import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BbgNodejsFunction } from './constructs/nodejs-fn.js';
import type { DataStack } from './data-stack.js';

export interface BudgetsActionStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly data: DataStack;
}

/**
 * Opt-in (`bbg:enableBudgetsAction=true`) parallel enforcement channel.
 *
 * Defense-in-depth: the real-time meter remains the primary signal for
 * stopping runaway spend. AWS Budgets fires on the CUR cadence (~24h
 * trailing) so it is too slow to be primary, but it is a useful
 * fail-closed safety net if the meter is degraded.
 *
 * What this stack creates:
 *
 *   1. **`BudgetsActionRole`** — assumed by `budgets.amazonaws.com`. AWS
 *      Budgets uses this role to attach the `bbg-deny-cur-*` policy when
 *      a budget threshold is breached. Trust is restricted to the BBG
 *      account; permissions scope `iam:Attach{User,Role}Policy` to the
 *      `bbg-deny-cur-*` namespace via an `iam:PolicyARN` ArnEquals
 *      condition.
 *   2. **`budgets-action-sync` Lambda** — DDB-stream-driven mirror of
 *      the operator-managed `Budgets` table → AWS Budgets +
 *      `BudgetsAction` (type IAM). Idempotent create/update/delete.
 *
 * The two enforcement channels coexist because they use distinct IAM
 * policy prefixes:
 *
 *   - real-time:    `bbg-deny-<hash>-<period>`
 *   - cur+budgets:  `bbg-deny-cur-<hash>-<period>`
 *
 * Both are caught by the shared `bbg-deny-*` ArnEquals guardrail and
 * both are detached + deleted by `period-rollover` at month end.
 */
export class BudgetsActionStack extends cdk.Stack {
  readonly sync: BbgNodejsFunction;
  readonly budgetsActionRole: iam.Role;

  constructor(scope: Construct, id: string, props: BudgetsActionStackProps) {
    super(scope, id, props);

    const { stagePrefix, data } = props;
    const notifyEmail =
      (this.node.tryGetContext('bbg:notifySenderAddress') as string | undefined) ?? '';

    // Both deny-policy namespaces are visible to the rollover Lambda's
    // existing `bbg-deny-*` ArnEquals condition. Within this stack we
    // tighten further to `bbg-deny-cur-*` so the Budgets-Action role
    // can only attach the CUR-channel policies it created — never a
    // real-time-channel policy.
    const curDenyArnPattern = `arn:aws:iam::${this.account}:policy/bbg-deny-cur-*`;

    // ── 1. Role assumed by AWS Budgets (the service principal) ──────
    this.budgetsActionRole = new iam.Role(this, 'BudgetsActionRole', {
      roleName: `${stagePrefix}-bbg-budgets-action-role`,
      // Restrict trust to budgets.amazonaws.com from THIS account only.
      // The aws:SourceAccount condition prevents the confused-deputy
      // problem if the role ARN ever leaks across account boundaries.
      assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
      description:
        'BBG: assumed by AWS Budgets to attach bbg-deny-cur-* policies on budget breach.',
    });

    // The Budgets service needs to attach the bbg-deny-cur-* policy to
    // user / role principals when a CUR-channel budget breaches. Scope
    // both the resource (user/role ARNs) and the policy ARN via
    // ArnEquals — same guardrail pattern as the real-time enforcement
    // Lambda's role.
    this.budgetsActionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:AttachUserPolicy', 'iam:DetachUserPolicy'],
        resources: [`arn:aws:iam::${this.account}:user/*`],
        conditions: { ArnEquals: { 'iam:PolicyARN': curDenyArnPattern } },
      }),
    );
    this.budgetsActionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: [`arn:aws:iam::${this.account}:role/*`],
        conditions: { ArnEquals: { 'iam:PolicyARN': curDenyArnPattern } },
      }),
    );
    this.budgetsActionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:GetPolicy'],
        resources: [curDenyArnPattern],
      }),
    );

    // ── 2. budgets-action-sync Lambda ──────────────────────────────
    const dlq = new sqs.Queue(this, 'BudgetsActionSyncDlq', {
      queueName: `${stagePrefix}-bbg-budgets-action-sync-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.sync = new BbgNodejsFunction(this, 'BudgetsActionSync', {
      functionName: `${stagePrefix}-bbg-budgets-action-sync`,
      handlerName: 'budgets-action-sync',
      timeout: Duration.minutes(2),
      memorySize: 512,
      environment: {
        STAGE_PREFIX: stagePrefix,
        BUDGETS_TABLE: data.budgets.tableName,
        INFERENCE_PROFILES_TABLE: data.inferenceProfiles.tableName,
        AWS_ACCOUNT_ID: this.account,
        BUDGETS_ACTION_ROLE_ARN: this.budgetsActionRole.roleArn,
        NOTIFY_EMAIL: notifyEmail,
      },
      deadLetterQueue: dlq,
    });

    // Stream read on Budgets table — see data-stack.ts for the stream
    // declaration (NEW_AND_OLD_IMAGES so REMOVE events carry the row).
    data.budgets.grantStreamRead(this.sync);
    data.inferenceProfiles.grantReadData(this.sync);

    this.sync.addEventSource(
      new DynamoEventSource(data.budgets, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        maxBatchingWindow: Duration.seconds(2),
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );

    // The sync Lambda manages Budgets + BudgetsActions for the
    // entire account, but each Budget is keyed by a stable BBG name
    // (see `naming.ts`). There's no resource-level ARN for these calls,
    // so we leave the resource set wildcard and rely on the BudgetName
    // pattern + the IAM PassRole condition to bound blast radius.
    this.sync.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'budgets:CreateBudget',
          'budgets:UpdateBudget',
          'budgets:DeleteBudget',
          'budgets:DescribeBudget',
          'budgets:DescribeBudgets',
          'budgets:CreateBudgetAction',
          'budgets:UpdateBudgetAction',
          'budgets:DeleteBudgetAction',
          'budgets:DescribeBudgetAction',
          'budgets:DescribeBudgetActionsForBudget',
        ],
        resources: ['*'],
      }),
    );

    // Create the bbg-deny-cur-* policy at sync time so AWS Budgets has
    // an existing ARN to reference in the Action's IamActionDefinition.
    this.sync.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'iam:CreatePolicy',
          'iam:CreatePolicyVersion',
          'iam:DeletePolicy',
          'iam:DeletePolicyVersion',
          'iam:GetPolicy',
          'iam:ListPolicyVersions',
        ],
        resources: [curDenyArnPattern],
      }),
    );

    // PassRole: the sync Lambda hands the BudgetsActionRole ARN to AWS
    // Budgets when creating an Action. iam:PassedToService bound to
    // budgets.amazonaws.com prevents the role from being passed to any
    // other service.
    this.sync.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.budgetsActionRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'budgets.amazonaws.com' },
        },
      }),
    );

    new cdk.CfnOutput(this, 'BudgetsActionRoleArn', {
      value: this.budgetsActionRole.roleArn,
      description:
        'IAM role assumed by AWS Budgets to attach bbg-deny-cur-* policies.',
    });
    new cdk.CfnOutput(this, 'BudgetsActionSyncFunctionName', {
      value: this.sync.functionName,
    });
  }
}
