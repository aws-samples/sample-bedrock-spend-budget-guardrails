import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Module-scope env must be set BEFORE the handler module is imported (the
// module reads these at load time).
process.env.ATHENA_WORKGROUP = 'test-wg';
process.env.CUR_DATABASE = 'test_cur';
process.env.CUR_TABLE = 'data';
process.env.LEDGER_DATABASE = 'test_ledger';
process.env.LEDGER_TABLE = 'invocations';
process.env.STAGE_PREFIX = 'test';

beforeAll(() => {
  // (kept for parity with other suites; module-scope envs above are the ones
  // that matter for load-time constants)
});

// Capture the Athena query strings the reconciler issues. Two queries run per
// invocation (CUR + ledger); route results by execution id.
interface StartedQuery {
  queryString: string;
  parameters: string[] | undefined;
  id: string;
}
let startedQueries: StartedQuery[] = [];
let curRows: { Data: { VarCharValue?: string }[] }[] = [];
let ledgerRows: { Data: { VarCharValue?: string }[] }[] = [];

const header = (a: string, b: string) => ({
  Data: [{ VarCharValue: a }, { VarCharValue: b }],
});

const startQueryMock = vi.fn(
  async (cmd: { input: { QueryString?: string; ExecutionParameters?: string[] } }) => {
    const q = cmd.input.QueryString ?? '';
    const id = q.includes('line_item_iam_principal') ? 'qid-cur' : 'qid-ledger';
    startedQueries.push({ queryString: q, parameters: cmd.input.ExecutionParameters, id });
    return { QueryExecutionId: id };
  },
);
const getQueryExecutionMock = vi.fn(async () => ({
  QueryExecution: { Status: { State: 'SUCCEEDED' } },
}));
const getQueryResultsMock = vi.fn(async (cmd: { input: { QueryExecutionId?: string } }) => {
  const rows =
    cmd.input.QueryExecutionId === 'qid-cur'
      ? [header('principal', 'cur_spend'), ...curRows]
      : [header('principal', 'meter_spend'), ...ledgerRows];
  return { ResultSet: { Rows: rows } };
});

vi.mock('@aws-sdk/client-athena', () => {
  class FakeCommand {
    constructor(public readonly input: unknown) {}
  }
  return {
    AthenaClient: vi.fn().mockImplementation(function () {
      return {
        send: (cmd: { _kind: string; input: unknown }) => {
          if (cmd._kind === 'StartQueryExecutionCommand') return startQueryMock(cmd as never);
          if (cmd._kind === 'GetQueryExecutionCommand') return getQueryExecutionMock();
          if (cmd._kind === 'GetQueryResultsCommand') return getQueryResultsMock(cmd as never);
          throw new Error(`unexpected command ${cmd._kind}`);
        },
      };
    }),
    StartQueryExecutionCommand: class extends FakeCommand {
      readonly _kind = 'StartQueryExecutionCommand';
    },
    GetQueryExecutionCommand: class extends FakeCommand {
      readonly _kind = 'GetQueryExecutionCommand';
    },
    GetQueryResultsCommand: class extends FakeCommand {
      readonly _kind = 'GetQueryResultsCommand';
    },
  };
});

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class FakeCommand {
    constructor(public readonly input: unknown) {}
  }
  return {
    CloudWatchClient: vi.fn().mockImplementation(function () { return { send: vi.fn(async () => ({})) }; }),
    PutMetricDataCommand: class extends FakeCommand {
      readonly _kind = 'PutMetricDataCommand';
    },
  };
});

// The reconciler no longer touches DynamoDB; shared/ddb is only imported for
// periodFor. Mock it so no real client is constructed.
vi.mock('../src/shared/ddb.js', () => ({
  ddb: { send: vi.fn() },
  periodFor: () => '2026-05',
}));

interface CapturedMetric {
  name: string;
  value: number;
}
const capturedMetrics: CapturedMetric[] = [];
const capturedDimensions: Record<string, string> = {};
vi.mock('../src/shared/powertools.js', async () => {
  const real = await vi.importActual<typeof import('@aws-lambda-powertools/metrics')>(
    '@aws-lambda-powertools/metrics',
  );
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: {
      addMetric: (name: string, _unit: string, value: number) => {
        capturedMetrics.push({ name, value });
      },
      addDimension: (name: string, value: string) => {
        capturedDimensions[name] = value;
      },
      publishStoredMetrics: vi.fn(),
      singleMetric: () => ({ addDimension: vi.fn(), addMetric: vi.fn() }),
    },
    MetricUnit: real.MetricUnit,
  };
});

const { handler } = await import('../src/cur-reconciler/index.js');

const WATERMARK = '2026-05-28T00:00:00.000Z';

describe('cur-reconciler', () => {
  afterEach(() => {
    capturedMetrics.length = 0;
    for (const k of Object.keys(capturedDimensions)) delete capturedDimensions[k];
    startedQueries = [];
    curRows = [];
    ledgerRows = [];
    startQueryMock.mockClear();
  });

  it('runs a CUR query and a ledger query, both watermarked, with bound parameters', async () => {
    await handler({ period: '2026-05', watermark: WATERMARK });

    expect(startedQueries).toHaveLength(2);
    const cur = startedQueries.find((q) => q.id === 'qid-cur')!;
    const ledger = startedQueries.find((q) => q.id === 'qid-ledger')!;

    // CUR side: canonicalization in-SQL, period + watermark BOUND as
    // parameters (never interpolated), usage windowed below the watermark.
    expect(cur.queryString).toContain('regexp_replace(line_item_iam_principal');
    expect(cur.queryString).toContain('arn:aws:iam::$1:role/$2');
    expect(cur.queryString).toMatch(/GROUP BY regexp_replace\(line_item_iam_principal/);
    expect(cur.queryString).toContain('line_item_usage_start_date < CAST(? AS TIMESTAMP)');
    expect(cur.queryString).not.toContain('2026-05');
    expect(cur.parameters).toEqual(["'2026-05-01 00:00:00'", "'2026-05-28 00:00:00'"]);

    // Ledger side: meter totals come from the Athena ledger (NOT RunningSpend),
    // windowed on recordedat below the same watermark, and summing ONLY
    // `model#` targets — `profile#` rows carry the SAME dollars again (the
    // meter writes both per profile-routed invocation for budgeting), so
    // including them double-counts profile-routed spend (observed: +$24
    // phantom drift on a month with ~25% profile-routed traffic).
    expect(ledger.queryString).toContain('FROM test_ledger.invocations');
    expect(ledger.queryString).toContain('recordedat < ?');
    expect(ledger.queryString).toContain("target LIKE 'model#%'");
    expect(ledger.queryString).not.toContain('2026-05');
    expect(ledger.parameters).toEqual(["'2026-05'", `'${WATERMARK}'`]);
  });

  it('publishes metrics with the stage dimension', async () => {
    await handler({ period: '2026-05', watermark: WATERMARK });
    expect(capturedDimensions.stage).toBe('test');
  });

  it('rejects a period that is not YYYY-MM (never reaches Athena)', async () => {
    await handler({ period: "2026-05' OR 1=1--" });
    expect(startQueryMock).not.toHaveBeenCalled();
  });

  it('rejects a watermark that is not ISO-8601 UTC (never reaches Athena)', async () => {
    await handler({ period: '2026-05', watermark: "2026-05-28' OR 1=1--" });
    expect(startQueryMock).not.toHaveBeenCalled();
  });

  it('aggregates multiple CUR session rows of the same role into one delta against the ledger', async () => {
    // Defensive in-process path: real CUR is already aggregated by the SQL
    // GROUP BY, but phantom per-session rows must still collapse.
    curRows = [
      { Data: [{ VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/sess-1' }, { VarCharValue: '10.00' }] },
      { Data: [{ VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/sess-2' }, { VarCharValue: '5.00' }] },
      { Data: [{ VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/sess-3' }, { VarCharValue: '3.00' }] },
    ];
    ledgerRows = [
      { Data: [{ VarCharValue: 'principal#arn:aws:iam::1:role/MyRole' }, { VarCharValue: '18.00' }] },
    ];

    const result = await handler({ period: '2026-05', watermark: WATERMARK });

    expect(result.deltas).toBe(1);
    const reconDeltas = capturedMetrics.filter((m) => m.name === 'ReconciliationDelta');
    expect(reconDeltas).toHaveLength(1);
    expect(reconDeltas[0].value).toBeCloseTo(0, 6); // CUR 18 - meter 18
  });

  it('emits a real delta when the meter and CUR disagree about a metered principal', async () => {
    curRows = [
      { Data: [{ VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/s1' }, { VarCharValue: '20.00' }] },
    ];
    ledgerRows = [
      { Data: [{ VarCharValue: 'principal#arn:aws:iam::1:role/MyRole' }, { VarCharValue: '12.50' }] },
    ];

    await handler({ period: '2026-05', watermark: WATERMARK });

    const reconDeltas = capturedMetrics.filter((m) => m.name === 'ReconciliationDelta');
    expect(reconDeltas).toHaveLength(1);
    expect(reconDeltas[0].value).toBeCloseTo(7.5, 6);
  });

  it('routes CUR-only spend (pre-deployment / unmetered stage) to ReconciliationUnmeteredSpend, not the alarmed delta', async () => {
    curRows = [
      { Data: [{ VarCharValue: 'arn:aws:sts::1:assumed-role/AdminRole/alice' }, { VarCharValue: '245.77' }] },
    ];
    ledgerRows = [];

    const result = await handler({ period: '2026-05', watermark: WATERMARK });

    // No alarm-feeding delta for a principal the stage never metered…
    expect(capturedMetrics.filter((m) => m.name === 'ReconciliationDelta')).toHaveLength(0);
    // …but the spend stays visible on the info metric.
    const unmetered = capturedMetrics.filter((m) => m.name === 'ReconciliationUnmeteredSpend');
    expect(unmetered).toHaveLength(1);
    expect(unmetered[0].value).toBeCloseTo(245.77, 2);
    expect(result.unmeteredPrincipals).toBe(1);
  });

  it('always emits ReconciliationUnmeteredSpend (0 when everything is metered)', async () => {
    curRows = [
      { Data: [{ VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/s1' }, { VarCharValue: '5.00' }] },
    ];
    ledgerRows = [
      { Data: [{ VarCharValue: 'principal#arn:aws:iam::1:role/MyRole' }, { VarCharValue: '5.00' }] },
    ];

    await handler({ period: '2026-05', watermark: WATERMARK });

    const unmetered = capturedMetrics.filter((m) => m.name === 'ReconciliationUnmeteredSpend');
    expect(unmetered).toHaveLength(1);
    expect(unmetered[0].value).toBe(0);
  });
});
