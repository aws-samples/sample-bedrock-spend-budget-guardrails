import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb } from '../../shared/ddb.js';
import { json, noContent, parseBody } from '../../shared/api.js';

const PASSKEY_NICKNAMES_TABLE = process.env.PASSKEY_NICKNAMES_TABLE!;

const userIdFromClaims = (event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined => {
  const c = event.requestContext.authorizer.jwt.claims as Record<string, string | string[]>;
  const sub = c.sub;
  return typeof sub === 'string' ? sub : undefined;
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const route = event.routeKey;
  const userId = userIdFromClaims(event);
  if (!userId) return json(401, { error: 'No user identity' });

  if (route === 'GET /me/passkey-nicknames') {
    const r = await ddb.send(
      new QueryCommand({
        TableName: PASSKEY_NICKNAMES_TABLE,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
      }),
    );
    const items = (r.Items ?? []).map((it) => ({
      credentialId: it.credentialId as string,
      nickname: it.nickname as string,
      updatedAt: it.updatedAt as string | undefined,
    }));
    return json(200, { items });
  }

  if (route === 'PUT /me/passkey-nicknames/{credentialId}') {
    const credentialId = decodeURIComponent(event.pathParameters?.credentialId ?? '');
    if (!credentialId) return json(400, { error: 'credentialId required' });
    const body = parseBody<{ nickname?: string }>(event);
    const nickname = (body?.nickname ?? '').trim();
    if (!nickname) return json(400, { error: 'nickname required' });
    if (nickname.length > 64) return json(400, { error: 'nickname too long (max 64 chars)' });
    await ddb.send(
      new PutCommand({
        TableName: PASSKEY_NICKNAMES_TABLE,
        Item: { userId, credentialId, nickname, updatedAt: new Date().toISOString() },
      }),
    );
    return json(200, { credentialId, nickname });
  }

  if (route === 'DELETE /me/passkey-nicknames/{credentialId}') {
    const credentialId = decodeURIComponent(event.pathParameters?.credentialId ?? '');
    if (!credentialId) return json(400, { error: 'credentialId required' });
    await ddb.send(
      new DeleteCommand({
        TableName: PASSKEY_NICKNAMES_TABLE,
        Key: { userId, credentialId },
      }),
    );
    return noContent();
  }

  return json(404, { error: `Unknown route: ${route}` });
};
