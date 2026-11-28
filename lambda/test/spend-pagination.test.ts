/**
 * Spend reads must follow every DynamoDB page.
 *
 * DynamoDB stops a Scan or Query page after reading 1 MB, before the filter
 * runs. On a RunningSpend table of about 3 MB, the first page of the old
 * /me/spend Scan read 266 items and returned none of the caller's rows, so the
 * page showed no spend for the month.
 */
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.RUNNING_SPEND_TABLE = 'test-running-spend';
const db = mockClient(DynamoDBDocumentClient);
const { handler } = await import('../src/api/spend');

const ME = 'arn:aws:iam::111122223333:role/SomeAdminRole';
const ASTRA_ROW = {
  principal: `principal#${ME}`,
  sk: 'period#2026-11#target#model#openai.gpt-6-astra',
  period: '2026-11',
  target: 'model#openai.gpt-6-astra',
  spendUsd: 2860.046294,
  cost_cacheReadTokens: 1967.417548,
};
const SECOND_PAGE = { principal: `principal#${ME}`, sk: 'period#2026-10#target#model#openai.gpt-6-astra' };

const meEvent = (routeKey: string, queryStringParameters: Record<string, string> = {}) => ({
  routeKey,
  queryStringParameters,
  requestContext: { authorizer: { jwt: { claims: { 'bbg:principal': ME } } } },
});
const adminEvent = (queryStringParameters: Record<string, string> = {}) => ({
  routeKey: 'GET /admin/spend',
  queryStringParameters,
  requestContext: { authorizer: { jwt: { claims: {
    'bbg:scope': '["*"]', 'cognito:groups': ['BBG-Admin-Wildcard'],
  } } } },
});

beforeEach(() => {
  db.reset();
  // Page 1 is full of other rows (filtered out); the match is on page 2.
  db.on(QueryCommand)
    .resolvesOnce({ Items: [], LastEvaluatedKey: SECOND_PAGE })
    .resolvesOnce({ Items: [ASTRA_ROW] });
  db.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: SECOND_PAGE });
});

describe('spend reads follow every page', () => {
  it('GET /me/spend returns a row that sits past the first page', async () => {
    const response = await handler(meEvent('GET /me/spend', { period: '2026-11' }) as never);
    const body = JSON.parse(response.body as string);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].target).toBe('model#openai.gpt-6-astra');
    expect(body.items[0].spendUsd).toBe(2860.046294);

    const queries = db.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(queries).toHaveLength(2);
    // The caller's own partition only: who can see whose spend is unchanged.
    expect(queries[0]).toMatchObject({
      KeyConditionExpression: 'principal = :me',
      ExpressionAttributeValues: { ':me': `principal#${ME}`, ':p': '2026-11' },
    });
    expect(queries[1].ExclusiveStartKey).toEqual(SECOND_PAGE);
    expect(db.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('GET /me/spend/trend sums rows past the first page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-28T12:00:00Z'));
    try {
      const response = await handler(meEvent('GET /me/spend/trend', { months: '1' }) as never);
      expect(JSON.parse(response.body as string).items)
        .toEqual([{ period: '2026-11', totalUsd: 2860.046294 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('GET /admin/spend returns rows past the first page', async () => {
    const response = await handler(adminEvent({ period: '2026-11' }) as never);
    const body = JSON.parse(response.body as string);
    expect(body.items.map((item: { target: string }) => item.target)).toEqual(['model#openai.gpt-6-astra']);
    expect(db.commandCalls(QueryCommand)).toHaveLength(2);
  });
});
