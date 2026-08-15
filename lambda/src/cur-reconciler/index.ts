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
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { canonicalizeCurPrincipal } from '../shared/arn.js';
import { ddb, periodFor } from '../shared/ddb.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';

const RUNNING_SPEND_TABLE = process.env.RUNNING_SPEND_TABLE!;
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP!;

// CUR database/table are Athena *identifiers*, which cannot be bound as query
// parameters — so validate them against a strict allowlist before they ever
// reach the query string. Glue/Athena identifiers are [A-Za-z0-9_]. This keeps
// the SQL injection-safe even though these come from operator-controlled env,
// and makes the pattern safe for anyone copying this reconciler.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;
const requireIdentifier = (name: string, value: string): string => {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${name} (must match ${SAFE_IDENTIFIER}): ${value}`);
  }
  return value;
};
const CUR_DATABASE = requireIdentifier('CUR_DATABASE', process.env.CUR_DATABASE ?? 'cur2_database');
const CUR_TABLE = requireIdentifier('CUR_TABLE', process.env.CUR_TABLE ?? 'cur2_export');
// Billing period — bound as a query parameter (see startQuery); also validated
// to YYYY-MM as defense-in-depth.
const SAFE_PERIOD = /^\d{4}-\d{2}$/;

const athena = new AthenaClient({});
const cw = new CloudWatchClient({});

/**
 * Canonicalize CUR's `line_item_iam_principal` in-SQL so per-session rows for
 * the same role aggregate before crossing the wire. CUR carries the
 * `arn:aws:sts::ACCT:assumed-role/<Role>/<Session>` form; BBG's RunningSpend
 * uses `arn:aws:iam::ACCT:role/<Role>`. Without this we get N false-positive
 * deltas per role (one per session, plus the canonical-form row).
 *
 * Mirrors `canonicalizeCurPrincipal` in shared/arn.ts so the test fixture
 * coverage there is the source of truth for the regex.
 */
const CANONICAL_PRINCIPAL_SQL =
  "regexp_replace(line_item_iam_principal, '^arn:aws:sts::(\\d+):assumed-role/([^/]+)/.+$', 'arn:aws:iam::$1:role/$2')";

const startQuery = async (period: string): Promise<string> => {
  // SQL-injection defense — no untrusted value is interpolated into the query:
  //   * `period` is bound as an Athena query PARAMETER (positional `?` via
  //     ExecutionParameters), never concatenated into the SQL string. The
  //     `CAST(? AS TIMESTAMP)` form is used because Trino/Athena won't accept a
  //     `?` directly after the TIMESTAMP type keyword. It is also validated to
  //     YYYY-MM as defense-in-depth.
  //   * CUR_DATABASE / CUR_TABLE are SQL *identifiers*, which the Athena
  //     parameter API cannot bind (parameters are values, not identifiers), so
  //     they are interpolated — but only after strict [A-Za-z0-9_] allowlist
  //     validation at module load (see requireIdentifier). They come from
  //     operator-controlled deploy config, never from request input.
  // If you copy this pattern: bind request values as parameters; for the
  // unbindable identifier positions, keep the allowlist — never interpolate an
  // unvalidated value into an Athena query.
  if (!SAFE_PERIOD.test(period)) {
    throw new Error(`Invalid period (must match YYYY-MM): ${period}`);
  }
  const r = await athena.send(
    new StartQueryExecutionCommand({
      QueryString:
        `SELECT ${CANONICAL_PRINCIPAL_SQL} AS principal, sum(line_item_unblended_cost) AS cur_spend
         FROM ${CUR_DATABASE}.${CUR_TABLE}
         WHERE bill_billing_period_start_date >= CAST(? AS TIMESTAMP)
           AND product_servicecode IN ('AmazonBedrock', 'AmazonBedrockFoundationModels', 'AmazonBedrockService')
           AND line_item_iam_principal IS NOT NULL
         GROUP BY ${CANONICAL_PRINCIPAL_SQL}`,
      ExecutionParameters: [`'${period}-01 00:00:00'`],
      WorkGroup: ATHENA_WORKGROUP,
    }),
  );
  if (!r.QueryExecutionId) throw new Error('Athena did not return a query execution id');
  return r.QueryExecutionId;
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

const fetchResults = async (id: string): Promise<Map<string, number>> => {
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
      // Belt-and-suspenders: the SQL GROUP BY already canonicalizes assumed-role
      // forms, but the in-process canonicalizer covers any edge case the regex
      // missed (e.g., future ARN shapes) and aggregates per-canonical-key here.
      const canonical = `principal#${canonicalizeCurPrincipal(principal)}`;
      result.set(canonical, (result.get(canonical) ?? 0) + spend);
    }
    nextToken = r.NextToken;
    firstPage = false;
  } while (nextToken);
  return result;
};

const meterTotalsFor = async (period: string): Promise<Map<string, number>> => {
  const totals = new Map<string, number>();
  // Paginate the Scan — a single Scan page caps at 1MB, so an org with >999
  // metered principals leaves the tail on later pages. Without following
  // LastEvaluatedKey the MET-1 backstop silently misses those principals and
  // reports phantom deltas (CUR spend with no meter counterpart).
  let cursor: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: RUNNING_SPEND_TABLE,
        FilterExpression: 'period = :p',
        ExpressionAttributeValues: { ':p': period },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of r.Items ?? []) {
      // skip identity-lens rows — they duplicate the primary role
      // row's dollars, which would inflate the BBG-side total the
      // reconciler compares against CUR and produce false ReconciliationDelta.
      if (item.identityLens) continue;
      const p = item.principal as string;
      totals.set(p, (totals.get(p) ?? 0) + (item.spendUsd as number ?? 0));
    }
    cursor = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return totals;
};

export const handler = async (event: { period?: string } = {}): Promise<{ deltas: number }> => {
  const period = event.period ?? periodFor();
  logger.info('cur-reconciler starting', { period });

  let curTotals: Map<string, number>;
  try {
    const id = await startQuery(period);
    await waitFor(id);
    curTotals = await fetchResults(id);
  } catch (err) {
    logger.warn('CUR query failed; reconciliation skipped', { err: (err as Error).message });
    return { deltas: 0 };
  }

  const meterTotals = await meterTotalsFor(period);
  const allPrincipals = new Set([...curTotals.keys(), ...meterTotals.keys()]);

  const deltas: { principal: string; meter: number; cur: number; delta: number }[] = [];
  for (const principal of allPrincipals) {
    const meter = meterTotals.get(principal) ?? 0;
    const cur = curTotals.get(principal) ?? 0;
    const delta = Math.abs(meter - cur);
    deltas.push({ principal, meter, cur, delta });
    metrics.addMetric('ReconciliationDelta', MetricUnit.NoUnit, delta);
  }

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
  return { deltas: deltas.length };
};
