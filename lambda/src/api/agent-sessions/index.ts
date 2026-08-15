import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb } from '../../shared/ddb.js';
import { callerScope, json, requireAdmin, scopeAllows } from '../../shared/api.js';
import { accountFromPrincipal } from '../../shared/iam-cross-account.js';

const AGENT_SESSIONS_TABLE = process.env.AGENT_SESSIONS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const scope = callerScope(event);
  const r = await ddb.send(new ScanCommand({ TableName: AGENT_SESSIONS_TABLE }));
  let items = r.Items ?? [];
  if (!scope.isWildcard) {
    // filter sessions whose IAM principal names an account in scope.
    items = items.filter((it) =>
      scopeAllows(scope, accountFromPrincipal(String(it.principal ?? ''))),
    );
  }
  return json(200, { items });
};
