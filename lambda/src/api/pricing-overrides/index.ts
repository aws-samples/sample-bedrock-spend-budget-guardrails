import { DeleteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb } from '../../shared/ddb.js';
import {
  callerIdentity,
  callerScope,
  json,
  noContent,
  parseBody,
  requireAdmin,
} from '../../shared/api.js';
import { emitAudit } from '../../shared/audit.js';
import { logger, metrics } from '../../shared/powertools.js';
import { providerFromModelId } from '../../shared/provider.js';
import {
  type DiscountScope,
  discountKey as buildDiscountKey,
  isDiscountKey,
  isValidPct,
  isValidScopeId,
  parseDiscountKey,
} from '../../shared/discounts.js';

const PRICING_TABLE = process.env.PRICING_TABLE!;
// Set by infra so a discount write can kick the hierarchical resolver on-demand
// (so a new OU/org discount takes effect in minutes, not at the next hourly run).
const DISCOUNT_RESOLVER_FN = process.env.DISCOUNT_RESOLVER_FN;

const lambda = new LambdaClient({});

// Custom pricing discount rows share the Pricing table, keyed by a reserved
// `discount#…` model key (namespaced so they never collide with real model
// rows). Three scopes: account (`discount#<acct>`), OU (`discount#ou#<id>`),
// org (`discount#org#<id>`) — see shared/discounts.ts. The meter reads the
// per-account row's materialized `effectivePct` (or authored `discountPct`).
const DISCOUNT_KEY_PREFIX = 'discount#';

/**
 * Fire-and-(mostly)-forget: async-invoke the org/OU discount resolver so a
 * write to any scope re-materializes effective rates within seconds. Never
 * blocks or fails the API response — the hourly schedule is the backstop.
 */
const triggerResolver = async (): Promise<void> => {
  if (!DISCOUNT_RESOLVER_FN) return;
  await lambda
    .send(new InvokeCommand({ FunctionName: DISCOUNT_RESOLVER_FN, InvocationType: 'Event' }))
    .catch((err) => logger.warn('discount resolver trigger failed', { err: (err as Error).message }));
};

interface PricingDiscountInput {
  /**
   * Scope of the discount. Defaults to 'account' for back-compat with the
   * original per-account API (a body with only accountId still works).
   */
  scope?: DiscountScope;
  /** Account id (scope=account) — also accepted as the legacy top-level field. */
  accountId?: string;
  /** The scoped id: 12-digit account, `ou-…`/`r-…`, or `o-…` per scope. */
  scopeId?: string;
  /** Discount percentage, 0–100. 0 (or delete) clears the discount. */
  discountPct: number;
  /** Optional operator-facing label (e.g. "2026 negotiated rate"). */
  label?: string;
}

interface DimensionInput {
  unit: string;
  pricePerUnit: number;
  label?: string;
  notes?: string;
}

interface PricingOverrideInput {
  model: string;
  /**
   * Legacy shorthand for token-only models. When set, the handler also
   * synthesizes `dimensions.inputTokens` / `dimensions.outputTokens` so the
   * meter's multi-dim path picks them up.
   */
  inputPer1k?: number;
  outputPer1k?: number;
  cacheReadPer1k?: number;
  cacheWritePer1k?: number;
  /**
   * Multi-dim shape — operator can directly specify any combination of
   * inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
   * outputImages, outputVideoSeconds, inputAudioSeconds, outputAudioSeconds,
   * searchUnits.
   */
  dimensions?: Record<string, DimensionInput>;
  displayName?: string;
  /** Optional explicit provider; when omitted, derived from `model`. */
  provider?: string;
  notes?: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });

  const route = event.routeKey;
  const scope = callerScope(event);
  // pricing overrides are global (one row per model affects
  // every account that meters that model). Restrict to wildcard scope.
  if (route !== 'GET /admin/pricing/overrides' && !scope.isWildcard) {
    return json(403, { error: 'Forbidden: pricing overrides are super-admin only' });
  }

  if (route === 'GET /admin/pricing/overrides') {
    const r = await ddb.send(new ScanCommand({ TableName: PRICING_TABLE }));
    // Exclude the reserved discount rows — they're not model overrides.
    const items = (r.Items ?? []).filter(
      (it) => !String(it.model ?? '').startsWith(DISCOUNT_KEY_PREFIX),
    );
    return json(200, { items });
  }

  // Custom pricing discounts — account / OU / org scopes (see shared/discounts).
  if (route === 'GET /admin/pricing/discounts') {
    const r = await ddb.send(new ScanCommand({ TableName: PRICING_TABLE }));
    const rows = (r.Items ?? []).filter((it) => isDiscountKey(String(it.model ?? '')));
    const items = rows
      .map((it) => {
        const parsed = parseDiscountKey(String(it.model));
        if (!parsed) return undefined;
        return {
          scope: parsed.scope,
          scopeId: parsed.scopeId,
          // Legacy alias so the existing UI keeps working for account rows.
          accountId: parsed.scope === 'account' ? parsed.scopeId : undefined,
          // Authored value (what the operator set at this scope). May be absent
          // on an account row that only carries an inherited materialized rate.
          discountPct: it.discountPct,
          label: it.label,
          updatedAt: it.updatedAt,
          // Resolver-materialized effective rate + provenance (account rows only).
          effectivePct: it.effectivePct,
          effectiveScope: it.effectiveScope,
          effectiveScopeId: it.effectiveScopeId,
        };
      })
      .filter(Boolean);
    return json(200, { items });
  }

  if (route === 'POST /admin/pricing/discounts') {
    const body = parseBody<PricingDiscountInput>(event);
    if (!body) return json(400, { error: 'body required' });
    // Resolve scope + scopeId, honoring the legacy account-only shape
    // (`{ accountId, discountPct }` with no scope).
    const scopeKind: DiscountScope = body.scope ?? 'account';
    if (!['account', 'ou', 'org'].includes(scopeKind)) {
      return json(400, { error: "scope must be 'account', 'ou', or 'org'" });
    }
    const scopeId = body.scopeId ?? (scopeKind === 'account' ? body.accountId : undefined);
    if (!scopeId || !isValidScopeId(scopeKind, scopeId)) {
      return json(400, { error: `valid scopeId required for scope '${scopeKind}'` });
    }
    const key = buildDiscountKey(scopeKind, scopeId);
    if (typeof body.discountPct !== 'number' || !Number.isFinite(body.discountPct) || body.discountPct < 0 || body.discountPct > 100) {
      return json(400, { error: 'discountPct must be a number between 0 and 100' });
    }
    // 0% semantics differ by scope:
    //  - account: STORE an explicit exclusion (discountPct 0). This is the only
    //    way to opt one account out of an OU/org discount it would inherit —
    //    the resolver treats it as list price and it WINS precedence. Deleting
    //    the row instead would let the OU/org discount silently re-inherit.
    //  - ou/org: there's nothing to exclude, so 0 clears the authored row.
    if (body.discountPct === 0 && scopeKind !== 'account') {
      await ddb.send(new DeleteCommand({ TableName: PRICING_TABLE, Key: { model: key } }));
      emitAudit(callerIdentity(event), scope, {
        action: 'pricingDiscount.clear',
        targetAccountId: '*',
        detail: { scope: scopeKind, scopeId },
      });
      await triggerResolver();
      metrics.publishStoredMetrics();
      return noContent();
    }
    if (body.discountPct !== 0 && !isValidPct(body.discountPct)) {
      return json(400, { error: 'discountPct must be a number between 0 and 100' });
    }
    const item = {
      model: key,
      scope: scopeKind,
      discountPct: body.discountPct, // 0 on an account = explicit exclusion
      label: body.label,
      source: 'custom-pricing-discount',
      updatedAt: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: PRICING_TABLE, Item: item }));
    emitAudit(callerIdentity(event), scope, {
      action: 'pricingDiscount.upsert',
      targetAccountId: scopeKind === 'account' ? scopeId : '*',
      detail: { scope: scopeKind, scopeId, discountPct: body.discountPct },
    });
    await triggerResolver();
    metrics.publishStoredMetrics();
    return json(201, { scope: scopeKind, scopeId, discountPct: body.discountPct, label: body.label });
  }

  // DELETE by scope+id via query params (?scope=&scopeId=), OR the legacy
  // path-param form DELETE /admin/pricing/discounts/{accountId} (account scope).
  if (route === 'DELETE /admin/pricing/discounts/{accountId}') {
    const accountId = decodeURIComponent(event.pathParameters?.accountId ?? '');
    if (!isValidScopeId('account', accountId)) return json(400, { error: 'accountId (12 digits) required' });
    await ddb.send(
      new DeleteCommand({ TableName: PRICING_TABLE, Key: { model: buildDiscountKey('account', accountId) } }),
    );
    emitAudit(callerIdentity(event), scope, {
      action: 'pricingDiscount.clear',
      targetAccountId: accountId,
      detail: { scope: 'account', scopeId: accountId },
    });
    await triggerResolver();
    metrics.publishStoredMetrics();
    return noContent();
  }

  if (route === 'DELETE /admin/pricing/discounts') {
    const qs = event.queryStringParameters ?? {};
    const scopeKind = (qs.scope ?? 'account') as DiscountScope;
    const scopeId = qs.scopeId ?? '';
    if (!['account', 'ou', 'org'].includes(scopeKind) || !isValidScopeId(scopeKind, scopeId)) {
      return json(400, { error: 'valid scope + scopeId query params required' });
    }
    await ddb.send(
      new DeleteCommand({ TableName: PRICING_TABLE, Key: { model: buildDiscountKey(scopeKind, scopeId) } }),
    );
    emitAudit(callerIdentity(event), scope, {
      action: 'pricingDiscount.clear',
      targetAccountId: scopeKind === 'account' ? scopeId : '*',
      detail: { scope: scopeKind, scopeId },
    });
    await triggerResolver();
    metrics.publishStoredMetrics();
    return noContent();
  }

  if (route === 'POST /admin/pricing/overrides') {
    const body = parseBody<PricingOverrideInput>(event);
    if (!body?.model) {
      return json(400, { error: 'model required' });
    }

    // Build the dimensions map from either the explicit `dimensions` field
    // (multi-dim shape) OR synthesize from the legacy inputPer1k/outputPer1k
    // shorthand. At least one must be present.
    const dimensions: Record<string, DimensionInput> = { ...(body.dimensions ?? {}) };
    if (typeof body.inputPer1k === 'number') {
      dimensions.inputTokens ??= { unit: '1K tokens', pricePerUnit: body.inputPer1k, label: 'Input tokens' };
    }
    if (typeof body.outputPer1k === 'number') {
      dimensions.outputTokens ??= { unit: '1K tokens', pricePerUnit: body.outputPer1k, label: 'Output tokens' };
    }
    if (typeof body.cacheReadPer1k === 'number') {
      dimensions.cacheReadTokens ??= {
        unit: '1K tokens',
        pricePerUnit: body.cacheReadPer1k,
        label: 'Cache read tokens',
      };
    }
    if (typeof body.cacheWritePer1k === 'number') {
      dimensions.cacheWriteTokens ??= {
        unit: '1K tokens',
        pricePerUnit: body.cacheWritePer1k,
        label: 'Cache write tokens',
      };
    }
    if (Object.keys(dimensions).length === 0) {
      return json(400, {
        error: 'At least one dimension (or legacy inputPer1k/outputPer1k pair) required',
      });
    }

    const item = {
      model: body.model,
      // Multi-dim canonical shape (consumed by meter via shared/pricing.ts).
      dimensions,
      // Legacy fields kept in sync for any consumer still reading them.
      inputPer1k: dimensions.inputTokens?.pricePerUnit,
      outputPer1k: dimensions.outputTokens?.pricePerUnit,
      cacheReadPer1k: dimensions.cacheReadTokens?.pricePerUnit,
      cacheWritePer1k: dimensions.cacheWriteTokens?.pricePerUnit,
      displayName: body.displayName ?? body.model,
      // Populate `provider` so an override row isn't schema-asymmetric with the
      // refresher's rows (which set it from ListFoundationModels.providerName).
      // Without this the UI derived a lowercase provider from the model id and
      // split it from the refresher's vendor-cased one (e.g. "openai" vs
      // "OpenAI"). Honor an explicit body.provider, else derive canonically.
      provider: body.provider ?? providerFromModelId(body.model),
      notes: body.notes,
      source: 'override',
      currency: 'USD',
      fetchedAt: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: PRICING_TABLE, Item: item }));
    emitAudit(callerIdentity(event), scope, {
      action: 'pricingOverrides.upsert',
      targetAccountId: '*',
      detail: { model: body.model },
    });
    metrics.publishStoredMetrics();
    return json(201, item);
  }

  if (route === 'DELETE /admin/pricing/override') {
    // model via QUERY param (?model=), not a path segment — a model id can
    // contain '/' (e.g. an inference-profile-style id) which would break
    // HTTP-API path matching. Query values arrive already URL-decoded.
    const model = event.queryStringParameters?.model ?? '';
    if (!model) return json(400, { error: 'model required' });
    await ddb.send(new DeleteCommand({ TableName: PRICING_TABLE, Key: { model } }));
    emitAudit(callerIdentity(event), scope, {
      action: 'pricingOverrides.delete',
      targetAccountId: '*',
      detail: { model },
    });
    metrics.publishStoredMetrics();
    return noContent();
  }

  return json(404, { error: `Unknown route: ${route}` });
};
