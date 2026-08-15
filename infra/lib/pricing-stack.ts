import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BbgNodejsFunction } from './constructs/nodejs-fn.js';
import type { DataStack } from './data-stack.js';

export interface PricingStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly data: DataStack;
}

/**
 * Daily AWS Pricing API refresher that populates the Pricing table by joining
 * `bedrock:ListFoundationModels` with `pricing:GetProducts` across the three
 * Bedrock service codes (see `docs/pricing-nuances.md`).
 */
export class PricingStack extends cdk.Stack {
  readonly refresher: BbgNodejsFunction;
  /** Hierarchical org/OU discount resolver — invoked on-write by the API. */
  readonly discountResolver: BbgNodejsFunction;

  constructor(scope: Construct, id: string, props: PricingStackProps) {
    super(scope, id, props);

    const { stagePrefix, data } = props;

    const meteredRegions = (this.node.tryGetContext('bbg:meteredRegions') as string[] | undefined) ?? [
      'us-east-1',
      'us-east-2',
      'us-west-2',
    ];

    this.refresher = new BbgNodejsFunction(this, 'PricingRefresher', {
      functionName: `${stagePrefix}-bbg-pricing-refresher`,
      handlerName: 'pricing-refresher',
      // 15min (the Lambda max) — the refresher walks ~140 models × 5 metered
      // regions against the low-TPS Pricing API, which throttles heavily; the
      // client uses adaptive retry (see pricing-refresher/index.ts) to pace
      // itself. It was running right at the 15min cap and timing out on some
      // runs (which skipped metric emission and blinded the pricing alarms); the
      // handler now has a self-imposed time budget that stops the loop early and
      // always publishes metrics (PricingRefreshIncomplete flags a truncated
      // run). Memory is 2048 (up from 1024) because Lambda scales CPU with
      // memory and the work is CPU-bound on JSON parsing + throttle backoff —
      // faster per-model work means fewer runs ever hit the budget.
      timeout: Duration.minutes(15),
      memorySize: 2048,
      environment: {
        PRICING_TABLE: data.pricing.tableName,
        METERED_REGIONS: meteredRegions.join(','),
        STAGE_PREFIX: stagePrefix,
      },
    });

    data.pricing.grantReadWriteData(this.refresher);

    this.refresher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'pricing:DescribeServices',
          'pricing:GetAttributeValues',
          'pricing:GetProducts',
          'pricing:ListPriceLists',
          'pricing:GetPriceListFileUrl',
        ],
        resources: ['*'],
      }),
    );
    this.refresher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ListFoundationModels'],
        resources: ['*'],
      }),
    );

    // Scheduler: daily at 03:00 UTC.
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    this.refresher.grantInvoke(schedulerRole);

    new scheduler.CfnSchedule(this, 'DailySchedule', {
      name: `${stagePrefix}-bbg-pricing-refresh`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 3 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: this.refresher.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
      },
    });

    // ── Hierarchical (org/OU) discount resolver ──────────────────────────────
    // Walks the Organizations tree OFF the meter hot path and materializes the
    // most-specific winning discount % onto each account's discount#<acct> row
    // (which the meter already reads with one cached GetItem). Runs hourly, and
    // is invoked on-demand by the pricing-overrides API after every discount
    // write so a new OU/org discount takes effect in minutes. Gracefully
    // degrades (no-op) when Organizations is denied — see the handler.
    this.discountResolver = new BbgNodejsFunction(this, 'OrgDiscountResolver', {
      functionName: `${stagePrefix}-bbg-org-discount-resolver`,
      handlerName: 'org-discount-resolver',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        PRICING_TABLE: data.pricing.tableName,
        STAGE_PREFIX: stagePrefix,
      },
    });
    data.pricing.grantReadWriteData(this.discountResolver);
    this.discountResolver.addToRolePolicy(
      new iam.PolicyStatement({
        // Read-only, top-down tree walk. NO organizations:ListParents (the walk
        // knows each account's parent from the direction it descends).
        actions: [
          'organizations:ListRoots',
          'organizations:ListAccountsForParent',
          'organizations:ListOrganizationalUnitsForParent',
          'organizations:DescribeOrganization',
        ],
        resources: ['*'],
      }),
    );

    this.discountResolver.grantInvoke(schedulerRole);
    new scheduler.CfnSchedule(this, 'DiscountResolverSchedule', {
      name: `${stagePrefix}-bbg-org-discount-resolve`,
      flexibleTimeWindow: { mode: 'OFF' },
      // Hourly at :20 (offset clear of the 03:00 refresher + activity cron slots).
      scheduleExpression: 'cron(20 * * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: this.discountResolver.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });
  }
}
