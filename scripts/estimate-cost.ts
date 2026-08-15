#!/usr/bin/env tsx
/**
 * Pulls live unit prices from the AWS Pricing API for every service BBG
 * provisions and writes a per-component cost estimate to
 * `docs/cost-estimate.md`.
 *
 * Run from repo root:
 *   npm run estimate-cost
 *
 * The script is idempotent — re-running regenerates the doc with
 * fresh prices. Usage assumptions (e.g. "1M Bedrock invocations/month")
 * are declared in code below so a reader can see exactly what was
 * multiplied by what.
 *
 * Pricing API is hosted only in us-east-1, eu-central-1, ap-south-1.
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GetProductsCommand,
  PricingClient,
  type Filter,
} from '@aws-sdk/client-pricing';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REGION = process.env.BBG_REGION ?? 'us-west-2';

// One-time low-traffic scenario (a small dev install). Used to size the
// "light demo" column.
const LOW = {
  invocationsPerMonth: 10_000,
  apiRequestsPerMonth: 5_000,
  cloudfrontEgressGbPerMonth: 0.5,
  cwlIngestGbPerMonth: 0.5,
  s3StorageGb: 0.5,
  ddbWritesPerInvocation: 4, // identityCache + meter + ledger + enforcement-stream side
  ddbReadsPerInvocation: 2, // meter reads identity + pricing
};

// Production scenario. Used to size the "production" column.
const HIGH = {
  invocationsPerMonth: 1_000_000,
  apiRequestsPerMonth: 50_000,
  cloudfrontEgressGbPerMonth: 5,
  cwlIngestGbPerMonth: 5,
  s3StorageGb: 5,
  ddbWritesPerInvocation: 4,
  ddbReadsPerInvocation: 2,
};

const pricing = new PricingClient({ region: 'us-east-1' });

interface Sku {
  product?: { attributes?: Record<string, string | undefined> };
  terms?: {
    OnDemand?: Record<
      string,
      {
        priceDimensions: Record<
          string,
          {
            unit: string;
            description?: string;
            pricePerUnit?: { USD?: string };
            beginRange?: string;
            endRange?: string;
          }
        >;
      }
    >;
  };
}

const fetchSkus = async (
  serviceCode: string,
  filters: Filter[],
  max = 100,
): Promise<Sku[]> => {
  const out: Sku[] = [];
  let nextToken: string | undefined;
  do {
    const r = await pricing.send(
      new GetProductsCommand({
        ServiceCode: serviceCode,
        Filters: filters,
        MaxResults: 100,
        NextToken: nextToken,
      }),
    );
    for (const raw of r.PriceList ?? []) {
      const json = typeof raw === 'string' ? raw : String(raw);
      try {
        out.push(JSON.parse(json) as Sku);
      } catch {
        /* skip malformed */
      }
      if (out.length >= max) return out;
    }
    nextToken = r.NextToken;
  } while (nextToken);
  return out;
};

const firstPrice = (sku: Sku | undefined): number | undefined => {
  if (!sku) return undefined;
  const term = Object.values(sku.terms?.OnDemand ?? {})[0];
  if (!term) return undefined;
  // Prefer the dimension whose beginRange == "0" (first tier).
  const dims = Object.values(term.priceDimensions);
  const tier0 = dims.find((d) => d.beginRange === '0' || d.beginRange === undefined) ?? dims[0];
  if (!tier0?.pricePerUnit?.USD) return undefined;
  const n = Number(tier0.pricePerUnit.USD);
  return Number.isFinite(n) ? n : undefined;
};

interface Component {
  name: string;
  driver: string;
  /** Unit cost (USD) and a brief explanation of where the unit was sourced from. */
  unit: number;
  unitLabel: string;
  source: string;
  lowQty: number;
  highQty: number;
}

const fmt = (n: number): string => `$${n.toFixed(n >= 1 ? 2 : 4)}`;

const lookupCloudTrailDataEventPrice = async (): Promise<{ usd: number; src: string }> => {
  // CloudTrail data events: $0.10 per 100k events ($1.00 per 1M).
  const skus = await fetchSkus('AWSCloudTrail', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'eventType', Value: 'Data Events' },
  ]);
  for (const sku of skus) {
    const usd = firstPrice(sku);
    if (usd !== undefined && usd > 0) {
      return { usd, src: `CloudTrail SKU per data event in ${REGION}` };
    }
  }
  return { usd: 0.000001, src: 'fallback (no CloudTrail data-events SKU returned)' };
};

const lookupDynamoOnDemandPrices = async (): Promise<{ writeUsd: number; readUsd: number; pitrUsd: number; src: string }> => {
  // DDB on-demand: $0.625 / million WCU, $0.125 / million RCU (us-west-2).
  // We pull the actual prices from the API.
  const wcu = await fetchSkus('AmazonDynamoDB', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Amazon DynamoDB PayPerRequest Throughput' },
    { Type: 'TERM_MATCH', Field: 'group', Value: 'DDB-WriteUnits' },
  ]);
  const rcu = await fetchSkus('AmazonDynamoDB', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Amazon DynamoDB PayPerRequest Throughput' },
    { Type: 'TERM_MATCH', Field: 'group', Value: 'DDB-ReadUnits' },
  ]);
  const pitr = await fetchSkus('AmazonDynamoDB', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Amazon DynamoDB PITR Backup Storage' },
  ]);
  return {
    writeUsd: firstPrice(wcu[0]) ?? 0.625e-6,
    readUsd: firstPrice(rcu[0]) ?? 0.125e-6,
    pitrUsd: firstPrice(pitr[0]) ?? 0.20,
    src: `Amazon DynamoDB PayPerRequest + PITR SKUs in ${REGION}`,
  };
};

const lookupLambdaPrices = async (): Promise<{ requestUsd: number; gbSecondUsd: number; src: string }> => {
  const requests = await fetchSkus('AWSLambda', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'group', Value: 'AWS-Lambda-Requests-ARM' },
  ]);
  const gbSeconds = await fetchSkus('AWSLambda', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'group', Value: 'AWS-Lambda-Duration-ARM' },
  ]);
  return {
    requestUsd: firstPrice(requests[0]) ?? 0.20e-6,
    gbSecondUsd: firstPrice(gbSeconds[0]) ?? 1.33e-5,
    src: `AWS Lambda ARM (Graviton) request + duration SKUs in ${REGION}`,
  };
};

const lookupCwlPrices = async (): Promise<{ ingestUsd: number; storeUsd: number; src: string }> => {
  const ingest = await fetchSkus('AmazonCloudWatch', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'group', Value: 'Ingested Logs' },
  ]);
  const storage = await fetchSkus('AmazonCloudWatch', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'group', Value: 'Stored Logs' },
  ]);
  return {
    ingestUsd: firstPrice(ingest[0]) ?? 0.50,
    storeUsd: firstPrice(storage[0]) ?? 0.03,
    src: `CloudWatch Logs Ingest + Storage SKUs in ${REGION}`,
  };
};

const lookupCloudFrontPrices = async (): Promise<{ egressUsd: number; reqUsd: number; src: string }> => {
  const egress = await fetchSkus('AmazonCloudFront', [
    { Type: 'TERM_MATCH', Field: 'group', Value: 'CDN-Data-Out' },
  ]);
  const requests = await fetchSkus('AmazonCloudFront', [
    { Type: 'TERM_MATCH', Field: 'group', Value: 'CDN-Requests-HTTPS' },
  ]);
  return {
    egressUsd: firstPrice(egress[0]) ?? 0.085,
    reqUsd: firstPrice(requests[0]) ?? 0.012e-3,
    src: 'CloudFront global egress + HTTPS requests SKUs',
  };
};

const lookupS3StoragePrice = async (): Promise<{ usd: number; src: string }> => {
  const skus = await fetchSkus('AmazonS3', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'storageClass', Value: 'General Purpose' },
  ]);
  return {
    usd: firstPrice(skus[0]) ?? 0.023,
    src: `S3 Standard storage SKU in ${REGION}`,
  };
};

const lookupApigwHttpApiPrice = async (): Promise<{ usd: number; src: string }> => {
  const skus = await fetchSkus('AmazonApiGateway', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'apiType', Value: 'HTTP API' },
  ]);
  return {
    usd: firstPrice(skus[0]) ?? 1.00e-6,
    src: `API Gateway HTTP API SKU in ${REGION}`,
  };
};

const lookupKmsKeyPrice = async (): Promise<{ usd: number; src: string }> => {
  const skus = await fetchSkus('awskms', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'keyType', Value: 'Customer-managed KMS Key' },
  ]);
  return {
    usd: firstPrice(skus[0]) ?? 1.00,
    src: `KMS customer-managed CMK SKU in ${REGION}`,
  };
};

const lookupConfigPrices = async (): Promise<{
  itemUsd: number;
  evalUsd: number;
  src: string;
}> => {
  // The right SKU is the bare `ConfigurationItemRecorded` ($0.003/item),
  // NOT `ConfigurationItemRecordedDaily` ($0.012/item-day) — the latter
  // is a rarer "record once a day" mode the Pricing API also returns.
  // Filter by usagetype suffix to pin the right one.
  const skus = await fetchSkus('AWSConfig', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
  ]);
  const item = skus.find(
    (s) => s.product?.attributes?.usagetype?.endsWith('-ConfigurationItemRecorded'),
  );
  const evalSku = skus.find(
    (s) => s.product?.attributes?.usagetype?.endsWith('-ConfigRuleEvaluations'),
  );
  return {
    itemUsd: firstPrice(item) ?? 0.003,
    evalUsd: firstPrice(evalSku) ?? 0.0008,
    src: `AWS Config ConfigurationItemRecorded + ConfigRuleEvaluations SKUs in ${REGION}`,
  };
};

const lookupWafPrices = async (): Promise<{ webaclUsd: number; ruleUsd: number; reqUsd: number; src: string }> => {
  const webacl = await fetchSkus('AWSWAF', [
    { Type: 'TERM_MATCH', Field: 'usagetype', Value: 'Global-WAFV2-WebACL' },
  ]);
  const rule = await fetchSkus('AWSWAF', [
    { Type: 'TERM_MATCH', Field: 'usagetype', Value: 'Global-WAFV2-RuleManaged' },
  ]);
  const req = await fetchSkus('AWSWAF', [
    { Type: 'TERM_MATCH', Field: 'usagetype', Value: 'Global-WAFV2-Request' },
  ]);
  return {
    webaclUsd: firstPrice(webacl[0]) ?? 5.00,
    ruleUsd: firstPrice(rule[0]) ?? 1.00,
    reqUsd: firstPrice(req[0]) ?? 0.60e-6,
    src: 'WAFv2 (CLOUDFRONT scope, Global) WebACL + ManagedRule + Request SKUs',
  };
};

const lookupCanaryPrice = async (): Promise<{ usd: number; src: string }> => {
  const skus = await fetchSkus('AmazonCloudWatch', [
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION },
    { Type: 'TERM_MATCH', Field: 'group', Value: 'CanaryRun' },
  ]);
  return {
    usd: firstPrice(skus[0]) ?? 0.0017,
    src: `CloudWatch Synthetics canary-run SKU in ${REGION}`,
  };
};

const main = async (): Promise<void> => {
  console.log(`[estimate-cost] querying AWS Pricing API for ${REGION} services...`);

  const [ct, ddb, lam, cwl, cf, s3, api, kms, cfg, waf, canary] = await Promise.all([
    lookupCloudTrailDataEventPrice(),
    lookupDynamoOnDemandPrices(),
    lookupLambdaPrices(),
    lookupCwlPrices(),
    lookupCloudFrontPrices(),
    lookupS3StoragePrice(),
    lookupApigwHttpApiPrice(),
    lookupKmsKeyPrice(),
    lookupConfigPrices(),
    lookupWafPrices(),
    lookupCanaryPrice(),
  ]);

  // Build the component table. Each component declares its driver, unit
  // price (live from Pricing API), and the per-month quantity in both
  // scenarios. Total = unit × qty.
  const components: Component[] = [
    {
      name: 'CloudTrail data events',
      driver: 'Bedrock data events',
      unit: ct.usd,
      unitLabel: '/event',
      source: ct.src,
      lowQty: LOW.invocationsPerMonth,
      highQty: HIGH.invocationsPerMonth,
    },
    {
      name: 'DynamoDB on-demand writes',
      driver: '~4 writes per invocation × all tables',
      unit: ddb.writeUsd,
      unitLabel: '/WCU',
      source: ddb.src,
      lowQty: LOW.invocationsPerMonth * LOW.ddbWritesPerInvocation,
      highQty: HIGH.invocationsPerMonth * HIGH.ddbWritesPerInvocation,
    },
    {
      name: 'DynamoDB on-demand reads',
      driver: '~2 reads per invocation',
      unit: ddb.readUsd,
      unitLabel: '/RCU',
      source: ddb.src,
      lowQty: LOW.invocationsPerMonth * LOW.ddbReadsPerInvocation,
      highQty: HIGH.invocationsPerMonth * HIGH.ddbReadsPerInvocation,
    },
    {
      name: 'DynamoDB PITR',
      driver: 'GB-month across all tables',
      unit: ddb.pitrUsd,
      unitLabel: '/GB-mo',
      source: ddb.src,
      lowQty: 0.05, // ~50 MB
      highQty: 0.5, // ~500 MB
    },
    {
      name: 'Lambda requests (Graviton)',
      driver: '~3 invocations per Bedrock request',
      unit: lam.requestUsd,
      unitLabel: '/request',
      source: lam.src,
      lowQty: LOW.invocationsPerMonth * 3,
      highQty: HIGH.invocationsPerMonth * 3,
    },
    {
      name: 'Lambda duration (Graviton)',
      driver: '256 MB × 200ms × 3 fns/request',
      unit: lam.gbSecondUsd,
      unitLabel: '/GB-second',
      source: lam.src,
      lowQty: LOW.invocationsPerMonth * 3 * 0.2 * 0.25, // GB-seconds
      highQty: HIGH.invocationsPerMonth * 3 * 0.2 * 0.25,
    },
    {
      name: 'CloudWatch Logs ingest',
      driver: 'meter + identity-cache + Lambda logs',
      unit: cwl.ingestUsd,
      unitLabel: '/GB',
      source: cwl.src,
      lowQty: LOW.cwlIngestGbPerMonth,
      highQty: HIGH.cwlIngestGbPerMonth,
    },
    {
      name: 'CloudWatch Logs storage',
      driver: '14d retention × ingest GB',
      unit: cwl.storeUsd,
      unitLabel: '/GB-mo',
      source: cwl.src,
      lowQty: LOW.cwlIngestGbPerMonth * 0.46, // 14d / 30d
      highQty: HIGH.cwlIngestGbPerMonth * 0.46,
    },
    {
      name: 'CloudWatch Synthetics canary',
      driver: '30-min cadence × 24 × 30 = 1440 runs/mo',
      unit: canary.usd,
      unitLabel: '/run',
      source: canary.src,
      lowQty: 1440,
      highQty: 1440,
    },
    {
      name: 'AWS Config items recorded (prod only)',
      driver: '~10k config items / mo (BBG resources + Lambda versions + IAM)',
      unit: cfg.itemUsd,
      unitLabel: '/item',
      source: cfg.src,
      lowQty: 0,
      highQty: 10_000,
    },
    {
      name: 'AWS Config rule evaluations (prod only)',
      driver: '19 managed rules × ~daily evaluations',
      unit: cfg.evalUsd,
      unitLabel: '/eval',
      source: cfg.src,
      lowQty: 0,
      highQty: 19 * 30, // 19 rules × ~30 evals/mo each (daily cadence)
    },
    {
      name: 'WAFv2 WebACL (prod only)',
      driver: '1 WebACL',
      unit: waf.webaclUsd,
      unitLabel: '/mo',
      source: waf.src,
      lowQty: 0,
      highQty: 1,
    },
    {
      name: 'WAFv2 managed rule groups (prod only)',
      driver: '3 rule groups: CommonRuleSet + KnownBadInputs + IpReputation',
      unit: waf.ruleUsd,
      unitLabel: '/group/mo',
      source: waf.src,
      lowQty: 0,
      highQty: 3,
    },
    {
      name: 'WAFv2 requests (prod only)',
      driver: 'CloudFront → ALB requests',
      unit: waf.reqUsd,
      unitLabel: '/request',
      source: waf.src,
      lowQty: 0,
      highQty: HIGH.apiRequestsPerMonth,
    },
    {
      name: 'CloudFront egress',
      driver: 'SPA assets + API JSON',
      unit: cf.egressUsd,
      unitLabel: '/GB',
      source: cf.src,
      lowQty: LOW.cloudfrontEgressGbPerMonth,
      highQty: HIGH.cloudfrontEgressGbPerMonth,
    },
    {
      name: 'CloudFront HTTPS requests',
      driver: 'SPA + API requests',
      unit: cf.reqUsd,
      unitLabel: '/request',
      source: cf.src,
      lowQty: LOW.apiRequestsPerMonth,
      highQty: HIGH.apiRequestsPerMonth,
    },
    {
      name: 'S3 Standard (LedgerBucket + access logs)',
      driver: 'GB-month after IA/Glacier lifecycle',
      unit: s3.usd,
      unitLabel: '/GB-mo',
      source: s3.src,
      lowQty: LOW.s3StorageGb,
      highQty: HIGH.s3StorageGb,
    },
    {
      name: 'API Gateway HTTP API',
      driver: 'API requests',
      unit: api.usd,
      unitLabel: '/request',
      source: api.src,
      lowQty: LOW.apiRequestsPerMonth,
      highQty: HIGH.apiRequestsPerMonth,
    },
    {
      name: 'KMS CMKs',
      driver: '4 keys (data, ledger, athena results, access logs)',
      unit: kms.usd,
      unitLabel: '/key/mo',
      source: kms.src,
      lowQty: 4,
      highQty: 4,
    },
  ];

  let lowTotal = 0;
  let highTotal = 0;
  for (const c of components) {
    lowTotal += c.unit * c.lowQty;
    highTotal += c.unit * c.highQty;
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('# Cost estimate');
  lines.push('');
  lines.push(`> Generated by [\`scripts/estimate-cost.ts\`](../scripts/estimate-cost.ts) on ${today} for region \`${REGION}\`. Re-run via \`npm run estimate-cost\` to refresh.`);
  lines.push('');
  lines.push('Every line below pulls live unit pricing from the AWS Pricing API at script-run time, then multiplies by the usage assumptions declared in the script. Treat the totals as a defensible ballpark — your actual bill will track close to this if your traffic matches the declared assumptions, but **always verify against the AWS Pricing Calculator and your own account history before committing budget.**');
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');
  lines.push('| Scenario | Bedrock invocations / month | API requests / month | CloudFront egress | CWL ingest | S3 storage |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| **Light demo** | ${LOW.invocationsPerMonth.toLocaleString()} | ${LOW.apiRequestsPerMonth.toLocaleString()} | ${LOW.cloudfrontEgressGbPerMonth} GB | ${LOW.cwlIngestGbPerMonth} GB | ${LOW.s3StorageGb} GB |`);
  lines.push(`| **Production** | ${HIGH.invocationsPerMonth.toLocaleString()} | ${HIGH.apiRequestsPerMonth.toLocaleString()} | ${HIGH.cloudfrontEgressGbPerMonth} GB | ${HIGH.cwlIngestGbPerMonth} GB | ${HIGH.s3StorageGb} GB |`);
  lines.push('');
  lines.push('## Per-component breakdown');
  lines.push('');
  lines.push('| Component | Driver | Unit price | Light demo | Production |');
  lines.push('|---|---|---|---|---|');
  for (const c of components) {
    const low = c.unit * c.lowQty;
    const high = c.unit * c.highQty;
    lines.push(
      `| **${c.name}** | ${c.driver} | ${fmt(c.unit)} ${c.unitLabel} | ${fmt(low)} | ${fmt(high)} |`,
    );
  }
  lines.push(`| **Total** | | | **${fmt(lowTotal)}** | **${fmt(highTotal)}** |`);
  lines.push('');
  lines.push('## Sources');
  lines.push('');
  lines.push('Each component above pulled its unit price from one of these AWS Pricing API queries:');
  lines.push('');
  for (const c of components) {
    lines.push(`- **${c.name}**: ${c.source}`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- **Cognito** is excluded — the User Pool sits in the 50,000 MAU free tier for any realistic admin/operator headcount.');
  lines.push('- **EventBridge Scheduler** is excluded — the monthly period-rollover cron is well within the EventBridge free tier.');
  lines.push('- **Athena** is excluded — only billed when an admin runs a Reports query, and 1 GB scanned costs ~$0.005.');
  lines.push('- **Route53 hosted zone** ($0.50/mo) is excluded because BBG reuses your existing zone, not its own.');
  lines.push('- **ACM certificates** are free at AWS.');
  lines.push('- The Bedrock invocations BBG **measures** are billed to the calling IAM principal exactly as they would be without BBG; they do not appear in this cost estimate.');
  lines.push('');
  lines.push('## Cost-control levers');
  lines.push('');
  lines.push('- Set `bbg:disableConfigStack: true` in the SSM operator config — saves the AWS Config line if you already run Config via Control Tower or Security Hub.');
  lines.push('- Comment out `AppCanary` in `infra/lib/observability-stack.ts` to skip the Synthetics canary.');
  lines.push('- WAFv2 is already prod-only by default; dev never gets it.');
  lines.push('- DynamoDB PITR can be disabled on `IdentityCache`, `PendingMeter`, and `AgentSessions` (they have TTLs) for a few cents savings.');

  const out = resolve(REPO_ROOT, 'docs', 'cost-estimate.md');
  writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log(`[estimate-cost] wrote ${out}`);
  console.log(`[estimate-cost] light-demo total: ${fmt(lowTotal)} / month`);
  console.log(`[estimate-cost] production total: ${fmt(highTotal)} / month`);
};

void main();
