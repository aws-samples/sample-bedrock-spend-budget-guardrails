import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { BbgNodejsFunction } from './constructs/nodejs-fn.js';
import { BbgPythonFunction } from './constructs/python-fn.js';
import type { DataStack } from './data-stack.js';
import type { NetworkAndAuthStack } from './network-and-auth-stack.js';

export interface ApiStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly auth: NetworkAndAuthStack;
  readonly data: DataStack;
  /** follow-up: regions BBG meters in the home account.
   *  Surfaced via the EnrollmentApi so the SPA renders the home
   *  account as always-enrolled with the correct region list. */
  readonly meteredRegions: string[];
  /** Hierarchical-discount resolver — the pricing-overrides API invokes it
   *  on-write so a new OU/org discount re-materializes within seconds. */
  readonly discountResolver: BbgNodejsFunction;
}

export class ApiStack extends cdk.Stack {
  readonly httpApi: apigwv2.HttpApi;
  /** exposed so app-stage can grant cross-account assume-role
   *  permissions when member accounts are enrolled. */
  budgetsApi!: BbgNodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stagePrefix, auth, data, meteredRegions, discountResolver } = props;

    // Cross-stack references for Cognito issuer + audience must be passed
    // through Stage props because StringAttribute on the user pool can't be
    // referenced cross-stack via CfnOutput in CDK Pipelines.
    // CORS: localhost dev + the BBG custom domain (when configured) + any
    // explicit context overrides.
    //
    // The SPA calls this API cross-origin (directly at execute-api.*, not
    // proxied through CloudFront). When a custom domain is configured we know
    // the SPA's origin at synth and pin an exact allowlist. But a NO-DOMAIN
    // deploy serves the SPA from a CloudFront `*.cloudfront.net` URL that isn't
    // known here — the Web/CloudFront stack is created AFTER this API stack
    // (Web depends on Api for the config.json apiBaseUrl), so referencing the
    // distribution domain would be a cross-stack cycle. In that case we fall
    // back to `*`, which is safe HERE specifically because auth is a Bearer ID
    // token in the Authorization header with NO cookies / `credentials:
    // 'include'` (see web/src/api/client.ts): CORS `*` only exposes ambient
    // credentials, of which there are none, and every route is still behind the
    // Cognito JWT authorizer. Operators who want a tight allowlist without a
    // custom domain can set `bbg:additionalCorsOrigins` to their CloudFront URL
    // (after the first deploy surfaces it) — providing ANY explicit origin
    // opts back out of the wildcard.
    const extraOrigins = (this.node.tryGetContext('bbg:additionalCorsOrigins') as string[] | undefined) ?? [];
    const domainNames = (this.node.tryGetContext('bbg:domainNames') as Record<string, string> | undefined) ?? {};
    const stageDomain = domainNames[stagePrefix];
    const stageDomainOrigin = stageDomain ? `https://${stageDomain}` : undefined;
    const explicitOrigins = [
      'http://localhost:5173',
      ...(stageDomainOrigin ? [stageDomainOrigin] : []),
      ...extraOrigins,
    ];
    // Wildcard only when there's no custom domain AND no explicit override —
    // i.e. the quick/demo path where the CloudFront origin is unknown at synth.
    const allowOrigins =
      !stageDomainOrigin && extraOrigins.length === 0 ? ['*'] : explicitOrigins;
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${stagePrefix}-bbg-api`,
      corsPreflight: {
        allowOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type', 'x-bbg-idempotency-key'],
        maxAge: Duration.hours(1),
      },
    });

    const issuer = `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${auth.userPool.userPoolId}`;
    const authorizer = new apigwv2Auth.HttpJwtAuthorizer('JwtAuth', issuer, {
      jwtAudience: [auth.userPoolClient.userPoolClientId],
    });

    const commonEnv = {
      STAGE_PREFIX: stagePrefix,
      // Home-account id. `accountFromPrincipal` is STRICT (iam|sts ARN →
      // account, else undefined — no home fallback; AUZ-1 scope guards fail
      // CLOSED on undefined). This env var remains for the PLACEMENT paths
      // that explicitly fall back to the home account (deny policies for
      // session-tag/Condition-only principals are created in the home
      // account — see enforcement/index.ts; matches enforcement-stack.ts).
      AWS_ACCOUNT_ID: this.account,
      BUDGETS_TABLE: data.budgets.tableName,
      RUNNING_SPEND_TABLE: data.runningSpend.tableName,
      IDENTITY_CACHE_TABLE: data.identityCache.tableName,
      PRICING_TABLE: data.pricing.tableName,
      INFERENCE_PROFILES_TABLE: data.inferenceProfiles.tableName,
      AGENT_SESSIONS_TABLE: data.agentSessions.tableName,
      PRINCIPALS_SEEN_TABLE: data.principalsSeen.tableName,
      // per-principal activity log (budgets + users write it; identities reads it).
      PRINCIPAL_ACTIVITY_TABLE: data.principalActivity.tableName,
    };

    const budgets = new BbgNodejsFunction(this, 'BudgetsApi', {
      functionName: `${stagePrefix}-bbg-api-budgets`,
      handlerName: 'api/budgets',
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: commonEnv,
    });
    this.budgetsApi = budgets;
    data.budgets.grantReadWriteData(budgets);
    data.runningSpend.grantReadWriteData(budgets);
    data.principalActivity.grantWriteData(budgets); // budget-change activity
    // Allow the budgets handler to release (detach + delete) bbg-deny-*
    // policies so admins can lift enforcement without waiting for rollover.
    const denyPolicyArnPattern = `arn:aws:iam::${this.account}:policy/bbg-deny-*`;
    budgets.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'iam:DeletePolicy',
          'iam:DeletePolicyVersion',
          'iam:GetPolicy',
          'iam:ListPolicyVersions',
          'iam:ListEntitiesForPolicy',
        ],
        resources: [denyPolicyArnPattern],
      }),
    );
    budgets.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:DetachUserPolicy'],
        resources: [`arn:aws:iam::${this.account}:user/*`],
        conditions: { ArnEquals: { 'iam:PolicyARN': denyPolicyArnPattern } },
      }),
    );
    budgets.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:DetachRolePolicy'],
        resources: [`arn:aws:iam::${this.account}:role/*`],
        conditions: { ArnEquals: { 'iam:PolicyARN': denyPolicyArnPattern } },
      }),
    );

    const spend = new BbgNodejsFunction(this, 'SpendApi', {
      functionName: `${stagePrefix}-bbg-api-spend`,
      handlerName: 'api/spend',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: commonEnv,
    });
    data.runningSpend.grantReadData(spend);

    const identities = new BbgNodejsFunction(this, 'IdentitiesApi', {
      functionName: `${stagePrefix}-bbg-api-identities`,
      handlerName: 'api/identities',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: commonEnv,
    });
    data.identityCache.grantReadData(identities);
    data.principalsSeen.grantReadData(identities);
    data.principalActivity.grantReadData(identities); // activity timeline read

    const inferenceProfiles = new BbgNodejsFunction(this, 'InferenceProfilesApi', {
      functionName: `${stagePrefix}-bbg-api-inference-profiles`,
      handlerName: 'api/inference-profiles',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: commonEnv,
    });
    data.inferenceProfiles.grantReadData(inferenceProfiles);

    // Returns the Bedrock-supported region list, derived from the public
    // AWS global-infrastructure SSM parameter tree (no account data).
    // Powers the enrollment UI's region pickers so they auto-track new
    // Bedrock launches instead of a hardcoded list.
    const regions = new BbgNodejsFunction(this, 'RegionsApi', {
      functionName: `${stagePrefix}-bbg-api-regions`,
      handlerName: 'api/regions',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: commonEnv,
    });
    regions.addToRolePolicy(
      new iam.PolicyStatement({
        // AWS-owned public namespace — readable by any account. Scoped to
        // the global-infrastructure tree so the grant stays tight.
        actions: ['ssm:GetParametersByPath'],
        resources: ['arn:aws:ssm:*::parameter/aws/service/global-infrastructure/*'],
      }),
    );

    const pricingOverrides = new BbgNodejsFunction(this, 'PricingOverridesApi', {
      functionName: `${stagePrefix}-bbg-api-pricing-overrides`,
      handlerName: 'api/pricing-overrides',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        ...commonEnv,
        // On-write trigger for the hierarchical-discount resolver.
        DISCOUNT_RESOLVER_FN: discountResolver.functionName,
      },
    });
    data.pricing.grantReadWriteData(pricingOverrides);
    discountResolver.grantInvoke(pricingOverrides);

    const passkeyNicknames = new BbgNodejsFunction(this, 'PasskeyNicknamesApi', {
      functionName: `${stagePrefix}-bbg-api-passkey-nicknames`,
      handlerName: 'api/passkey-nicknames',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: { ...commonEnv, PASSKEY_NICKNAMES_TABLE: data.passkeyNicknames.tableName },
    });
    data.passkeyNicknames.grantReadWriteData(passkeyNicknames);

    const agentSessions = new BbgNodejsFunction(this, 'AgentSessionsApi', {
      functionName: `${stagePrefix}-bbg-api-agent-sessions`,
      handlerName: 'api/agent-sessions',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: commonEnv,
    });
    data.agentSessions.grantReadData(agentSessions);

    const users = new BbgNodejsFunction(this, 'UsersApi', {
      functionName: `${stagePrefix}-bbg-api-users`,
      handlerName: 'api/users',
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: { ...commonEnv, USER_POOL_ID: auth.userPool.userPoolId },
    });
    users.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:ListGroups',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminResetUserPassword',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser',
        ],
        resources: [auth.userPool.userPoolArn],
      }),
    );
    data.principalActivity.grantWriteData(users); // user lifecycle/metadata activity

    // org enrollment API. Lists Org accounts/OUs, reads/writes
    // /bbg/operator-config, triggers a pipeline run on apply, and
    // surfaces StackSet instance status. Super-admin only (enforced
    // in handler).
    const enrollment = new BbgNodejsFunction(this, 'EnrollmentApi', {
      functionName: `${stagePrefix}-bbg-api-enrollment`,
      handlerName: 'api/enrollment',
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...commonEnv,
        OPERATOR_CONFIG_PARAM: '/bbg/operator-config',
        PIPELINE_NAME: 'bbg-pipeline',
        HOME_ACCOUNT_ID: this.account,
        HOME_METERED_REGIONS: meteredRegions.join(','),
      },
    });
    enrollment.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'organizations:DescribeOrganization',
          'organizations:DescribeAccount',
          'organizations:ListRoots',
          'organizations:ListAccountsForParent',
          'organizations:ListOrganizationalUnitsForParent',
          // preflight check for StackSets trusted access.
          'organizations:ListAWSServiceAccessForOrganization',
        ],
        resources: ['*'],
      }),
    );
    // preflight check for `cloudformation activate-organizations-access`.
    enrollment.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeOrganizationsAccess'],
        resources: ['*'],
      }),
    );
    enrollment.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/bbg/operator-config`],
      }),
    );
    enrollment.addToRolePolicy(
      new iam.PolicyStatement({
        // DescribeStackSet exposes the OU StackSet's
        // autoDeployment config to the SPA so it can render
        // "auto-enrollment on / new accounts auto-enrolled in ~10 min".
        actions: ['cloudformation:ListStackInstances', 'cloudformation:DescribeStackSet'],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stackset/${stagePrefix}-bbg-member-roles*:*`,
        ],
      }),
    );
    enrollment.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codepipeline:StartPipelineExecution'],
        resources: [`arn:aws:codepipeline:${this.region}:${this.account}:bbg-pipeline`],
      }),
    );
    // Home-region metered-regions preflight: before writing a new
    // bbg:meteredRegions set, the handler checks CDKToolkit exists in each
    // candidate region (an un-bootstrapped region would fail the pipeline
    // mid-release). cloudformation:DescribeStacks isn't resource-scopable
    // per-region for a cross-region check, so it's granted on * — read-only
    // and low-risk. The AWS-owned Bedrock region SSM tree is public-read.
    enrollment.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: ['*'],
      }),
    );

    // audit log viewer. CloudWatch Logs Insights against the
    // admin Lambda log groups for the kind:"audit" lines emitted by
    // an earlier change's emitAudit. Super-admin only (handler-enforced).
    const audit = new BbgNodejsFunction(this, 'AuditApi', {
      functionName: `${stagePrefix}-bbg-api-audit`,
      handlerName: 'api/audit',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: { ...commonEnv },
    });
    audit.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:StartQuery',
          'logs:StopQuery',
          'logs:GetQueryResults',
        ],
        // Insights logs:StartQuery requires '*' for cross-log-group
        // queries — the API call's logGroupNames array is the actual
        // scope, but IAM doesn't support resource-level conditions on
        // logGroupNames. cdk-nag suppression scoped to this statement.
        resources: ['*'],
      }),
    );

    const reports = new BbgNodejsFunction(this, 'ReportsApi', {
      functionName: `${stagePrefix}-bbg-api-reports`,
      handlerName: 'api/reports',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnv,
        ATHENA_WORKGROUP: data.athenaWorkGroup.name,
        LEDGER_DATABASE: data.glueDatabase.ref,
      },
    });
    reports.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:GetWorkGroup',
        ],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${data.athenaWorkGroup.name}`],
      }),
    );
    reports.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions'],
        resources: ['*'],
      }),
    );
    data.athenaResultsBucket.grantReadWrite(reports);
    data.ledgerBucket.grantRead(reports);
    data.key.grantEncryptDecrypt(reports);

    // pre-onboarding Readiness page. Vendors the Python
    // bedrock-attribution-audit discovery engine (lambda/python/readiness)
    // as a Lambda. v1 audits the home (deploy) account on this Lambda's own
    // execution role; org-mode (cross-account sweep) is v2. A full
    // multi-region audit exceeds API GW's ~30s integration cap, so it runs
    // async like Reports: POST starts a job (async self-invoke), GET polls
    // the result blob from S3.
    const readiness = new BbgPythonFunction(this, 'ReadinessApi', {
      functionName: `${stagePrefix}-bbg-api-readiness`,
      handlerDir: 'readiness',
      // Account mode returns in ~1-3 min; the org-sweep auto-pivot (when
      // deployed in a management account) audits every member account in
      // parallel and needs headroom. API start/poll paths return in <2s.
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        STAGE_PREFIX: stagePrefix,
        HOME_ACCOUNT_ID: this.account,
        READINESS_RESULTS_BUCKET: data.athenaResultsBucket.bucketName,
        READINESS_RESULTS_PREFIX: 'readiness/',
        // F2: org-sweep assumes the dedicated read-only bbg-readiness-reader
        // role in each member (provisioned by the member StackSet), NOT the
        // AdministratorAccess OrganizationAccountAccessRole.
        READINESS_CROSS_ACCOUNT_ROLE: 'bbg-readiness-reader',
      },
    });
    // F2: pin a deterministic execution-role name so the member-account
    // bbg-readiness-reader trust policy (member-stackset-stack.ts) can pin
    // its Principal to this exact role ARN. Stage-prefixed so dev/prod in the
    // same account don't collide.
    (readiness.role!.node.defaultChild as iam.CfnRole).roleName = `${stagePrefix}-bbg-readiness`;
    // Result blobs live under the readiness/ prefix of the existing Athena
    // results bucket (KMS-encrypted with the project key).
    data.athenaResultsBucket.grantReadWrite(readiness);
    data.key.grantEncryptDecrypt(readiness);
    // Async self-invoke: POST /admin/readiness fires the run-mode worker.
    // Reference the function by its constructed ARN (not grantInvoke(self))
    // to avoid a Role->Function->Role circular dependency at synth.
    readiness.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:${stagePrefix}-bbg-api-readiness`,
        ],
      }),
    );
    // Read-only discovery permissions — the bedrock-attribution-audit
    // account-audit permission set plus the Bedrock list APIs the inventory
    // uses. These list/describe/get APIs have no resource-level scoping; the
    // wildcard is covered by the blanket AwsSolutions-IAM5 suppression in
    // bin/app.ts. No write/tag/delete actions anywhere (audit is read-only).
    readiness.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ce:GetCostAndUsage',
          'organizations:DescribeOrganization',
          'organizations:ListAccounts',
          'iam:ListRoles',
          'iam:ListUsers',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
          'iam:GetRolePolicy',
          'iam:ListUserPolicies',
          'iam:ListAttachedUserPolicies',
          'iam:GetUserPolicy',
          'iam:GetPolicy',
          'iam:GetPolicyVersion',
          'iam:ListUserTags',
          'iam:ListRoleTags',
          'bedrock:ListInferenceProfiles',
          'bedrock:ListProjects',
          'bedrock:ListAgents',
          'bedrock:ListKnowledgeBases',
          'bedrock:ListCustomModels',
          'bedrock:ListGuardrails',
          'bedrock:ListProvisionedModelThroughputs',
          'bedrock:ListTagsForResource',
          'bedrock:GetModelInvocationLoggingConfiguration',
          'cloudwatch:ListMetrics',
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
          'cloudtrail:DescribeTrails',
          'cloudtrail:GetEventSelectors',
          'bcm-data-exports:ListExports',
          'bcm-data-exports:GetExport',
        ],
        resources: ['*'],
      }),
    );
    // Org-mode auto-pivot: when BBG is deployed in an Organizations
    // management account, the audit assumes a read-only role into each member
    // account to sweep the org. F2: scoped to the dedicated read-only
    // bbg-readiness-reader role (provisioned by the member StackSet with
    // Describe/List/Get-only permissions), NOT the AdministratorAccess
    // OrganizationAccountAccessRole — a code-compromise here can't escalate to
    // org-wide admin. Must match READINESS_CROSS_ACCOUNT_ROLE above. In a
    // member-account deploy this grant is simply unused (no pivot happens).
    readiness.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/bbg-readiness-reader'],
      }),
    );

    const route = (path: string, method: apigwv2.HttpMethod, fn: lambda.IFunction): void => {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        authorizer,
        integration: new apigwv2Int.HttpLambdaIntegration(`${path}-${method}`, fn),
      });
    };

    // Admin routes.
    route('/admin/budgets', apigwv2.HttpMethod.GET, budgets);
    route('/admin/budgets', apigwv2.HttpMethod.POST, budgets);
    // principal + target are QUERY params (?principal=&target=), NOT path
    // segments: both embed an ARN (principal#arn:...:role/Name,
    // profile#arn:...:inference-profile/id) whose '/' the HTTP API decodes from
    // %2F back to '/' BEFORE route matching, so a single {principal}/{target}
    // path segment 404s for every role/user-ARN principal or profile#arn target.
    // Query values are not path-matched and reach the Lambda intact. (Same fix
    // as the activity route — see /admin/principal-activity below.)
    route('/admin/budget', apigwv2.HttpMethod.PUT, budgets);
    route('/admin/budget', apigwv2.HttpMethod.DELETE, budgets);
    route('/admin/budget/toggle', apigwv2.HttpMethod.POST, budgets);
    route('/admin/budget/release', apigwv2.HttpMethod.POST, budgets);
    // default-deny baseline config (master toggle + values).
    route('/admin/defaults', apigwv2.HttpMethod.GET, budgets);
    route('/admin/defaults', apigwv2.HttpMethod.PUT, budgets);
    // declarative manifest apply (with dry-run flag).
    route('/admin/budgets:apply', apigwv2.HttpMethod.POST, budgets);
    route('/admin/spend', apigwv2.HttpMethod.GET, spend);
    route('/admin/spend/trend', apigwv2.HttpMethod.GET, spend);
    route('/admin/spend/periods', apigwv2.HttpMethod.GET, spend);
    route('/admin/identities', apigwv2.HttpMethod.GET, identities);
    // per-principal activity. Principal is a QUERY param (?principal=),
    // not a path segment: an IAM principal is `principal#arn:aws:iam::...:role/Name`
    // and the ARN's `/` survives encoding as %2F, which API Gateway HTTP APIs
    // decode back to `/` BEFORE route matching — so a single `{principal}` path
    // segment 404s for any role/user ARN. Query values are not path-matched, so
    // they preserve the encoded slash and reach the Lambda intact.
    route('/admin/principal-activity', apigwv2.HttpMethod.GET, identities);
    // Central cross-principal activity feed (wildcard-only, byDay GSI). Same
    // Lambda + grant; grantReadData auto-extends to the table's indexes.
    route('/admin/activity', apigwv2.HttpMethod.GET, identities);
    // readiness page (async start/poll — see ReadinessApi above).
    route('/admin/readiness', apigwv2.HttpMethod.POST, readiness);
    route('/admin/readiness/{jobId}', apigwv2.HttpMethod.GET, readiness);
    route('/admin/inference-profiles', apigwv2.HttpMethod.GET, inferenceProfiles);
    route('/admin/regions', apigwv2.HttpMethod.GET, regions);
    route('/admin/agent-sessions', apigwv2.HttpMethod.GET, agentSessions);
    route('/admin/reports/query', apigwv2.HttpMethod.POST, reports);
    route('/admin/reports/{executionId}', apigwv2.HttpMethod.GET, reports);
    route('/admin/users', apigwv2.HttpMethod.GET, users);
    route('/admin/users', apigwv2.HttpMethod.POST, users);
    route('/admin/users/groups', apigwv2.HttpMethod.GET, users);
    route('/admin/users/{username}', apigwv2.HttpMethod.GET, users);
    route('/admin/users/{username}', apigwv2.HttpMethod.PUT, users);
    route('/admin/users/{username}', apigwv2.HttpMethod.DELETE, users);
    route('/admin/users/{username}/groups', apigwv2.HttpMethod.PUT, users);
    route('/admin/users/{username}/disable', apigwv2.HttpMethod.POST, users);
    route('/admin/users/{username}/enable', apigwv2.HttpMethod.POST, users);
    route('/admin/users/{username}/reset-password', apigwv2.HttpMethod.POST, users);
    route('/admin/pricing/overrides', apigwv2.HttpMethod.GET, pricingOverrides);
    route('/admin/pricing/overrides', apigwv2.HttpMethod.POST, pricingOverrides);
    // model via ?model= query param (a model id can contain '/'; path-segment matching would 404).
    route('/admin/pricing/override', apigwv2.HttpMethod.DELETE, pricingOverrides);
    // custom pricing discounts (per-account %), same Lambda + table.
    route('/admin/pricing/discounts', apigwv2.HttpMethod.GET, pricingOverrides);
    route('/admin/pricing/discounts', apigwv2.HttpMethod.POST, pricingOverrides);
    // Legacy account-scope delete (path param) + scope-aware delete (?scope=&scopeId=).
    route('/admin/pricing/discounts/{accountId}', apigwv2.HttpMethod.DELETE, pricingOverrides);
    route('/admin/pricing/discounts', apigwv2.HttpMethod.DELETE, pricingOverrides);
    // enrollment routes (super-admin only — handler-enforced).
    route('/admin/org/accounts', apigwv2.HttpMethod.GET, enrollment);
    route('/admin/org/account/{accountId}', apigwv2.HttpMethod.GET, enrollment);
    route('/admin/enrollment/config', apigwv2.HttpMethod.GET, enrollment);
    route('/admin/enrollment/config', apigwv2.HttpMethod.POST, enrollment);
    route('/admin/enrollment/status', apigwv2.HttpMethod.GET, enrollment);
    // preflight check.
    route('/admin/enrollment/preflight', apigwv2.HttpMethod.GET, enrollment);
    // an earlier change OU auto-deployment surface.
    route('/admin/enrollment/auto-deployment', apigwv2.HttpMethod.GET, enrollment);
    // audit log (super-admin only — handler-enforced).
    route('/admin/audit', apigwv2.HttpMethod.GET, audit);

    // User routes.
    route('/me/spend', apigwv2.HttpMethod.GET, spend);
    route('/me/spend/trend', apigwv2.HttpMethod.GET, spend);
    route('/me/spend/periods', apigwv2.HttpMethod.GET, spend);
    route('/me/budget', apigwv2.HttpMethod.GET, budgets);
    // BBG self-service activity — served by the identities Lambda (which already
    // has grantReadData on PrincipalActivity + the table env). Claim-derived
    // subject, no admin gate; see identities handler.
    route('/me/activity', apigwv2.HttpMethod.GET, identities);
    route('/me/passkey-nicknames', apigwv2.HttpMethod.GET, passkeyNicknames);
    route('/me/passkey-nicknames/{credentialId}', apigwv2.HttpMethod.PUT, passkeyNicknames);
    route('/me/passkey-nicknames/{credentialId}', apigwv2.HttpMethod.DELETE, passkeyNicknames);

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
  }
}
