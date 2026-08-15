/**
 * Budget window encoding + period math.
 *
 * Four window kinds:
 *   - monthly (default, back-compat: SK keeps the bare YYYY-MM form)
 *   - weekly  (ISO week, Mon 00:00 UTC anchor)
 *   - daily   (00:00 UTC anchor)
 *   - 5h      (00:00, 05:00, 10:00, 15:00, 20:00 UTC anchors)
 *
 * Period encoding (for the `period` attribute on RunningSpend rows and
 * the GSI key):
 *   - monthly  -> "2026-05"
 *   - weekly   -> "weekly:2026-W21"
 *   - daily    -> "daily:2026-05-21"
 *   - 5h       -> "5h:2026-05-21T00"
 *
 * Monthly intentionally keeps the legacy bare format so every in-flight
 * RunningSpend row + the byPeriod GSI keep working without any data
 * migration. Non-monthly windows use a kind-prefixed key; the prefix is
 * harmless to existing consumers (the SPA shows it as the period
 * label).
 */

export type Window = 'monthly' | 'weekly' | 'daily' | '5h';

export const WINDOWS: readonly Window[] = ['monthly', 'weekly', 'daily', '5h'] as const;

const isoWeek = (date: Date): { year: number; week: number } => {
  // ISO 8601 week date: weeks start on Monday and the first week of a year
  // contains the first Thursday. Spec: https://en.wikipedia.org/wiki/ISO_week_date.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Sun=0 -> 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Returns the period key for the given window + timestamp. Monthly keeps
 * the bare `YYYY-MM` form; non-monthly windows use a kind-prefixed key.
 */
export const periodFor = (window: Window = 'monthly', date: Date = new Date()): string => {
  if (window === 'monthly') {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
  }
  if (window === 'weekly') {
    const { year, week } = isoWeek(date);
    return `weekly:${year}-W${pad2(week)}`;
  }
  if (window === 'daily') {
    return `daily:${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }
  // 5h: anchor to the floor of the 5-hour bucket of the UTC hour.
  const hourBucket = Math.floor(date.getUTCHours() / 5) * 5;
  return `5h:${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}T${pad2(hourBucket)}`;
};

/**
 * Returns the start of the period containing `date` for the given window,
 * as a UTC Date.
 */
export const periodStart = (window: Window, date: Date = new Date()): Date => {
  if (window === 'monthly') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0));
  }
  if (window === 'weekly') {
    const dayNum = date.getUTCDay() || 7; // Sun=0 -> 7
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0));
    monday.setUTCDate(monday.getUTCDate() - (dayNum - 1));
    return monday;
  }
  if (window === 'daily') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0));
  }
  const hourBucket = Math.floor(date.getUTCHours() / 5) * 5;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourBucket, 0, 0));
};

/**
 * Returns the start of the next period after the one containing `date`.
 */
export const nextPeriodStart = (window: Window, date: Date = new Date()): Date => {
  const start = periodStart(window, date);
  if (window === 'monthly') {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0));
  }
  if (window === 'weekly') {
    const next = new Date(start);
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  if (window === 'daily') {
    const next = new Date(start);
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  const next = new Date(start);
  next.setUTCHours(next.getUTCHours() + 5);
  return next;
};

/**
 * Returns the previous period's key (the one that just ended at the given
 * timestamp). Used by period-rollover to know which spend rows to clean
 * up.
 */
export const previousPeriodFor = (window: Window, date: Date = new Date()): string => {
  const start = periodStart(window, date);
  // Subtract 1ms to land in the previous period.
  return periodFor(window, new Date(start.getTime() - 1));
};

/**
 * Epoch seconds at the END of the period AFTER the one containing `date`.
 * Originally the TTL on RunningSpend so rollover artifacts auto-purged
 * after one period of grace. **No longer used for the row TTL** — see
 * {@link spendRowTtl}, which retains spend history for analytics — but
 * kept for the period-rollover grace-window math and any caller that
 * wants the "one period out" boundary.
 */
export const periodEndEpochFor = (window: Window = 'monthly', date: Date = new Date()): number => {
  const start = periodStart(window, date);
  if (window === 'monthly') {
    // End of next month: matches the legacy ddb.periodEndEpochFor exactly
    // so monthly TTLs are unchanged.
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 1, 0, 0, 0));
    return Math.floor(d.getTime() / 1000);
  }
  // Non-monthly: 2 periods out (current + 1 grace).
  const grace = nextPeriodStart(window, nextPeriodStart(window, date));
  return Math.floor(grace.getTime() / 1000);
};

/**
 * TTL (epoch seconds) for a RunningSpend row, computed so spend history
 * is retained for `retentionMonths` after the START of the row's period.
 * This is the sole retention control now that period-rollover no longer
 * deletes rows — it lets the SPA period selector and Spend Dashboard read
 * back many months of history (the user-facing "view usage going back to
 * when it was first recorded" requirement).
 *
 * Retention is anchored to the period START (not `date`) so every row in a
 * given period expires together regardless of when within the period it was
 * last written, independent of window kind.
 *
 * `retentionMonths <= 0` means **retain forever** — returns `undefined` so
 * the caller omits the `ttl` attribute entirely. The permanent archive is
 * always the S3 ledger (no TTL); this only bounds the hot DynamoDB store.
 */
export const spendRowTtl = (
  window: Window,
  date: Date,
  retentionMonths: number,
): number | undefined => {
  if (!Number.isFinite(retentionMonths) || retentionMonths <= 0) return undefined;
  const start = periodStart(window, date);
  const expiry = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + retentionMonths, start.getUTCDate(), 0, 0, 0),
  );
  return Math.floor(expiry.getTime() / 1000);
};
