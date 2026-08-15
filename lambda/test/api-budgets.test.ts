import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

// The budgets handler reads BUDGETS_TABLE / RUNNING_SPEND_TABLE at module
// load. `accountFromPrincipal` (shared/iam-cross-account.ts) is strict:
// iam|sts ARN → account, anything else → undefined (no AWS_ACCOUNT_ID
// fallback), so the AUZ-1 tests below hold regardless of env.
beforeAll(() => {
  process.env.BUDGETS_TABLE = 'test-budgets';
  process.env.RUNNING_SPEND_TABLE = 'test-running-spend';
});

// Stub the DDB doc client. POST /admin/budgets issues a single PutCommand;
// we resolve it and record whether a write happened.
const ddbSendMock = vi.fn();
vi.mock('../src/shared/ddb.js', () => ({
  ddb: { send: (cmd: unknown) => ddbSendMock(cmd) },
  periodFor: () => '2026-05',
}));

vi.mock('../src/shared/powertools.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metrics: {
    addMetric: vi.fn(),
    addDimension: vi.fn(),
    publishStoredMetrics: vi.fn(),
    singleMetric: () => ({ addDimension: vi.fn(), addMetric: vi.fn() }),
  },
  MetricUnit: { Count: 'Count' },
}));

const { handler } = await import('../src/api/budgets/index.js');

const postEvent = (
  scopeClaim: string,
  groups: string[],
  body: Record<string, unknown>,
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey: 'POST /admin/budgets',
    requestContext: {
      authorizer: {
        jwt: { claims: { 'bbg:scope': scopeClaim, 'cognito:groups': groups } },
      },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const wildcard = (body: Record<string, unknown>) =>
  postEvent('["*"]', ['BBG-Admin-Wildcard'], body);
const scoped = (accountId: string, body: Record<string, unknown>) =>
  postEvent(`["${accountId}"]`, [`BBG-Admin-${accountId}`], body);

// A principal key whose account can't be parsed (session-tag form).
// `accountFromPrincipal` returns undefined for it — always, independent
// of AWS_ACCOUNT_ID (the home-account fallback was removed).
const UNPARSEABLE_PRINCIPAL = 'sessionTag/principal=alice@example.com';

describe('AUZ-1 — fail-closed per-account scope guard (POST /admin/budgets)', () => {
  beforeEach(() => {
    ddbSendMock.mockReset();
    ddbSendMock.mockResolvedValue({});
    // Unparseable-account path: no ARN account segment ⇒
    // accountFromPrincipal returns undefined (strict — env-independent;
    // unset AWS_ACCOUNT_ID anyway to prove the old fallback is gone).
    delete process.env.AWS_ACCOUNT_ID;
  });

  it('rejects an unparseable principal for a scoped (non-wildcard) caller with 403', async () => {
    const r = (await handler(
      scoped('111122223333', {
        principal: UNPARSEABLE_PRINCIPAL,
        target: 'model#anthropic.claude-sonnet-4-6',
        limitUsd: 10,
      }),
    )) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/cannot determine the target account/i);
    // Fail-closed: nothing persisted.
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('allows an unparseable principal for a wildcard (super-admin) caller', async () => {
    const r = (await handler(
      wildcard({
        principal: UNPARSEABLE_PRINCIPAL,
        target: 'model#anthropic.claude-sonnet-4-6',
        limitUsd: 10,
      }),
    )) as { statusCode: number };
    // Wildcard proceeds past the scope guard and persists the budget.
    expect(r.statusCode).toBe(201);
    expect(ddbSendMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a parseable but out-of-scope account for a scoped caller with 403', async () => {
    const r = (await handler(
      scoped('111122223333', {
        principal: 'arn:aws:iam::999999999999:user/bob',
        target: 'model#anthropic.claude-sonnet-4-6',
        limitUsd: 10,
      }),
    )) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/scope does not include account 999999999999/);
    expect(ddbSendMock).not.toHaveBeenCalled();
  });
});

describe('API-1 — budget target shape validation (POST /admin/budgets)', () => {
  beforeEach(() => {
    ddbSendMock.mockReset();
    ddbSendMock.mockResolvedValue({});
    process.env.AWS_ACCOUNT_ID = '111122223333';
  });

  it('rejects a malformed target with 400 (so resourcesFor never falls back to *)', async () => {
    const r = (await handler(
      wildcard({
        principal: 'arn:aws:iam::111122223333:user/bob',
        target: 'garbage',
        limitUsd: 10,
      }),
    )) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/target must be one of/);
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('rejects an empty-suffix target (model# with no id)', async () => {
    const r = (await handler(
      wildcard({
        principal: 'arn:aws:iam::111122223333:user/bob',
        target: 'model#',
        limitUsd: 10,
      }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(400);
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it.each(['model#anthropic.claude-sonnet-4-6', 'model#*', 'profile#arn:aws:bedrock:us-east-1:1:inference-profile/x', 'profile#*'])(
    'accepts a well-formed target %s',
    async (target) => {
      const r = (await handler(
        wildcard({
          principal: 'arn:aws:iam::111122223333:user/bob',
          target,
          limitUsd: 10,
        }),
      )) as { statusCode: number };
      expect(r.statusCode).toBe(201);
    },
  );
});

describe('enforceable-principal validation (POST /admin/budgets)', () => {
  beforeEach(() => {
    ddbSendMock.mockReset();
    ddbSendMock.mockResolvedValue({});
    process.env.AWS_ACCOUNT_ID = '111122223333';
  });

  it('rejects a deny budget on principal#unknown with 400 (would never enforce)', async () => {
    const r = (await handler(
      wildcard({ principal: 'unknown', target: 'model#anthropic.claude-sonnet-4-6', limitUsd: 10 }),
    )) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/principal#unknown/);
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('ALLOWS an alert-only budget on principal#unknown (visibility, no enforcement)', async () => {
    const r = (await handler(
      wildcard({ principal: 'unknown', target: 'model#anthropic.claude-sonnet-4-6', limitUsd: 10, action: 'alert' }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(201);
  });

  it('allows a deny budget on a sessionTag principal but returns a steering warning', async () => {
    const r = (await handler(
      wildcard({ principal: 'sessionTag/principal=alice@example.com', target: 'model#anthropic.claude-sonnet-4-6', limitUsd: 10 }),
    )) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.body).warning).toMatch(/sso-user#|sourceIdentity#/);
  });

  it('allows a deny budget on an sso-user principal with no warning', async () => {
    const r = (await handler(
      wildcard({ principal: 'sso-user#alice@example.com', target: 'model#anthropic.claude-sonnet-4-6', limitUsd: 10 }),
    )) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.body).warning).toBeUndefined();
  });
});

afterEach(() => {
  delete process.env.AWS_ACCOUNT_ID;
});

// Budget mutations take principal + target as QUERY params (not path segments)
// so an IAM-ARN principal or a profile#arn target — both containing '/' — reach
// the handler intact (the path-segment form 404s at API Gateway). These pin the
// query-param contract, incl. the slash-containing values that motivated the fix.
const mutEvent = (
  routeKey: string,
  qs: Record<string, string>,
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey,
    requestContext: {
      authorizer: { jwt: { claims: { 'bbg:scope': '["*"]', 'cognito:groups': ['BBG-Admin-Wildcard'] } } },
    },
    queryStringParameters: qs,
    body: JSON.stringify({ limitUsd: 5, action: 'deny' }),
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('budget mutation routes read principal/target from query params', () => {
  beforeEach(() => ddbSendMock.mockReset());

  // A role-ARN principal AND a profile#arn target — both contain '/'.
  const ROLE_PRINCIPAL = 'principal#arn:aws:iam::123456789012:role/AdminRole';
  const PROFILE_TARGET = 'profile#arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude';

  it('DELETE keys DynamoDB by the full slash-containing principal + target', async () => {
    ddbSendMock.mockResolvedValue({});
    const r = (await handler(
      mutEvent('DELETE /admin/budget', { principal: ROLE_PRINCIPAL, target: PROFILE_TARGET }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(204);
    const del = ddbSendMock.mock.calls.find(
      (c) => (c[0] as { input?: { Key?: { principal?: string } } }).input?.Key?.principal,
    );
    const key = (del![0] as { input: { Key: { principal: string; target: string } } }).input.Key;
    expect(key.principal).toBe(ROLE_PRINCIPAL); // slash intact — no 404, no double-decode
    expect(key.target).toBe(PROFILE_TARGET);
  });

  it('toggle looks up the budget by the query-param principal + target', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { principal: ROLE_PRINCIPAL, target: PROFILE_TARGET, enabled: true } });
    ddbSendMock.mockResolvedValue({});
    const r = (await handler(
      mutEvent('POST /admin/budget/toggle', { principal: ROLE_PRINCIPAL, target: PROFILE_TARGET }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(200);
    const get = ddbSendMock.mock.calls[0][0] as { input: { Key: { principal: string } } };
    expect(get.input.Key.principal).toBe(ROLE_PRINCIPAL);
  });

  it('400s when principal or target query param is missing', async () => {
    const r1 = (await handler(mutEvent('DELETE /admin/budget', { principal: ROLE_PRINCIPAL }))) as { statusCode: number };
    expect(r1.statusCode).toBe(400);
    const r2 = (await handler(mutEvent('POST /admin/budget/release', { target: PROFILE_TARGET }))) as { statusCode: number };
    expect(r2.statusCode).toBe(400);
  });

  it('does NOT double-decode — a literal %2F in the (already-decoded) query value is preserved', async () => {
    ddbSendMock.mockResolvedValue({});
    // API Gateway hands the handler the decoded value; a target that genuinely
    // contains a percent sign must not be decoded again.
    const weird = 'model#a%2Fb';
    await handler(mutEvent('DELETE /admin/budget', { principal: ROLE_PRINCIPAL, target: weird }));
    const del = ddbSendMock.mock.calls.find(
      (c) => (c[0] as { input?: { Key?: { principal?: string } } }).input?.Key?.principal,
    );
    expect((del![0] as { input: { Key: { target: string } } }).input.Key.target).toBe(weird);
  });
});
