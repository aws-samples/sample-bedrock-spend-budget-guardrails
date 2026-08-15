# Runbook: `UnpricedInvocations`

## Symptom

CloudWatch alarm `<stage>-bbg-unpriced-invocations` fires when the `bbg.UnpricedInvocations` metric exceeds **50** (`Sum` statistic) over **1 evaluation period of 15 minutes** (`treatMissingData: NOT_BREACHING`). The metric is emitted by the `meter` Lambda once per Bedrock invocation that lands against a `modelId` with no priced row in the `Pricing` DynamoDB table — i.e., a model that either has `gap=true` set by `pricing-refresher` or is missing from the `Pricing` table entirely.

Token counts (`tokensIn` / `tokensOut`) **are** still recorded on `RunningSpend`. Only the dollar-cost (`spendUsd` increment) is missing for those invocations. Budgets and enforcement that key off USD will under-count for the affected principals; budgets that key off raw tokens are unaffected.

A breach above 50 in 15 minutes (~3.3/min) suggests a real production caller is consistently hitting an unpriced model — not a one-off race between a new-model launch and the pricing refresh.

Default threshold: `Sum > 50` over 1 evaluation period (15 min).

## Severity guidance

- **Sev3** — sustained high rate (hundreds/min), or the metric is climbing alongside `PricingGapCount` for a model that's clearly in production use. Customer USD totals are diverging from CUR; expect a `ReconciliationDelta` follow-up alarm. Page the on-call.
- **Sev4** — a brief burst that decayed within an hour (likely caught right after a model launched and before the pricing refresh ran), or a low-volume internal test caller. File a ticket and confirm the next refresh closes the gap.

## Likely causes (in order)

1. **`PricingGapCount` is also non-zero.** The model is in `ListFoundationModels` but has no Pricing API match. Most common combined cause; treat the `PricingGapCount` alarm as the upstream root cause and remediate there. See [`pricing-gap-count.md`](pricing-gap-count.md).
2. **Caller is using a CRIS modelId that the meter didn't strip.** Cross-region inference profile IDs (`us.anthropic.claude-…`, `eu.…`, `apac.…`, `ap.…`) have no Pricing API SKU; the meter strips the regional prefix before lookup. If the prefix list has drifted (a new region prefix shipped, e.g., `mx.` for Mexico), the bare-model lookup misses and the invocation is logged as unpriced even though the bare model is priced.
3. **Caller is using a private / custom model ARN** (provisioned-throughput, custom model, or imported model). These models don't have an `AmazonBedrockFoundationModels` SKU — they're charged via `AmazonBedrockService` reserved-throughput SKUs that the meter currently skips. Spend for these callers is recorded in tokens but not USD by design.
4. **Gateway / proxy is forwarding a stale modelId.** A caller (or the optional `bbg-gateway` if enabled) is sending a deprecated modelId that AWS still accepts but that's no longer in the `Pricing` table. The model row was overwritten by a refresh that removed it.
5. **Pricing table write throttled / refresh hadn't propagated to all regions.** Less common — the meter reads `Pricing` from the same region it deploys in, and the refresher writes once globally. Surfaces only if `data-stack.ts` was changed to make `Pricing` regional.

## Investigation

```bash
# Tail meter logs for the warning emitted alongside this metric
aws logs tail /aws/lambda/dev-bbg-meter-us-west-2 --since 1h --region us-west-2 \
  --filter-pattern 'unpriced'

# Group recent unpriced invocations by modelId — needs CloudWatch Logs Insights
aws logs start-query --log-group-name /aws/lambda/dev-bbg-meter-us-west-2 --region us-west-2 \
  --start-time $(date -u -v-1H '+%s') --end-time $(date -u '+%s') \
  --query-string 'fields @timestamp, model, principal | filter @message like /unpriced/ | stats count() by model'

# Is PricingGapCount also non-zero? (root-cause check)
aws cloudwatch get-metric-statistics --namespace bbg --metric-name PricingGapCount \
  --start-time $(date -u -v-4H '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 3600 --statistics Maximum --region us-west-2

# Check the Pricing table for the offending modelId
aws dynamodb get-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"<modelId-from-meter-log>"}}'

# If the modelId has a CRIS-style prefix, check the bare row too
aws dynamodb get-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"<bare-modelId-without-prefix>"}}'
```

## Remediation

### Cause 1 — `PricingGapCount` upstream

Follow [`pricing-gap-count.md`](pricing-gap-count.md). Once the gap clears (refresh succeeds or operator sets a manual override), `UnpricedInvocations` returns to 0 on the next invocation against that model.

### Cause 2 — New CRIS regional prefix

Update the prefix-strip list in `lambda/src/meter/index.ts` (look for the array of `us.`/`eu.`/`apac.`/`ap.` prefixes). Add the new prefix, lint, test, and ship:

```bash
npm run -w @bbg/lambda lint && npm run -w @bbg/lambda test
```

### Cause 3 — Private / custom / provisioned-throughput model

Confirm by inspecting the modelId in meter logs — provisioned models have ARNs like `arn:aws:bedrock:us-west-2:<acct>:provisioned-model/<id>`, and imported / custom models have `arn:aws:bedrock:…:custom-model/…` or `…:imported-model/…`. These don't have foundation-model SKUs.

Two options:
- Set a manual pricing override keyed on the modelId (see `pricing-refresher.md` "Last resort" section).
- Accept the gap and rely on `ReconciliationDelta` + CUR for the dollar figure on those callers. Document the customer's intent in `docs/pricing-nuances.md`.

### Cause 4 — Stale modelId from a caller / gateway

Identify the caller from the meter log (`principal` field). Reach out and ask them to migrate to the current modelId. As a stopgap, set a manual pricing override on the deprecated modelId pointing at the new model's rates.

### Cause 5 — Pricing table replication lag

Re-invoke `pricing-refresher` and confirm the row appears in the meter's region. If `data-stack.ts` was changed to make `Pricing` regional, revert or ensure all regional tables receive writes.

### Mitigation while root cause is in flight

Set a manual pricing override on the offending modelId via the SPA Pricing page, or:

```bash
curl -X POST https://<api-url>/admin/pricing/overrides \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "model": "<offending-modelId>",
    "displayName": "<human-readable name>",
    "dimensions": {
      "inputTokens":  {"unit":"1K tokens","pricePerUnit":0.00010,"label":"Input tokens"},
      "outputTokens": {"unit":"1K tokens","pricePerUnit":0.00040,"label":"Output tokens"}
    },
    "notes": "Stopgap while <root cause> is in flight"
  }'
```

The override takes effect on the next meter invocation; no Lambda redeploy needed.

Acceptance: `bbg.UnpricedInvocations` returns to 0 within one 15-minute period after the next invocation against the model. The alarm transitions to OK on the following evaluation.

## Related Lambda runbooks

- [`meter`](../meter.md) — emitter of this metric; idempotency and lookup-flow details.
- [`pricing-refresher`](../pricing-refresher.md) — fixes the upstream gap that's the most common root cause.
- [`cur-reconciler`](../cur-reconciler.md) — surfaces the dollar drift if `UnpricedInvocations` runs sustained; `ReconciliationDelta` will follow.
- [`inference-profile-refresher`](../inference-profile-refresher.md) — populates the `InferenceProfiles` table the meter joins against; relevant when CRIS modelIds are involved.
