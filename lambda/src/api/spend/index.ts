import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb, periodFor } from '../../shared/ddb.js';
import { callerPrincipalKey, callerScope, json, requireAdmin, scopeAllows } from '../../shared/api.js';
import { accountFromPrincipal } from '../../shared/iam-cross-account.js';

const RUNNING_SPEND_TABLE = process.env.RUNNING_SPEND_TABLE!;

/**
 * Display-only account attribution for the /spend/trend byAccount split.
 * Buckets by the true ARN account — `accountFromPrincipal` matches both
 * `iam` and `sts` ARNs (federated principals are stored as sts ARNs) — and
 * returns '(unknown)' for principals with no account segment, so a non-ARN
 * principal never inflates the home account's trend line. Kept semantically
 * in step with the SPA's `accountFor()` (web/src/pages/SpendDashboard.tsx)
 * so the trend chart agrees with the by-account bar chart and tables.
 */
const accountForDisplay = (principal: string): string =>
  accountFromPrincipal(principal) ?? '(unknown)';

interface SpendRow {
  principal: string;
  sk: string;
  spendUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  period?: string;
  target?: string;
  enforcementPolicyArn?: string;
  /**
   * BBG-RATELIMITS — what triggered the active enforcement. Stamped
   * by the enforcement Lambda alongside `enforcementPolicyArn`.
   * Absent on legacy rows (treat as 'usd' on the SPA).
   */
  enforcementReason?: 'usd' | 'rpm' | 'tpm';
  /** BBG-RATELIMITS — value/limit/window snapshot at deny time. */
  enforcementMetric?: { value: number; limit: number; windowSeconds?: number };
  /** set on identity-lens rows (per-identity view of a role's spend). */
  identityLens?: 'sso-user' | 'source-identity';
  issuerPrincipal?: string;
  // Flat per-dimension attributes (multi-dim pricing): `usage_<kind>`
  // and `cost_<kind>`. We re-aggregate into maps for the API response.
  [key: string]: unknown;
}

const collectDims = (
  row: SpendRow,
  prefix: 'usage_' | 'cost_',
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith(prefix) && typeof v === 'number' && v > 0) {
      out[k.slice(prefix.length)] = v;
    }
  }
  return out;
};

/**
 * per-region cost attribution. Meter writes `region_<code>`
 * flat attrs (e.g. `region_us_west_2: 1.20`); we expose them as a
 * `regions` map keyed by the canonical region code (with hyphens).
 */
const collectRegions = (row: SpendRow): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('region_') && typeof v === 'number' && v > 0) {
      // region_us_west_2 -> us-west-2
      const code = k.slice('region_'.length).replace(/_/g, '-');
      out[code] = v;
    }
  }
  return out;
};

const flatten = (items: SpendRow[]) =>
  items.map((it) => ({
    principal: it.principal,
    sk: it.sk,
    period: it.period,
    target: it.target,
    spendUsd: it.spendUsd ?? 0,
    inputTokens: it.inputTokens ?? 0,
    outputTokens: it.outputTokens ?? 0,
    dimCost: collectDims(it, 'cost_'),
    dimUsage: collectDims(it, 'usage_'),
    regions: collectRegions(it),
    enforced: Boolean(it.enforcementPolicyArn),
    // BBG-RATELIMITS — surface the enforcement reason + snapshot so
    // the SPA can render "Enforced (RPM 42 ≥ 20 in 60s)" rather than
    // a generic "Enforced (deny)".
    enforcementReason: it.enforcementReason,
    enforcementMetric: it.enforcementMetric,
    // identity-lens rows (principal#sso-user# / #sourceIdentity#):
    // the per-identity view of a role's spend. The SPA EXCLUDES these from
    // aggregates (they duplicate the primary role row's dollars) and shows
    // them in the per-row table with a badge.
    identityLens: it.identityLens,
    issuerPrincipal: it.issuerPrincipal,
  }));

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const route = event.routeKey;
  const period = event.queryStringParameters?.period ?? periodFor();

  if (route === 'GET /admin/spend') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    const r = await ddb.send(
      new QueryCommand({
        TableName: RUNNING_SPEND_TABLE,
        IndexName: 'byPeriod',
        KeyConditionExpression: 'period = :p',
        ExpressionAttributeValues: { ':p': period },
      }),
    );
    let rows = (r.Items ?? []) as SpendRow[];
    if (!scope.isWildcard) {
      // filter to accounts the caller can administer.
      rows = rows.filter((it) => scopeAllows(scope, accountFromPrincipal(String(it.principal))));
    }
    return json(200, { period, items: flatten(rows) });
  }

  // Distinct monthly periods that actually have data, newest-first. Powers
  // the SPA period selector's auto-extend: instead of a hardcoded "last N
  // months", the dashboard reads the earliest recorded period and offers
  // every month from then through now. RunningSpend is bounded (principals ×
  // targets × periods) so a projected Scan is cheap; we only keep bare
  // `YYYY-MM` (monthly) keys — the selector is monthly, and prefixed
  // (weekly:/daily:/5h:) keys would never match a monthly query anyway.
  if (route === 'GET /admin/spend/periods') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    const periods = new Set<string>();
    let cursor: Record<string, unknown> | undefined;
    do {
      const r = await ddb.send(
        new ScanCommand({
          TableName: RUNNING_SPEND_TABLE,
          ProjectionExpression: 'principal, #p',
          ExpressionAttributeNames: { '#p': 'period' },
          ExclusiveStartKey: cursor,
        }),
      );
      for (const it of (r.Items ?? []) as SpendRow[]) {
        const p = it.period;
        if (!p || !/^\d{4}-\d{2}$/.test(p)) continue;
        if (!scope.isWildcard && !scopeAllows(scope, accountFromPrincipal(String(it.principal)))) {
          continue;
        }
        periods.add(p);
      }
      cursor = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return json(200, { periods: [...periods].sort((a, b) => b.localeCompare(a)) });
  }

  if (route === 'GET /me/spend/periods') {
    const me = callerPrincipalKey(event);
    if (!me) return json(200, { periods: [], unmapped: true });
    const periods = new Set<string>();
    let cursor: Record<string, unknown> | undefined;
    do {
      const r = await ddb.send(
        new ScanCommand({
          TableName: RUNNING_SPEND_TABLE,
          ProjectionExpression: '#p',
          FilterExpression: 'principal = :me',
          ExpressionAttributeNames: { '#p': 'period' },
          ExpressionAttributeValues: { ':me': me },
          ExclusiveStartKey: cursor,
        }),
      );
      for (const it of (r.Items ?? []) as SpendRow[]) {
        const p = it.period;
        if (p && /^\d{4}-\d{2}$/.test(p)) periods.add(p);
      }
      cursor = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return json(200, { periods: [...periods].sort((a, b) => b.localeCompare(a)) });
  }

  if (route === 'GET /admin/spend/trend') {
    if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
    const scope = callerScope(event);
    const months = Math.min(
      Math.max(parseInt(event.queryStringParameters?.months ?? '6', 10) || 6, 1),
      24,
    );
    const periods: string[] = [];
    const now = new Date();
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      periods.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    // Query each period in parallel. We sum only model-target rows so we
    // don't double-count profile-target rows (same money, different lens).
    const results = await Promise.all(
      periods.map(async (p) => {
        const r = await ddb.send(
          new QueryCommand({
            TableName: RUNNING_SPEND_TABLE,
            IndexName: 'byPeriod',
            KeyConditionExpression: 'period = :p',
            ExpressionAttributeValues: { ':p': p },
          }),
        );
        let total = 0;
        // Per-account split so the SPA can render one trend line per
        // account (multi-account installs). Additive to the response —
        // older clients ignore `byAccount` and keep using `totalUsd`.
        const byAccount: Record<string, number> = {};
        for (const item of (r.Items ?? []) as SpendRow[]) {
          // skip identity-lens rows — they duplicate the primary
          // role row's dollars (per-identity view), so counting them here
          // would double the trend total + byAccount split.
          if (item.identityLens) continue;
          // Authorization: strict accountFromPrincipal fails CLOSED for
          // non-ARN principals (undefined never matches a scope entry),
          // so scoped admins only ever see rows attributable to their
          // accounts; wildcard admins see everything.
          if (!scope.isWildcard && !scopeAllows(scope, accountFromPrincipal(String(item.principal)))) {
            continue;
          }
          const target = item.target ?? '';
          if (target.startsWith('model#') && typeof item.spendUsd === 'number') {
            total += item.spendUsd;
            // Display attribution is DISTINCT from authorization: bucket by
            // the true ARN account (iam OR sts), and '(unknown)' for
            // non-ARN principals — matching the client's accountFor() so the
            // trend agrees with the by-account bar chart + tables. A non-ARN
            // principal must NOT be silently folded into the home account's
            // trend line (that was the bug the byAccount split first shipped).
            const acct = accountForDisplay(String(item.principal));
            byAccount[acct] = (byAccount[acct] ?? 0) + item.spendUsd;
          }
        }
        // Round each account's contribution to match totalUsd's precision.
        for (const k of Object.keys(byAccount)) byAccount[k] = Number(byAccount[k].toFixed(6));
        return { period: p, totalUsd: Number(total.toFixed(6)), byAccount };
      }),
    );
    // Sort ascending by period so the chart renders left → right oldest → newest.
    results.sort((a, b) => a.period.localeCompare(b.period));
    return json(200, { months, items: results });
  }

  if (route === 'GET /me/spend') {
    const me = callerPrincipalKey(event);
    if (!me) return json(200, { period, items: [], unmapped: true });
    const r = await ddb.send(
      new ScanCommand({
        TableName: RUNNING_SPEND_TABLE,
        FilterExpression: 'principal = :me AND period = :p',
        ExpressionAttributeValues: { ':me': me, ':p': period },
      }),
    );
    return json(200, { period, items: flatten((r.Items ?? []) as SpendRow[]) });
  }

  if (route === 'GET /me/spend/trend') {
    const me = callerPrincipalKey(event);
    if (!me) return json(200, { months: 0, items: [], unmapped: true });
    const months = Math.min(
      Math.max(parseInt(event.queryStringParameters?.months ?? '3', 10) || 3, 1),
      12,
    );
    const periods: string[] = [];
    const now = new Date();
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      periods.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    // Per-period scan filtered to the caller's principal. Same model-only
    // sum as /admin/spend/trend so this view doesn't double-count profile
    // rows.
    const results = await Promise.all(
      periods.map(async (p) => {
        const r = await ddb.send(
          new ScanCommand({
            TableName: RUNNING_SPEND_TABLE,
            FilterExpression: 'principal = :me AND period = :p',
            ExpressionAttributeValues: { ':me': me, ':p': p },
          }),
        );
        let total = 0;
        for (const item of (r.Items ?? []) as SpendRow[]) {
          const target = item.target ?? '';
          if (target.startsWith('model#') && typeof item.spendUsd === 'number') {
            total += item.spendUsd;
          }
        }
        return { period: p, totalUsd: Number(total.toFixed(6)) };
      }),
    );
    results.sort((a, b) => a.period.localeCompare(b.period));
    return json(200, { months, items: results });
  }

  return json(404, { error: `Unknown route: ${route}` });
};
