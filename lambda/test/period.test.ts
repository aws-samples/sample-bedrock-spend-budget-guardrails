import { describe, expect, it } from 'vitest';
import {
  WINDOWS,
  nextPeriodStart,
  periodEndEpochFor,
  periodFor,
  periodStart,
  previousPeriodFor,
  spendRowTtl,
} from '../src/shared/period.js';

const utc = (
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): Date => new Date(Date.UTC(y, mo - 1, d, h, mi, s));

describe('periodFor — encoding for each window', () => {
  it('monthly is the bare YYYY-MM form (back-compat)', () => {
    expect(periodFor('monthly', utc(2026, 5, 21, 14))).toBe('2026-05');
    expect(periodFor('monthly', utc(2026, 1, 1))).toBe('2026-01');
    // Default window is monthly.
    expect(periodFor(undefined, utc(2026, 5, 21))).toBe('2026-05');
  });

  it('weekly uses ISO week numbers anchored to Monday', () => {
    // Mon 2026-05-18 is the start of ISO week 21 of 2026.
    expect(periodFor('weekly', utc(2026, 5, 18))).toBe('weekly:2026-W21');
    expect(periodFor('weekly', utc(2026, 5, 21, 14))).toBe('weekly:2026-W21');
    // Sun 2026-05-24 is still in week 21 (week ends Sun 23:59 UTC, then
    // Mon 2026-05-25 starts W22).
    expect(periodFor('weekly', utc(2026, 5, 24, 23))).toBe('weekly:2026-W21');
    expect(periodFor('weekly', utc(2026, 5, 25))).toBe('weekly:2026-W22');
  });

  it('weekly correctly handles ISO year transitions (Jan 1 in last week of prev year)', () => {
    // 2027-01-01 is a Friday → still in 2026-W53.
    expect(periodFor('weekly', utc(2027, 1, 1))).toBe('weekly:2026-W53');
    // First Monday of ISO 2027.
    expect(periodFor('weekly', utc(2027, 1, 4))).toBe('weekly:2027-W01');
  });

  it('daily anchors to UTC midnight', () => {
    expect(periodFor('daily', utc(2026, 5, 21, 0, 0, 0))).toBe('daily:2026-05-21');
    expect(periodFor('daily', utc(2026, 5, 21, 23, 59, 59))).toBe('daily:2026-05-21');
    expect(periodFor('daily', utc(2026, 5, 22, 0, 0, 0))).toBe('daily:2026-05-22');
  });

  it('5h anchors to 00/05/10/15/20 UTC hours', () => {
    expect(periodFor('5h', utc(2026, 5, 21, 0))).toBe('5h:2026-05-21T00');
    expect(periodFor('5h', utc(2026, 5, 21, 4, 59))).toBe('5h:2026-05-21T00');
    expect(periodFor('5h', utc(2026, 5, 21, 5))).toBe('5h:2026-05-21T05');
    expect(periodFor('5h', utc(2026, 5, 21, 9, 59))).toBe('5h:2026-05-21T05');
    expect(periodFor('5h', utc(2026, 5, 21, 10))).toBe('5h:2026-05-21T10');
    expect(periodFor('5h', utc(2026, 5, 21, 15))).toBe('5h:2026-05-21T15');
    expect(periodFor('5h', utc(2026, 5, 21, 20))).toBe('5h:2026-05-21T20');
    // Hour 22 still rounds down to the 20:00 bucket — the last 4-hour
    // bucket of the day (20:00–23:59) by design.
    expect(periodFor('5h', utc(2026, 5, 21, 22))).toBe('5h:2026-05-21T20');
  });

  it('exposes all four windows in WINDOWS', () => {
    expect(WINDOWS).toEqual(['monthly', 'weekly', 'daily', '5h']);
  });
});

describe('periodStart / nextPeriodStart', () => {
  it('monthly start is the 1st 00:00 UTC; next is the 1st of the next month', () => {
    expect(periodStart('monthly', utc(2026, 5, 21, 14)).toISOString()).toBe(
      '2026-05-01T00:00:00.000Z',
    );
    expect(nextPeriodStart('monthly', utc(2026, 5, 21)).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    // December → next is January of next year.
    expect(nextPeriodStart('monthly', utc(2026, 12, 31)).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('weekly start is the Monday of the ISO week; next is the next Monday', () => {
    // Wed 2026-05-20 → Mon 2026-05-18.
    expect(periodStart('weekly', utc(2026, 5, 20)).toISOString()).toBe(
      '2026-05-18T00:00:00.000Z',
    );
    expect(nextPeriodStart('weekly', utc(2026, 5, 20)).toISOString()).toBe(
      '2026-05-25T00:00:00.000Z',
    );
    // Sunday is the last day of the ISO week — start is still that week's Mon.
    expect(periodStart('weekly', utc(2026, 5, 24)).toISOString()).toBe(
      '2026-05-18T00:00:00.000Z',
    );
  });

  it('daily start is 00:00 UTC; next is the next day', () => {
    expect(periodStart('daily', utc(2026, 5, 21, 14)).toISOString()).toBe(
      '2026-05-21T00:00:00.000Z',
    );
    expect(nextPeriodStart('daily', utc(2026, 5, 21, 14)).toISOString()).toBe(
      '2026-05-22T00:00:00.000Z',
    );
  });

  it('5h start floors to the 5-hour bucket; next is +5h', () => {
    expect(periodStart('5h', utc(2026, 5, 21, 7, 30)).toISOString()).toBe(
      '2026-05-21T05:00:00.000Z',
    );
    expect(nextPeriodStart('5h', utc(2026, 5, 21, 7, 30)).toISOString()).toBe(
      '2026-05-21T10:00:00.000Z',
    );
    // The 20:00 bucket rolls over to 01:00 of the next day's 00:00 bucket.
    expect(nextPeriodStart('5h', utc(2026, 5, 21, 20, 0)).toISOString()).toBe(
      '2026-05-22T01:00:00.000Z',
    );
  });
});

describe('previousPeriodFor', () => {
  it('monthly: returns previous month', () => {
    expect(previousPeriodFor('monthly', utc(2026, 5, 1, 0, 0, 0))).toBe('2026-04');
    expect(previousPeriodFor('monthly', utc(2026, 1, 1, 0, 0, 0))).toBe('2025-12');
  });

  it('weekly: returns previous ISO week', () => {
    // Mon 2026-05-25 00:00 → previous = W21 of 2026.
    expect(previousPeriodFor('weekly', utc(2026, 5, 25))).toBe('weekly:2026-W21');
  });

  it('daily: returns previous day', () => {
    expect(previousPeriodFor('daily', utc(2026, 5, 21, 0, 0, 0))).toBe('daily:2026-05-20');
  });

  it('5h: returns previous 5-hour bucket', () => {
    expect(previousPeriodFor('5h', utc(2026, 5, 21, 5, 0, 0))).toBe('5h:2026-05-21T00');
    expect(previousPeriodFor('5h', utc(2026, 5, 21, 0, 0, 0))).toBe('5h:2026-05-20T20');
  });
});

describe('periodEndEpochFor — TTL math', () => {
  it('monthly: matches the legacy "end of next month" exactly', () => {
    // Legacy from ddb.ts: end of next month = 1st of (month+2) at 00:00 UTC.
    const epoch = periodEndEpochFor('monthly', utc(2026, 5, 21));
    expect(new Date(epoch * 1000).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('non-monthly: 2 periods out (current period end + 1 grace period)', () => {
    // daily: 2026-05-21 → grace through 2026-05-23 00:00 UTC.
    const epoch = periodEndEpochFor('daily', utc(2026, 5, 21, 14));
    expect(new Date(epoch * 1000).toISOString()).toBe('2026-05-23T00:00:00.000Z');
  });
});

describe('spendRowTtl — RunningSpend history retention', () => {
  it('monthly: retains N months from the period start', () => {
    // May 2026 row + 13 months retention → expires 2027-06-01 00:00 UTC.
    const epoch = spendRowTtl('monthly', utc(2026, 5, 21), 13);
    expect(new Date(epoch! * 1000).toISOString()).toBe('2027-06-01T00:00:00.000Z');
  });

  it('anchors to the period start regardless of when in the period the row was written', () => {
    // Two writes in the same May period (early + late) must yield the same TTL.
    const early = spendRowTtl('monthly', utc(2026, 5, 2, 1), 13);
    const late = spendRowTtl('monthly', utc(2026, 5, 30, 23), 13);
    expect(early).toBe(late);
  });

  it('non-monthly windows also anchor to the containing period start', () => {
    // daily window: retention is still expressed in months from the day's start.
    const epoch = spendRowTtl('daily', utc(2026, 5, 21, 14), 1);
    expect(new Date(epoch! * 1000).toISOString()).toBe('2026-06-21T00:00:00.000Z');
  });

  it('retains forever (undefined ⇒ no TTL attribute) when retention <= 0', () => {
    expect(spendRowTtl('monthly', utc(2026, 5, 21), 0)).toBeUndefined();
    expect(spendRowTtl('monthly', utc(2026, 5, 21), -1)).toBeUndefined();
    expect(spendRowTtl('monthly', utc(2026, 5, 21), Number.NaN)).toBeUndefined();
  });
});
