import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  DescribeOrganizationCommand,
  ListAccountsCommand,
  ListRootsCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';
import type { App } from 'aws-cdk-lib';

/**
 * Account-specific operator configuration that we don't want to commit to
 * a public repo. Loaded from a single SSM String parameter (JSON-encoded)
 * at synth time and pushed into CDK context so existing
 * `node.tryGetContext('bbg:...')` calls keep working unchanged.
 *
 * Bootstrap (one-time per account) — `cdk.context.example.json` holds the
 * minimal set that works when copied verbatim; add the optional keys from
 * docs/operator-config.md (domain, SES sender, CUR bucket, …) as needed:
 *
 *   aws ssm put-parameter \
 *     --name /bbg/operator-config \
 *     --type String \
 *     --value "$(cat cdk.context.example.json)"
 *
 * The parameter must live in the SAME account+region as the pipeline so
 * the pipeline's CodeBuild role can read it during synth. An admin-level
 * local deploying principal on the same account already has SSM read
 * access via its Admin policy.
 */
const PARAM_NAME = process.env.BBG_OPERATOR_CONFIG_PARAM ?? '/bbg/operator-config';

interface OperatorConfig {
  'bbg:githubOwner'?: string;
  /**
   * Regions where Bedrock invocations are metered. The FIRST entry should be
   * the home region (where all control-plane state lives). Any additional
   * region deploys a thin cross-region metering stack there AND causes CDK
   * Pipelines to create a cross-region "support" stack (replication bucket +
   * KMS) in that region — so EVERY region listed here (plus us-east-1, which
   * always hosts the CloudFront WAF/cert stacks) must be `cdk bootstrap`-ed
   * before deploying. Overrides the committed `cdk.json` default (home-only
   * `["us-west-2"]`). Also editable via the Enrollment UI, which writes it
   * back to this same SSM parameter. See docs/operator-config.md.
   */
  'bbg:meteredRegions'?: string[];
  'bbg:hostedZoneName'?: string;
  'bbg:hostedZoneId'?: string;
  'bbg:domainNames'?: Record<string, string>;
  'bbg:cognitoDomainPrefix'?: Record<string, string> | string;
  'bbg:additionalCorsOrigins'?: string[];
  'bbg:alertEmail'?: string;
  'bbg:disableConfigStack'?: boolean;
  /**
   * Months of RunningSpend history retained in DynamoDB (drives each spend
   * row's TTL). Default `13` (a year + the current month) so the Spend
   * Dashboard period selector reads back history. `0` ⇒ retain forever (no
   * TTL written). The S3 ledger is the permanent archive regardless, so
   * lowering this only bounds the hot DynamoDB store, not the audit trail.
   */
  'bbg:spendRetentionMonths'?: number;
  /**
   * SES-verified sender address used for budget-threshold and enforcement
   * emails sent to Cognito users whose `custom:iam_principal` matches a
   * principal whose budget is approaching or has been breached. Without
   * this set the notify Lambda no-ops with a warning.
   */
  'bbg:notifySenderAddress'?: string;
  /**
   * ops fallback recipient for budget emails about principals that
   * map to no Cognito human. IAM roles (and IAM users with no operator
   * account) frequently have no `custom:iam_principal` mapping, so their
   * threshold-warning emails would otherwise reach nobody and their
   * enforcement emails would reach only admin-watch subscribers (which may
   * be empty). When set to a verified SES address (or one under the
   * `bbg:notifySenderAddress` domain), notify also sends the threshold /
   * enforcement email for any unmapped principal to this mailbox. Unset ⇒
   * legacy behavior (unmapped principals only surface via admin-watch on
   * enforcement). Requires `bbg:notifySenderAddress` to be set.
   */
  'bbg:notifyOpsFallbackAddress'?: string;
  /**
   * ENF-2 kill-switch. When `true`, the enforcement Lambda skips
   * attaching NEW `bbg-deny-*` policies (it logs + emits an
   * `EnforcementPaused` metric and no-ops). Already-attached denies stay
   * put and period-rollover still detaches them normally — this only
   * stops the Lambda from applying new denies (e.g. during an incident
   * where a metering bug is over-denying org-wide). Default `false`.
   */
  'bbg:pauseEnforcement'?: boolean;
  /**
   * an earlier change Phase 2 multi-account: enrolled member accounts.
   *
   * Per-stage shape (recommended) — same shape as `bbg:domainNames`:
   *
   *   { "dev": [{ accountId, regions }], "prod": [...] }
   *
   * A given member account must only be enrolled by ONE stage (the
   * `bbg-enforcement` / `bbg-meter-reader` IAM role names aren't
   * stage-prefixed, so dev and prod can't both deploy roles into the
   * same member account).
   *
   * Legacy flat-array shape — `[{ accountId, regions }]` — is honored
   * for back-compat and applies to every stage.
   *
   * Default `{}` => single-account mode, no MemberStackSet deployed.
   */
  'bbg:enrolledMemberAccounts'?:
    | Record<string, Array<{ accountId: string; regions: string[] }>>
    | Array<{ accountId: string; regions: string[] }>;
  /**
   * an earlier change Org-wide enrollment. Per-stage map (or flat array) of
   * organizational-unit IDs. Deploys the member stack to every
   * account currently in the OU AND auto-deploys to any account
   * joining the OU later. Requires the home account to be the Org
   * management account (or a delegated CloudFormation StackSet
   * administrator) and `aws cloudformation activate-organizations-access`
   * + StackSets trusted access enabled in the Org.
   */
  'bbg:enrolledOus'?:
    | Record<string, Array<{ ouId: string; regions: string[] }>>
    | Array<{ ouId: string; regions: string[] }>;
  /**
   * follow-up: AWS Organizations ID of the home account's
   * Org. Used in the home-bus EventBusPolicy `aws:PrincipalOrgID`
   * condition when org-wide enrollment is in use, so any account in
   * the Org can `events:PutEvents` to the home bus.
   *
   * Auto-detected at synth time via `organizations:DescribeOrganization`
   * when not already in operator-config — customers don't need to
   * paste their `o-xxxxx` ID manually. Falls back to undefined when
   * the home account isn't in an Org or lacks Organizations:* perms,
   * which is correct for single-account installs.
   */
  'bbg:organizationId'?: string;
  /** Organizations Root ID, used as the SERVICE_MANAGED
   *  StackSet's `OrganizationalUnitIds` when targeting specific
   *  in-Org accounts via `accountFilterType=INTERSECTION`.
   *  Auto-detected at synth time alongside `bbg:organizationId`. */
  'bbg:organizationRootId'?: string;
  /** an earlier change (internal): cached list of every account ID currently in
   *  the home account's Organization. Populated at synth time alongside
   *  `bbg:organizationId` and consumed by `AppStage` to flag operators
   *  who put an in-Org account into `enrolledMemberAccounts` instead of
   *  `enrolledOrgAccounts`. Not a documented operator key. */
  'bbg:_orgAccountIds'?: string[];
}

let cached: OperatorConfig | undefined;

/**
 * Pulls operator config from SSM and merges it into the App's context. Safe
 * to call multiple times — the SSM fetch is memoized.
 *
 * Returns silently with an empty config when:
 *   - The SSM parameter doesn't exist yet (first-time bootstrap)
 *   - The caller has no AWS credentials (CI matrices, lint-only runs)
 *
 * In both cases stack construction may still fail later if a required
 * value is missing; the caller's error message tells the operator what
 * to put in the SSM document.
 */
export const loadOperatorConfig = async (app: App): Promise<void> => {
  if (cached === undefined) {
    cached = await fetchFromSsm();
    // follow-up: auto-detect the Organization ID when the
    // operator hasn't supplied one. Lets customers `cdk deploy` into
    // any Org-management account without manually editing SSM.
    if (cached['bbg:organizationId'] === undefined) {
      const detected = await detectOrganizationId();
      if (detected) cached['bbg:organizationId'] = detected;
    }
    if (cached['bbg:organizationRootId'] === undefined) {
      const root = await detectOrganizationRootId();
      if (root) cached['bbg:organizationRootId'] = root;
    }
    if (cached['bbg:_orgAccountIds'] === undefined && cached['bbg:organizationId']) {
      const ids = await detectOrgAccountIds();
      if (ids) cached['bbg:_orgAccountIds'] = ids;
    }
  }
  for (const [key, value] of Object.entries(cached)) {
    if (value !== undefined) {
      app.node.setContext(key, value);
    }
  }
};

/** Auto-detect the home account's Organization ID. Returns undefined
 *  when the account isn't in an Org or the caller lacks
 *  organizations:DescribeOrganization permission — both of which are
 *  correct for single-account installs. */
const detectOrganizationId = async (): Promise<string | undefined> => {
  // Organizations is a global service; us-east-1 is the canonical endpoint.
  const client = new OrganizationsClient({ region: 'us-east-1' });
  try {
    const r = await client.send(new DescribeOrganizationCommand({}));
    return r.Organization?.Id;
  } catch (err) {
    if (isExpectedOrgError(err)) return undefined;
    throw err;
  }
};

/** List every account ID in the Org. Paginated; returns
 *  undefined when the caller can't list accounts (delegated admin
 *  without the right perms, or single-account install). */
const detectOrgAccountIds = async (): Promise<string[] | undefined> => {
  const client = new OrganizationsClient({ region: 'us-east-1' });
  const ids: string[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const r = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
      for (const a of r.Accounts ?? []) {
        if (a.Id && a.Status === 'ACTIVE') ids.push(a.Id);
      }
      nextToken = r.NextToken;
    } while (nextToken);
    return ids;
  } catch (err) {
    if (isExpectedOrgError(err)) return undefined;
    throw err;
  }
};

/** Auto-detect the Organizations Root ID. Required for an earlier change's
 *  SERVICE_MANAGED + ACCOUNT_FILTER=INTERSECTION StackSet targeting. */
const detectOrganizationRootId = async (): Promise<string | undefined> => {
  const client = new OrganizationsClient({ region: 'us-east-1' });
  try {
    const r = await client.send(new ListRootsCommand({}));
    return r.Roots?.[0]?.Id;
  } catch (err) {
    if (isExpectedOrgError(err)) return undefined;
    throw err;
  }
};

const isExpectedOrgError = (err: unknown): boolean => {
  const name = (err as { name?: string }).name;
  return (
    name === 'AWSOrganizationsNotInUseException' ||
    name === 'AccessDeniedException' ||
    name === 'CredentialsProviderError' ||
    name === 'CredentialsError'
  );
};

const fetchFromSsm = async (): Promise<OperatorConfig> => {
  const region =
    process.env.CDK_DEFAULT_REGION ?? process.env.CDK_DEPLOY_REGION ?? process.env.AWS_REGION ?? 'us-west-2';
  const client = new SSMClient({ region });
  try {
    const r = await client.send(new GetParameterCommand({ Name: PARAM_NAME }));
    const raw = r.Parameter?.Value;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as OperatorConfig;
    } catch (err) {
      throw new Error(
        `Operator config in SSM ${PARAM_NAME} is not valid JSON: ${(err as Error).message}`,
      );
    }
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'ParameterNotFound') {
      console.warn(
        `[operator-config] SSM parameter ${PARAM_NAME} not found. Synth will proceed with whatever values are already in cdk.json.`,
      );
      return {};
    }
    if (name === 'CredentialsProviderError' || name === 'CredentialsError') {
      console.warn(
        `[operator-config] No AWS credentials available; skipping SSM-backed operator config.`,
      );
      return {};
    }
    throw err;
  }
};
