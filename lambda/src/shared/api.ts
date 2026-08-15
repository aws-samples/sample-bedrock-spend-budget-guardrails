import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
  },
  body: JSON.stringify(body),
});

export const noContent = (): APIGatewayProxyResultV2 => ({
  statusCode: 204,
  headers: { 'access-control-allow-origin': '*' },
  body: '',
});

const claims = (event: APIGatewayProxyEventV2WithJWTAuthorizer) =>
  event.requestContext.authorizer.jwt.claims as Record<string, string | string[]>;

export const requireAdmin = (event: APIGatewayProxyEventV2WithJWTAuthorizer): boolean => {
  const c = claims(event);
  const groups = c['cognito:groups'];
  // API GW HTTP API JWT authorizer serializes array claims as either a real
  // JS array, a comma-separated string, or a bracketed-space-separated string
  // (`[Admins Users]`). Cover all three.
  if (Array.isArray(groups)) return groups.includes('Admins') || groups.includes('BBG-Admin-Wildcard') || groups.some((g) => g.startsWith('BBG-Admin-'));
  if (typeof groups === 'string') {
    const inner = groups.replace(/^\[(.*)\]$/, '$1');
    const parts = inner.split(/[\s,]+/).map((g) => g.trim()).filter(Boolean);
    return parts.includes('Admins') || parts.includes('BBG-Admin-Wildcard') || parts.some((g) => g.startsWith('BBG-Admin-'));
  }
  return false;
};

/**
 * per-account scope derived from the `bbg:scope` claim emitted
 * by the pre-token-gen V2 trigger. Empty scope = no admin
 * rights at all (read+write predicates fail closed). `accounts: ['*']`
 * = super-admin. Otherwise `accounts` is a list of 12-digit account IDs.
 *
 * Compat fallback: if `bbg:scope` is missing (in-flight users with
 * tokens minted before the trigger deployed), scope is derived directly
 * from `BBG-Admin-*` `cognito:groups` membership. (The legacy
 * `Admins`→wildcard mapping was retired — every admin is now in a
 * `BBG-Admin-*` group.)
 */
export interface CallerScope {
  readonly accounts: readonly string[];
  readonly isWildcard: boolean;
}

const ACCOUNT_GROUP_PREFIX = 'BBG-Admin-';

export const callerScope = (event: APIGatewayProxyEventV2WithJWTAuthorizer): CallerScope => {
  const c = claims(event);
  const raw = c['bbg:scope'];
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const ids = (parsed as unknown[]).filter((v): v is string => typeof v === 'string');
        if (ids.includes('*')) return { accounts: ['*'], isWildcard: true };
        return { accounts: ids, isWildcard: false };
      }
    } catch {
      /* fall through to legacy compat below */
    }
  }
  // Compat: a user signed in before the pre-token-gen trigger landed
  // won't have bbg:scope. Read directly from cognito:groups so they
  // keep working until their next token refresh.
  const groups = c['cognito:groups'];
  const list = Array.isArray(groups)
    ? groups
    : typeof groups === 'string'
    ? groups.replace(/^\[(.*)\]$/, '$1').split(/[\s,]+/).map((g) => g.trim()).filter(Boolean)
    : [];
  if (list.includes(`${ACCOUNT_GROUP_PREFIX}Wildcard`)) {
    return { accounts: ['*'], isWildcard: true };
  }
  const accounts = list
    .filter((g) => g.startsWith(ACCOUNT_GROUP_PREFIX))
    .map((g) => g.slice(ACCOUNT_GROUP_PREFIX.length))
    .filter((tail) => /^\d{12}$/.test(tail));
  return { accounts, isWildcard: false };
};

/** Returns true when the caller is allowed to operate on the given
 *  account ID. Super-admins (wildcard) always pass. Empty-scope users
 *  always fail. An unknown account (`undefined` — e.g. a non-ARN
 *  principal that `accountFromPrincipal` can't attribute) fails CLOSED
 *  for scoped admins: it can never match a scope entry, so such rows
 *  are visible only to wildcard admins. */
export const scopeAllows = (scope: CallerScope, accountId: string | undefined): boolean => {
  if (scope.isWildcard) return true;
  if (!accountId) return false;
  return scope.accounts.includes(accountId);
};

/** True when the caller has any admin rights at all (per-account or
 *  wildcard). Replaces the legacy `requireAdmin` boolean for routes
 *  that only need a coarse admin check (no per-account targeting). */
export const isAdminScope = (scope: CallerScope): boolean =>
  scope.isWildcard || scope.accounts.length > 0;

/**
 * F1: /me/* identity comes from the `bbg:principal` claim minted by the
 * pre-token-gen trigger out of the admin-owned `custom:iam_principal`
 * attribute — NOT the raw attribute claim, which used to be user-writable
 * and let a caller repoint their spend+budget views at a victim's ledger.
 * A missing claim (unmapped user, or an in-flight token minted before the
 * trigger deployed) fails closed to "no mapping" (undefined).
 */
export const callerPrincipalKey = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): string | undefined => {
  const c = claims(event);
  const arn = c['bbg:principal'] as string | undefined;
  return typeof arn === 'string' && arn ? `principal#${arn}` : undefined;
};

/**
 * The set of PrincipalActivity partition keys that belong to the signed-in
 * caller, derived ENTIRELY from signed JWT claims (no caller-supplied input),
 * for the self-service /me/activity view. Covers:
 *   - `principal#<arn>` from the admin-minted `bbg:principal` claim
 *   - `user#<cognito:username>` (the UUID Username) and `user#<sub>` fallback —
 *     THE canonical key: api/users now writes every user-lifecycle event
 *     (created/updated/disabled/enabled/deleted/groups/password-reset) here.
 *   - `user#<email>` — COMPATIBILITY read only: matches user.created rows
 *     written before api/users was fixed to key on the UUID. Safe to drop once
 *     the 1-year activity TTL has cycled past that fix's deploy date.
 *   - `principal#sso-user#<email>` (+ lowercased) — the meter's identity-lens key
 *
 * SECURITY: `email` is a self-writable Cognito attribute, so an email-derived
 * key is attacker-influenced (set email to a victim's, read their rows). Every
 * email-derived key is therefore gated on `email_verified === true`; Cognito
 * clears that flag on a self-service email change. `sourceIdentity#` lens rows
 * are not derivable from any claim and are intentionally out of scope.
 *
 * Returns `{ keys, mapped }` where `mapped` is true iff a `bbg:principal` claim
 * resolved (so the UI can distinguish "no IAM mapping" from "no activity yet").
 */
export const callerActivityKeys = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): { keys: string[]; mapped: boolean } => {
  const c = claims(event);
  const str = (k: string): string | undefined =>
    typeof c[k] === 'string' && (c[k] as string) ? (c[k] as string) : undefined;

  const keys = new Set<string>();
  const principalKey = callerPrincipalKey(event);
  if (principalKey) keys.add(principalKey);

  const username = str('cognito:username') ?? str('sub');
  if (username) keys.add(`user#${username}`);

  // The JWT authorizer serializes email_verified as the string 'true'/'false'.
  const emailVerified = c['email_verified'] === 'true';
  const email = str('email');
  if (email && emailVerified) {
    keys.add(`user#${email}`);
    keys.add(`principal#sso-user#${email}`);
    keys.add(`principal#sso-user#${email.toLowerCase()}`);
  }

  return { keys: [...keys], mapped: Boolean(principalKey) };
};

export interface CallerIdentity {
  readonly sub?: string;
  readonly email?: string;
}

/** Extract the caller's Cognito sub + email for audit stamping. */
export const callerIdentity = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): CallerIdentity => {
  const c = claims(event);
  return {
    sub: typeof c['sub'] === 'string' ? (c['sub'] as string) : undefined,
    email: typeof c['email'] === 'string' ? (c['email'] as string) : undefined,
  };
};

export const parseBody = <T>(event: APIGatewayProxyEventV2WithJWTAuthorizer): T | null => {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};
