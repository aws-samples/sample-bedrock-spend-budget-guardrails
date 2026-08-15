import {
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DetachUserPolicyCommand,
  IAMClient,
  ListEntitiesForPolicyCommand,
  ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env before importing the handler — index.ts reads RUNNING_SPEND_TABLE
// at module-load time. AWS_ACCOUNT_ID matches the test policy ARN's home
// account so the cross-account helper short-circuits to the in-process
// IAMClient (which the test mocks) instead of attempting an AssumeRole.
process.env.RUNNING_SPEND_TABLE = 'test-running-spend';
process.env.AWS_ACCOUNT_ID = '123456789012';

const iamMock = mockClient(IAMClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// Singleton-import after env is set. Each test resets the SDK mocks; the
// metrics instance is a powertools singleton so we spy on it per-test.
const importHandler = async () => (await import('../src/period-rollover')).handler;

const POLICY_ARN = 'arn:aws:iam::123456789012:policy/bbg-deny-abc123def456-2026-04';
const PRINCIPAL = 'principal#arn:aws:iam::123456789012:user/alice';

beforeEach(() => {
  iamMock.reset();
  ddbMock.reset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('period-rollover detach failure path', () => {
  it('retries detach 3x and emits PeriodRolloverDetachFailure metric on persistent AccessDenied', async () => {
    const handler = await importHandler();

    // ddb.send: one Query page (one row), then a Delete (no-op response).
    ddbMock.on(QueryCommand).resolves({
      Items: [{ principal: PRINCIPAL, sk: 'enf', enforcementPolicyArn: POLICY_ARN, period: '2026-04' }],
    });
    ddbMock.on(UpdateCommand).resolves({});

    // IAM: ListEntitiesForPolicy returns one user.
    iamMock.on(ListEntitiesForPolicyCommand).resolves({
      PolicyUsers: [{ UserName: 'alice' }],
      PolicyRoles: [],
    });

    // DetachUserPolicy: always throw AccessDenied — should be retried 3x.
    const accessDenied = Object.assign(new Error('User is not authorized'), {
      name: 'AccessDeniedException',
    });
    iamMock.on(DetachUserPolicyCommand).rejects(accessDenied);

    iamMock.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iamMock.on(DeletePolicyVersionCommand).resolves({});
    iamMock.on(DeletePolicyCommand).resolves({});

    // Capture metric emissions. period-rollover uses
    // metrics.singleMetric().addDimension(...).addMetric(...) for failure
    // metrics, so we spy on the shared metrics singleton's singleMetric().
    const { metrics } = await import('../src/shared/powertools');
    const addMetricCalls: Array<[string, string, number]> = [];
    const addDimensionCalls: Array<[string, string]> = [];
    const fakeSingle = {
      addDimension(name: string, value: string) {
        addDimensionCalls.push([name, value]);
        return this;
      },
      addMetric(name: string, _unit: unknown, value: number) {
        addMetricCalls.push([name, addDimensionCalls.at(-1)?.[0] ?? '', value]);
        return this;
      },
    };
    const singleSpy = vi.spyOn(metrics, 'singleMetric').mockReturnValue(fakeSingle as never);
    const publishSpy = vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => {});

    const result = await handler({ period: '2026-04' });

    // The row was processed (deleted) even though detach failed.
    expect(result).toEqual({ rolledOver: 1 });

    // DetachUserPolicy was attempted 3x (initial + 2 retries).
    const detachCalls = iamMock.commandCalls(DetachUserPolicyCommand);
    expect(detachCalls).toHaveLength(3);

    // Exactly one failure metric was emitted, with principal dimension.
    const failureMetrics = addMetricCalls.filter(
      ([name]) => name === 'PeriodRolloverDetachFailure',
    );
    expect(failureMetrics).toHaveLength(1);
    expect(failureMetrics[0][2]).toBe(1);
    expect(addDimensionCalls).toContainEqual(['principal', 'user/alice']);

    expect(singleSpy).toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalled();
  }, 10_000);

  it('emits PeriodRolloverDeleteFailure when detach succeeds but DeletePolicy fails', async () => {
    const handler = await importHandler();

    ddbMock.on(QueryCommand).resolves({
      Items: [{ principal: PRINCIPAL, sk: 'enf', enforcementPolicyArn: POLICY_ARN, period: '2026-04' }],
    });
    ddbMock.on(UpdateCommand).resolves({});

    iamMock.on(ListEntitiesForPolicyCommand).resolves({
      PolicyUsers: [{ UserName: 'alice' }],
      PolicyRoles: [],
    });
    // DetachUserPolicy succeeds first try.
    iamMock.on(DetachUserPolicyCommand).resolves({});
    iamMock.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    // DeletePolicy fails persistently — entities still attached, throttle, etc.
    const stillAttached = Object.assign(
      new Error('Cannot delete a policy attached to entities'),
      { name: 'DeleteConflictException' },
    );
    iamMock.on(DeletePolicyCommand).rejects(stillAttached);

    const { metrics } = await import('../src/shared/powertools');
    const addMetricCalls: Array<[string, string, number]> = [];
    const addDimensionCalls: Array<[string, string]> = [];
    const fakeSingle = {
      addDimension(name: string, value: string) {
        addDimensionCalls.push([name, value]);
        return this;
      },
      addMetric(name: string, _unit: unknown, value: number) {
        addMetricCalls.push([name, addDimensionCalls.at(-1)?.[0] ?? '', value]);
        return this;
      },
    };
    vi.spyOn(metrics, 'singleMetric').mockReturnValue(fakeSingle as never);
    vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => {});

    const result = await handler({ period: '2026-04' });
    expect(result).toEqual({ rolledOver: 1 });

    // Detach succeeded once (no retries).
    expect(iamMock.commandCalls(DetachUserPolicyCommand)).toHaveLength(1);
    // DeletePolicy was tried 3x (initial + 2 retries).
    expect(iamMock.commandCalls(DeletePolicyCommand)).toHaveLength(3);

    const deleteMetrics = addMetricCalls.filter(
      ([name]) => name === 'PeriodRolloverDeleteFailure',
    );
    expect(deleteMetrics).toHaveLength(1);
    expect(deleteMetrics[0][2]).toBe(1);
    expect(addDimensionCalls.some(([k]) => k === 'policyArn')).toBe(true);

    // No detach failure metric was emitted.
    const detachMetrics = addMetricCalls.filter(
      ([name]) => name === 'PeriodRolloverDetachFailure',
    );
    expect(detachMetrics).toHaveLength(0);
  }, 10_000);
});

// N1: the enforcement stamp (enforcementPolicyArn) must be cleared ONLY when
// the deny was verifiably removed. Clearing it on a failed detach would leave
// the principal denied (policy still attached) with no record to redrive.
describe('period-rollover N1 stamp-clear contract', () => {
  const stampClearUpdates = () =>
    ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) =>
        String((c.args[0].input as { UpdateExpression?: string }).UpdateExpression).startsWith(
          'REMOVE enforcementPolicyArn',
        ),
      );

  it('does NOT clear the stamp when a detach fails (row keeps enforcementPolicyArn)', async () => {
    const handler = await importHandler();
    ddbMock.on(QueryCommand).resolves({
      Items: [{ principal: PRINCIPAL, sk: 'enf', enforcementPolicyArn: POLICY_ARN, period: '2026-04' }],
    });
    ddbMock.on(UpdateCommand).resolves({});
    iamMock.on(ListEntitiesForPolicyCommand).resolves({ PolicyUsers: [{ UserName: 'alice' }], PolicyRoles: [] });
    iamMock.on(DetachUserPolicyCommand).rejects(
      Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }),
    );
    iamMock.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iamMock.on(DeletePolicyCommand).resolves({});

    const { metrics } = await import('../src/shared/powertools');
    vi.spyOn(metrics, 'singleMetric').mockReturnValue({
      addDimension() { return this; },
      addMetric() { return this; },
    } as never);
    vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => {});

    await handler({ period: '2026-04' });

    // The stamp-clearing REMOVE must NOT have run (detach failed).
    expect(stampClearUpdates()).toHaveLength(0);
    // And a failed detach must never delete the (still-attached) policy.
    expect(iamMock.commandCalls(DeletePolicyCommand)).toHaveLength(0);
  }, 10_000);

  it('clears the stamp (guarded by the current ARN) when detach+delete succeed', async () => {
    const handler = await importHandler();
    ddbMock.on(QueryCommand).resolves({
      Items: [{ principal: PRINCIPAL, sk: 'enf', enforcementPolicyArn: POLICY_ARN, period: '2026-04' }],
    });
    ddbMock.on(UpdateCommand).resolves({});
    iamMock.on(ListEntitiesForPolicyCommand).resolves({ PolicyUsers: [{ UserName: 'alice' }], PolicyRoles: [] });
    iamMock.on(DetachUserPolicyCommand).resolves({});
    iamMock.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iamMock.on(DeletePolicyCommand).resolves({});

    const { metrics } = await import('../src/shared/powertools');
    vi.spyOn(metrics, 'singleMetric').mockReturnValue({
      addDimension() { return this; },
      addMetric() { return this; },
    } as never);
    vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => {});

    await handler({ period: '2026-04' });

    const clears = stampClearUpdates();
    expect(clears).toHaveLength(1);
    // Release-latch: the clear is conditional on the stamp still pointing at
    // the ARN we removed, so a concurrent re-enforcement isn't clobbered.
    const input = clears[0].args[0].input as {
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.ConditionExpression).toBe('enforcementPolicyArn = :arn');
    expect(input.ExpressionAttributeValues?.[':arn']).toBe(POLICY_ARN);
  }, 10_000);

  it('session-tag "stamped but never attached": deletes policy and clears stamp with no detach failure', async () => {
    const handler = await importHandler();
    ddbMock.on(QueryCommand).resolves({
      Items: [{ principal: PRINCIPAL, sk: 'enf', enforcementPolicyArn: POLICY_ARN, period: '2026-04' }],
    });
    ddbMock.on(UpdateCommand).resolves({});
    // No entities: the deny was enforced via a policy Condition, never attached.
    iamMock.on(ListEntitiesForPolicyCommand).resolves({ PolicyUsers: [], PolicyRoles: [] });
    iamMock.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iamMock.on(DeletePolicyCommand).resolves({});

    const { metrics } = await import('../src/shared/powertools');
    const seen: string[] = [];
    vi.spyOn(metrics, 'singleMetric').mockReturnValue({
      addDimension() { return this; },
      addMetric(name: string) { seen.push(name); return this; },
    } as never);
    vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => {});

    await handler({ period: '2026-04' });

    // Policy deleted, stamp cleared, and no detach was attempted or failed.
    expect(iamMock.commandCalls(DeletePolicyCommand)).toHaveLength(1);
    expect(iamMock.commandCalls(DetachUserPolicyCommand)).toHaveLength(0);
    expect(stampClearUpdates()).toHaveLength(1);
    expect(seen).not.toContain('PeriodRolloverDetachFailure');
  }, 10_000);
});
