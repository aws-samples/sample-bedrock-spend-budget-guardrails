import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { CodeBuildStep, CodePipeline, CodePipelineSource, ManualApprovalStep } from 'aws-cdk-lib/pipelines';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';
import { AppStage } from './stages/app-stage.js';

export interface PipelineStackProps extends cdk.StackProps {}

/**
 * Self-mutating CDK Pipeline. Source from GitHub via CodeStar Connections.
 * Default: auto-promote dev → prod with no manual gate. Set context
 * `bbg:requireProdApproval=true` to insert a ManualApprovalStep.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: PipelineStackProps) {
    super(scope, id, props);

    const githubOwner = this.node.tryGetContext('bbg:githubOwner') as string | undefined;
    const githubRepo = this.node.tryGetContext('bbg:githubRepo') as string | undefined;
    const githubBranch = (this.node.tryGetContext('bbg:githubBranch') as string | undefined) ?? 'main';
    const connectionParam = (this.node.tryGetContext('bbg:githubConnectionArnSsm') as string | undefined) ?? '/bbg/github-connection-arn';
    const operatorConfigParam =
      (this.node.tryGetContext('bbg:operatorConfigSsm') as string | undefined) ?? '/bbg/operator-config';
    const requireProdApproval = this.node.tryGetContext('bbg:requireProdApproval') === true;

    if (!githubOwner || !githubRepo) {
      throw new Error(
        `Set bbg:githubOwner + bbg:githubRepo in SSM ${operatorConfigParam} (or cdk.json) before deploying PipelineStack.`,
      );
    }

    const connectionArn = ssm.StringParameter.valueForStringParameter(this, connectionParam);

    const synthStep = new CodeBuildStep('Synth', {
        input: CodePipelineSource.connection(`${githubOwner}/${githubRepo}`, githubBranch, {
          connectionArn,
        }),
        installCommands: ['npm ci'],
        commands: [
          'npm run -w @bbg/lambda lint',
          'npm run -w @bbg/lambda test',
          'npm run -w @bbg/lambda build',
          'npm run -w @bbg/web lint',
          'npm run -w @bbg/web test',
          'npm run -w @bbg/web build',
          // Auto-bootstrap every configured metered region BEFORE synth/deploy.
          // Adding a home region via the Enrollment UI (bbg:meteredRegions in
          // the operator-config SSM param) synthesizes a MeteringStack in that
          // region; without CDKToolkit there the deploy fails mid-release.
          // `cdk bootstrap` is idempotent (no-ops when current), so this adds
          // ~seconds for already-bootstrapped regions. The bootstrap power
          // deliberately lives HERE (the pipeline's synth role, which already
          // self-mutates the pipeline) and NOT in the enrollment API Lambda —
          // an API route that can create cfn-exec admin roles would be an
          // account-takeover primitive.
          'node scripts/bootstrap-metered-regions.mjs',
          // Run cdk synth from the repo root so it picks up the root cdk.json.
          // Bypass the npm script (which cd's into infra/ first).
          'npx cdk synth --quiet',
        ],
        primaryOutputDirectory: 'cdk.out',
        // Synth reads operator-specific values (account-id'd Cognito
        // prefixes, hosted zone, custom domains, alert email, GitHub owner)
        // from SSM at runtime so they aren't committed to the public repo.
        rolePolicyStatements: [
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: [
              cdk.Arn.format(
                {
                  service: 'ssm',
                  resource: 'parameter',
                  resourceName: operatorConfigParam.replace(/^\//, ''),
                },
                this,
              ),
            ],
          }),
          // an earlier change/28: synth-time auto-detection of the home account's
          // Organization ID, root ID, and account list. Without these
          // perms `loadOperatorConfig` returns undefined for those
          // values and the MemberStackSet construct falls back to a
          // no-op stack with no exports — which silently drops the
          // cross-stack `ExportsOutputFnGetAttEnforcement*` outputs
          // that previous synths produced, causing CFN to fail with
          // "Cannot delete export ... in use by member-stackset" the
          // next time the pipeline tries to update the producer
          // stacks. Read-only Org APIs.
          new iam.PolicyStatement({
            actions: [
              'organizations:DescribeOrganization',
              'organizations:ListRoots',
              'organizations:ListAccounts',
            ],
            resources: ['*'],
          }),
          // Auto-bootstrap of metered regions (scripts/bootstrap-metered-
          // regions.mjs above): `cdk bootstrap` deploys/updates the
          // CDKToolkit stack in each configured region. It needs to read
          // the bootstrap version SSM param + describe the stack in ANY
          // region (region can't be scoped in the ARN pattern usefully
          // since the region list is operator-config data), and to assume
          // the CDK bootstrap roles once they exist. The heavy lifting
          // (creating the CDKToolkit CFN stack) runs via CloudFormation
          // with the caller's credentials in the target region.
          new iam.PolicyStatement({
            actions: [
              'cloudformation:CreateStack',
              'cloudformation:UpdateStack',
              'cloudformation:DescribeStacks',
              'cloudformation:DescribeStackEvents',
              'cloudformation:GetTemplate',
              'cloudformation:CreateChangeSet',
              'cloudformation:DescribeChangeSet',
              'cloudformation:ExecuteChangeSet',
              'cloudformation:DeleteChangeSet',
            ],
            resources: [`arn:aws:cloudformation:*:${this.account}:stack/CDKToolkit/*`],
          }),
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:PutParameter'],
            resources: [`arn:aws:ssm:*:${this.account}:parameter/cdk-bootstrap/*`],
          }),
          // CDKToolkit provisions these resource types; the bootstrap
          // template creates IAM roles (incl. the cfn-exec role), the
          // assets bucket + ECR repo. Scoped to the CDK bootstrap
          // naming convention where the services support it.
          new iam.PolicyStatement({
            actions: [
              'iam:CreateRole', 'iam:GetRole', 'iam:PutRolePolicy', 'iam:GetRolePolicy',
              'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:DeleteRolePolicy',
              'iam:TagRole', 'iam:UpdateAssumeRolePolicy', 'iam:PassRole',
            ],
            resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
          }),
          new iam.PolicyStatement({
            actions: ['iam:CreatePolicy', 'iam:GetPolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:ListPolicyVersions'],
            resources: [`arn:aws:iam::${this.account}:policy/cdk-*`],
          }),
          new iam.PolicyStatement({
            actions: ['s3:CreateBucket', 's3:PutBucketPolicy', 's3:GetBucketPolicy', 's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock', 's3:PutLifecycleConfiguration', 's3:GetBucketLocation', 's3:ListBucket'],
            resources: ['arn:aws:s3:::cdk-*'],
          }),
          new iam.PolicyStatement({
            actions: ['ecr:CreateRepository', 'ecr:DescribeRepositories', 'ecr:SetRepositoryPolicy', 'ecr:GetRepositoryPolicy', 'ecr:PutLifecyclePolicy', 'ecr:PutImageTagMutability', 'ecr:TagResource'],
            resources: [`arn:aws:ecr:*:${this.account}:repository/cdk-*`],
          }),
        ],
      });

    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'bbg-pipeline',
      selfMutation: true,
      dockerEnabledForSynth: true,
      synth: synthStep,
      // Pin the build image + Node for ALL CodeBuild projects the pipeline
      // creates (Synth, SelfMutate, Assets). The CDK-default image's default
      // Node is too old for the toolchain — vitest@4 uses `util.styleText`
      // (added Node 20.12) — so builds failed at test startup with
      // "node:util does not provide an export named 'styleText'". Node 22 (on
      // standard:7.0) satisfies the whole build toolchain: vitest@4, esbuild
      // (can target node24 output from a node22 host), and `npm ci` (our
      // engines ">=24" is advisory — no engine-strict — so it only warns). The
      // Lambda *runtime* Node is set independently by the CDK Runtime enum, so
      // the CI host Node doesn't need to be 24.
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        },
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          phases: {
            install: {
              'runtime-versions': { nodejs: 22 },
            },
          },
        }),
      },
    });

    pipeline.addStage(new AppStage(this, 'Dev', {
      env: { account: this.account, region: this.region },
      stagePrefix: 'dev',
    }));

    const prodStage = pipeline.addStage(new AppStage(this, 'Prod', {
      env: { account: this.account, region: this.region },
      stagePrefix: 'prod',
    }));

    if (requireProdApproval) {
      prodStage.addPre(new ManualApprovalStep('PromoteToProd'));
    }
  }
}
