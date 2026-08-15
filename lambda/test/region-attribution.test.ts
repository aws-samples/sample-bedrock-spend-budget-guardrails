import { describe, expect, it } from 'vitest';

/**
 * covers the contract for per-region attribution.
 *
 * - `region_<code>` attr names use underscores (DDB attribute names
 *   are aliased through ExpressionAttributeNames anyway, so hyphens
 *   would also work, but underscores avoid surprises in any later
 *   raw-DDB tooling that might enumerate attributes).
 * - The /admin/spend + /me/spend API decode `region_<code>` flat
 *   attrs into a `regions` map keyed by the canonical region code
 *   (`us-west-2`, `us-east-1`, ...).
 *
 * Both helpers are re-implemented here against the same contract so
 * we don't have to bootstrap SDK clients to test them.
 */

// --- meter side ---

/** Mirrors the meter's `region_<code>` attribute-name derivation. */
const regionAttrName = (region: string): string =>
  `region_${region.replace(/-/g, '_')}`;

describe('region attribute name shape', () => {
  it('replaces hyphens with underscores', () => {
    expect(regionAttrName('us-west-2')).toBe('region_us_west_2');
    expect(regionAttrName('us-east-1')).toBe('region_us_east_1');
    expect(regionAttrName('eu-central-1')).toBe('region_eu_central_1');
  });
  it('passes through codes without hyphens (defensive)', () => {
    // Theoretical — no real region code lacks a hyphen, but the
    // replace must not error if one ever did.
    expect(regionAttrName('local')).toBe('region_local');
  });
});

// --- /admin/spend side ---

/** Mirrors the spend API's collectRegions helper. */
const collectRegions = (row: Record<string, unknown>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('region_') && typeof v === 'number' && v > 0) {
      const code = k.slice('region_'.length).replace(/_/g, '-');
      out[code] = v;
    }
  }
  return out;
};

describe('collectRegions decode for /admin/spend', () => {
  it('decodes a multi-region row', () => {
    const row = {
      principal: 'principal#arn:aws:iam::1:user/alice',
      region_us_west_2: 1.2,
      region_us_east_1: 0.3,
      spendUsd: 1.5,
    };
    expect(collectRegions(row)).toEqual({
      'us-west-2': 1.2,
      'us-east-1': 0.3,
    });
  });

  it('returns an empty map for legacy rows (no region_* attrs)', () => {
    const row = {
      principal: 'principal#arn:aws:iam::1:user/bob',
      spendUsd: 2.0,
      cost_inputTokens: 1.0,
      cost_outputTokens: 1.0,
    };
    expect(collectRegions(row)).toEqual({});
  });

  it('skips region attrs whose value is 0 or non-number', () => {
    const row = {
      region_us_west_2: 0,
      region_us_east_1: 0.5,
      // bogus typed value — defensive
      region_us_east_2: 'not-a-number' as unknown as number,
    };
    expect(collectRegions(row)).toEqual({ 'us-east-1': 0.5 });
  });

  it('ignores attrs that look like region_* but are not numeric', () => {
    const row = {
      region_us_west_2: { nested: 'object' } as unknown as number,
    };
    expect(collectRegions(row)).toEqual({});
  });

  it('does not treat usage_/cost_ attrs as regions', () => {
    const row = {
      usage_inputTokens: 5000,
      cost_inputTokens: 0.015,
    };
    expect(collectRegions(row)).toEqual({});
  });
});
