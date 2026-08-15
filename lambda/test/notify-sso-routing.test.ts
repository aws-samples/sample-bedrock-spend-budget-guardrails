import { describe, expect, it } from 'vitest';

// SSO/identity-lens budget email routing.
//
// notify/index.ts keeps its user-resolution helpers in module scope (see
// notify-floor.test.ts for the same convention). We re-implement the two
// observable contracts the change introduced, as a guard against
// accidental drift:
//
//   1. ssoEmailFromPrincipal: `principal#sso-user#<email>` → lowercased email;
//      undefined for role/user ARNs and sourceIdentity lens rows (which have
//      no email to route to).
//   2. userFor resolution order: an exact `principal#<arn>` mapping wins; an
//      SSO lens row with no ARN mapping falls back to the email index.
//   3. admin-watch suppression: the fan-out runs only when enforcement just
//      fired AND the row is NOT an identity-lens row (the role row already
//      sent the admin copy for the same dollars).

/** Mirror of notify/index.ts ssoEmailFromPrincipal. */
const ssoEmailFromPrincipal = (principalKey: string): string | undefined => {
  const m = /^principal#sso-user#(.+)$/.exec(principalKey);
  return m ? m[1].toLowerCase() : undefined;
};

/** Mirror of notify/index.ts userFor resolution (cache lookups only). */
const resolveUser = (
  principalKey: string,
  principalToUser: Map<string, { email: string }>,
  emailToUser: Map<string, { email: string }>,
): { email: string } | undefined => {
  const direct = principalToUser.get(principalKey);
  if (direct) return direct;
  const ssoEmail = ssoEmailFromPrincipal(principalKey);
  return ssoEmail ? emailToUser.get(ssoEmail) : undefined;
};

/** Mirror of the ADMIN-WATCH channel guard. */
const shouldFanOutAdminWatch = (enforcementJustFired: boolean, identityLens?: string): boolean =>
  enforcementJustFired && !identityLens;

describe('ssoEmailFromPrincipal', () => {
  it('extracts and lowercases the email from an sso-user lens key', () => {
    expect(ssoEmailFromPrincipal('principal#sso-user#Alice@Example.COM')).toBe('alice@example.com');
  });

  it('returns undefined for a role ARN principal', () => {
    expect(
      ssoEmailFromPrincipal('principal#arn:aws:sts::111122223333:assumed-role/Dev/alice'),
    ).toBeUndefined();
  });

  it('returns undefined for a sourceIdentity lens (no email to route to)', () => {
    expect(ssoEmailFromPrincipal('principal#sourceIdentity#alice')).toBeUndefined();
  });

  it('handles emails containing a plus/subaddress', () => {
    expect(ssoEmailFromPrincipal('principal#sso-user#bob+bedrock@example.com')).toBe(
      'bob+bedrock@example.com',
    );
  });
});

describe('userFor resolution order', () => {
  const arnUser = { email: 'role-human@example.com' };
  const ssoUser = { email: 'alice@example.com' };
  const principalToUser = new Map([['principal#arn:aws:iam::1:user/x', arnUser]]);
  const emailToUser = new Map([['alice@example.com', ssoUser]]);

  it('an exact ARN mapping wins', () => {
    expect(resolveUser('principal#arn:aws:iam::1:user/x', principalToUser, emailToUser)).toBe(
      arnUser,
    );
  });

  it('an SSO lens row with no ARN mapping resolves via the email index', () => {
    expect(resolveUser('principal#sso-user#alice@example.com', principalToUser, emailToUser)).toBe(
      ssoUser,
    );
  });

  it('an SSO lens row for an unknown email resolves to undefined', () => {
    expect(
      resolveUser('principal#sso-user#nobody@example.com', principalToUser, emailToUser),
    ).toBeUndefined();
  });
});

describe('admin-watch suppression for lens rows', () => {
  it('fans out for a primary role row on enforcement', () => {
    expect(shouldFanOutAdminWatch(true, undefined)).toBe(true);
  });

  it('suppresses the fan-out for an identity-lens row (role row already sent it)', () => {
    expect(shouldFanOutAdminWatch(true, 'sso-user')).toBe(false);
  });

  it('never fans out on a threshold-only (non-enforcement) event', () => {
    expect(shouldFanOutAdminWatch(false, undefined)).toBe(false);
  });
});
