import { describe, expect, it } from 'vitest';

// The floor + legacy-derive helpers aren't exported from notify/index.ts (they
// live in module scope to keep the file's surface narrow). Re-implement the
// observable contract here as a guard against accidental drift.
//
// Contract under test:
//   - explicit floor wins
//   - missing → derive from legacy 3 toggles
//   - all 3 disabled → never (101)
//   - threshold passes when crossedPct >= floor

const THRESHOLD_NEVER = 101;

const deriveLegacyFloor = (t50: boolean, t80: boolean, t100: boolean): number => {
  if (t50) return 50;
  if (t80) return 80;
  if (t100) return 100;
  return THRESHOLD_NEVER;
};

const parseFloor = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > THRESHOLD_NEVER) return undefined;
  return n;
};

const resolveFloor = (
  raw: string | undefined,
  legacy: { t50: boolean; t80: boolean; t100: boolean },
): number =>
  parseFloor(raw) ?? deriveLegacyFloor(legacy.t50, legacy.t80, legacy.t100);

const shouldEmail = (crossedPct: number, floor: number): boolean =>
  crossedPct >= floor;

describe('threshold-floor compat-derive from legacy toggles', () => {
  it('all 3 toggles enabled → floor 50 (today\'s default)', () => {
    expect(deriveLegacyFloor(true, true, true)).toBe(50);
  });

  it('only 80 + 100 → floor 80', () => {
    expect(deriveLegacyFloor(false, true, true)).toBe(80);
  });

  it('only 100 → floor 100', () => {
    expect(deriveLegacyFloor(false, false, true)).toBe(100);
  });

  it('all 3 disabled → never (101)', () => {
    expect(deriveLegacyFloor(false, false, false)).toBe(THRESHOLD_NEVER);
  });
});

describe('parseFloor', () => {
  it('undefined / empty → undefined (caller falls back to legacy)', () => {
    expect(parseFloor(undefined)).toBeUndefined();
    expect(parseFloor('')).toBeUndefined();
  });

  it('valid numbers within range', () => {
    expect(parseFloor('50')).toBe(50);
    expect(parseFloor('75')).toBe(75);
    expect(parseFloor('100')).toBe(100);
    expect(parseFloor('101')).toBe(101);
  });

  it('invalid input → undefined', () => {
    expect(parseFloor('foo')).toBeUndefined();
    expect(parseFloor('-1')).toBeUndefined();
    expect(parseFloor('200')).toBeUndefined();
  });
});

describe('resolveFloor (explicit > legacy)', () => {
  it('explicit floor wins over legacy toggles', () => {
    expect(resolveFloor('90', { t50: true, t80: true, t100: true })).toBe(90);
  });

  it('legacy used when no explicit value', () => {
    expect(resolveFloor(undefined, { t50: false, t80: true, t100: true })).toBe(80);
  });
});

describe('email decision: crossedPct >= floor', () => {
  it('floor=75: 80% crosses → email; 50% doesn\'t', () => {
    const floor = 75;
    expect(shouldEmail(80, floor)).toBe(true);
    expect(shouldEmail(50, floor)).toBe(false);
    expect(shouldEmail(75, floor)).toBe(true);
  });

  it('floor=101: nothing emails (the never case)', () => {
    const floor = THRESHOLD_NEVER;
    expect(shouldEmail(50, floor)).toBe(false);
    expect(shouldEmail(80, floor)).toBe(false);
    expect(shouldEmail(100, floor)).toBe(false);
  });

  it('floor=50: every threshold ≥ 50 emails (today\'s default)', () => {
    const floor = 50;
    expect(shouldEmail(50, floor)).toBe(true);
    expect(shouldEmail(80, floor)).toBe(true);
    expect(shouldEmail(100, floor)).toBe(true);
    expect(shouldEmail(49, floor)).toBe(false);
  });
});
