import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BbgNodejsFunction } from './constructs/nodejs-fn.js';
import type { DataStack } from './data-stack.js';
import type { NetworkAndAuthStack } from './network-and-auth-stack.js';

export interface EnforcementStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly data: DataStack;
  /** Auth stack — used by the notify Lambda for Cognito reverse-lookup. */
  readonly auth: NetworkAndAuthStack;
  /** Optional custom-domain URL for the "view your spend" link in emails. */
  readonly appUrl?: string;
}

/**
 * Enforcement Lambda: consumes RunningSpend stream, compares to Budgets, and
 * on breach attaches a `bbg-deny-*` customer-managed IAM policy to the
 * offending principal. Detached + deleted at the start of the next period
 * by `period-rollover` (EventBridge Scheduler monthly cron).
 */
export class EnforcementStack extends cdk.Stack {
  readonly enforcement: BbgNodejsFunction;
  readonly periodRollover: BbgNodejsFunction;
  readonly notify: BbgNodejsFunction;

  constructor(scope: Construct, id: string, props: EnforcementStackProps) {
    super(scope, id, props);

    const { stagePrefix, data, auth, appUrl } = props;
    const notifySender =
      (this.node.tryGetContext('bbg:notifySenderAddress') as string | undefined) ?? '';
    // ops fallback for principals that map to no Cognito human.
    // Only honored when a sender is configured (SES send needs a From). If
    // set without a sender, it's inert (notify no-ops without a sender).
    const notifyOpsFallback = notifySender
      ? ((this.node.tryGetContext('bbg:notifyOpsFallbackAddress') as string | undefined) ?? '')
      : '';
    // ENF-2 kill-switch: operator flag (operator-config `bbg:pauseEnforcement`)
    // that, when set, makes the enforcement Lambda skip attaching new deny
    // policies. Passed as an env flag so flipping it is a redeploy — the
    // audit trail is the pipeline run, not a mutable-at-runtime toggle.
    const pauseEnforcement =
      this.node.tryGetContext('bbg:pauseEnforcement') === true ? 'true' : 'false';

    const dlq = new sqs.Queue(this, 'EnforcementDlq', {
      queueName: `${stagePrefix}-bbg-enforcement-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const denyPolicyArnPattern = `arn:aws:iam::${this.account}:policy/bbg-deny-*`;

    this.enforcement = new BbgNodejsFunction(this, 'Enforcement', {
      functionName: `${stagePrefix}-bbg-enforcement`,
      handlerName: 'enforcement',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        STAGE_PREFIX: stagePrefix,
        BUDGETS_TABLE: data.budgets.tableName,
        RUNNING_SPEND_TABLE: data.runningSpend.tableName,
        INFERENCE_PROFILES_TABLE: data.inferenceProfiles.tableName,
        // BBG-RATELIMITS: enforcement reads rate counters when the
        // matching budget has rpm/tpm set.
        RATE_COUNTERS_TABLE: data.rateCounters.tableName,
        AWS_ACCOUNT_ID: this.account,
        // ENF-2 kill-switch.
        ENFORCEMENT_PAUSED: pauseEnforcement,
        // per-principal activity log.
        PRINCIPAL_ACTIVITY_TABLE: data.principalActivity.tableName,
      },
      deadLetterQueue: dlq,
    });

    data.budgets.grantReadData(this.enforcement);
    data.runningSpend.grantReadWriteData(this.enforcement);
    data.principalActivity.grantWriteData(this.enforcement);
    data.inferenceProfiles.grantReadData(this.enforcement);
    // BBG-RATELIMITS: read-only — enforcement queries the buckets but
    // never writes them.
    data.rateCounters.grantReadData(this.enforcement);

    // Scoped IAM: only the bbg-deny-* namespace.
    this.enforcement.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'iam:CreatePolicy',
          'iam:CreatePolicyVersion',
          'iam:DeletePolicy',
          'iam:DeletePolicyVersion',
          'iam:GetPolicy',
          'iam:ListPolicyVersions',
        ],
        resources: [denyPolicyArnPattern],
      }),
    );
    this.enforcement.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:AttachUserPolicy', 'iam:DetachUserPolicy'],
        resources: [`arn:aws:iam::${this.account}:user/*`],
        conditions: { ArnEquals: { 'iam:PolicyARN': denyPolicyArnPattern } },
      }),
    );
    this.enforcement.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: [`arn:aws:iam::${this.account}:role/*`],
        conditions: { ArnEquals: { 'iam:PolicyARN': denyPolicyArnPattern } },
      }),
    );
    // Read-only principal lookup, scoped to this account's IAM namespace.
    // The enforcement Lambda resolves arbitrary metered principals (any
    // user/role in the home account can appear in RunningSpend), so it needs
    // account-wide user/role read — but never cross-account, and never write.
    this.enforcement.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:GetUser', 'iam:GetRole'],
        resources: [
          `arn:aws:iam::${this.account}:user/*`,
          `arn:aws:iam::${this.account}:role/*`,
        ],
      }),
    );

    this.enforcement.addEventSource(
      new DynamoEventSource(data.runningSpend, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        maxBatchingWindow: Duration.seconds(2),
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );

    // Period rollover: monthly cron + on-demand.
    this.periodRollover = new BbgNodejsFunction(this, 'PeriodRollover', {
      functionName: `${stagePrefix}-bbg-period-rollover`,
      handlerName: 'period-rollover',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        STAGE_PREFIX: stagePrefix,
        RUNNING_SPEND_TABLE: data.runningSpend.tableName,
        PRINCIPAL_ACTIVITY_TABLE: data.principalActivity.tableName,
      },
    });
    data.runningSpend.grantReadWriteData(this.periodRollover);
    data.principalActivity.grantWriteData(this.periodRollover);
    this.periodRollover.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:DetachUserPolicy', 'iam:DetachRolePolicy'],
        resources: [`arn:aws:iam::${this.account}:user/*`, `arn:aws:iam::${this.account}:role/*`],
        conditions: { ArnEquals: { 'iam:PolicyARN': denyPolicyArnPattern } },
      }),
    );
    this.periodRollover.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:ListPolicyVersions', 'iam:ListEntitiesForPolicy'],
        resources: [denyPolicyArnPattern],
      }),
    );

    const schedulerRole = new iam.Role(this, 'RolloverSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    this.periodRollover.grantInvoke(schedulerRole);

    // Monthly schedule: keeps the legacy name + no payload for back-compat.
    // The Lambda defaults `window` to 'monthly' when no payload is given.
    new scheduler.CfnSchedule(this, 'MonthlyRollover', {
      name: `${stagePrefix}-bbg-period-rollover`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 0 1 * ? *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: this.periodRollover.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    // Weekly: Mondays 00:00 UTC.
    new scheduler.CfnSchedule(this, 'WeeklyRollover', {
      name: `${stagePrefix}-bbg-period-rollover-weekly`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 0 ? * MON *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: this.periodRollover.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ window: 'weekly' }),
      },
    });

    // Daily: 00:00 UTC.
    new scheduler.CfnSchedule(this, 'DailyRollover', {
      name: `${stagePrefix}-bbg-period-rollover-daily`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 0 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: this.periodRollover.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ window: 'daily' }),
      },
    });

    // 5h: 00:00, 05:00, 10:00, 15:00, 20:00 UTC.
    new scheduler.CfnSchedule(this, 'FiveHourRollover', {
      name: `${stagePrefix}-bbg-period-rollover-5h`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 0/5 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: this.periodRollover.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ window: '5h' }),
      },
    });

    // Notify Lambda: same DynamoDB stream as enforcement, separate event
    // source mapping. Sends SES emails to the Cognito user mapped to a
    // breached principal at threshold crossings (50/80/100) and on
    // enforcement-just-fired events. No-ops cleanly when
    // `bbg:notifySenderAddress` isn't a verified SES identity.
    const notifyDlq = new sqs.Queue(this, 'NotifyDlq', {
      queueName: `${stagePrefix}-bbg-notify-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.notify = new BbgNodejsFunction(this, 'Notify', {
      functionName: `${stagePrefix}-bbg-notify`,
      handlerName: 'notify',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        STAGE_PREFIX: stagePrefix,
        BUDGETS_TABLE: data.budgets.tableName,
        RUNNING_SPEND_TABLE: data.runningSpend.tableName,
        USER_POOL_ID: auth.userPool.userPoolId,
        NOTIFY_SENDER_ADDRESS: notifySender,
        NOTIFY_OPS_FALLBACK_ADDRESS: notifyOpsFallback,
        APP_URL: appUrl ?? '',
        PRINCIPAL_ACTIVITY_TABLE: data.principalActivity.tableName,
      },
      deadLetterQueue: notifyDlq,
    });

    data.budgets.grantReadData(this.notify);
    data.runningSpend.grantReadWriteData(this.notify);
    data.principalActivity.grantWriteData(this.notify);

    // Cognito reverse-lookup needs ListUsers (principal→email map) and
    // ListUsersInGroup ('Admins' group membership for the admin-watch
    // fan-out) on the deployed pool.
    this.notify.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup'],
        resources: [auth.userPool.userPoolArn],
      }),
    );

    // SES SendEmail — scoped to the configured sender identity. Granted only
    // when a sender is set; without one the notify Lambda no-ops (see its
    // NOTIFY_SENDER_ADDRESS guard), so it needs no SES permission at all and
    // first-run deploy still succeeds. The resource covers both the exact
    // sender-address identity and its parent-domain identity (SES authorizes a
    // domain-verified sender against the domain identity ARN), and a
    // ses:FromAddress condition pins the actual From to the configured sender.
    if (notifySender) {
      const senderDomain = notifySender.split('@')[1];
      this.notify.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: [
            `arn:aws:ses:${this.region}:${this.account}:identity/${notifySender}`,
            ...(senderDomain
              ? [`arn:aws:ses:${this.region}:${this.account}:identity/${senderDomain}`]
              : []),
          ],
          conditions: { StringEquals: { 'ses:FromAddress': notifySender } },
        }),
      );
    }

    this.notify.addEventSource(
      new DynamoEventSource(data.runningSpend, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        maxBatchingWindow: Duration.seconds(2),
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );
  }
}
