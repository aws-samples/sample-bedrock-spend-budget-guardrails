import {
  CloudFormationClient,
  DescribeOrganizationsAccessCommand,
  DescribeStackSetCommand,
  DescribeStacksCommand,
  ListStackInstancesCommand,
} from '@aws-sdk/client-cloudformation';
import {
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  DescribeAccountCommand,
  DescribeOrganizationCommand,
  ListAWSServiceAccessForOrganizationCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';
import {
  CodePipelineClient,
  StartPipelineExecutionCommand,
} from '@aws-sdk/client-codepipeline';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { callerIdentity, callerScope, json, parseBody, requireAdmin } from '../../shared/api.js';
import { emitAudit } from '../../shared/audit.js';
import { logger, metrics } from '../../shared/powertools.js';

const STAGE_PREFIX = process.env.STAGE_PREFIX!;
const OPERATOR_CONFIG_PARAM = process.env.OPERATOR_CONFIG_PARAM ?? '/bbg/operator-config';
const PIPELINE_NAME = process.env.PIPELINE_NAME ?? 'bbg-pipeline';
// follow-up: home account ID + the regions BBG meters in the
// home account itself (not via cross-account StackSet). The SPA renders
// this as an always-enrolled row so the operator doesn't see their
// own account marked "not enrolled" while it's actually being metered.
const HOME_ACCOUNT_ID = process.env.HOME_ACCOUNT_ID!;
const HOME_METERED_REGIONS = (process.env.HOME_METERED_REGIONS ?? 'us-west-2').split(',');

// Organizations is a global service in us-east-1.
const organizations = new OrganizationsClient({ region: 'us-east-1' });
const ssm = new SSMClient({});
const cfn = new CloudFormationClient({});
const codepipeline = new CodePipelineClient({});

interface OrgAccount {
  id: string;
  name: string;
  email?: string;
  status?: string;
  ouId?: string;
  ouName?: string;
}

/** Walk the Organizations tree from the root, returning every Account
 *  with its parent OU annotated. Tree is small (most orgs have <500
 *  accounts and <100 OUs); a single pass with paginated calls covers it. */
const listAllOrgAccounts = async (): Promise<{
  accounts: OrgAccount[];
  ous: { id: string; name: string; parentId: string }[];
  rootId: string;
}> => {
  const roots = await organizations.send(new ListRootsCommand({}));
  const rootId = roots.Roots?.[0]?.Id;
  if (!rootId) throw new Error('No Organization root found');

  const ous: { id: string; name: string; parentId: string }[] = [];
  const accounts: OrgAccount[] = [];

  const walk = async (parentId: string, parentName: string): Promise<void> => {
    // Accounts directly under this parent.
    let acctToken: string | undefined;
    do {
      const r = await organizations.send(
        new ListAccountsForParentCommand({ ParentId: parentId, NextToken: acctToken }),
      );
      for (const a of r.Accounts ?? []) {
        if (!a.Id || !a.Name) continue;
        accounts.push({
          id: a.Id,
          name: a.Name,
          email: a.Email,
          status: a.Status,
          ouId: parentId,
          ouName: parentName,
        });
      }
      acctToken = r.NextToken;
    } while (acctToken);

    // Recurse into child OUs.
    let ouToken: string | undefined;
    do {
      const r = await organizations.send(
        new ListOrganizationalUnitsForParentCommand({ ParentId: parentId, NextToken: ouToken }),
      );
      for (const ou of r.OrganizationalUnits ?? []) {
        if (!ou.Id || !ou.Name) continue;
        ous.push({ id: ou.Id, name: ou.Name, parentId });
        await walk(ou.Id, ou.Name);
      }
      ouToken = r.NextToken;
    } while (ouToken);
  };

  await walk(rootId, 'Root');
  return { accounts, ous, rootId };
};

interface ConfigShape {
  /** External accounts (not in this Org) — SELF_MANAGED StackSet,
   *  requires per-member AWSCloudFormationStackSetExecutionRole. */
  enrolledMemberAccounts: { accountId: string; regions: string[] }[];
  /** In-Org accounts — SERVICE_MANAGED StackSet with
   *  ACCOUNT_FILTER=INTERSECTION targeting specific account IDs.
   *  Requires StackSets trusted access; no per-member bootstrap. */
  enrolledOrgAccounts: { accountId: string; regions: string[] }[];
  /** OUs — SERVICE_MANAGED StackSet with auto-deployment.
   *  Accounts joining the OU later auto-receive the member stack. */
  enrolledOus: { ouId: string; regions: string[] }[];
  /** whole-org enrollment — SERVICE_MANAGED StackSet targeting
   *  the Org root with ACCOUNT_FILTER=DIFFERENCE excluding the home
   *  account (always) + optional extras. autoDeployment.enabled=true.
   *  Mutually exclusive with enrolledOus + enrolledOrgAccounts. */
  enrolledWholeOrg?: { regions: string[]; excludeAccountIds?: string[] };
  /** Home-account metered regions (`bbg:meteredRegions`). NOT a
   *  cross-account StackSet enrollment — each region here gets an
   *  in-account MeteringStack on the next pipeline deploy. undefined
   *  means "not configured in SSM; the deployed HOME_METERED_REGIONS
   *  env-var value stands (cdk.json fallback)". */
  meteredRegions?: string[];
}

const readOperatorConfig = async (): Promise<ConfigShape> => {
  const r = await ssm.send(new GetParameterCommand({ Name: OPERATOR_CONFIG_PARAM }));
  const raw = r.Parameter?.Value ?? '{}';
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const accountsRaw = parsed['bbg:enrolledMemberAccounts'];
  const orgAccountsRaw = parsed['bbg:enrolledOrgAccounts'];
  const ousRaw = parsed['bbg:enrolledOus'];
  const wholeOrgRaw = parsed['bbg:enrolledWholeOrg'];
  // Normalize either flat-array or per-stage-map shape down to the
  // current stage's list. Returning the operator's config rather than
  // some BBG canonical projection keeps the write-back path simple.
  const normalize = <T>(input: unknown): T[] => {
    if (Array.isArray(input)) return input as T[];
    if (input && typeof input === 'object') {
      const stageKey = STAGE_PREFIX;
      const v = (input as Record<string, T[]>)[stageKey];
      return Array.isArray(v) ? v : [];
    }
    return [];
  };
  // whole-org has a single-object shape (not an array). Either
  // a flat object that applies to every stage, or a per-stage map.
  const normalizeWholeOrg = (
    input: unknown,
  ): ConfigShape['enrolledWholeOrg'] => {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.regions)) {
      return obj as ConfigShape['enrolledWholeOrg'];
    }
    const v = obj[STAGE_PREFIX];
    if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).regions)) {
      return v as ConfigShape['enrolledWholeOrg'];
    }
    return undefined;
  };
  // bbg:meteredRegions is a flat string[] shared across stages (matches
  // its cdk.json shape). Absent from SSM => undefined (the deployed
  // HOME_METERED_REGIONS env var / cdk.json fallback is authoritative).
  const meteredRaw = parsed['bbg:meteredRegions'];
  const meteredRegions = Array.isArray(meteredRaw)
    ? (meteredRaw as unknown[]).filter((r): r is string => typeof r === 'string')
    : undefined;
  return {
    enrolledMemberAccounts: normalize(accountsRaw),
    enrolledOrgAccounts: normalize(orgAccountsRaw),
    enrolledOus: normalize(ousRaw),
    enrolledWholeOrg: normalizeWholeOrg(wholeOrgRaw),
    meteredRegions,
  };
};

const writeOperatorConfig = async (newConfig: ConfigShape): Promise<void> => {
  // Read existing JSON, mutate the two keys for this stage, write back.
  const r = await ssm.send(new GetParameterCommand({ Name: OPERATOR_CONFIG_PARAM }));
  const raw = r.Parameter?.Value ?? '{}';
  const existing = JSON.parse(raw) as Record<string, unknown>;

  // Preserve the operator's existing shape (per-stage map vs flat).
  // If they had a flat array, promote to per-stage map.
  const promoteToMap = (key: string, value: unknown[]): Record<string, unknown[]> => {
    const cur = existing[key];
    if (Array.isArray(cur)) {
      // Flat → per-stage map. Other stages get the original flat list
      // until they're explicitly written.
      return { [STAGE_PREFIX]: value, ...(STAGE_PREFIX === 'dev' ? { prod: cur } : { dev: cur }) };
    }
    if (cur && typeof cur === 'object') {
      return { ...(cur as Record<string, unknown[]>), [STAGE_PREFIX]: value };
    }
    return { [STAGE_PREFIX]: value };
  };

  existing['bbg:enrolledMemberAccounts'] = promoteToMap(
    'bbg:enrolledMemberAccounts',
    newConfig.enrolledMemberAccounts,
  );
  existing['bbg:enrolledOrgAccounts'] = promoteToMap(
    'bbg:enrolledOrgAccounts',
    newConfig.enrolledOrgAccounts,
  );
  existing['bbg:enrolledOus'] = promoteToMap('bbg:enrolledOus', newConfig.enrolledOus);

  // whole-org has a single-object value, not array. Same
  // per-stage promotion logic.
  const promoteWholeOrgToMap = (
    value: ConfigShape['enrolledWholeOrg'],
  ): Record<string, unknown> | undefined => {
    if (value === undefined) {
      // Operator cleared whole-org enrollment; preserve existing per-stage
      // shape but null out the current stage. If there's no existing
      // value, drop the key entirely.
      const cur = existing['bbg:enrolledWholeOrg'];
      if (!cur) return undefined;
      if (typeof cur === 'object' && !Array.isArray(cur) && !('regions' in (cur as object))) {
        const map = { ...(cur as Record<string, unknown>) };
        delete map[STAGE_PREFIX];
        return Object.keys(map).length === 0 ? undefined : map;
      }
      // Was flat — promote to per-stage and drop current stage.
      return { [STAGE_PREFIX === 'dev' ? 'prod' : 'dev']: cur };
    }
    const cur = existing['bbg:enrolledWholeOrg'];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      if ('regions' in (cur as object)) {
        // Was flat — promote to per-stage map.
        return {
          [STAGE_PREFIX]: value,
          ...(STAGE_PREFIX === 'dev' ? { prod: cur } : { dev: cur }),
        };
      }
      return { ...(cur as Record<string, unknown>), [STAGE_PREFIX]: value };
    }
    return { [STAGE_PREFIX]: value };
  };
  const wholeOrgMap = promoteWholeOrgToMap(newConfig.enrolledWholeOrg);
  if (wholeOrgMap === undefined) {
    delete existing['bbg:enrolledWholeOrg'];
  } else {
    existing['bbg:enrolledWholeOrg'] = wholeOrgMap;
  }

  // Home metered regions. Flat array shared across stages (matches its
  // cdk.json shape). Only written when the caller supplied a value — we
  // never delete the key (home must always meter ≥1 region; an absent
  // value means "leave the cdk.json fallback in charge").
  if (newConfig.meteredRegions !== undefined) {
    existing['bbg:meteredRegions'] = newConfig.meteredRegions;
  }

  await ssm.send(
    new PutParameterCommand({
      Name: OPERATOR_CONFIG_PARAM,
      Type: 'String',
      Value: JSON.stringify(existing, null, 2),
      Overwrite: true,
    }),
  );
};

/** an earlier change/32: each StackSet name → the deployment mode the SPA should
 *  display next to the per-instance status row. */
type StackSetSource =
  | 'self-managed-external'
  | 'service-managed-account'
  | 'service-managed-ou'
  | 'service-managed-whole-org';
const STACK_SETS: Array<{ name: string; source: StackSetSource }> = [
  { name: `${STAGE_PREFIX}-bbg-member-roles`, source: 'self-managed-external' },
  { name: `${STAGE_PREFIX}-bbg-member-roles-org-accounts`, source: 'service-managed-account' },
  { name: `${STAGE_PREFIX}-bbg-member-roles-org`, source: 'service-managed-ou' },
  { name: `${STAGE_PREFIX}-bbg-member-roles-whole-org`, source: 'service-managed-whole-org' },
];

const stackInstanceStatus = async (): Promise<
  { account: string; region: string; status?: string; reason?: string; source: StackSetSource }[]
> => {
  const out: {
    account: string;
    region: string;
    status?: string;
    reason?: string;
    source: StackSetSource;
  }[] = [];
  for (const { name: stackSetName, source } of STACK_SETS) {
    let nextToken: string | undefined;
    do {
      try {
        const r = await cfn.send(
          new ListStackInstancesCommand({ StackSetName: stackSetName, NextToken: nextToken }),
        );
        for (const s of r.Summaries ?? []) {
          out.push({
            account: s.Account ?? '',
            region: s.Region ?? '',
            status: s.StackInstanceStatus?.DetailedStatus ?? s.Status,
            reason: s.StatusReason,
            source,
          });
        }
        nextToken = r.NextToken;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === 'StackSetNotFoundException') break;
        throw err;
      }
    } while (nextToken);
  }
  return out;
};

interface AutoDeploymentInfo {
  stackSetName: string;
  enabled: boolean;
  retainStacksOnAccountRemoval: boolean;
  organizationalUnitIds: string[];
}

const describeAutoDeployment = async (stackSetName: string): Promise<AutoDeploymentInfo | null> => {
  try {
    const r = await cfn.send(new DescribeStackSetCommand({ StackSetName: stackSetName }));
    const ad = r.StackSet?.AutoDeployment;
    return {
      stackSetName,
      enabled: ad?.Enabled ?? false,
      retainStacksOnAccountRemoval: ad?.RetainStacksOnAccountRemoval ?? false,
      organizationalUnitIds: r.StackSet?.OrganizationalUnitIds ?? [],
    };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'StackSetNotFoundException') return null;
    throw err;
  }
};

/** an earlier change/32: surface the OU + whole-org StackSets' auto-deployment
 *  configuration so the SPA can render "auto-enrollment is on; new
 *  accounts will receive the member stack within ~10 min". Each field
 *  is null when its StackSet doesn't exist (no enrollment of that type
 *  yet). */
const stackSetAutoDeployment = async (): Promise<{
  ou: AutoDeploymentInfo | null;
  wholeOrg: AutoDeploymentInfo | null;
}> => ({
  ou: await describeAutoDeployment(`${STAGE_PREFIX}-bbg-member-roles-org`),
  wholeOrg: await describeAutoDeployment(`${STAGE_PREFIX}-bbg-member-roles-whole-org`),
});

// ---------------------------------------------------------------------------
// Home metered-regions support.
// ---------------------------------------------------------------------------

/** Authoritative Bedrock region list from the AWS-owned global-infrastructure
 *  SSM tree (same source as the /admin/regions endpoint). Used to validate
 *  that operator-submitted home regions actually support Bedrock. Falls back
 *  to permissive (return undefined => skip the membership check) on failure so
 *  a transient SSM error never blocks a legitimate config write. */
const BEDROCK_REGIONS_SSM_PATH = '/aws/service/global-infrastructure/services/bedrock/regions';
const fetchBedrockRegions = async (): Promise<Set<string> | undefined> => {
  try {
    const regions = new Set<string>();
    let nextToken: string | undefined;
    do {
      const r = await ssm.send(
        new GetParametersByPathCommand({ Path: BEDROCK_REGIONS_SSM_PATH, NextToken: nextToken }),
      );
      for (const p of r.Parameters ?? []) if (typeof p.Value === 'string' && p.Value) regions.add(p.Value);
      nextToken = r.NextToken;
    } while (nextToken);
    return regions.size > 0 ? regions : undefined;
  } catch {
    return undefined;
  }
};

/** Preflight: a home MeteringStack can only deploy into a region the home
 *  account has been `cdk bootstrap`-ed in — otherwise the pipeline fails
 *  mid-release. Check each candidate region for the CDKToolkit stack and
 *  return the ones that are NOT bootstrapped. A per-region client is created
 *  since CDKToolkit is a regional stack. */
const HOME_REGION = process.env.AWS_REGION ?? 'us-west-2';
const unbootstrappedRegions = async (regions: string[]): Promise<string[]> => {
  const missing: string[] = [];
  await Promise.all(
    regions.map(async (region) => {
      const client = new CloudFormationClient({ region });
      try {
        const r = await client.send(new DescribeStacksCommand({ StackName: 'CDKToolkit' }));
        const status = r.Stacks?.[0]?.StackStatus ?? '';
        if (!/COMPLETE$/.test(status)) missing.push(region);
      } catch (err) {
        // ValidationError => stack does not exist => not bootstrapped.
        // Any other error is treated as "can't confirm" => flag it so the
        // operator investigates rather than risking a mid-release failure.
        missing.push(region);
        logger.warn('CDKToolkit preflight failed for region', {
          region,
          err: (err as Error).message,
        });
      }
    }),
  );
  return missing;
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const scope = callerScope(event);
  // Org-level enrollment changes affect everything; super-admin only.
  if (!scope.isWildcard) {
    return json(403, { error: 'Forbidden: enrollment is super-admin only' });
  }
  const route = event.routeKey;
  logger.info('enrollment api', { route });

  if (route === 'GET /admin/enrollment/preflight') {
    // surface actionable errors before the operator hits Apply
    // and watches the pipeline fail. Three checks:
    //   1. Caller can DescribeOrganization (the deploy account is in
    //      an Org and has Organizations:* perms).
    //   2. StackSets trusted access enabled
    //      (member.org.stacksets.cloudformation.amazonaws.com).
    //   3. CloudFormation organizations-access activated
    //      (`aws cloudformation activate-organizations-access`).
    // For each failed check, we return the operator-facing fix command
    // so the SPA can render copy-paste guidance.
    const checks: Array<{
      id: string;
      label: string;
      status: 'ok' | 'fail';
      detail?: string;
      fix?: string;
    }> = [];

    let orgId: string | undefined;
    let masterAccountId: string | undefined;
    try {
      const r = await organizations.send(new DescribeOrganizationCommand({}));
      orgId = r.Organization?.Id;
      masterAccountId = r.Organization?.MasterAccountId;
      checks.push({ id: 'org', label: 'AWS Organization detected', status: 'ok' });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'AWSOrganizationsNotInUseException') {
        checks.push({
          id: 'org',
          label: 'AWS Organization detected',
          status: 'fail',
          detail: 'This account is not part of an AWS Organization. OU-based enrollment unavailable; per-account enrollment of external accounts still works.',
        });
      } else {
        checks.push({
          id: 'org',
          label: 'AWS Organization detected',
          status: 'fail',
          detail: (err as Error).message,
          fix: 'Grant the BBG enrollment Lambda role organizations:DescribeOrganization. If this is the management account, the role already has it — check the deploy.',
        });
      }
    }

    // Only run the next two checks if we're in an Org.
    if (orgId) {
      try {
        const r = await organizations.send(new ListAWSServiceAccessForOrganizationCommand({}));
        const enabled = (r.EnabledServicePrincipals ?? []).some(
          (p) => p.ServicePrincipal === 'member.org.stacksets.cloudformation.amazonaws.com',
        );
        checks.push({
          id: 'stacksets-trusted-access',
          label: 'StackSets trusted access enabled',
          status: enabled ? 'ok' : 'fail',
          detail: enabled ? undefined : 'Required for SERVICE_MANAGED StackSets (OU-targeted + in-Org account enrollment without per-member bootstrap).',
          fix: enabled
            ? undefined
            : 'aws organizations enable-aws-service-access --service-principal=member.org.stacksets.cloudformation.amazonaws.com',
        });
      } catch (err) {
        const name = (err as { name?: string }).name;
        const isPerm = name === 'AccessDeniedException';
        checks.push({
          id: 'stacksets-trusted-access',
          label: 'StackSets trusted access enabled',
          status: 'fail',
          detail: isPerm
            ? 'Caller lacks organizations:ListAWSServiceAccessForOrganization. The deploy account must be the Org management account or a delegated CloudFormation StackSets admin.'
            : (err as Error).message,
          fix: isPerm
            ? 'Run `aws organizations register-delegated-administrator --service-principal=member.org.stacksets.cloudformation.amazonaws.com --account-id=<DEPLOY_ACCOUNT>` from the management account.'
            : undefined,
        });
      }

      try {
        // CFN organizations-access; required separately from StackSets
        // trusted access — they're cousin features.
        const r = await cfn.send(new DescribeOrganizationsAccessCommand({}));
        // CFN's DescribeOrganizationsAccess.Status enum is ENABLED /
        // DISABLED / DISABLED_PERMANENTLY (per CFN docs). Cast through
        // unknown since the SDK type doesn't expose `Status` directly
        // when narrowed.
        const active = (r as { Status?: string }).Status === 'ENABLED';
        checks.push({
          id: 'cfn-organizations-access',
          label: 'CloudFormation organizations-access activated',
          status: active ? 'ok' : 'fail',
          detail: active
            ? undefined
            : `Status: ${r.Status ?? 'UNKNOWN'}. Required so the BBG home account can target OUs in StackSet operations.`,
          fix: active ? undefined : 'aws cloudformation activate-organizations-access',
        });
      } catch (err) {
        const name = (err as { name?: string }).name;
        const isPerm = name === 'AccessDeniedException';
        checks.push({
          id: 'cfn-organizations-access',
          label: 'CloudFormation organizations-access activated',
          status: 'fail',
          detail: isPerm
            ? 'Caller lacks cloudformation:DescribeOrganizationsAccess.'
            : (err as Error).message,
          fix: isPerm ? undefined : 'aws cloudformation activate-organizations-access',
        });
      }
    }

    return json(200, {
      organizationId: orgId,
      masterAccountId,
      isOrgMaster: orgId && masterAccountId === HOME_ACCOUNT_ID,
      checks,
      // Convenience: true when every check is OK (or no Org, in which
      // case OU enrollment isn't applicable and the SPA hides those
      // controls). The caller can render a single-line summary.
      ready:
        checks.every((c) => c.status === 'ok') ||
        // Single-account install (no Org) is also "ready" — just for a
        // narrower set of features.
        !orgId,
    });
  }

  if (route === 'GET /admin/org/accounts') {
    try {
      const { accounts, ous, rootId } = await listAllOrgAccounts();
      const org = await organizations.send(new DescribeOrganizationCommand({}));
      return json(200, {
        organizationId: org.Organization?.Id,
        masterAccountId: org.Organization?.MasterAccountId,
        // follow-up: surfaces the home account so the SPA can
        // render its always-enrolled row alongside the cross-account
        // enrollments.
        homeAccountId: HOME_ACCOUNT_ID,
        homeMeteredRegions: HOME_METERED_REGIONS,
        rootId,
        ous,
        accounts,
      });
    } catch (err) {
      logger.error('list org accounts failed', { err: (err as Error).message });
      const name = (err as { name?: string }).name;
      if (name === 'AWSOrganizationsNotInUseException') {
        return json(404, { error: 'No AWS Organization exists for this account' });
      }
      if (name === 'AccessDeniedException') {
        return json(
          403,
          { error: 'Caller lacks organizations:* permissions or the home account is not the Org management account / delegated admin' },
        );
      }
      throw err;
    }
  }

  if (route === 'GET /admin/org/account/{accountId}') {
    const accountId = decodeURIComponent(event.pathParameters?.accountId ?? '');
    if (!/^\d{12}$/.test(accountId)) return json(400, { error: 'accountId must be 12 digits' });
    const r = await organizations.send(new DescribeAccountCommand({ AccountId: accountId }));
    return json(200, {
      id: r.Account?.Id,
      name: r.Account?.Name,
      email: r.Account?.Email,
      status: r.Account?.Status,
    });
  }

  if (route === 'GET /admin/enrollment/config') {
    return json(200, await readOperatorConfig());
  }

  if (route === 'POST /admin/enrollment/config') {
    // auto-partition accounts. SPA sends a single
    // `enrolledAccounts` list (the operator picked them — they don't
    // care if the StackSet uses SELF_MANAGED or SERVICE_MANAGED
    // underneath). We split:
    //   - In-Org accounts → enrolledOrgAccounts (SERVICE_MANAGED, no
    //     per-member bootstrap)
    //   - External accounts → enrolledMemberAccounts (SELF_MANAGED,
    //     requires per-member AWSCloudFormationStackSetExecutionRole)
    // OUs route to enrolledOus (SERVICE_MANAGED + auto-deployment).
    //
    // For back-compat, the old shape (direct enrolledMemberAccounts +
    // enrolledOus from a manual SSM edit) still works — we don't
    // re-partition unless the SPA sends `enrolledAccounts`.
    interface PostBody extends ConfigShape {
      /** New SPA shape: single picked-accounts list. We
       *  partition server-side using the Org tree. */
      enrolledAccounts?: { accountId: string; regions: string[] }[];
      /** Home-account metered regions (`bbg:meteredRegions`). Optional —
       *  omitted => leave the current home-region config untouched. */
      homeMeteredRegions?: string[];
    }
    const body = parseBody<PostBody>(event);
    if (!body) return json(400, { error: 'Invalid body' });

    let toWrite: ConfigShape;
    if (Array.isArray(body.enrolledAccounts)) {
      // Auto-partition path. Look up the Org tree once.
      let orgAccountIds = new Set<string>();
      try {
        const { accounts } = await listAllOrgAccounts();
        orgAccountIds = new Set(accounts.map((a) => a.id));
      } catch (err) {
        // No Org or insufficient perms → treat every account as
        // external (SELF_MANAGED). Operator gets the bootstrap-CFN
        // friction, which is correct for non-Org installs.
        logger.warn('Org tree unavailable; treating every enrolled account as external', {
          err: (err as Error).message,
        });
      }
      const orgAccts: ConfigShape['enrolledOrgAccounts'] = [];
      const externalAccts: ConfigShape['enrolledMemberAccounts'] = [];
      for (const a of body.enrolledAccounts) {
        if (!/^\d{12}$/.test(a.accountId) || !Array.isArray(a.regions)) {
          return json(400, { error: `Invalid enrolled account: ${JSON.stringify(a)}` });
        }
        // Don't enroll the home account — it's metered locally.
        if (a.accountId === HOME_ACCOUNT_ID) continue;
        if (orgAccountIds.has(a.accountId)) orgAccts.push(a);
        else externalAccts.push(a);
      }
      toWrite = {
        enrolledMemberAccounts: externalAccts,
        enrolledOrgAccounts: orgAccts,
        enrolledOus: body.enrolledOus ?? [],
        enrolledWholeOrg: body.enrolledWholeOrg,
      };
    } else {
      // Legacy shape — operator passed pre-partitioned lists.
      if (
        !Array.isArray(body.enrolledMemberAccounts) ||
        !Array.isArray(body.enrolledOus)
      ) {
        return json(400, {
          error:
            'Either enrolledAccounts (auto-partitioned) OR both enrolledMemberAccounts + enrolledOus required',
        });
      }
      for (const a of body.enrolledMemberAccounts) {
        if (!/^\d{12}$/.test(a.accountId) || !Array.isArray(a.regions)) {
          return json(400, { error: `Invalid enrolled account: ${JSON.stringify(a)}` });
        }
      }
      toWrite = {
        enrolledMemberAccounts: body.enrolledMemberAccounts,
        enrolledOrgAccounts: body.enrolledOrgAccounts ?? [],
        enrolledOus: body.enrolledOus,
        enrolledWholeOrg: body.enrolledWholeOrg,
      };
    }

    for (const o of toWrite.enrolledOus) {
      if (!/^ou-[a-z0-9-]+$/.test(o.ouId) || !Array.isArray(o.regions)) {
        return json(400, { error: `Invalid enrolled OU: ${JSON.stringify(o)}` });
      }
    }

    // validate enrolledWholeOrg shape only. Mutual exclusion is
    // resolved at synth time by precedence (whole-org wins; per-OU and
    // per-account StackSets are skipped) so the operator can keep
    // their per-account selections in SSM while whole-org is active —
    // flipping whole-org off later restores the previous deployment
    // shape with no further edits.
    if (toWrite.enrolledWholeOrg) {
      const w = toWrite.enrolledWholeOrg;
      if (!Array.isArray(w.regions) || w.regions.length === 0) {
        return json(400, { error: 'enrolledWholeOrg.regions must be a non-empty array' });
      }
      if (w.excludeAccountIds && !w.excludeAccountIds.every((id) => /^\d{12}$/.test(id))) {
        return json(400, { error: 'enrolledWholeOrg.excludeAccountIds entries must be 12 digits' });
      }
      if (toWrite.enrolledOus.length > 0 || toWrite.enrolledOrgAccounts.length > 0) {
        logger.info(
          'enrolledWholeOrg is set; per-OU and per-account StackSets will be skipped at synth time',
          {
            ouCount: toWrite.enrolledOus.length,
            orgAccountCount: toWrite.enrolledOrgAccounts.length,
          },
        );
      }
    }

    // Home-account metered regions (bbg:meteredRegions). Optional — only
    // validated + written when the caller supplies them.
    if (body.homeMeteredRegions !== undefined) {
      const regions = body.homeMeteredRegions;
      if (!Array.isArray(regions) || regions.length === 0) {
        return json(400, { error: 'homeMeteredRegions must be a non-empty array' });
      }
      // Region-code shape check.
      const badShape = regions.filter((r) => !/^[a-z]{2}(-[a-z]+)+-\d$/.test(r));
      if (badShape.length > 0) {
        return json(400, { error: `Invalid region code(s): ${badShape.join(', ')}` });
      }
      // Bedrock-availability check (best-effort; skipped if the AWS region
      // tree is unreachable so a transient error never blocks a write).
      const bedrockRegions = await fetchBedrockRegions();
      if (bedrockRegions) {
        const noBedrock = regions.filter((r) => !bedrockRegions.has(r));
        if (noBedrock.length > 0) {
          return json(400, {
            error: `Region(s) do not support Amazon Bedrock: ${noBedrock.join(', ')}`,
          });
        }
      }
      // Force-include the home region — its MeteringStack hosts the
      // DDB-adjacent topology; the home account must always meter itself.
      const withHome = regions.includes(HOME_REGION) ? regions : [HOME_REGION, ...regions];
      toWrite.meteredRegions = withHome;
    }

    // Bootstrap preflight — INFORMATIONAL, not blocking. The pipeline's
    // Synth step auto-bootstraps every configured metered region before
    // deploying (scripts/bootstrap-metered-regions.mjs), so an
    // un-bootstrapped region no longer fails the release; it just adds
    // ~2 min. We still check so the SPA can tell the operator what will
    // happen. (The bootstrap POWER lives in the pipeline role, not this
    // Lambda — an API route able to create cfn-exec admin roles would be
    // an account-takeover primitive.)
    let bootstrapPending: string[] = [];
    if (toWrite.meteredRegions) {
      try {
        bootstrapPending = await unbootstrappedRegions(toWrite.meteredRegions);
      } catch {
        // Best-effort — the pipeline self-heals regardless.
      }
    }

    await writeOperatorConfig(toWrite);
    // Trigger pipeline so the StackSet update lands without operator
    // having to push a commit.
    let pipelineExecutionId: string | undefined;
    try {
      const r = await codepipeline.send(
        new StartPipelineExecutionCommand({ name: PIPELINE_NAME }),
      );
      pipelineExecutionId = r.pipelineExecutionId;
    } catch (err) {
      logger.warn('start-pipeline failed; operator can re-trigger manually', {
        err: (err as Error).message,
      });
    }
    emitAudit(callerIdentity(event), scope, {
      action: 'enrollment.update',
      targetAccountId: '*',
      detail: {
        externalAccountCount: toWrite.enrolledMemberAccounts.length,
        orgAccountCount: toWrite.enrolledOrgAccounts.length,
        ouCount: toWrite.enrolledOus.length,
        wholeOrg: toWrite.enrolledWholeOrg
          ? {
              regions: toWrite.enrolledWholeOrg.regions,
              excludeCount: toWrite.enrolledWholeOrg.excludeAccountIds?.length ?? 0,
            }
          : null,
        homeMeteredRegions: toWrite.meteredRegions ?? null,
        bootstrapPending,
        pipelineExecutionId,
      },
    });
    metrics.publishStoredMetrics();
    return json(200, {
      ok: true,
      pipelineExecutionId,
      homeMeteredRegions: toWrite.meteredRegions,
      // Regions the pipeline will auto-bootstrap before deploying (adds
      // ~2 min each). Purely informational — nothing for the operator to do.
      bootstrapPending,
      partition: {
        externalAccounts: toWrite.enrolledMemberAccounts.map((a) => a.accountId),
        orgAccounts: toWrite.enrolledOrgAccounts.map((a) => a.accountId),
        ous: toWrite.enrolledOus.map((o) => o.ouId),
      },
    });
  }

  if (route === 'GET /admin/enrollment/status') {
    return json(200, { instances: await stackInstanceStatus() });
  }

  if (route === 'GET /admin/enrollment/auto-deployment') {
    // an earlier change/32: surface OU + whole-org StackSet auto-deployment config.
    return json(200, await stackSetAutoDeployment());
  }

  return json(404, { error: `Unknown route: ${route}` });
};
