/**
 * api/users — PrincipalActivity keying. Every user-lifecycle event must key on
 * the IMMUTABLE Cognito Username (UUID), NOT the email, so a user's timeline
 * isn't split across `user#<email>` (create) and `user#<uuid>` (disable/delete)
 * — and isn't influenced by the self-writable email attribute. This suite is
 * the regression guard (api/users had zero coverage before).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

process.env.USER_POOL_ID = 'test-pool';

// Capture recordActivity calls (the thing under test).
const activityMock = vi.fn();
vi.mock('../src/shared/activity.js', () => ({
  recordActivity: (e: unknown) => activityMock(e),
}));
vi.mock('../src/shared/audit.js', () => ({ emitAudit: vi.fn() }));
vi.mock('../src/shared/powertools.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metrics: { addMetric: vi.fn(), publishStoredMetrics: vi.fn(), singleMetric: () => ({ addDimension: vi.fn(), addMetric: vi.fn() }) },
}));

// Fake Cognito: AdminGetUser resolves the alias(email)→UUID; AdminCreateUser
// returns a generated UUID Username; others record call order.
const calls: string[] = [];
// Each command carries its own class name in a `_cmd` field (constructor.name
// is unreliable for dynamically-built classes under the test bundler).
vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const mk = (name: string) => {
    const C = class {
      _cmd = name;
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown> = {}) {
        this.input = input;
      }
    };
    return C;
  };
  return {
    CognitoIdentityProviderClient: class {
      async send(cmd: { _cmd: string; input: { Username?: string } }) {
        const n = cmd._cmd;
        calls.push(n);
        if (n === 'AdminCreateUserCommand') return { User: { Username: 'uuid-of-alice' } };
        if (n === 'AdminGetUserCommand') {
          if (cmd.input.Username === 'gone@example.com') {
            throw Object.assign(new Error('not found'), { name: 'UserNotFoundException' });
          }
          return { Username: 'uuid-of-alice' }; // alias → canonical UUID
        }
        if (n === 'AdminListGroupsForUserCommand') return { Groups: [] };
        return {};
      }
    },
    AdminAddUserToGroupCommand: mk('AdminAddUserToGroupCommand'),
    AdminCreateUserCommand: mk('AdminCreateUserCommand'),
    AdminDeleteUserCommand: mk('AdminDeleteUserCommand'),
    AdminDisableUserCommand: mk('AdminDisableUserCommand'),
    AdminEnableUserCommand: mk('AdminEnableUserCommand'),
    AdminGetUserCommand: mk('AdminGetUserCommand'),
    AdminListGroupsForUserCommand: mk('AdminListGroupsForUserCommand'),
    AdminRemoveUserFromGroupCommand: mk('AdminRemoveUserFromGroupCommand'),
    AdminResetUserPasswordCommand: mk('AdminResetUserPasswordCommand'),
    AdminSetUserPasswordCommand: mk('AdminSetUserPasswordCommand'),
    AdminUpdateUserAttributesCommand: mk('AdminUpdateUserAttributesCommand'),
    ListGroupsCommand: mk('ListGroupsCommand'),
    ListUsersCommand: mk('ListUsersCommand'),
  };
});

const { handler } = await import('../src/api/users/index.js');

const ev = (routeKey: string, opts: { username?: string; body?: unknown } = {}): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey,
    requestContext: {
      http: { method: routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: { 'cognito:groups': ['BBG-Admin-Wildcard'], 'bbg:scope': '["*"]', sub: 'op', email: 'op@x.com' } } },
    },
    pathParameters: opts.username ? { username: opts.username } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const keysRecorded = () => activityMock.mock.calls.map((c) => (c[0] as { principal: string; type: string }));

beforeEach(() => {
  activityMock.mockReset();
  calls.length = 0;
});

describe('api/users activity keying', () => {
  it('CREATE keys user#<AdminCreateUser UUID>, not user#<email>', async () => {
    const r = (await handler(ev('POST /admin/users', { body: { email: 'alice@example.com' } }))) as { statusCode: number };
    expect(r.statusCode).toBe(201);
    const created = keysRecorded().find((k) => k.type === 'user.created');
    expect(created!.principal).toBe('user#uuid-of-alice');
    expect(keysRecorded().every((k) => k.principal !== 'user#alice@example.com')).toBe(true);
  });

  it('CREATE with an iamPrincipal ALSO writes a principal#<arn> mirror', async () => {
    await handler(ev('POST /admin/users', { body: { email: 'alice@example.com', iamPrincipal: 'arn:aws:iam::1:role/Dev' } }));
    const principals = keysRecorded().filter((k) => k.type === 'user.created').map((k) => k.principal);
    expect(principals).toContain('user#uuid-of-alice');
    expect(principals.some((p) => p.startsWith('principal#arn:aws:iam::1:role/Dev'))).toBe(true);
  });

  it('DISABLE resolves the UUID via AdminGetUser even when the path param is the email alias', async () => {
    await handler(ev('POST /admin/users/{username}/disable', { username: 'alice@example.com' }));
    expect(keysRecorded()[0].principal).toBe('user#uuid-of-alice');
    expect(keysRecorded()[0].type).toBe('user.disabled');
  });

  it('DELETE resolves the canonical UUID BEFORE deleting the user (ordering)', async () => {
    await handler(ev('DELETE /admin/users/{username}', { username: 'alice@example.com' }));
    // AdminGetUser must run before AdminDeleteUser.
    expect(calls.indexOf('AdminGetUserCommand')).toBeLessThan(calls.indexOf('AdminDeleteUserCommand'));
    expect(keysRecorded()[0].principal).toBe('user#uuid-of-alice');
    expect(keysRecorded()[0].type).toBe('user.deleted');
  });

  it('falls back to the raw path param (does NOT throw/500) when AdminGetUser fails', async () => {
    const r = (await handler(ev('POST /admin/users/{username}/enable', { username: 'gone@example.com' }))) as { statusCode: number };
    expect(r.statusCode).toBe(200); // route still succeeds
    expect(keysRecorded()[0].principal).toBe('user#gone@example.com'); // fell back to input
  });

  it('reset-password now records an activity event (was previously silent)', async () => {
    await handler(ev('POST /admin/users/{username}/reset-password', { username: 'alice@example.com' }));
    expect(keysRecorded()[0].type).toBe('user.password_reset');
    expect(keysRecorded()[0].principal).toBe('user#uuid-of-alice');
  });
});
