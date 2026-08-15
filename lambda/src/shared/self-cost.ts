/**
 * Self-cost estimator — emits `bbg.MeterCostUSD` per Lambda invocation so
 * admins can see what BBG itself costs to run vs. the spend it meters.
 *
 * Plan §3 Cost Optimization commitment: every BBG Lambda emits a per-
 * invocation USD estimate of the AWS infra it just consumed (Lambda
 * compute + request, DDB on-demand R/W, CloudWatch Logs ingest).
 *
 * ── Why constants and not a runtime DDB lookup? ─────────────────────
 * The Pricing DDB table holds Bedrock model pricing, not AWS-platform
 * pricing for Lambda / DDB / CWL. Adding a runtime DDB lookup on every
 * invocation would also add a self-referential cost (and latency) to a
 * helper whose entire purpose is to keep BBG cheap. So we hard-code the
 * us-west-2 baseline rates here and flag the assumption below.
 *
 * ── Source: AWS public pricing pages, May 2026 (us-west-2) ──────────
 *   Lambda compute:      https://aws.amazon.com/lambda/pricing/
 *     ARM64, $0.0000133334 per GB-second
 *   Lambda request:      $0.20 per 1M  → $0.0000002 per invocation
 *   DynamoDB on-demand:  https://aws.amazon.com/dynamodb/pricing/on-demand/
 *     Write request:     $1.25 per 1M  → $0.00000125 per WCU
 *     Read request:      $0.25 per 1M  → $0.00000025 per RCU
 *   CloudWatch Logs:     https://aws.amazon.com/cloudwatch/pricing/
 *     Ingest:            $0.50 per GB
 *
 * ── Multi-region note ───────────────────────────────────────────────
 * These are us-west-2 baseline rates. If BBG goes multi-region, this
 * constants table needs to become a region-keyed lookup (DDB on-demand
 * is the same in every commercial region, but Lambda and CWL prices vary
 * in GovCloud / China / opt-in regions, and the Bedrock-supported region
 * set is broader than commercial-baseline).
 */

import { metrics, MetricUnit } from './powertools.js';

/** us-west-2 baseline rates. See top-of-file note for multi-region caveat. */
export const SELF_COST_RATES = {
  /** USD per GB-second of Lambda ARM64 compute. */
  lambdaArmGbSecond: 0.0000133334,
  /** USD per Lambda invocation request. */
  lambdaRequest: 0.0000002,
  /** USD per DynamoDB on-demand WCU (1KB write). */
  ddbWriteUnit: 0.00000125,
  /** USD per DynamoDB on-demand RCU (4KB strongly-consistent / 8KB eventually-consistent read). */
  ddbReadUnit: 0.00000025,
  /** USD per GB of CloudWatch Logs ingest. */
  cwlIngestGb: 0.5,
} as const;

/**
 * Per-invocation dimensional usage that contributes to self-cost. Every
 * field is optional: a Lambda that only does DDB writes leaves reads at
 * 0 (or undefined) and vice versa.
 */
export interface SelfCostUsage {
  /** Number of DynamoDB write requests (WCUs) consumed. */
  ddbWrites?: number;
  /** Number of DynamoDB read requests (RCUs) consumed. */
  ddbReads?: number;
  /**
   * Approximate CloudWatch Logs ingest in bytes for this invocation. If
   * omitted we assume zero — a reasonable approximation when the Lambda
   * only writes a handful of structured log lines.
   */
  cwlIngestBytes?: number;
}

/**
 * Computes the USD self-cost of a single Lambda invocation given its
 * billed duration, configured memory, and dimensional AWS API calls.
 *
 * GB-seconds are billed in 1ms increments by AWS, but the runtime
 * pricing model rounds up to the next GB-millisecond per invocation.
 * We use `Math.ceil(memoryGb * durationMs / 1000)` which matches the
 * "GB-second per invocation" line item AWS shows on the Cost Explorer.
 *
 * @param durationMs   Wall-clock duration this invocation has consumed
 *                     so far. Use `(initialRemaining - context.getRemainingTimeInMillis())`.
 * @param memoryMb     The Lambda's configured memory size, in MB.
 *                     Read from `process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE`.
 * @param usage        Optional per-invocation API call counts.
 */
export const computeSelfCost = (
  durationMs: number,
  memoryMb: number,
  usage: SelfCostUsage = {},
): number => {
  // Defensive: Lambda runtime always populates AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
  // but if a caller passes 0 / NaN we'd produce NaN below. Coerce to 128MB
  // (the minimum Lambda allows) so the metric is always a finite USD value.
  const safeMemoryMb = Number.isFinite(memoryMb) && memoryMb > 0 ? memoryMb : 128;
  const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;

  const gbSeconds = Math.ceil((safeMemoryMb / 1024) * (safeDurationMs / 1000));
  const computeCost = gbSeconds * SELF_COST_RATES.lambdaArmGbSecond;
  const requestCost = SELF_COST_RATES.lambdaRequest;
  const ddbWriteCost = (usage.ddbWrites ?? 0) * SELF_COST_RATES.ddbWriteUnit;
  const ddbReadCost = (usage.ddbReads ?? 0) * SELF_COST_RATES.ddbReadUnit;
  const cwlIngestCost =
    ((usage.cwlIngestBytes ?? 0) / (1024 * 1024 * 1024)) * SELF_COST_RATES.cwlIngestGb;

  return computeCost + requestCost + ddbWriteCost + ddbReadCost + cwlIngestCost;
};

/**
 * Reads the Lambda's configured memory from the runtime-injected env var.
 * Lambda always sets this; the fallback to 512 MB only kicks in for
 * non-Lambda contexts (local invokes, vitest harness).
 */
export const getConfiguredMemoryMb = (): number => {
  const raw = process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512;
};

/**
 * Emits the `MeterCostUSD` metric tagged with a `Lambda` dimension so the
 * Operations dashboard can show per-Lambda self-cost without colliding
 * with other invocation metrics published in the same flush.
 *
 * Uses `singleMetric()` so the `Lambda` dimension is scoped to this one
 * metric — adding it via `addDimension()` on the global `metrics`
 * instance would leak the dimension onto every other metric in the same
 * EMF blob, which would explode CloudWatch dimension cardinality on the
 * existing metrics (MeterUnjoined, EnforcementApplied, etc.).
 */
export const emitSelfCost = (lambdaName: string, costUsd: number): void => {
  const m = metrics.singleMetric();
  m.addDimension('Lambda', lambdaName);
  m.addMetric('MeterCostUSD', MetricUnit.Count, costUsd);
};

/**
 * Convenience: compute and emit in one call. Most handlers use this at
 * the very end of their handler, just before `metrics.publishStoredMetrics()`.
 */
export const recordSelfCost = (
  lambdaName: string,
  durationMs: number,
  memoryMb: number,
  usage: SelfCostUsage = {},
): number => {
  const cost = computeSelfCost(durationMs, memoryMb, usage);
  emitSelfCost(lambdaName, cost);
  return cost;
};
