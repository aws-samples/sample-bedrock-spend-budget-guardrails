#!/usr/bin/env tsx
/* Throwaway: inspect Pricing SDK return shape. */
import { GetProductsCommand, PricingClient } from '@aws-sdk/client-pricing';

const main = async (): Promise<void> => {
  const c = new PricingClient({ region: 'us-east-1' });
  const r = await c.send(
    new GetProductsCommand({
      ServiceCode: 'AmazonBedrockFoundationModels',
      Filters: [
        { Type: 'TERM_MATCH', Field: 'servicename', Value: 'Claude Sonnet 4.6 (Amazon Bedrock Edition)' },
        { Type: 'TERM_MATCH', Field: 'regionCode', Value: 'us-east-1' },
      ],
      MaxResults: 3,
    }),
  );
  console.log('count:', r.PriceList?.length);
  const first = r.PriceList?.[0];
  console.log('typeof:', typeof first);
  console.log('is String wrapper?', first instanceof String);
  console.log('is Array?', Array.isArray(first));
  console.log('constructor:', (first as object).constructor?.name);
  console.log('valueOf:', String(first).slice(0, 200));
  // Try parsing it as if it WERE a string:
  try {
    const s = String(first);
    const parsed = JSON.parse(s);
    console.log('parsed keys:', Object.keys(parsed));
    console.log('attributes:', parsed.product?.attributes);
  } catch (e) {
    console.log('parse failed:', (e as Error).message);
  }
};
void main();
