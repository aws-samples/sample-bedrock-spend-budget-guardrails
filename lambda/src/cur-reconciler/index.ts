import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { canonicalizeCurPrincipal } from '../shared/arn.js';
import { periodFor } from '../shared/ddb.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';

const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP!;
const STAGE_PREFIX = process.env.STAGE_PREFIX ?? 'unknown';

// CUR/ledger database + table are Athena *identifiers*, which cannot be bound
// as query parameters — so validate them against a strict allowlist before
// they ever reach the query string. Glue/Athena identifiers are [A-Za-z0-9_].
// This keeps the SQL injection-safe even though these come from
// operator-controlled env, and makes the pattern safe for anyone copying this
// reconciler.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;
const requireIdentifier = (name: string, value: string): string => {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${name} (must match ${SAFE_IDENTIFIER}): ${value}`);
  }
  return value;
};
const CUR_DATABASE = requireIdentifier('CUR_DATABASE', process.env.CUR_DATABASE ?? 'cur2_database');
const CUR_TABLE = requireIdentifier('CUR_TABLE', process.env.CUR_TABLE ?? 'cur2_export');
const LEDGER_DATABASE = requireIdentifier(
  'LEDGER_DATABASE',
  process.env.LEDGER_DATABASE ?? 'bbg_ledger',
);
const LEDGER_TABLE = requireIdentifier('LEDGER_TABLE', process.env.LEDGER_TABLE ?? 'invocations');

// Billing period — bound as a query parameter (see startQuery); also validated
// to YYYY-MM as defense-in-depth.
const SAFE_PERIOD = /^\d{4}-\d{2}$/;

/**
 * Reconciliation watermark. CUR line items land 8–24h after the usage they
 * bill (and the export only refreshes a few times a day), while BBG's meter
 * records an invocation within seconds. Comparing a real-time total against a
 * lagging one guarantees a phantom "drift" equal to the last day-or-two of
 * spend for any active principal — which is exactly the false positive that
 * kept the reconciliation alarm red. Both sides of the comparison are
 * therefore windowed to end at `now - RECONCILE_WATERMARK_HOURS` (default
 * 72h): every usage row on either side of the join is bill-complete, so a
 * non-zero delta means a REAL discrepancy (meter bug, bypass path, or pricing
 * drift), not ingestion latency.
 *
 * Why 72 and not 48: Marketplace-billed model SKUs (the entire Anthropic
 * Claude lineup bills via AmazonBedrockFoundationModels) were observed
 * settling in CUR later than 48h after usage — a heavy-usage day still showed
 * a double-digit-percent CUR shortfall at the 48h mark and converged by the
 * next export cycle. 72h keeps the alarm meaningful for the slowest observed
 * billing path at the cost of one more day of detection latency.
 */
const WATERMARK_HOURS = Number(process.env.RECONCILE_WATERMARK_HOURS ?? '72');
const SAFE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const athena = new AthenaClient({});
const cw = new CloudWatchClient({});

/**
 * Canonicalize CUR's `line_item_iam_principal` in-SQL so per-session rows for
 * the same role aggregate before crossing the wire. CUR carries the
 * `arn:aws:sts::ACCT:assumed-role/<Role>/<Session>` form; BBG's ledger uses
 * `arn:aws:iam::ACCT:role/<Role>`. Without this we get N false-positive
 * deltas per role (one per session, plus the canonical-form row).
 *
 * Mirrors `canonicalizeCurPrincipal` in shared/arn.ts so the test fixture
 * coverage there is the source of truth for the regex.
 */
const CANONICAL_PRINCIPAL_SQL =
  "regexp_replace(line_item_iam_principal, '^arn:aws:sts::(\\d+):assumed-role/([^/]+)/.+$', 'arn:aws:iam::$1:role/$2')";

/** `YYYY-MM-DD HH:MM:SS` form for Athena `CAST(? AS TIMESTAMP)` binding. */
const athenaTimestamp = (iso: string): string => iso.slice(0, 19).replace('T', ' ');

const runQuery = async (queryString: string, parameters: string[]): Promise<string> => {
  const r = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: queryString,
      ExecutionParameters: parameters,
      WorkGroup: ATHENA_WORKGROUP,
    }),
  );
  if (!r.QueryExecutionId) throw new Error('Athena did not return a query execution id');
  return r.QueryExecutionId;
};

const startCurQuery = async (period: string, watermarkIso: string): Promise<string> => {
  // SQL-injection defense — no untrusted value is interpolated into the query:
  //   * `period` and the watermark are BOUND as Athena query PARAMETERS
  //     (positional `?` via ExecutionParameters), never concatenated into the
  //     SQL string. The `CAST(? AS TIMESTAMP)` form is used because
  //     Trino/Athena won't accept a `?` directly after the TIMESTAMP type
  //     keyword. Both are also shape-validated as defense-in-depth.
  //   * CUR_DATABASE / CUR_TABLE are SQL *identifiers*, which the Athena
  //     parameter API cannot bind (parameters are values, not identifiers), so
  //     they are interpolated — but only after strict [A-Za-z0-9_] allowlist
  //     validation at module load (see requireIdentifier). They come from
  //     operator-controlled deploy config, never from request input.
  // If you copy this pattern: bind request values as parameters; for the
  // unbindable identifier positions, keep the allowlist — never interpolate an
  // unvalidated value into an Athena query.
  return runQuery(
    `SELECT ${CANONICAL_PRINCIPAL_SQL} AS principal, sum(line_item_unblended_cost) AS cur_spend
         FROM ${CUR_DATABASE}.${CUR_TABLE}
         WHERE bill_billing_period_start_date >= CAST(? AS TIMESTAMP)
           AND line_item_usage_start_date < CAST(? AS TIMESTAMP)
           AND product_servicecode IN ('AmazonBedrock', 'AmazonBedrockFoundationModels', 'AmazonBedrockService')
           AND line_item_iam_principal IS NOT NULL
         GROUP BY ${CANONICAL_PRINCIPAL_SQL}`,
    [`'${period}-01 00:00:00'`, `'${athenaTimestamp(watermarkIso)}'`],
  );
};

/**
 * Meter-side totals come from the S3/Athena LEDGER (per-event spend deltas
 * with a `recordedat` timestamp), NOT from the RunningSpend DynamoDB table.
 * RunningSpend only holds month-running cumulative totals, which cannot be
 * windowed to the watermark — using it is what made the old comparison
 * real-time-vs-lagging. The ledger rows are written by ledger-writer off the
 * RunningSpend stream (identity-lens rows already excluded there, so no
 * double-count) and `recordedat` trails the invocation by seconds, so a
 * lexicographic ISO-8601 comparison against the watermark gives a
 * bill-complete meter total.
 *
 * ONLY `model#` targets are summed. The meter writes the SAME dollars to a
 * `profile#<arn>` row alongside every `model#` row when an inference profile
 * was used (so admins can budget either dimension) — summing all targets
 * double-counts profile-routed spend and inflates the meter side by exactly
 * that amount (observed: +$24 on a month where ~25% of spend went through
 * profiles, misdiagnosed for a day as a pricing gap).
 */
const startLedgerQuery = async (period: string, watermarkIso: string): Promise<string> => {
  return runQuery(
    `SELECT principal, sum(spendusd) AS meter_spend
         FROM ${LEDGER_DATABASE}.${LEDGER_TABLE}
         WHERE period = ?
           AND recordedat < ?
           AND target LIKE 'model#%'
         GROUP BY principal`,
    [`'${period}'`, `'${watermarkIso}'`],
  );
};

const waitFor = async (id: string): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    const r = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = r.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') return;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena query ${state}: ${r.QueryExecution?.Status?.StateChangeReason ?? ''}`);
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('Athena query timed out');
};

const fetchResults = async (
  id: string,
  canonicalizeKeys: boolean,
): Promise<Map<string, number>> => {
  const result = new Map<string, number>();
  // Paginate GetQueryResults — one page holds at most 1000 rows, so at any org
  // with >999 distinct metered principals an unpaginated read silently drops
  // the tail and the reconciler under-reports drift. The header row is only
  // present on the FIRST page; skip it there, keep every row after.
  let nextToken: string | undefined;
  let firstPage = true;
  do {
    const r = await athena.send(
      new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: nextToken }),
    );
    const rows = r.ResultSet?.Rows ?? [];
    for (const row of firstPage ? rows.slice(1) : rows) {
      const principal = row.Data?.[0]?.VarCharValue;
      const spend = Number(row.Data?.[1]?.VarCharValue ?? '0');
      if (!principal) continue;
      // CUR rows need the canonical `principal#<arn>` key shape the ledger
      // already uses. Belt-and-suspenders: the SQL GROUP BY already
      // canonicalizes assumed-role forms, but the in-process canonicalizer
      // covers any edge case the regex missed (e.g., future ARN shapes) and
      // aggregates per-canonical-key here.
      const key = canonicalizeKeys ? `principal#${canonicalizeCurPrincipal(principal)}` : principal;
      result.set(key, (result.get(key) ?? 0) + spend);
    }
    nextToken = r.NextToken;
    firstPage = false;
  } while (nextToken);
  return result;
};

export const handler = async (
  event: { period?: string; watermark?: string } = {},
): Promise<{ deltas: number; unmeteredPrincipals: number }> => {
  const period = event.period ?? periodFor();
  if (!SAFE_PERIOD.test(period)) {
    logger.warn('invalid period; reconciliation skipped', { period });
    return { deltas: 0, unmeteredPrincipals: 0 };
  }
  const watermark =
    event.watermark ?? new Date(Date.now() - WATERMARK_HOURS * 3600 * 1000).toISOString();
  if (!SAFE_ISO.test(watermark)) {
    logger.warn('invalid watermark; reconciliation skipped', { watermark });
    return { deltas: 0, unmeteredPrincipals: 0 };
  }
  logger.info('cur-reconciler starting', { period, watermark, stage: STAGE_PREFIX });

  // Per-stage metric identity. Without this, dev's and prod's reconcilers both
  // publish to the same `service=bbg` series and each stage's alarm fires on
  // the other stage's deltas (observed: a dev install that meters almost
  // nothing compared itself against the whole account's CUR and kept the prod
  // alarm red).
  metrics.addDimension('stage', STAGE_PREFIX);

  let curTotals: Map<string, number>;
  let meterTotals: Map<string, number>;
  try {
    // Both queries run in the same workgroup; start them together and wait.
    const [curId, ledgerId] = await Promise.all([
      startCurQuery(period, watermark),
      startLedgerQuery(period, watermark),
    ]);
    await Promise.all([waitFor(curId), waitFor(ledgerId)]);
    [curTotals, meterTotals] = await Promise.all([
      fetchResults(curId, true),
      fetchResults(ledgerId, false),
    ]);
  } catch (err) {
    logger.warn('CUR/ledger query failed; reconciliation skipped', {
      err: (err as Error).message,
    });
    return { deltas: 0, unmeteredPrincipals: 0 };
  }

  // Split the population:
  //   * Principals the METER knows → true reconciliation. Any delta here means
  //     the meter and the bill disagree about spend it DID see — alarm-worthy.
  //   * CUR-only principals → `ReconciliationUnmeteredSpend`. This is spend
  //     the stage never metered at all: pre-deployment history, another
  //     stage's traffic, or a structural bypass (e.g. `bedrock-mantle`).
  //     Real signal, wrong alarm — it would otherwise dominate
  //     ReconciliationDelta with deltas the operator cannot fix by fixing the
  //     meter (this is also what made a barely-metering dev stage alarm on the
  //     entire account's CUR).
  const deltas: { principal: string; meter: number; cur: number; delta: number }[] = [];
  let unmeteredSpend = 0;
  const unmetered: { principal: string; cur: number }[] = [];
  for (const [principal, cur] of curTotals) {
    if (!meterTotals.has(principal)) {
      unmeteredSpend += cur;
      unmetered.push({ principal, cur });
    }
  }
  for (const [principal, meter] of meterTotals) {
    const cur = curTotals.get(principal) ?? 0;
    const delta = Math.abs(meter - cur);
    deltas.push({ principal, meter, cur, delta });
    metrics.addMetric('ReconciliationDelta', MetricUnit.NoUnit, delta);
  }
  metrics.addMetric('ReconciliationUnmeteredSpend', MetricUnit.NoUnit, unmeteredSpend);

  if (unmetered.length > 0) {
    logger.info('CUR spend with no meter counterpart (unmetered)', {
      period,
      watermark,
      totalUsd: unmeteredSpend,
      principals: unmetered
        .sort((a, b) => b.cur - a.cur)
        .slice(0, 20)
        .map((u) => ({ principal: u.principal, cur: Number(u.cur.toFixed(4)) })),
    });
  }
  logger.info('reconciliation breakdown', {
    period,
    watermark,
    deltas: deltas
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 20)
      .map((d) => ({
        principal: d.principal,
        meter: Number(d.meter.toFixed(4)),
        cur: Number(d.cur.toFixed(4)),
        delta: Number(d.delta.toFixed(4)),
      })),
  });

  await cw.send(
    new PutMetricDataCommand({
      Namespace: 'bbg',
      MetricData: deltas.slice(0, 20).map((d) => ({
        MetricName: 'ReconciliationDeltaUsd',
        Dimensions: [{ Name: 'Principal', Value: d.principal.slice(0, 200) }],
        Value: d.delta,
        Unit: 'None',
      })),
    }),
  ).catch(() => undefined);

  metrics.publishStoredMetrics();
  return { deltas: deltas.length, unmeteredPrincipals: unmetered.length };
};
