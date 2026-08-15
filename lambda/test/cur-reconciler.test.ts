import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.RUNNING_SPEND_TABLE = 'test-running-spend';
  process.env.ATHENA_WORKGROUP = 'test-wg';
  process.env.CUR_DATABASE = 'test_cur';
  process.env.CUR_TABLE = 'data';
});

// Capture the Athena query string the reconciler issues so we can assert that
// the canonicalization is performed in-SQL (not just in-process).
let lastQueryString: string | undefined;
let lastExecutionParameters: string[] | undefined;
const startQueryMock = vi.fn(
  async (cmd: { input: { QueryString?: string; ExecutionParameters?: string[] } }) => {
    lastQueryString = cmd.input.QueryString;
    lastExecutionParameters = cmd.input.ExecutionParameters;
    return { QueryExecutionId: 'qid-1' };
  },
);
const getQueryExecutionMock = vi.fn(async () => ({
  QueryExecution: { Status: { State: 'SUCCEEDED' } },
}));
const getQueryResultsMock = vi.fn(async () => ({ ResultSet: { Rows: [] } }));

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
          if (cmd._kind === 'GetQueryResultsCommand') return getQueryResultsMock();
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

const ddbSendMock = vi.fn();
vi.mock('../src/shared/ddb.js', () => ({
  ddb: { send: (cmd: unknown) => ddbSendMock(cmd) },
  periodFor: () => '2026-05',
}));

interface CapturedMetric {
  name: string;
  value: number;
}
const capturedMetrics: CapturedMetric[] = [];
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
      addDimension: vi.fn(),
      publishStoredMetrics: vi.fn(),
      singleMetric: () => ({ addDimension: vi.fn(), addMetric: vi.fn() }),
    },
    MetricUnit: real.MetricUnit,
  };
});

const { handler } = await import('../src/cur-reconciler/index.js');

describe('cur-reconciler', () => {
  afterEach(() => {
    capturedMetrics.length = 0;
    lastQueryString = undefined;
    lastExecutionParameters = undefined;
    startQueryMock.mockClear();
    ddbSendMock.mockReset();
    getQueryResultsMock.mockReset();
    getQueryResultsMock.mockResolvedValue({ ResultSet: { Rows: [] } });
  });

  it('Athena query canonicalizes assumed-role principals in-SQL', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    await handler({ period: '2026-05' });

    expect(lastQueryString).toBeDefined();
    expect(lastQueryString!).toContain('regexp_replace(line_item_iam_principal');
    expect(lastQueryString!).toContain('arn:aws:iam::$1:role/$2');
    // GROUP BY must use the canonical expression so per-session rows aggregate.
    expect(lastQueryString!).toMatch(/GROUP BY regexp_replace\(line_item_iam_principal/);
    // SQL-injection defense: `period` must be BOUND as a query parameter, never
    // interpolated into the SQL string. The query uses a CAST(? AS TIMESTAMP)
    // placeholder and the value rides in ExecutionParameters.
    expect(lastQueryString!).toContain('CAST(? AS TIMESTAMP)');
    expect(lastQueryString!).not.toContain('2026-05');
    expect(lastExecutionParameters).toEqual(["'2026-05-01 00:00:00'"]);
  });

  it('rejects a period that is not YYYY-MM (never reaches Athena)', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    // A SQL-injection-style period must be refused by validation, so no Athena
    // query is issued at all.
    await handler({ period: "2026-05' OR 1=1--" });
    expect(startQueryMock).not.toHaveBeenCalled();
    expect(lastQueryString).toBeUndefined();
  });

  it('aggregates multiple session rows of the same role into one delta', async () => {
    // CUR returns 3 phantom session rows (defensive: real CUR would already
    // be aggregated by the SQL GROUP BY, but covering the in-process path).
    getQueryResultsMock.mockResolvedValue({
      ResultSet: {
        Rows: [
          { Data: [{ VarCharValue: 'principal' }, { VarCharValue: 'cur_spend' }] }, // header
          {
            Data: [
              { VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/sess-1' },
              { VarCharValue: '10.00' },
            ],
          },
          {
            Data: [
              { VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/sess-2' },
              { VarCharValue: '5.00' },
            ],
          },
          {
            Data: [
              { VarCharValue: 'arn:aws:sts::1:assumed-role/MyRole/sess-3' },
              { VarCharValue: '3.00' },
            ],
          },
        ],
      },
    });
    // Meter has the canonical row at $18 — perfect match for the aggregated CUR total.
    ddbSendMock.mockResolvedValue({
      Items: [
        {
          principal: 'principal#arn:aws:iam::1:role/MyRole',
          period: '2026-05',
          spendUsd: 18.0,
        },
      ],
    });

    const result = await handler({ period: '2026-05' });

    // Three CUR rows + one meter row collapse to one canonical key.
    expect(result.deltas).toBe(1);
    const reconDeltas = capturedMetrics.filter((m) => m.name === 'ReconciliationDelta');
    expect(reconDeltas).toHaveLength(1);
    expect(reconDeltas[0].value).toBeCloseTo(0, 6); // CUR 18 - meter 18
  });

  it('emits a delta when CUR has spend the meter never saw (e.g., pre-deployment history)', async () => {
    getQueryResultsMock.mockResolvedValue({
      ResultSet: {
        Rows: [
          { Data: [{ VarCharValue: 'principal' }, { VarCharValue: 'cur_spend' }] },
          {
            Data: [
              { VarCharValue: 'arn:aws:sts::1:assumed-role/AdminRole/alice' },
              { VarCharValue: '245.77' },
            ],
          },
        ],
      },
    });
    ddbSendMock.mockResolvedValue({ Items: [] });

    await handler({ period: '2026-05' });

    const reconDeltas = capturedMetrics.filter((m) => m.name === 'ReconciliationDelta');
    expect(reconDeltas).toHaveLength(1);
    expect(reconDeltas[0].value).toBeCloseTo(245.77, 2);
  });
});
