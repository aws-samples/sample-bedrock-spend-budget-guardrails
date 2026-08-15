import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the parallel CUR + Budgets enforcement channel's DDB-stream
 * Lambda. We mock the AWS SDK clients (Budgets, IAM) and the shared DDB
 * doc client so we can exercise INSERT / MODIFY / REMOVE / idempotent
 * re-INSERT and the failure-metric path.
 */

beforeAll(() => {
  process.env.STAGE_PREFIX = 'test';
  process.env.INFERENCE_PROFILES_TABLE = 'test-inference-profiles';
  process.env.BUDGETS_ACTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/test-bbg-budgets-action-role';
  process.env.AWS_ACCOUNT_ID = '123456789012';
  process.env.NOTIFY_EMAIL = 'noreply@example.com';
});

interface SdkCall {
  client: 'budgets' | 'iam';
  kind: string;
  input: Record<string, unknown>;
}

const sdkCalls: SdkCall[] = [];

const budgetsSendMock = vi.fn();
const iamSendMock = vi.fn();

vi.mock('@aws-sdk/client-budgets', () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    BudgetsClient: vi.fn().mockImplementation(function () {
      return {
        send: (cmd: { _kind: string; input: Record<string, unknown> }) => {
          sdkCalls.push({ client: 'budgets', kind: cmd._kind, input: cmd.input });
          return budgetsSendMock(cmd);
        },
      };
    }),
    CreateBudgetCommand: class extends FakeCommand {
      readonly _kind = 'CreateBudget';
    },
    UpdateBudgetCommand: class extends FakeCommand {
      readonly _kind = 'UpdateBudget';
    },
    DeleteBudgetCommand: class extends FakeCommand {
      readonly _kind = 'DeleteBudget';
    },
    DescribeBudgetCommand: class extends FakeCommand {
      readonly _kind = 'DescribeBudget';
    },
    CreateBudgetActionCommand: class extends FakeCommand {
      readonly _kind = 'CreateBudgetAction';
    },
    UpdateBudgetActionCommand: class extends FakeCommand {
      readonly _kind = 'UpdateBudgetAction';
    },
    DeleteBudgetActionCommand: class extends FakeCommand {
      readonly _kind = 'DeleteBudgetAction';
    },
    DescribeBudgetActionsForBudgetCommand: class extends FakeCommand {
      readonly _kind = 'DescribeBudgetActionsForBudget';
    },
  };
});

vi.mock('@aws-sdk/client-iam', () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    IAMClient: vi.fn().mockImplementation(function () {
      return {
        send: (cmd: { _kind: string; input: Record<string, unknown> }) => {
          sdkCalls.push({ client: 'iam', kind: cmd._kind, input: cmd.input });
          return iamSendMock(cmd);
        },
      };
    }),
    CreatePolicyCommand: class extends FakeCommand {
      readonly _kind = 'CreatePolicy';
    },
    GetPolicyCommand: class extends FakeCommand {
      readonly _kind = 'GetPolicy';
    },
  };
});

vi.mock('../src/shared/ddb.js', () => ({
  ddb: { send: vi.fn(async () => ({ Items: [] })) },
  periodFor: () => '2026-05',
  periodEndEpochFor: () => 0,
  oneHourFromNowEpoch: () => 0,
}));

interface CapturedMetric {
  name: string;
  value: number;
}
const captured: CapturedMetric[] = [];

vi.mock('../src/shared/powertools.js', async () => {
  const real = await vi.importActual<typeof import('@aws-lambda-powertools/metrics')>(
    '@aws-lambda-powertools/metrics',
  );
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: {
      addMetric: (name: string, _unit: string, value: number) => {
        captured.push({ name, value });
      },
      addDimension: vi.fn(),
      publishStoredMetrics: vi.fn(),
      singleMetric: () => ({
        addDimension: vi.fn().mockReturnThis(),
        addMetric: (name: string, _unit: string, value: number) => {
          captured.push({ name, value });
        },
      }),
    },
    MetricUnit: real.MetricUnit,
  };
});

const importHandler = async () => (await import('../src/budgets-action-sync')).handler;

const PRINCIPAL = 'principal#arn:aws:iam::123456789012:user/alice';
const TARGET = 'model#anthropic.claude-sonnet-4-6';

const makeNewImage = (overrides: Record<string, { S?: string; N?: string; BOOL?: boolean }> = {}) => ({
  principal: { S: PRINCIPAL },
  target: { S: TARGET },
  limitUsd: { N: '50' },
  action: { S: 'deny' },
  enabled: { BOOL: true },
  ...overrides,
});

const insertEvent = () => ({
  Records: [
    {
      eventName: 'INSERT' as const,
      dynamodb: { NewImage: makeNewImage() },
    },
  ],
});

const modifyEvent = (limit: string) => ({
  Records: [
    {
      eventName: 'MODIFY' as const,
      dynamodb: { NewImage: makeNewImage({ limitUsd: { N: limit } }) },
    },
  ],
});

const removeEvent = () => ({
  Records: [
    {
      eventName: 'REMOVE' as const,
      dynamodb: { OldImage: makeNewImage() },
    },
  ],
});

const dispatchBudgets = (cmd: { _kind: string; input: Record<string, unknown> }): unknown => {
  switch (cmd._kind) {
    case 'DescribeBudget': {
      const err = Object.assign(new Error('Budget not found'), {
        name: 'NotFoundException',
      });
      throw err;
    }
    case 'CreateBudget':
    case 'UpdateBudget':
    case 'DeleteBudget':
    case 'CreateBudgetAction':
    case 'UpdateBudgetAction':
    case 'DeleteBudgetAction':
      return {};
    case 'DescribeBudgetActionsForBudget':
      return { Actions: [] };
    default:
      throw new Error(`Unhandled budgets cmd: ${cmd._kind}`);
  }
};

const dispatchIam = (cmd: { _kind: string; input: Record<string, unknown> }): unknown => {
  switch (cmd._kind) {
    case 'CreatePolicy':
      return {
        Policy: {
          Arn: `arn:aws:iam::123456789012:policy/${cmd.input.PolicyName as string}`,
        },
      };
    case 'GetPolicy':
      return { Policy: { Arn: cmd.input.PolicyArn as string } };
    default:
      throw new Error(`Unhandled iam cmd: ${cmd._kind}`);
  }
};

beforeEach(() => {
  budgetsSendMock.mockReset();
  iamSendMock.mockReset();
  sdkCalls.length = 0;
  captured.length = 0;
  budgetsSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) =>
    Promise.resolve(dispatchBudgets(cmd)),
  );
  iamSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) =>
    Promise.resolve(dispatchIam(cmd)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('budgets-action-sync', () => {
  it('INSERT creates the policy, the budget, and the action', async () => {
    const handler = await importHandler();
    const out = await handler(insertEvent() as never);
    expect(out).toEqual({ processed: 1, failures: 0 });

    const kinds = sdkCalls.map((c) => `${c.client}:${c.kind}`);
    expect(kinds).toContain('budgets:DescribeBudget');
    expect(kinds).toContain('budgets:CreateBudget');
    expect(kinds).toContain('iam:CreatePolicy');
    expect(kinds).toContain('budgets:DescribeBudgetActionsForBudget');
    expect(kinds).toContain('budgets:CreateBudgetAction');

    // Policy name must use the bbg-deny-cur- prefix.
    const createPolicy = sdkCalls.find((c) => c.kind === 'CreatePolicy');
    expect(createPolicy).toBeDefined();
    expect(createPolicy!.input.PolicyName as string).toMatch(/^bbg-deny-cur-[0-9a-f]{12}-\d{4}-\d{2}$/);

    // CreateBudget must include the iamPrincipal cost-allocation tag and
    // a LinkedAccount filter scoped to this account.
    const createBudget = sdkCalls.find((c) => c.kind === 'CreateBudget');
    expect(createBudget).toBeDefined();
    const budget = (createBudget!.input.Budget as Record<string, unknown>) ?? {};
    const filters = budget.CostFilters as Record<string, string[]>;
    expect(filters.TagKeyValue?.[0]).toBe(`user:iamPrincipal$${PRINCIPAL}`);
    expect(filters.LinkedAccount?.[0]).toBe('123456789012');

    // CreateBudgetAction must reference the BudgetsActionRole.
    const createAction = sdkCalls.find((c) => c.kind === 'CreateBudgetAction');
    expect(createAction).toBeDefined();
    expect(createAction!.input.ExecutionRoleArn as string).toBe(
      process.env.BUDGETS_ACTION_ROLE_ARN,
    );
    expect(createAction!.input.ActionType as string).toBe('APPLY_IAM_POLICY');
    const def = createAction!.input.Definition as { IamActionDefinition: { Users?: string[]; PolicyArn: string } };
    expect(def.IamActionDefinition.PolicyArn).toMatch(/^arn:aws:iam::123456789012:policy\/bbg-deny-cur-/);
    expect(def.IamActionDefinition.Users).toEqual(['alice']);

    expect(captured.filter((m) => m.name === 'BudgetsActionSyncFailures')).toHaveLength(0);
  });

  it('MODIFY updates an existing budget', async () => {
    const handler = await importHandler();

    // DescribeBudget returns success → we call UpdateBudget instead of CreateBudget.
    budgetsSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) => {
      if (cmd._kind === 'DescribeBudget') return Promise.resolve({ Budget: { BudgetName: 'x' } });
      return Promise.resolve(dispatchBudgets(cmd));
    });

    const out = await handler(modifyEvent('100') as never);
    expect(out).toEqual({ processed: 1, failures: 0 });

    const kinds = sdkCalls.map((c) => `${c.client}:${c.kind}`);
    expect(kinds).toContain('budgets:UpdateBudget');
    expect(kinds).not.toContain('budgets:CreateBudget');

    const update = sdkCalls.find((c) => c.kind === 'UpdateBudget');
    const newBudget = (update!.input.NewBudget as Record<string, unknown>) ?? {};
    const limit = newBudget.BudgetLimit as { Amount: string; Unit: string };
    expect(limit.Amount).toBe('100');
    expect(limit.Unit).toBe('USD');
  });

  it('REMOVE deletes the budget action and budget', async () => {
    const handler = await importHandler();

    budgetsSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) => {
      if (cmd._kind === 'DescribeBudgetActionsForBudget') {
        return Promise.resolve({ Actions: [{ ActionId: 'aid-123' }] });
      }
      return Promise.resolve(dispatchBudgets(cmd));
    });

    const out = await handler(removeEvent() as never);
    expect(out).toEqual({ processed: 1, failures: 0 });

    const kinds = sdkCalls.map((c) => `${c.client}:${c.kind}`);
    expect(kinds).toContain('budgets:DeleteBudgetAction');
    expect(kinds).toContain('budgets:DeleteBudget');

    const delAction = sdkCalls.find((c) => c.kind === 'DeleteBudgetAction');
    expect(delAction!.input.ActionId as string).toBe('aid-123');
  });

  it('idempotent re-INSERT does not duplicate (CreatePolicy returns EntityAlreadyExists, action match found)', async () => {
    const handler = await importHandler();

    // CreatePolicy → already exists; GetPolicy returns existing ARN.
    iamSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) => {
      if (cmd._kind === 'CreatePolicy') {
        const err = Object.assign(new Error('Policy already exists'), {
          name: 'EntityAlreadyExistsException',
        });
        return Promise.reject(err);
      }
      if (cmd._kind === 'GetPolicy') {
        return Promise.resolve({ Policy: { Arn: cmd.input.PolicyArn as string } });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd._kind}`));
    });

    // DescribeBudget → exists. DescribeActions → finds matching action.
    budgetsSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) => {
      if (cmd._kind === 'DescribeBudget') return Promise.resolve({ Budget: { BudgetName: 'x' } });
      if (cmd._kind === 'DescribeBudgetActionsForBudget') {
        // The GetPolicy ARN observed during this run will be the
        // bbg-deny-cur-<hash>-<period> ARN derived deterministically by
        // the handler; build the same value here so the matching path
        // fires and we go through UpdateBudgetAction (NOT
        // CreateBudgetAction).
        return Promise.resolve({
          Actions: [
            {
              ActionId: 'aid-existing',
              Definition: {
                IamActionDefinition: {
                  // Match on prefix — the action's deterministic hash
                  // depends on the handler's internal SHA-1 digest.
                  PolicyArn:
                    'arn:aws:iam::123456789012:policy/bbg-deny-cur-PLACEHOLDER-2026-05',
                },
              },
            },
          ],
        });
      }
      return Promise.resolve(dispatchBudgets(cmd));
    });

    // First call to populate the deterministic policy ARN, then
    // re-mock DescribeBudgetActionsForBudget to return the same ARN.
    let knownArn: string | undefined;
    iamSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) => {
      if (cmd._kind === 'CreatePolicy') {
        knownArn = `arn:aws:iam::123456789012:policy/${cmd.input.PolicyName as string}`;
        const err = Object.assign(new Error('exists'), {
          name: 'EntityAlreadyExistsException',
        });
        return Promise.reject(err);
      }
      if (cmd._kind === 'GetPolicy') {
        return Promise.resolve({ Policy: { Arn: cmd.input.PolicyArn as string } });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd._kind}`));
    });

    budgetsSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) => {
      if (cmd._kind === 'DescribeBudget') return Promise.resolve({ Budget: { BudgetName: 'x' } });
      if (cmd._kind === 'DescribeBudgetActionsForBudget') {
        return Promise.resolve({
          Actions: [
            {
              ActionId: 'aid-existing',
              Definition: {
                IamActionDefinition: {
                  PolicyArn: knownArn ?? 'arn:aws:iam::123456789012:policy/bbg-deny-cur-x',
                },
              },
            },
          ],
        });
      }
      return Promise.resolve(dispatchBudgets(cmd));
    });

    const out = await handler(insertEvent() as never);
    expect(out).toEqual({ processed: 1, failures: 0 });

    const kinds = sdkCalls.map((c) => `${c.client}:${c.kind}`);
    // Idempotent path: no duplicate Create commands.
    expect(kinds).toContain('iam:CreatePolicy'); // attempted, but threw EntityAlreadyExistsException
    expect(kinds).toContain('iam:GetPolicy'); // recovered the existing ARN
    expect(kinds).toContain('budgets:UpdateBudget');
    expect(kinds).not.toContain('budgets:CreateBudget');
    expect(kinds).toContain('budgets:UpdateBudgetAction');
    expect(kinds).not.toContain('budgets:CreateBudgetAction');

    expect(captured.filter((m) => m.name === 'BudgetsActionSyncFailures')).toHaveLength(0);
  });

  it('emits BudgetsActionSyncFailures when CreateBudget fails', async () => {
    const handler = await importHandler();

    budgetsSendMock.mockImplementation((cmd: { _kind: string; input: Record<string, unknown> }) => {
      if (cmd._kind === 'DescribeBudget') {
        const err = Object.assign(new Error('Budget not found'), { name: 'NotFoundException' });
        return Promise.reject(err);
      }
      if (cmd._kind === 'CreateBudget') {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(dispatchBudgets(cmd));
    });

    const out = await handler(insertEvent() as never);
    expect(out).toEqual({ processed: 0, failures: 1 });

    const failureMetrics = captured.filter((m) => m.name === 'BudgetsActionSyncFailures');
    expect(failureMetrics).toHaveLength(1);
    expect(failureMetrics[0].value).toBe(1);
  });

  it('disabled budget triggers a remove path even on INSERT', async () => {
    const handler = await importHandler();

    const event = {
      Records: [
        {
          eventName: 'INSERT' as const,
          dynamodb: {
            NewImage: makeNewImage({ enabled: { BOOL: false } }),
          },
        },
      ],
    };

    const out = await handler(event as never);
    expect(out).toEqual({ processed: 1, failures: 0 });
    const kinds = sdkCalls.map((c) => `${c.client}:${c.kind}`);
    expect(kinds).toContain('budgets:DeleteBudget');
    expect(kinds).not.toContain('budgets:CreateBudget');
    expect(kinds).not.toContain('iam:CreatePolicy');
  });
});
