import { describe, expect, it } from 'vitest';
import { loadRegionOfferSkus } from '../src/pricing-refresher/bulk-offer';
import {
  classifyAmazonBedrockUsage,
  skuPrecedence,
  toPricePer1k,
} from '../src/pricing-refresher/usagetype';

/**
 * Live-network verification of the bulk-offer fallback source. Hits the public
 * AWS Price List offer files (no auth). Skips cleanly when offline / blocked so
 * CI without egress doesn't fail. When it runs, it proves the module reshapes
 * the real bulk file into the SkuJson shape the refresher's classifiers accept,
 * and that a known model prices correctly through the exact classify+precedence
 * path the handler uses.
 */
const firstOnDemandPrice = (sku: {
  terms: { OnDemand?: Record<string, { priceDimensions: Record<string, { unit: string; pricePerUnit: { USD?: string } }> }> };
}): { unit: string; price: number } | undefined => {
  const term = Object.values(sku.terms.OnDemand ?? {})[0];
  if (!term) return undefined;
  const dim = Object.values(term.priceDimensions)[0];
  if (!dim) return undefined;
  return { unit: dim.unit, price: Number(dim.pricePerUnit.USD ?? '0') };
};

const canReach = async (): Promise<boolean> => {
  try {
    const r = await fetch(
      'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/region_index.json',
      { method: 'HEAD' },
    );
    return r.ok;
  } catch {
    return false;
  }
};

describe('bulk-offer fallback source (live network)', () => {
  it('loads the us-east-1 offer file and prices a known model through the real classify path', async () => {
    if (!(await canReach())) {
      console.warn('bulk-offer test skipped — no network egress to pricing.us-east-1.amazonaws.com');
      return;
    }
    const skus = await loadRegionOfferSkus('us-east-1');
    expect(skus.length).toBeGreaterThan(100);
    // Every returned SKU must carry an on-demand price (loader filters those in).
    expect(skus.every((s) => s.terms.OnDemand && Object.keys(s.terms.OnDemand).length > 0)).toBe(true);

    // gpt-oss-120b is a known commercial AmazonBedrock model. Choose its best
    // input rate exactly like the refresher (lowest tier, then cheapest).
    const rows = skus.filter((s) => (s.product.attributes.model ?? '').toLowerCase() === 'gpt-oss-120b');
    expect(rows.length).toBeGreaterThan(0);

    let bestPrice: number | undefined;
    let bestPrec = Number.POSITIVE_INFINITY;
    for (const s of rows) {
      const ut = s.product.attributes.usagetype ?? '';
      const kind = classifyAmazonBedrockUsage(ut, s.product.attributes.inferenceType);
      const priced = firstOnDemandPrice(s);
      if (kind === 'input' && priced && priced.unit === '1K tokens') {
        const per1k = toPricePer1k(priced.price, 'AmazonBedrock');
        const prec = skuPrecedence(ut);
        if (prec < bestPrec || (prec === bestPrec && (bestPrice === undefined || per1k < bestPrice))) {
          bestPrec = prec;
          bestPrice = per1k;
        }
      }
    }
    // Known on-demand input rate for gpt-oss-120b in us-east-1 is $0.00015/1K.
    expect(bestPrice).toBe(0.00015);
  });
});
