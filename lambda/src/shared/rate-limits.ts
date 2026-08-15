/**
 * BBG-RATELIMITS — shared helpers for sliding-window rate counters.
 *
 * The data model: per-principal, per-minute buckets keyed
 * `(principal, bucket)` where `bucket = "1m#YYYY-MM-DDTHH:MM"` (UTC
 * floor of the event time). Counters: `requestCount` and `tokenCount`
 * (input + output tokens combined). TTL = bucket-time + 16 minutes so
 * even at the longest 15-minute supported window we can sum 15 buckets
 * without one expiring mid-query.
 *
 * Three windows are supported: 60s (default), 5min, 15min. Anything
 * else is rejected at API + manifest validation. The meter writes to a
 * single 1-minute bucket regardless of window — the window only
 * affects how many buckets enforcement sums on a check. Sub-minute
 * windows are intentionally not supported because Bedrock CWL log
 * delivery itself takes 1–5s, so a 30s window has too much noise.
 */

/**
 * Sliding window length, in seconds. The set is closed: any other
 * value is rejected by the API + manifest validators. Sub-minute is
 * intentionally not supported — log-delivery noise would dominate.
 */
export type RateWindowSeconds = 60 | 300 | 900;

export const RATE_WINDOWS: readonly RateWindowSeconds[] = [60, 300, 900] as const;

/** Default sliding window when none is set on a budget that has rpm/tpm. */
export const DEFAULT_RATE_WINDOW_SECONDS: RateWindowSeconds = 60;

/**
 * TTL on a freshly-written rate-counter row. 16 minutes = max window
 * (15) + 1 minute slack so a bucket at the lower edge of a 15-min sum
 * can't expire mid-query.
 */
export const RATE_COUNTER_TTL_SECONDS = 16 * 60;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Floor a date down to the start of its 1-minute UTC bucket and return
 * the canonical bucket key `1m#YYYY-MM-DDTHH:MM`.
 */
export const bucketKeyFor = (date: Date): string => {
  const yyyy = date.getUTCFullYear();
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const min = pad2(date.getUTCMinutes());
  return `1m#${yyyy}-${mm}-${dd}T${hh}:${min}`;
};

/**
 * Returns the K bucket keys covering `[now - windowSeconds, now]`, in
 * descending time order (newest first). For a 60s window this returns
 * the current minute and the previous minute (2 buckets), since we
 * don't know how far we are into the current bucket — counting both
 * is the conservative direction for enforcement.
 */
export const bucketKeysForWindow = (
  windowSeconds: RateWindowSeconds,
  now: Date = new Date(),
): string[] => {
  // Always sum the current bucket plus enough prior buckets to cover
  // the window. For a 60s window: current + 1 prior. For 5min: current
  // + 5 prior. For 15min: current + 15 prior. Conservative direction —
  // we count up to ~1 extra minute of activity.
  const minutes = Math.ceil(windowSeconds / 60);
  const keys: string[] = [];
  // Floor `now` to its bucket so all subsequent decrements land on
  // bucket boundaries.
  const floor = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      0,
      0,
    ),
  );
  for (let i = 0; i <= minutes; i++) {
    const t = new Date(floor.getTime() - i * 60_000);
    keys.push(bucketKeyFor(t));
  }
  return keys;
};

/**
 * Validate a window value. Returns the typed window or undefined when
 * `raw` is not a supported value. Callers turn `undefined` into a 400
 * with a friendly error message.
 */
export const parseRateWindow = (raw: unknown): RateWindowSeconds | undefined => {
  if (typeof raw !== 'number') return undefined;
  if (!(RATE_WINDOWS as readonly number[]).includes(raw)) return undefined;
  return raw as RateWindowSeconds;
};

/** Human-readable label used by the SPA + email body. */
export const windowLabel = (windowSeconds: RateWindowSeconds): string => {
  if (windowSeconds === 60) return '60s';
  if (windowSeconds === 300) return '5min';
  return '15min';
};

/**
 * Fields that may be attached to a Budget row to enable rate-limit
 * enforcement alongside the dollar limit. All optional; omitting them
 * yields exactly the existing dollar-only behavior.
 */
export interface RateLimitFields {
  /** Requests per `rateWindowSeconds`. undefined = no RPM limit. */
  rpm?: number;
  /** Tokens (input+output combined) per `rateWindowSeconds`.
   *  undefined = no TPM limit. */
  tpm?: number;
  /** Sliding window length in seconds. Defaults to 60. */
  rateWindowSeconds?: RateWindowSeconds;
}

/**
 * Returns true when a budget has at least one rate-limit field set
 * such that the meter must write rate-counter buckets and enforcement
 * must consult them.
 */
export const hasRateLimits = (b: RateLimitFields): boolean =>
  (typeof b.rpm === 'number' && b.rpm > 0) ||
  (typeof b.tpm === 'number' && b.tpm > 0);

/**
 * Reason field stamped on a RunningSpend row by the enforcement Lambda
 * when it attaches a deny policy. Lets the SPA + notify Lambda render
 * the right human-readable cause.
 */
export type EnforcementReason = 'usd' | 'rpm' | 'tpm';

/**
 * Snapshot recorded with the deny so the SPA + email can show what
 * triggered it without recomputing from raw counters.
 */
export interface EnforcementMetric {
  /** What was measured at deny time (USD spend, RPM count, or TPM count). */
  value: number;
  /** The configured limit that was breached. */
  limit: number;
  /** Sliding-window length in seconds. Only set on rate-triggered denies. */
  windowSeconds?: RateWindowSeconds;
}
