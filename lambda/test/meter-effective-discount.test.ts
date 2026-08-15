/**
 * effectiveDiscountFromRow — the meter's money-path resolution of a discount
 * row into the % applied to metered spend. Prefers the resolver-materialized
 * effectivePct (OU/org inheritance) over the account's authored discountPct,
 * and treats an explicit account exclusion (authored 0, no effectivePct) as
 * list price. This is the one line that decides what a customer is charged, so
 * it gets direct coverage.
 */
import { describe, expect, it } from 'vitest';
import { effectiveDiscountFromRow } from '../src/meter/index';

describe('effectiveDiscountFromRow', () => {
  it('prefers a valid materialized effectivePct (OU/org inheritance) over authored', () => {
    // Account authored 40, but the resolver materialized 30 (an OU it inherits)
    // — wait: account beats OU, so the resolver would write 40 as effectivePct.
    // Here we assert the PREFERENCE mechanic directly: effectivePct wins.
    expect(effectiveDiscountFromRow({ effectivePct: 30, discountPct: 40 })).toBe(30);
  });

  it('falls back to authored discountPct when no effectivePct materialized yet', () => {
    expect(effectiveDiscountFromRow({ discountPct: 25 })).toBe(25);
  });

  it('an explicit account exclusion (authored 0, no effectivePct) → 0 (list price)', () => {
    // The resolver clears effectivePct for excluded accounts, so the row is
    // {discountPct: 0}. Must NOT inherit any discount.
    expect(effectiveDiscountFromRow({ discountPct: 0 })).toBe(0);
  });

  it('missing row → 0 (list price)', () => {
    expect(effectiveDiscountFromRow(undefined)).toBe(0);
    expect(effectiveDiscountFromRow({})).toBe(0);
  });

  it('out-of-range values are ignored (defensive: no negative or >100% charge swing)', () => {
    expect(effectiveDiscountFromRow({ effectivePct: 150 })).toBe(0); // >100 ignored
    expect(effectiveDiscountFromRow({ effectivePct: -10, discountPct: 20 })).toBe(20); // bad effective → authored
    expect(effectiveDiscountFromRow({ effectivePct: 0, discountPct: 20 })).toBe(20); // 0 effective → authored
  });

  it('a materialized effectivePct of 100 is honored (fully free tier)', () => {
    expect(effectiveDiscountFromRow({ effectivePct: 100 })).toBe(100);
  });
});
