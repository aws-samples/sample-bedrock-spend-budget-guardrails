import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.RUNNING_SPEND_TABLE = 'test-running-spend';
const db = mockClient(DynamoDBDocumentClient);
const event = (queryStringParameters: Record<string, string> = {}) => ({
  routeKey: 'GET /admin/spend',
  queryStringParameters,
  requestContext: { authorizer: { jwt: { claims: {
    'bbg:scope': '["*"]', 'cognito:groups': ['BBG-Admin-Wildcard'],
  } } } },
});

beforeEach(() => {
  db.reset();
  db.on(QueryCommand).resolves({ Items: [] });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('current spend by budget window', () => {
  it.each([
    ['monthly', '2026-09'],
    ['weekly', 'weekly:2026-W39'],
    ['daily', 'daily:2026-09-21'],
    ['5h', '5h:2026-09-21T10'],
  ])('queries the current %s period', async (window, period) => {
    const { handler } = await import('../src/api/spend');
    const response = await handler(event({ window }) as never);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string).period).toBe(period);
    expect(db.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues)
      .toEqual({ ':p': period });
  });

  it('preserves the monthly default and explicit historical period', async () => {
    const { handler } = await import('../src/api/spend');
    expect(JSON.parse((await handler(event() as never)).body as string).period).toBe('2026-09');
    const response = await handler(event({ window: 'daily', period: 'daily:2026-09-01' }) as never);
    expect(JSON.parse(response.body as string).period).toBe('daily:2026-09-01');
  });

  it('rejects an unsupported window without querying DynamoDB', async () => {
    const { handler } = await import('../src/api/spend');
    expect((await handler(event({ window: 'hourly' }) as never)).statusCode).toBe(400);
    expect(db.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
