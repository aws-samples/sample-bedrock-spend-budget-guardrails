import {
  BudgetsClient,
  CreateBudgetActionCommand,
  CreateBudgetCommand,
  DeleteBudgetActionCommand,
  DeleteBudgetCommand,
  DescribeBudgetActionsForBudgetCommand,
  DescribeBudgetCommand,
  UpdateBudgetActionCommand,
  UpdateBudgetCommand,
} from '@aws-sdk/client-budgets';
import {
  CreatePolicyCommand,
  GetPolicyCommand,
  IAMClient,
} from '@aws-sdk/client-iam';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { ddb } from '../shared/ddb.js';
import { buildDenyPolicy } from '../shared/policies.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';
import { getConfiguredMemoryMb, recordSelfCost } from '../shared/self-cost.js';
import {
  Threshold,
  blockThreshold,
  resolveThresholds,
} from '../shared/thresholds.js';
import { isDefaultsRow } from '../shared/defaults.js';
import { curBudgetName, curDenyPolicyName } from './naming.js';

/**
 * budgets-action-sync — DDB stream consumer for the `Budgets` table.
 *
 * Mirrors every operator-managed budget row to a matching native AWS
 * `Budget` + `BudgetAction` (type IAM) so AWS Budgets fires its own
 * enforcement on the CUR cadence (~24h trailing). This is the secondary
 * channel: the real-time DDB-stream-driven enforcement Lambda
 * (`enforcement/`) remains primary and uses a *different* policy
 * namespace (`bbg-deny-`) — this Lambda creates `bbg-deny-cur-` policies
 * so the two channels never race for the same IAM policy.
 */

const STAGE_PREFIX = process.env.STAGE_PREFIX!;
const INFERENCE_PROFILES_TABLE = process.env.INFERENCE_PROFILES_TABLE!;
const BUDGETS_ACTION_ROLE_ARN = process.env.BUDGETS_ACTION_ROLE_ARN!;
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID!;
/** SES-verified or noreply email for the Budgets-Action subscriber list.
 *  Required by AWS Budgets — the action notifies subscribers when it fires. */
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL ?? '';

const budgets = new BudgetsClient({});
const iam = new IAMClient({});

interface BudgetRow {
  principal: string;
  target: string;
  limitUsd: number;
  action: 'deny' | 'alert';
  thresholds?: Threshold[];
  unlimited?: boolean;
  enabled: boolean;
  condition?: { tagKey?: string; tagValue?: string };
}

const profilesForModel = async (target: string): Promise<string[]> => {
  if (!target.startsWith('model#') || target === 'model#*') return [];
  const modelId = target.slice('model#'.length);
  const r = await ddb
    .send(
      new QueryCommand({
        TableName: INFERENCE_PROFILES_TABLE,
        IndexName: 'byModel',
        KeyConditionExpression: 'modelId = :m',
        ExpressionAttributeValues: { ':m': modelId },
      }),
    )
    .catch(() => undefined);
  if (!r?.Items) return [];
  return r.Items.map((it) => it.profileArn as string).filter(Boolean);
};

/**
 * Idempotent CreatePolicy. Catches `EntityAlreadyExistsException` and
 * returns the existing policy ARN via `GetPolicy`.
 */
const ensureDenyPolicy = async (
  policyName: string,
  document: object,
): Promise<string> => {
  const expectedArn = `arn:aws:iam::${ACCOUNT_ID}:policy/${policyName}`;
  try {
    await iam.send(
      new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(document),
        Description:
          'BBG generated deny policy — attached by AWS Budgets when the CUR-driven budget threshold is breached. Parallel to the real-time bbg-deny-* path; uses bbg-deny-cur- prefix to avoid namespace collisions.',
      }),
    );
    return expectedArn;
  } catch (err) {
    if ((err as { name?: string }).name === 'EntityAlreadyExistsException') {
      const r = await iam.send(new GetPolicyCommand({ PolicyArn: expectedArn }));
      return r.Policy?.Arn ?? expectedArn;
    }
    throw err;
  }
};

/**
 * Builds the Budgets `CostFilters` map for one (principal, target) pair.
 * `iamPrincipal` cost-allocation tag must be activated in the Billing
 * console (see `docs/cur-reconciliation.md`). `LinkedAccount` keeps the
 * filter scoped to this account when the export aggregates an
 * Organization.
 */
const costFiltersFor = (principal: string): Record<string, string[]> => ({
  TagKeyValue: [`user:iamPrincipal$${principal}`],
  LinkedAccount: [ACCOUNT_ID],
  Service: [
    'Amazon Bedrock',
    'AmazonBedrockFoundationModels',
    'AmazonBedrockService',
  ],
});

const upsertBudget = async (row: BudgetRow): Promise<void> => {
  const budgetName = curBudgetName(row.principal, row.target);
  const desired = {
    BudgetName: budgetName,
    BudgetLimit: { Amount: String(row.limitUsd), Unit: 'USD' },
    BudgetType: 'COST' as const,
    TimeUnit: 'MONTHLY' as const,
    CostFilters: costFiltersFor(row.principal),
    CostTypes: {
      IncludeCredit: false,
      IncludeDiscount: true,
      IncludeOtherSubscription: true,
      IncludeRecurring: true,
      IncludeRefund: false,
      IncludeSubscription: true,
      IncludeSupport: false,
      IncludeTax: false,
      IncludeUpfront: true,
      UseAmortized: false,
      UseBlended: false,
    },
  };

  let exists = false;
  try {
    await budgets.send(
      new DescribeBudgetCommand({ AccountId: ACCOUNT_ID, BudgetName: budgetName }),
    );
    exists = true;
  } catch (err) {
    if ((err as { name?: string }).name !== 'NotFoundException') throw err;
  }

  if (exists) {
    await budgets.send(
      new UpdateBudgetCommand({ AccountId: ACCOUNT_ID, NewBudget: desired }),
    );
  } else {
    await budgets.send(
      new CreateBudgetCommand({ AccountId: ACCOUNT_ID, Budget: desired }),
    );
  }
};

const upsertBudgetAction = async (row: BudgetRow): Promise<void> => {
  const blockTh = blockThreshold(resolveThresholds(row));
  if (!blockTh) {
    // Alert-only budgets (no `block` threshold) don't need a Budgets
    // Action — the threshold notification on the Budget itself is
    // sufficient. We still keep the Budget object so operators see a
    // unified view.
    return;
  }

  const budgetName = curBudgetName(row.principal, row.target);
  const profiles = await profilesForModel(row.target);
  const policyDoc = buildDenyPolicy({
    target: row.target,
    associatedProfileArns: profiles,
    sessionTagKey: row.condition?.tagKey,
    sessionTagValue: row.condition?.tagValue,
  });
  const policyName = curDenyPolicyName(row.principal, row.target);
  const policyArn = await ensureDenyPolicy(policyName, policyDoc);

  const subscribers = NOTIFY_EMAIL
    ? [{ SubscriptionType: 'EMAIL' as const, Address: NOTIFY_EMAIL }]
    : [];
  if (subscribers.length === 0) {
    logger.warn(
      'NOTIFY_EMAIL not configured — Budget Action will be created without subscribers, which AWS Budgets rejects. Set bbg:notifySenderAddress in operator-config.',
      { budgetName },
    );
  }

  // AWS Budgets has no DescribeBudgetAction-by-name API; we list all
  // actions for the budget and look for one whose IAM policy ARN matches
  // ours. If found, UpdateBudgetAction; else CreateBudgetAction. This is
  // the canonical idempotency pattern for Budget Actions.
  const existing = await budgets.send(
    new DescribeBudgetActionsForBudgetCommand({
      AccountId: ACCOUNT_ID,
      BudgetName: budgetName,
    }),
  );
  const match = (existing.Actions ?? []).find(
    (a) => a.Definition?.IamActionDefinition?.PolicyArn === policyArn,
  );

  const principalToAttach = row.principal.replace(/^principal#(agent-role#)?/, '');
  const isUser = /^arn:aws:iam::\d+:user\//.test(principalToAttach);
  const isRole = /^arn:aws:iam::\d+:role\//.test(principalToAttach);
  if (!isUser && !isRole) {
    // Federated / SAML / agent-service principals are gated by the policy's
    // Condition block in the real-time channel. Budgets Actions can't
    // attach to them, so skip the action — the Budget itself still
    // notifies the subscriber.
    logger.info('Principal not directly attachable; skipping Budget Action', {
      principal: row.principal,
    });
    return;
  }

  const attachTarget = isUser
    ? { Users: [principalToAttach.split('/').slice(1).join('/')] }
    : { Roles: [principalToAttach.split('/').slice(1).join('/')] };

  const definition = {
    IamActionDefinition: {
      PolicyArn: policyArn,
      ...attachTarget,
    },
  };

  const common = {
    AccountId: ACCOUNT_ID,
    BudgetName: budgetName,
    NotificationType: 'ACTUAL' as const,
    ActionType: 'APPLY_IAM_POLICY' as const,
    ActionThreshold: { ActionThresholdValue: blockTh.at, ActionThresholdType: 'PERCENTAGE' as const },
    ApprovalModel: 'AUTOMATIC' as const,
    ExecutionRoleArn: BUDGETS_ACTION_ROLE_ARN,
    Definition: definition,
    Subscribers: subscribers,
  };

  if (match?.ActionId) {
    await budgets.send(
      new UpdateBudgetActionCommand({
        AccountId: ACCOUNT_ID,
        BudgetName: budgetName,
        ActionId: match.ActionId,
        NotificationType: common.NotificationType,
        ActionThreshold: common.ActionThreshold,
        ApprovalModel: common.ApprovalModel,
        ExecutionRoleArn: common.ExecutionRoleArn,
        Definition: common.Definition,
        Subscribers: common.Subscribers,
      }),
    );
  } else {
    await budgets.send(new CreateBudgetActionCommand(common));
  }
};

const removeBudget = async (row: BudgetRow): Promise<void> => {
  const budgetName = curBudgetName(row.principal, row.target);
  // Delete every action attached to the budget first; Budgets rejects
  // DeleteBudget while actions still exist.
  try {
    const r = await budgets.send(
      new DescribeBudgetActionsForBudgetCommand({
        AccountId: ACCOUNT_ID,
        BudgetName: budgetName,
      }),
    );
    for (const a of r.Actions ?? []) {
      if (!a.ActionId) continue;
      await budgets
        .send(
          new DeleteBudgetActionCommand({
            AccountId: ACCOUNT_ID,
            BudgetName: budgetName,
            ActionId: a.ActionId,
          }),
        )
        .catch((err) => {
          if ((err as { name?: string }).name !== 'NotFoundException') throw err;
        });
    }
  } catch (err) {
    if ((err as { name?: string }).name !== 'NotFoundException') throw err;
  }
  await budgets
    .send(new DeleteBudgetCommand({ AccountId: ACCOUNT_ID, BudgetName: budgetName }))
    .catch((err) => {
      if ((err as { name?: string }).name !== 'NotFoundException') throw err;
    });
  // Note: we intentionally do NOT delete the bbg-deny-cur-* IAM policy
  // here. period-rollover handles that at the month boundary so any
  // partially-attached policy is detached + deleted in one place.
};

const handleRecord = async (record: DynamoDBRecord): Promise<void> => {
  if (record.eventName === 'REMOVE') {
    const old = record.dynamodb?.OldImage;
    if (!old) return;
    const row = unmarshall(old as Record<string, never>) as BudgetRow;
    if (isDefaultsRow(row)) return;
    await removeBudget(row);
    return;
  }

  // INSERT / MODIFY: read NewImage and upsert.
  const next = record.dynamodb?.NewImage;
  if (!next) return;
  const row = unmarshall(next as Record<string, never>) as BudgetRow;

  // The defaults sentinel row is config-only; it must never be
  // mirrored to AWS Budgets.
  if (isDefaultsRow(row)) return;

  // Unlimited budgets explicitly opt out of the parallel CUR-based
  // enforcement channel — same as the real-time channel.
  if (row.unlimited) {
    await removeBudget(row);
    return;
  }

  if (!row.enabled) {
    // A disabled budget should not enforce — remove any prior Budget +
    // Action so AWS Budgets doesn't fire on stale data.
    await removeBudget(row);
    return;
  }

  await upsertBudget(row);
  await upsertBudgetAction(row);
};

export const handler = async (
  event: DynamoDBStreamEvent,
): Promise<{ processed: number; failures: number }> => {
  const startedAt = Date.now();
  let processed = 0;
  let failures = 0;
  for (const record of event.Records) {
    try {
      await handleRecord(record);
      processed++;
    } catch (err) {
      failures++;
      logger.error('budgets-action-sync record failed', {
        eventName: record.eventName,
        err: (err as Error).message,
      });
      metrics.addMetric('BudgetsActionSyncFailures', MetricUnit.Count, 1);
    }
  }

  recordSelfCost(
    'budgets-action-sync',
    Date.now() - startedAt,
    getConfiguredMemoryMb(),
    {
      // One IAM-profile lookup per record at most; no DDB writes (the
      // Budget objects live in the AWS Budgets service, not in DDB).
      ddbReads: event.Records.length,
      ddbWrites: 0,
    },
  );
  metrics.publishStoredMetrics();
  // Suppress unused warning on STAGE_PREFIX (kept for future structured
  // logging dimensions).
  void STAGE_PREFIX;
  return { processed, failures };
};
