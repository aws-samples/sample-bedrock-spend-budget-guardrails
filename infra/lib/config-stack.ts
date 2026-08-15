import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface ConfigStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
}

/**
 * AWS Config recorder + delivery channel + a curated set of AWS-managed
 * rules that align with the Well-Architected Security pillar commitments.
 *
 * Account-level singletons: only one recorder + delivery channel per
 * (account, region) — so this stack is gated to the prod stage and gets
 * skipped if AWS Config is already enabled in the account by something else
 * (Control Tower, Security Hub, an existing org-level Config aggregator).
 *
 * `bbg:disableConfigStack=true` in cdk.json suppresses this whole stack
 * for accounts that already have Config managed elsewhere.
 */
export class ConfigStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConfigStackProps) {
    super(scope, id, props);

    const removalPolicy = cdk.RemovalPolicy.RETAIN; // keep history when stack is deleted

    // S3 bucket for Config snapshots + history.
    const bucket = new s3.Bucket(this, 'ConfigHistory', {
      bucketName: `${props.stagePrefix}-bbg-config-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'tier-and-expire',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(180) },
          ],
          expiration: cdk.Duration.days(2555), // 7 years for compliance
        },
      ],
      removalPolicy,
    });

    // IAM role Config assumes to record configs + write to the bucket.
    const role = new iam.Role(this, 'ConfigRole', {
      assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole')],
    });
    bucket.grantReadWrite(role);

    // Bucket policy required by Config: explicit deny if SSL not used (handled
    // by enforceSSL above) + explicit grant for the Config service principal.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSConfigBucketPermissionsCheck',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('config.amazonaws.com')],
        actions: ['s3:GetBucketAcl', 's3:ListBucket'],
        resources: [bucket.bucketArn],
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSConfigBucketDelivery',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('config.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${bucket.bucketArn}/AWSLogs/${this.account}/*`],
        conditions: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } },
      }),
    );

    const recorder = new config.CfnConfigurationRecorder(this, 'Recorder', {
      name: 'default',
      roleArn: role.roleArn,
      recordingGroup: { allSupported: true, includeGlobalResourceTypes: true },
    });

    const channel = new config.CfnDeliveryChannel(this, 'DeliveryChannel', {
      name: 'default',
      s3BucketName: bucket.bucketName,
    });
    // AWS Config recorder/delivery-channel ordering is a known CFN trap. Do
    // NOT add an explicit DependsOn between the recorder and the channel in
    // EITHER direction — CloudFormation handles the pair natively ("starts the
    // recorder as soon as the delivery channel is available", per the
    // AWS::Config::ConfigurationRecorder docs) as long as neither is forced to
    // wait on the other:
    //   - channel DependsOn recorder  → CFN starts the recorder before the
    //     channel exists → `NoAvailableDeliveryChannelException`.
    //   - recorder DependsOn channel  → `PutDeliveryChannel` runs before a
    //     recorder exists → `NoAvailableConfigurationRecorderException`.
    // (Both were observed on a fresh account.) The official AWS sample template
    // (aws-cloudformation-templates/Config/Config.yaml) declares them as
    // independent resources with no inter-dependency — matched here.
    //
    // What DOES need an explicit edge: the S3 bucket RESOURCE POLICY. When CFN
    // brings up the recorder + channel, Config immediately validates it can
    // write snapshots to the bucket (s3:GetBucketAcl / PutObject via the
    // AWSConfig* statements), so the bucket policy must exist first — otherwise
    // the delivery channel create races the policy attach.
    recorder.node.addDependency(bucket.policy!);
    channel.node.addDependency(bucket.policy!);

    // Curated AWS-managed Config rules — Well-Architected Security pillar.
    const rules: Array<[string, string]> = [
      ['EncryptedVolumes', 'ENCRYPTED_VOLUMES'],
      ['S3PublicReadProhibited', 'S3_BUCKET_PUBLIC_READ_PROHIBITED'],
      ['S3PublicWriteProhibited', 'S3_BUCKET_PUBLIC_WRITE_PROHIBITED'],
      ['S3SSLOnly', 'S3_BUCKET_SSL_REQUESTS_ONLY'],
      ['S3DefaultEncryption', 'S3_DEFAULT_ENCRYPTION_KMS'],
      ['IamPolicyNoAdmin', 'IAM_POLICY_NO_STATEMENTS_WITH_ADMIN_ACCESS'],
      ['IamRootAccessKey', 'IAM_ROOT_ACCESS_KEY_CHECK'],
      ['RootMfa', 'ROOT_ACCOUNT_MFA_ENABLED'],
      ['IamUserMfa', 'IAM_USER_MFA_ENABLED'],
      ['CloudTrailEnabled', 'CLOUD_TRAIL_ENABLED'],
      ['CloudTrailEncryption', 'CLOUD_TRAIL_ENCRYPTION_ENABLED'],
      ['CloudTrailLogFileValidation', 'CLOUD_TRAIL_LOG_FILE_VALIDATION_ENABLED'],
      ['LambdaConcurrencyCheck', 'LAMBDA_CONCURRENCY_CHECK'],
      ['LambdaDlqCheck', 'LAMBDA_DLQ_CHECK'],
      ['DynamoDbAutoscaling', 'DYNAMODB_AUTOSCALING_ENABLED'],
      ['DynamoDbPitr', 'DYNAMODB_PITR_ENABLED'],
      ['ApiGwSslEnabled', 'API_GW_SSL_ENABLED'],
      // NOTE: two identifiers were removed because AWS Config rejects them as
      // invalid AWS-owned managed rules (`InvalidRequest: The sourceIdentifier
      // ... is invalid`), which fails the whole stack on a fresh account:
      //   - CLOUDFRONT_VIEWER_POLICY_HTTPS — not accepted here, and redundant
      //     with BBG's direct CloudFront HTTPS enforcement (REDIRECT_TO_HTTPS +
      //     TLS_V1_2_2021 + HSTS in web-stack.ts).
      //   - COGNITO_USER_POOL_MFA_CONFIGURED — no such AWS-managed rule exists
      //     (it needs a custom Lambda rule); BBG intentionally uses passkey/
      //     WebAuthn instead of MFA (see the AwsSolutions-COG2 suppression), so
      //     the rule would flag a deliberate design choice.
    ];

    for (const [logicalId, identifier] of rules) {
      new config.ManagedRule(this, logicalId, {
        identifier,
        configRuleName: `${props.stagePrefix}-bbg-${logicalId.toLowerCase()}`,
      }).node.addDependency(recorder, channel);
    }

    new cdk.CfnOutput(this, 'ConfigBucketName', { value: bucket.bucketName });
  }
}
