/**
 * Canonicalizes a CloudTrail `userIdentity` block into a stable principal
 * key used as the partition key on Budgets and RunningSpend.
 *
 * Coverage matrix (per plan §1):
 *   - IAMUser           → arn:aws:iam::ACCT:user/<name>
 *   - AssumedRole (IAM) → arn:aws:iam::ACCT:role/<name>  (canonicalized
 *                          via sessionContext.sessionIssuer.arn)
 *   - SSO assumed-role  → both
 *                          arn:aws:iam::ACCT:role/aws-reserved/.../AWSReservedSSO_<...>
 *                          AND principal#sso-user#<email> (returned in
 *                          `extras.ssoUser`)
 *   - Bedrock Agent     → AWSService — caller is bedrock.amazonaws.com;
 *                          we record principal#agent-role#<roleArn> when
 *                          present in invokedBy/sessionIssuer.
 *   - Federated         → Falls back to the assumed-role canonicalization;
 *                          callers can additionally key by sessionTag/<key>.
 */

export type PrincipalType = 'IAMUser' | 'IAMRole' | 'SSO' | 'AgentService' | 'Federated' | 'Unknown';

export interface CloudTrailUserIdentity {
  type?: string;
  arn?: string;
  principalId?: string;
  invokedBy?: string;
  userName?: string;
  accountId?: string;
  sessionContext?: {
    sessionIssuer?: { type?: string; arn?: string; userName?: string };
    sourceIdentity?: string;
    attributes?: { [key: string]: string };
  };
}

export interface CanonicalPrincipal {
  /** Primary key written to RunningSpend.principal / Budgets.principal */
  principal: string;
  /** Caller-type tag for the UI's PrincipalBadge. */
  principalType: PrincipalType;
  /** SSO email parsed from session name when applicable, else undefined. */
  ssoUser?: string;
  /** Source identity (sts:SetSourceIdentity) when present. */
  sourceIdentity?: string;
}

const SSO_RESERVED_PREFIX = '/aws-reserved/sso.amazonaws.com/';

export const canonicalize = (ui: CloudTrailUserIdentity | undefined): CanonicalPrincipal => {
  if (!ui) {
    return { principal: 'principal#unknown', principalType: 'Unknown' };
  }

  const type = ui.type;
  const sourceIdentity = ui.sessionContext?.sourceIdentity;

  if (type === 'IAMUser') {
    if (ui.arn) {
      return {
        principal: `principal#${ui.arn}`,
        principalType: 'IAMUser',
        sourceIdentity,
      };
    }
  }

  if (type === 'AssumedRole') {
    const sessionIssuerArn = ui.sessionContext?.sessionIssuer?.arn;
    if (sessionIssuerArn?.includes(SSO_RESERVED_PREFIX)) {
      // SSO permission set assumption. Session name is typically the user's
      // email/UUID; principalId is `<RoleId>:<sessionName>`.
      const sessionName = ui.arn?.split('/').slice(-1)[0];
      return {
        principal: `principal#${sessionIssuerArn}`,
        principalType: 'SSO',
        ssoUser: sessionName,
        sourceIdentity,
      };
    }
    if (sessionIssuerArn) {
      return {
        principal: `principal#${sessionIssuerArn}`,
        principalType: 'IAMRole',
        sourceIdentity,
      };
    }
  }

  if (type === 'AWSService' || ui.invokedBy === 'bedrock.amazonaws.com') {
    const roleArn = ui.sessionContext?.sessionIssuer?.arn ?? ui.arn ?? 'unknown';
    return {
      principal: `principal#agent-role#${roleArn}`,
      principalType: 'AgentService',
      sourceIdentity,
    };
  }

  if (type === 'FederatedUser' || type === 'WebIdentityUser' || type === 'SAMLUser') {
    return {
      principal: `principal#${ui.arn ?? ui.principalId ?? 'federated-unknown'}`,
      principalType: 'Federated',
      sourceIdentity,
    };
  }

  return {
    principal: `principal#${ui.arn ?? ui.principalId ?? 'unknown'}`,
    principalType: 'Unknown',
    sourceIdentity,
  };
};

/**
 * Canonicalizes a raw ARN string from CUR's `line_item_iam_principal` to the
 * same form that {@link canonicalize} produces from CloudTrail's structured
 * `userIdentity` block. CUR carries the assumed-role session form
 * (`arn:aws:sts::ACCT:assumed-role/<Role>/<Session>`); BBG writes spend rows
 * keyed by the canonical role ARN (`arn:aws:iam::ACCT:role/<Role>`). Without
 * this normalization the reconciler treats every session as a distinct
 * principal and emits N false-positive deltas per role.
 *
 * Returns the input unchanged if it doesn't match the assumed-role shape
 * (IAM users, raw role ARNs, agent-role keys, federated user ARNs).
 */
const ASSUMED_ROLE_RE = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.+$/;

export const canonicalizeCurPrincipal = (raw: string): string => {
  const m = raw.match(ASSUMED_ROLE_RE);
  if (!m) return raw;
  const [, accountId, roleName] = m;
  if (roleName.startsWith('AWSReservedSSO_')) {
    // BBG's canonical SSO key is the full sessionIssuer ARN
    // (arn:aws:iam::ACCT:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_...).
    // CUR's line_item_iam_principal doesn't carry the region segment, so we
    // produce a best-effort match. SSO callers will still partially mismatch
    // until both sides converge — documented behavior.
    return `arn:aws:iam::${accountId}:role/aws-reserved/sso.amazonaws.com/${roleName}`;
  }
  return `arn:aws:iam::${accountId}:role/${roleName}`;
};

/**
 * Strips the CRIS regional prefix (`us.`, `eu.`, `apac.`, `ap.`) from a
 * Bedrock model ID so the meter can find the bare-model SKU in the
 * Pricing table. Cross-region inference profiles are billed at the
 * source-region rate using the bare modelId — verified 2026-05-13, no
 * separate CRIS pricing SKUs exist.
 *
 * `global.` is the exception to that verification: AWS DOES publish
 * distinct Global-routing SKUs (`*_Global` / `*-global-standard`) and for
 * several lineups (Anthropic frontier, OpenAI GPT-5.6) the Global rate
 * DIFFERS from the regional rate — so the routing mode must not be
 * discarded for pricing. The meter therefore also calls `routingModeOf`
 * on the same model id and passes the mode through to `computeCost`,
 * which prefers a `routingDimensions[mode]` rate when the Pricing row
 * carries one. This strip stays: the bare id remains the spend TARGET
 * key (`model#<bare>`) so budgets are per-model regardless of routing.
 */
export const stripCrisPrefix = (modelId: string): string =>
  modelId.replace(/^(us|eu|apac|ap|global)\./, '');

/**
 * Extracts the inference routing mode from a (possibly prefixed) Bedrock
 * model id: `global.anthropic.claude-opus-5` → `'global'`,
 * `us.anthropic.claude-fable-5` → `'us'`, bare ids → undefined.
 *
 * The mode is used as a key into a Pricing row's `routingDimensions` map.
 * Only modes with a genuinely different published rate ever have an entry
 * (today: `global`); every other mode falls back to the regional/default
 * dimensions, so passing `us`/`eu` through costs nothing.
 */
export const routingModeOf = (modelId: string): string | undefined =>
  /^(us|eu|apac|ap|global)\./.exec(modelId)?.[1];
