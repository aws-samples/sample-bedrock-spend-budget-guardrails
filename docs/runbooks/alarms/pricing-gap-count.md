# Runbook: `PricingGapCount`

## Symptom

CloudWatch alarm `<stage>-bbg-pricing-gap-count` fires when the `bbg.PricingGapCount` metric is `> 0` (`Maximum` statistic) over **4 consecutive 1-hour evaluation periods** (`treatMissingData: NOT_BREACHING`). The metric is emitted by the `pricing-refresher` Lambda once per model that appears in `bedrock:ListFoundationModels` but has no matching SKU across any of the three Bedrock service codes (`AmazonBedrockFoundationModels`, `AmazonBedrock`, `AmazonBedrockService`). The model's row is written to the `Pricing` table with `gap=true` and no rate, so any caller invoking it will trip `UnpricedInvocations` in the meter.

A sustained breach across 4 hours means the gap is real (not a transient Pricing API blip) and BBG cannot dollar-cost the affected model until either the next refresh resolves it or an operator adds a manual override.

Default threshold: `Maximum > 0` over 4 evaluation periods of 1 hour each.

> **Steady state is 0 (verified 2026-07-30).** A live replay of the matcher over all 131 live models found that the genuine not-yet-priced set is **empty** — every gap was a BBG-side **name-join** failure, not AWS lagging on pricing. So treat any non-zero value as a join bug FIRST (cause 2/3/7), not "wait for AWS" (cause 1). Don't let the old "new models can be legitimately unpriced" framing talk you out of investigating.

## Fast triage — is it a join bug or a real gap?

Run the read-only dry-run harness (no DynamoDB writes) — it exercises the exact resolution chain the Lambda writes (`resolveModelPricing`):

```bash
# Uses your shell's existing credentials for the home account.
tsx scripts/test-pricing-refresher.ts --all          # prints resolved / feature-fallback / GAP counts + gap list
tsx scripts/test-pricing-refresher.ts --model <id>   # one model, per-region detail
```

1. If the harness resolves the model → it's a transient/throttling gap (cause 5); re-invoke the refresher.
2. If the harness ALSO gaps it, check whether the model's SKUs carry a `model` attribute at all:
   `aws pricing get-products --region us-east-1 --service-code AmazonBedrock --filters Type=TERM_MATCH,Field=model,Value='<name>' --max-results 1`. If 0 SKUs but the model clearly exists, it's a **no-`model`-attribute** SKU (Titan embeddings / Rerank / Nova Multimodal Embeddings) → add a `USAGETYPE_PREFIX` entry (cause 7).
3. Only if `GetProducts` returns 0 SKUs across all service codes for every metered region is it a genuine AWS-not-yet-priced gap (cause 1) → manual override + wait.

## Severity guidance

- **Sev3** — multiple models in gap, OR a model with material customer traffic is in gap (cross-check `UnpricedInvocations`). Spend for that model is recorded in tokens but not in USD; budgets and enforcement can't act on it. Page the on-call.
- **Sev4** — a single newly-launched model that hasn't propagated to the Pricing API yet, no real traffic against it. File a ticket and wait for the next refresh, or set a manual override if the customer is asking.

## Likely causes (in order)

1. **New Bedrock model launched without Pricing API SKU yet.** AWS announces a model in `ListFoundationModels` hours-to-days before its Pricing API row lands. Most common cause; usually self-resolves within 24-48h.
2. **Name-join failure — the dominant cause.** The Pricing API `model`/`servicename` differs from the LFM name in a way `name-variants.ts` doesn't cover, or it's a free-form marketing rename not in `model-aliases.ts` (e.g. `cohere.embed-v4:0` → `Cohere Embed 4 Model`). `GetProducts` returns 0 SKUs, so the model gaps before any classifier runs. Fix: add an alias or extend the normalizer.
3. **New `usagetype` naming convention.** `classifyFoundationModelsUsage` / `classifyAmazonBedrockUsage` / `classifyNonTokenUsage` returns `null` for the new shape; the SKU exists but is silently skipped, so the model row is written as a gap.
4. **Cross-region inference profile (CRIS) modelId surfaced as a gap.** False positive — CRIS modelIds (`us.anthropic.…`, `eu.…`, `apac.…`, `ap.…`) have no Pricing API SKU by design. The meter strips the regional prefix at lookup time. If the bare modelId already has a row, no action needed.
5. **Pricing API throttling during the refresh.** The refresher partial-completed; some models were skipped and recorded as gaps. Subsequent refreshes should clear them.
6. **Nova short-name reconciliation gap.** A new Nova variant ships and isn't in `nova-map.ts`; the API returns a `model="Nova X"` SKU but the refresher has no canonical `amazon.nova-x-v1:0` modelId to write under. NOTE: for a Nova model LFM ALREADY returns (e.g. Nova 2 Lite), nova-map is short-circuited — the fix belongs in `name-variants.ts` (cause 2), not nova-map.
7. **SKU carries no `model` attribute at all.** Titan embeddings, Amazon Rerank, and Nova Multimodal Embeddings SKUs have no `model`/`titanModel`-in-`model` attribute, so a `Field=model` query returns 0. They're reachable only via the `USAGETYPE_PREFIX` map + `Type=CONTAINS,Field=usagetype` pass in `index.ts`. A new model of this shape needs a `USAGETYPE_PREFIX` entry.

## Investigation

```bash
# Which models are currently flagged gap=true in the Pricing table?
aws dynamodb scan --table-name dev-bbg-pricing --region us-west-2 \
  --filter-expression 'gap = :t' \
  --expression-attribute-values '{":t":{"BOOL":true}}' \
  --projection-expression 'model, displayName, refreshedAt'

# Most recent pricing-refresher run — look for the `gaps` array in the response
aws logs tail /aws/lambda/dev-bbg-pricing-refresher --since 24h --region us-west-2 \
  --filter-pattern 'pricing-refresher complete'

# Manually re-invoke to see if the gap clears (idempotent)
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 /tmp/refresh.json && cat /tmp/refresh.json

# Cross-check the Pricing API directly for the gapped model — Pricing API is us-east-1 only
aws pricing get-products --region us-east-1 \
  --service-code AmazonBedrockFoundationModels \
  --filters \
    Type=TERM_MATCH,Field=servicename,Value="<expected servicename>" \
    Type=TERM_MATCH,Field=regionCode,Value=us-west-2 \
  --max-results 5

# Is UnpricedInvocations also rising? (i.e., real callers are hitting the gap)
aws cloudwatch get-metric-statistics --namespace bbg --metric-name UnpricedInvocations \
  --start-time $(date -u -v-4H '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 3600 --statistics Sum --region us-west-2

# What does ListFoundationModels currently return?
aws bedrock list-foundation-models --region us-west-2 \
  --query 'modelSummaries[].[modelId,modelName,providerName]' --output table
```

## Remediation

### Cause 1 — New model, Pricing API row not yet published

Wait. The next daily refresh after AWS publishes the SKU will clear the gap automatically. If a customer needs immediate dollar-costing, set a manual override (see "Last resort" below).

### Cause 2 — `servicename` schema drift

Add the new variant(s) to `lambda/src/pricing-refresher/index.ts::servicenameCandidates`. Cover both with-and-without `(Amazon Bedrock Edition)` suffix and any provider-prefix variants. Then:

```bash
npm run -w @bbg/lambda lint
npm run -w @bbg/lambda test
# ship via the normal CI/CD pipeline, then:
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 /tmp/refresh.json
```

### Cause 3 — New `usagetype` convention

Add the regex to `lambda/src/pricing-refresher/usagetype.ts::classifyFoundationModelsUsage` (or the appropriate sibling for `AmazonBedrock` / non-token SKUs). Reference `docs/pricing-nuances.md` for the existing conventions table.

### Cause 4 — CRIS profile surfacing as gap (false positive)

Confirm the bare modelId has a row:

```bash
aws dynamodb get-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"anthropic.claude-sonnet-4-6"}}'
```

If yes, no action — the meter strips `us.`/`eu.`/`apac.`/`ap.` prefixes at lookup. If the alarm keeps firing despite the meter handling it, the gap row is being written for the bare modelId itself and should be investigated as cause 1 or 2.

### Cause 5 — Throttling during refresh

Re-invoke the refresher manually 5+ minutes after the previous run:

```bash
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 /tmp/refresh.json
```

If throttling is chronic, raise refresher memory or split per service code (see `pricing-refresher.md` cause 2).

### Cause 6 — New Nova variant

Add the entry to `lambda/src/pricing-refresher/nova-map.ts::NOVA_MODEL_NAME_TO_ID`. Redeploy and invoke.

### Last resort — manual pricing override

Until upstream is fixed, an admin can set a manual pricing override on the Pricing page in the SPA, or via the API:

```bash
curl -X POST https://<api-url>/admin/pricing/overrides \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "model": "amazon.nova-x-v1:0",
    "displayName": "Amazon Nova X",
    "dimensions": {
      "inputTokens":  {"unit":"1K tokens","pricePerUnit":0.00010,"label":"Input tokens"},
      "outputTokens": {"unit":"1K tokens","pricePerUnit":0.00040,"label":"Output tokens"}
    },
    "notes": "Manual override pending Pricing API SKU"
  }'
```

The override row has `source: "override"` and survives subsequent refreshes only if no API SKU is found; once the upstream SKU lands, the API value becomes authoritative.

Acceptance: next `pricing-refresher` run logs `pricing-refresher complete` with `gapCount: 0` (or excludes the previously-gapped model from the `gaps` array). The alarm transitions to OK once `Maximum` of `PricingGapCount` is `0` for one full evaluation period.

## Related Lambda runbooks

- [`pricing-refresher`](../pricing-refresher.md) — the producer of this metric; deeper diagnosis of refresh failures.
- [`meter`](../meter.md) — downstream consumer; if the gap isn't resolved, the meter emits `UnpricedInvocations` for every call to the gapped model (see [`unpriced-invocations.md`](unpriced-invocations.md)).
- [`inference-profile-refresher`](../inference-profile-refresher.md) — companion daily; CRIS-related false positives are explained there.
