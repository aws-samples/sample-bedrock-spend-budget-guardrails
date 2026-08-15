#!/usr/bin/env tsx
/**
 * Read-only dry-run harness for the pricing-refresher's name-join + SKU-tier
 * resolution. Runs the EXACT resolution chain the Lambda writes
 * (`resolveModelPricing` — alias → name-variants → usagetype-prefix), but makes
 * NO DynamoDB writes. This is the pre-deploy gate for the "37 gaps → 0" claim
 * and, via `--json`, the before/after rate-diff guard against mis-joins (a
 * broad name variant matching a DIFFERENT, wrongly-priced model).
 *
 * Requires AWS creds for the home account (Pricing API + bedrock:
 * ListFoundationModels). NEVER sets AWS_PROFILE.
 *
 * Usage:
 *   tsx scripts/test-pricing-refresher.ts                 # first few Claude models (smoke)
 *   tsx scripts/test-pricing-refresher.ts --all           # every live model; prints gap table + count
 *   tsx scripts/test-pricing-refresher.ts --model <id>    # one model, full per-region detail
 *   tsx scripts/test-pricing-refresher.ts --all --json    # machine-readable {modelId: {region: rates}}
 */
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { resolveModelPricing, featureFallbackFor, type RegionalPricing } from '../lambda/src/pricing-refresher';
import type { FoundationModelSummary } from '../lambda/src/pricing-refresher/cross-ref';

const METERED_REGIONS = (process.env.METERED_REGIONS ?? 'us-east-1,us-east-2,us-west-2')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const wantJson = args.includes('--json');
const modelFlagIdx = args.indexOf('--model');
const onlyModelId = modelFlagIdx >= 0 ? args[modelFlagIdx + 1] : undefined;

/** Flattens a resolved RegionalPricing into a {region: {dimension: rate}} map. */
const ratesOf = (regional: RegionalPricing): Record<string, Record<string, number>> => {
  const out: Record<string, Record<string, number>> = {};
  for (const [region, row] of Object.entries(regional)) {
    const dims: Record<string, number> = {};
    for (const [k, dim] of Object.entries(row.dimensions)) {
      if (dim) dims[k] = dim.pricePerUnit;
    }
    if (Object.keys(dims).length > 0) out[region] = dims;
  }
  return out;
};

const listLiveModels = async (): Promise<FoundationModelSummary[]> => {
  const byId = new Map<string, FoundationModelSummary>();
  for (const region of METERED_REGIONS) {
    const bedrock = new BedrockClient({ region });
    try {
      const r = await bedrock.send(new ListFoundationModelsCommand({}));
      for (const m of r.modelSummaries ?? []) {
        if (m.modelId && m.modelName && m.providerName) {
          byId.set(m.modelId, {
            modelId: m.modelId,
            modelName: m.modelName,
            providerName: m.providerName,
            modelLifecycle: m.modelLifecycle?.status,
          });
        }
      }
    } catch (err) {
      console.error(`ListFoundationModels failed in ${region}: ${(err as Error).message}`);
    }
  }
  return [...byId.values()];
};

const main = async (): Promise<void> => {
  let models = await listLiveModels();
  if (onlyModelId) {
    models = models.filter((m) => m.modelId === onlyModelId);
    if (models.length === 0) {
      console.error(`Model ${onlyModelId} not returned by ListFoundationModels in ${METERED_REGIONS.join(',')}`);
      process.exit(1);
    }
  } else if (!wantAll) {
    // Smoke default: a few well-known Claude models.
    models = models.filter((m) =>
      ['anthropic.claude-sonnet', 'anthropic.claude-haiku', 'anthropic.claude-opus'].some((p) =>
        m.modelId.startsWith(p),
      ),
    ).slice(0, 3);
  }

  console.error(`Resolving ${models.length} model(s) across ${METERED_REGIONS.join(', ')} (read-only)…`);

  const resolved: Record<string, Record<string, Record<string, number>>> = {};
  const gaps: string[] = [];
  const viaFeatureFallback: string[] = [];

  for (const m of models) {
    const regional = await resolveModelPricing(m);
    const rates = ratesOf(regional);
    if (Object.keys(rates).length > 0) {
      resolved[m.modelId] = rates;
    } else if (featureFallbackFor(m.modelId)) {
      // The handler prices these via the parent servicename (verified to
      // resolve for all current feature-fallback models); not a gap.
      viaFeatureFallback.push(m.modelId);
    } else {
      gaps.push(m.modelId);
    }
    if (onlyModelId) {
      console.log(`\n${m.modelId}  (${m.modelName}, ${m.providerName}):`);
      console.log(JSON.stringify(rates, null, 2));
    }
  }

  if (wantJson) {
    console.log(JSON.stringify({ resolved, gaps, viaFeatureFallback }, null, 2));
    return;
  }

  if (wantAll || !onlyModelId) {
    console.log(`\n=== SUMMARY ===`);
    console.log(`Total live models : ${models.length}`);
    console.log(`Resolved (priced) : ${Object.keys(resolved).length}`);
    console.log(`Feature-fallback  : ${viaFeatureFallback.length}`);
    console.log(`GAPS              : ${gaps.length}`);
    if (gaps.length > 0) {
      console.log(`\n=== GAP MODELS (no priced SKU found across any dimension) ===`);
      for (const id of gaps) console.log(`  ${id}`);
    }
  }
};

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
