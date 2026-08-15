# Runbook: `pricing-refresher`

## Purpose

Daily job that refreshes the `Pricing` DDB table by joining `bedrock:ListFoundationModels` (per metered region) against the AWS Pricing API across the three Bedrock service codes — `AmazonBedrockFoundationModels`, `AmazonBedrock`, and `AmazonBedrockService`. Produces the canonical per-`modelId` row the meter reads when costing every Bedrock invocation. Triggered by EventBridge Scheduler at `cron(0 3 * * ? *)` UTC; the Lambda lives in `us-east-1` because that's one of only three regions that host the Pricing API.

## Symptoms

- CloudWatch alarm `dev-bbg-pricing-refresh-age` fires (`PricingRefreshAge > 36h`) — the daily run hasn't completed.
- `PricingGapCount > 0` metric — `ListFoundationModels` returned models that have no priced SKU across any of the three service codes. Models surface on the Pricing UI as "Missing pricing"; admins can set manual overrides.
- Meter logs warning `unpriced invocation` and emits `UnpricedInvocations` for a real invocation against a model that was just released or that fell out of `ListFoundationModels` while still being callable.
- Pricing page in the SPA shows stale `fetchedAt` timestamps (>24h old).
- Logs in `/aws/lambda/dev-bbg-pricing-refresher`: `FoundationModels query failed`, `AmazonBedrock query failed`, `No pricing found across any dimension`.

## Likely causes (in order)

1. **Scheduler didn't fire.** `dev-bbg-pricing-refresh` EventBridge schedule disabled, deleted, or its IAM role lost `lambda:InvokeFunction`.
2. **Pricing API throttling.** `AmazonBedrockFoundationModels` walks ~45 servicenames × N regions × multiple `servicename` candidate variants per model — easy to hit Pricing API rate limits on a fresh-pool refresh. Manifests as `ThrottlingException` warnings; refresher partially succeeds but with elevated `PricingGapCount`.
3. **`bedrock:ListFoundationModels` failed in one or more regions.** IAM regression or a regional Bedrock outage. Logged as `ListFoundationModels failed in <region>` (warning, doesn't fail the run), but the model catalog gets shorter so subsequent meter lookups for those models return gaps.
4. **Pricing API schema drift.** Anthropic / Stability / TwelveLabs occasionally rename a `servicename` (e.g. add/remove the `(Amazon Bedrock Edition)` suffix, change `Pegasus v1.2` → `TwelveLabs Pegasus 1.2`). The candidate-name generator in `index.ts::servicenameCandidates` covers known variants but new ones surface as gaps.
5. **New `usagetype` naming convention.** `AmazonBedrockFoundationModels` ships at least three concurrent conventions (CamelCase `USE1_InputTokenCount_Global-Units`, snake_case+`_standard` `input_tokens_standard`, `Million*BatchInputTokens`). When a new launch invents a fourth, `classifyFoundationModelsUsage` returns null and SKUs are skipped silently.
6. **Cross-region inference profile (CRIS) confusion.** CRIS modelIds (`us.anthropic.claude-sonnet-4-6`) have NO Pricing API SKU. The meter strips the `us.`/`eu.`/`apac.`/`ap.` prefix before lookup — but if someone reports a CRIS gap, it's by design; the bare modelId row is what they want.
7. **Nova short-name reconciliation gap.** A new Nova model (Nova X) ships and isn't in the static `nova-map.ts`. Pricing API returns a `model="Nova X"` SKU but we have no canonical `amazon.nova-x-v1:0` modelId to write under.

## Investigation

```bash
# Last invocation of the daily refresh.
aws logs tail /aws/lambda/dev-bbg-pricing-refresher --since 36h --region us-west-2

# Schedule status (the scheduler lives in the Lambda's deploy region).
aws scheduler get-schedule --name dev-bbg-pricing-refresh --region us-west-2

# Manual invoke (out-of-band refresh).
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 /tmp/refresh.json && cat /tmp/refresh.json

# How many gaps did the last run produce? Returned in the Lambda response payload.
# {"refreshed": N, "gaps": ["amazon.foo-v1:0", ...]}

# Inspect a specific Pricing row.
aws dynamodb get-item \
  --table-name dev-bbg-pricing \
  --region us-west-2 \
  --key '{"model":{"S":"anthropic.claude-sonnet-4-6"}}'

# Cross-check the Pricing API directly (Pricing API is hosted in us-east-1 only).
aws pricing get-products --region us-east-1 \
  --service-code AmazonBedrockFoundationModels \
  --filters \
    Type=TERM_MATCH,Field=servicename,Value="Claude Sonnet 4.6 (Amazon Bedrock Edition)" \
    Type=TERM_MATCH,Field=regionCode,Value=us-west-2 \
  --max-results 5

# What does ListFoundationModels currently return in us-west-2?
aws bedrock list-foundation-models --region us-west-2 \
  --query 'modelSummaries[].[modelId,modelName,providerName]' --output table
```

## Remediation

### Cause 1 — Scheduler didn't fire

```bash
# Re-enable the schedule.
aws scheduler update-schedule \
  --name dev-bbg-pricing-refresh \
  --state ENABLED \
  --region us-west-2

# Or trigger an immediate refresh (idempotent).
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 /tmp/refresh.json
```

If the schedule was deleted, redeploy `PricingStack`:

```bash
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Pricing-us-west-2'
```

### Cause 2 — Pricing API throttling

The Lambda has a **15-minute timeout** (`Duration.minutes(15)` — the Lambda max) and **2048MB** memory. A run that hits the hard timeout mid-loop is killed before `metrics.publishStoredMetrics()`, which blinds `PricingRefreshAge` and `PricingGapCount`. To prevent that the handler enforces a **self-imposed time budget** (`TIME_BUDGET_RESERVE_MS`, 90s): once `context.getRemainingTimeInMillis()` drops below it, the model loop stops starting new models, then the tail (staleness scan + metric publish + return) always runs. A truncated run leaves prior rows intact (each is an independent PutItem), sets `incomplete: true`, and emits `PricingRefreshIncomplete=1` + `PricingModelsSkipped=<n>` so the shortfall is visible/alarmable (the `<stage>-bbg-pricing-refresh-incomplete` alarm).

**Primary source is now the bulk offer files, not the Query API** — this is the fix for the truncation that this cause describes. Previously `GetProducts` (the throttling, low-TPS Query API) was primary; at 5 metered regions the run bumped the 15-min cap and truncated, skipping the same ~35 tail models every run (deterministic loop order), so `PricingRefreshAge` climbed a day per run and `PricingRefreshIncomplete` stuck at 1. The refresher now pre-warms both service codes' static offer files once per run (`prewarmBulkOffers`) and prices every model off them in-memory; `GetProducts` runs only as a per-(model,region) fallback for what bulk missed. This takes the run from ~13.6 min to well under a minute and eliminates throttling as the dominant cost. The Pricing client still uses **adaptive retry** (`retryMode: 'adaptive'`, `maxAttempts: 8`) for the residual fallback calls. Manual re-run:

```bash
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 /tmp/refresh.json
```

The refresher emits **`PricingQueryFallbackUsed`** each time it has to fall back to `GetProducts` for a (model, region). A trickle is fine (an offer file lagging the Query index for a brand-new model, or the no-`model` embeddings/rerank SKUs which are only Query-addressable). A **sustained high count** means bulk coverage regressed — check that BOTH offer files loaded (`loaded bulk offer file` log lines for `AmazonBedrock` **and** `AmazonBedrockFoundationModels` in every region) and that the servicename/model candidates still match. See `docs/pricing-nuances.md` → "Bulk offer files". Neither source can price a model AWS publishes no commercial SKU for (e.g. proprietary GPT-5.x, GovCloud-only — distinct from the open-weight `gpt-oss-*` family, which is published and prices normally).

If `PricingRefreshIncomplete` still fires after this, the bulk downloads or the residual fallback volume are bumping the cap — check the `loaded bulk offer file` lines succeeded, then `PricingModelsSkipped` / `PricingQueryFallbackUsed` / run duration. Further headroom: parallelize the fallback calls within the adaptive-retry limit, or split the refresher per service code.

### Cause 3 — `ListFoundationModels` regional failure

Verify Bedrock is healthy in the affected region:

```bash
aws bedrock list-foundation-models --region us-east-2 --max-results 5
```

If a single region is permanently broken, drop it from `bbg:meteredRegions` in `cdk.json` and redeploy. Models are de-duplicated by `modelId` across regions so dropping one region rarely loses pricing data — only models that are exclusive to that region.

### Cause 4 — Schema drift (new `servicename` shape)

Add the new variant to `lambda/src/pricing-refresher/index.ts::servicenameCandidates`. Cover both with-and-without `(Amazon Bedrock Edition)` suffix and any provider-prefix variants. Then `npm run -w @bbg/lambda lint && npm run -w @bbg/lambda test`, deploy, and re-invoke.

### Cause 5 — New `usagetype` convention

Add the regex to `lambda/src/pricing-refresher/usagetype.ts::classifyFoundationModelsUsage` (or `classifyAmazonBedrockUsage` / `classifyNonTokenUsage` depending on which service code surfaces it). Reference `docs/pricing-nuances.md` for the existing conventions table. Watch out for `1KTPMHour` and `TextUnit` — those are Guardrails and reserved-throughput SKUs and must be excluded from token math.

### Cause 6 — CRIS profile reported as missing

Not a bug. Confirm the bare modelId has a row:

```bash
aws dynamodb get-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"anthropic.claude-sonnet-4-6"}}'
```

If yes, the meter will strip `us.`/`eu.`/`apac.`/`ap.` prefixes before lookup. No action needed.

### Cause 7 — New Nova model

Add the entry to `lambda/src/pricing-refresher/nova-map.ts::NOVA_MODEL_NAME_TO_ID`. Then redeploy and invoke. The pass-2 Nova reconciliation loop in `index.ts::handler` handles it from there.

### Last resort — admin pricing override

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

The override row has `source: "override"` and is preserved across daily refreshes (the refresher only writes rows with `source: "pricing-api*"`).

## Idempotency / safety notes

- **Safe to re-run any time.** The handler's only write is `PutCommand` to the Pricing table keyed by `model` (modelId), so repeated runs converge to the same row. The schedule's retry policy is `maximumRetryAttempts: 3`.
- **Does NOT clobber overrides.** Override rows have `source: "override"` and the refresher's writes use `source: "pricing-api"` / `"pricing-api-historical"` / `"pricing-api-feature-fallback"`. However, the writer uses `PutCommand` (full-row replace) keyed by modelId — if a refresh produces a row for a modelId that already has an override, the override IS overwritten. Today this is acceptable because admins set overrides specifically for models the API can't price; if the API later returns SKUs for the same modelId, the API value is now authoritative. If you need overrides to survive, add a `ConditionExpression: 'attribute_not_exists(#s) OR #s <> :override'`.
- **Per-token unit conversion is one-way.** `AmazonBedrockFoundationModels` returns prices per `Units` (= 1M tokens); the refresher divides by 1,000,000 via `toPricePer1k(price, 'AmazonBedrockFoundationModels')`. `AmazonBedrock` and `AmazonBedrockService` return per `1K tokens` natively. Don't double-convert.
- **CRIS → bare-model lookup is the meter's responsibility, not the refresher's.** The refresher writes rows keyed by bare modelId only; the meter strips `us.`/`eu.`/`apac.`/`ap.` regional prefixes at lookup time.
- **Skip TextUnit and 1KTPMHour SKUs** in the classifier — they're Guardrails and reserved-throughput-per-hour-per-1K-TPM, not token rates. `classifyAmazonBedrockUsage` already gates on `priced.unit === '1K tokens'` for token classification.

## Related runbooks

- [`inference-profile-refresher.md`](inference-profile-refresher.md) — companion daily that populates the `InferenceProfiles` table the meter joins against for profile-keyed budgets.
- [`cur-reconciler.md`](cur-reconciler.md) — daily Athena vs. meter-totals delta. Picks up when refresher gaps cause meter undercounting.
- [`meter-unjoined.md`](meter-unjoined.md) — different cause (CloudTrail wiring), but unpriced-invocation symptoms can look similar in the dashboard.
