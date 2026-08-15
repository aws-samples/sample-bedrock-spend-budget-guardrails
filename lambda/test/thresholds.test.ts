import { describe, expect, it } from 'vitest';
import {
  Threshold,
  ThresholdValidationError,
  blockThreshold,
  highestCrossedWarn,
  resolveThresholds,
  validateThresholds,
  warnPercents,
} from '../src/shared/thresholds.js';

describe('resolveThresholds — compat-read for legacy budget rows', () => {
  it('returns the explicit threshold list when present, sorted by `at`', () => {
    const out = resolveThresholds({
      thresholds: [
        { at: 100, action: 'block' },
        { at: 50, action: 'warn' },
      ],
    });
    expect(out.map((t) => t.at)).toEqual([50, 100]);
    expect(out.map((t) => t.action)).toEqual(['warn', 'block']);
  });

  it('falls back to default deny cadence when thresholds is undefined', () => {
    const out = resolveThresholds({ action: 'deny' });
    expect(out).toEqual([
      { at: 50, action: 'warn' },
      { at: 80, action: 'warn' },
      { at: 100, action: 'block' },
    ]);
  });

  it('falls back to all-warn cadence when action=alert', () => {
    const out = resolveThresholds({ action: 'alert' });
    expect(out.map((t) => t.action)).toEqual(['warn', 'warn', 'warn']);
  });

  it('treats an empty thresholds array the same as missing', () => {
    expect(resolveThresholds({ thresholds: [] })).toEqual(resolveThresholds({}));
  });

  it('defaults to deny cadence when neither thresholds nor action is set', () => {
    const out = resolveThresholds({});
    expect(blockThreshold(out)?.at).toBe(100);
  });
});

describe('warnPercents / blockThreshold', () => {
  const sample: Threshold[] = [
    { at: 50, action: 'warn' },
    { at: 80, action: 'warn' },
    { at: 100, action: 'block' },
  ];

  it('extracts only the warn percents', () => {
    expect(warnPercents(sample)).toEqual([50, 80]);
  });

  it('returns the block threshold when present', () => {
    expect(blockThreshold(sample)?.at).toBe(100);
  });

  it('returns undefined when there is no block threshold (alert-only)', () => {
    expect(blockThreshold([{ at: 50, action: 'warn' }])).toBeUndefined();
  });
});

describe('highestCrossedWarn — de-dup against lastNotifiedThreshold', () => {
  const ladder: Threshold[] = [
    { at: 50, action: 'warn' },
    { at: 80, action: 'warn' },
    { at: 100, action: 'block' },
  ];

  it('returns the highest crossed warn percent above lastNotified', () => {
    expect(highestCrossedWarn(85, ladder, 0)).toBe(80);
    expect(highestCrossedWarn(85, ladder, 50)).toBe(80);
    expect(highestCrossedWarn(85, ladder, 80)).toBeNull();
  });

  it('ignores the block threshold (block emails are handled separately)', () => {
    expect(highestCrossedWarn(120, ladder, 80)).toBeNull();
  });

  it('returns null when no warn threshold has been crossed', () => {
    expect(highestCrossedWarn(10, ladder, 0)).toBeNull();
  });

  it('handles non-canonical percentages (e.g. warn at 75)', () => {
    const custom: Threshold[] = [
      { at: 75, action: 'warn' },
      { at: 100, action: 'block' },
    ];
    expect(highestCrossedWarn(80, custom, 0)).toBe(75);
    expect(highestCrossedWarn(80, custom, 75)).toBeNull();
  });
});

describe('validateThresholds', () => {
  it('rejects an empty list', () => {
    expect(() => validateThresholds([])).toThrow(ThresholdValidationError);
  });

  it('rejects non-increasing percentages', () => {
    expect(() =>
      validateThresholds([
        { at: 80, action: 'warn' },
        { at: 50, action: 'warn' },
      ]),
    ).toThrow(/strictly-increasing/);
  });

  it('rejects two block thresholds', () => {
    // [80 block, 100 block]: the first block fails the "must be last"
    // check; [50 warn, 100 block, 200 block] fails the duplicate check.
    expect(() =>
      validateThresholds([
        { at: 50, action: 'warn' },
        { at: 100, action: 'block' },
        { at: 200, action: 'block' },
      ]),
    ).toThrow(/Only one .*block/);
  });

  it('rejects a block threshold that is not the last entry', () => {
    expect(() =>
      validateThresholds([
        { at: 80, action: 'block' },
        { at: 100, action: 'warn' },
      ]),
    ).toThrow(/must be the last/);
  });

  it('rejects out-of-range percents', () => {
    expect(() => validateThresholds([{ at: 0, action: 'warn' }])).toThrow();
    expect(() => validateThresholds([{ at: 1001, action: 'warn' }])).toThrow();
  });

  it('accepts a normal warn-then-block ladder', () => {
    expect(() =>
      validateThresholds([
        { at: 50, action: 'warn' },
        { at: 80, action: 'warn' },
        { at: 100, action: 'block' },
      ]),
    ).not.toThrow();
  });

  it('accepts a single block-only threshold', () => {
    expect(() => validateThresholds([{ at: 100, action: 'block' }])).not.toThrow();
  });

  it('accepts an all-warn (alert-only) ladder', () => {
    expect(() =>
      validateThresholds([
        { at: 50, action: 'warn' },
        { at: 80, action: 'warn' },
        { at: 100, action: 'warn' },
      ]),
    ).not.toThrow();
  });
});
