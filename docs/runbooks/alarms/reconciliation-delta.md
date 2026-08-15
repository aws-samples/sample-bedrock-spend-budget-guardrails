# Runbook: `ReconciliationDelta`

## Symptom

CloudWatch alarm `<stage>-bbg-reconciliation-delta` fires when the `bbg.ReconciliationDelta` metric is `> $1` for **3 consecutive evaluation periods** (`treatMissingData: NOT_BREACHING`). The metric is the absolute USD difference between BBG's `RunningSpend` totals and the Cost & Usage Report (CUR 2.0) `line_item_iam_principal` allocation, computed once per day per principal by the `cur-reconciler` Lambda. A persistent breach means BBG's per-principal totals have drifted from the bill of record — either BBG is over- or under-counting a principal's Bedrock spend.

Default threshold: `> $1` over 3 periods.

The companion metric `bbg.ReconciliationDeltaUsd` is emitted with a `Principal` dimension for the top 20 deltas — use it to identify the offending principals.

## Severity guidance

- **Sev3** — delta is widening day over day, or any single principal's delta crosses ~10 % of their monthly spend. Customer trust in the bill is at stake; page the on-call.
- **Sev4** — delta is bounded (under a few dollars) and stable across multiple days, OR limited to a single principal that just rotated identity (e.g., a role recreated mid-period). File a ticket and reconcile manually.

## Likely causes (in order)

1. **Metering paths bypassed by the meter.** Bedrock added a new API (e.g., a new `Converse*` variant, a new agent runtime) whose CWL log shape isn't recognized by `lambda/src/meter/index.ts`. Spend lands in CUR but never reaches BBG. This is the most common cause when a delta appears suddenly after an AWS announcement.
2. **Pricing table drift.** AWS changed Bedrock pricing partway through the period; `pricing-refresher` updated the rows but historical `RunningSpend` was computed at the old rate. Check whether `PricingRefreshAge` was high recently.
3. **Identity canonicalization difference.** CUR's `line_item_iam_principal` represents the assumed-role session ARN whereas BBG canonicalizes to the underlying role ARN (or vice versa for some caller types). The total is right but it's split across two principal keys, so per-principal deltas appear even though the global sum matches.
4. **`MeterUnjoined` events that timed out.** Invocations sat in `PendingMeter` past the join window and were dropped; they appear in CUR but not in `RunningSpend`. If `MeterUnjoined` was firing recently, this is the likely cause.
5. **Athena query failure or stale CUR partition.** The CUR table's partition for the requested period hasn't been crawled yet — the Lambda gets `0` for CUR totals for some principals and reports the entire meter total as a delta. Almost always self-resolves within 24 hours.
6. **Cross-region spend.** A principal called Bedrock in a region BBG isn't metering. CUR sees it; BBG doesn't.

## Investigation

```bash
# Tail the most recent reconciler run
aws logs tail /aws/lambda/dev-bbg-cur-reconciler-us-west-2 --since 48h --region us-west-2

# Pull the top deltas by principal from the dimensioned metric
aws cloudwatch get-metric-statistics --namespace bbg --metric-name ReconciliationDeltaUsd \
  --dimensions Name=Principal,Value=<principal-arn> \
  --start-time $(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 86400 --statistics Maximum --region us-west-2

# Inspect this principal's RunningSpend rows for the period
aws dynamodb query --table-name dev-bbg-running-spend --region us-west-2 \
  --key-condition-expression 'principal = :p' \
  --expression-attribute-values '{":p":{"S":"<principal-arn>"}}'

# Manually re-run the reconciler for a specific period
aws lambda invoke --function-name dev-bbg-cur-reconciler-us-west-2 --region us-west-2 \
  --payload '{"period":"2026-05"}' /tmp/recon.json
cat /tmp/recon.json

# Has MeterUnjoined been firing during the same period?
aws cloudwatch get-metric-statistics --namespace bbg --metric-name MeterUnjoined \
  --start-time $(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 3600 --statistics Sum --region us-west-2
```

## Remediation

- **Bypassed metering path**: extend `meter/index.ts` to recognize the new event shape; add a fixture under `lambda/test/fixtures/cwl/`. Backfill the affected period by running `scripts/backfill-from-cur.ts` (Athena query → re-write `RunningSpend` rows).
- **Pricing drift**: confirm `pricing-refresher` is healthy (see the `PricingRefreshAge` runbook). For closed periods, document the drift and accept it — historical `RunningSpend` rows are immutable.
- **Identity canonicalization mismatch**: confirm in `lambda/src/identity-cache/index.ts` that the principal type (assumed-role, federated user, IAM user, root, service) is canonicalized consistently with the CUR mapping in `cur-reconciler/index.ts`. See [`docs/architecture.md`](../../architecture.md) §"Identity canonicalization" for the rules.
- **Stale CUR partition**: wait 24h and re-run the reconciler. If still drifting, run the AWS Glue crawler on the CUR S3 prefix manually.
- **Cross-region spend**: add the missing region to `METERED_REGIONS` and redeploy the MeteringStack in that region.

Acceptance: next reconciler run produces a delta `< $1` for all principals; alarm returns to OK within 3 days.

## Related Lambda runbooks

- [`cur-reconciler`](../cur-reconciler.md)
- [`meter`](../meter.md)
- [`pricing-refresher`](../pricing-refresher.md)
- [`identity-cache`](../identity-cache.md)
