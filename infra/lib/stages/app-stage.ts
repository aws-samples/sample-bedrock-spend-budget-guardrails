import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NetworkAndAuthStack } from '../network-and-auth-stack.js';
import { CertStack } from '../cert-stack.js';
import { ConfigStack } from '../config-stack.js';
import { WafStack } from '../waf-stack.js';
import { DataStack } from '../data-stack.js';
import { PricingStack } from '../pricing-stack.js';
import { MeteringStack } from '../metering-stack.js';
import { EnforcementStack } from '../enforcement-stack.js';
import { ApiStack } from '../api-stack.js';
import { WebStack } from '../web-stack.js';
import { ObservabilityStack } from '../observability-stack.js';
import { CurStack } from '../cur-stack.js';
import { BudgetsActionStack } from '../budgets-action-stack.js';
import { GatewayStack } from '../gateway-stack.js';
import { MultiAgentStack } from '../multi-agent-stack.js';
import {
  MemberStackSetStack,
  type EnrolledMemberAccount,
  type EnrolledOrgAccount,
  type EnrolledOu,
  type EnrolledWholeOrg,
} from '../member-stackset-stack.js';

export interface AppStageProps extends cdk.StageProps {
  /** Stack-name prefix applied to every stack in this stage (e.g. `dev`, `prod`). */
  readonly stagePrefix: string;
}

/**
 * Composes the full Bedrock Budget Guard application as a CDK Stage so it can
 * be deployed directly (BBG_LOCAL=1) or through CDK Pipelines.
 */
export class AppStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);

    const { stagePrefix } = props;
    const node = this.node;

    // Context flags read at synth time.
    const enableGateway = node.tryGetContext('bbg:enableGateway') === true;
    const enableMultiAgent = node.tryGetContext('bbg:enableMultiAgent') === true;
    const enableBudgetsAction = node.tryGetContext('bbg:enableBudgetsAction') === true;
    const meteredRegions: string[] = node.tryGetContext('bbg:meteredRegions') ?? ['us-west-2'];
    // Per-stage enrollment: same shape as `bbg:domainNames` so dev and
    // prod can enroll different sets of member accounts (or in this
    // smoke-test case, only dev enrolls the test account because role
    // names like `bbg-enforcement` are stage-independent and would
    // collide if both stages tried to deploy into the same member).
    const enrolledMemberAccountsByStage =
      (node.tryGetContext('bbg:enrolledMemberAccounts') as
        | Record<string, EnrolledMemberAccount[]>
        | EnrolledMemberAccount[]
        | undefined) ?? {};
    const enrolledMemberAccounts: EnrolledMemberAccount[] = Array.isArray(
      enrolledMemberAccountsByStage,
    )
      ? // Legacy flat-array shape: applies to every stage. Kept for
        // back-compat with operators who haven't migrated to per-stage.
        enrolledMemberAccountsByStage
      : enrolledMemberAccountsByStage[stagePrefix] ?? [];
    // Org-targeted enrollment. Same per-stage shape.
    const enrolledOusByStage =
      (node.tryGetContext('bbg:enrolledOus') as
        | Record<string, EnrolledOu[]>
        | EnrolledOu[]
        | undefined) ?? {};
    const enrolledOus: EnrolledOu[] = Array.isArray(enrolledOusByStage)
      ? enrolledOusByStage
      : enrolledOusByStage[stagePrefix] ?? [];
    // in-Org account-list enrollment (SERVICE_MANAGED with
    // ACCOUNT_FILTER=INTERSECTION). Same per-stage shape.
    const enrolledOrgAccountsByStage =
      (node.tryGetContext('bbg:enrolledOrgAccounts') as
        | Record<string, EnrolledOrgAccount[]>
        | EnrolledOrgAccount[]
        | undefined) ?? {};
    const enrolledOrgAccounts: EnrolledOrgAccount[] = Array.isArray(enrolledOrgAccountsByStage)
      ? enrolledOrgAccountsByStage
      : enrolledOrgAccountsByStage[stagePrefix] ?? [];

    // whole-org enrollment (SERVICE_MANAGED with
    // ACCOUNT_FILTER=DIFFERENCE excluding home + extras). Per-stage map
    // OR a flat single value. Mutually exclusive with enrolledOus +
    // enrolledOrgAccounts (StackSet-level guard rethrows in
    // MemberStackSetStack constructor).
    const enrolledWholeOrgRaw = node.tryGetContext('bbg:enrolledWholeOrg') as
      | Record<string, EnrolledWholeOrg>
      | EnrolledWholeOrg
      | undefined;
    const isFlatWholeOrg = (
      v: Record<string, EnrolledWholeOrg> | EnrolledWholeOrg,
    ): v is EnrolledWholeOrg => Array.isArray((v as EnrolledWholeOrg).regions);
    let enrolledWholeOrg: EnrolledWholeOrg | undefined;
    if (enrolledWholeOrgRaw === undefined) {
      enrolledWholeOrg = undefined;
    } else if (isFlatWholeOrg(enrolledWholeOrgRaw)) {
      enrolledWholeOrg = enrolledWholeOrgRaw;
    } else {
      enrolledWholeOrg = enrolledWholeOrgRaw[stagePrefix];
    }

    // synth-time preflight. The pipeline previously crashed
    // 12 minutes in at prod-bbg-member-stackset.Deploy when an in-Org
    // account was placed in `enrolledMemberAccounts` (SELF_MANAGED,
    // requires per-member bootstrap CFN). Catch the misconfig at synth
    // so the operator sees the error in seconds instead of minutes.
    // Throws a real Error rather than `Annotations.of(this).addError`
    // because Stage-level annotations don't reliably abort synth.
    const orgAccountIds = node.tryGetContext('bbg:_orgAccountIds') as string[] | undefined;
    if (orgAccountIds && enrolledMemberAccounts.length > 0) {
      const orgSet = new Set(orgAccountIds);
      const inOrg = enrolledMemberAccounts.filter((m) => orgSet.has(m.accountId));
      if (inOrg.length > 0) {
        const ids = inOrg.map((m) => m.accountId).join(', ');
        throw new Error(
          `[${stagePrefix}] preflight: account(s) ${ids} are in this Organization but ` +
            `enrolled via bbg:enrolledMemberAccounts (SELF_MANAGED, requires the bootstrap CFN). ` +
            `Move them to bbg:enrolledOrgAccounts (SERVICE_MANAGED INTERSECTION, no bootstrap ` +
            `needed). See docs/multi-account-multi-region.md § 6.2.2.`,
        );
      }
    }
    const hostedZoneName = node.tryGetContext('bbg:hostedZoneName') as string | undefined;
    const hostedZoneId = node.tryGetContext('bbg:hostedZoneId') as string | undefined;
    const domainNames = (node.tryGetContext('bbg:domainNames') as Record<string, string> | undefined) ?? {};
    const domainName = domainNames[stagePrefix];
    const useDomain = Boolean(hostedZoneName && hostedZoneId && domainName);

    // 0. Wildcard ACM cert in us-east-1 for CloudFront. Only created when a
    //    domain is configured for this stage.
    let certStack: CertStack | undefined;
    if (useDomain) {
      certStack = new CertStack(this, 'Cert', {
        stackName: `${stagePrefix}-bbg-cert`,
        hostedZoneName: hostedZoneName!,
        hostedZoneId: hostedZoneId!,
        env: { account: props.env?.account, region: 'us-east-1' },
      });
    }

    // 0b. WAFv2 WebACL on prod CloudFront only (dev skipped to keep cost low).
    let wafStack: WafStack | undefined;
    if (stagePrefix === 'prod') {
      wafStack = new WafStack(this, 'Waf', {
        stackName: `${stagePrefix}-bbg-waf`,
        stagePrefix,
        env: { account: props.env?.account, region: 'us-east-1' },
      });
    }

    // 0c. AWS Config recorder + curated managed rules. Prod only because
    // Config is an account+region singleton; opt out via
    // bbg:disableConfigStack if Control Tower or Security Hub already
    // manages it.
    const disableConfig = node.tryGetContext('bbg:disableConfigStack') === true;
    if (stagePrefix === 'prod' && !disableConfig) {
      new ConfigStack(this, 'Config', {
        stackName: `${stagePrefix}-bbg-config`,
        stagePrefix,
      });
    }

    // 1. Auth (Cognito).
    const auth = new NetworkAndAuthStack(this, 'NetworkAndAuth', {
      stackName: `${stagePrefix}-bbg-auth`,
      stagePrefix,
      domainName,
    });

    // 2. Data plane (DynamoDB, S3, Glue, Athena).
    const data = new DataStack(this, 'Data', {
      stackName: `${stagePrefix}-bbg-data`,
      stagePrefix,
    });

    // 3. Pricing refresher (depends on data).
    const pricing = new PricingStack(this, 'Pricing', {
      stackName: `${stagePrefix}-bbg-pricing`,
      stagePrefix,
      data,
    });
    pricing.addDependency(data);

    // 4. Metering — one stack per metered region. Each MeteringStack
    // deploys in its corresponding metered region so the LogGroup +
    // Trail + Bedrock invocation-logging custom resource land where
    // Bedrock can write to them (Bedrock can only deliver invocation
    // logs to a same-region CloudWatch LogGroup; CWL subscription
    // filters to Lambda are same-region only).
    //
    // The Lambdas (meter / identity-cache / ledger-writer /
    // inference-profile-refresher) live in the metered region and
    // read+write the DataStack's DDB tables CROSS-REGION. DDB supports
    // cross-region reads/writes; latency adds ~10-50ms and you pay
    // inter-region data transfer. The DDB streams (consumed by
    // enforcement + ledger-writer + notify) stay in the home region
    // since they're co-located with their tables.
    //
    // For the single-region case (home region == metered region) this
    // is identical to the previous topology — no behavior change.
    const homeRegion = props.env?.region ?? cdk.Aws.REGION;
    let homeMetering: MeteringStack | undefined;
    for (const region of meteredRegions) {
      const isHomeRegion = region === homeRegion;
      const metering = new MeteringStack(this, `Metering-${region}`, {
        stackName: `${stagePrefix}-bbg-metering-${region}`,
        stagePrefix,
        data,
        meteredRegion: region,
        isHomeRegion,
        // Cross-region references so the metered stack can reference
        // home-region DDB table names / KMS key ARNs at synth time.
        crossRegionReferences: !isHomeRegion,
        env: {
          account: props.env?.account,
          region,
        },
      });
      metering.addDependency(data);
      metering.addDependency(pricing);
      if (isHomeRegion) homeMetering = metering;
    }

    // 5. Enforcement (DDB stream consumer + scheduler + notify).
    const enforcement = new EnforcementStack(this, 'Enforcement', {
      stackName: `${stagePrefix}-bbg-enforcement`,
      stagePrefix,
      data,
      auth,
      appUrl: domainName ? `https://${domainName}` : undefined,
    });
    enforcement.addDependency(data);
    enforcement.addDependency(auth);

    // 6. API (HTTP API + JWT authorizer + handlers).
    const api = new ApiStack(this, 'Api', {
      stackName: `${stagePrefix}-bbg-api`,
      stagePrefix,
      auth,
      data,
      meteredRegions,
      discountResolver: pricing.discountResolver,
    });
    api.addDependency(auth);
    api.addDependency(data);
    api.addDependency(pricing);

    // 6b. an earlier change Phase 2 — cross-account member-account roles.
    // Skipped when no enrollments at all (single-account mode).
    if (
      (enrolledMemberAccounts.length > 0 ||
        enrolledOus.length > 0 ||
        enrolledOrgAccounts.length > 0 ||
        enrolledWholeOrg) &&
      homeMetering?.meter
    ) {
      const memberStackSet = new MemberStackSetStack(this, 'MemberStackSet', {
        stackName: `${stagePrefix}-bbg-member-stackset`,
        stagePrefix,
        // All three home-account roles that need to assume into the
        // member's bbg-enforcement role: enforcement (create + attach),
        // period-rollover (detach + delete), budgets-api (release route).
        homeEnforcementRoleArns: [
          enforcement.enforcement.role!.roleArn,
          enforcement.periodRollover.role!.roleArn,
          api.budgetsApi.role!.roleArn,
        ],
        homeMeterRoleArn: homeMetering.meter.role!.roleArn,
        enrolledMemberAccounts,
        enrolledOus,
        enrolledOrgAccounts,
        enrolledWholeOrg,
        // ENF-1: Org ID for the bbg-enforcement trust `aws:PrincipalOrgID`
        // condition. Auto-detected into context by loadOperatorConfig
        // (operator-config `bbg:organizationId`).
        organizationId: this.node.tryGetContext('bbg:organizationId') as string | undefined,
      });
      memberStackSet.addDependency(enforcement);

      // Grant the home enforcement Lambda permission to assume the
      // bbg-enforcement role in every enrolled member account. For
      // Org-based enrollments (OU, in-Org account-list, OR whole-org —
      // all SERVICE_MANAGED) we use a wildcard since we don't know all
      // member accounts at synth time. The bbg-enforcement role's
      // trust policy still pins to the home Lambda role ARNs, so this
      // widening doesn't grant anything new outside the Org.
      const memberAccountIds = [
        ...enrolledMemberAccounts.map((m) => m.accountId),
        ...enrolledOrgAccounts.map((m) => m.accountId),
      ];
      const orgManaged =
        enrolledOus.length > 0 || enrolledOrgAccounts.length > 0 || enrolledWholeOrg !== undefined;
      const orgWideAssumeRole = orgManaged
        ? ['arn:aws:iam::*:role/bbg-enforcement']
        : [];

      // an earlier change/26/28: home-region default event bus must permit
      // events:PutEvents from each enrolled member account (and from
      // the whole Org when SERVICE_MANAGED enrollment is in use) so
      // the member account's CWL forwarder + Bedrock-API EventBridge
      // rule can deliver events to the home meter Lambda. The default
      // bus doesn't accept resource-policy via L2
      // EventBus.fromEventBusArn — use CfnEventBusPolicy directly.
      // Hosted on the home metering stack so it lands in the right
      // region (AppStage is a Stage, not a Stack — Stack.of(this)
      // would throw).
      const orgInfo = orgManaged
        ? this.node.tryGetContext('bbg:organizationId') as string | undefined
        : undefined;
      new events.CfnEventBusPolicy(homeMetering, 'HomeBusMemberPutEventsPolicy', {
        eventBusName: 'default',
        statementId: `${stagePrefix}-bbg-member-putevents`,
        statement: orgInfo
          ? {
              Effect: 'Allow',
              Principal: '*',
              Action: 'events:PutEvents',
              Resource: `arn:aws:events:${homeMetering.region}:${homeMetering.account}:event-bus/default`,
              Condition: { StringEquals: { 'aws:PrincipalOrgID': orgInfo } },
            }
          : {
              Effect: 'Allow',
              Principal: { AWS: memberAccountIds.map((id) => `arn:aws:iam::${id}:root`) },
              Action: 'events:PutEvents',
              Resource: `arn:aws:events:${homeMetering.region}:${homeMetering.account}:event-bus/default`,
            },
      });

      const memberEnforcementRoleArns = [
        ...memberAccountIds.map((id) => `arn:aws:iam::${id}:role/bbg-enforcement`),
        ...orgWideAssumeRole,
      ];
      enforcement.enforcement.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: memberEnforcementRoleArns,
        }),
      );
      // period-rollover detaches/deletes deny policies cross-account.
      enforcement.periodRollover.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: memberEnforcementRoleArns,
        }),
      );
      // The /admin/budgets release route also detaches cross-account.
      api.budgetsApi.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: memberEnforcementRoleArns,
        }),
      );
      // Same for the home meter Lambda (reserved for future use).
      homeMetering.meter.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [
            ...memberAccountIds.map((id) => `arn:aws:iam::${id}:role/bbg-meter-reader`),
            ...(orgManaged ? ['arn:aws:iam::*:role/bbg-meter-reader'] : []),
          ],
        }),
      );
    }

    // 7. CUR 2.0 reconciler (second source of truth).
    const cur = new CurStack(this, 'Cur', {
      stackName: `${stagePrefix}-bbg-cur`,
      stagePrefix,
      data,
    });
    cur.addDependency(data);

    // 8. Web (S3 + CloudFront, deploys after API and Auth so config.json is correct).
    const web = new WebStack(this, 'Web', {
      stackName: `${stagePrefix}-bbg-web`,
      stagePrefix,
      auth,
      api,
      domainName,
      certificate: certStack?.certificate,
      hostedZoneName,
      hostedZoneId,
      webAclArn: wafStack?.webAclArn,
    });
    web.addDependency(auth);
    web.addDependency(api);
    if (certStack) web.addDependency(certStack);
    if (wafStack) web.addDependency(wafStack);

    // 9. Observability (dashboards, alarms, canary).
    // Canary pings the custom domain when set, else the CloudFront URL (the Web
    // stack is created above, so its distribution domain is known here) — so a
    // no-domain deploy still gets synthetic uptime monitoring.
    const observability = new ObservabilityStack(this, 'Observability', {
      stackName: `${stagePrefix}-bbg-observability`,
      stagePrefix,
      data,
      canaryUrl: domainName
        ? `https://${domainName}/`
        : `https://${web.distribution.distributionDomainName}/`,
    });
    observability.addDependency(data);
    observability.addDependency(web);

    // 10. Optional: parallel CUR + Budgets enforcement channel
    // (defense-in-depth, ~24h trailing). Default off; the real-time
    // meter remains primary. See `docs/parallel-enforcement.md`.
    if (enableBudgetsAction) {
      const budgetsAction = new BudgetsActionStack(this, 'BudgetsAction', {
        stackName: `${stagePrefix}-bbg-budgets-action`,
        stagePrefix,
        data,
      });
      budgetsAction.addDependency(data);
    }

    // 11. Optional: gateway for end-user attribution through Bedrock Agents.
    if (enableGateway) {
      const gateway = new GatewayStack(this, 'Gateway', {
        stackName: `${stagePrefix}-bbg-gateway`,
        stagePrefix,
        auth,
        data,
      });
      gateway.addDependency(auth);
      gateway.addDependency(data);

      if (enableMultiAgent) {
        const multiAgent = new MultiAgentStack(this, 'MultiAgent', {
          stackName: `${stagePrefix}-bbg-multi-agent`,
          stagePrefix,
          gateway,
        });
        multiAgent.addDependency(gateway);
      }
    }

    // Tag every resource in the stage for cost allocation.
    cdk.Tags.of(this).add('Project', 'bbg');
    cdk.Tags.of(this).add('Stage', stagePrefix);
    cdk.Tags.of(this).add('CostCenter', 'bbg');
  }
}
