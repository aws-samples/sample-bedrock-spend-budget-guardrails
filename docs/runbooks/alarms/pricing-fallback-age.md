# Runbook: PricingFallbackAge

## Signal

A live website fallback, manual override, or catalog row with reviewed context/service-tier metadata has not been reviewed for 30 days. This is separate from the daily refresher's execution health. A new `fetchedAt` does not renew `verifiedAt`.

## Resolution

1. Inspect `source`, `sourceUrl`, `verifiedAt`, and `fetchedAt` on the affected pricing rows.
2. Check current AWS documentation and commercial Price List SKUs for all billed dimensions, regions, routing modes, and context tiers.
3. Update reviewed fallback data or the operator override. Advance the review date only after checking the source.
4. Run the refresher and verify the stage-specific metric.

Do not rewrite review dates merely to clear the alarm. See [pricing accuracy](../../pricing-accuracy.md).
