# Runbook: `ReconciliationDelta`

## Symptom

CloudWatch alarm `<stage>-bbg-reconciliation-delta` fires when the `bbg.ReconciliationDelta` metric (dimensions `service=bbg, stage=<stage>`) is `> $1` for **3 consecutive evaluation periods** (`treatMissingData: NOT_BREACHING`). The metric is the absolute USD difference between the stage's **invocation ledger** (S3/Athena, written by `ledger-writer`) and the Cost & Usage Report (CUR 2.0) `line_item_iam_principal` allocation, computed once per day per principal by the `cur-reconciler` Lambda.

Both sides of the comparison are **watermarked to bill-complete days** (`now − 72h`, override `RECONCILE_WATERMARK_HOURS`), so CUR ingestion lag cannot produce a breach. And the metric only covers principals the stage's meter has actually seen — CUR-billed spend the stage never metered (pre-deployment history, another stage's traffic, structural bypasses like `bedrock-mantle`) rolls up into the dashboard-only `bbg.ReconciliationUnmeteredSpend` metric instead. A persistent breach therefore means the meter and the bill genuinely disagree about spend the meter **did** see — BBG is over- or under-counting a principal's Bedrock spend, so budget enforcement may be mis-firing.

Default threshold: `> $1` over 3 periods. The alarm only exists on stages listed in `bbg:reconciliationAlarmStages` (default `["prod"]`) — a stage that doesn't own the account's invocation-log subscription meters only a sliver of the traffic its CUR side sees, so its reconciliation alarm would be structurally red.

The companion metric `bbg.ReconciliationDeltaUsd` is emitted with a `Principal` dimension for the top 20 deltas — use it to identify the offending principals. The reconciler also logs a `reconciliation breakdown` line (top-20 meter/CUR/delta per principal) and a `CUR spend with no meter counterpart` line (top-20 unmetered principals) every run.

## Severity guidance

- **Sev3** — delta is widening day over day, or any single principal's delta crosses ~10 % of their monthly spend. Customer trust in the bill is at stake; page the on-call.
- **Sev4** — delta is bounded (under a few dollars) and stable across multiple days, OR limited to a single principal that just rotated identity (e.g., a role recreated mid-period). File a ticket and reconcile manually.

## Likely causes (in order)

1. **Metering paths bypassed by the meter.** Bedrock added a new API (e.g., a new `Converse*` variant, a new agent runtime) whose CWL log shape isn't recognized by `lambda/src/meter/index.ts`. If the principal ALSO has metered spend, the missing slice appears as a delta; if the principal is only ever billed via the bypass path, it lands in `ReconciliationUnmeteredSpend` instead. This is the most common cause when a delta appears suddenly after an AWS announcement.
2. **Same-dimension multi-rate collapse (cache-write TTL is the big one).** The invocation log carries one coarse counter per dimension with no TTL/resolution/modality signal, so the refresher deterministically prices the cheapest same-tier SKU (5-min cache-write ≈ 1.25× input) — but 1h-TTL cache writes bill at 2× input. Heavy 1h-cache users (agentic coding tools) accumulate a real meter UNDER-count of `(2 − 1.25) × input rate` per 1h-cached-write token (observed: ~$3.5 on one month of Claude Code traffic). Structural until Bedrock surfaces TTL on the log; see "One dimension, many rates" in `docs/pricing-nuances.md`.
3. **Pricing table drift.** AWS changed Bedrock pricing partway through the period; `pricing-refresher` updated the rows but historical ledger entries were computed at the old rate. Check whether `PricingRefreshAge` was high recently. (One historical instance is now fixed at the source: `global.`-routed traffic used to be metered at the regional rate while AWS bills distinct Global SKUs ~9% lower for the Anthropic frontier — the meter now prices routing-aware via `routingDimensions`. Ledger rows metered before that fix carry the old rate until the period rolls.)
4. **Identity canonicalization difference.** CUR's `line_item_iam_principal` represents the assumed-role session ARN whereas BBG canonicalizes to the underlying role ARN (or vice versa for some caller types). The total is right but it's split across two principal keys — the canonical-key rows show a delta while the session-form rows land in `ReconciliationUnmeteredSpend`.
5. **`MeterUnjoined` events that timed out.** Invocations sat in `PendingMeter` past the join window and were dropped; they appear in CUR but never reached the ledger. If `MeterUnjoined` was firing recently, this is the likely cause.
6. **Ledger-writer gaps.** The ledger is written off the RunningSpend DynamoDB stream; if `ledger-writer` errored for a window, metered spend exists in DDB but not in the ledger the reconciler reads, deflating the meter side. Check the `ledger-writer` Lambda's error metric for the period.
7. **Cross-region spend.** A principal called Bedrock in a region BBG isn't metering. CUR sees it; BBG doesn't — metered principals show a delta, meter-unknown principals land in `ReconciliationUnmeteredSpend`.
8. **Meter-only spend (billed $0 in CUR).** Rare: a model in billing preview, or a manual override row pricing traffic AWS doesn't (yet) bill. The meter side carries dollars with no CUR counterpart at all (observed: GPT-5.6 on `bedrock-runtime` metered ~$0.75 in a month with zero CUR line items for it).

## Investigation

```bash
# Tail the most recent reconciler run. NOTE: the function uses a custom
# LoggingConfig log group (NOT /aws/lambda/<fn>) — resolve it first.
LG=$(aws lambda get-function-configuration --function-name dev-bbg-cur-reconciler \
  --region us-west-2 --query 'LoggingConfig.LogGroup' --output text)
aws logs tail "$LG" --since 48h --region us-west-2
# The 'reconciliation breakdown' and 'CUR spend with no meter counterpart' log
# lines carry the per-principal meter/CUR/delta composition — start there.

# Pull the top deltas by principal from the dimensioned metric
aws cloudwatch get-metric-statistics --namespace bbg --metric-name ReconciliationDeltaUsd \
  --dimensions Name=Principal,Value=<principal-arn> \
  --start-time $(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 86400 --statistics Maximum --region us-west-2

# Inspect this principal's metered spend in the ledger (Athena) — same source
# the reconciler reads, windowable by recordedat
# SELECT principal, sum(spendusd) FROM dev_bbg_ledger.invocations
#   WHERE period = '2026-08' AND principal = 'principal#<arn>'
#   AND target LIKE 'model#%'  -- profile# rows duplicate model# dollars
#   AND recordedat < '<watermark-iso>' GROUP BY principal

# Manually re-run the reconciler for a specific period (optionally pin the watermark)
aws lambda invoke --function-name dev-bbg-cur-reconciler --region us-west-2 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"period":"2026-08","watermark":"2026-08-18T00:00:00.000Z"}' /tmp/recon.json
cat /tmp/recon.json

# Has MeterUnjoined been firing during the same period?
aws cloudwatch get-metric-statistics --namespace bbg --metric-name MeterUnjoined \
  --start-time $(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 3600 --statistics Sum --region us-west-2
```

## Remediation

- **Bypassed metering path**: extend `meter/index.ts` to recognize the new event shape; add a fixture under `lambda/test/fixtures/cwl/`. Backfill the affected period by running `scripts/backfill-from-cur.ts` (Athena query → re-write `RunningSpend` rows; the ledger-writer picks the corrections up off the stream).
- **Pricing drift**: confirm `pricing-refresher` is healthy (see the `PricingRefreshAge` runbook). For closed periods, document the drift and accept it — historical ledger rows are immutable.
- **Identity canonicalization mismatch**: confirm in `lambda/src/identity-cache/index.ts` that the principal type (assumed-role, federated user, IAM user, root, service) is canonicalized consistently with the CUR mapping in `cur-reconciler/index.ts`. See [`docs/architecture.md`](../../architecture.md) §"Identity canonicalization" for the rules.
- **Ledger-writer gaps**: check the `ledger-writer` Lambda's errors/DLQ for the period; re-drive the stream window if events were lost.
- **Cross-region spend**: add the missing region to `METERED_REGIONS` and redeploy the MeteringStack in that region.

Acceptance: next reconciler run produces a delta `< $1` for all principals; alarm returns to OK within 3 days.

## Related Lambda runbooks

- [`cur-reconciler`](../cur-reconciler.md)
- [`meter`](../meter.md)
- [`pricing-refresher`](../pricing-refresher.md)
- [`identity-cache`](../identity-cache.md)
