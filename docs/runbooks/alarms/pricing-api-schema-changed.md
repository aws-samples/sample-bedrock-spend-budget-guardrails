# Runbook: `PricingApiSchemaChanged`

> **GOOD-NEWS ALARM.** This fires when AWS ships an open AWS feature request that lets us simplify the pricing-refresher. Don't page anyone — schedule a refactor.

## Symptom

CloudWatch alarm `<stage>-bbg-pricing-api-schema-changed` fires when `bbg.PricingApiSchemaChanged > 0` over a 1-hour window. The metric is emitted by `pricing-refresher` the first time it sees ANY SKU on the `AmazonBedrockFoundationModels` Pricing API service code carry a populated value for `modelId`, `inferenceType`, or `model` — attributes that, as of 2026-05, are absent on every SKU. The metric carries an `attribute=<modelId|inferenceType|model>` dimension naming which one was found.

Today the refresher joins by `servicename` via a cross-reference against `bedrock:ListFoundationModels` (see `lambda/src/pricing-refresher/cross-ref.ts` and `usagetype.ts`). When this alarm fires, AWS has shipped the open AWS feature request and the cross-reference workaround can be retired in favor of a one-step direct lookup.

## Severity guidance

- **Sev5 / informational** — schedule a refactor task within the week. Not page-worthy. The existing cross-API logic continues to work after the schema change; it just becomes redundant.

## Likely causes (in order)

1. **AWS shipped the AWS feature request.** The expected case. Confirm via direct probe (see Investigation).
2. **Partial backfill.** AWS may populate a stable identifier on a subset of SKUs first (e.g., only newer marketplace-edition Anthropic models). Check the dimension on the metric and the structured log line — it names the SKU. If only one provider carries the new attribute, hold off on the refactor; wait for full coverage.
3. **Pricing API schema regression** (extremely unlikely). AWS could ship a schema change that adds a stub field with empty values and our string-trim guard would still hit. The structured log line includes the raw value — if it's a sentinel like `"<unset>"` or always-empty-after-trim, file feedback to AWS Pricing.

## Investigation

```bash
# Confirm the metric value across a wide window. Should be > 0 only after the AWS feature request ships.
aws cloudwatch get-metric-statistics --namespace bbg --metric-name PricingApiSchemaChanged \
  --start-time $(date -u -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics Sum --region us-west-2

# Find the SKU(s) the refresher saw the attribute on. The structured log
# line includes sku, servicename, attribute, and value.
aws logs tail /aws/lambda/prod-bbg-pricing-refresher --since 24h --region us-west-2 \
  | grep 'PricingApiSchemaChanged\|now carries a schema-watch attribute'

# Direct probe: confirm the new attribute is queryable via the Pricing API.
aws pricing get-attribute-values --service-code AmazonBedrockFoundationModels \
  --attribute-name modelId --region us-east-1
# (us-east-1 is the only region for the pricing service control plane.)

# Cross-check the new attribute against bedrock:ListFoundationModels
# to ensure the identifiers actually align with what we'd use for joining.
aws bedrock list-foundation-models --query 'modelSummaries[].modelId' --region us-west-2
```

## Remediation

This isn't a remediation in the operational sense — it's a refactor opportunity:

1. **Confirm the schema change is durable** — wait one full daily-refresher cycle before acting (the metric only emits once per attribute per run; if the SKU list is partial, give AWS time to backfill).
2. **File a tracking issue** titled "Retire pricing-refresher cross-API workaround". Acceptance:
   - `lambda/src/pricing-refresher/cross-ref.ts` collapses to a direct `pricing:GetProducts --filters Field=modelId,Value=<id>` call
   - `lambda/src/pricing-refresher/usagetype.ts` keeps its parsing logic (still needed — usagetype naming variants are unrelated to the modelId gap)
   - `lambda/test/pricing-refresher.test.ts` updated to reflect the new shape
   - `docs/pricing-nuances.md` updated to note the refactor
3. **Retire this alarm + metric** as part of the same PR — once the workaround is gone, the watch is also unnecessary. The alarm + metric definitions live in `infra/lib/observability-stack.ts` and `lambda/src/pricing-refresher/index.ts`.

After the refactor lands, BBG's pricing-refresher gets simpler, faster, and easier to reason about. Tag the PR description with this alarm name so the historical context is preserved.

## Related Lambda runbooks

- [`pricing-refresher.md`](../pricing-refresher.md) — the Lambda that emits the metric
- [`pricing-gap-count.md`](pricing-gap-count.md) — companion alarm for when a model is in `ListFoundationModels` but no Pricing API match
- [`unpriced-invocations.md`](unpriced-invocations.md) — companion alarm for when a meter invocation hits an unpriced model
