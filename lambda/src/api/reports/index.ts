import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { callerScope, json, parseBody, requireAdmin } from '../../shared/api.js';

const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP!;

// The ledger database/table are Athena *identifiers*, which cannot be bound as
// query parameters — so validate them against a strict allowlist before they
// ever reach a query string. Glue/Athena identifiers are [A-Za-z0-9_]. These
// values come from operator-controlled env (set by data-stack.ts), so there's no
// injection vector today; the guard keeps it that way if anyone copying this
// sample ever makes them dynamic. Mirrors cur-reconciler/index.ts.
//
// Validated LAZILY (first query build, not module load) for two reasons: a
// regex-only check would pass `undefined` through as the string "undefined",
// and throwing at import time would break any consumer that sets env after
// importing this module (e.g. test/reports.test.ts's `beforeAll`).
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;
const requireIdentifier = (name: string, value: string | undefined): string => {
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name} (required Athena identifier)`);
  }
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${name} (must match ${SAFE_IDENTIFIER}): ${value}`);
  }
  return value;
};

/** Fully-qualified, validated `"db"."table"` for the ledger. */
const ledgerTableRef = (): string => {
  const db = requireIdentifier('LEDGER_DATABASE', process.env.LEDGER_DATABASE);
  const table = requireIdentifier('LEDGER_TABLE', process.env.LEDGER_TABLE ?? 'invocations');
  return `"${db}"."${table}"`;
};

const athena = new AthenaClient({});

/**
 * Supported timeframes. The handler validates the caller-supplied
 * `timeframe` param against these keys (rejecting anything else with a
 * 400) and then builds the WHERE clause from the matching closure — never
 * from the raw string — so the allow-listed templates stay safe.
 */
const TIMEFRAMES = [
  'today',
  'thisMonth',
  'lastMonth',
  'last7d',
  'last30d',
  'last90d',
] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const DEFAULT_TIMEFRAME: Timeframe = 'thisMonth';

const isTimeframe = (v: string | undefined): v is Timeframe =>
  v !== undefined && (TIMEFRAMES as readonly string[]).includes(v);

/**
 * Build a SQL predicate (no leading AND) that constrains the ledger to the
 * requested timeframe. Month-grain windows prune cheaply on the
 * year/month/day partition columns (zero-padded strings, matching the
 * ledger-writer's partition format). Rolling-day windows can't align to
 * partition boundaries, so they filter on `from_iso8601_timestamp(recordedat)`
 * against a server-side `now()` interval. Every value interpolated here is
 * computed from `Date`/Athena functions, never from user input.
 */
const timeframeClause = (tf: Timeframe): string => {
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  switch (tf) {
    case 'today':
      return `year = '${y}' AND month = '${m}' AND day = '${d}'`;
    case 'thisMonth':
      return `year = '${y}' AND month = '${m}'`;
    case 'lastMonth': {
      // Roll back one calendar month in UTC.
      const lm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const ly = String(lm.getUTCFullYear());
      const lmm = String(lm.getUTCMonth() + 1).padStart(2, '0');
      return `year = '${ly}' AND month = '${lmm}'`;
    }
    case 'last7d':
      return `from_iso8601_timestamp(recordedat) >= date_add('day', -7, now())`;
    case 'last30d':
      return `from_iso8601_timestamp(recordedat) >= date_add('day', -30, now())`;
    case 'last90d':
      return `from_iso8601_timestamp(recordedat) >= date_add('day', -90, now())`;
  }
};

/**
 * Allow-listed query templates. The handler interpolates safe parameters
 * (already validated against an enum or numeric bound) into them so the
 * UI can drive Athena without our handler ever building raw SQL from user
 * input. Templates that accept a timeframe receive a pre-validated
 * `Timeframe` and call `timeframeClause` for the WHERE predicate.
 *
 * `region`, `enforced`, and `enforcementreason` are normalized columns the
 * ledger-writer now emits (and data-stack.ts declares on the Glue table),
 * so spendByRegion + enforcement reports query them directly. Rows written
 * before that schema landed have NULL/empty region and enforced=false.
 */
const TEMPLATES: Record<string, (tf: Timeframe) => string> = {
  // BBG: principal-level aggregate. Filter to `model#` rows only — every
  // inference-profile invocation writes BOTH a `model#` and a `profile#`
  // row, so summing across all targets double-counts profile users. This
  // matches how the dashboard avoids the double-count.
  topSpenders: (tf) => `
    SELECT principal, SUM(spendusd) AS spendusd, SUM(inputtokens) AS inputtokens, SUM(outputtokens) AS outputtokens
    FROM ${ledgerTableRef()}
    WHERE target LIKE 'model#%'
      AND ${timeframeClause(tf)}
    GROUP BY principal
    ORDER BY spendusd DESC
    LIMIT 25
  `,
  spendByModel: (tf) => `
    SELECT
      regexp_extract(target, 'model#(.+)', 1) AS model,
      SUM(spendusd) AS spendusd,
      SUM(inputtokens) AS inputtokens,
      SUM(outputtokens) AS outputtokens
    FROM ${ledgerTableRef()}
    WHERE target LIKE 'model#%'
      AND ${timeframeClause(tf)}
    GROUP BY 1
    ORDER BY spendusd DESC
    LIMIT 50
  `,
  // Today's spend bucketed by hour. Model rows only — same profile
  // double-count caveat as every other aggregate here (an inference-profile
  // invocation writes BOTH a `model#` and a `profile#` row), which this
  // template was previously missing, so its hourly bars over-reported spend
  // for profile users relative to dailyTrend/topSpenders.
  hourlyToday: () => {
    const now = new Date();
    const y = String(now.getUTCFullYear());
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `
      SELECT
        date_trunc('hour', from_iso8601_timestamp(recordedat)) AS hour,
        SUM(spendusd) AS spendusd
      FROM ${ledgerTableRef()}
      WHERE target LIKE 'model#%'
        AND year = '${y}' AND month = '${m}' AND day = '${d}'
      GROUP BY 1
      ORDER BY 1
    `;
  },
  // Principal × model aggregate — same double-count caveat as topSpenders,
  // so restrict to `model#` rows. (Profile rows are already collapsed into
  // their underlying model by the meter's dual write.)
  perPrincipalPerModel: (tf) => `
    SELECT
      principal,
      regexp_extract(target, '^model#(.+)$', 1) AS target,
      SUM(spendusd) AS spendusd
    FROM ${ledgerTableRef()}
    WHERE target LIKE 'model#%'
      AND ${timeframeClause(tf)}
    GROUP BY 1, 2
    ORDER BY spendusd DESC
    LIMIT 100
  `,
  // Total spend per UTC day across the selected timeframe (model rows only,
  // to avoid the profile double-count). `day` here is the calendar date
  // derived from recordedat so rolling windows render a clean trend line.
  dailyTrend: (tf) => `
    SELECT
      date_trunc('day', from_iso8601_timestamp(recordedat)) AS day,
      SUM(spendusd) AS spendusd
    FROM ${ledgerTableRef()}
    WHERE target LIKE 'model#%'
      AND ${timeframeClause(tf)}
    GROUP BY 1
    ORDER BY 1
  `,
  // Spend by source region (`region` column emitted by ledger-writer).
  // Model rows only (avoid the profile double-count). Excludes rows with no
  // region attribution (legacy, pre-schema) so the chart isn't skewed by a
  // blank bucket.
  spendByRegion: (tf) => `
    SELECT region, SUM(spendusd) AS spendusd
    FROM ${ledgerTableRef()}
    WHERE target LIKE 'model#%'
      AND region <> ''
      AND ${timeframeClause(tf)}
    GROUP BY region
    ORDER BY spendusd DESC
  `,
  // Spend by account (`account` column emitted by ledger-writer, mirroring
  // the spend API's accountForDisplay: ARN account id for iam/sts
  // principals, '(unknown)' otherwise — never the home account). Model rows
  // only (avoid the profile double-count). Historical rows that predate the
  // column have NULL account, so COALESCE re-derives the same attribution
  // from the principal ARN at query time; the '(unknown)' fallback covers
  // non-ARN principals in both eras. Entirely static SQL — no user input.
  spendByAccount: (tf) => `
    SELECT
      COALESCE(account, regexp_extract(principal, 'arn:aws:(?:iam|sts)::(\\d+):', 1), '(unknown)') AS account,
      SUM(spendusd) AS spendusd,
      SUM(inputtokens) AS inputtokens,
      SUM(outputtokens) AS outputtokens
    FROM ${ledgerTableRef()}
    WHERE target LIKE 'model#%'
      AND ${timeframeClause(tf)}
    GROUP BY 1
    ORDER BY spendusd DESC
  `,
  // Enforcement activity: principals that had a deny policy attached at
  // write time, with the trigger reason and the spend recorded under
  // enforcement. Model rows only. `enforcementreason` is 'usd'|'rpm'|'tpm'.
  enforcement: (tf) => `
    SELECT
      principal,
      COALESCE(enforcementreason, 'usd') AS reason,
      SUM(spendusd) AS spendusd,
      MAX(recordedat) AS lastenforced
    FROM ${ledgerTableRef()}
    WHERE target LIKE 'model#%'
      AND enforced = true
      AND ${timeframeClause(tf)}
    GROUP BY principal, COALESCE(enforcementreason, 'usd')
    ORDER BY spendusd DESC
    LIMIT 100
  `,
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const scope = callerScope(event);
  // Athena queries against the ledger don't yet partition by
  // account; return wildcard-only for now. Per-account ledger partition
  // is a Phase 3 follow-up (see docs/multi-account-multi-region.md).
  if (!scope.isWildcard) {
    return json(403, { error: 'Forbidden: cross-account reports are super-admin only' });
  }

  const route = event.routeKey;

  if (route === 'POST /admin/reports/query') {
    const body = parseBody<{ template?: string; params?: Record<string, string> }>(event);
    const template = body?.template;
    // Hasattr-style allowlist check rather than bracket access on a generic
    // Record so static analyzers (and reviewers) can see that `template`
    // only ever resolves to a known key. Equivalent to TEMPLATES[template]
    // but lints cleanly under semgrep's unsafe-dynamic-method rule.
    if (!template || !Object.prototype.hasOwnProperty.call(TEMPLATES, template)) {
      return json(400, { error: 'Unknown template', available: Object.keys(TEMPLATES) });
    }
    // Timeframe arrives inside the existing `params` bag. Validate it
    // against the closed enum and fall back to the default; never thread a
    // raw string into the SQL. Reject anything non-empty that isn't a
    // known timeframe so a typo surfaces as a 400 rather than silently
    // running the wrong window.
    const rawTimeframe = body?.params?.timeframe;
    if (rawTimeframe !== undefined && !isTimeframe(rawTimeframe)) {
      return json(400, { error: 'Unknown timeframe', available: [...TIMEFRAMES] });
    }
    const timeframe: Timeframe = rawTimeframe ?? DEFAULT_TIMEFRAME;
    // The hasOwnProperty guard above means `template` is always one of the
    // allowlisted keys at this point. The TEMPLATES values are module-static
    // closures, not user-supplied. Safe. (nosemgrep must sit on the finding
    // line itself — a comment gap orphans it — hence the trailing pragma.)
    const builder = TEMPLATES[template as keyof typeof TEMPLATES]; // nosemgrep: unsafe-dynamic-method
    const sql = builder(timeframe);
    const r = await athena.send(
      new StartQueryExecutionCommand({ QueryString: sql, WorkGroup: ATHENA_WORKGROUP }),
    );
    return json(200, { executionId: r.QueryExecutionId, sql });
  }

  if (route === 'GET /admin/reports/{executionId}') {
    const id = event.pathParameters?.executionId;
    if (!id) return json(400, { error: 'executionId required' });

    const exec = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State;
    if (state === 'QUEUED' || state === 'RUNNING') {
      return json(200, { state });
    }
    if (state === 'FAILED' || state === 'CANCELLED') {
      return json(200, {
        state,
        error: exec.QueryExecution?.Status?.StateChangeReason ?? 'Query failed',
      });
    }

    const r = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 1000 }));
    const rows = r.ResultSet?.Rows ?? [];
    if (rows.length === 0) return json(200, { state, columns: [], rows: [] });
    const header = rows[0]?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
    const data = rows.slice(1).map((row) =>
      (row.Data ?? []).reduce<Record<string, string | undefined>>((acc, cell, i) => {
        acc[header[i] ?? `col${i}`] = cell.VarCharValue;
        return acc;
      }, {}),
    );
    return json(200, { state, columns: header, rows: data });
  }

  return json(404, { error: `Unknown route: ${route}` });
};
