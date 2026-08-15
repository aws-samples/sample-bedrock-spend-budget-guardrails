import { describe, expect, it } from 'vitest';
import { accountFromPolicyArn, accountFromPrincipal } from '../src/shared/iam-cross-account.js';
import { scopeAllows } from '../src/shared/api.js';

describe('accountFromPrincipal', () => {
  it('extracts the account from a user ARN', () => {
    expect(accountFromPrincipal('arn:aws:iam::111122223333:user/alice')).toBe('111122223333');
  });

  it('extracts the account from a role ARN', () => {
    expect(accountFromPrincipal('arn:aws:iam::123456789012:role/some-role')).toBe('123456789012');
  });

  it('extracts the account from a principal#arn:aws:iam:: prefix used in spend rows', () => {
    expect(
      accountFromPrincipal('principal#arn:aws:iam::111122223333:user/alice'),
    ).toBe('111122223333');
  });

  it('extracts the member account from an sts assumed-role ARN', () => {
    expect(
      accountFromPrincipal('arn:aws:sts::444455556666:assumed-role/dev-role/session'),
    ).toBe('444455556666');
  });

  it('extracts the member account from an sts federated-user principal (shared/arn.ts form)', () => {
    expect(
      accountFromPrincipal('principal#arn:aws:sts::444455556666:federated-user/alice@example.com'),
    ).toBe('444455556666');
  });

  it('returns undefined for non-ARN principals — NO home-account fallback', () => {
    const prev = process.env.AWS_ACCOUNT_ID;
    process.env.AWS_ACCOUNT_ID = '999999999999';
    try {
      // Even with AWS_ACCOUNT_ID set, non-ARN principals must not be
      // attributed to the home account (that misattribution made a
      // home-scoped admin see member/unknown rows).
      expect(accountFromPrincipal('principal#unknown')).toBeUndefined();
      expect(accountFromPrincipal('principal#sso-user#alice@example.com')).toBeUndefined();
      expect(accountFromPrincipal('sessionTag/principal=alice@example.com')).toBeUndefined();
      expect(accountFromPrincipal('principal#some-symbolic-name')).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AWS_ACCOUNT_ID;
      else process.env.AWS_ACCOUNT_ID = prev;
    }
  });

  it('authorization visibility: non-ARN principals fail closed for scoped admins, visible to wildcard', () => {
    const homeScoped = { accounts: ['999999999999'], isWildcard: false };
    const wildcard = { accounts: ['*'], isWildcard: true };
    const acct = accountFromPrincipal('principal#unknown');
    // A home-account-scoped admin must NOT see the unattributable row...
    expect(scopeAllows(homeScoped, acct)).toBe(false);
    // ...but a wildcard super-admin still does.
    expect(scopeAllows(wildcard, acct)).toBe(true);
    // And an sts federated row is visible to the MEMBER account's admin,
    // not the home account's (the misattribution this fix addresses).
    const fedAcct = accountFromPrincipal(
      'principal#arn:aws:sts::444455556666:federated-user/alice@example.com',
    );
    expect(scopeAllows({ accounts: ['444455556666'], isWildcard: false }, fedAcct)).toBe(true);
    expect(scopeAllows(homeScoped, fedAcct)).toBe(false);
  });
});

describe('accountFromPolicyArn', () => {
  it('extracts the account from a customer-managed policy ARN', () => {
    expect(
      accountFromPolicyArn('arn:aws:iam::111122223333:policy/bbg-deny-foo-2026-05'),
    ).toBe('111122223333');
  });

  it('falls back to AWS_ACCOUNT_ID env when malformed', () => {
    const prev = process.env.AWS_ACCOUNT_ID;
    process.env.AWS_ACCOUNT_ID = '111111111111';
    try {
      expect(accountFromPolicyArn('not-an-arn')).toBe('111111111111');
    } finally {
      if (prev === undefined) delete process.env.AWS_ACCOUNT_ID;
      else process.env.AWS_ACCOUNT_ID = prev;
    }
  });
});
