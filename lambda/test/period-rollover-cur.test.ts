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

/**
 * Period-rollover dual-channel coverage. The rollover Lambda iterates
 * `RunningSpend` rows and detaches whatever IAM policy is stamped on
 * `enforcementPolicyArn`. With we now have TWO naming conventions
 * a row's stamp can carry:
 *
 *   - `bbg-deny-<hash>-<period>`     (real-time channel — primary)
 *   - `bbg-deny-cur-<hash>-<period>` (CUR + Budgets channel — opt-in)
 *
 * Both prefixes are covered by the IAM scope guardrail
 * `iam:PolicyARN ArnEquals bbg-deny-*`. The rollover detach loop
 * doesn't care about the prefix — it only reads `enforcementPolicyArn`
 * straight off the row — but the test below pins the behavior
 * explicitly so a future change that *adds prefix-dependent logic*
 * can't quietly drop one of the two channels.
 */

process.env.RUNNING_SPEND_TABLE = 'test-running-spend';
// AWS_ACCOUNT_ID matches the test policy ARNs' home account so the
// cross-account helper short-circuits to the in-process IAMClient
// (mocked here) instead of attempting an AssumeRole.
process.env.AWS_ACCOUNT_ID = '123456789012';

const iamMock = mockClient(IAMClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const importHandler = async () => (await import('../src/period-rollover')).handler;

const RT_POLICY_ARN = 'arn:aws:iam::123456789012:policy/bbg-deny-aaa111bbb222-2026-04';
const CUR_POLICY_ARN = 'arn:aws:iam::123456789012:policy/bbg-deny-cur-ccc333ddd444-2026-04';

beforeEach(() => {
  iamMock.reset();
  ddbMock.reset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('period-rollover dual-channel detach', () => {
  it('detaches both bbg-deny-* and bbg-deny-cur-* policies in a single rollover pass', async () => {
    const handler = await importHandler();

    // Two rows: one stamped with the real-time channel's policy, one
    // with the CUR channel's policy.
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          principal: 'principal#arn:aws:iam::123456789012:user/alice',
          sk: 'enf-rt',
          enforcementPolicyArn: RT_POLICY_ARN,
          period: '2026-04',
        },
        {
          principal: 'principal#arn:aws:iam::123456789012:user/bob',
          sk: 'enf-cur',
          enforcementPolicyArn: CUR_POLICY_ARN,
          period: '2026-04',
        },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});

    iamMock.on(ListEntitiesForPolicyCommand).callsFake((input) => {
      // Each policy has its own attached user.
      if (input.PolicyArn === RT_POLICY_ARN) {
        return Promise.resolve({ PolicyUsers: [{ UserName: 'alice' }], PolicyRoles: [] });
      }
      if (input.PolicyArn === CUR_POLICY_ARN) {
        return Promise.resolve({ PolicyUsers: [{ UserName: 'bob' }], PolicyRoles: [] });
      }
      return Promise.resolve({ PolicyUsers: [], PolicyRoles: [] });
    });
    iamMock.on(DetachUserPolicyCommand).resolves({});
    iamMock.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iamMock.on(DeletePolicyVersionCommand).resolves({});
    iamMock.on(DeletePolicyCommand).resolves({});

    const out = await handler({ period: '2026-04' });
    expect(out).toEqual({ rolledOver: 2 });

    // Detach must have been called for BOTH policies.
    const detachCalls = iamMock.commandCalls(DetachUserPolicyCommand);
    const detachedPolicyArns = detachCalls.map((c) => c.args[0].input.PolicyArn);
    expect(detachedPolicyArns).toContain(RT_POLICY_ARN);
    expect(detachedPolicyArns).toContain(CUR_POLICY_ARN);

    // Delete must have been called for BOTH policies too.
    const deleteCalls = iamMock.commandCalls(DeletePolicyCommand);
    const deletedPolicyArns = deleteCalls.map((c) => c.args[0].input.PolicyArn);
    expect(deletedPolicyArns).toContain(RT_POLICY_ARN);
    expect(deletedPolicyArns).toContain(CUR_POLICY_ARN);

    // Both spend rows are PRESERVED (not deleted) — the next period starts
    // from zero on its own because every period is a distinct SK. Rollover
    // only clears the enforcement stamp via an UpdateCommand REMOVE so the
    // closed-period row stops reporting as actively enforced while its spend
    // history stays readable in the SPA. Both rows carried an
    // enforcementPolicyArn, so both get one UpdateCommand.
    const ddbUpdates = ddbMock.commandCalls(UpdateCommand);
    expect(ddbUpdates).toHaveLength(2);
    for (const call of ddbUpdates) {
      expect(call.args[0].input.UpdateExpression).toMatch(/REMOVE enforcementPolicyArn/);
    }
  }, 10_000);
});
