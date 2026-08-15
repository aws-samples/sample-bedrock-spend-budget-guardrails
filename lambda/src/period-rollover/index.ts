import {
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  ListEntitiesForPolicyCommand,
  ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb.js';
import { accountFromPolicyArn, iamForAccount } from '../shared/iam-cross-account.js';
import { Window, previousPeriodFor } from '../shared/period.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';
import { recordActivity } from '../shared/activity.js';

const RUNNING_SPEND_TABLE = process.env.RUNNING_SPEND_TABLE!;

interface SpendRow {
  principal: string;
  sk: string;
  enforcementPolicyArn?: string;
  period: string;
}

// Truncate ARNs / policy ARNs so they fit CloudWatch metric dimension limits
// (256 chars max) and don't cardinality-explode the metric. We keep the tail
// because the suffix (user/role name, deny-policy hash + period) is the most
// distinguishing portion.
const truncateForDimension = (value: string, max = 200): string =>
  value.length <= max ? value : `...${value.slice(-(max - 3))}`;

// Retry an IAM call with jittered exponential backoff. IAM throttling is the
// most-common cause of detach/delete failures during rollover and usually
// self-heals within a few hundred ms. We swallow the final error and let the
// caller emit a metric.
const RETRY_ATTEMPTS = 3;
const retryIam = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_ATTEMPTS) break;
      const baseMs = 100 * 2 ** (attempt - 1); // 100, 200, 400
      const jitter = Math.floor(Math.random() * baseMs);
      const delay = baseMs + jitter;
      logger.warn(`${label} failed; retrying`, {
        attempt,
        nextDelayMs: delay,
        err: (err as Error).message,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
};

const emitDetachFailure = (principal: string, err: Error): void => {
  logger.warn('detach failed after retries', { principal, err: err.message });
  // Dual-emit: one with the principal dimension for drill-down, plus a
  // rollup on the default (service=bbg) dimension so the
  // `bbg-period-rollover-detach-failure` alarm in observability-stack.ts
  // can fire on ANY failure across the population. CloudWatch metric
  // alarms reject SEARCH expressions so the rollup-emit pattern is the
  // only way to alarm across a high-cardinality dimension.
  metrics
    .singleMetric()
    .addDimension('principal', truncateForDimension(principal))
    .addMetric('PeriodRolloverDetachFailure', MetricUnit.Count, 1);
  metrics.addMetric('PeriodRolloverDetachFailure', MetricUnit.Count, 1);
};

const emitDeleteFailure = (policyArn: string, err: Error): void => {
  logger.warn('delete policy failed after retries', { policyArn, err: err.message });
  metrics
    .singleMetric()
    .addDimension('policyArn', truncateForDimension(policyArn))
    .addMetric('PeriodRolloverDeleteFailure', MetricUnit.Count, 1);
  metrics.addMetric('PeriodRolloverDeleteFailure', MetricUnit.Count, 1);
};

// Detach the deny policy from every entity and delete it. Returns `true` only
// when the deny was VERIFIABLY removed — every detach succeeded AND the policy
// was deleted. Returns `false` if any detach or the delete failed (a metric is
// emitted per failure). N1: the caller must NOT clear the spend row's
// enforcementPolicyArn stamp unless this returns `true`; clearing on a failed
// detach would leave the principal denied (policy still attached) with no
// record to redrive.
//
// Session-tag / federated principals ("stamped but never attached"): the deny
// policy was created + stamped but never physically attached to a user/role,
// so ListEntitiesForPolicy returns no entities → the detach loops are a no-op
// (allDetached stays true) → the policy is deleted → this returns `true` and
// the caller safely clears the (dangling) stamp. No failed detach on a
// non-attached policy.
const detachAndDelete = async (policyArn: string): Promise<boolean> => {
  // target the policy's home account. For customer-managed deny
  // policies the account is encoded in the ARN.
  const policyAccount = accountFromPolicyArn(policyArn);
  const iam = await iamForAccount(policyAccount);

  let allDetached = true;

  // 1. Detach from every entity that currently has it attached. A failure on
  //    one principal must not stop the rest — we emit a metric and continue,
  //    but a single failure means the deny is NOT fully removed.
  const entities = await iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: policyArn }));
  for (const u of entities.PolicyUsers ?? []) {
    if (!u.UserName) continue;
    try {
      await retryIam(`detach user ${u.UserName}`, () =>
        iam.send(new DetachUserPolicyCommand({ UserName: u.UserName, PolicyArn: policyArn })),
      );
    } catch (err) {
      emitDetachFailure(`user/${u.UserName}`, err as Error);
      allDetached = false;
    }
  }
  for (const r of entities.PolicyRoles ?? []) {
    if (!r.RoleName) continue;
    try {
      await retryIam(`detach role ${r.RoleName}`, () =>
        iam.send(new DetachRolePolicyCommand({ RoleName: r.RoleName, PolicyArn: policyArn })),
      );
    } catch (err) {
      emitDetachFailure(`role/${r.RoleName}`, err as Error);
      allDetached = false;
    }
  }

  // If any detach failed the deny is still (partially) attached — do NOT delete
  // the policy (deleting an attached policy fails anyway) and report failure so
  // the caller keeps the stamp for a later redrive.
  if (!allDetached) return false;

  // 2. Delete non-default versions, then the policy itself.
  const versions = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
  for (const v of versions.Versions ?? []) {
    if (v.IsDefaultVersion) continue;
    if (v.VersionId) {
      await iam
        .send(new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: v.VersionId }))
        .catch(() => undefined);
    }
  }
  try {
    await retryIam(`delete policy ${policyArn}`, () =>
      iam.send(new DeletePolicyCommand({ PolicyArn: policyArn })),
    );
  } catch (err) {
    emitDeleteFailure(policyArn, err as Error);
    return false;
  }
  return true;
};

export const handler = async (
  event: { period?: string; window?: Window } = {},
): Promise<{ rolledOver: number }> => {
  // `period` overrides everything (operator-driven manual rollover of a
  // specific period). Otherwise we derive the previous period for the
  // given window kind. Default window is `monthly` so the existing
  // monthly EventBridge Schedule keeps invoking us with no payload.
  const window: Window = event.window ?? 'monthly';
  const target = event.period ?? previousPeriodFor(window);
  logger.info('period-rollover starting', { period: target, window });

  let rolledOver = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: RUNNING_SPEND_TABLE,
        IndexName: 'byPeriod',
        KeyConditionExpression: 'period = :p',
        ExpressionAttributeValues: { ':p': target },
        ExclusiveStartKey: cursor,
      }),
    );

    for (const item of (r.Items ?? []) as SpendRow[]) {
      // N1: only clear the enforcement stamp when the deny was VERIFIABLY
      // removed. `removed` stays false on any detach/delete failure OR an
      // unexpected error (e.g. ListEntitiesForPolicy), so the row keeps its
      // enforcementPolicyArn and the PeriodRolloverDetachFailure alarm carries
      // it for a manual/next-run redrive — instead of wiping the only record
      // of a still-attached deny and leaving the principal permanently denied.
      let removed = false;
      if (item.enforcementPolicyArn) {
        try {
          removed = await detachAndDelete(item.enforcementPolicyArn);
          if (removed) {
            metrics.addMetric('EnforcementRolledBack', MetricUnit.Count, 1);
            await recordActivity({
              principal: item.principal,
              type: 'enforcement.rolled_over',
              summary: `Enforcement released at period rollover (${target})`,
              detail: { period: target, policyArn: item.enforcementPolicyArn },
            });
          }
        } catch (err) {
          // Unexpected error (detachAndDelete handles per-call IAM failures
          // internally and returns false). Emit a detach-failure metric so
          // visibility is preserved; leave `removed` false so we keep the stamp.
          emitDetachFailure(item.principal, err as Error);
        }
      }
      // Do NOT delete the row. The next period already starts from zero
      // because every period is a distinct item (SK is
      // `period#<period>#target#...`), so leaving the closed period's row in
      // place can't leak spend forward. Deleting it instead destroyed the
      // historical record the SPA period selector reads back — operators
      // expect to look at last month's spend after rollover. We only clear
      // the enforcement stamp (the policy is detached/deleted above) so the
      // closed-period row no longer reports as actively enforced, then leave
      // the spend totals intact for as long as the row is retained.
      if (item.enforcementPolicyArn && removed) {
        // Release-latch: only clear the stamp if it STILL points at the ARN we
        // just removed. If a concurrent enforcement re-stamped a fresh ARN
        // between our Query and this write (a new breach in the closed period),
        // the ConditionExpression fails and we leave the new stamp untouched
        // rather than blindly wiping an active deny.
        await ddb
          .send(
            new UpdateCommand({
              TableName: RUNNING_SPEND_TABLE,
              Key: { principal: item.principal, sk: item.sk },
              UpdateExpression:
                'REMOVE enforcementPolicyArn, enforcementReason, enforcementMetric',
              ConditionExpression: 'enforcementPolicyArn = :arn',
              ExpressionAttributeValues: { ':arn': item.enforcementPolicyArn },
            }),
          )
          .catch((err) => {
            if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
              logger.info('stamp changed since query — leaving re-enforcement in place', {
                principal: item.principal,
                sk: item.sk,
              });
              return undefined;
            }
            throw err;
          });
      }
      rolledOver++;
    }
    cursor = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);

  metrics.publishStoredMetrics();
  logger.info('period-rollover complete', { period: target, window, rolledOver });
  return { rolledOver };
};
