# Runbook: `meter` Lambda

## Purpose

The `meter` Lambda is the spend-attribution engine. It consumes Bedrock model-invocation log records from the `/aws/bedrock/<stage>-invocations-<region>` log group via a CloudWatch Logs subscription, joins them to a canonical IAM principal via the `IdentityCache` table, computes per-dimension cost from the `Pricing` table, and writes both an aggregate `spendUsd` and per-dimension columns onto `RunningSpend`. It also handles the back-channel `bbg.identity-arrived` EventBridge event that drains `PendingMeter` rows once the matching CloudTrail identity finally lands.

### Custom pricing discount (hot path)

The meter derives the account from the invocation's principal ARN and resolves a discount with **one cached `GetItem`** (5-min TTL per warm container) on the reserved `Pricing` row `discount#<accountId>`, then scales metered spend by `(1 − pct/100)` in `computeCost`. It **prefers the resolver-materialized `effectivePct`** — which already reflects OU/org inheritance and most-specific-wins precedence — over the account's own authored `discountPct`, falling back to the authored value for installs where [`org-discount-resolver`](org-discount-resolver.md) hasn't run (or isn't the Org management account). Hierarchical discounts add **no** hot-path work: the resolver walks the Organizations tree off-path and materializes the winner onto this same row.

An account row with authored **`discountPct: 0` is an explicit exclusion** — meter at list price, ignoring any OU/org discount the account would otherwise inherit. The resolver never materializes an `effectivePct` onto an excluded account, so there is no path where an inherited rate overrides the exclusion. See `effectiveDiscountFromRow` in `lambda/src/meter/index.ts`.

## Symptoms

- CloudWatch alarm `<stage>-bbg-meter-unjoined` firing (covered separately in [`meter-unjoined.md`](meter-unjoined.md)).
- `bbg.MeterSpendCommitted` metric drops to zero while Bedrock invocations are clearly happening (check the Bedrock invocation log group itself for activity).
- `RunningSpend` rows have `lastUpdated` that doesn't advance, or `spendUsd` doesn't move when traffic is happening.
- Lambda errors / DLQ depth on `<stage>-bbg-metering-dlq-<region>`.
- `UnpricedInvocations` metric climbing — the meter is running but can't price the model (Pricing table cold or model-id canonicalization broke).
- Log lines `processInvocation failed`, `commitJoinedSpend failed during identity-arrived drain`, or `Unrecognized meter event shape`.
- SPA spend tables show input/output token counts but no `spendUsd` (priced=false code path on `RunningSpend`).
- Apparent double-billing of a single requestId — should be impossible because of the `processedRequestIds` set guard; if you see it, the guard regressed.

## Likely causes (in order)

1. **Pricing table cold for a newly-launched model.** `bedrock:ListFoundationModels` returns a model the daily `pricing-refresher` hasn't yet ingested, so `lookupPricing()` returns `undefined`, the meter writes `usage_*` columns but no `cost_*` columns, increments `unpricedInvocations`, and emits the `UnpricedInvocations` metric. The `usage` is still recorded — only the dollar amount is missing.
2. **`modelId` canonicalization mismatch.** The meter strips inference-profile ARN wrappers and CRIS regional prefixes (`us.`, `eu.`, `apac.`, `ap.`, `global.`) via `stripCrisPrefix()` to find the bare model id in `Pricing`. A new regional prefix that isn't in the regex (or a model id format change) shows up as "priced=false" on every invocation of that model.
3. **ConverseStream zero-record contention.** ConverseStream emits TWO log records per `requestId` — first one has all token counters at zero (start-of-stream), second has the real totals (end-of-stream). The `hasUsage()` guard skips the zero record so the `processedRequestIds` set guard doesn't lock in the zero and reject the real one. If `hasUsage()` regressed, you'd see streamed invocations attributed at $0.
4. **Identity join window expired.** Meter event arrived but no `IdentityCache` row exists for that `requestId` yet — meter writes to `PendingMeter` and bumps `MeterUnjoined`. If CloudTrail data events stay missing for >1 hour, the `PendingMeter` row TTLs out and the spend is permanently lost. See [`meter-unjoined.md`](meter-unjoined.md).
5. **DDB throttling on `RunningSpend`.** PAY_PER_REQUEST should auto-scale, but a sudden multi-thousand-RPS spike on a single principal partition key can still hot-shard. Look for `ProvisionedThroughputExceededException` in the meter's logs.
6. **`UpdateExpression` schema drift.** Per-dimension usage/cost are FLAT top-level columns named `usage_<kind>` / `cost_<kind>` (NOT a nested map). DDB rejects mixing `ADD nested.path` with `SET if_not_exists(parent, ...)` as "two document paths overlap"; the flat-attr design sidesteps that. If anyone refactors back to a nested map, every write will fail with `ValidationException`.
7. **CloudWatch Logs subscription unsubscribed or filter pattern changed.** The `MeterSubscription` filter on the Bedrock log group must be `ALL` (no filter) — any filter will drop log records.

## Investigation

```bash
# Recent meter logs (errors and warnings first)
aws logs tail /aws/lambda/dev-bbg-meter-us-west-2 \
  --since 30m --filter-pattern '?ERROR ?WARN ?failed' --region us-west-2

# Full tail for one minute when reproducing
aws logs tail /aws/lambda/dev-bbg-meter-us-west-2 --follow --region us-west-2

# Lambda invocation + error counts
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=dev-bbg-meter-us-west-2 \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --region us-west-2

# DLQ depth
aws sqs get-queue-attributes \
  --queue-url $(aws sqs get-queue-url --queue-name dev-bbg-metering-dlq-us-west-2 \
    --region us-west-2 --query QueueUrl --output text) \
  --attribute-names ApproximateNumberOfMessages --region us-west-2

# Confirm CWL subscription still wired up (destination must be the meter Lambda)
aws logs describe-subscription-filters \
  --log-group-name /aws/bedrock/dev-invocations-us-west-2 --region us-west-2

# Pricing table — does the model in question even have a row?
aws dynamodb get-item --table-name dev-bbg-pricing \
  --key '{"model":{"S":"anthropic.claude-opus-4-7-v1"}}' --region us-west-2

# Spot-check a RunningSpend row for shape (flat usage_/cost_ attrs)
aws dynamodb query --table-name dev-bbg-running-spend \
  --key-condition-expression 'principal = :p' \
  --expression-attribute-values '{":p":{"S":"principal#arn:aws:iam::123456789012:role/SomeRole"}}' \
  --region us-west-2 --max-items 1

# Pending rows (should be small and draining)
aws dynamodb scan --table-name dev-bbg-pending-meter \
  --select COUNT --region us-west-2

# Recent BBG custom metrics
aws cloudwatch get-metric-statistics --namespace bbg \
  --metric-name MeterSpendCommitted \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --region us-west-2
aws cloudwatch get-metric-statistics --namespace bbg \
  --metric-name UnpricedInvocations \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --region us-west-2
```

## Remediation

**Cause 1 — Pricing table cold for a new model.** Force a pricing refresh:

```bash
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 /tmp/out.json && cat /tmp/out.json
```

If the model genuinely has no AWS Pricing API entry yet (common for preview models), set a manual override row in `Pricing` via the SPA's Pricing page. The meter will then start pricing future invocations; the historical `usage_*` rows can be repriced with `scripts/reprice.ts` if available, otherwise the dollar amount for those invocations is permanently lost (the AWS Pricing API doesn't support backfill).

**Cause 2 — modelId canonicalization mismatch.** Check `stripCrisPrefix()` in `lambda/src/shared/arn.ts` — the regex is `^(us|eu|apac|ap|global)\.`. If AWS introduced a new regional prefix, add it. After fixing, redeploy:

```bash
cdk deploy 'DevAppStage/Metering-us-west-2'
```

**Cause 3 — ConverseStream zero-record regression.** Confirm `hasUsage()` in `lambda/src/meter/index.ts` returns `false` for an all-zero log line. The unit test in `lambda/test/meter.test.ts` covers this; if it's green but production is broken, the log shape itself changed — diff a recent log line against `lambda/test/fixtures/`.

**Cause 4 — Identity join window expired.** See [`meter-unjoined.md`](meter-unjoined.md). The fix is on the identity side, not on the meter.

**Cause 5 — DDB throttling.** Check the `RunningSpend` table's CloudWatch metrics for `WriteThrottleEvents`. If hot-sharding on a single principal, the partition key is already the principal so there's nothing to redistribute — talk to the budget owner about rate-limiting that workload, or temporarily switch the table to provisioned mode with on-demand burst.

**Cause 6 — Schema drift.** Don't refactor `usage_<kind>` / `cost_<kind>` to a nested map. The comment block at line 144-149 of `lambda/src/meter/index.ts` explains why. Revert any change that does.

**Cause 7 — Subscription filter changed.** Re-deploy the metering stack to restore it:

```bash
cdk deploy 'DevAppStage/Metering-us-west-2'
```

## Idempotency / safety notes

- **Safe to retry the entire Lambda invocation.** Idempotency is enforced by the `processedRequestIds` SS attribute on `RunningSpend` plus a `ConditionalCheckFailedException`-as-success pattern. Replaying the same CWL batch is a no-op.
- **`bbg.identity-arrived` drain is also idempotent.** If `commitJoinedSpend()` fails because the requestId is already in `processedRequestIds`, the meter still deletes the `PendingMeter` row — the spend is already accounted for elsewhere.
- **Manually invoking the meter** with a synthesized event is safe but generally useless; the Lambda only does work when given either a real CWL gzip blob or an `bbg.identity-arrived` EventBridge event.
- **Don't manually delete `PendingMeter` rows during an active outage** — they're the system's record of unjoined spend and feed the recovery path. They auto-TTL after 1 hour.
- **Don't manually edit `RunningSpend` rows** — `enforcement` reads the stream and may attach a deny policy in response. Use the SPA's admin API (which uses the documented API surface) if you need to override.

## Related runbooks

- [`meter-unjoined.md`](meter-unjoined.md) — `MeterUnjoined > 0` alarm
- [`identity-cache.md`](identity-cache.md) — the upstream that emits `bbg.identity-arrived`
- [`enforcement.md`](enforcement.md) — the downstream that reads `RunningSpend` stream
- [`period-rollover.md`](period-rollover.md) — monthly cleanup of deny policies + `RunningSpend` rows
- [`org-discount-resolver.md`](org-discount-resolver.md) — materializes the `effectivePct` this Lambda reads on the money path
