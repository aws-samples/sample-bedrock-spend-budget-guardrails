import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { json, requireAdmin } from '../../shared/api.js';

const ssm = new SSMClient({});

/**
 * Authoritative source of Bedrock-supported regions: the public AWS
 * global-infrastructure SSM parameter tree. Each leaf parameter under
 * this path holds one region code as its `Value`. This namespace is
 * AWS-owned and readable by any account — no special data required —
 * and auto-updates as Bedrock launches in new regions.
 */
const SSM_PATH = '/aws/service/global-infrastructure/services/bedrock/regions';

/**
 * Static fallback used when the SSM lookup fails (throttling, transient
 * error, an account/region where the parameter tree isn't reachable).
 * Mirrors the current GA Bedrock region set so the endpoint never returns
 * empty and the enrollment UI always has something to render.
 */
const STATIC_FALLBACK: readonly string[] = [
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ca-central-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-gov-east-1',
  'us-gov-west-1',
  'us-west-1',
  'us-west-2',
];

/** Module-level cache so repeated invocations on a warm Lambda don't
 *  re-hit SSM. TTL is 12h — region availability changes rarely. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let cachedRegions: string[] | undefined;
let cachedAt = 0;

/** Paginate GetParametersByPath, collecting each leaf parameter's Value
 *  (the region code). Returns a sorted, de-duplicated list. */
const fetchRegionsFromSsm = async (): Promise<string[]> => {
  const regions = new Set<string>();
  let nextToken: string | undefined;
  do {
    const r = await ssm.send(
      new GetParametersByPathCommand({ Path: SSM_PATH, NextToken: nextToken }),
    );
    for (const p of r.Parameters ?? []) {
      if (typeof p.Value === 'string' && p.Value) regions.add(p.Value);
    }
    nextToken = r.NextToken;
  } while (nextToken);
  return [...regions].sort();
};

/** Resolve the region list: serve from cache, else SSM, else fall back to
 *  the static set on any failure. Always returns a sorted, non-empty list. */
const resolveRegions = async (): Promise<string[]> => {
  if (cachedRegions && Date.now() - cachedAt < CACHE_TTL_MS) return cachedRegions;
  try {
    const regions = await fetchRegionsFromSsm();
    if (regions.length > 0) {
      cachedRegions = regions;
      cachedAt = Date.now();
      return regions;
    }
  } catch {
    // Fall through to the static fallback below.
  }
  return [...STATIC_FALLBACK].sort();
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const regions = await resolveRegions();
  return json(200, { regions });
};
