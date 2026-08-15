/**
 * shared/discounts.ts — hierarchical custom-pricing-discount keys + precedence.
 * The precedence resolver is the heart of org/OU discounts; these tests pin the
 * most-specific-wins semantics and the reserved-key round-trips.
 */
import { describe, expect, it } from 'vitest';
import {
  discountKey,
  isDiscountKey,
  isValidPct,
  isValidScopeId,
  parseDiscountKey,
  resolveEffectiveDiscount,
  type DiscountPolicies,
} from '../src/shared/discounts';

describe('discount key round-trip', () => {
  it('builds + parses each scope', () => {
    expect(discountKey('account', '123456789012')).toBe('discount#123456789012');
    expect(discountKey('ou', 'ou-ab12-cdef3456')).toBe('discount#ou#ou-ab12-cdef3456');
    expect(discountKey('org', 'o-abc123defg')).toBe('discount#org#o-abc123defg');
    expect(parseDiscountKey('discount#123456789012')).toEqual({ scope: 'account', scopeId: '123456789012' });
    expect(parseDiscountKey('discount#ou#ou-ab12-cdef3456')).toEqual({ scope: 'ou', scopeId: 'ou-ab12-cdef3456' });
    expect(parseDiscountKey('discount#org#o-abc123defg')).toEqual({ scope: 'org', scopeId: 'o-abc123defg' });
  });

  it('the org root as an OU keeps the ou scope', () => {
    expect(parseDiscountKey('discount#ou#r-ab12')).toEqual({ scope: 'ou', scopeId: 'r-ab12' });
  });

  it('isDiscountKey excludes real model rows', () => {
    expect(isDiscountKey('discount#123456789012')).toBe(true);
    expect(isDiscountKey('anthropic.claude-sonnet')).toBe(false);
    expect(parseDiscountKey('anthropic.claude-sonnet')).toBeUndefined();
  });
});

describe('scope id + pct validation', () => {
  it('account = 12 digits', () => {
    expect(isValidScopeId('account', '123456789012')).toBe(true);
    expect(isValidScopeId('account', '12345')).toBe(false);
    expect(isValidScopeId('account', 'ou-x')).toBe(false);
  });
  it('ou = ou- or root r-', () => {
    expect(isValidScopeId('ou', 'ou-ab12-cdef3456')).toBe(true);
    expect(isValidScopeId('ou', 'r-ab12')).toBe(true);
    expect(isValidScopeId('ou', 'o-abc123')).toBe(false);
  });
  it('org = o-', () => {
    expect(isValidScopeId('org', 'o-abc123defg')).toBe(true);
    expect(isValidScopeId('org', 'ou-x')).toBe(false);
  });
  it('pct is (0,100]', () => {
    expect(isValidPct(25)).toBe(true);
    expect(isValidPct(100)).toBe(true);
    expect(isValidPct(0)).toBe(false);
    expect(isValidPct(101)).toBe(false);
    expect(isValidPct(-5)).toBe(false);
    expect(isValidPct('25')).toBe(false);
    expect(isValidPct(NaN)).toBe(false);
  });
});

describe('resolveEffectiveDiscount — most-specific-wins', () => {
  const ORG = 'o-abc123defg';
  // Root r-root → ou-eng → ou-sandbox → account 111111111111
  const ouPath = ['r-root', 'ou-eng', 'ou-sandbox'];
  const acct = '111111111111';

  const policies = (over: Partial<DiscountPolicies>): DiscountPolicies => ({
    byAccount: new Map(),
    byOu: new Map(),
    ...over,
  });

  it('account beats OU and org', () => {
    const r = resolveEffectiveDiscount(
      acct,
      ouPath,
      policies({ byAccount: new Map([[acct, 40]]), byOu: new Map([['ou-eng', 20]]), org: 10 }),
      ORG,
    );
    expect(r).toEqual({ pct: 40, scope: 'account', scopeId: acct });
  });

  it('nearest (deepest) OU wins over a shallower OU', () => {
    const r = resolveEffectiveDiscount(
      acct,
      ouPath,
      policies({ byOu: new Map([['ou-eng', 20], ['ou-sandbox', 30]]), org: 10 }),
      ORG,
    );
    // ou-sandbox is the immediate parent (deepest) → 30.
    expect(r).toEqual({ pct: 30, scope: 'ou', scopeId: 'ou-sandbox' });
  });

  it('a shallower OU applies when the deeper OU has no policy', () => {
    const r = resolveEffectiveDiscount(acct, ouPath, policies({ byOu: new Map([['ou-eng', 20]]) }), ORG);
    expect(r).toEqual({ pct: 20, scope: 'ou', scopeId: 'ou-eng' });
  });

  it('the org root (as an OU) applies when no closer OU matches', () => {
    const r = resolveEffectiveDiscount(acct, ouPath, policies({ byOu: new Map([['r-root', 15]]) }), ORG);
    expect(r).toEqual({ pct: 15, scope: 'ou', scopeId: 'r-root' });
  });

  it('org-wide applies when nothing else matches', () => {
    const r = resolveEffectiveDiscount(acct, ouPath, policies({ org: 10 }), ORG);
    expect(r).toEqual({ pct: 10, scope: 'org', scopeId: ORG });
  });

  it('no policy anywhere → undefined (list price)', () => {
    expect(resolveEffectiveDiscount(acct, ouPath, policies({}), ORG)).toBeUndefined();
  });

  it('an explicit account EXCLUSION (0) wins over an OU/org discount → list price', () => {
    // The money-safety case: account authored 0 must NOT inherit ou-eng's 20%.
    const r = resolveEffectiveDiscount(
      acct,
      ouPath,
      policies({ byAccount: new Map([[acct, 0]]), byOu: new Map([['ou-eng', 20]]), org: 10 }),
      ORG,
    );
    expect(r).toBeUndefined(); // list price, and it short-circuited (didn't fall through to OU)
  });

  it('an account with an empty ouPath still resolves org-wide', () => {
    expect(resolveEffectiveDiscount(acct, [], policies({ org: 5 }), ORG)).toEqual({
      pct: 5,
      scope: 'org',
      scopeId: ORG,
    });
  });
});
