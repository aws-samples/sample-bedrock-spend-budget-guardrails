import { IAMClient } from '@aws-sdk/client-iam';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

/**
 * per-account IAM client cache. Home-account calls use the
 * Lambda's own role; cross-account calls use temporary credentials
 * obtained via sts:AssumeRole into the member account's
 * `bbg-enforcement` role. STS session credentials are valid for 1 hour
 * by default; we refresh ~5 minutes before expiry to avoid in-flight
 * failures.
 *
 * Used by both `enforcement` (Create/Attach) and `period-rollover` /
 * `api/budgets` (Detach/Delete) so they cooperate across accounts.
 */
const homeIam = new IAMClient({});
const sts = new STSClient({});

interface CachedClient {
  client: IAMClient;
  expiresAt: number;
}

const crossAccountClients = new Map<string, CachedClient>();
const CACHE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns an `IAMClient` scoped to the given account. For the home
 * account this is the Lambda's own role. For any other account it
 * assumes `arn:aws:iam::<accountId>:role/bbg-enforcement` and caches
 * the resulting client until ~5 minutes before credential expiry.
 */
export const iamForAccount = async (accountId: string): Promise<IAMClient> => {
  const homeAccount = process.env.AWS_ACCOUNT_ID;
  if (homeAccount && accountId === homeAccount) return homeIam;
  if (!accountId) return homeIam;

  const cached = crossAccountClients.get(accountId);
  if (cached && cached.expiresAt - Date.now() > CACHE_REFRESH_BUFFER_MS) {
    return cached.client;
  }

  const roleArn = `arn:aws:iam::${accountId}:role/bbg-enforcement`;
  const r = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `bbg-${Date.now()}`,
      DurationSeconds: 3600,
    }),
  );
  if (
    !r.Credentials?.AccessKeyId ||
    !r.Credentials.SecretAccessKey ||
    !r.Credentials.SessionToken ||
    !r.Credentials.Expiration
  ) {
    throw new Error(`AssumeRole ${roleArn} returned incomplete credentials`);
  }
  const client = new IAMClient({
    credentials: {
      accessKeyId: r.Credentials.AccessKeyId,
      secretAccessKey: r.Credentials.SecretAccessKey,
      sessionToken: r.Credentials.SessionToken,
    },
  });
  const expiresAt = new Date(r.Credentials.Expiration).getTime();
  crossAccountClients.set(accountId, { client, expiresAt });
  return client;
};

/**
 * Strictly derive the AWS account ID from a principal key/ARN. Matches
 * both `iam` ARNs (users/roles) and `sts` ARNs (assumed-role and
 * federated-user sessions — federated principals are stored as sts
 * ARNs, see shared/arn.ts), so a member account's federated spend is
 * attributed to its true account, never the home account. Returns
 * `undefined` for genuinely non-ARN principals (`principal#unknown`,
 * `principal#sso-user#...`, `sessionTag/...`).
 *
 * IMPORTANT — no home-account fallback here (it used to silently
 * return `process.env.AWS_ACCOUNT_ID`):
 *   - AUTHORIZATION sites (scopeAllows visibility / scope-guard
 *     checks) must fail CLOSED for non-ARN principals:
 *     `scopeAllows(scope, undefined)` matches no scope entry, so those
 *     rows are visible only to wildcard admins.
 *   - PLACEMENT sites (which account a deny policy is created or
 *     attached in) DO need the home account for Condition-only
 *     session-tag principals: apply an explicit
 *     `?? process.env.AWS_ACCOUNT_ID` AT THE CALL SITE (see
 *     enforcement/index.ts) so the fallback is visible and deliberate
 *     instead of inherited silently by every caller.
 */
export const accountFromPrincipal = (principal: string): string | undefined => {
  const match = /arn:aws:(?:iam|sts)::(\d+):/.exec(principal);
  return match ? match[1] : undefined;
};

/** Pull the AWS account ID out of a customer-managed IAM policy ARN. */
export const accountFromPolicyArn = (policyArn: string): string => {
  const match = /arn:aws:iam::(\d+):/.exec(policyArn);
  return match ? match[1] : (process.env.AWS_ACCOUNT_ID ?? '');
};
