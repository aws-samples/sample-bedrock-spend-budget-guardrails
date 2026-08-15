import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  ListEntitiesForPolicyCommand,
  ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam';
import {
  accountFromPolicyArn,
  accountFromPrincipal,
  iamForAccount,
} from '../../shared/iam-cross-account.js';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb } from '../../shared/ddb.js';
import {
  type CallerScope,
  callerIdentity,
  callerPrincipalKey,
  callerScope,
  json,
  noContent,
  parseBody,
  requireAdmin,
  scopeAllows,
} from '../../shared/api.js';
import { emitAudit } from '../../shared/audit.js';
import { recordActivity } from '../../shared/activity.js';
import { logger, metrics } from '../../shared/powertools.js';
import {
  Threshold,
  ThresholdValidationError,
  validateThresholds,
} from '../../shared/thresholds.js';
import { Window, WINDOWS } from '../../shared/period.js';
import {
  DEFAULTS_PRINCIPAL,
  DEFAULTS_TARGET,
  isDefaultsRow,
} from '../../shared/defaults.js';
import {
  ManifestValidationError,
  diffManifest,
  validateCondition,
  validateManifest,
} from '../../shared/manifest.js';
import {
  RATE_WINDOWS,
  type RateWindowSeconds,
} from '../../shared/rate-limits.js';

const BUDGETS_TABLE = process.env.BUDGETS_TABLE!;
const RUNNING_SPEND_TABLE = process.env.RUNNING_SPEND_TABLE!;

interface BudgetInput {
  principal: string;
  target: string;
  limitUsd: number;
  action?: 'deny' | 'alert';
  thresholds?: Threshold[];
  window?: Window;
  /**
   * per-budget escape hatch. When true, enforcement skips the
   * deny-policy attach for this budget; meter still records spend.
   */
  unlimited?: boolean;
  enabled?: boolean;
  condition?: { tagKey: string; tagValue: string };
  /**
   * BBG-RATELIMITS — per-principal request rate limit. When set,
   * enforcement attaches a deny policy when the principal makes
   * `rpm` requests through any rate-window-eligible budget within
   * `rateWindowSeconds` seconds. Independent of `limitUsd`. Pass
   * `null` on PUT to clear an existing limit.
   */
  rpm?: number | null;
  /**
   * BBG-RATELIMITS — per-principal token rate limit (input + output
   * combined). Same semantics as `rpm` but counted in tokens. Pass
   * `null` on PUT to clear.
   */
  tpm?: number | null;
  /**
   * BBG-RATELIMITS — sliding window length for `rpm`/`tpm`. Must be
   * one of the values in `RATE_WINDOWS`. Defaults to 60. Pass `null`
   * on PUT to clear (resets to default).
   */
  rateWindowSeconds?: RateWindowSeconds | null;
}

/**
 * master toggle config payload (PUT /admin/defaults). Empty
 * body / missing keys treated as no-op.
 */
interface DefaultsInput {
  enabled?: boolean;
  limitUsd?: number;
  window?: Window;
  thresholds?: Threshold[];
  /** BBG-RATELIMITS-DEFAULTS — propagate rate limits to every
   *  default-materialized budget. Pass `null` on PUT to clear an
   *  existing limit; omit to leave unchanged. */
  rpm?: number | null;
  tpm?: number | null;
  rateWindowSeconds?: RateWindowSeconds | null;
}

const validateWindow = (w: unknown): w is Window =>
  typeof w === 'string' && (WINDOWS as readonly string[]).includes(w);

/**
 * a `deny` budget only bites if enforcement can actually attach a
 * scoped deny for the principal. Reject the key shapes where it provably
 * can't, with a steering message. Returns an error string (→ 400) for a
 * hard-unenforceable key, a `{ warning }` for a soft case, or undefined
 * when the key is fine. Only applies to action=deny — alert-only budgets
 * are visibility-only and allowed on any key.
 *
 * - `principal#unknown`: no attach target, no scoping condition → the deny
 *   would be inert (enforcement emits EnforcementUnattachable). Reject.
 * - `principal#sessionTag/...`: only enforceable when the gateway
 *   (bbg:enableGateway) is deployed AND has attached the deny to the
 *   federation role, OR the operator manually attaches it. Metering works
 *   (the gateway keys spend by this shape), but auto-enforcement is not
 *   guaranteed → allow with a warning steering to sso-user#/sourceIdentity#.
 */
const validateEnforceablePrincipal = (
  principalKey: string,
  action: 'deny' | 'alert' | undefined,
): { error?: string; warning?: string } => {
  if (action === 'alert') return {};
  const inner = principalKey.replace(/^principal#/, '');
  if (inner === 'unknown') {
    return {
      error:
        'Cannot create a deny budget on principal#unknown — BBG has no identity to attach a deny to, so it would never enforce. Use a role/user ARN, principal#sso-user#<email>, or principal#sourceIdentity#<value>; or set action=alert.',
    };
  }
  if (inner.startsWith('sessionTag/')) {
    return {
      warning:
        'Session-tag budgets only auto-enforce when the BBG gateway (bbg:enableGateway) attaches the deny to the federation role. For direct-attach enforcement prefer principal#sso-user#<email> or principal#sourceIdentity#<value>. Metering + alerting work regardless.',
    };
  }
  return {};
};

/**
 * API-1 (B4) — validate a budget `target` matches one of the shapes
 * `resourcesFor()` in shared/policies.ts understands: `model#<id>`,
 * `model#*`, `profile#<arn>`, or `profile#*`. Anything else makes
 * `resourcesFor` fall back to `Resource: ['*']`, producing a Deny policy
 * that blocks *all* Bedrock resources. Reject those before persisting so
 * enforcement never builds an over-broad deny. The non-wildcard body must
 * carry a non-empty suffix after the `#`.
 */
const isValidTarget = (target: string): boolean => {
  if (target === 'model#*' || target === 'profile#*') return true;
  if (target.startsWith('model#')) return target.slice('model#'.length).length > 0;
  if (target.startsWith('profile#')) return target.slice('profile#'.length).length > 0;
  return false;
};

/**
 * BBG-RATELIMITS — validate the optional rate-limit fields on a
 * BudgetInput. Returns an error string (suitable for a 400 response)
 * or undefined when the input is clean. Treats all three fields as
 * optional but mutually-coherent: `rateWindowSeconds` without rpm/tpm
 * is allowed (no-op), but a non-positive rpm/tpm or an unsupported
 * window is rejected. `null` is a valid PUT-only sentinel meaning
 * "clear this field" — handled by the caller, skipped here.
 */
const validateRateLimits = (b: BudgetInput): string | undefined => {
  if (b.rpm !== undefined && b.rpm !== null) {
    if (typeof b.rpm !== 'number' || !Number.isFinite(b.rpm) || b.rpm <= 0) {
      return 'rpm must be a positive number';
    }
  }
  if (b.tpm !== undefined && b.tpm !== null) {
    if (typeof b.tpm !== 'number' || !Number.isFinite(b.tpm) || b.tpm <= 0) {
      return 'tpm must be a positive number';
    }
  }
  if (b.rateWindowSeconds !== undefined && b.rateWindowSeconds !== null) {
    if (!(RATE_WINDOWS as readonly number[]).includes(b.rateWindowSeconds)) {
      return `rateWindowSeconds must be one of ${RATE_WINDOWS.join(', ')}`;
    }
  }
  // Unlimited budgets shouldn't pretend to have rate enforcement —
  // the whole point of `unlimited` is "skip enforcement". Refuse the
  // ambiguous combination.
  if (b.unlimited && (b.rpm != null || b.tpm != null)) {
    return 'Unlimited budgets cannot have rpm or tpm rate limits.';
  }
  return undefined;
};

/**
 * AUZ-1 (B4) — fail-CLOSED per-account scope guard for budget writes.
 *
 * A wildcard (super-admin) scope may operate on any principal, including
 * one whose account can't be parsed from the ARN. A scope-limited admin
 * must prove the target principal lives in an account they administer:
 *   - `targetAccount` undefined/unparseable → reject (403). This is the
 *     fail-closed fix — the previous `if (targetAccount && !scopeAllows)`
 *     guard silently skipped the check when the account couldn't be
 *     derived (e.g. session-tag principals), letting a scoped admin
 *     write outside their scope. `accountFromPrincipal` is now strict
 *     (iam|sts ARN → account, else undefined — no home-account
 *     fallback), so a non-ARN principal is always super-admin-only here.
 *   - `targetAccount` not in scope → reject (403).
 *
 * Returns a 403 response to short-circuit the handler, or `undefined`
 * when the caller may proceed.
 */
const scopeGuardResult = (
  scope: CallerScope,
  targetAccount: string | undefined,
): APIGatewayProxyResultV2 | undefined => {
  if (scope.isWildcard) return undefined;
  if (!targetAccount) {
    return json(403, {
      error: 'Forbidden: cannot determine the target account for this principal',
    });
  }
  if (!scopeAllows(scope, targetAccount)) {
    return json(403, { error: `Forbidden: scope does not include account ${targetAccount}` });
  }
  return undefined;
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const route = event.routeKey;
  logger.info('budgets api', { route });

  if (route === 'GET /admin/budgets') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    const r = await ddb.send(new ScanCommand({ TableName: BUDGETS_TABLE }));
    // The defaults config row lives in the same table; never expose it
    // through the budgets list.
    let items = (r.Items ?? []).filter(
      (it) => !isDefaultsRow({ principal: String(it.principal), target: String(it.target) }),
    );
    // per-account admins only see budgets for accounts they
    // administer. Wildcard scope sees everything (current behavior).
    if (!scope.isWildcard) {
      items = items.filter((it) =>
        scopeAllows(scope, accountFromPrincipal(String(it.principal))),
      );
    }
    return json(200, { items });
  }

  if (route === 'GET /admin/defaults') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const r = await ddb.send(
      new GetCommand({
        TableName: BUDGETS_TABLE,
        Key: { principal: DEFAULTS_PRINCIPAL, target: DEFAULTS_TARGET },
      }),
    );
    // Return a stable empty-defaults shape when the row doesn't exist
    // yet — matches "master toggle off, no defaults set" semantics.
    return json(200, {
      enabled: Boolean(r.Item?.enabled),
      limitUsd: Number(r.Item?.limitUsd ?? 0),
      window: (r.Item?.window as Window | undefined) ?? 'monthly',
      thresholds: (r.Item?.thresholds as Threshold[] | undefined) ?? [
        { at: 80, action: 'warn' },
        { at: 100, action: 'block' },
      ],
      // BBG-RATELIMITS-DEFAULTS — surface optional rate-limit fields.
      // Absent (undefined) means "no rate limit applied on materialize".
      rpm: typeof r.Item?.rpm === 'number' ? (r.Item.rpm as number) : undefined,
      tpm: typeof r.Item?.tpm === 'number' ? (r.Item.tpm as number) : undefined,
      rateWindowSeconds:
        typeof r.Item?.rateWindowSeconds === 'number'
          ? (r.Item.rateWindowSeconds as RateWindowSeconds)
          : undefined,
      updatedAt: r.Item?.updatedAt ?? null,
    });
  }

  if (route === 'PUT /admin/defaults') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    // Defaults config is global (affects every principal). Restrict to
    // wildcard scope so per-account admins can't flip the master toggle.
    if (!scope.isWildcard) {
      return json(403, { error: 'Forbidden: defaults config is super-admin only' });
    }
    const body = parseBody<DefaultsInput>(event);
    if (!body) return json(400, { error: 'Invalid body' });
    if (body.thresholds) {
      try {
        validateThresholds(body.thresholds);
      } catch (err) {
        if (err instanceof ThresholdValidationError) return json(400, { error: err.message });
        throw err;
      }
    }
    if (body.window !== undefined && !validateWindow(body.window)) {
      return json(400, { error: `window must be one of ${WINDOWS.join(', ')}` });
    }
    if (body.limitUsd !== undefined && (typeof body.limitUsd !== 'number' || body.limitUsd < 0)) {
      return json(400, { error: 'limitUsd must be a non-negative number' });
    }
    // BBG-RATELIMITS-DEFAULTS — same validator as per-budget rate
    // limits, minus the unlimited check (defaults are never unlimited
    // since they always materialize as `action: 'deny'`).
    if (body.rpm !== undefined && body.rpm !== null) {
      if (typeof body.rpm !== 'number' || !Number.isFinite(body.rpm) || body.rpm <= 0) {
        return json(400, { error: 'rpm must be a positive number' });
      }
    }
    if (body.tpm !== undefined && body.tpm !== null) {
      if (typeof body.tpm !== 'number' || !Number.isFinite(body.tpm) || body.tpm <= 0) {
        return json(400, { error: 'tpm must be a positive number' });
      }
    }
    if (body.rateWindowSeconds !== undefined && body.rateWindowSeconds !== null) {
      if (!(RATE_WINDOWS as readonly number[]).includes(body.rateWindowSeconds)) {
        return json(400, {
          error: `rateWindowSeconds must be one of ${RATE_WINDOWS.join(', ')}`,
        });
      }
    }
    const existing = await ddb.send(
      new GetCommand({
        TableName: BUDGETS_TABLE,
        Key: { principal: DEFAULTS_PRINCIPAL, target: DEFAULTS_TARGET },
      }),
    );
    const item: Record<string, unknown> = {
      ...(existing.Item ?? {}),
      principal: DEFAULTS_PRINCIPAL,
      target: DEFAULTS_TARGET,
      enabled: body.enabled ?? Boolean(existing.Item?.enabled),
      limitUsd: body.limitUsd ?? Number(existing.Item?.limitUsd ?? 0),
      window: body.window ?? existing.Item?.window ?? 'monthly',
      thresholds:
        body.thresholds ??
        (existing.Item?.thresholds as Threshold[] | undefined) ?? [
          { at: 80, action: 'warn' },
          { at: 100, action: 'block' },
        ],
      updatedAt: new Date().toISOString(),
    };
    // BBG-RATELIMITS-DEFAULTS — apply tri-state on each rate field:
    //   undefined = leave unchanged
    //   null      = clear (delete the key from the row)
    //   number    = set
    for (const k of ['rpm', 'tpm', 'rateWindowSeconds'] as const) {
      const v = body[k];
      if (v === null) delete item[k];
      else if (v !== undefined) item[k] = v;
    }
    await ddb.send(new PutCommand({ TableName: BUDGETS_TABLE, Item: item }));
    logger.warn('default-budget config updated', {
      enabled: item.enabled,
      limitUsd: item.limitUsd,
      window: item.window,
    });
    emitAudit(callerIdentity(event), scope, {
      action: 'defaults.update',
      targetAccountId: '*',
      detail: { enabled: item.enabled, limitUsd: item.limitUsd, window: item.window },
    });
    metrics.publishStoredMetrics();
    return json(200, item);
  }

  if (route === 'POST /admin/budgets') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const body = parseBody<BudgetInput>(event);
    if (!body?.principal || !body.target || typeof body.limitUsd !== 'number') {
      return json(400, { error: 'principal, target, limitUsd required' });
    }
    // Refuse to clobber the defaults sentinel through the budget API —
    // operators must use /admin/defaults for that.
    if (body.principal === DEFAULTS_PRINCIPAL || body.target === DEFAULTS_TARGET) {
      return json(400, { error: 'Reserved principal/target. Use /admin/defaults to manage the default budget.' });
    }
    // API-1: reject a malformed target before persisting so the deny
    // policy never falls back to Resource:'*'.
    if (!isValidTarget(body.target)) {
      return json(400, {
        error: 'target must be one of: model#<id>, model#*, profile#<arn>, profile#*',
      });
    }
    // per-account scope guard. Caller must have scope for the
    // account whose principal they're creating a budget for.
    const scope = callerScope(event);
    const principalNormalized = body.principal.startsWith('principal#') ? body.principal : `principal#${body.principal}`;
    const targetAccount = accountFromPrincipal(principalNormalized);
    {
      const denied = scopeGuardResult(scope, targetAccount);
      if (denied) return denied;
    }
    if (body.thresholds) {
      try {
        validateThresholds(body.thresholds);
      } catch (err) {
        if (err instanceof ThresholdValidationError) return json(400, { error: err.message });
        throw err;
      }
    }
    if (body.window !== undefined && !validateWindow(body.window)) {
      return json(400, { error: `window must be one of ${WINDOWS.join(', ')}` });
    }
    if (body.unlimited && body.thresholds?.some((t) => t.action === 'block')) {
      return json(400, { error: 'Unlimited budgets cannot have a `block` threshold.' });
    }
    {
      const rateErr = validateRateLimits(body);
      if (rateErr) return json(400, { error: rateErr });
    }
    // BBG-SESSIONTAG — validate the optional session-tag condition before
    // persisting so operator input can't inject into the deny policy's
    // Condition block downstream (shared/policies.ts buildDenyPolicy).
    {
      const condErr = validateCondition(body.condition);
      if (condErr) return json(400, { error: condErr });
    }
    // reject deny budgets on principals BBG can't enforce.
    const enforceability = validateEnforceablePrincipal(principalNormalized, body.action);
    if (enforceability.error) return json(400, { error: enforceability.error });
    // A budget with neither USD nor RPM nor TPM is just a no-op — we'd
    // record spend but never enforce anything. Refuse it so operators
    // notice the misconfiguration before it ships.
    if (
      (body.limitUsd === 0 || body.unlimited) &&
      body.rpm === undefined &&
      body.tpm === undefined &&
      !body.unlimited
    ) {
      return json(400, {
        error: 'Set at least one of: limitUsd > 0, rpm, tpm. (Or use unlimited: true.)',
      });
    }
    const item: Record<string, unknown> = {
      principal: principalNormalized,
      target: body.target,
      limitUsd: body.limitUsd,
      action: body.action ?? 'deny',
      enabled: body.enabled ?? true,
      condition: body.condition,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (body.thresholds) item.thresholds = body.thresholds;
    if (body.window) item.window = body.window;
    if (body.unlimited) item.unlimited = true;
    if (body.rpm != null) item.rpm = body.rpm;
    if (body.tpm != null) item.tpm = body.tpm;
    if (body.rateWindowSeconds != null) item.rateWindowSeconds = body.rateWindowSeconds;
    await ddb.send(new PutCommand({ TableName: BUDGETS_TABLE, Item: item }));
    emitAudit(callerIdentity(event), scope, {
      action: 'budgets.create',
      targetAccountId: targetAccount || '*',
      detail: {
        principal: principalNormalized,
        target: body.target,
        limitUsd: body.limitUsd,
        rpm: body.rpm,
        tpm: body.tpm,
        rateWindowSeconds: body.rateWindowSeconds,
      },
    });
    await recordActivity({
      principal: principalNormalized,
      type: 'budget.created',
      summary: `Budget created for ${body.target} — limit $${body.limitUsd}`,
      detail: { target: body.target, limitUsd: body.limitUsd, action: body.action ?? 'deny' },
      actor: callerIdentity(event),
    });
    metrics.publishStoredMetrics();
    return json(201, enforceability.warning ? { ...item, warning: enforceability.warning } : item);
  }

  if (route === 'PUT /admin/budget') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    // principal + target are QUERY params, not path segments: both embed an ARN
    // (principal#arn:...:role/Name, profile#arn:...:inference-profile/id) whose
    // '/' the HTTP API decodes before route matching, so a {principal}/{target}
    // path 404s. Query values are already URL-decoded — read them directly (no
    // double-decode). See api-stack.ts.
    const principal = event.queryStringParameters?.principal ?? '';
    const target = event.queryStringParameters?.target ?? '';
    if (!principal || !target) return json(400, { error: 'principal and target are required' });
    if (principal === DEFAULTS_PRINCIPAL || target === DEFAULTS_TARGET) {
      return json(400, { error: 'Reserved principal/target. Use /admin/defaults to manage the default budget.' });
    }
    // API-1: reject a malformed target before persisting so the deny
    // policy never falls back to Resource:'*'.
    if (!isValidTarget(target)) {
      return json(400, {
        error: 'target must be one of: model#<id>, model#*, profile#<arn>, profile#*',
      });
    }
    const scope = callerScope(event);
    const targetAccount = accountFromPrincipal(principal);
    {
      const denied = scopeGuardResult(scope, targetAccount);
      if (denied) return denied;
    }
    const body = parseBody<BudgetInput>(event);
    if (!body) return json(400, { error: 'Invalid body' });
    if (body.thresholds) {
      try {
        validateThresholds(body.thresholds);
      } catch (err) {
        if (err instanceof ThresholdValidationError) return json(400, { error: err.message });
        throw err;
      }
    }
    if (body.window !== undefined && !validateWindow(body.window)) {
      return json(400, { error: `window must be one of ${WINDOWS.join(', ')}` });
    }
    if (body.unlimited && body.thresholds?.some((t) => t.action === 'block')) {
      return json(400, { error: 'Unlimited budgets cannot have a `block` threshold.' });
    }
    {
      const rateErr = validateRateLimits(body);
      if (rateErr) return json(400, { error: rateErr });
    }
    // BBG-SESSIONTAG — validate the optional session-tag condition (when
    // present on this update) before persisting, same as POST. Absent =>
    // no-op; the existing condition is carried forward via the merge below.
    {
      const condErr = validateCondition(body.condition);
      if (condErr) return json(400, { error: condErr });
    }
    const existing = await ddb.send(new GetCommand({ TableName: BUDGETS_TABLE, Key: { principal, target } }));
    if (!existing.Item) return json(404, { error: 'Not found' });
    // reject a deny budget on an unenforceable principal. Uses the
    // EFFECTIVE action (body override, else the existing row's action) so a
    // PUT that flips action=alert→deny is caught, and one that leaves action
    // untouched still validates against the persisted deny.
    const effectiveAction = (body.action ?? existing.Item.action) as 'deny' | 'alert' | undefined;
    const putEnforceability = validateEnforceablePrincipal(principal, effectiveAction);
    if (putEnforceability.error) return json(400, { error: putEnforceability.error });
    // BBG-RATELIMITS: when the caller explicitly sends `null` for rpm/
    // tpm/rateWindowSeconds, treat it as "remove this rate field" so
    // operators can clear an old rate limit. The PutCommand item we
    // build below only sets a key when the body has a defined non-null
    // value; we explicitly carry forward the existing value when
    // undefined.
    const merged = { ...existing.Item, ...body, principal, target, updatedAt: new Date().toISOString() };
    if (body.rpm === null) delete merged.rpm;
    if (body.tpm === null) delete merged.tpm;
    if (body.rateWindowSeconds === null) delete merged.rateWindowSeconds;
    await ddb.send(new PutCommand({ TableName: BUDGETS_TABLE, Item: merged }));
    emitAudit(callerIdentity(event), scope, {
      action: 'budgets.update',
      targetAccountId: targetAccount || '*',
      detail: { principal, target },
    });
    await recordActivity({
      principal,
      type: 'budget.updated',
      summary: `Budget updated for ${target}`,
      detail: { target, limitUsd: merged.limitUsd },
      actor: callerIdentity(event),
    });
    metrics.publishStoredMetrics();
    return json(200, putEnforceability.warning ? { ...merged, warning: putEnforceability.warning } : merged);
  }

  if (route === 'DELETE /admin/budget') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    // ?principal=&target= query params (see the PUT /admin/budget note).
    const principal = event.queryStringParameters?.principal ?? '';
    const target = event.queryStringParameters?.target ?? '';
    if (!principal || !target) return json(400, { error: 'principal and target are required' });
    const targetAccount = accountFromPrincipal(principal);
    {
      const denied = scopeGuardResult(scope, targetAccount);
      if (denied) return denied;
    }
    await ddb.send(new DeleteCommand({ TableName: BUDGETS_TABLE, Key: { principal, target } }));
    emitAudit(callerIdentity(event), scope, {
      action: 'budgets.delete',
      targetAccountId: targetAccount || '*',
      detail: { principal, target },
    });
    await recordActivity({
      principal,
      type: 'budget.deleted',
      summary: `Budget deleted for ${target}`,
      detail: { target },
      actor: callerIdentity(event),
    });
    metrics.publishStoredMetrics();
    return noContent();
  }

  if (route === 'POST /admin/budget/toggle') {
    // Flip Budgets.enabled. When disabled, the enforcement Lambda skips this
    // budget entirely on subsequent stream events.
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    // ?principal=&target= query params (see the PUT /admin/budget note).
    const principal = event.queryStringParameters?.principal ?? '';
    const target = event.queryStringParameters?.target ?? '';
    if (!principal || !target) return json(400, { error: 'principal and target are required' });
    const targetAccount = accountFromPrincipal(principal);
    {
      const denied = scopeGuardResult(scope, targetAccount);
      if (denied) return denied;
    }
    const existing = await ddb.send(new GetCommand({ TableName: BUDGETS_TABLE, Key: { principal, target } }));
    if (!existing.Item) return json(404, { error: 'Not found' });
    const next = !existing.Item.enabled;
    await ddb.send(
      new UpdateCommand({
        TableName: BUDGETS_TABLE,
        Key: { principal, target },
        UpdateExpression: 'SET enabled = :e, updatedAt = :now',
        ExpressionAttributeValues: { ':e': next, ':now': new Date().toISOString() },
      }),
    );
    emitAudit(callerIdentity(event), scope, {
      action: 'budgets.toggle',
      targetAccountId: targetAccount || '*',
      detail: { principal, target, enabled: next },
    });
    await recordActivity({
      principal,
      type: 'budget.toggled',
      summary: `Budget ${next ? 'enabled' : 'disabled'} for ${target}`,
      detail: { target, enabled: next },
      actor: callerIdentity(event),
    });
    metrics.publishStoredMetrics();
    return json(200, { ...existing.Item, enabled: next });
  }

  if (route === 'POST /admin/budget/release') {
    // Manually detach + delete the bbg-deny-* policy currently enforcing this
    // budget. Used by admins to lift a deny without waiting for the period
    // rollover. Clears enforcementPolicyArn on the matching spend row so
    // future enforcement can re-attach if spend climbs again.
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    // ?principal=&target= query params (see the PUT /admin/budget note).
    const principal = event.queryStringParameters?.principal ?? '';
    const target = event.queryStringParameters?.target ?? '';
    if (!principal || !target) return json(400, { error: 'principal and target are required' });
    const targetAccount = accountFromPrincipal(principal);
    {
      const denied = scopeGuardResult(scope, targetAccount);
      if (denied) return denied;
    }

    // Find the spend row that has enforcementPolicyArn set for this budget.
    const scan = await ddb.send(
      new ScanCommand({
        TableName: RUNNING_SPEND_TABLE,
        FilterExpression: 'principal = :p AND target = :t AND attribute_exists(enforcementPolicyArn)',
        ExpressionAttributeValues: { ':p': principal, ':t': target },
      }),
    );
    const row = scan.Items?.[0];
    if (!row?.enforcementPolicyArn) {
      return json(200, { released: false, reason: 'No active enforcement found' });
    }

    const policyArn = row.enforcementPolicyArn as string;
    const policyAccount = accountFromPolicyArn(policyArn);
    // route to the policy's home account for cross-account
    // enforcement policies.
    const iam = await iamForAccount(policyAccount);
    logger.info('release: iam client ready', { policyArn, policyAccount });
    try {
      const ents = await iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: policyArn }));
      logger.info('release: listed entities', {
        users: (ents.PolicyUsers ?? []).map((u) => u.UserName),
        roles: (ents.PolicyRoles ?? []).map((r) => r.RoleName),
      });
      for (const u of ents.PolicyUsers ?? []) {
        if (u.UserName) {
          await iam.send(new DetachUserPolicyCommand({ UserName: u.UserName, PolicyArn: policyArn }));
          logger.info('release: detached user', { user: u.UserName });
        }
      }
      for (const r of ents.PolicyRoles ?? []) {
        if (r.RoleName) {
          await iam.send(new DetachRolePolicyCommand({ RoleName: r.RoleName, PolicyArn: policyArn }));
          logger.info('release: detached role', { role: r.RoleName });
        }
      }
      const versions = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
      for (const v of versions.Versions ?? []) {
        if (v.IsDefaultVersion || !v.VersionId) continue;
        await iam
          .send(new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: v.VersionId }))
          .catch(() => undefined);
      }
      await iam.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
      logger.info('release: deleted policy', { policyArn });
    } catch (err) {
      logger.error('Failed to release deny policy', { policyArn, err: (err as Error).message });
      return json(500, { error: 'Failed to release deny policy', detail: (err as Error).message });
    }

    // N1 release-latch: only clear the stamp if it STILL points at the ARN we
    // just released. If a concurrent enforcement re-stamped a fresh ARN (and
    // attached a new deny) between our Scan above and this write, the
    // ConditionExpression fails and we leave the new stamp in place rather than
    // wiping an active deny and leaving the principal blocked with no record.
    const cleared = await ddb
      .send(
        new UpdateCommand({
          TableName: RUNNING_SPEND_TABLE,
          Key: { principal: row.principal, sk: row.sk },
          UpdateExpression: 'REMOVE enforcementPolicyArn',
          ConditionExpression: 'enforcementPolicyArn = :arn',
          ExpressionAttributeValues: { ':arn': policyArn },
        }),
      )
      .then(() => true)
      .catch((err) => {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      });
    if (!cleared) {
      logger.info('release: stamp changed since scan — re-enforcement left in place', {
        principal: row.principal,
        sk: row.sk,
      });
      return json(200, {
        released: false,
        reason: 'Enforcement was re-applied concurrently; released policy detached but a newer deny is active',
        policyArn,
      });
    }
    emitAudit(callerIdentity(event), scope, {
      action: 'budgets.release',
      targetAccountId: targetAccount || policyAccount || '*',
      detail: { principal, target, policyArn },
    });
    await recordActivity({
      principal,
      type: 'enforcement.released',
      summary: `Enforcement manually released for ${target}`,
      detail: { target, policyArn },
      actor: callerIdentity(event),
    });
    metrics.publishStoredMetrics();
    return json(200, { released: true, policyArn });
  }

  if (route === 'POST /admin/budgets:apply') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    // Manifest apply rewrites budgets across every principal in the
    // payload, including potentially cross-account principals. Restrict
    // to wildcard scope; per-account admins should use individual
    // POST/PUT/DELETE endpoints.
    if (!scope.isWildcard) {
      return json(403, { error: 'Forbidden: manifest apply is super-admin only' });
    }
    const body = parseBody<{ manifest?: unknown; dryRun?: boolean }>(event);
    if (!body || body.manifest === undefined) {
      return json(400, { error: 'manifest is required' });
    }
    let manifest;
    try {
      manifest = validateManifest(body.manifest);
    } catch (err) {
      if (err instanceof ManifestValidationError) return json(400, { error: err.message });
      throw err;
    }
    // Read current state — both regular budget rows + the defaults sentinel.
    const allRows = await ddb.send(new ScanCommand({ TableName: BUDGETS_TABLE }));
    const currentBudgets = (allRows.Items ?? []).filter(
      (it) => !isDefaultsRow({ principal: String(it.principal), target: String(it.target) }),
    );
    const currentDefaults = (allRows.Items ?? []).find((it) =>
      isDefaultsRow({ principal: String(it.principal), target: String(it.target) }),
    );
    const diff = diffManifest(
      currentBudgets as Parameters<typeof diffManifest>[0],
      manifest,
      currentDefaults as Parameters<typeof diffManifest>[2],
    );
    if (body.dryRun) {
      return json(200, { dryRun: true, diff });
    }
    // Apply.
    const now = new Date().toISOString();
    for (const m of manifest.budgets ?? []) {
      // Skip cleanly when nothing actually changed — saves a write per
      // unchanged budget on large manifests.
      const isUnchanged = diff.unchanged.some(
        (u) => u.principal === m.principal && u.target === m.target,
      );
      if (isUnchanged) continue;
      const item: Record<string, unknown> = {
        principal: m.principal,
        target: m.target,
        limitUsd: m.limitUsd ?? 0,
        action: m.unlimited ? 'alert' : (m.thresholds?.some((t) => t.action === 'block') ? 'deny' : 'alert'),
        enabled: m.enabled ?? true,
        condition: m.condition,
        createdAt: now,
        updatedAt: now,
        source: 'manifest',
      };
      if (m.thresholds) item.thresholds = m.thresholds;
      if (m.window) item.window = m.window;
      if (m.unlimited) item.unlimited = true;
      // BBG-RATELIMITS
      if (m.rpm !== undefined) item.rpm = m.rpm;
      if (m.tpm !== undefined) item.tpm = m.tpm;
      if (m.rateWindowSeconds !== undefined) item.rateWindowSeconds = m.rateWindowSeconds;
      await ddb.send(new PutCommand({ TableName: BUDGETS_TABLE, Item: item }));
    }
    for (const d of diff.removed) {
      await ddb.send(
        new DeleteCommand({
          TableName: BUDGETS_TABLE,
          Key: { principal: d.principal, target: d.target },
        }),
      );
    }
    if (manifest.defaults && diff.defaultsChanged) {
      const cur = (currentDefaults ?? {}) as Record<string, unknown>;
      const item: Record<string, unknown> = {
        ...cur,
        principal: DEFAULTS_PRINCIPAL,
        target: DEFAULTS_TARGET,
        enabled: manifest.defaults.enabled ?? Boolean(cur.enabled),
        limitUsd: manifest.defaults.limitUsd ?? Number(cur.limitUsd ?? 0),
        window: manifest.defaults.window ?? cur.window ?? 'monthly',
        thresholds:
          manifest.defaults.thresholds ??
          cur.thresholds ?? [
            { at: 80, action: 'warn' },
            { at: 100, action: 'block' },
          ],
        updatedAt: now,
      };
      // BBG-RATELIMITS-DEFAULTS — propagate optional rate-limit fields
      // from the manifest. Manifest schema doesn't support null-clears
      // for defaults (operators use a separate API call to remove a
      // limit), so we only set when provided.
      if (manifest.defaults.rpm !== undefined) item.rpm = manifest.defaults.rpm;
      if (manifest.defaults.tpm !== undefined) item.tpm = manifest.defaults.tpm;
      if (manifest.defaults.rateWindowSeconds !== undefined) {
        item.rateWindowSeconds = manifest.defaults.rateWindowSeconds;
      }
      await ddb.send(new PutCommand({ TableName: BUDGETS_TABLE, Item: item }));
    }
    logger.warn('manifest applied', {
      created: diff.created.length,
      updated: diff.updated.length,
      removed: diff.removed.length,
      defaultsChanged: diff.defaultsChanged,
    });
    emitAudit(callerIdentity(event), scope, {
      action: 'budgets.applyManifest',
      targetAccountId: '*',
      detail: {
        created: diff.created.length,
        updated: diff.updated.length,
        removed: diff.removed.length,
        defaultsChanged: diff.defaultsChanged,
      },
    });
    metrics.publishStoredMetrics();
    return json(200, { dryRun: false, diff });
  }

  if (route === 'GET /me/budget') {
    const me = callerPrincipalKey(event);
    // No mapped IAM principal => no budgets to scope; that's not an error,
    // it just means the user hasn't been linked to an IAM identity yet.
    if (!me) return json(200, { items: [], unmapped: true });
    const r = await ddb.send(
      new ScanCommand({
        TableName: BUDGETS_TABLE,
        FilterExpression: 'principal = :p',
        ExpressionAttributeValues: { ':p': me },
      }),
    );
    return json(200, { items: r.Items ?? [] });
  }

  return json(404, { error: `Unknown route: ${route}` });
};
