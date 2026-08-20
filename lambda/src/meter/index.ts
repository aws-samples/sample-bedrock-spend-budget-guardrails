import { gunzipSync } from 'node:zlib';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { CloudWatchLogsEvent, Context, EventBridgeEvent } from 'aws-lambda';
import { canonicalizeCurPrincipal, routingModeOf, stripCrisPrefix } from '../shared/arn.js';
import { accountFromPrincipal } from '../shared/iam-cross-account.js';
import { ddb, oneHourFromNowEpoch } from '../shared/ddb.js';
import {
  DEFAULTS_PRINCIPAL,
  DEFAULTS_TARGET,
  type DefaultsRow,
} from '../shared/defaults.js';
import { Window, periodFor, spendRowTtl } from '../shared/period.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';
import {
  computeCost,
  type DimensionKind,
  type PricingRow,
  type UsageCounts,
} from '../shared/pricing.js';
import {
  RATE_COUNTER_TTL_SECONDS,
  bucketKeyFor,
  hasRateLimits,
  type RateLimitFields,
} from '../shared/rate-limits.js';
import { getConfiguredMemoryMb, recordSelfCost } from '../shared/self-cost.js';

const RUNNING_SPEND_TABLE = process.env.RUNNING_SPEND_TABLE!;
const IDENTITY_CACHE_TABLE = process.env.IDENTITY_CACHE_TABLE!;
const PENDING_METER_TABLE = process.env.PENDING_METER_TABLE!;
const PRICING_TABLE = process.env.PRICING_TABLE!;
const BUDGETS_TABLE = process.env.BUDGETS_TABLE!;
/** BBG-RATELIMITS — set by metering-stack on home-region meters only.
 *  When unset (legacy / non-rate-limited deployments), the rate-bucket
 *  write path becomes a silent no-op. */
const RATE_COUNTERS_TABLE = process.env.RATE_COUNTERS_TABLE;
/**
 * How many months of RunningSpend history to retain in DynamoDB, used to
 * compute each row's TTL. Defaults to 13 months (a full year of history
 * plus the current month) so the Spend Dashboard period selector can read
 * back history "to when it was first recorded". `0` (or unset-to-0 by an
 * operator) means retain forever — no TTL is written. The S3 ledger is the
 * permanent archive regardless; this only bounds the hot DynamoDB store.
 */
const SPEND_RETENTION_MONTHS = Number.parseInt(
  process.env.SPEND_RETENTION_MONTHS ?? '13',
  10,
);

/**
 * Cache: `principaltarget` → window. Looked up on the meter hot
 * path. 5-minute TTL is plenty since window changes roll over at the
 * next period boundary anyway.
 */
const budgetMetaCache = new Map<string, { meta: BudgetMeta; exp: number }>();
const WINDOW_CACHE_TTL_MS = 5 * 60 * 1000;
const isWindow = (s: unknown): s is Window =>
  s === 'monthly' || s === 'weekly' || s === 'daily' || s === '5h';

/**
 * BBG-RATELIMITS — descriptor used by the meter cache. `rateLimited`
 * is true iff the matching budget has `rpm` or `tpm` set; meter uses
 * this to short-circuit the rate-counter write so non-rate-limited
 * deployments stay zero-overhead.
 */
interface BudgetMeta {
  window: Window;
  rateLimited: boolean;
}

/**
 * Cache for the defaults config row. Same TTL as the window cache.
 */
let defaultsCache: { row?: DefaultsRow; exp: number } = { exp: 0 };

const fetchDefaults = async (): Promise<DefaultsRow | undefined> => {
  if (defaultsCache.exp > Date.now()) return defaultsCache.row;
  const r = await ddb.send(
    new GetCommand({
      TableName: BUDGETS_TABLE,
      Key: { principal: DEFAULTS_PRINCIPAL, target: DEFAULTS_TARGET },
    }),
  ).catch(() => undefined);
  const row = (r?.Item as DefaultsRow | undefined) ?? undefined;
  defaultsCache = { row, exp: Date.now() + WINDOW_CACHE_TTL_MS };
  return row;
};

/**
 * Materialize a default budget for a principal that has no explicit
 * budget yet. Idempotent via `attribute_not_exists(principal)` — if a
 * concurrent meter (or the operator) raced and wrote a real budget
 * first, leave it alone.
 */
const materializeDefaultBudget = async (
  principal: string,
  target: string,
  defaults: DefaultsRow,
): Promise<void> => {
  // BBG-RATELIMITS-DEFAULTS — copy rate-limit fields from the defaults
  // config when set so the materialized row gets the same RPM/TPM
  // protection as principals with explicit budgets. Skipping the keys
  // (rather than writing undefined) keeps the DDB item shape clean for
  // operators reading rows without rate-limits set.
  const item: Record<string, unknown> = {
    principal,
    target,
    limitUsd: defaults.limitUsd,
    enabled: true,
    action: 'deny' as const,
    window: defaults.window ?? 'monthly',
    thresholds: defaults.thresholds,
    source: 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (typeof defaults.rpm === 'number' && defaults.rpm > 0) item.rpm = defaults.rpm;
  if (typeof defaults.tpm === 'number' && defaults.tpm > 0) item.tpm = defaults.tpm;
  if (defaults.rateWindowSeconds) item.rateWindowSeconds = defaults.rateWindowSeconds;
  await ddb.send(
    new PutCommand({
      TableName: BUDGETS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(principal)',
    }),
  ).catch((err) => {
    // Lost the race — caller already has whatever budget exists.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  });
  metrics.addMetric('DefaultBudgetMaterialized', MetricUnit.Count, 1);
};

const lookupBudgetMeta = async (principal: string, target: string): Promise<BudgetMeta> => {
  const key = `${principal}${target}`;
  const cached = budgetMetaCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.meta;
  // Try exact-target then wildcard fallback (matches enforcement's lookup).
  const exact = await ddb.send(
    new GetCommand({ TableName: BUDGETS_TABLE, Key: { principal, target } }),
  ).catch(() => undefined);
  let window: Window = 'monthly';
  let rateLimited = false;
  let foundBudget = Boolean(exact?.Item);
  if (exact?.Item) {
    if (isWindow(exact.Item.window)) window = exact.Item.window;
    if (hasRateLimits(exact.Item as RateLimitFields)) rateLimited = true;
  }
  if (!exact?.Item) {
    const targetParts = target.split('#');
    const wildcard = `${targetParts[0]}#*`;
    const wild = await ddb.send(
      new GetCommand({ TableName: BUDGETS_TABLE, Key: { principal, target: wildcard } }),
    ).catch(() => undefined);
    if (wild?.Item) {
      foundBudget = true;
      if (isWindow(wild.Item.window)) window = wild.Item.window;
      if (hasRateLimits(wild.Item as RateLimitFields)) rateLimited = true;
    }
  }
  // default-deny baseline: if there's no budget at all and the
  // operator has flipped the master toggle on, materialize a default
  // budget for this principal × target so subsequent invocations have a
  // visible, enforceable budget on the books.
  if (!foundBudget) {
    const defaults = await fetchDefaults();
    if (defaults?.enabled && defaults.limitUsd > 0) {
      await materializeDefaultBudget(principal, target, defaults);
      window = defaults.window ?? 'monthly';
    }
  }
  const meta: BudgetMeta = { window, rateLimited };
  budgetMetaCache.set(key, { meta, exp: Date.now() + WINDOW_CACHE_TTL_MS });
  return meta;
};

/**
 * Bedrock invocation log shape — superset of fields we read across all
 * model families. Token counts are universal. Image / video / audio /
 * search counters are only present for the relevant model classes.
 *
 * Two regions get logged separately. `region` is the source region the
 * customer's request was sent to (and the region that owns the log
 * group); `inferenceRegion` is where the model actually ran (different
 * for cross-region inference profiles). Pricing follows the source
 * region per AWS docs.
 */
export interface BedrockInvocationLog {
  schemaType?: string;
  timestamp?: string;
  region?: string;
  inferenceRegion?: string;
  requestId?: string;
  operation?: string;
  /**
   * Either a bare modelId (e.g. `us.anthropic.claude-opus-4-7-v1`) when
   * the caller invoked by model id directly, or the FULL inference-profile
   * ARN (e.g. `arn:aws:bedrock:us-west-2:...:inference-profile/us.anthropic.claude-opus-4-7`)
   * when they invoked via a profile. We canonicalize either shape down to
   * the underlying model id for pricing lookup.
   */
  modelId?: string;
  inferenceProfileArn?: string;
  /**
   * The caller's IAM principal, present directly in the invocation-log
   * record. Verified live 2026-08-18 on both `Converse` and `Responses`
   * records: `identity.arn` is an assumed-role STS ARN, e.g.
   * `arn:aws:sts::111122223333:assumed-role/SomeRole/session`.
   *
   * This is a FALLBACK identity source only. The CloudTrail join stays
   * primary because it also yields the SSO user and `sourceIdentity` that
   * per-human enforcement needs, which this field does not carry.
   */
  identity?: { arn?: string };
  input?: {
    inputTokenCount?: number;
    cacheReadInputTokenCount?: number;
    cacheWriteInputTokenCount?: number;
    audioInputDurationSeconds?: number;
    videoInputDurationSeconds?: number;
  };
  output?: {
    outputTokenCount?: number;
    outputImagesCount?: number;
    outputVideoDurationSeconds?: number;
    outputAudioDurationSeconds?: number;
    searchUnits?: number;
  };
}

interface MeterPayload {
  requestId: string;
  modelId: string;
  inferenceProfileArn?: string;
  usage: UsageCounts;
  region: string;
  eventTime: string;
}

const isCwlEvent = (e: unknown): e is CloudWatchLogsEvent =>
  typeof e === 'object' && e !== null && 'awslogs' in (e as object);

const isIdentityArrivedEvent = (
  e: unknown,
): e is EventBridgeEvent<'bbg.identity-arrived', { requestId: string; principal: string; modelId?: string }> =>
  typeof e === 'object' &&
  e !== null &&
  (e as { 'detail-type'?: string })['detail-type'] === 'bbg.identity-arrived';

/**
 * an earlier change Phase 1b: events emitted by `cwl-forwarder` Lambda in non-home
 * metered regions. Wraps a single CWL log message + the source region.
 */
const isRemoteBedrockInvocationEvent = (
  e: unknown,
): e is EventBridgeEvent<
  'bbg.bedrock-invocation',
  { sourceRegion: string; cwlMessage: string; cwlTimestamp: number; cwlId: string }
> =>
  typeof e === 'object' &&
  e !== null &&
  (e as { 'detail-type'?: string })['detail-type'] === 'bbg.bedrock-invocation';

const decodeCwlEvent = (event: CloudWatchLogsEvent): BedrockInvocationLog[] => {
  const decoded = JSON.parse(
    gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'),
  ) as { messageType: string; logEvents: { message: string }[] };
  if (decoded.messageType !== 'DATA_MESSAGE') return [];
  const logs: BedrockInvocationLog[] = [];
  for (const ev of decoded.logEvents) {
    try {
      logs.push(JSON.parse(ev.message) as BedrockInvocationLog);
    } catch {
      // Skip non-JSON lines (control messages, etc.).
    }
  }
  return logs;
};

/**
 * Persists per-dimension usage and cost on `RunningSpend` row. Schema:
 *   - spendUsd (Number) — aggregate USD across all dimensions
 *   - inputTokens, outputTokens (Number, top-level) — legacy aggregates
 *     consumed by ledger-writer / spend API / SPA tables
 *   - dimUsage (Map<DimensionKind, Number>) — every per-dimension counter
 *   - dimCost  (Map<DimensionKind, Number>) — every per-dimension USD cost
 *   - target, period, lastUpdated, ttl, processedRequestIds (Set) — bookkeeping
 *
 * Idempotent on `processedRequestIds`: a retry of the same requestId is
 * a no-op (CFE → catch ConditionalCheckFailedException).
 */
/**
 * Identity-lens descriptor. When passed to `upsertSpend`, the row is keyed
 * by `lensPrincipal` (e.g. `principal#sso-user#alice@x.com`) instead of the
 * role principal, and carries `identityLens` + `issuerPrincipal` so
 * enforcement can attach the deny to the issuer role scoped to just this
 * identity, and so spend aggregates can exclude these duplicate-dollar rows.
 * See docs/identity-coverage.md.
 */
export interface IdentityLens {
  lensPrincipal: string;
  identityLens: 'sso-user' | 'source-identity';
  /** The role-keyed principal (incl. `principal#` prefix) enforcement attaches to. */
  issuerPrincipal: string;
}

const upsertSpend = async (
  principal: string,
  target: string,
  payload: MeterPayload,
  pricing: PricingRow | undefined,
  routing?: string,
  lens?: IdentityLens,
): Promise<void> => {
  // apply the org's per-account custom pricing discount (if any).
  // Account is derived from the ROLE principal's ARN (the discount is
  // account-level; lens rows share the role's account). Non-ARN principals
  // resolve to undefined → no discount.
  const discountPct = await lookupDiscountPct(accountFromPrincipal(principal));
  const { spendUsd, priced, dimensionsCost, dimensionsUsage } = computeCost(
    pricing,
    payload.region,
    payload.usage,
    discountPct,
    routing,
  );
  // Budget window/meta is resolved against the ROW's principal — a lens row's
  // budget is keyed by the lens principal. For the primary row that's the
  // role principal (unchanged behaviour).
  const rowPrincipal = lens ? lens.lensPrincipal : principal;
  const meta = await lookupBudgetMeta(rowPrincipal, target);
  const window = meta.window;
  const period = periodFor(window, new Date(payload.eventTime));
  const sk = `period#${period}#target#${target}`;

  const exprValues: Record<string, unknown> = {
    ':spend': spendUsd,
    ':rid': new Set([payload.requestId]),
    ':ridScalar': payload.requestId,
    ':now': payload.eventTime,
    ':period': period,
    ':target': target,
  };
  const exprNames: Record<string, string> = {};
  const addClauses: string[] = ['spendUsd :spend', 'processedRequestIds :rid'];
  // ADD on a nested map path (e.g. `dimUsage.outputTokens`) auto-creates
  // the parent map, so we don't need a `SET dimUsage = if_not_exists(...)`
  // pre-clause — and including one would conflict with the ADD path.
  const setClauses: string[] = ['lastUpdated = :now', 'period = :period', 'target = :target'];

  // Identity-lens marker attributes (set-once, never change for a row).
  if (lens) {
    exprValues[':ilens'] = lens.identityLens;
    exprValues[':issuer'] = lens.issuerPrincipal;
    setClauses.push('identityLens = :ilens', 'issuerPrincipal = :issuer');
  }

  // Row TTL: retain SPEND_RETENTION_MONTHS of history so the Spend
  // Dashboard period selector can read it back. `undefined` ⇒ retain
  // forever ⇒ no `ttl` attribute. `if_not_exists` so the first write of a
  // period fixes the row's retention horizon (later writes in the same
  // period don't push it out). Set once, never moved.
  const ttl = spendRowTtl(window, new Date(payload.eventTime), SPEND_RETENTION_MONTHS);
  if (ttl !== undefined) {
    exprValues[':ttl'] = ttl;
    exprNames['#ttl'] = 'ttl';
    setClauses.push('#ttl = if_not_exists(#ttl, :ttl)');
  }

  // Per-dimension usage + cost as FLAT top-level attributes named
  // `usage_<kind>` and `cost_<kind>`. ADD on a top-level missing
  // attribute auto-creates it; nested-map ADD requires the parent to
  // exist, which fights the SET if_not_exists pattern (DDB rejects it
  // with a "two document paths overlap" error). Flat attrs sidestep
  // the issue entirely and are just as queryable.
  let i = 0;
  for (const [kind, count] of Object.entries(dimensionsUsage) as Array<[DimensionKind, number]>) {
    const placeholder = `#du${i}`;
    const valName = `:du${i}`;
    exprNames[placeholder] = `usage_${kind}`;
    exprValues[valName] = count;
    addClauses.push(`${placeholder} ${valName}`);
    i++;
  }
  for (const [kind, cost] of Object.entries(dimensionsCost) as Array<[DimensionKind, number]>) {
    const placeholder = `#dc${i}`;
    const valName = `:dc${i}`;
    exprNames[placeholder] = `cost_${kind}`;
    exprValues[valName] = Number(cost.toFixed(6));
    addClauses.push(`${placeholder} ${valName}`);
    i++;
  }
  if (!priced && Object.keys(dimensionsUsage).length > 0) {
    exprValues[':one'] = 1;
    addClauses.push('unpricedInvocations :one');
  }

  // per-region attribution. payload.region is the source region
  // (where the customer's request was sent), which is what AWS bills at
  // for both bare-modelId and CRIS invocations. Mirror the flat
  // `cost_<kind>` pattern: `region_<code>` with hyphens replaced by
  // underscores (DDB attribute names disallow `-` directly but
  // ExpressionAttributeNames lets us alias). We use underscores in the
  // attribute name for grep-ability.
  if (spendUsd > 0 && payload.region) {
    const regionAttr = `region_${payload.region.replace(/-/g, '_')}`;
    const placeholder = `#r${i}`;
    const valName = `:r${i}`;
    exprNames[placeholder] = regionAttr;
    exprValues[valName] = Number(spendUsd.toFixed(6));
    addClauses.push(`${placeholder} ${valName}`);
    i++;
  }

  // Legacy top-level token aggregates so existing consumers keep working
  // unchanged. ledger-writer reads these, spend API surfaces them, and the
  // SPA's tables show "Tokens (in / out)".
  if (payload.usage.inputTokens) {
    exprValues[':itLegacy'] = payload.usage.inputTokens;
    addClauses.push('inputTokens :itLegacy');
  }
  if (payload.usage.outputTokens) {
    exprValues[':otLegacy'] = payload.usage.outputTokens;
    addClauses.push('outputTokens :otLegacy');
  }

  const updateExpression = `ADD ${addClauses.join(', ')} SET ${setClauses.join(', ')}`;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: RUNNING_SPEND_TABLE,
        Key: { principal: rowPrincipal, sk },
        UpdateExpression: updateExpression,
        ConditionExpression: 'NOT contains(processedRequestIds, :ridScalar)',
        ExpressionAttributeValues: exprValues,
        // DynamoDB rejects an empty ExpressionAttributeNames map; only pass
        // it when at least one alias (#ttl or a `usage_`/`cost_`/`region_`
        // placeholder) was registered.
        ...(Object.keys(exprNames).length > 0 ? { ExpressionAttributeNames: exprNames } : {}),
      }),
    );
    metrics.addMetric('MeterSpendCommitted', MetricUnit.Count, 1);
    if (!priced) metrics.addMetric('UnpricedInvocations', MetricUnit.Count, 1);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Already processed — idempotent retry.
      return;
    }
    throw err;
  }

  // BBG-RATELIMITS — write a per-minute rate-counter bucket alongside
  // the cumulative spend row. Skipped entirely when no budget for this
  // principal × target has rpm/tpm set, keeping the existing zero-
  // overhead claim for non-rate-limited deployments. Failure to write
  // the bucket is logged but never throws — rate enforcement is
  // additive to dollar enforcement, so a transient miss only causes a
  // brief visibility gap, not a correctness issue.
  //
  // Rate buckets are keyed by the ROW principal, so a lens row would
  // write a SECOND bucket for the same event under the lens principal.
  // Rate limiting on identity-lens principals is out of scope (spec:
  // "Known gaps"), and double-writing would need dedup — so only the
  // primary (non-lens) row touches the rate counters.
  if (!lens && meta.rateLimited && RATE_COUNTERS_TABLE) {
    try {
      await upsertRateBucket(rowPrincipal, payload);
    } catch (err) {
      logger.warn('rate-bucket write failed', {
        principal,
        target,
        err: (err as Error).message,
      });
    }
  }
};

/**
 * BBG-RATELIMITS — increments per-minute counters on a single
 * RateCounters row. Both `requestCount` and `tokenCount` are
 * accumulated unconditionally — enforcement decides which (if any) to
 * compare against the budget's rpm/tpm. Per-event TTL refresh keeps
 * the bucket alive at least RATE_COUNTER_TTL_SECONDS past its last
 * activity.
 */
const upsertRateBucket = async (principal: string, payload: MeterPayload): Promise<void> => {
  if (!RATE_COUNTERS_TABLE) return;
  const eventDate = new Date(payload.eventTime);
  const bucket = bucketKeyFor(eventDate);
  const tokens =
    (payload.usage.inputTokens ?? 0) + (payload.usage.outputTokens ?? 0);
  // ttl = bucket-floor + RATE_COUNTER_TTL_SECONDS. Using bucket-floor
  // (not "now") means a late-arriving event for an old bucket doesn't
  // reset the TTL further into the future than the bucket actually
  // covers.
  const minuteFloor = Math.floor(eventDate.getTime() / 60_000) * 60;
  const ttl = minuteFloor + RATE_COUNTER_TTL_SECONDS;
  await ddb.send(
    new UpdateCommand({
      TableName: RATE_COUNTERS_TABLE,
      Key: { principal, bucket },
      UpdateExpression: 'ADD requestCount :one, tokenCount :tok SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':tok': tokens,
        ':ttl': ttl,
      },
    }),
  );
  metrics.addMetric('RateBucketWrites', MetricUnit.Count, 1);
};

const lookupPricing = async (modelId: string): Promise<PricingRow | undefined> => {
  const r = await ddb.send(
    new GetCommand({ TableName: PRICING_TABLE, Key: { model: modelId } }),
  );
  return r.Item as PricingRow | undefined;
};

/**
 * "Custom pricing discount". A discount % is stored in the Pricing table under
 * the reserved key `discount#<accountId>` (namespaced so it never collides with
 * a real `model` row). The meter resolves the invocation's account from its
 * principal ARN and scales metered spend by `(1 - discountPct/100)` in
 * computeCost, so spend reflects the org's negotiated Bedrock rate.
 *
 * Hierarchical (org/OU) discounts do NOT change this hot path: an off-hot-path
 * resolver (org-discount-resolver) walks the Org tree and MATERIALIZES the
 * most-specific winning percentage onto this same account row as
 * `effectivePct`. The meter prefers `effectivePct` (which already reflects an
 * OU- or org-scoped discount inherited by this account) and falls back to the
 * account's own authored `discountPct` for installs where the resolver hasn't
 * run (or isn't the management account). Still one cached GetItem; 5-min TTL.
 */
export const discountRowKey = (accountId: string): string => `discount#${accountId}`;
const discountCache = new Map<string, { pct: number; exp: number }>();
const validPct = (raw: unknown): number =>
  typeof raw === 'number' && raw > 0 && raw <= 100 ? raw : 0;

/**
 * Resolve the effective discount % from a `discount#<acct>` row. Prefers the
 * resolver-materialized `effectivePct` (which already reflects OU/org
 * inheritance and most-specific-wins) over the account's own authored
 * `discountPct`. Exported + pure so the money path has direct test coverage.
 *
 * An account row with authored `discountPct: 0` is an explicit EXCLUSION (list
 * price). The resolver clears `effectivePct` for excluded accounts, so such a
 * row has effectivePct absent and discountPct 0 → both validPct → 0 → no
 * discount. There is no path where an inherited OU/org rate overrides an
 * account exclusion: the resolver never materializes an effectivePct onto an
 * excluded account.
 */
export const effectiveDiscountFromRow = (item: Record<string, unknown> | undefined): number => {
  const effective = validPct(item?.effectivePct);
  return effective || validPct(item?.discountPct);
};

const lookupDiscountPct = async (accountId: string | undefined): Promise<number | undefined> => {
  if (!accountId) return undefined;
  const cached = discountCache.get(accountId);
  if (cached && cached.exp > Date.now()) return cached.pct || undefined;
  const r = await ddb
    .send(new GetCommand({ TableName: PRICING_TABLE, Key: { model: discountRowKey(accountId) } }))
    .catch(() => undefined);
  const pct = effectiveDiscountFromRow(r?.Item);
  discountCache.set(accountId, { pct, exp: Date.now() + WINDOW_CACHE_TTL_MS });
  return pct || undefined;
};

/** The identity joined to an invocation. `principal` is the canonical
 *  role-keyed principal (the primary spend-row key). `ssoUser` /
 *  `sourceIdentity`, when present, drive the per-identity "lens" rows that
 *  make sso-user#/sourceIdentity# budgets meter + enforce (see the
 *  identity-lens section of docs/identity-coverage.md). */
export interface MeterIdentity {
  principal: string;
  ssoUser?: string;
  sourceIdentity?: string;
}

const lookupIdentity = async (requestId: string): Promise<MeterIdentity | undefined> => {
  const r = await ddb.send(
    new GetCommand({ TableName: IDENTITY_CACHE_TABLE, Key: { requestId } }),
  );
  const principal = r.Item?.principal as string | undefined;
  if (!principal) return undefined;
  return {
    principal,
    ssoUser: (r.Item?.ssoUser as string | null | undefined) ?? undefined,
    sourceIdentity: (r.Item?.sourceIdentity as string | null | undefined) ?? undefined,
  };
};

const writePending = async (payload: MeterPayload): Promise<void> => {
  await ddb.send(
    new PutCommand({
      TableName: PENDING_METER_TABLE,
      Item: { ...payload, ttl: oneHourFromNowEpoch() },
    }),
  );
  metrics.addMetric('MeterUnjoined', MetricUnit.Count, 1);
};

const readPending = async (requestId: string): Promise<MeterPayload | undefined> => {
  const r = await ddb.send(
    new GetCommand({ TableName: PENDING_METER_TABLE, Key: { requestId } }),
  );
  return r.Item as MeterPayload | undefined;
};

/**
 * Pulls every known usage counter from the Bedrock invocation log into a
 * canonical UsageCounts record. Token counters are universal; image / video
 * / audio / search counters are model-class-specific and are simply absent
 * for unrelated models. Embeddings are recorded under inputTokens (Bedrock
 * doesn't break out a separate embedTokens counter on the log).
 */
export const extractUsage = (log: BedrockInvocationLog): UsageCounts => ({
  inputTokens: log.input?.inputTokenCount,
  outputTokens: log.output?.outputTokenCount,
  cacheReadTokens: log.input?.cacheReadInputTokenCount,
  cacheWriteTokens: log.input?.cacheWriteInputTokenCount,
  outputImages: log.output?.outputImagesCount,
  inputVideoSeconds: log.input?.videoInputDurationSeconds,
  outputVideoSeconds: log.output?.outputVideoDurationSeconds,
  inputAudioSeconds: log.input?.audioInputDurationSeconds,
  outputAudioSeconds: log.output?.outputAudioDurationSeconds,
  searchUnits: log.output?.searchUnits,
});

/**
 * Splits a `modelId` field into (a) the base model id used for pricing
 * lookup and (b) the inference-profile ARN if the caller invoked through
 * a profile (Bedrock surfaces the full ARN in `modelId` in that case).
 */
const canonicalizeModelId = (
  rawModelId: string,
  fallbackProfileArn: string | undefined,
): { modelId: string; inferenceProfileArn?: string } => {
  // Inference-profile ARN: arn:aws:bedrock:<region>:<acct>:inference-profile/<id>
  const profileMatch = rawModelId.match(
    /^arn:aws:bedrock:[^:]+:[^:]*:inference-profile\/(.+)$/,
  );
  if (profileMatch) {
    // The profile id is the trailing segment, e.g. `us.anthropic.claude-opus-4-7`.
    // For pricing we strip the CRIS prefix and look up the base model.
    return { modelId: profileMatch[1], inferenceProfileArn: rawModelId };
  }
  return { modelId: rawModelId, inferenceProfileArn: fallbackProfileArn };
};

/**
 * Returns true iff the log entry has any non-zero usage counter that we
 * know how to bill. ConverseStream emits TWO log records per requestId:
 * an initial record at stream-start with all counters zeroed, and a
 * final record at stream-end with the real totals. We must skip the
 * zero record so the idempotency guard on processedRequestIds doesn't
 * block the real one.
 */
const hasUsage = (log: BedrockInvocationLog): boolean => {
  const i = log.input ?? {};
  const o = log.output ?? {};
  return Boolean(
    (i.inputTokenCount && i.inputTokenCount > 0) ||
      (o.outputTokenCount && o.outputTokenCount > 0) ||
      (i.cacheReadInputTokenCount && i.cacheReadInputTokenCount > 0) ||
      (i.cacheWriteInputTokenCount && i.cacheWriteInputTokenCount > 0) ||
      (o.outputImagesCount && o.outputImagesCount > 0) ||
      (i.videoInputDurationSeconds && i.videoInputDurationSeconds > 0) ||
      (o.outputVideoDurationSeconds && o.outputVideoDurationSeconds > 0) ||
      (i.audioInputDurationSeconds && i.audioInputDurationSeconds > 0) ||
      (o.outputAudioDurationSeconds && o.outputAudioDurationSeconds > 0) ||
      (o.searchUnits && o.searchUnits > 0),
  );
};

const processInvocation = async (log: BedrockInvocationLog): Promise<void> => {
  if (!log.requestId || !log.modelId) return;

  // ConverseStream emits an initial record with all counts zeroed; the
  // real totals come in the SECOND record. Skip empty records so the
  // idempotency guard doesn't lock in the zeroes and drop the real
  // billing record on arrival.
  if (!hasUsage(log)) return;

  const { modelId, inferenceProfileArn } = canonicalizeModelId(
    log.modelId,
    log.inferenceProfileArn,
  );

  const payload: MeterPayload = {
    requestId: log.requestId,
    modelId,
    inferenceProfileArn,
    usage: extractUsage(log),
    // Pricing follows the source region (the region that owns the log
    // group). `inferenceRegion` may differ for cross-region inference
    // profiles but doesn't drive the rate.
    region: log.region ?? 'us-west-2',
    eventTime: log.timestamp ?? new Date().toISOString(),
  };

  const identity = await lookupIdentity(log.requestId);
  if (identity) {
    await commitJoinedSpend(identity, payload);
    return;
  }

  // The CloudTrail join missed. Before parking this in PendingMeter (1h TTL,
  // after which the spend is lost), fall back to the identity the invocation
  // log itself carries. This is what keeps an API whose CloudTrail eventName
  // we do not yet allowlist from silently dropping spend — the failure mode
  // observed for `Responses` before it was added.
  const loggedArn = log.identity?.arn;
  if (loggedArn) {
    // Reuse the CUR normalizer: it collapses an STS assumed-role ARN to the
    // base role ARN, which is exactly BBG's canonical principal key. SSO
    // callers normalize to a best-effort sessionIssuer key (see its docstring)
    // — the CloudTrail path remains the accurate source for those.
    metrics.addMetric('MeterIdentityFromLog', MetricUnit.Count, 1);
    await commitJoinedSpend(
      { principal: `principal#${canonicalizeCurPrincipal(loggedArn)}` },
      payload,
    );
    return;
  }

  await writePending(payload);
};

const commitJoinedSpend = async (
  identity: MeterIdentity,
  payload: MeterPayload,
): Promise<void> => {
  const { principal } = identity;
  const baseModelId = stripCrisPrefix(payload.modelId);
  // Routing mode (e.g. `global`) is extracted BEFORE the prefix is stripped:
  // Global-routed traffic bills at AWS's distinct Global SKU rate, so the
  // mode must reach computeCost even though the spend TARGET stays keyed by
  // the bare model id (budgets are per-model regardless of routing).
  const routing = routingModeOf(payload.modelId);
  const pricing = await lookupPricing(baseModelId);
  const modelTarget = `model#${baseModelId}`;

  // Primary role-keyed rows (unchanged): a per-model row (always) and a
  // per-profile row (when an inference profile was used) so admins can
  // budget either dimension.
  await upsertSpend(principal, modelTarget, payload, pricing, routing);
  if (payload.inferenceProfileArn) {
    await upsertSpend(
      principal,
      `profile#${payload.inferenceProfileArn}`,
      payload,
      pricing,
      routing,
    );
  }

  // Identity-lens rows (model target only): the per-identity view of the
  // same dollars so `sso-user#`/`sourceIdentity#` budgets meter + enforce.
  // Aggregates EXCLUDE these rows (they duplicate the primary row's spend).
  // No profile lens row — budgeting an identity on a specific inference
  // profile isn't a use case.
  for (const lens of identityLensRows(identity)) {
    await upsertSpend(principal, modelTarget, payload, pricing, routing, lens);
  }
};

/**
 * Given a joined identity, return the identity-lens descriptors whose spend
 * rows should be written alongside the primary role-keyed row. Pure +
 * exported so the contract (key shapes, issuerPrincipal) is unit-tested
 * without a full DDB harness — enforcement (G2) and the spend API/UI (G3)
 * depend on these exact shapes. `issuerPrincipal` is always the canonical
 * role principal, which enforcement attaches the deny to (scoped by
 * aws:userid / aws:SourceIdentity). A plain-role invocation (no ssoUser /
 * sourceIdentity) yields NO lens rows.
 */
export const identityLensRows = (identity: MeterIdentity): IdentityLens[] => {
  const rows: IdentityLens[] = [];
  if (identity.ssoUser) {
    rows.push({
      lensPrincipal: `principal#sso-user#${identity.ssoUser}`,
      identityLens: 'sso-user',
      issuerPrincipal: identity.principal,
    });
  }
  if (identity.sourceIdentity) {
    rows.push({
      lensPrincipal: `principal#sourceIdentity#${identity.sourceIdentity}`,
      identityLens: 'source-identity',
      issuerPrincipal: identity.principal,
    });
  }
  return rows;
};

/**
 * Approximates the DDB calls a single CWL-event invocation makes, so the
 * self-cost emitter can compute a per-invocation USD figure. Per log:
 *   - 1 read (lookupIdentity)
 *   - 1 read (lookupPricing) when joined
 *   - 1 write (writePending) when not joined
 *   - 1 write per upsertSpend target (model row, plus profile row if a
 *     CRIS profile was used)
 * The numbers are an estimate, not bookkeeping — over-counting by a
 * small constant factor is preferable to under-counting because this
 * metric is meant to be a conservative cost ceiling.
 */
const estimatedDdbCallsPerLog = (log: BedrockInvocationLog): { reads: number; writes: number } => {
  if (!hasUsage(log) || !log.requestId || !log.modelId) return { reads: 0, writes: 0 };
  // Identity lookup is unconditional. Assume joined → pricing lookup + 1
  // model-row write + (profile row write iff CRIS prefix present).
  const reads = 2;
  const profileWrite = log.inferenceProfileArn || /^arn:aws:bedrock:/.test(log.modelId) ? 1 : 0;
  const writes = 1 + profileWrite;
  return { reads, writes };
};

export const handler = async (
  event: unknown,
  context?: Context,
): Promise<{ processed: number }> => {
  const startedAt = Date.now();
  let processed = 0;
  let ddbReads = 0;
  let ddbWrites = 0;

  if (isCwlEvent(event)) {
    const logs = decodeCwlEvent(event);
    for (const log of logs) {
      try {
        await processInvocation(log);
        const est = estimatedDdbCallsPerLog(log);
        ddbReads += est.reads;
        ddbWrites += est.writes;
        processed++;
      } catch (err) {
        logger.error('processInvocation failed', {
          err: (err as Error).message,
          requestId: log.requestId,
          modelId: log.modelId,
          region: log.region,
          timestamp: log.timestamp,
        });
      }
    }
  } else if (isRemoteBedrockInvocationEvent(event)) {
    // Cross-region forwarded CWL message from a non-home metered
    // region's cwl-forwarder Lambda. Parse + process the same way
    // local CWL events do.
    try {
      const log = JSON.parse(event.detail.cwlMessage) as BedrockInvocationLog;
      await processInvocation(log);
      const est = estimatedDdbCallsPerLog(log);
      ddbReads += est.reads;
      ddbWrites += est.writes;
      processed++;
    } catch (err) {
      logger.error('remote bedrock-invocation processInvocation failed', {
        err: (err as Error).message,
        sourceRegion: event.detail.sourceRegion,
      });
    }
  } else if (isIdentityArrivedEvent(event)) {
    // Drain pending meter rows now that the identity is known.
    const { requestId, principal } = event.detail;
    const payload = await readPending(requestId);
    ddbReads += 1; // readPending
    if (payload) {
      try {
        // The event carries only the principal string; re-read the full
        // IdentityCache row (which the identity-cache Lambda just wrote,
        // triggering this event) so the drain path also emits the
        // sso-user/source-identity lens rows. Fall back to a
        // principal-only identity if the row is somehow gone (TTL race).
        const identity = (await lookupIdentity(requestId)) ?? { principal };
        ddbReads += 1; // identity re-lookup
        await commitJoinedSpend(identity, payload);
        ddbReads += 1; // pricing lookup
        ddbWrites += payload.inferenceProfileArn ? 2 : 1;
        processed++;
      } catch (err) {
        logger.error('commitJoinedSpend failed during identity-arrived drain', {
          requestId,
          err: (err as Error).message,
        });
      }
      // Delete the pending row regardless: if the commit succeeded we're
      // done; if it failed because processedRequestIds already contains
      // this requestId, the spend is already accounted for. Either way
      // the pending row is no longer useful.
      await ddb.send(new DeleteCommand({ TableName: PENDING_METER_TABLE, Key: { requestId } }));
      ddbWrites += 1;
    }
  } else {
    logger.warn('Unrecognized meter event shape', { keys: Object.keys((event ?? {}) as object) });
  }

  // Self-cost: emit MeterCostUSD with `Lambda=meter` dimension so the ops
  // dashboard can chart what BBG spends on itself per invocation.
  const durationMs = Date.now() - startedAt;
  void context; // remainingTimeInMillis is captured implicitly via wall-clock duration above
  recordSelfCost('meter', durationMs, getConfiguredMemoryMb(), {
    ddbReads,
    ddbWrites,
  });

  metrics.publishStoredMetrics();
  return { processed };
};
