import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import {
  callerIdentity,
  callerScope,
  isAdminScope,
  scopeAllows,
} from '../src/shared/api.js';

const eventWithClaims = (
  claims: Record<string, unknown>,
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    requestContext: {
      authorizer: { jwt: { claims } },
    },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('callerScope', () => {
  it('parses the bbg:scope claim as wildcard', () => {
    const s = callerScope(eventWithClaims({ 'bbg:scope': '["*"]' }));
    expect(s.isWildcard).toBe(true);
    expect(s.accounts).toEqual(['*']);
  });

  it('parses bbg:scope as a multi-account list', () => {
    const s = callerScope(
      eventWithClaims({ 'bbg:scope': '["111122223333","444455556666"]' }),
    );
    expect(s.isWildcard).toBe(false);
    expect(s.accounts).toEqual(['111122223333', '444455556666']);
  });

  it('returns empty scope when bbg:scope is empty array', () => {
    const s = callerScope(eventWithClaims({ 'bbg:scope': '[]' }));
    expect(s.isWildcard).toBe(false);
    expect(s.accounts).toEqual([]);
  });

  it('AUZ-2: legacy Admins group no longer grants wildcard scope', () => {
    const s = callerScope(eventWithClaims({ 'cognito:groups': ['Admins'] }));
    expect(s.isWildcard).toBe(false);
    expect(s.accounts).toEqual([]);
  });

  it('compat-fallback: BBG-Admin-Wildcard group → wildcard', () => {
    const s = callerScope(eventWithClaims({ 'cognito:groups': ['BBG-Admin-Wildcard'] }));
    expect(s.isWildcard).toBe(true);
  });

  it('compat-fallback: BBG-Admin-<accountId> → per-account', () => {
    const s = callerScope(
      eventWithClaims({ 'cognito:groups': ['BBG-Admin-111122223333', 'Users'] }),
    );
    expect(s.isWildcard).toBe(false);
    expect(s.accounts).toEqual(['111122223333']);
  });

  it('returns empty scope for a user with no admin groups', () => {
    const s = callerScope(eventWithClaims({ 'cognito:groups': ['Users'] }));
    expect(s.isWildcard).toBe(false);
    expect(s.accounts).toEqual([]);
  });

  it('handles malformed bbg:scope JSON by falling back to groups', () => {
    const s = callerScope(
      eventWithClaims({ 'bbg:scope': 'not-json', 'cognito:groups': ['BBG-Admin-Wildcard'] }),
    );
    expect(s.isWildcard).toBe(true);
  });

  it('handles bracketed-string serialization of cognito:groups', () => {
    const s = callerScope(eventWithClaims({ 'cognito:groups': '[BBG-Admin-Wildcard Users]' }));
    expect(s.isWildcard).toBe(true);
  });
});

describe('scopeAllows', () => {
  it('wildcard allows any account', () => {
    expect(scopeAllows({ accounts: ['*'], isWildcard: true }, '111122223333')).toBe(true);
    expect(scopeAllows({ accounts: ['*'], isWildcard: true }, '111122223333')).toBe(true);
  });

  it('per-account scope allows matching, denies non-matching', () => {
    const s = { accounts: ['111122223333'], isWildcard: false };
    expect(scopeAllows(s, '111122223333')).toBe(true);
    expect(scopeAllows(s, '999999999999')).toBe(false);
  });

  it('empty scope denies everything', () => {
    expect(scopeAllows({ accounts: [], isWildcard: false }, '111122223333')).toBe(false);
  });
});

describe('isAdminScope', () => {
  it('returns true for wildcard', () => {
    expect(isAdminScope({ accounts: ['*'], isWildcard: true })).toBe(true);
  });
  it('returns true for any per-account scope', () => {
    expect(isAdminScope({ accounts: ['111122223333'], isWildcard: false })).toBe(true);
  });
  it('returns false for empty scope', () => {
    expect(isAdminScope({ accounts: [], isWildcard: false })).toBe(false);
  });
});

describe('callerIdentity', () => {
  it('extracts sub and email', () => {
    const id = callerIdentity(
      eventWithClaims({ sub: 'abc-123', email: 'admin@example.com' }),
    );
    expect(id).toEqual({ sub: 'abc-123', email: 'admin@example.com' });
  });

  it('returns undefined fields when claims missing', () => {
    const id = callerIdentity(eventWithClaims({}));
    expect(id).toEqual({ sub: undefined, email: undefined });
  });
});
