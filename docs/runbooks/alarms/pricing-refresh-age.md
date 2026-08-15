# Runbook: `PricingRefreshAge`

## Symptom

CloudWatch alarm `<stage>-bbg-pricing-refresh-age` fires when the `bbg.PricingRefreshAge` metric exceeds **36 hours** for **1 evaluation period**.

The metric is **computed, not a counter.** At the end of every run the `pricing-refresher` scans the `Pricing` table and emits `now − min(fetchedAt)` in seconds across every row for a **currently-live** model (`lambda/src/pricing-refresher/index.ts::computePricingRefreshAgeSeconds`). The *oldest* live row is what's reported, because a single stale live model is a real gap even if everything else refreshed. It is read at a **1-day period with the `Maximum` statistic** — the emission is once-daily, so a default 300s/Average read would leave ~287 of 288 daily windows empty.

**Deprecated models are excluded.** A model AWS dropped from `ListFoundationModels` keeps its last-known price row forever. It can no longer be invoked, so its stale price is harmless — but its ancient `fetchedAt` would otherwise pin this metric past 36h permanently and hold the alarm in ALARM even with a perfectly healthy refresher. Only rows whose `model` is in the live set (the current `ListFoundationModels` catalog plus reconciled Nova ids) are counted. Reserved non-model rows (e.g. `discount#<accountId>`) have no `fetchedAt` and are skipped anyway. If no live row has a parseable `fetchedAt`, the metric is `0`.

`treatMissingData: BREACHING` (**not** the default `MISSING`). Because the age is emitted only once per daily run, a refresher that stops firing produces no datapoints at all — treating missing data as breaching means "**the refresher went dark**" trips the alarm instead of parking it in `INSUFFICIENT_DATA` while the meter charges against days-old prices.

Default threshold: `> 36 hours` (`129600` seconds) over 1 period.

A breach therefore means one of two things: the daily refresh missed at least a full day, or it hasn't run at all. Either way the `Pricing` rows are going stale and the meter is computing spend against last-known prices.

## Severity guidance

- **Sev3** — refresh has been failing for more than ~48 hours, OR a Bedrock model price change is in flight (e.g., AWS just announced a price drop) and BBG would over-bill customers. Page the on-call.
- **Sev4** — single missed run that's already remediated by the next scheduled trigger; pricing is "yesterday's" but still consistent across the fleet. File a ticket.

## Likely causes (in order)

1. **`pricing-refresher` Lambda errored on every recent run.** Most common: AWS Pricing API throttling, or a new Bedrock model whose pricing shape the Lambda doesn't yet handle. Check Lambda errors and the logs.
2. **EventBridge Scheduler schedule disabled or deleted.** The schedule `<stage>-bbg-pricing-refresh` (`cron(0 3 * * ? *)` UTC) is what triggers the Lambda. If it's disabled — e.g. during a manual test that wasn't undone — no datapoints are emitted and `treatMissingData: BREACHING` trips the alarm.
3. **IAM permission lost** for `pricing:GetProducts` / `bedrock:ListFoundationModels` / `dynamodb:PutItem` on the `Pricing` table. The run fails before reaching the age emit at the bottom of the handler.
4. **`Pricing` table write throttled.** A burst of price rows on a fresh deploy can throttle; the Lambda finishes partial and may never reach the emit.
5. **Lambda timeout mid-run.** The timeout is **15 minutes** (`Duration.minutes(15)` — the Lambda maximum, set in `infra/lib/pricing-stack.ts`, 2048MB). A run that hits the hard timeout mid-loop emits nothing, so this alarm trips via the missing-data path. To prevent that, the handler now enforces a **self-imposed 90s time budget**: it stops starting new models before the cap and always publishes metrics, emitting `PricingRefreshIncomplete=1` instead. So if you see this age alarm with NO recent `PricingRefreshIncomplete` datapoint, the refresher truly went dark (schedule/permissions/crash); if you see `PricingRefreshIncomplete=1`, the refresher ran but truncated — see the `<stage>-bbg-pricing-refresh-incomplete` alarm and cause below.
6. **One genuinely stale live model.** Every other model refreshed, but a single live model's row didn't get rewritten (its `servicename` variant drifted, or its SKUs vanished from the Pricing API), so `min(fetchedAt)` stays old. Correlate with `PricingGapCount` — a gap on a live model is the usual driver here.

> **Not a cause: manual overrides.** Rows with `source: "override"` are **excluded** from this metric. An override exists precisely because AWS publishes no priced SKU for that model, so the refresher gaps it every run and never rewrites its `fetchedAt` — counting it would make the alarm fire on a permanent, un-actionable condition. (Observed 2026-08-15: the Mantle-served `openai.gpt-5.6-{sol,terra,luna}` overrides, authored 2026-07-30, became visible in `ListFoundationModels` and instantly pinned this metric at 15.3 days in **both** stages while the refresher was healthy — 135 refreshed, 0 errors, 0 skipped, age 538s the previous day. See [`docs/pricing-nuances.md`](../../pricing-nuances.md) for why Mantle models have no Price List SKU.) Override freshness is a *pricing-coverage* concern: track it via `PricingGapCount` and by reviewing each override row's `notes`/`fetchedAt` on the Pricing page.

## Investigation

```bash
# Last few invocations of pricing-refresher.
aws logs tail /aws/lambda/dev-bbg-pricing-refresher --since 48h --region us-west-2 --follow=false
# A healthy run logs: pricing-refresher complete {refreshed, gapCount, pricingRefreshAgeSeconds}
# — read pricingRefreshAgeSeconds straight off that line.

# Is the daily schedule still enabled?
aws scheduler get-schedule --name dev-bbg-pricing-refresh --region us-west-2

# Manually trigger one run to confirm the code path works.
aws lambda invoke --function-name dev-bbg-pricing-refresher --region us-west-2 /tmp/out.json
cat /tmp/out.json   # {"refreshed": N, "gaps": ["amazon.foo-v1:0", ...]}

# The metric itself — 1-day period / Maximum, matching the alarm.
aws cloudwatch get-metric-statistics --namespace bbg --metric-name PricingRefreshAge \
  --dimensions Name=service,Value=bbg \
  --start-time "$(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --period 86400 --statistics Maximum --region us-west-2 \
  --query 'Datapoints[].[Timestamp,Maximum]' --output table
# NO datapoints at all = the refresher went dark (the BREACHING path).

# Which live rows are oldest? The table PK is `model`; the timestamp is `fetchedAt`.
aws dynamodb scan --table-name dev-bbg-pricing --region us-west-2 \
  --projection-expression '#m, fetchedAt, #s' \
  --expression-attribute-names '{"#m":"model","#s":"source"}' \
  --max-items 20
# Cross-check any ancient row against the live catalog before treating it as a
# real gap — a deprecated model's row is excluded from the metric by design.
aws bedrock list-foundation-models --region us-west-2 \
  --query 'modelSummaries[].modelId' --output text | tr '\t' '\n' | sort

# Is PricingGapCount also rising? (related dashboard metric — different alarm)
aws cloudwatch get-metric-statistics --namespace bbg --metric-name PricingGapCount \
  --dimensions Name=service,Value=bbg \
  --start-time "$(date -u -v-24H '+%Y-%m-%dT%H:%M:%SZ')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --period 3600 --statistics Maximum --region us-west-2
```

## Remediation

- **Schedule disabled**: re-enable it.
  ```bash
  aws scheduler update-schedule --name dev-bbg-pricing-refresh --state ENABLED --region us-west-2
  ```
  If the schedule was deleted, redeploy `PricingStack` (which owns it):
  ```bash
  BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Pricing-us-west-2'
  ```
- **Lambda failure**: read the most recent error from CloudWatch Logs, fix in `lambda/src/pricing-refresher/index.ts`, ship via the normal CI/CD pipeline. For a same-day mitigation while the fix is in flight, invoke the Lambda manually to keep `PricingRefreshAge` low.
- **Throttling**: the Pricing client already uses adaptive retry (`retryMode: 'adaptive'`, `maxAttempts: 8`) and skips the redundant `AmazonBedrock` fallback pass for regions already priced. Retry once after a few minutes; if chronic, raise memory (default 1024MB) or split the refresher per service code. See [`pricing-refresher.md`](../pricing-refresher.md) cause 2.
- **New Bedrock model with a novel pricing shape**: add the `servicename` variant to `servicenameCandidates`, or the `usagetype` regex to `pricing-refresher/usagetype.ts`, and add a fixture under `lambda/test/fixtures/pricing/`.
- **Throttle on `Pricing` table**: bump the table to PAY_PER_REQUEST or raise provisioned WCU in `data-stack.ts`.
- **One stale live model**: treat it as a pricing gap. Fix the name-join if you can (that restores automatic refresh); otherwise set a manual override via the SPA's Pricing page (or `POST /admin/pricing/overrides`), which both prices the model and removes it from this metric — `source: "override"` rows are excluded by design (see the note under Likely causes), so the row stops pinning the age. Track the override itself via `PricingGapCount`. See [`alarms/pricing-gap-count.md`](pricing-gap-count.md).

Acceptance: a successful run logs `pricing-refresher complete` with a `pricingRefreshAgeSeconds` below `129600`, and the alarm transitions back to OK within the next evaluation period (up to a day, given the 1-day period).

## Related Lambda runbooks

- [`pricing-refresher`](../pricing-refresher.md)
- [`meter`](../meter.md) — downstream consumer of the `Pricing` table; if pricing is stale, meter spend numbers will be stale too.
- [`alarms/pricing-gap-count.md`](pricing-gap-count.md) — a live model with no priced SKU; a common driver of a single old `fetchedAt`.
