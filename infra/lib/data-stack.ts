import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface DataStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
}

/**
 * The system of record: 8 DynamoDB tables, 3 S3 buckets, Glue + Athena
 * for the Parquet ledger. All KMS-CMK-encrypted, PITR on, on-demand.
 */
export class DataStack extends cdk.Stack {
  readonly key: kms.Key;
  readonly budgets: dynamodb.Table;
  readonly runningSpend: dynamodb.Table;
  readonly identityCache: dynamodb.Table;
  readonly pricing: dynamodb.Table;
  readonly inferenceProfiles: dynamodb.Table;
  readonly pendingMeter: dynamodb.Table;
  readonly agentSessions: dynamodb.Table;
  readonly principalsSeen: dynamodb.Table;
  readonly passkeyNicknames: dynamodb.Table;
  /**
   * BBG-RATELIMITS: per-principal sliding-window rate counters.
   * Keyed (principal, bucket) where bucket is a 1-minute UTC floor like
   * `1m#2026-05-24T22:51`. Counters: `requestCount` and `tokenCount`
   * (input+output combined). TTL ~16 minutes — well past the longest
   * supported sliding window (15 min). Written by the meter on every
   * metered Bedrock invocation when any budget for the principal has
   * `rpm` or `tpm` set; queried by enforcement on every RunningSpend
   * stream event when the matching budget has rate fields. Separate
   * from RunningSpend so RunningSpend's existing readers (period-rollover,
   * ledger-writer, spend API) don't have to filter rate rows.
   */
  readonly rateCounters: dynamodb.Table;
  /** per-principal activity timeline (warnings, enforcement,
   *  identity/budget changes). PK=principal, SK=`ts#<iso>#<ulid>`. */
  readonly principalActivity: dynamodb.Table;
  readonly ledgerBucket: s3.Bucket;
  readonly athenaResultsBucket: s3.Bucket;
  readonly accessLogsBucket: s3.Bucket;
  readonly glueDatabase: glue.CfnDatabase;
  readonly glueLedgerTable: glue.CfnTable;
  readonly athenaWorkGroup: athena.CfnWorkGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { stagePrefix } = props;
    const removalPolicy = stagePrefix === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const autoDelete = stagePrefix !== 'prod';

    // Customer-managed key shared by all data resources.
    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/${stagePrefix}-bbg-data`,
      enableKeyRotation: true,
      removalPolicy,
      description: 'BBG data-plane CMK for DynamoDB and S3 encryption',
    });

    const tableDefaults: Pick<
      dynamodb.TableProps,
      'billingMode' | 'pointInTimeRecoverySpecification' | 'encryption' | 'encryptionKey' | 'removalPolicy'
    > = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      removalPolicy,
    };

    // Budgets — PK principal, SK target (model#<id> | model#* | profile#<arn> | profile#*).
    // Stream is consumed by the optional `budgets-action-sync` Lambda
    // (BudgetsActionStack) which mirrors each row to a corresponding native
    // AWS Budgets + Budget Action so the CUR-driven enforcement channel
    // stays in sync with the operator-managed budget table. The stream
    // exists unconditionally so the table doesn't need a stack-update on
    // first opt-in — the consumer Lambda is the gated piece.
    this.budgets = new dynamodb.Table(this, 'Budgets', {
      tableName: `${stagePrefix}-bbg-budgets`,
      partitionKey: { name: 'principal', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'target', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      ...tableDefaults,
    });
    this.budgets.addGlobalSecondaryIndex({
      indexName: 'byTarget',
      partitionKey: { name: 'target', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'principal', type: dynamodb.AttributeType.STRING },
    });

    // RunningSpend — DDB stream feeds enforcement and ledger-writer.
    this.runningSpend = new dynamodb.Table(this, 'RunningSpend', {
      tableName: `${stagePrefix}-bbg-running-spend`,
      partitionKey: { name: 'principal', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // period#YYYY-MM#target#<id>
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
      ...tableDefaults,
    });
    this.runningSpend.addGlobalSecondaryIndex({
      indexName: 'byPeriod',
      partitionKey: { name: 'period', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'principal', type: dynamodb.AttributeType.STRING },
    });

    // IdentityCache — the requestId join target.
    this.identityCache = new dynamodb.Table(this, 'IdentityCache', {
      tableName: `${stagePrefix}-bbg-identity-cache`,
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'ttl',
      ...tableDefaults,
    });

    // per-principal activity log. One row per event; PK=principal,
    // SK=`ts#<iso>#<uuid>` so a Query on the principal returns the timeline
    // in reverse-chronological order (ScanIndexForward=false). TTL-expired
    // (~1yr) so history is durable but bounded.
    this.principalActivity = new dynamodb.Table(this, 'PrincipalActivity', {
      tableName: `${stagePrefix}-bbg-principal-activity`,
      partitionKey: { name: 'principal', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      ...tableDefaults,
    });
    // Central-activity feed (PR4): PK=principal can't serve a cross-principal,
    // time-ordered "recent activity across everyone" query, so add a byDay GSI
    // partitioned by UTC day (`day#YYYY-MM-DD`) with the existing time-ordered
    // `sk` as the sort key. INCLUDE projection keeps the projected item ~0.3KB
    // (~1 WCU) — `detail` is excluded on purpose (feed rows open the modal,
    // which reads the base table for full detail). Sparse: pre-existing rows
    // have no `bucket`, so the feed fills forward from first write.
    this.principalActivity.addGlobalSecondaryIndex({
      indexName: 'byDay',
      partitionKey: { name: 'bucket', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['ts', 'type', 'summary', 'actor', 'accountId'],
    });

    this.pricing = new dynamodb.Table(this, 'Pricing', {
      tableName: `${stagePrefix}-bbg-pricing`,
      partitionKey: { name: 'model', type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    this.inferenceProfiles = new dynamodb.Table(this, 'InferenceProfiles', {
      tableName: `${stagePrefix}-bbg-inference-profiles`,
      partitionKey: { name: 'profileArn', type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });
    this.inferenceProfiles.addGlobalSecondaryIndex({
      indexName: 'byModel',
      partitionKey: { name: 'modelId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'profileArn', type: dynamodb.AttributeType.STRING },
    });

    this.pendingMeter = new dynamodb.Table(this, 'PendingMeter', {
      tableName: `${stagePrefix}-bbg-pending-meter`,
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'ttl',
      ...tableDefaults,
    });

    this.agentSessions = new dynamodb.Table(this, 'AgentSessions', {
      tableName: `${stagePrefix}-bbg-agent-sessions`,
      partitionKey: { name: 'agentSessionId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      ...tableDefaults,
    });

    // PrincipalsSeen — directory of distinct callers, one row per principal,
    // upserted by identity-cache on every CloudTrail event. Powers the
    // Identities page's "principals seen in last X" range query (presets:
    // 1h / 6h / 24h / 7d / 30d). Separate from IdentityCache (which is the
    // per-requestId join cache and TTLs out at 1h) because we want a small
    // table scaled by # distinct principals (10s–1000s), not # invocations.
    // TTL: lastSeen + 30d so quiet principals roll off naturally.
    this.principalsSeen = new dynamodb.Table(this, 'PrincipalsSeen', {
      tableName: `${stagePrefix}-bbg-principals-seen`,
      partitionKey: { name: 'principal', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      ...tableDefaults,
    });

    // User-chosen nicknames for WebAuthn / passkey credentials. Cognito has
    // no API to rename a registered credential, so we store the friendly
    // nickname here keyed by (cognito sub, credentialId).
    this.passkeyNicknames = new dynamodb.Table(this, 'PasskeyNicknames', {
      tableName: `${stagePrefix}-bbg-passkey-nicknames`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'credentialId', type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    // BBG-RATELIMITS — sliding-window rate-counter buckets. PK
    // `principal` + SK `bucket` (`1m#YYYY-MM-DDTHH:MM`). Meter does
    // `ADD requestCount 1, tokenCount :tok` per metered event when any
    // budget for the principal has rpm/tpm set. Enforcement scans the
    // last K buckets on every RunningSpend stream event when the
    // matching budget has rate fields. TTL = bucket-time + 16 min so
    // even at the longest 15-min window we can sum 15 buckets without
    // mid-query expiry.
    this.rateCounters = new dynamodb.Table(this, 'RateCounters', {
      tableName: `${stagePrefix}-bbg-rate-counters`,
      partitionKey: { name: 'principal', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'bucket', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      ...tableDefaults,
    });

    // S3: server access logs sink first.
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogs', {
      bucketName: `${stagePrefix}-bbg-access-logs-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS_MANAGED, // SSE-KMS with the AWS-managed `aws/s3` key (satisfies Control Tower CT.S3.PR.10; AWS-managed keys are natively supported by the S3 server access logging service).
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: autoDelete,
      lifecycleRules: [
        {
          id: 'expire-access-logs',
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    this.ledgerBucket = new s3.Bucket(this, 'Ledger', {
      bucketName: `${stagePrefix}-bbg-ledger-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'ledger/',
      removalPolicy,
      autoDeleteObjects: autoDelete,
      lifecycleRules: [
        {
          id: 'tier-and-expire',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(180) },
          ],
          expiration: cdk.Duration.days(730),
        },
      ],
    });

    this.athenaResultsBucket = new s3.Bucket(this, 'AthenaResults', {
      bucketName: `${stagePrefix}-bbg-athena-results-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'athena/',
      removalPolicy,
      autoDeleteObjects: autoDelete,
      lifecycleRules: [
        { id: 'expire-athena-results', expiration: cdk.Duration.days(30) },
      ],
    });

    // Glue + Athena — partitioned ledger of invocations for ad-hoc reporting.
    this.glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: cdk.Stack.of(this).account,
      databaseInput: {
        name: `${stagePrefix}_bbg_ledger`,
        description: 'BBG Bedrock invocation ledger',
      },
    });

    // Glue table over the JSONL files written by the ledger-writer Lambda.
    // Schema mirrors the JSON shape (camelCase keys), with partition
    // projection so we don't need MSCK REPAIR / Glue crawler to discover
    // year/month/day partitions.
    this.glueLedgerTable = new glue.CfnTable(this, 'InvocationsTable', {
      catalogId: cdk.Stack.of(this).account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'invocations',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          classification: 'json',
          'projection.enabled': 'true',
          'projection.year.type': 'integer',
          'projection.year.range': '2025,2030',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template': `s3://${this.ledgerBucket.bucketName}/events/year=\${year}/month=\${month}/day=\${day}/`,
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
        storageDescriptor: {
          location: `s3://${this.ledgerBucket.bucketName}/events/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            parameters: { 'ignore.malformed.json': 'true' },
          },
          columns: [
            { name: 'principal', type: 'string' },
            { name: 'sk', type: 'string' },
            { name: 'period', type: 'string' },
            { name: 'target', type: 'string' },
            { name: 'spendusd', type: 'double' },
            { name: 'inputtokens', type: 'bigint' },
            { name: 'outputtokens', type: 'bigint' },
            // Normalized attribution fields emitted by ledger-writer so
            // Athena reports can GROUP BY region / filter on enforcement
            // without parsing the dynamic `region_<code>` attr set.
            // `region` is the source region of the spend delta (''/null for
            // legacy rows pre-dating region attribution); `enforced` is true
            // when a deny policy was attached at write time;
            // `enforcementreason` is 'usd' | 'rpm' | 'tpm' (null otherwise).
            { name: 'region', type: 'string' },
            { name: 'enforced', type: 'boolean' },
            { name: 'enforcementreason', type: 'string' },
            { name: 'lastupdated', type: 'string' },
            { name: 'recordedat', type: 'string' },
            // `account` is the display-attribution account id derived from
            // the principal ARN (iam or sts), or '(unknown)' — mirrors
            // accountForDisplay in the spend API. Appended after the
            // original column set (additive schema evolution: the JSON
            // serde matches by key name, and objects written before this
            // column landed simply return NULL for it).
            { name: 'account', type: 'string' },
          ],
        },
      },
    });

    this.athenaWorkGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: `${stagePrefix}-bbg-wg`,
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${this.athenaResultsBucket.bucketName}/results/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_KMS',
            kmsKey: this.key.keyArn,
          },
        },
      },
    });

    // CDK-nag suppressions: server access logs bucket cannot itself have access logs (recursive).
    NagSuppressions.addResourceSuppressions(this.accessLogsBucket, [
      { id: 'AwsSolutions-S1', reason: 'This bucket IS the access-log destination; recursive logging is not supported.' },
    ]);

    // Outputs for downstream stacks.
    new cdk.CfnOutput(this, 'BudgetsTableName', { value: this.budgets.tableName });
    new cdk.CfnOutput(this, 'PricingTableName', { value: this.pricing.tableName });
    new cdk.CfnOutput(this, 'LedgerBucketName', { value: this.ledgerBucket.bucketName });
  }
}
