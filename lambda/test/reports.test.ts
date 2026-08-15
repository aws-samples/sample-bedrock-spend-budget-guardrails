import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

beforeAll(() => {
  process.env.ATHENA_WORKGROUP = 'test-wg';
  process.env.LEDGER_DATABASE = 'test_db';
  process.env.LEDGER_TABLE = 'invocations';
});

// Capture the SQL the handler hands to Athena without hitting the service.
const athenaSendMock = vi.fn();
vi.mock('@aws-sdk/client-athena', () => ({
  AthenaClient: class {
    send(cmd: unknown) {
      return athenaSendMock(cmd);
    }
  },
  // The handler constructs these commands; we only need the input echoed back.
  StartQueryExecutionCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetQueryExecutionCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetQueryResultsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const { handler } = await import('../src/api/reports/index.js');

const queryEvent = (body: unknown): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey: 'POST /admin/reports/query',
    requestContext: { authorizer: { jwt: { claims: { 'cognito:groups': ['BBG-Admin-Wildcard'] } } } },
    body: JSON.stringify(body),
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const nonAdminEvent = (): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey: 'POST /admin/reports/query',
    requestContext: { authorizer: { jwt: { claims: { 'cognito:groups': ['Users'] } } } },
    body: JSON.stringify({ template: 'topSpenders' }),
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const runTemplate = async (template: string, params?: Record<string, string>) => {
  athenaSendMock.mockResolvedValueOnce({ QueryExecutionId: 'qid-1' });
  const r = (await handler(queryEvent({ template, params }))) as { statusCode: number; body: string };
  return { statusCode: r.statusCode, body: JSON.parse(r.body) as { sql?: string; error?: string; available?: string[] } };
};

describe('POST /admin/reports/query', () => {
  afterEach(() => {
    athenaSendMock.mockReset();
  });

  it('forbids non-admins', async () => {
    const r = (await handler(nonAdminEvent())) as { statusCode: number };
    expect(r.statusCode).toBe(403);
  });

  it('rejects an unknown template with 400 and lists the available ones', async () => {
    const r = (await handler(queryEvent({ template: 'dropTables' }))) as {
      statusCode: number;
      body: string;
    };
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).available).toContain('topSpenders');
  });

  it('rejects an unknown timeframe with 400 and lists the valid ones', async () => {
    const r = (await handler(
      queryEvent({ template: 'topSpenders', params: { timeframe: 'lastMillennium' } }),
    )) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body) as { error: string; available: string[] };
    expect(body.error).toBe('Unknown timeframe');
    expect(body.available).toEqual(
      expect.arrayContaining(['today', 'thisMonth', 'lastMonth', 'last7d', 'last30d', 'last90d']),
    );
    // Nothing should have been sent to Athena for an invalid timeframe.
    expect(athenaSendMock).not.toHaveBeenCalled();
  });

  it('defaults to thisMonth (year + month partition prune) when no timeframe is given', async () => {
    const now = new Date();
    const y = String(now.getUTCFullYear());
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const { statusCode, body } = await runTemplate('topSpenders');
    expect(statusCode).toBe(200);
    expect(body.sql).toContain(`year = '${y}' AND month = '${m}'`);
  });

  it('fixes the topSpenders double-count by filtering to model# rows only', async () => {
    const { body } = await runTemplate('topSpenders', { timeframe: 'thisMonth' });
    expect(body.sql).toContain("WHERE target LIKE 'model#%'");
  });

  it('fixes perPrincipalPerModel double-count: model# rows only, model regex', async () => {
    const { body } = await runTemplate('perPrincipalPerModel', { timeframe: 'thisMonth' });
    expect(body.sql).toContain("WHERE target LIKE 'model#%'");
    expect(body.sql).toContain("regexp_extract(target, '^model#(.+)$', 1)");
    // Must NOT still match profile rows.
    expect(body.sql).not.toContain('(?:model|profile)');
  });

  it('today timeframe prunes on year + month + day partitions', async () => {
    const now = new Date();
    const y = String(now.getUTCFullYear());
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const { body } = await runTemplate('spendByModel', { timeframe: 'today' });
    expect(body.sql).toContain(`year = '${y}' AND month = '${m}' AND day = '${d}'`);
  });

  it('rolling-day timeframes filter on recordedat against a now() interval', async () => {
    const { body } = await runTemplate('topSpenders', { timeframe: 'last7d' });
    expect(body.sql).toContain("from_iso8601_timestamp(recordedat) >= date_add('day', -7, now())");
  });

  it('lastMonth rolls back one calendar month in UTC', async () => {
    const now = new Date();
    const lm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const ly = String(lm.getUTCFullYear());
    const lmm = String(lm.getUTCMonth() + 1).padStart(2, '0');
    const { body } = await runTemplate('spendByModel', { timeframe: 'lastMonth' });
    expect(body.sql).toContain(`year = '${ly}' AND month = '${lmm}'`);
  });

  it('builds the dailyTrend preset grouped by day', async () => {
    const { statusCode, body } = await runTemplate('dailyTrend', { timeframe: 'last30d' });
    expect(statusCode).toBe(200);
    expect(body.sql).toContain("date_trunc('day', from_iso8601_timestamp(recordedat)) AS day");
    expect(body.sql).toContain("from_iso8601_timestamp(recordedat) >= date_add('day', -30, now())");
  });

  it('hourlyToday ignores the timeframe param entirely', async () => {
    const now = new Date();
    const d = String(now.getUTCDate()).padStart(2, '0');
    const { body } = await runTemplate('hourlyToday', { timeframe: 'last90d' });
    // Still today-only; no rolling-window predicate leaked in.
    expect(body.sql).toContain(`day = '${d}'`);
    expect(body.sql).not.toContain('date_add');
  });

  it('hourlyToday filters to model# rows so it matches its sibling aggregates', async () => {
    const { body } = await runTemplate('hourlyToday');
    // Profile invocations write BOTH a model# and a profile# row; without this
    // filter the hourly bars double-count profile users' spend.
    expect(body.sql).toContain("WHERE target LIKE 'model#%'");
  });

  it('every template filters to model# rows (no aggregate double-counts profiles)', async () => {
    // Enumerate from the handler itself (the 400 body lists Object.keys(TEMPLATES))
    // so a newly-added template can't silently skip the filter.
    const { body: probe } = await runTemplate('__nope__');
    const templates = probe.available!;
    expect(templates.length).toBeGreaterThanOrEqual(8);
    for (const t of templates) {
      const { body } = await runTemplate(t);
      expect(body.sql, `${t} must restrict to model# rows`).toContain("target LIKE 'model#%'");
    }
  });
});

/**
 * The ledger database/table are Athena identifiers interpolated into the query
 * templates, so they're validated against a strict allowlist. Validation is
 * LAZY (at query-build time, not module load) — a module-load throw would break
 * this very suite, which sets env in `beforeAll` after the top-level import.
 */
describe('ledger identifier guard', () => {
  const withEnv = async (
    env: { database?: string; table?: string },
    fn: () => Promise<void>,
  ) => {
    const prevDb = process.env.LEDGER_DATABASE;
    const prevTable = process.env.LEDGER_TABLE;
    if ('database' in env) {
      if (env.database === undefined) delete process.env.LEDGER_DATABASE;
      else process.env.LEDGER_DATABASE = env.database;
    }
    if ('table' in env) {
      if (env.table === undefined) delete process.env.LEDGER_TABLE;
      else process.env.LEDGER_TABLE = env.table;
    }
    try {
      await fn();
    } finally {
      process.env.LEDGER_DATABASE = prevDb;
      process.env.LEDGER_TABLE = prevTable;
    }
  };

  afterEach(() => {
    athenaSendMock.mockReset();
  });

  it('quotes the validated database + table into the FROM clause', async () => {
    const { statusCode, body } = await runTemplate('topSpenders');
    expect(statusCode).toBe(200);
    expect(body.sql).toContain('FROM "test_db"."invocations"');
  });

  it('rejects a SQL-injecting table identifier rather than interpolating it', async () => {
    await withEnv({ table: 'invocations" UNION SELECT * FROM "secrets' }, async () => {
      await expect(
        handler(queryEvent({ template: 'topSpenders' })),
      ).rejects.toThrow(/Invalid LEDGER_TABLE/);
      // Nothing reached Athena.
      expect(athenaSendMock).not.toHaveBeenCalled();
    });
  });

  it('rejects a SQL-injecting database identifier', async () => {
    await withEnv({ database: 'db"."other' }, async () => {
      await expect(
        handler(queryEvent({ template: 'topSpenders' })),
      ).rejects.toThrow(/Invalid LEDGER_DATABASE/);
    });
  });

  it('rejects an UNSET database instead of emitting the string "undefined"', async () => {
    // A regex-only guard would happily pass `String(undefined)`; the explicit
    // undefined check is what makes this a hard failure.
    await withEnv({ database: undefined }, async () => {
      await expect(
        handler(queryEvent({ template: 'topSpenders' })),
      ).rejects.toThrow(/Missing LEDGER_DATABASE/);
      expect(athenaSendMock).not.toHaveBeenCalled();
    });
  });

  it('falls back to the default table name when LEDGER_TABLE is unset', async () => {
    await withEnv({ table: undefined }, async () => {
      const { statusCode, body } = await runTemplate('topSpenders');
      expect(statusCode).toBe(200);
      expect(body.sql).toContain('FROM "test_db"."invocations"');
    });
  });
});

describe('POST /admin/reports/query (template shapes)', () => {
  afterEach(() => {
    athenaSendMock.mockReset();
  });

  it('spendByRegion groups by the region column, excludes blanks + profile rows', async () => {
    const { statusCode, body } = await runTemplate('spendByRegion', { timeframe: 'thisMonth' });
    expect(statusCode).toBe(200);
    expect(body.sql).toContain('GROUP BY region');
    expect(body.sql).toContain("region <> ''");
    expect(body.sql).toContain("target LIKE 'model#%'");
  });

  it('spendByAccount groups by account with a principal-ARN fallback for historical rows', async () => {
    const { statusCode, body } = await runTemplate('spendByAccount', { timeframe: 'thisMonth' });
    expect(statusCode).toBe(200);
    // Historical rows predate the `account` column: COALESCE re-derives the
    // display attribution from the principal ARN (iam OR sts), and falls
    // back to '(unknown)' — never the home account.
    expect(body.sql).toContain(
      "COALESCE(account, regexp_extract(principal, 'arn:aws:(?:iam|sts)::(\\d+):', 1), '(unknown)') AS account",
    );
    expect(body.sql).toContain("target LIKE 'model#%'");
    expect(body.sql).toContain('GROUP BY 1');
  });

  it('enforcement filters to enforced rows and reports the trigger reason', async () => {
    const { statusCode, body } = await runTemplate('enforcement', { timeframe: 'last30d' });
    expect(statusCode).toBe(200);
    expect(body.sql).toContain('enforced = true');
    expect(body.sql).toContain("COALESCE(enforcementreason, 'usd')");
    expect(body.sql).toContain("from_iso8601_timestamp(recordedat) >= date_add('day', -30, now())");
  });
});
