import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb } from '../../shared/ddb.js';
import { json, requireAdmin } from '../../shared/api.js';

const INFERENCE_PROFILES_TABLE = process.env.INFERENCE_PROFILES_TABLE!;

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const r = await ddb.send(new ScanCommand({ TableName: INFERENCE_PROFILES_TABLE }));
  return json(200, { items: r.Items ?? [] });
};
