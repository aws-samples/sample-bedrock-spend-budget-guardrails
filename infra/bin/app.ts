#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { type IConstruct } from 'constructs';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { AppStage } from '../lib/stages/app-stage.js';
import { PipelineStack } from '../lib/pipeline-stack.js';
import { loadOperatorConfig } from '../lib/operator-config.js';

/**
 * Documented cdk-nag suppressions covering both framework-internal noise
 * (CDK Pipelines' build-role IAM, BucketDeployment + S3AutoDeleteObjects
 * helper roles, cross-region replication artifact bucket) and accepted
 * MVP trade-offs. Each entry has a `reason` for security-review audit.
 *
 * Application-code IAM is reviewed and tightened separately (e.g. the
 * enforcement Lambda's iam:Attach*Policy is scoped via iam:PolicyARN
 * ArnEquals to bbg-deny-* only).
 */
const blanketSuppressions = [
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWS-managed policies attached to CDK-generated framework helper Lambda roles (log retention, BucketDeployment, S3 auto-delete-objects custom resource).',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Wildcards exist on (a) CDK Pipelines artifact-bucket access on the build role, (b) framework custom-resource helpers (BucketDeployment, S3AutoDeleteObjects), (c) Bedrock/Pricing/Organizations AWS APIs that have no resource-level scoping (bedrock:ListFoundationModels, bedrock:ListInferenceProfiles, pricing:GetProducts, and the org-discount-resolver read-only tree walk: organizations:ListRoots/ListAccountsForParent/ListOrganizationalUnitsForParent/DescribeOrganization), and (d) cross-region replication buckets generated when crossRegionReferences=true. Application-code wildcards are explicitly scoped via iam:PolicyARN ArnEquals (bbg-deny-*) and the User Pool ARN; reviewed manually.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      'Application Lambdas pin to Node 20 LTS via BbgNodejsFunction. Suppression covers framework-internal helper Lambdas that pin to older runtimes.',
  },
  {
    id: 'AwsSolutions-S1',
    reason:
      'Server access logs intentionally disabled on (a) the access-logs sink itself (recursion not supported), (b) the CDK Pipelines artifact bucket and its cross-region replication peer (CloudTrail covers them), and (c) the Athena results bucket (30d expiry, IAM-scoped, account-internal only).',
  },
  {
    id: 'AwsSolutions-S10',
    reason:
      'Server-side encryption with bucket-owner-enforced + KMS-CMK applied where applicable; framework helper buckets use AES256 by default.',
  },
  {
    id: 'AwsSolutions-CB3',
    reason:
      'CDK Pipelines CodeBuild project uses privileged mode for Docker bundling of NodejsFunction assets. Required for cross-region asset publishing; the build container is single-tenant per build invocation.',
  },
  {
    id: 'AwsSolutions-CB4',
    reason:
      'CDK Pipelines CodeBuild project encrypts artifacts using the AWS-managed S3 key. Tightening to a CMK is a follow-on once we have a wildcard cross-region key strategy.',
  },
  {
    id: 'AwsSolutions-CFR1',
    reason:
      'Geo restrictions intentionally not configured; access control is via Cognito User Pool, not source-IP/geo.',
  },
  {
    id: 'AwsSolutions-CFR2',
    reason: 'WAFv2 attachment to CloudFront is planned for prod stage only; dev stage skipped.',
  },
  {
    id: 'AwsSolutions-CFR3',
    reason: 'CloudFront access logging not enabled on dev distribution to keep dev cost low.',
  },
  {
    id: 'AwsSolutions-CFR4',
    reason:
      'CloudFront uses REDIRECT_TO_HTTPS + TLS_V1_2_2021. Suppressed for any false positive on the implicit default-protocol fallback.',
  },
  {
    id: 'AwsSolutions-COG1',
    reason: 'Password policy enforces 12-char minimum with all character classes.',
  },
  {
    id: 'AwsSolutions-COG2',
    reason:
      'MFA is OFF because we offer passkey/WebAuthn as a first-factor option (alternative to MFA, not in addition). Cognito has no separate "passkey-required" enforcement.',
  },
  {
    id: 'AwsSolutions-COG3',
    reason: 'Standard threat protection mode set to FULL_FUNCTION (highest available).',
  },
  {
    id: 'AwsSolutions-APIG1',
    reason:
      'API Gateway HTTP APIs do not yet support the same access-logging configuration as REST APIs in CloudFormation; suppressed pending CDK construct improvement.',
  },
  {
    id: 'AwsSolutions-APIG4',
    reason:
      'API Gateway HTTP API uses Cognito JWT authorizer scoped to our User Pool client. No anonymous routes.',
  },
  {
    id: 'AwsSolutions-DDB3',
    reason: 'PITR enabled on all application tables via tableDefaults.',
  },
  {
    id: 'AwsSolutions-ATH1',
    reason: 'Athena WorkGroup encrypts results with the project CMK.',
  },
  {
    id: 'AwsSolutions-SQS3',
    reason:
      'DLQs use SQS-managed encryption; payloads are internal metering events, no PII.',
  },
  {
    id: 'AwsSolutions-SQS4',
    reason:
      'DLQs only accessed by Lambda execution roles in-account; SSL-only access policy not required.',
  },
];

const applySuppressions = (scope: IConstruct): void => {
  for (const child of scope.node.children) {
    if (child instanceof cdk.Stack) {
      NagSuppressions.addStackSuppressions(child, blanketSuppressions, true);
    } else if (child instanceof cdk.Stage) {
      applySuppressions(child);
    }
  }
};

// CDK Pipelines auto-spawns a cross-region replication stack at synth time
// (us-east-1, for CloudFront cert assets) that's NOT a child of
// PipelineStack — it's added to the App directly during synthesis, after
// our applySuppressions() walk. Use an Aspect that runs during synth, when
// the cross-region stack DOES exist, to suppress its findings too.
class StackNagSuppressionsAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (node instanceof cdk.Stack) {
      NagSuppressions.addStackSuppressions(node, blanketSuppressions, true);
    }
  }
}

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.CDK_DEPLOY_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? process.env.CDK_DEPLOY_REGION ?? 'us-west-2';

if (!account && process.env.BBG_LOCAL === '1') {
  throw new Error(
    'CDK_DEFAULT_ACCOUNT is unset. Run with active AWS credentials, e.g. `aws sts get-caller-identity`.',
  );
}

const env = account ? { account, region } : undefined;

void (async (): Promise<void> => {
  // Pull operator-specific values (account-id'd Cognito prefixes, hosted
  // zone, custom domains, GitHub owner, alert email) from SSM Parameter
  // Store and merge them into App context. Keeps the public repo free
  // of account IDs while letting the pipeline self-configure.
  await loadOperatorConfig(app);

  if (process.env.BBG_LOCAL === '1') {
    // Direct (non-pipeline) deploy of one stage, for local iteration and
    // smoke-testing. Defaults to `dev`; set BBG_LOCAL_STAGE=prod to exercise
    // the prod-only stacks (WAF on CloudFront in us-east-1, AWS Config) without
    // waiting on the GitOps pipeline.
    const localStage = process.env.BBG_LOCAL_STAGE === 'prod' ? 'prod' : 'dev';
    new AppStage(app, localStage === 'prod' ? 'ProdAppStage' : 'DevAppStage', {
      env,
      stagePrefix: localStage,
    });
  } else {
    new PipelineStack(app, 'PipelineStack', {
      env,
      description: 'Bedrock Budget Guard — CDK Pipelines (GitOps)',
    });
  }

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  applySuppressions(app);
  Aspects.of(app).add(new StackNagSuppressionsAspect());

  app.synth();
})();
