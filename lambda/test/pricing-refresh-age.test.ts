/**
 * computePricingRefreshAgeSeconds — the staleness metric behind the
 * *-pricing-refresh-age alarm.
 *
 * The regression this guards: a deprecated model (one AWS no longer returns
 * from ListFoundationModels) keeps its last-known price row forever. Its
 * ancient `fetchedAt` must NOT count toward the freshness metric, or the alarm
 * fires permanently even when the refresher is healthy. Only rows for
 * currently-LIVE models count; reserved rows (discount#) and rows without a
 * parseable fetchedAt are skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('../src/shared/ddb.js', () => ({ ddb: undefined }));
vi.mock('@aws-sdk/lib-dynamodb', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: (c: unknown) => sendMock(c) }) } };
});
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('../src/shared/powertools.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metrics: { addMetric: vi.fn(), singleMetric: () => ({ addDimension: vi.fn(), addMetric: vi.fn() }), publishStoredMetrics: vi.fn() },
  MetricUnit: { Seconds: 'Seconds', Count: 'Count' },
}));

process.env.PRICING_TABLE = 'test-pricing';

const { computePricingRefreshAgeSeconds } = await import('../src/pricing-refresher/index.js');

const NOW = Date.parse('2026-07-30T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400_000).toISOString();

describe('computePricingRefreshAgeSeconds', () => {
  beforeEach(() => sendMock.mockReset());

  it('ignores deprecated-model rows — a 60-day-old dead model does not pin the metric', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { model: 'live.model-a', fetchedAt: daysAgo(1) }, // live, 1 day old
        { model: 'live.model-b', fetchedAt: daysAgo(0.5) }, // live, 12h old
        { model: 'deprecated.claude-opus-4', fetchedAt: daysAgo(60) }, // NOT live
      ],
    });
    const live = new Set(['live.model-a', 'live.model-b']);
    const age = await computePricingRefreshAgeSeconds(NOW, live);
    // Oldest LIVE row is 1 day → ~86400s, NOT 60 days.
    expect(age).toBeGreaterThan(86000);
    expect(age).toBeLessThan(90000);
  });

  it('flags a genuinely stale LIVE model (refresher silently stopped)', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ model: 'live.model-a', fetchedAt: daysAgo(3) }],
    });
    const age = await computePricingRefreshAgeSeconds(NOW, new Set(['live.model-a']));
    // 3 days > 36h threshold → alarm reachable.
    expect(age).toBeGreaterThan(129600);
  });

  // Regression: 2026-08-15 false alarm. Manual `source: 'override'` rows exist
  // precisely BECAUSE AWS publishes no priced SKU for that model, so the
  // refresher gaps it every run and never rewrites `fetchedAt`. When the
  // Mantle-served openai.gpt-5.6-{sol,terra,luna} overrides (authored
  // 2026-07-30) became visible in ListFoundationModels, they instantly pinned
  // this metric at 15.3 days and fired *-bbg-pricing-refresh-age in BOTH stages
  // while the refresher was provably healthy (age 538s the previous day).
  it('ignores manual override rows — an un-refreshable override does not pin the metric', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { model: 'live.model-a', fetchedAt: daysAgo(1), source: 'pricing-api' },
        // Live AND ancient, but manually authored — the refresher can never
        // refresh it, so it must not count as refresher staleness.
        { model: 'openai.gpt-5.6-sol', fetchedAt: daysAgo(16), source: 'override' },
      ],
    });
    const live = new Set(['live.model-a', 'openai.gpt-5.6-sol']);
    const age = await computePricingRefreshAgeSeconds(NOW, live);
    // Oldest NON-override live row is 1 day → ~86400s, NOT 16 days (1382400s).
    expect(age).toBeGreaterThan(86000);
    expect(age).toBeLessThan(90000);
  });

  it('still flags staleness when an override is the ONLY live row (returns 0, not a false alarm)', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ model: 'openai.gpt-5.6-sol', fetchedAt: daysAgo(40), source: 'override' }],
    });
    const age = await computePricingRefreshAgeSeconds(NOW, new Set(['openai.gpt-5.6-sol']));
    // No refresher-owned row at all → nothing to report, and crucially NOT a
    // 40-day breach. Pricing coverage for overrides is PricingGapCount's job.
    expect(age).toBe(0);
  });

  it('skips reserved (discount#) and unparseable rows', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { model: 'discount#123456789012', discountPct: 25 }, // reserved, no fetchedAt
        { model: 'live.model-a', fetchedAt: 'not-a-date' }, // unparseable
        { model: 'live.model-a', fetchedAt: daysAgo(2) },
      ],
    });
    const age = await computePricingRefreshAgeSeconds(NOW, new Set(['live.model-a']));
    expect(age).toBeGreaterThan(129600); // 2 days from the one valid live row
  });

  it('returns 0 when no live-model row has a fetchedAt (empty/all-deprecated)', async () => {
    sendMock.mockResolvedValueOnce({ Items: [{ model: 'deprecated.x', fetchedAt: daysAgo(90) }] });
    const age = await computePricingRefreshAgeSeconds(NOW, new Set(['live.only']));
    expect(age).toBe(0);
  });

  it('paginates through LastEvaluatedKey', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [{ model: 'live.a', fetchedAt: daysAgo(1) }], LastEvaluatedKey: { model: 'live.a' } })
      .mockResolvedValueOnce({ Items: [{ model: 'live.b', fetchedAt: daysAgo(5) }] });
    const age = await computePricingRefreshAgeSeconds(NOW, new Set(['live.a', 'live.b']));
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(age).toBeGreaterThan(5 * 86400 - 100); // oldest live = 5 days
  });
});
