import * as cdk from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as logsDest from "aws-cdk-lib/aws-logs-destinations";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import { BbgNodejsFunction } from "./constructs/nodejs-fn.js";
import { BedrockLoggingConfig } from "./constructs/bedrock-logging-config.js";
import type { DataStack } from "./data-stack.js";

export interface MeteringStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly data: DataStack;
  /** AWS region whose Bedrock invocations this stack instance meters.
   *  When this differs from the home region (where DataStack lives),
   *  the stack must be deployed with `env.region = meteredRegion`. */
  readonly meteredRegion: string;
  /** True when meteredRegion === home region. The home-region stack
   *  owns the Lambdas with DDB / KMS access. Non-home stacks only
   *  capture local CWL + CloudTrail events and forward them to the
   *  home region via EventBridge. */
  readonly isHomeRegion: boolean;
}

/**
 * Real-time meter for one region.
 *
 * Two distinct topologies depending on `isHomeRegion`:
 *
 * Identity source: Bedrock `InvokeModel` / `Converse` / `InvokeAgent` calls
 * surface as management-event API calls ("AWS API Call via CloudTrail") on the
 * account's default EventBridge bus, delivered by whatever account/org
 * management trail already exists (BBG runs no trail of its own). The
 * `BedrockApiRule` matches those default-bus events.
 *
 * **Home region (us-west-2 today):**
 * - LogGroup + BedrockLoggingConfig (Bedrock invocation logs write here)
 * - Meter Lambda (subscribed to local LogGroup; does DDB writes)
 * - IdentityCache Lambda (subscribed to EventBridge default bus;
 *   does DDB writes + emits `bbg.identity-arrived`)
 * - LedgerWriter Lambda (consumes RunningSpend DDB stream)
 * - InferenceProfileRefresher Lambda (scheduled)
 * - EventBridge rules:
 *   - `BedrockApiRule`: default-bus Bedrock API-call events → IdentityCache
 *   - `IdentityArrivedRule`: `bbg.identity-arrived` → Meter
 *   - `RemoteBedrockInvocationRule` (Phase 1b): cross-region
 *     forwarded `bbg.bedrock-invocation` events → Meter
 *
 * **Metered, non-home region (us-east-1, us-east-2):**
 * - LogGroup + BedrockLoggingConfig (same as home)
 * - CwlForwarder Lambda — subscribed to local LogGroup, calls
 *   PutEvents to the home-region default bus with the raw CWL message.
 * - EventBridge rule on local default bus → cross-region target =
 *   home-region default bus. Bedrock API-call events flow
 *   through to home for IdentityCache to pick up.
 *
 * No DDB / KMS access is granted to non-home Lambdas. They only need
 * `events:PutEvents` on the home-region default bus + basic CWL
 * permissions. This sidesteps the CDK chicken-and-egg with cross-
 * region grants to a customer-managed KMS key.
 */
export class MeteringStack extends cdk.Stack {
  /** Home-region: the meter Lambda. Non-home: undefined. */
  meter?: BbgNodejsFunction;
  /** Home-region: the identity-cache Lambda. Non-home: undefined. */
  identityCache?: BbgNodejsFunction;
  /** Home-region only — see {@link MeteringStackProps.isHomeRegion}. */
  ledgerWriter?: BbgNodejsFunction;
  /** Home-region: the inference-profile-refresher Lambda. Non-home: undefined. */
  inferenceProfileRefresher?: BbgNodejsFunction;
  /** Non-home only: the CWL → home-region EventBridge forwarder. */
  cwlForwarder?: BbgNodejsFunction;
  readonly bedrockLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: MeteringStackProps) {
    super(scope, id, props);

    const { stagePrefix, data, meteredRegion, isHomeRegion } = props;
    const removalPolicy =
      stagePrefix === "prod"
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;

    const dlq = new sqs.Queue(this, "MeteringDlq", {
      queueName: `${stagePrefix}-bbg-metering-dlq-${meteredRegion}`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // N3: alarm on a filling metering DLQ. Messages here are metered Bedrock
    // spend events (home: meter / identity-cache / ledger-writer; non-home:
    // cwl-forwarder) that exhausted their retries — that spend never reaches
    // RUNNING_SPEND, so enforcement never fires for it. The alarm MUST live in
    // the metered region: metering DLQs are created per region (one per entry
    // in bbg:meteredRegions), and a CloudWatch alarm can only trigger a
    // same-region SNS topic — a home-region alarm structurally cannot read this
    // region's AWS/SQS metric. So each MeteringStack owns its own alarm + a
    // regional alerts topic (subscribed to the same bbg:alertEmail as the
    // home-region bbg-alerts topic in observability-stack).
    const dlqAlertTopic = new sns.Topic(this, "MeteringDlqAlerts", {
      topicName: `${stagePrefix}-bbg-metering-alerts-${meteredRegion}`,
      displayName: `Bedrock Budget Guard metering alerts (${meteredRegion})`,
    });
    const alertEmail = this.node.tryGetContext("bbg:alertEmail") as
      string | undefined;
    if (alertEmail) {
      dlqAlertTopic.addSubscription(new snsSubs.EmailSubscription(alertEmail));
    }
    new cloudwatch.Alarm(this, "MeteringDlqNotEmptyAlarm", {
      alarmName: `${stagePrefix}-bbg-metering-dlq-not-empty-${meteredRegion}`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: dlq.queueName },
        statistic: "Maximum",
        period: Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `The ${meteredRegion} metering dead-letter queue has visible messages: a metering Lambda exhausted its retries and dropped a Bedrock spend event, so that spend never reached RUNNING_SPEND and enforcement never fired for it. Redrive the DLQ before its 14-day retention expires. See docs/runbooks/meter.md.`,
    }).addAlarmAction(new cwActions.SnsAction(dlqAlertTopic));

    const homeRegion = cdk.Stack.of(data).region;

    // How many months of RunningSpend history the meter retains (drives each
    // row's TTL). Defaults to 13 (a year + current month) so the Spend
    // Dashboard period selector can read back history. `0` ⇒ retain forever
    // (no TTL written). Override via the `bbg:spendRetentionMonths` operator
    // config / context key. The S3 ledger is the permanent archive regardless.
    const spendRetentionMonths =
      (this.node.tryGetContext("bbg:spendRetentionMonths") as
        number | undefined) ?? 13;

    // Common environment for all metering Lambdas.
    const commonEnv = {
      STAGE_PREFIX: stagePrefix,
      METERED_REGION: meteredRegion,
      HOME_REGION: homeRegion,
      RUNNING_SPEND_TABLE: data.runningSpend.tableName,
      IDENTITY_CACHE_TABLE: data.identityCache.tableName,
      PENDING_METER_TABLE: data.pendingMeter.tableName,
      PRICING_TABLE: data.pricing.tableName,
      INFERENCE_PROFILES_TABLE: data.inferenceProfiles.tableName,
      AGENT_SESSIONS_TABLE: data.agentSessions.tableName,
      PRINCIPALS_SEEN_TABLE: data.principalsSeen.tableName,
      LEDGER_BUCKET: data.ledgerBucket.bucketName,
      BUDGETS_TABLE: data.budgets.tableName,
      RATE_COUNTERS_TABLE: data.rateCounters.tableName,
      SPEND_RETENTION_MONTHS: String(spendRetentionMonths),
    };

    // CWL log group + Bedrock invocation logging config + Trail. These
    // live in the metered region in BOTH topologies (home + non-home).
    this.bedrockLogGroup = new logs.LogGroup(this, "BedrockInvocationLogs", {
      logGroupName: `/aws/bedrock/${stagePrefix}-invocations-${meteredRegion}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy,
    });

    new BedrockLoggingConfig(this, "LoggingConfig", {
      logGroup: this.bedrockLogGroup,
      region: meteredRegion,
    });

    // Identity source: Bedrock `InvokeModel` / `Converse` / `InvokeAgent` calls
    // surface as management-event API calls ("AWS API Call via CloudTrail") on
    // the account's default EventBridge bus — but ONLY if a trail is currently
    // logging management events (CloudTrail's free 90-day Event history alone
    // does NOT deliver to EventBridge). Many accounts already have one (Control
    // Tower / an org trail); a bare account does not.
    //
    // So by default BBG creates its own minimal multi-region management-events
    // trail, once, in the home region — this makes the sample work out of the
    // box on a stock account. CloudTrail delivers the first copy of management
    // events free; you pay only trivial S3 storage (7-day expiry here — the
    // trail exists to enable default-bus delivery, not to be queried).
    //
    // Opt OUT with operator-config `bbg:createManagementEventsTrail: false` if
    // the account/org already has a management trail (Control Tower, org trail),
    // to avoid a redundant second trail (a second copy of management events is
    // NOT free). We do NOT add data-event selectors here, so there is no
    // basic-vs-advanced selector clobber (the failure mode of the removed
    // per-stage data-events trail).
    const rawCreateTrail = this.node.tryGetContext(
      "bbg:createManagementEventsTrail",
    );
    const createManagementTrail =
      rawCreateTrail !== false && rawCreateTrail !== "false";
    if (isHomeRegion && createManagementTrail) {
      const mgmtTrailBucket = new s3.Bucket(this, "ManagementTrailBucket", {
        bucketName: `${stagePrefix}-bbg-mgmt-trail-${this.account}-${meteredRegion}`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.KMS_MANAGED, // AWS-managed aws/s3 key — CT-compatible, satisfies CT.S3.PR.10.
        enforceSSL: true,
        removalPolicy,
        autoDeleteObjects: stagePrefix !== "prod",
        lifecycleRules: [
          { id: "expire-mgmt-trail", expiration: Duration.days(7) },
        ],
      });
      // Multi-region + management events (L2 default is ReadWriteType.ALL), so
      // Bedrock API calls in every metered region land on that region's default
      // bus for the local BedrockApiRule / cross-region forwarder to pick up.
      new cloudtrail.Trail(this, "ManagementEventsTrail", {
        trailName: `${stagePrefix}-bbg-mgmt-${meteredRegion}`,
        bucket: mgmtTrailBucket,
        isMultiRegionTrail: true,
        includeGlobalServiceEvents: true,
        enableFileValidation: true,
      });
    }

    if (isHomeRegion) {
      this.buildHomeRegion(commonEnv, dlq, data);
    } else {
      this.buildMeteredRegion(commonEnv, homeRegion, dlq);
    }

    new cdk.CfnOutput(this, "BedrockLogGroupName", {
      value: this.bedrockLogGroup.logGroupName,
    });
  }

  /**
   * Home-region topology: full meter / identity-cache / ledger-writer
   * / inference-profile-refresher with DDB + KMS access.
   */
  private buildHomeRegion(
    commonEnv: Record<string, string>,
    dlq: sqs.Queue,
    data: DataStack,
  ): void {
    const { stagePrefix } = this.parseProps();
    const meteredRegion = commonEnv.METERED_REGION;

    this.meter = new BbgNodejsFunction(this, "Meter", {
      functionName: `${stagePrefix}-bbg-meter-${meteredRegion}`,
      handlerName: "meter",
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      deadLetterQueue: dlq,
    });

    this.identityCache = new BbgNodejsFunction(this, "IdentityCache", {
      functionName: `${stagePrefix}-bbg-identity-cache-${meteredRegion}`,
      handlerName: "identity-cache",
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      deadLetterQueue: dlq,
    });

    this.ledgerWriter = new BbgNodejsFunction(this, "LedgerWriter", {
      functionName: `${stagePrefix}-bbg-ledger-writer-${meteredRegion}`,
      handlerName: "ledger-writer",
      timeout: Duration.minutes(2),
      memorySize: 1024,
      environment: commonEnv,
      deadLetterQueue: dlq,
    });

    this.inferenceProfileRefresher = new BbgNodejsFunction(
      this,
      "InferenceProfileRefresher",
      {
        functionName: `${stagePrefix}-bbg-inference-profile-refresher-${meteredRegion}`,
        handlerName: "inference-profile-refresher",
        timeout: Duration.minutes(2),
        memorySize: 256,
        environment: commonEnv,
      },
    );

    // Grants — all to home-region resources, all in-region.
    data.runningSpend.grantReadWriteData(this.meter);
    data.identityCache.grantReadWriteData(this.meter);
    data.pendingMeter.grantReadWriteData(this.meter);
    data.pricing.grantReadData(this.meter);
    data.inferenceProfiles.grantReadData(this.meter);
    data.budgets.grantReadWriteData(this.meter);
    // BBG-RATELIMITS: meter writes per-minute rate-counter buckets when a
    // budget for the principal has rpm/tpm set. Read access lets the
    // skip-cache check whether any rate-limited budget exists for the
    // principal before doing the bucket write.
    data.rateCounters.grantReadWriteData(this.meter);

    data.identityCache.grantReadWriteData(this.identityCache);
    data.pendingMeter.grantReadWriteData(this.identityCache);
    data.agentSessions.grantReadWriteData(this.identityCache);
    data.principalsSeen.grantReadWriteData(this.identityCache);

    data.runningSpend.grantStreamRead(this.ledgerWriter);
    data.ledgerBucket.grantWrite(this.ledgerWriter);
    data.key.grantEncrypt(this.ledgerWriter);

    data.inferenceProfiles.grantReadWriteData(this.inferenceProfileRefresher);
    this.inferenceProfileRefresher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:ListInferenceProfiles",
          "bedrock:GetInferenceProfile",
        ],
        resources: ["*"],
      }),
    );

    // Scheduler: daily at 02:00 UTC for inference-profile-refresher.
    const inferenceProfileSchedulerRole = new iam.Role(
      this,
      "InferenceProfileSchedulerRole",
      {
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      },
    );
    this.inferenceProfileRefresher.grantInvoke(inferenceProfileSchedulerRole);

    new scheduler.CfnSchedule(this, "DailyInferenceProfileRefresh", {
      name: `${stagePrefix}-bbg-inference-profile-refresh-${meteredRegion}`,
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "cron(0 2 * * ? *)",
      scheduleExpressionTimezone: "UTC",
      target: {
        arn: this.inferenceProfileRefresher.functionArn,
        roleArn: inferenceProfileSchedulerRole.roleArn,
      },
    });

    // identity-cache needs to read IAM tags + emit EventBridge events.
    this.identityCache.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:ListUserTags", "iam:ListRoleTags"],
        resources: ["*"],
      }),
    );
    this.identityCache.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["events:PutEvents"],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:event-bus/default`,
        ],
      }),
    );

    // CWL → meter (same-region subscription).
    new logs.SubscriptionFilter(this, "MeterSubscription", {
      logGroup: this.bedrockLogGroup,
      destination: new logsDest.LambdaDestination(this.meter),
      filterPattern: logs.FilterPattern.allEvents(),
    });

    // CloudTrail Bedrock data events → identity-cache.
    new events.Rule(this, "BedrockApiRule", {
      ruleName: `${stagePrefix}-bbg-bedrock-runtime-${meteredRegion}`,
      eventPattern: {
        source: [
          "aws.bedrock-runtime",
          "aws.bedrock",
          "aws.bedrock-agent-runtime",
        ],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          eventName: [
            "InvokeModel",
            "InvokeModelWithResponseStream",
            "Converse",
            "ConverseStream",
            // OpenAI-compatible APIs on the /openai/v1 paths of bedrock-runtime. Verified
            // 2026-08-18 against a live call: CloudTrail logs these as MANAGEMENT events
            // (eventName 'Responses', eventCategory 'Management', managementEvent true,
            // eventSource bedrock.amazonaws.com) carrying userIdentity + a requestID that
            // matches the invocation-log record. Without them the meter writes to
            // PendingMeter, the row TTLs out after 1h, and the spend is silently lost --
            // reproduced before this fix.
            "Responses",
            "ChatCompletions",
            "InvokeAgent",
            "Retrieve",
            "RetrieveAndGenerate",
          ],
        },
      },
      targets: [
        new eventsTargets.LambdaFunction(this.identityCache, {
          deadLetterQueue: dlq,
        }),
      ],
    });

    // bbg.identity-arrived events (emitted by identity-cache after a join) → meter.
    new events.Rule(this, "IdentityArrivedRule", {
      ruleName: `${stagePrefix}-bbg-identity-arrived-${meteredRegion}`,
      eventPattern: {
        source: ["bbg.metering"],
        detailType: ["bbg.identity-arrived"],
      },
      targets: [
        new eventsTargets.LambdaFunction(this.meter, { deadLetterQueue: dlq }),
      ],
    });

    // an earlier change Phase 1b: cross-region forwarded Bedrock invocation events
    // from non-home metered regions land here. Same meter Lambda
    // consumes them — the event detail carries the original CWL
    // message + sourceRegion so the meter can do region-aware
    // pricing.
    new events.Rule(this, "RemoteBedrockInvocationRule", {
      ruleName: `${stagePrefix}-bbg-remote-bedrock-invocation`,
      eventPattern: {
        source: ["bbg.metering"],
        detailType: ["bbg.bedrock-invocation"],
      },
      targets: [
        new eventsTargets.LambdaFunction(this.meter, { deadLetterQueue: dlq }),
      ],
    });

    // RunningSpend stream → ledger-writer.
    this.ledgerWriter.addEventSource(
      new DynamoEventSource(data.runningSpend, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 50,
        maxBatchingWindow: Duration.seconds(5),
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );
  }

  /**
   * Non-home metered region: capture-and-forward only. No DDB / KMS
   * access. Two forwarders:
   *  1. CWL → home-region default bus (via the CwlForwarder Lambda).
   *  2. CloudTrail Bedrock data events on local default bus →
   *     home-region default bus (via EventBridge cross-region rule
   *     target).
   */
  private buildMeteredRegion(
    commonEnv: Record<string, string>,
    homeRegion: string,
    dlq: sqs.Queue,
  ): void {
    const { stagePrefix } = this.parseProps();
    const meteredRegion = commonEnv.METERED_REGION;

    this.cwlForwarder = new BbgNodejsFunction(this, "CwlForwarder", {
      functionName: `${stagePrefix}-bbg-cwl-forwarder-${meteredRegion}`,
      handlerName: "cwl-forwarder",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: commonEnv,
      // On partial/total PutEvents failure the handler throws; the CWL
      // SubscriptionFilter invokes async, so failed events retry twice then
      // land on this DLQ for durable capture (matching meter/identity-cache/
      // ledger-writer). Loss is also surfaced by the CwlForwardFailed alarm.
      deadLetterQueue: dlq,
    });

    // Allow the forwarder to PutEvents in the home region.
    this.cwlForwarder.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["events:PutEvents"],
        resources: [
          `arn:aws:events:${homeRegion}:${this.account}:event-bus/default`,
        ],
      }),
    );

    // CWL → forwarder (same-region subscription).
    new logs.SubscriptionFilter(this, "CwlForwarderSubscription", {
      logGroup: this.bedrockLogGroup,
      destination: new logsDest.LambdaDestination(this.cwlForwarder),
      filterPattern: logs.FilterPattern.allEvents(),
    });

    // EventBridge cross-region target for CloudTrail Bedrock data
    // events: rule sits on this region's default bus, target = home
    // region's default bus. Same-account + same-Org cross-region
    // routing requires only an IAM role assumed by EventBridge.
    const crossRegionEventRole = new iam.Role(this, "CrossRegionEventRole", {
      assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
      inlinePolicies: {
        PutEventsHome: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["events:PutEvents"],
              resources: [
                `arn:aws:events:${homeRegion}:${this.account}:event-bus/default`,
              ],
            }),
          ],
        }),
      },
    });

    new events.Rule(this, "BedrockApiRule", {
      ruleName: `${stagePrefix}-bbg-bedrock-runtime-${meteredRegion}`,
      eventPattern: {
        source: [
          "aws.bedrock-runtime",
          "aws.bedrock",
          "aws.bedrock-agent-runtime",
        ],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          eventName: [
            "InvokeModel",
            "InvokeModelWithResponseStream",
            "Converse",
            "ConverseStream",
            // OpenAI-compatible APIs on the /openai/v1 paths of bedrock-runtime. Verified
            // 2026-08-18 against a live call: CloudTrail logs these as MANAGEMENT events
            // (eventName 'Responses', eventCategory 'Management', managementEvent true,
            // eventSource bedrock.amazonaws.com) carrying userIdentity + a requestID that
            // matches the invocation-log record. Without them the meter writes to
            // PendingMeter, the row TTLs out after 1h, and the spend is silently lost --
            // reproduced before this fix.
            "Responses",
            "ChatCompletions",
            "InvokeAgent",
            "Retrieve",
            "RetrieveAndGenerate",
          ],
        },
      },
      targets: [
        new eventsTargets.EventBus(
          events.EventBus.fromEventBusArn(
            this,
            "HomeDefaultBus",
            `arn:aws:events:${homeRegion}:${this.account}:event-bus/default`,
          ),
          { role: crossRegionEventRole },
        ),
      ],
    });
  }

  /** Helper to recover stagePrefix in the build* methods without
   *  threading it through. */
  private parseProps(): { stagePrefix: string } {
    // The stack's stackName is `${stagePrefix}-bbg-metering-${region}`.
    // Pull stagePrefix off the front.
    const stackName = this.stackName;
    const match = stackName.match(/^(.+?)-bbg-metering-/);
    if (!match) throw new Error(`Cannot derive stagePrefix from ${stackName}`);
    return { stagePrefix: match[1] };
  }
}
