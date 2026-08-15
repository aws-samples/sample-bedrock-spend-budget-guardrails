/**
 * pricing-overrides discount API — hierarchical (account/OU/org) scopes.
 * Guards the scope validation, key building, legacy account back-compat, the
 * 0%-deletes behavior, and the on-write resolver trigger.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

const ddbSend = vi.fn();
const lambdaSend = vi.fn();

vi.mock('../src/shared/ddb.js', () => ({ ddb: { send: (c: unknown) => ddbSend(c) } }));
vi.mock('@aws-sdk/client-lambda', () => {
  class InvokeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { LambdaClient: class { send(c: unknown) { return lambdaSend(c); } }, InvokeCommand };
});
vi.mock('../src/shared/audit.js', () => ({ emitAudit: vi.fn() }));
vi.mock('../src/shared/powertools.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metrics: { addMetric: vi.fn(), publishStoredMetrics: vi.fn() },
}));

process.env.PRICING_TABLE = 'test-pricing';
process.env.DISCOUNT_RESOLVER_FN = 'test-resolver';
const { handler } = await import('../src/api/pricing-overrides/index.js');

const ev = (
  route: string,
  opts: { body?: unknown; qs?: Record<string, string>; path?: Record<string, string> } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey: route,
    requestContext: { authorizer: { jwt: { claims: { 'cognito:groups': ['BBG-Admin-Wildcard'] } } } },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    queryStringParameters: opts.qs,
    pathParameters: opts.path,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

beforeEach(() => {
  ddbSend.mockReset();
  ddbSend.mockResolvedValue({});
  lambdaSend.mockReset();
  lambdaSend.mockResolvedValue({});
});

describe('POST /admin/pricing/discounts — scopes', () => {
  it('legacy account shape ({accountId}) still works and keys discount#<acct>', async () => {
    const r = (await handler(
      ev('POST /admin/pricing/discounts', { body: { accountId: '123456789012', discountPct: 25 } }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(201);
    const put = ddbSend.mock.calls.find((c) => (c[0] as { input?: { Item?: { model?: string } } }).input?.Item);
    expect((put![0] as { input: { Item: { model: string } } }).input.Item.model).toBe('discount#123456789012');
  });

  it('OU scope keys discount#ou#<id>', async () => {
    await handler(ev('POST /admin/pricing/discounts', { body: { scope: 'ou', scopeId: 'ou-ab12-cdef3456', discountPct: 30 } }));
    const put = ddbSend.mock.calls.find((c) => (c[0] as { input?: { Item?: { model?: string } } }).input?.Item);
    expect((put![0] as { input: { Item: { model: string } } }).input.Item.model).toBe('discount#ou#ou-ab12-cdef3456');
  });

  it('org scope keys discount#org#<id>', async () => {
    await handler(ev('POST /admin/pricing/discounts', { body: { scope: 'org', scopeId: 'o-abc123defg', discountPct: 10 } }));
    const put = ddbSend.mock.calls.find((c) => (c[0] as { input?: { Item?: { model?: string } } }).input?.Item);
    expect((put![0] as { input: { Item: { model: string } } }).input.Item.model).toBe('discount#org#o-abc123defg');
  });

  it('rejects an invalid scopeId for the scope', async () => {
    const r = (await handler(
      ev('POST /admin/pricing/discounts', { body: { scope: 'ou', scopeId: 'not-an-ou', discountPct: 10 } }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(400);
  });

  it('0% on an OU/org scope deletes the authored row (nothing to exclude)', async () => {
    const r = (await handler(
      ev('POST /admin/pricing/discounts', { body: { scope: 'org', scopeId: 'o-abc123defg', discountPct: 0 } }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(204);
    const del = ddbSend.mock.calls.find((c) => (c[0] as { constructor: { name: string } }).constructor.name === 'DeleteCommand');
    expect(del).toBeTruthy();
  });

  it('0% on an ACCOUNT scope STORES an explicit exclusion (does not delete)', async () => {
    // Money-safety: deleting instead would let an OU/org discount silently
    // re-inherit. 0 must be stored so the resolver treats it as list price + wins.
    const r = (await handler(
      ev('POST /admin/pricing/discounts', { body: { scope: 'account', scopeId: '123456789012', discountPct: 0 } }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(201);
    const put = ddbSend.mock.calls.find((c) => (c[0] as { input?: { Item?: { model?: string } } }).input?.Item);
    const item = (put![0] as { input: { Item: { model: string; discountPct: number } } }).input.Item;
    expect(item.model).toBe('discount#123456789012');
    expect(item.discountPct).toBe(0);
    // No DeleteCommand issued.
    expect(ddbSend.mock.calls.some((c) => (c[0] as { constructor: { name: string } }).constructor.name === 'DeleteCommand')).toBe(false);
  });

  it('rejects an unknown scope value', async () => {
    const r = (await handler(
      ev('POST /admin/pricing/discounts', { body: { scope: 'evil', scopeId: 'o-abc123', discountPct: 50 } }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(400);
  });

  it('triggers the resolver on write (async Event invoke)', async () => {
    await handler(ev('POST /admin/pricing/discounts', { body: { scope: 'ou', scopeId: 'ou-ab12-cdef3456', discountPct: 30 } }));
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const inv = lambdaSend.mock.calls[0][0] as { input: { FunctionName: string; InvocationType: string } };
    expect(inv.input.FunctionName).toBe('test-resolver');
    expect(inv.input.InvocationType).toBe('Event');
  });
});

describe('GET /admin/pricing/discounts — surfaces scope + effective provenance', () => {
  it('maps each scope + returns effectivePct for account rows', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { model: 'discount#111111111111', effectivePct: 30, effectiveScope: 'ou', effectiveScopeId: 'ou-eng' },
        { model: 'discount#ou#ou-eng', discountPct: 30, scope: 'ou' },
        { model: 'discount#org#o-abc', discountPct: 10, scope: 'org' },
        { model: 'anthropic.claude-sonnet', dimensions: {} }, // real model row — excluded
      ],
    });
    const r = (await handler(ev('GET /admin/pricing/discounts'))) as { statusCode: number; body: string };
    const items = JSON.parse(r.body).items as Array<Record<string, unknown>>;
    // Real model row excluded; 3 discount rows mapped.
    expect(items).toHaveLength(3);
    const acct = items.find((i) => i.scope === 'account')!;
    expect(acct.scopeId).toBe('111111111111');
    expect(acct.effectivePct).toBe(30);
    expect(acct.effectiveScope).toBe('ou');
    expect(items.some((i) => i.scope === 'ou' && i.scopeId === 'ou-eng')).toBe(true);
    expect(items.some((i) => i.scope === 'org' && i.scopeId === 'o-abc')).toBe(true);
  });
});

describe('DELETE /admin/pricing/discounts — scope-aware', () => {
  it('deletes by ?scope=&scopeId= and triggers the resolver', async () => {
    const r = (await handler(
      ev('DELETE /admin/pricing/discounts', { qs: { scope: 'ou', scopeId: 'ou-ab12-cdef3456' } }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(204);
    const del = ddbSend.mock.calls.find((c) => (c[0] as { input?: { Key?: { model?: string } } }).input?.Key?.model === 'discount#ou#ou-ab12-cdef3456');
    expect(del).toBeTruthy();
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  it('legacy path-param delete still works for account scope', async () => {
    const r = (await handler(
      ev('DELETE /admin/pricing/discounts/{accountId}', { path: { accountId: '123456789012' } }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(204);
    const del = ddbSend.mock.calls.find((c) => (c[0] as { input?: { Key?: { model?: string } } }).input?.Key?.model === 'discount#123456789012');
    expect(del).toBeTruthy();
  });
});
