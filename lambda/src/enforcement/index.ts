import {
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreatePolicyCommand,
  GetPolicyCommand,
} from '@aws-sdk/client-iam';
import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ddb } from '../shared/ddb.js';
import { accountFromPrincipal, iamForAccount } from '../shared/iam-cross-account.js';
import {
  buildDenyPolicy,
  denyPolicyName,
  principalToAttachTarget,
} from '../shared/policies.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';
import {
  DEFAULT_RATE_WINDOW_SECONDS,
  bucketKeysForWindow,
  hasRateLimits,
  type EnforcementReason,
  type RateLimitFields,
  type RateWindowSeconds,
} from '../shared/rate-limits.js';
import { getConfiguredMemoryMb, recordSelfCost } from '../shared/self-cost.js';
import { recordActivity } from '../shared/activity.js';
import {
  Threshold,
  blockThreshold,
  resolveThresholds,
} from '../shared/thresholds.js';

const BUDGETS_TABLE = process.env.BUDGETS_TABLE!;
const RUNNING_SPEND_TABLE = process.env.RUNNING_SPEND_TABLE!;
const INFERENCE_PROFILES_TABLE = process.env.INFERENCE_PROFILES_TABLE!;
const RATE_COUNTERS_TABLE = process.env.RATE_COUNTERS_TABLE;

/**
 * ENF-2 kill-switch. When `ENFORCEMENT_PAUSED=true`, the Lambda skips
 * attaching NEW deny policies (logs + emits an `EnforcementPaused`
 * metric and no-ops). Already-attached denies are untouched; period-
 * rollover still detaches them. Read per-invocation so a redeploy that
 * flips the flag takes effect immediately (env is re-read on cold start;
 * this function evaluates the current value each call).
 */
const enforcementPaused = (): boolean => process.env.ENFORCEMENT_PAUSED === 'true';


interface BudgetRow {
  principal: string;
  target: string;
  limitUsd: number;
  action: 'deny' | 'alert';
  thresholds?: Threshold[];
  unlimited?: boolean;
  enabled: boolean;
  condition?: { tagKey?: string; tagValue?: string };
  /** BBG-RATELIMITS — request rate limit per `rateWindowSeconds`. */
  rpm?: number;
  /** BBG-RATELIMITS — token rate limit per `rateWindowSeconds`. */
  tpm?: number;
  /** BBG-RATELIMITS — sliding window length (60, 300, or 900 seconds). */
  rateWindowSeconds?: RateWindowSeconds;
}

interface SpendRow {
  principal: string;
  sk: string;
  spendUsd: number;
  period: string;
  target: string;
  enforcementPolicyArn?: string;
  /** Identity-lens rows (G1): when set, this row is the per-identity view
   *  of a role's spend. Enforcement attaches the deny to `issuerPrincipal`
   *  (the role) scoped to just this identity via aws:userid / aws:SourceIdentity.
   *  See docs/identity-coverage.md. */
  identityLens?: 'sso-user' | 'source-identity';
  issuerPrincipal?: string;
}

const fetchBudget = async (principal: string, target: string): Promise<BudgetRow | undefined> => {
  const r = await ddb.send(
    new GetCommand({ TableName: BUDGETS_TABLE, Key: { principal, target } }),
  );
  return r.Item as BudgetRow | undefined;
};

const profilesForModel = async (target: string): Promise<string[]> => {
  if (!target.startsWith('model#') || target === 'model#*') return [];
  const modelId = target.slice('model#'.length);
  const r = await ddb.send(
    new QueryCommand({
      TableName: INFERENCE_PROFILES_TABLE,
      IndexName: 'byModel',
      KeyConditionExpression: 'modelId = :m',
      ExpressionAttributeValues: { ':m': modelId },
    }),
  ).catch(() => undefined);
  if (!r?.Items) return [];
  return r.Items.map((it) => it.profileArn as string).filter(Boolean);
};

const ensurePolicy = async (
  accountId: string,
  policyName: string,
  document: object,
): Promise<string> => {
  const expectedArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
  const client = await iamForAccount(accountId);
  try {
    await client.send(
      new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(document),
        Description: 'BBG generated deny policy — auto-attached when a Bedrock budget is breached.',
      }),
    );
    return expectedArn;
  } catch (err) {
    if ((err as { name?: string }).name === 'EntityAlreadyExistsException') {
      const r = await client.send(new GetPolicyCommand({ PolicyArn: expectedArn }));
      return r.Policy?.Arn ?? expectedArn;
    }
    throw err;
  }
};

const attachPolicyOnce = async (
  accountId: string,
  principal: string,
  policyArn: string,
): Promise<void> => {
  const target = principalToAttachTarget(principal);
  if (!target) {
    logger.info('Principal not directly attachable; relying on policy Condition only', { principal });
    return;
  }
  const client = await iamForAccount(accountId);
  if (target.attachKind === 'user') {
    await client.send(new AttachUserPolicyCommand({ UserName: target.name, PolicyArn: policyArn }));
  } else {
    await client.send(new AttachRolePolicyCommand({ RoleName: target.name, PolicyArn: policyArn }));
  }
};

/** Truncate principal ARN for use as a metric dimension (CloudWatch dimension
 * values are limited to 256 chars; we cap at 200 to leave headroom and keep
 * cardinality predictable on long agent-role ARNs). */
const truncatePrincipalForDimension = (principal: string): string =>
  principal.length > 200 ? principal.slice(0, 200) : principal;

/** Extract the email from an sso-user lens principal key
 *  (`principal#sso-user#alice@example.com` → `alice@example.com`). */
const emailFromLensPrincipal = (principal: string): string =>
  principal.replace(/^principal#sso-user#/, '');

/** Extract the value from a source-identity lens principal key
 *  (`principal#sourceIdentity#svc-abc` → `svc-abc`). */
const valueFromLensPrincipal = (principal: string): string =>
  principal.replace(/^principal#sourceIdentity#/, '');

/** Retry parameters for the IAM attach call. The DynamoDB stream record won't
 * be redelivered (the event source mapping is configured for at-most-once
 * delivery to keep enforcement idempotent), so any retry must happen
 * in-process. Three attempts at 100ms / 400ms / 1600ms (with ±50% jitter)
 * gives us ~2s of cover against transient IAM throttles without holding up
 * the stream consumer for too long. */
const ATTACH_RETRY_BASE_DELAYS_MS = [100, 400, 1600];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (baseMs: number): number => {
  // ±50% jitter around the base delay.
  const factor = 0.5 + Math.random();
  return Math.round(baseMs * factor);
};

const attachPolicyWithRetry = async (
  accountId: string,
  principal: string,
  policyArn: string,
  spendArn: string,
): Promise<void> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < ATTACH_RETRY_BASE_DELAYS_MS.length; attempt++) {
    try {
      await attachPolicyOnce(accountId, principal, policyArn);
      return;
    } catch (err) {
      lastErr = err;
      const delay = jitter(ATTACH_RETRY_BASE_DELAYS_MS[attempt]);
      logger.warn('Attach attempt failed; will retry', {
        attempt: attempt + 1,
        maxAttempts: ATTACH_RETRY_BASE_DELAYS_MS.length,
        nextDelayMs: delay,
        spendArn,
        policyArn,
        err: (err as Error).message,
      });
      if (attempt < ATTACH_RETRY_BASE_DELAYS_MS.length - 1) {
        await sleep(delay);
      }
    }
  }

  // All retries exhausted: the spend row already has enforcementPolicyArn
  // stamped (set-once guard), so the caller is in a "stamped but not attached"
  // state and operator action is required. Dual-emit: one with the principal
  // dimension (via singleMetric() so it doesn't leak onto other metrics in
  // this invocation) for drill-down, plus a rollup on the default dimension
  // set so the bbg-enforcement-attach-stuck alarm — which is a single-stream
  // metric alarm — can fire on ANY failure across the principal population.
  // CloudWatch metric alarms reject SEARCH expressions so the rollup-emit
  // pattern is the only way to alarm across a high-cardinality dimension.
  const stuckMetric = metrics.singleMetric();
  stuckMetric.addDimension('principal', truncatePrincipalForDimension(principal));
  stuckMetric.addMetric('EnforcementAttachStuck', MetricUnit.Count, 1);
  metrics.addMetric('EnforcementAttachStuck', MetricUnit.Count, 1);
  logger.error('Enforcement attach failed after retries — spend row is stamped but principal is NOT blocked. Operator must manually attach the deny policy. See docs/runbooks/alarms/enforcement-attach-stuck.md', {
    spendArn,
    policyArn,
    principal,
    attempts: ATTACH_RETRY_BASE_DELAYS_MS.length,
    err: (lastErr as Error)?.message,
  });
  throw lastErr;
};

const stampEnforcementOnSpend = async (
  row: SpendRow,
  policyArn: string,
  reason: EnforcementReason = 'usd',
  metric?: { value: number; limit: number; windowSeconds?: number },
): Promise<boolean> => {
  try {
    const exprValues: Record<string, unknown> = { ':a': policyArn, ':r': reason };
    let updateExpr = 'SET enforcementPolicyArn = :a, enforcementReason = :r';
    if (metric) {
      updateExpr += ', enforcementMetric = :m';
      exprValues[':m'] = metric;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: RUNNING_SPEND_TABLE,
        Key: { principal: row.principal, sk: row.sk },
        UpdateExpression: updateExpr,
        ConditionExpression: 'attribute_not_exists(enforcementPolicyArn)',
        ExpressionAttributeValues: exprValues,
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
};

/**
 * BBG-RATELIMITS — read the per-minute rate-counter buckets covering
 * `windowSeconds` and return the summed (requestCount, tokenCount).
 * Buckets that don't exist yet show up as missing keys; missing
 * counts are treated as zero. Returns zeros when RATE_COUNTERS_TABLE
 * isn't set (legacy / non-rate-limited deployments).
 */
const sumRateBuckets = async (
  principal: string,
  windowSeconds: RateWindowSeconds,
  now: Date = new Date(),
): Promise<{ requestCount: number; tokenCount: number }> => {
  if (!RATE_COUNTERS_TABLE) return { requestCount: 0, tokenCount: 0 };
  const buckets = bucketKeysForWindow(windowSeconds, now);
  // BatchGet caps at 100 keys; max we'd ever ask for is 16 (15min
  // window + current). Single batch is fine.
  const r = await ddb.send(
    new BatchGetCommand({
      RequestItems: {
        [RATE_COUNTERS_TABLE]: {
          Keys: buckets.map((bucket) => ({ principal, bucket })),
        },
      },
    }),
  );
  const items = r.Responses?.[RATE_COUNTERS_TABLE] ?? [];
  let requestCount = 0;
  let tokenCount = 0;
  for (const it of items) {
    if (typeof it.requestCount === 'number') requestCount += it.requestCount;
    if (typeof it.tokenCount === 'number') tokenCount += it.tokenCount;
  }
  return { requestCount, tokenCount };
};

/**
 * BBG-RATELIMITS — evaluate the budget's rpm/tpm signal against the
 * sliding-window counters. Returns the reason + metric snapshot when a
 * threshold is breached; undefined when no breach. Caller is
 * responsible for ensuring `budget` actually has rate limits set.
 */
const evaluateRateLimits = async (
  budget: BudgetRow,
): Promise<{
  reason: EnforcementReason;
  metric: { value: number; limit: number; windowSeconds: number };
} | undefined> => {
  const windowSeconds = (budget.rateWindowSeconds ?? DEFAULT_RATE_WINDOW_SECONDS) as RateWindowSeconds;
  const { requestCount, tokenCount } = await sumRateBuckets(budget.principal, windowSeconds);
  if (typeof budget.rpm === 'number' && budget.rpm > 0 && requestCount >= budget.rpm) {
    return {
      reason: 'rpm',
      metric: { value: requestCount, limit: budget.rpm, windowSeconds },
    };
  }
  if (typeof budget.tpm === 'number' && budget.tpm > 0 && tokenCount >= budget.tpm) {
    return {
      reason: 'tpm',
      metric: { value: tokenCount, limit: budget.tpm, windowSeconds },
    };
  }
  return undefined;
};

const evaluateAndEnforce = async (row: SpendRow): Promise<void> => {
  // Look up both an exact-target budget and the wildcard fallback.
  const targetParts = row.target.split('#');
  const wildcard = `${targetParts[0]}#*`;
  const [exact, wild] = await Promise.all([
    fetchBudget(row.principal, row.target),
    fetchBudget(row.principal, wildcard),
  ]);

  for (const budget of [exact, wild]) {
    if (!budget?.enabled) continue;
    if (budget.unlimited) {
      // Per-budget escape hatch. Meter still records spend
      // for visibility; we just never attach a deny policy.
      metrics.addMetric('UnlimitedBudgetSeen', MetricUnit.Count, 1);
      logger.debug('Unlimited budget — skipping enforcement', {
        principal: row.principal,
        target: budget.target,
      });
      continue;
    }

    // BBG-RATELIMITS — evaluate the rate-limit signal *before* the
    // USD/threshold path. A runaway agent loop trips the rate signal
    // first (within 60s of the first burst) where the USD signal
    // would only fire after the loop has actually accumulated enough
    // dollars to cross the block threshold. Both paths share the same
    // deny primitive — the only difference is the reason field
    // stamped on the spend row.
    let rateBreach: Awaited<ReturnType<typeof evaluateRateLimits>> | undefined;
    if (hasRateLimits(budget as RateLimitFields)) {
      rateBreach = await evaluateRateLimits(budget);
    }

    const thresholds = resolveThresholds(budget);
    const blockTh = blockThreshold(thresholds);

    if (!rateBreach) {
      // No rate breach: fall through to the existing USD path.
      if (!blockTh) {
        // Pure alert-only budget (no block threshold). Track the breach for
        // visibility but don't attach a deny policy.
        if (row.spendUsd >= budget.limitUsd) {
          metrics.addMetric('AlertOnlyBreaches', MetricUnit.Count, 1);
          logger.info('Alert-only budget breached', { principal: row.principal, target: row.target });
        }
        continue;
      }
      const blockAtUsd = budget.limitUsd * (blockTh.at / 100);
      if (row.spendUsd < blockAtUsd) continue;
    }
    if (row.enforcementPolicyArn) return;

    // ENF-2 kill-switch: an operator has paused enforcement (e.g. a
    // metering bug is over-denying org-wide). We've confirmed a breach
    // that WOULD attach a deny, but skip it — no policy is created or
    // stamped, so enforcement resumes cleanly on the next stream event
    // once the flag is cleared. Emit a metric so the pause is visible on
    // the dashboard and doesn't get silently forgotten.
    if (enforcementPaused()) {
      metrics.addMetric('EnforcementPaused', MetricUnit.Count, 1);
      logger.warn('Enforcement paused (ENF-2 kill-switch) — skipping deny attach', {
        principal: row.principal,
        target: budget.target,
        spendUsd: row.spendUsd,
        limitUsd: budget.limitUsd,
      });
      return;
    }

    // Resolve WHERE the deny attaches + HOW it's scoped.
    //
    // Identity-lens rows (G1: principal#sso-user#<email> /
    // principal#sourceIdentity#<value>) enforce by attaching the deny to
    // the ISSUER role (`issuerPrincipal`, a real IAM ARN) scoped to just
    // this identity's sessions via aws:userid / aws:SourceIdentity — so
    // other users of the shared role are unaffected. Non-lens rows attach
    // to the row principal (IAM user/role budgets) or carry the existing
    // budget.condition (aws:PrincipalTag) for role-keyed session-tag budgets.
    const attachPrincipal = row.issuerPrincipal ?? row.principal;
    const denyConditions =
      row.identityLens === 'sso-user'
        ? { ssoUserEmail: emailFromLensPrincipal(row.principal) }
        : row.identityLens === 'source-identity'
          ? { sourceIdentity: valueFromLensPrincipal(row.principal) }
          : { sessionTagKey: budget.condition?.tagKey, sessionTagValue: budget.condition?.tagValue };

    // FAIL LOUD instead of stamping an inert policy: if there's no attachable
    // target AND no scoping condition, an unattached customer-managed policy
    // does nothing — the old code created + stamped it anyway, producing a
    // false "Enforced (denied)" state while the principal kept spending. Now
    // we emit EnforcementUnattachable (dual-emit rollup, like
    // EnforcementAttachStuck) and skip — no policy, no stamp, no
    // EnforcementApplied. The EnforcementUnattachable alarm surfaces it so
    // the operator can re-key the budget (sso-user#/sourceIdentity#/role+condition).
    const hasAttachTarget = principalToAttachTarget(attachPrincipal) !== null;
    const hasScopingCondition =
      denyConditions.ssoUserEmail !== undefined ||
      denyConditions.sourceIdentity !== undefined ||
      (denyConditions.sessionTagKey !== undefined && denyConditions.sessionTagValue !== undefined);
    if (!hasAttachTarget && !hasScopingCondition) {
      const stuck = metrics.singleMetric();
      stuck.addDimension('principal', truncatePrincipalForDimension(row.principal));
      stuck.addMetric('EnforcementUnattachable', MetricUnit.Count, 1);
      metrics.addMetric('EnforcementUnattachable', MetricUnit.Count, 1);
      logger.error(
        'Budget breached but principal is not enforceable — no attach target and no scoping condition. Deny NOT applied. Re-key the budget to sso-user#/sourceIdentity#/role+condition, or set it alert-only. See docs/runbooks/alarms/enforcement-unattachable.md',
        { principal: row.principal, target: budget.target, spendUsd: row.spendUsd },
      );
      await recordActivity({
        principal: row.principal,
        type: 'enforcement.unattachable',
        summary: `Budget breached but not enforceable (no attachable identity) for ${budget.target}`,
        detail: { target: budget.target, spendUsd: row.spendUsd, limitUsd: budget.limitUsd },
      });
      return;
    }

    // derive the account to place the policy in from the ATTACH
    // principal (the issuer role for lens rows). PLACEMENT fallback
    // (deliberate, load-bearing): a role-keyed session-tag Condition-only
    // budget has an attachable... — actually if we reach here without an
    // attach target we DO have a scoping condition, so the policy is
    // created in the home account and gates via its Condition. Authorization
    // scope checks use the strict result and fail closed instead.
    const principalAccount =
      accountFromPrincipal(attachPrincipal) ?? process.env.AWS_ACCOUNT_ID ?? '';

    const profiles = await profilesForModel(budget.target);
    const policyDoc = buildDenyPolicy({
      target: budget.target,
      associatedProfileArns: profiles,
      ...denyConditions,
    });
    const policyName = denyPolicyName(row.principal, budget.target, row.period);

    let policyArn: string;
    try {
      policyArn = await ensurePolicy(principalAccount, policyName, policyDoc);
    } catch (err) {
      logger.error('Failed to create/get deny policy', { policyName, err: (err as Error).message });
      metrics.addMetric('EnforcementErrors', MetricUnit.Count, 1);
      throw err;
    }

    // BBG-RATELIMITS — record what triggered the deny so the SPA / notify
    // Lambda render the right cause. USD breach is the default reason
    // when no rate breach was detected.
    const reason: EnforcementReason = rateBreach?.reason ?? 'usd';
    const metricSnapshot = rateBreach
      ? rateBreach.metric
      : blockTh
      ? { value: row.spendUsd, limit: budget.limitUsd }
      : undefined;
    const stamped = await stampEnforcementOnSpend(row, policyArn, reason, metricSnapshot);
    if (!stamped) {
      // Another invocation already wrote a policy ARN; skip the attach to
      // avoid duplicate work.
      return;
    }

    const spendArn = `${row.principal}|${row.sk}`;
    try {
      // Attach to the issuer role for lens rows (else the row principal).
      await attachPolicyWithRetry(principalAccount, attachPrincipal, policyArn, spendArn);
      metrics.addMetric('EnforcementApplied', MetricUnit.Count, 1);
      if (rateBreach) {
        // BBG-RATELIMITS — separate metric so dashboards can chart
        // rate-triggered enforcement vs USD-triggered. Same shape as
        // the existing EnforcementApplied so the dashboard widget
        // stack can be a sibling.
        metrics.addMetric('RateLimitEnforcementApplied', MetricUnit.Count, 1);
      }
      logger.warn('Budget breached — deny policy attached', {
        principal: row.principal,
        target: budget.target,
        reason,
        spendUsd: row.spendUsd,
        limitUsd: budget.limitUsd,
        blockThresholdPct: blockTh?.at,
        rateMetric: rateBreach?.metric,
        policyArn,
      });
      // record the enforcement on BOTH the row principal (the lens
      // identity, when this is a lens row) and — for a lens row — nothing
      // extra; the row principal IS the meaningful subject of the deny.
      await recordActivity({
        principal: row.principal,
        type: 'enforcement.applied',
        summary: `Deny attached for ${budget.target} (${reason}) — spend $${row.spendUsd.toFixed(2)} ≥ limit $${budget.limitUsd.toFixed(2)}`,
        detail: {
          target: budget.target,
          reason,
          spendUsd: row.spendUsd,
          limitUsd: budget.limitUsd,
          policyArn,
          attachedTo: attachPrincipal,
        },
      });
    } catch (err) {
      // attachPolicyWithRetry has already emitted EnforcementAttachStuck and
      // logged the structured failure context; we still increment
      // EnforcementErrors so existing dashboards/alarms see the failure.
      metrics.addMetric('EnforcementErrors', MetricUnit.Count, 1);
      logger.error('Failed to attach deny policy', { policyArn, err: (err as Error).message });
      throw err;
    }
    return;
  }
};

export const handler = async (event: DynamoDBStreamEvent): Promise<{ processed: number }> => {
  const startedAt = Date.now();
  let processed = 0;
  // Each record we process consults up to 2 BUDGETS_TABLE rows (exact +
  // wildcard) and may stamp 1 RUNNING_SPEND_TABLE row when a breach
  // triggers enforcement. The IAM CreatePolicy / AttachPolicy calls don't
  // count toward DDB self-cost (they bill against IAM, which is free
  // until you hit large quotas — we'd add an iam-call cost line if it
  // ever became material).
  let ddbReads = 0;
  let ddbWrites = 0;

  for (const record of event.Records) {
    if (record.eventName !== 'MODIFY' && record.eventName !== 'INSERT') continue;
    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;
    try {
      const row = unmarshall(newImage as Record<string, never>) as SpendRow;
      if (typeof row.spendUsd !== 'number') continue;
      await evaluateAndEnforce(row);
      ddbReads += 2; // exact + wildcard budget lookup
      processed++;
    } catch (err) {
      logger.error('enforcement record failed', { err: (err as Error).message });
    }
  }

  recordSelfCost('enforcement', Date.now() - startedAt, getConfiguredMemoryMb(), {
    ddbReads,
    ddbWrites,
  });
  metrics.publishStoredMetrics();
  return { processed };
};
