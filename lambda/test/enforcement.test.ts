import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The enforcement module reads BUDGETS_TABLE / RUNNING_SPEND_TABLE /
// INFERENCE_PROFILES_TABLE / AWS_ACCOUNT_ID at module load. Set them before
// the dynamic import below.
beforeAll(() => {
  process.env.BUDGETS_TABLE = 'test-budgets';
  process.env.RUNNING_SPEND_TABLE = 'test-running-spend';
  process.env.INFERENCE_PROFILES_TABLE = 'test-inference-profiles';
  process.env.AWS_ACCOUNT_ID = '123456789012';
});

// Stub aws-sdk-client-iam so we can drive the IAM call sequence and count
// AttachUserPolicy retries deterministically. The enforcement Lambda's
// retry helper sleeps between attempts (100/400/1600ms with ±50% jitter); we
// fake timers so the test completes instantly.
const iamSendMock = vi.fn();
vi.mock('@aws-sdk/client-iam', () => {
  class FakeCommand {
    constructor(public readonly input: unknown) {}
  }
  return {
    IAMClient: vi.fn().mockImplementation(function () { return { send: iamSendMock }; }),
    AttachUserPolicyCommand: class extends FakeCommand {
      readonly _kind = 'AttachUserPolicyCommand';
    },
    AttachRolePolicyCommand: class extends FakeCommand {
      readonly _kind = 'AttachRolePolicyCommand';
    },
    CreatePolicyCommand: class extends FakeCommand {
      readonly _kind = 'CreatePolicyCommand';
    },
    GetPolicyCommand: class extends FakeCommand {
      readonly _kind = 'GetPolicyCommand';
    },
  };
});

// Stub the DDB doc client used by the enforcement Lambda. We script returns
// per-command-class so the handler walks the breach path end-to-end.
const ddbSendMock = vi.fn();
vi.mock('../src/shared/ddb.js', () => ({
  ddb: { send: (cmd: unknown) => ddbSendMock(cmd) },
  periodFor: () => '2026-05',
  periodEndEpochFor: () => 0,
  oneHourFromNowEpoch: () => 0,
}));

// Capture metric emissions. We accept either the bulk-metric path
// (`metrics.addMetric`) or the singleMetric path used for the
// EnforcementAttachStuck dimensioned metric.
interface CapturedMetric {
  name: string;
  unit: string;
  value: number;
  dimensions: Record<string, string>;
}
const captured: CapturedMetric[] = [];
let pendingDims: Record<string, string> = {};

vi.mock('../src/shared/powertools.js', async () => {
  const real = await vi.importActual<typeof import('@aws-lambda-powertools/metrics')>(
    '@aws-lambda-powertools/metrics',
  );
  const fakeMetrics = {
    addMetric: (name: string, unit: string, value: number) => {
      captured.push({ name, unit, value, dimensions: { ...pendingDims } });
    },
    addDimension: (k: string, v: string) => {
      pendingDims[k] = v;
    },
    publishStoredMetrics: () => {
      pendingDims = {};
    },
    singleMetric: () => {
      const dims: Record<string, string> = {};
      return {
        addDimension: (k: string, v: string) => {
          dims[k] = v;
        },
        addMetric: (name: string, unit: string, value: number) => {
          captured.push({ name, unit, value, dimensions: { ...dims } });
        },
      };
    },
  };
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: fakeMetrics,
    MetricUnit: real.MetricUnit,
  };
});

const importHandler = async () => {
  const mod = await import('../src/enforcement/index.js');
  return mod.handler;
};

const makeStreamEvent = () => ({
  Records: [
    {
      eventName: 'MODIFY' as const,
      dynamodb: {
        NewImage: {
          principal: { S: 'principal#arn:aws:iam::123456789012:user/alice' },
          sk: { S: 'period#2026-05#target#model#anthropic.claude-opus-4-7-v1' },
          spendUsd: { N: '12.5' },
          period: { S: '2026-05' },
          target: { S: 'model#anthropic.claude-opus-4-7-v1' },
        },
      },
    },
  ],
});

const dispatchDdb = (cmd: unknown): unknown => {
  const ctorName = (cmd as { constructor: { name: string } }).constructor.name;
  if (ctorName === 'GetCommand') {
    const input = (cmd as { input: { Key?: Record<string, unknown> } }).input;
    const key = (input.Key ?? {}) as { target?: string };
    // Exact-target Get returns a deny budget; wildcard returns nothing.
    if (key.target === 'model#anthropic.claude-opus-4-7-v1') {
      return {
        Item: {
          principal: 'principal#arn:aws:iam::123456789012:user/alice',
          target: 'model#anthropic.claude-opus-4-7-v1',
          limitUsd: 10,
          action: 'deny',
          enabled: true,
        },
      };
    }
    return {};
  }
  if (ctorName === 'QueryCommand') {
    return { Items: [] };
  }
  if (ctorName === 'UpdateCommand') {
    // The set-once stamp succeeds.
    return {};
  }
  throw new Error(`Unexpected DDB command in test: ${ctorName}`);
};

// Variant of dispatchDdb that returns a budget with a custom block@80 threshold
// instead of the default block@100. Used by the multi-threshold tests below.
const dispatchDdbBlockAt = (atPct: number) => (cmd: unknown): unknown => {
  const ctorName = (cmd as { constructor: { name: string } }).constructor.name;
  if (ctorName === 'GetCommand') {
    const input = (cmd as { input: { Key?: Record<string, unknown> } }).input;
    const key = (input.Key ?? {}) as { target?: string };
    if (key.target === 'model#anthropic.claude-opus-4-7-v1') {
      return {
        Item: {
          principal: 'principal#arn:aws:iam::123456789012:user/alice',
          target: 'model#anthropic.claude-opus-4-7-v1',
          limitUsd: 10,
          action: 'deny',
          enabled: true,
          thresholds: [
            { at: 50, action: 'warn' },
            { at: atPct, action: 'block' },
          ],
        },
      };
    }
    return {};
  }
  if (ctorName === 'QueryCommand') return { Items: [] };
  if (ctorName === 'UpdateCommand') return {};
  throw new Error(`Unexpected DDB command in test: ${ctorName}`);
};

const makeStreamEventAtSpend = (spendUsd: number) => ({
  Records: [
    {
      eventName: 'MODIFY' as const,
      dynamodb: {
        NewImage: {
          principal: { S: 'principal#arn:aws:iam::123456789012:user/alice' },
          sk: { S: 'period#2026-05#target#model#anthropic.claude-opus-4-7-v1' },
          spendUsd: { N: String(spendUsd) },
          period: { S: '2026-05' },
          target: { S: 'model#anthropic.claude-opus-4-7-v1' },
        },
      },
    },
  ],
});

// Variant of dispatchDdb that returns an unlimited budget — used to
// verify enforcement short-circuits regardless of spend.
const dispatchDdbUnlimited = (cmd: unknown): unknown => {
  const ctorName = (cmd as { constructor: { name: string } }).constructor.name;
  if (ctorName === 'GetCommand') {
    const input = (cmd as { input: { Key?: Record<string, unknown> } }).input;
    const key = (input.Key ?? {}) as { target?: string };
    if (key.target === 'model#anthropic.claude-opus-4-7-v1') {
      return {
        Item: {
          principal: 'principal#arn:aws:iam::123456789012:user/alice',
          target: 'model#anthropic.claude-opus-4-7-v1',
          limitUsd: 10,
          action: 'deny',
          enabled: true,
          unlimited: true,
        },
      };
    }
    return {};
  }
  if (ctorName === 'QueryCommand') return { Items: [] };
  if (ctorName === 'UpdateCommand') return {};
  throw new Error(`Unexpected DDB command in test: ${ctorName}`);
};

describe('unlimited budget short-circuit', () => {
  beforeEach(() => {
    iamSendMock.mockReset();
    ddbSendMock.mockReset();
    captured.length = 0;
    pendingDims = {};
    iamSendMock.mockImplementation(() => {
      throw new Error('IAM should not be called for unlimited budgets');
    });
    ddbSendMock.mockImplementation((cmd: unknown) =>
      Promise.resolve(dispatchDdbUnlimited(cmd)),
    );
  });

  it('does NOT attach a deny policy even when spend is over the limit', async () => {
    const handler = await importHandler();
    const out = await handler(makeStreamEventAtSpend(50) as never);
    expect(out).toEqual({ processed: 1 });

    // No EnforcementApplied; instead UnlimitedBudgetSeen counted.
    expect(captured.filter((m) => m.name === 'EnforcementApplied')).toHaveLength(0);
    expect(captured.filter((m) => m.name === 'UnlimitedBudgetSeen')).toHaveLength(1);
    // No IAM mutations.
    expect(iamSendMock.mock.calls).toHaveLength(0);
  });
});

describe('multi-threshold enforcement', () => {
  beforeEach(() => {
    iamSendMock.mockReset();
    ddbSendMock.mockReset();
    captured.length = 0;
    pendingDims = {};
    iamSendMock.mockImplementation((cmd: unknown) => {
      const kind = (cmd as { _kind?: string })._kind;
      if (kind === 'CreatePolicyCommand') return Promise.resolve({});
      if (kind === 'GetPolicyCommand') {
        return Promise.resolve({
          Policy: { Arn: 'arn:aws:iam::123456789012:policy/bbg-deny-fakefake-2026-05' },
        });
      }
      if (kind === 'AttachUserPolicyCommand') return Promise.resolve({});
      if (kind === 'AttachRolePolicyCommand') return Promise.resolve({});
      throw new Error(`Unexpected IAM command kind: ${kind}`);
    });
  });

  it('attaches when spend crosses a custom block@80 threshold (8 USD on a 10 USD budget)', async () => {
    ddbSendMock.mockImplementation((cmd: unknown) =>
      Promise.resolve(dispatchDdbBlockAt(80)(cmd)),
    );
    const handler = await importHandler();
    const out = await handler(makeStreamEventAtSpend(8) as never);
    expect(out).toEqual({ processed: 1 });
    const applied = captured.filter((m) => m.name === 'EnforcementApplied');
    expect(applied).toHaveLength(1);
  });

  it('does not attach when spend is below the custom block@80 threshold (7 USD on a 10 USD budget)', async () => {
    ddbSendMock.mockImplementation((cmd: unknown) =>
      Promise.resolve(dispatchDdbBlockAt(80)(cmd)),
    );
    const handler = await importHandler();
    const out = await handler(makeStreamEventAtSpend(7) as never);
    expect(out).toEqual({ processed: 1 });
    const applied = captured.filter((m) => m.name === 'EnforcementApplied');
    expect(applied).toHaveLength(0);
    // Also no IAM AttachUserPolicy / CreatePolicy should fire.
    const iamCalls = iamSendMock.mock.calls.length;
    expect(iamCalls).toBe(0);
  });
});

describe('ENF-2 enforcement kill-switch', () => {
  beforeEach(() => {
    iamSendMock.mockReset();
    ddbSendMock.mockReset();
    captured.length = 0;
    pendingDims = {};
    ddbSendMock.mockImplementation((cmd: unknown) => Promise.resolve(dispatchDdb(cmd)));
    iamSendMock.mockImplementation(() => {
      throw new Error('IAM must not be called while enforcement is paused');
    });
  });

  afterEach(() => {
    delete process.env.ENFORCEMENT_PAUSED;
  });

  it('skips the deny attach and emits EnforcementPaused when ENFORCEMENT_PAUSED=true', async () => {
    process.env.ENFORCEMENT_PAUSED = 'true';
    const handler = await importHandler();
    // spend 12.5 on a 10 USD deny budget → would normally attach.
    const out = await handler(makeStreamEvent() as never);
    expect(out).toEqual({ processed: 1 });
    expect(captured.filter((m) => m.name === 'EnforcementPaused')).toHaveLength(1);
    expect(captured.filter((m) => m.name === 'EnforcementApplied')).toHaveLength(0);
    // No policy created or attached.
    expect(iamSendMock.mock.calls).toHaveLength(0);
  });

  it('enforces normally when ENFORCEMENT_PAUSED is unset', async () => {
    delete process.env.ENFORCEMENT_PAUSED;
    iamSendMock.mockImplementation((cmd: unknown) => {
      const kind = (cmd as { _kind?: string })._kind;
      if (kind === 'CreatePolicyCommand') return Promise.resolve({});
      if (kind === 'GetPolicyCommand') {
        return Promise.resolve({
          Policy: { Arn: 'arn:aws:iam::123456789012:policy/bbg-deny-fakefake-2026-05' },
        });
      }
      if (kind === 'AttachUserPolicyCommand') return Promise.resolve({});
      throw new Error(`Unexpected IAM command kind: ${kind}`);
    });
    const handler = await importHandler();
    const out = await handler(makeStreamEvent() as never);
    expect(out).toEqual({ processed: 1 });
    expect(captured.filter((m) => m.name === 'EnforcementPaused')).toHaveLength(0);
    expect(captured.filter((m) => m.name === 'EnforcementApplied')).toHaveLength(1);
  });
});

describe('enforcement attach retry path', () => {
  beforeEach(() => {
    iamSendMock.mockReset();
    ddbSendMock.mockReset();
    captured.length = 0;
    pendingDims = {};
    ddbSendMock.mockImplementation((cmd: unknown) => Promise.resolve(dispatchDdb(cmd)));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries the attach 3 times and emits EnforcementAttachStuck on terminal failure', async () => {
    const transient = Object.assign(new Error('Throttling: rate exceeded'), {
      name: 'ThrottlingException',
    });

    iamSendMock.mockImplementation((cmd: unknown) => {
      const kind = (cmd as { _kind?: string })._kind;
      if (kind === 'CreatePolicyCommand') return Promise.resolve({});
      if (kind === 'GetPolicyCommand') {
        return Promise.resolve({
          Policy: { Arn: 'arn:aws:iam::123456789012:policy/bbg-deny-fakefake-2026-05' },
        });
      }
      if (kind === 'AttachUserPolicyCommand') return Promise.reject(transient);
      throw new Error(`Unexpected IAM command kind: ${kind}`);
    });

    const handler = await importHandler();

    // Drive the retry loop's setTimeout backoffs to completion in fake time.
    const promise = handler(makeStreamEvent() as never);
    await vi.runAllTimersAsync();
    const out = await promise;

    // Retry-exhausted attach throws out of evaluateAndEnforce, so the per-
    // record try/catch in the handler logs the error and the record is not
    // counted as processed. This is fine — the attach failure is now
    // surfaced via the EnforcementAttachStuck metric below.
    expect(out).toEqual({ processed: 0 });

    const attachAttempts = iamSendMock.mock.calls.filter(
      (c) => (c[0] as { _kind?: string })._kind === 'AttachUserPolicyCommand',
    );
    expect(attachAttempts).toHaveLength(3);

    // Dual-emit: one drill-down emission with the principal dimension and
    // one rollup with just service=bbg so the single-stream alarm in
    // observability-stack.ts can fire across the population. Both must
    // carry value=1 for a single failure.
    const stuck = captured.filter((m) => m.name === 'EnforcementAttachStuck');
    expect(stuck).toHaveLength(2);
    expect(stuck.every((s) => s.value === 1)).toBe(true);
    const drillDown = stuck.find((s) => s.dimensions.principal !== undefined);
    expect(drillDown).toBeDefined();
    expect(drillDown!.dimensions.principal).toBe(
      'principal#arn:aws:iam::123456789012:user/alice',
    );
    const rollup = stuck.find((s) => s.dimensions.principal === undefined);
    expect(rollup).toBeDefined();

    // EnforcementErrors is also incremented (existing behavior preserved).
    const errors = captured.filter((m) => m.name === 'EnforcementErrors');
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe(1);
  });
});

describe('G2 non-ARN identity-lens enforcement', () => {
  const ISSUER_ROLE =
    'principal#arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_Dev_abc';

  beforeEach(() => {
    iamSendMock.mockReset();
    ddbSendMock.mockReset();
    captured.length = 0;
    pendingDims = {};
    iamSendMock.mockImplementation((cmd: unknown) => {
      const kind = (cmd as { _kind?: string })._kind;
      if (kind === 'CreatePolicyCommand') return Promise.resolve({});
      if (kind === 'GetPolicyCommand')
        return Promise.resolve({
          Policy: { Arn: 'arn:aws:iam::123456789012:policy/bbg-deny-fakefake-2026-05' },
        });
      if (kind === 'AttachRolePolicyCommand') return Promise.resolve({});
      if (kind === 'AttachUserPolicyCommand') return Promise.resolve({});
      throw new Error(`Unexpected IAM command kind: ${kind}`);
    });
  });

  const lensDispatch = (lensPrincipal: string) => (cmd: unknown): unknown => {
    const ctorName = (cmd as { constructor: { name: string } }).constructor.name;
    if (ctorName === 'GetCommand') {
      const key = ((cmd as { input: { Key?: Record<string, unknown> } }).input.Key ?? {}) as {
        principal?: string;
        target?: string;
      };
      if (key.principal === lensPrincipal && key.target === 'model#anthropic.claude-opus-4-7-v1') {
        return { Item: { principal: lensPrincipal, target: key.target, limitUsd: 10, action: 'deny', enabled: true } };
      }
      return {};
    }
    if (ctorName === 'QueryCommand') return { Items: [] };
    if (ctorName === 'UpdateCommand') return {};
    throw new Error(`Unexpected DDB command: ${ctorName}`);
  };

  const lensStreamEvent = (
    lensPrincipal: string,
    identityLens: 'sso-user' | 'source-identity',
  ) => ({
    Records: [
      {
        eventName: 'MODIFY' as const,
        dynamodb: {
          NewImage: {
            principal: { S: lensPrincipal },
            sk: { S: 'period#2026-05#target#model#anthropic.claude-opus-4-7-v1' },
            spendUsd: { N: '12.5' },
            period: { S: '2026-05' },
            target: { S: 'model#anthropic.claude-opus-4-7-v1' },
            identityLens: { S: identityLens },
            issuerPrincipal: { S: ISSUER_ROLE },
          },
        },
      },
    ],
  });

  const createdPolicyDoc = () => {
    const call = iamSendMock.mock.calls.find(
      (c) => (c[0] as { _kind?: string })._kind === 'CreatePolicyCommand',
    );
    const input = (call![0] as { input: { PolicyDocument: string } }).input;
    return JSON.parse(input.PolicyDocument) as {
      Statement: Array<{ Condition?: Record<string, Record<string, string>> }>;
    };
  };

  it('sso-user lens: attaches to the ISSUER role with an aws:userid condition', async () => {
    const lensPrincipal = 'principal#sso-user#alice@example.com';
    ddbSendMock.mockImplementation((cmd: unknown) => Promise.resolve(lensDispatch(lensPrincipal)(cmd)));
    const handler = await importHandler();
    const out = await handler(lensStreamEvent(lensPrincipal, 'sso-user') as never);
    expect(out).toEqual({ processed: 1 });
    expect(captured.filter((m) => m.name === 'EnforcementApplied')).toHaveLength(1);

    const attach = iamSendMock.mock.calls.find(
      (c) => (c[0] as { _kind?: string })._kind === 'AttachRolePolicyCommand',
    );
    expect(attach).toBeDefined();
    expect((attach![0] as { input: { RoleName: string } }).input.RoleName).toBe('AWSReservedSSO_Dev_abc');

    for (const stmt of createdPolicyDoc().Statement) {
      expect(stmt.Condition).toEqual({ StringLike: { 'aws:userid': '*:alice@example.com' } });
    }
  });

  it('source-identity lens: builds an aws:SourceIdentity condition', async () => {
    const lensPrincipal = 'principal#sourceIdentity#svc-abc';
    ddbSendMock.mockImplementation((cmd: unknown) => Promise.resolve(lensDispatch(lensPrincipal)(cmd)));
    const handler = await importHandler();
    const out = await handler(lensStreamEvent(lensPrincipal, 'source-identity') as never);
    expect(out).toEqual({ processed: 1 });
    for (const stmt of createdPolicyDoc().Statement) {
      expect(stmt.Condition).toEqual({ StringEquals: { 'aws:SourceIdentity': 'svc-abc' } });
    }
  });

  it('unknown principal: no policy, no stamp, no EnforcementApplied — emits EnforcementUnattachable', async () => {
    const unknownPrincipal = 'principal#unknown';
    ddbSendMock.mockImplementation((cmd: unknown): unknown => {
      const ctorName = (cmd as { constructor: { name: string } }).constructor.name;
      if (ctorName === 'GetCommand') {
        const key = ((cmd as { input: { Key?: Record<string, unknown> } }).input.Key ?? {}) as {
          principal?: string;
          target?: string;
        };
        if (key.principal === unknownPrincipal && key.target === 'model#anthropic.claude-opus-4-7-v1') {
          return { Item: { principal: unknownPrincipal, target: key.target, limitUsd: 10, action: 'deny', enabled: true } };
        }
        return {};
      }
      if (ctorName === 'QueryCommand') return { Items: [] };
      if (ctorName === 'UpdateCommand') return {};
      throw new Error(`Unexpected DDB command: ${ctorName}`);
    });
    iamSendMock.mockImplementation(() => {
      throw new Error('IAM must not be called for an unattachable principal');
    });
    const handler = await importHandler();
    const out = await handler({
      Records: [
        {
          eventName: 'MODIFY' as const,
          dynamodb: {
            NewImage: {
              principal: { S: unknownPrincipal },
              sk: { S: 'period#2026-05#target#model#anthropic.claude-opus-4-7-v1' },
              spendUsd: { N: '12.5' },
              period: { S: '2026-05' },
              target: { S: 'model#anthropic.claude-opus-4-7-v1' },
            },
          },
        },
      ],
    } as never);
    expect(out).toEqual({ processed: 1 });
    expect(iamSendMock.mock.calls).toHaveLength(0);
    expect(captured.filter((m) => m.name === 'EnforcementApplied')).toHaveLength(0);
    const unatt = captured.filter((m) => m.name === 'EnforcementUnattachable');
    expect(unatt).toHaveLength(2);
    expect(unatt.some((m) => m.dimensions.principal === unknownPrincipal)).toBe(true);
  });
});
