import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { callerScope, json, requireAdmin } from '../../shared/api.js';
import { logger } from '../../shared/powertools.js';

/**
 * audit-log API. Runs CloudWatch Logs Insights against the
 * admin Lambda log groups for the `kind:"audit"` lines emitted by
 * an earlier change's `emitAudit`. Polls until the query completes (typical
 * Insights latency ~2-4s for the last 24h across these log groups)
 * then returns the results inline.
 *
 * Super-admin only — the audit trail spans every account; per-account
 * admins shouldn't see writes that target other accounts.
 */
const STAGE_PREFIX = process.env.STAGE_PREFIX!;
const cwl = new CloudWatchLogsClient({});

// All admin Lambdas that emit audit lines. Adding a new admin Lambda?
// Add its log group here so its writes show up in the SPA.
const AUDIT_LOG_GROUPS = [
  `/aws/lambda/${STAGE_PREFIX}-bbg-api-budgets`,
  `/aws/lambda/${STAGE_PREFIX}-bbg-api-users`,
  `/aws/lambda/${STAGE_PREFIX}-bbg-api-pricing-overrides`,
  `/aws/lambda/${STAGE_PREFIX}-bbg-api-enrollment`,
];

const QUERY = `
fields @timestamp, action, targetAccountId, operator.email, operator.sub, detail
| filter kind = "audit"
| sort @timestamp desc
| limit 200
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const scope = callerScope(event);
  if (!scope.isWildcard) {
    return json(403, { error: 'Forbidden: audit log is super-admin only' });
  }

  const route = event.routeKey;
  if (route !== 'GET /admin/audit') return json(404, { error: `Unknown route: ${route}` });

  const hours = Math.min(
    Math.max(parseInt(event.queryStringParameters?.hours ?? '24', 10) || 24, 1),
    24 * 7,
  );
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - hours * 3600;

  const start = await cwl.send(
    new StartQueryCommand({
      logGroupNames: AUDIT_LOG_GROUPS,
      startTime,
      endTime,
      queryString: QUERY,
    }),
  );
  const queryId = start.queryId;
  if (!queryId) return json(500, { error: 'StartQuery returned no queryId' });

  // Poll up to ~25s. Insights typically finishes in 2-4s for this
  // size of dataset; slow queries get a 504-ish response so the SPA
  // can retry rather than a hung Lambda.
  const deadline = Date.now() + 25_000;
  let results: { field?: string; value?: string }[][] = [];
  let completed = false;
  while (Date.now() < deadline) {
    const r = await cwl.send(new GetQueryResultsCommand({ queryId }));
    if (r.status === 'Complete') {
      results = r.results ?? [];
      completed = true;
      break;
    }
    if (r.status === 'Failed' || r.status === 'Cancelled' || r.status === 'Timeout') {
      logger.warn('audit query did not complete', { status: r.status });
      return json(504, { error: `Insights query ${r.status}` });
    }
    await sleep(1000);
  }
  // If we hit the deadline before Complete, stop the query (clean
  // shutdown) and tell the caller to retry. Distinct from "Complete
  // with 0 results" — the latter is a valid response and falls
  // through to render an empty list.
  if (!completed) {
    await cwl.send(new StopQueryCommand({ queryId })).catch(() => undefined);
    return json(504, { error: 'Insights query did not complete in 25s; retry' });
  }

  // Reshape Insights results into objects.
  const items = results.map((row) => {
    const obj: Record<string, string> = {};
    for (const f of row) {
      if (f.field && f.value !== undefined) obj[f.field] = f.value;
    }
    return obj;
  });

  return json(200, { items, hours, logGroups: AUDIT_LOG_GROUPS });
};
