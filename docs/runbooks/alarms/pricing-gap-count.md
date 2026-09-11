# Runbook: `PricingGapCount`

## Symptom

`<stage>-bbg-pricing-gap-count` alarms when the daily refresh reports unresolved models. The metric has dimensions `service=bbg, stage=<stage>` and emits one gauge per run, including zero. The alarm evaluates `Maximum > 0` over one 24-hour period; missing data is not breaching. Check the separate refresh-age alarm for a missing run.

## Investigation

1. Resolve the refresher's actual log group and inspect its completion summary. The `gaps` list identifies unresolved models; no placeholder `gap=true` pricing rows are written.
2. Check the model's raw ID, marketing name, aliases, usage types, regions, and routing variants in the Pricing API. A SKU may identify its model by raw ID rather than display name.
3. If the API has no usable SKU, check the official Bedrock pricing page and model card. Reviewed website fallbacks include source URLs and verification dates; they must cover cache, routing, and context tiers where applicable.
4. Check `UnpricedInvocations` to establish whether the gap affects traffic, and `PricingModelsSkipped` for incomplete refreshes.

```bash
LG=$(aws lambda get-function-configuration --function-name dev-bbg-pricing-refresher \
  --region us-west-2 --query 'LoggingConfig.LogGroup' --output text)
aws logs tail "$LG" --since 24h --region us-west-2

# Read-only resolver; use the same model/region scope as the failing run.
npx tsx scripts/test-pricing-refresher.ts --model openai.gpt-6-astra

# Refresh after fixing the resolver or adding reviewed published rates.
aws lambda invoke --function-name dev-bbg-pricing-refresher \
  --region us-west-2 --invocation-type Event /tmp/pricing-refresh-invoke.json
```

## Remediation

- Add a missing alias or usage classifier when a matching SKU already exists. Cover the actual API shape with a regression fixture.
- Add reviewed published rates in `lambda/src/pricing-refresher/published-pricing.ts` when the official website publishes rates before the API. Never borrow another model's price solely because its name is similar.
- Preserve operator overrides. Refreshes do not replace `source=override` rows, even after API pricing appears. Review and explicitly remove or migrate an obsolete override.
- For historical unpriced usage, use an audited conditional repair plan as described in [Pricing accuracy](../../pricing-accuracy.md). Reinvoking the refresher changes future prices; it does not repair past usage automatically.

## Verification

The refresher completes with zero gaps and zero skipped models. Confirm a real invocation resolves every observed usage dimension. The gap alarm clears after the previous nonzero sample leaves its daily evaluation window.

## Related runbooks

- [Pricing refresher](../pricing-refresher.md)
- [Unpriced invocations](unpriced-invocations.md)
- [Published price age](pricing-fallback-age.md)
