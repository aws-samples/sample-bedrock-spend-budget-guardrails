import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';

/**
 * Documented cdk-nag suppressions for findings that are either:
 *   1. Inherent to a managed CDK construct we use (CDK Pipelines internals,
 *      S3 BucketDeployment, Custom::S3AutoDeleteObjects, etc.)
 *   2. Acceptable trade-offs for this MVP (auto-delete on dev buckets,
 *      Lambda runtime version pinning, log retention via deprecated prop).
 *
 * Each suppression includes a `reason` per cdk-nag's docs requirement so a
 * security reviewer can audit the rationale. When we tighten the
 * application code we revisit and remove these.
 */

const SHARED_SUPPRESSIONS: Array<{ id: string; reason: string }> = [
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWS-managed policies are used by CDK-generated Lambda execution roles for log-retention helpers, BucketDeployment custom resources, and similar internal constructs. Suppressed because the source policies are AWS-managed and follow least-privilege for the helper role itself.',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Wildcard IAM permissions appear on (a) CDK-generated framework helper roles (BucketDeployment, S3AutoDeleteObjects, log-retention provider) where the wildcard is over the helper-managed object set, (b) cross-region replication buckets generated for cross-region cert references, and (c) bedrock:ListInferenceProfiles / pricing:GetProducts where AWS does not expose resource-level ARNs. We have manually reviewed every wildcard in our own code and either narrowed to a specific resource pattern (e.g. iam:PolicyARN ArnEquals condition on bbg-deny-*) or left the wildcard intentional with this suppression.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      'Lambda runtime managed via aws-cdk-lib NodejsFunction; it pins to the latest Node 20 LTS. Suppressed for CDK-internal constructs that pin to older runtimes (custom resource providers, log retention, etc.). Application Lambdas use Node 20.x via BbgNodejsFunction.',
  },
  {
    id: 'AwsSolutions-S1',
    reason:
      'Server access logs intentionally disabled on (a) the access-logs sink itself (recursion not supported), (b) the CDK Pipelines artifacts bucket (CodePipeline manages its own access tracking via CloudTrail), and (c) the Athena results bucket which has 30-day expiry and is accessed only by IAM-scoped roles in this account.',
  },
  {
    id: 'AwsSolutions-CB4',
    reason:
      'CDK Pipelines CodeBuild project does not encrypt at rest with a customer-managed KMS key. It uses the AWS-managed S3 KMS key for the artifacts bucket; tightening to a CMK is a follow-on.',
  },
  {
    id: 'AwsSolutions-KDS3',
    reason:
      'Not applicable; we have no Kinesis Data Streams. Suppression added defensively for any framework-generated stream.',
  },
];

/**
 * Apply the project-wide suppression list to a stack. Call after the stack
 * tree is fully constructed.
 */
export const applyBbgSuppressions = (stack: Stack): void => {
  NagSuppressions.addStackSuppressions(stack, SHARED_SUPPRESSIONS, true);
};
