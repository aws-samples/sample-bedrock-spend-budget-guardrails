import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb } from '../../shared/ddb.js';
import { callerActivityKeys, callerScope, json, requireAdmin, scopeAllows } from '../../shared/api.js';
import { accountFromPrincipal } from '../../shared/iam-cross-account.js';

const PRINCIPALS_SEEN_TABLE = process.env.PRINCIPALS_SEEN_TABLE!;
const PRINCIPAL_ACTIVITY_TABLE = process.env.PRINCIPAL_ACTIVITY_TABLE;

interface PrincipalRow {
  principal: string;
  principalType?: string;
  principalArn?: string;
  ssoUser?: string;
  firstSeen?: string;
  lastSeen?: string;
}

const MIN_HOURS = 1;
const MAX_HOURS = 720; // 30 days
const DEFAULT_HOURS = 1;

/** Activity sort key shape: `ts#<iso>#<uuid>` (see shared/activity.ts). */
const ACTIVITY_SK_RE = /^ts#\d{4}-\d{2}-\d{2}T/;

/**
 * Encode a DynamoDB LastEvaluatedKey into an opaque page cursor carrying ONLY
 * the sort key. The partition key (`principal`) is intentionally omitted — the
 * caller always re-supplies it (path/query param, scope-guarded), so a cursor
 * can never be used to read a different principal's rows.
 */
const encodeActivityCursor = (lek: Record<string, unknown> | undefined): string | undefined => {
  const sk = lek?.sk;
  if (typeof sk !== 'string') return undefined;
  return Buffer.from(JSON.stringify({ sk }), 'utf8').toString('base64url');
};

/**
 * Decode a page cursor back into an ExclusiveStartKey, re-attaching the
 * server-known `principal`. Returns undefined for a missing/malformed/forged
 * cursor (fail-safe: start from the newest page rather than error).
 */
const decodeActivityCursor = (
  raw: string | undefined,
  principal: string,
): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { sk?: unknown };
    if (typeof parsed.sk !== 'string' || !ACTIVITY_SK_RE.test(parsed.sk)) return undefined;
    return { principal, sk: parsed.sk };
  } catch {
    return undefined;
  }
};

/**
 * Fields of an activity row's `detail` that are safe to return to the end user
 * on /me/activity. ALLOWLIST (not denylist): an unknown/future field is
 * dropped by default rather than leaked. Notably excludes policyArn, attachedTo,
 * and any raw actor identifiers.
 */
const SELF_DETAIL_ALLOWLIST = [
  'target',
  'thresholdPct',
  'usedPct',
  'spendUsd',
  'limitUsd',
  'period',
  'groups',
  'username',
] as const;

const redactDetailForSelf = (detail: unknown): Record<string, unknown> => {
  if (!detail || typeof detail !== 'object') return {};
  const src = detail as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SELF_DETAIL_ALLOWLIST) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
};

const parsePeriodHours = (raw: string | undefined): number => {
  if (!raw) return DEFAULT_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_HOURS;
  if (n < MIN_HOURS) return MIN_HOURS;
  if (n > MAX_HOURS) return MAX_HOURS;
  return n;
};

/**
 * Central-feed cursor: `{ b, sk?, p?, f }`.
 *   b = bucket to resume at (`day#YYYY-MM-DD`)
 *   sk + p = the within-bucket GSI resume position. Both are required together:
 *     a Query against the byDay GSI needs an ExclusiveStartKey carrying the
 *     index keys (bucket, sk) AND the base-table PK (principal), so `p` is the
 *     principal. Absent (sk+p) = start from the top (newest) of that bucket.
 *   f = the window FLOOR bucket, carried so the `days` window stays stable
 *     across pages (otherwise re-anchoring to `b` each page would slide the
 *     window arbitrarily far back).
 * All fields validated on decode; table/index names are never sourced from the
 * token. Wildcard-only route, but validate anyway in case the gate is loosened.
 */
const BUCKET_RE = /^day#\d{4}-\d{2}-\d{2}$/;

interface AdminCursor {
  b: string;
  sk?: string;
  p?: string;
  f: string;
}

const encodeAdminCursor = (c: AdminCursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

const decodeAdminCursor = (raw: string | undefined): AdminCursor | undefined => {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      b?: unknown;
      sk?: unknown;
      p?: unknown;
      f?: unknown;
    };
    if (typeof c.b !== 'string' || !BUCKET_RE.test(c.b)) return undefined;
    if (typeof c.f !== 'string' || !BUCKET_RE.test(c.f)) return undefined;
    // sk and p travel together (both or neither).
    const hasSk = c.sk !== undefined;
    const hasP = c.p !== undefined;
    if (hasSk !== hasP) return undefined;
    if (hasSk && (typeof c.sk !== 'string' || !ACTIVITY_SK_RE.test(c.sk))) return undefined;
    if (hasP && (typeof c.p !== 'string' || !c.p)) return undefined;
    return {
      b: c.b,
      f: c.f,
      sk: typeof c.sk === 'string' ? c.sk : undefined,
      p: typeof c.p === 'string' ? c.p : undefined,
    };
  } catch {
    return undefined;
  }
};

const dayBucket = (d: Date): string => `day#${d.toISOString().slice(0, 10)}`;
/** One UTC day earlier than a `day#YYYY-MM-DD` bucket. */
const prevBucket = (bucket: string): string =>
  dayBucket(new Date(Date.parse(`${bucket.slice('day#'.length)}T00:00:00.000Z`) - 86400_000));

/**
 * Central activity feed (wildcard-only, checked by the caller). Queries the
 * byDay GSI newest-first, walking back one UTC day per underfilled page, bounded
 * by `days` (default 7, clamp 1..90) and a per-invocation Query cap so a quiet
 * install can't spin dozens of sequential Queries inside the 10s Lambda — it
 * returns a mid-walk cursor instead (never silently truncates). Optional `type`
 * filter is a FilterExpression (does NOT reduce RCUs; documented tradeoff).
 */
const MAX_BUCKET_QUERIES = 30;
const handleAdminActivity = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!PRINCIPAL_ACTIVITY_TABLE) return json(200, { items: [], days: 0 });
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Math.max(parseInt(qs.limit ?? '50', 10) || 50, 1), 200);
  // Up to the full 365-day activity retention. The per-invocation MAX_BUCKET_QUERIES
  // cap + mid-walk cursor bound the work per request regardless of the window.
  const days = Math.min(Math.max(parseInt(qs.days ?? '7', 10) || 7, 1), 365);
  const typeFilter = qs.type && qs.type.length <= 64 ? qs.type : undefined;

  const cursor = decodeAdminCursor(qs.cursor);
  // Walk window. First page: anchor today, floor at today-(days-1). Resumed
  // page: both come from the cursor so the window is STABLE across pagination
  // (days = total reach, not per-page).
  let bucket = cursor ? cursor.b : dayBucket(new Date());
  const floorBucket = cursor?.f ?? dayBucket(new Date(Date.now() - (days - 1) * 86400_000));
  // Within-bucket GSI resume needs all of {bucket, sk, principal}.
  let exclusiveStartKey: Record<string, unknown> | undefined =
    cursor?.sk && cursor?.p ? { bucket: cursor.b, sk: cursor.sk, principal: cursor.p } : undefined;

  const items: Record<string, unknown>[] = [];
  let queries = 0;
  /** Set to the resume position whenever more data remains at loop exit. */
  let resume: { b: string; sk?: string; p?: string } | undefined;

  while (items.length < limit && queries < MAX_BUCKET_QUERIES) {
    queries += 1;
    const r = await ddb.send(
      new QueryCommand({
        TableName: PRINCIPAL_ACTIVITY_TABLE,
        IndexName: 'byDay',
        // `bucket` and `type` are BOTH DynamoDB reserved words — alias them via
        // ExpressionAttributeNames (#b, #t) or the Query 400s (which surfaced as
        // a 500 on the /admin/activity feed).
        KeyConditionExpression: '#b = :b',
        ...(typeFilter
          ? {
              FilterExpression: '#t = :ty',
              ExpressionAttributeNames: { '#b': 'bucket', '#t': 'type' },
            }
          : { ExpressionAttributeNames: { '#b': 'bucket' } }),
        ExpressionAttributeValues: typeFilter ? { ':b': bucket, ':ty': typeFilter } : { ':b': bucket },
        ScanIndexForward: false,
        Limit: limit - items.length,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const it of r.Items ?? []) items.push(it);

    if (r.LastEvaluatedKey) {
      // More rows in THIS bucket. Carry the FULL GSI key (bucket+sk+principal).
      exclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown>;
      if (items.length >= limit) {
        resume = { b: bucket, sk: String(r.LastEvaluatedKey.sk), p: String(r.LastEvaluatedKey.principal) };
        break;
      }
      continue; // keep draining this bucket
    }

    // Bucket fully drained. Done if we're at the window floor.
    if (bucket === floorBucket) break;
    bucket = prevBucket(bucket);
    exclusiveStartKey = undefined;
    // Filled exactly at the boundary → resume from the TOP of the next bucket.
    if (items.length >= limit) {
      resume = { b: bucket };
      break;
    }
  }

  // Stopped by the per-invocation query cap (not the limit, not the floor) with
  // data still pending: hand back where we are so nothing is silently dropped.
  if (!resume && queries >= MAX_BUCKET_QUERIES && bucket !== floorBucket) {
    resume = exclusiveStartKey
      ? { b: bucket, sk: String(exclusiveStartKey.sk), p: String(exclusiveStartKey.principal) }
      : { b: bucket };
  }

  return json(200, {
    items: items.slice(0, limit).map((it) => ({
      principal: it.principal,
      ts: it.ts,
      type: it.type,
      summary: it.summary,
      actor: it.actor,
      accountId: it.accountId,
    })),
    cursor: resume ? encodeAdminCursor({ ...resume, f: floorBucket }) : undefined,
    days,
  });
};

/**
 * BBG self-service activity: a signed-in user's OWN timeline. Subject is derived
 * ENTIRELY from signed claims (callerActivityKeys) — there is no principal input
 * of any kind, so nothing to tamper with. Merges up to a handful of bounded
 * per-key Queries, sorts newest-first, redacts actor→byAdmin + detail→allowlist,
 * and never 403s (unmapped users get an empty, unmapped:true response).
 *
 * The `{ i, sk }` cursor indexes into the CALLER-DERIVED key list (re-derived
 * from claims every page) plus a sort key — it can never name a principal, so a
 * forged cursor at worst pages the caller's own timeline.
 */
const handleMyActivity = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!PRINCIPAL_ACTIVITY_TABLE) return json(200, { items: [], unmapped: true, mappedPrincipal: false });
  const { keys, mapped } = callerActivityKeys(event);
  if (keys.length === 0) {
    return json(200, { items: [], unmapped: true, mappedPrincipal: false });
  }
  const limit = Math.min(Math.max(parseInt(event.queryStringParameters?.limit ?? '50', 10) || 50, 1), 200);

  // Query each of the caller's keys (bounded), merge, sort desc, truncate.
  // Each key is a distinct partition; we over-fetch `limit` from each then trim.
  const perKey = await Promise.all(
    keys.map((principal) =>
      ddb
        .send(
          new QueryCommand({
            TableName: PRINCIPAL_ACTIVITY_TABLE,
            KeyConditionExpression: 'principal = :p',
            ExpressionAttributeValues: { ':p': principal },
            ScanIndexForward: false,
            Limit: limit,
          }),
        )
        .then((r) => r.Items ?? [])
        .catch(() => [] as Record<string, unknown>[]),
    ),
  );
  const merged = perKey
    .flat()
    .sort((a, b) => String(b.sk).localeCompare(String(a.sk)))
    .slice(0, limit);

  return json(200, {
    items: merged.map((it) => ({
      ts: it.ts,
      type: it.type,
      summary: it.summary,
      detail: redactDetailForSelf(it.detail),
      // Redact the actor: reveal only whether an admin (vs the system) acted —
      // never a colleague's email.
      byAdmin: Boolean(it.actor),
    })),
    unmapped: !mapped,
    mappedPrincipal: mapped,
  });
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // Self-service route: claim-derived, no admin gate. Handled ABOVE the
  // requireAdmin wall (exact-literal match, NOT a predicate — a predicate fails
  // OPEN on a future typo'd route string).
  if (event.routeKey === 'GET /me/activity') return handleMyActivity(event);

  // ---- everything below this line is admin-only ----
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const scope = callerScope(event);

  // Central cross-principal activity feed. WILDCARD-ONLY: a large share of rows
  // are keyed on principals accountFromPrincipal can't resolve (user#, sso-user#,
  // sourceIdentity#), and scopeAllows fails closed on those — a scoped feed would
  // be silently holed. Scoped admins keep the per-principal timeline instead.
  if (event.routeKey === 'GET /admin/activity') {
    if (!scope.isWildcard) {
      return json(403, { error: 'Forbidden: central activity feed is super-admin only' });
    }
    return handleAdminActivity(event);
  }

  // per-principal activity timeline. Principal comes via the
  // `?principal=` QUERY param (not a path segment) — an IAM principal key
  // embeds an ARN whose `/` breaks HTTP-API path matching (see api-stack.ts).
  // API Gateway already URL-decodes query values, so read it directly.
  if (event.routeKey === 'GET /admin/principal-activity') {
    if (!PRINCIPAL_ACTIVITY_TABLE) return json(200, { items: [] });
    const principal = event.queryStringParameters?.principal ?? '';
    if (!principal) return json(400, { error: 'principal required' });
    // Per-account scope guard: a scoped admin may only read a principal in
    // an account they administer. accountFromPrincipal is strict (undefined
    // for non-ARN principals → wildcard-admin-only, fail-closed).
    if (!scope.isWildcard && !scopeAllows(scope, accountFromPrincipal(principal))) {
      return json(403, { error: 'Forbidden: principal is outside your scope' });
    }
    const limit = Math.min(Math.max(parseInt(event.queryStringParameters?.limit ?? '50', 10) || 50, 1), 200);
    // Cursor carries ONLY the DynamoDB sort key — `principal` comes from the
    // (already scope-guarded) query param, never the token, so a forged cursor
    // can't pivot to another principal. Reject anything that isn't a plausible
    // activity sort key.
    const exclusiveStartKey = decodeActivityCursor(event.queryStringParameters?.cursor, principal);
    const r = await ddb.send(
      new QueryCommand({
        TableName: PRINCIPAL_ACTIVITY_TABLE,
        KeyConditionExpression: 'principal = :p',
        ExpressionAttributeValues: { ':p': principal },
        ScanIndexForward: false, // newest first
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    return json(200, {
      items: (r.Items ?? []).map((it) => ({
        ts: it.ts,
        type: it.type,
        summary: it.summary,
        detail: it.detail ?? {},
        actor: it.actor,
      })),
      cursor: encodeActivityCursor(r.LastEvaluatedKey),
    });
  }

  const periodHours = parsePeriodHours(event.queryStringParameters?.periodHours);
  const thresholdIso = new Date(Date.now() - periodHours * 3600 * 1000).toISOString();

  // PrincipalsSeen is a small table (~10s–1000s of rows: one per distinct
  // canonicalized principal). A scan with FilterExpression on `lastSeen`
  // is the right shape — Query would need a GSI without buying us much
  // since rows already roll off via TTL after 30d of inactivity.
  const items: PrincipalRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: PRINCIPALS_SEEN_TABLE,
        FilterExpression: 'lastSeen >= :t',
        ExpressionAttributeValues: { ':t': thresholdIso },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const row of (r.Items ?? []) as PrincipalRow[]) items.push(row);
    exclusiveStartKey = r.LastEvaluatedKey;
  } while (exclusiveStartKey);

  // per-account admins only see identities whose principal ARN
  // names an account in their scope.
  const visible = scope.isWildcard
    ? items
    : items.filter((r) => scopeAllows(scope, accountFromPrincipal(r.principalArn ?? r.principal)));

  // Map to the response shape the SPA expects. `eventTime` is preserved
  // for back-compat with the original handler — it now means lastSeen.
  const responseItems = visible
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
    .map((r) => ({
      principal: r.principal,
      principalType: r.principalType,
      principalArn: r.principalArn,
      ssoUser: r.ssoUser,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      eventTime: r.lastSeen,
    }));

  return json(200, { items: responseItems, periodHours });
};
