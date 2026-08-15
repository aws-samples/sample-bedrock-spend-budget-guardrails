/**
 * G1 — identity-lens row contract.
 *
 * The meter writes a per-identity "lens" spend row alongside the primary
 * role-keyed row when the joined identity carries an SSO user or a
 * source-identity, so that `principal#sso-user#<email>` /
 * `principal#sourceIdentity#<value>` budgets meter (and enforcement can
 * attach the deny to the issuer role). `identityLensRows` is the pure
 * decision function; enforcement (G2) and the spend API/UI (G3) depend on
 * these EXACT key shapes + issuerPrincipal, so lock them here.
 */
import { describe, expect, it } from 'vitest';
import { identityLensRows } from '../src/meter/index';

const ROLE = 'principal#arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_Dev_abc';

describe('identityLensRows', () => {
  it('produces NO lens rows for a plain-role identity (no ssoUser/sourceIdentity)', () => {
    expect(identityLensRows({ principal: ROLE })).toEqual([]);
  });

  it('produces an sso-user lens row keyed by email, issuer = the role principal', () => {
    const rows = identityLensRows({ principal: ROLE, ssoUser: 'alice@example.com' });
    expect(rows).toEqual([
      {
        lensPrincipal: 'principal#sso-user#alice@example.com',
        identityLens: 'sso-user',
        issuerPrincipal: ROLE,
      },
    ]);
  });

  it('produces a source-identity lens row keyed by the value', () => {
    const rows = identityLensRows({ principal: ROLE, sourceIdentity: 'svc-abc' });
    expect(rows).toEqual([
      {
        lensPrincipal: 'principal#sourceIdentity#svc-abc',
        identityLens: 'source-identity',
        issuerPrincipal: ROLE,
      },
    ]);
  });

  it('produces BOTH lens rows when the identity carries both', () => {
    const rows = identityLensRows({
      principal: ROLE,
      ssoUser: 'alice@example.com',
      sourceIdentity: 'svc-abc',
    });
    expect(rows.map((r) => r.identityLens)).toEqual(['sso-user', 'source-identity']);
    // issuerPrincipal is always the role principal enforcement attaches to.
    expect(rows.every((r) => r.issuerPrincipal === ROLE)).toBe(true);
  });
});
