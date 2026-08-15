import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

// Env must be set BEFORE the handler module is imported — it reads these table
// names into module-level consts at load time.
process.env.PRINCIPALS_SEEN_TABLE = 'test-principals-seen';
process.env.PRINCIPAL_ACTIVITY_TABLE = 'test-principal-activity';

const ddbSendMock = vi.fn();
vi.mock('../src/shared/ddb.js', () => ({
  ddb: { send: (cmd: unknown) => ddbSendMock(cmd) },
}));

const { handler } = await import('../src/api/identities/index.js');

const adminEvent = (qs: Record<string, string> = {}): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    requestContext: {
      authorizer: { jwt: { claims: { 'cognito:groups': ['BBG-Admin-Wildcard'] } } },
    },
    queryStringParameters: qs,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const nonAdminEvent = (): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    requestContext: {
      authorizer: { jwt: { claims: { 'cognito:groups': ['Users'] } } },
    },
    queryStringParameters: {},
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('GET /admin/identities', () => {
  afterEach(() => {
    ddbSendMock.mockReset();
  });

  it('forbids non-admins', async () => {
    const r = (await handler(nonAdminEvent())) as { statusCode: number };
    expect(r.statusCode).toBe(403);
  });

  it('defaults to 1h window when periodHours is absent and scans with the right threshold', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    const r = (await handler(adminEvent())) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).periodHours).toBe(1);

    const cmd = ddbSendMock.mock.calls[0][0] as {
      input: { FilterExpression: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(cmd.input.FilterExpression).toBe('lastSeen >= :t');
    const threshold = cmd.input.ExpressionAttributeValues[':t'];
    const ageMs = Date.now() - new Date(threshold).getTime();
    // Should be within ~1h ± 5s of "now"
    expect(ageMs).toBeGreaterThan(3600 * 1000 - 5000);
    expect(ageMs).toBeLessThan(3600 * 1000 + 5000);
  });

  it.each([
    ['6', 6],
    ['24', 24],
    ['168', 168],
    ['720', 720],
  ])('honors valid periodHours=%s', async (raw, expected) => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    const r = (await handler(adminEvent({ periodHours: raw }))) as { body: string };
    expect(JSON.parse(r.body).periodHours).toBe(expected);
  });

  it('clamps below MIN_HOURS to 1', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    const r = (await handler(adminEvent({ periodHours: '0' }))) as { body: string };
    expect(JSON.parse(r.body).periodHours).toBe(1);
  });

  it('clamps above MAX_HOURS (720) to 720', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    const r = (await handler(adminEvent({ periodHours: '99999' }))) as { body: string };
    expect(JSON.parse(r.body).periodHours).toBe(720);
  });

  it('falls back to default for non-numeric periodHours', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    const r = (await handler(adminEvent({ periodHours: 'abc' }))) as { body: string };
    expect(JSON.parse(r.body).periodHours).toBe(1);
  });

  it('returns rows sorted by lastSeen desc and exposes both lastSeen and eventTime', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Items: [
        {
          principal: 'principal#arn:aws:iam::1:user/alice',
          principalType: 'IAMUser',
          principalArn: 'arn:aws:iam::1:user/alice',
          firstSeen: '2026-05-15T10:00:00.000Z',
          lastSeen: '2026-05-17T08:00:00.000Z',
        },
        {
          principal: 'principal#arn:aws:iam::1:user/bob',
          principalType: 'IAMUser',
          principalArn: 'arn:aws:iam::1:user/bob',
          firstSeen: '2026-05-16T10:00:00.000Z',
          lastSeen: '2026-05-17T11:00:00.000Z',
        },
      ],
    });
    const r = (await handler(adminEvent({ periodHours: '24' }))) as { body: string };
    const body = JSON.parse(r.body) as {
      items: Array<{ principal: string; lastSeen?: string; eventTime?: string }>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0].principal).toBe('principal#arn:aws:iam::1:user/bob');
    expect(body.items[1].principal).toBe('principal#arn:aws:iam::1:user/alice');
    // eventTime is preserved as an alias of lastSeen for back-compat.
    expect(body.items[0].eventTime).toBe('2026-05-17T11:00:00.000Z');
    expect(body.items[0].lastSeen).toBe('2026-05-17T11:00:00.000Z');
  });

  it('paginates through LastEvaluatedKey', async () => {
    ddbSendMock
      .mockResolvedValueOnce({
        Items: [{ principal: 'a', lastSeen: '2026-05-17T01:00:00.000Z' }],
        LastEvaluatedKey: { principal: 'a' },
      })
      .mockResolvedValueOnce({
        Items: [{ principal: 'b', lastSeen: '2026-05-17T02:00:00.000Z' }],
      });
    const r = (await handler(adminEvent())) as { body: string };
    const body = JSON.parse(r.body) as { items: Array<{ principal: string }> };
    expect(body.items).toHaveLength(2);
    expect(ddbSendMock).toHaveBeenCalledTimes(2);
  });
});

// activity route. The principal comes via the ?principal= QUERY param
// (a path segment can't hold an ARN — its `/` breaks HTTP-API path matching),
// so the handler must read queryStringParameters.principal verbatim.
const activityEvent = (
  qs: Record<string, string>,
  groups: string[] = ['BBG-Admin-Wildcard'],
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey: 'GET /admin/principal-activity',
    requestContext: { authorizer: { jwt: { claims: { 'cognito:groups': groups } } } },
    queryStringParameters: qs,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('GET /admin/principal-activity', () => {
  afterEach(() => {
    ddbSendMock.mockReset();
  });

  it('forbids non-admins', async () => {
    const r = (await handler(
      activityEvent({ principal: 'principal#arn:aws:iam::1:role/X' }, ['Users']),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(403);
  });

  it('400s when principal query param is missing', async () => {
    const r = (await handler(activityEvent({}))) as { statusCode: number };
    expect(r.statusCode).toBe(400);
  });

  it('queries by the full role-ARN principal from the query param (the slash-safe path)', async () => {
    const principal = 'principal#arn:aws:iam::123456789012:role/AdminRole';
    ddbSendMock.mockResolvedValueOnce({
      Items: [{ ts: '2026-07-30T00:00:00.000Z', type: 'threshold.warning', summary: 's', detail: {} }],
    });
    const r = (await handler(activityEvent({ principal }))) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(200);
    // The value the handler queried by must be the full principal, slash intact.
    const cmd = ddbSendMock.mock.calls[0][0] as {
      input: { KeyConditionExpression: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(cmd.input.KeyConditionExpression).toBe('principal = :p');
    expect(cmd.input.ExpressionAttributeValues[':p']).toBe(principal);
    expect(JSON.parse(r.body).items).toHaveLength(1);
  });

  it('newest-first (ScanIndexForward false) and clamps limit to 200', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    await handler(activityEvent({ principal: 'principal#arn:aws:iam::1:role/X', limit: '9999' }));
    const cmd = ddbSendMock.mock.calls[0][0] as { input: { ScanIndexForward: boolean; Limit: number } };
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.Limit).toBe(200);
  });

  it('returns an opaque cursor (sk only) when the page has a LastEvaluatedKey', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Items: [],
      LastEvaluatedKey: { principal: 'principal#arn:aws:iam::1:role/X', sk: 'ts#2026-07-30T00:00:00.000Z#abc' },
    });
    const r = (await handler(activityEvent({ principal: 'principal#arn:aws:iam::1:role/X' }))) as { body: string };
    const cursor = JSON.parse(r.body).cursor as string;
    expect(typeof cursor).toBe('string');
    // Cursor must carry ONLY sk — never the principal (would be a read-any primitive).
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ sk: 'ts#2026-07-30T00:00:00.000Z#abc' });
    expect(decoded.principal).toBeUndefined();
  });

  it('omits the cursor on the last page (no LastEvaluatedKey)', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    const r = (await handler(activityEvent({ principal: 'principal#arn:aws:iam::1:role/X' }))) as { body: string };
    expect(JSON.parse(r.body).cursor).toBeUndefined();
  });

  it('resumes from a valid cursor, re-attaching the server-known principal', async () => {
    const principal = 'principal#arn:aws:iam::1:role/X';
    const cursor = Buffer.from(JSON.stringify({ sk: 'ts#2026-07-30T00:00:00.000Z#abc' }), 'utf8').toString('base64url');
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    await handler(activityEvent({ principal, cursor }));
    const cmd = ddbSendMock.mock.calls[0][0] as { input: { ExclusiveStartKey?: Record<string, unknown> } };
    expect(cmd.input.ExclusiveStartKey).toEqual({ principal, sk: 'ts#2026-07-30T00:00:00.000Z#abc' });
  });

  it('ignores a forged cursor (bad sk shape) rather than trusting it', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [] });
    const forged = Buffer.from(JSON.stringify({ sk: 'not-a-ts-key', principal: 'principal#arn:aws:iam::999:role/evil' }), 'utf8').toString('base64url');
    await handler(activityEvent({ principal: 'principal#arn:aws:iam::1:role/X', cursor: forged }));
    const cmd = ddbSendMock.mock.calls[0][0] as { input: { ExclusiveStartKey?: Record<string, unknown> } };
    // Malformed sk → no ExclusiveStartKey (fail-safe: start from newest page).
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });
});

// PR3 self-service /me/activity. Subject is derived from signed claims; there is
// NO principal input. These guard the auth boundary + the email_verified leak
// gate + actor/detail redaction.
const meEvent = (
  claims: Record<string, string | string[]>,
  qs: Record<string, string> = {},
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey: 'GET /me/activity',
    requestContext: { authorizer: { jwt: { claims } } },
    queryStringParameters: qs,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('GET /me/activity (self-service)', () => {
  afterEach(() => ddbSendMock.mockReset());

  it('is reachable by a NON-admin (no requireAdmin gate)', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    const r = (await handler(
      meEvent({ 'cognito:groups': ['Users'], 'bbg:principal': 'arn:aws:iam::1:role/X', sub: 's' }),
    )) as { statusCode: number };
    expect(r.statusCode).toBe(200);
  });

  it('returns unmapped:true (never 403) when the caller has no derivable key', async () => {
    const r = (await handler(meEvent({ 'cognito:groups': ['Users'] }))) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.unmapped).toBe(true);
    expect(b.mappedPrincipal).toBe(false);
    expect(b.items).toEqual([]);
    // No key derived → no DDB query at all.
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('queries principal# + user#<username> from claims (no principal input)', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    await handler(
      meEvent({
        'bbg:principal': 'arn:aws:iam::1:role/X',
        'cognito:username': 'uuid-123',
        sub: 'uuid-123',
      }),
    );
    const queried = ddbSendMock.mock.calls.map(
      (c) => (c[0] as { input: { ExpressionAttributeValues: Record<string, string> } }).input.ExpressionAttributeValues[':p'],
    );
    expect(queried).toContain('principal#arn:aws:iam::1:role/X');
    expect(queried).toContain('user#uuid-123');
  });

  it('LEAK GATE: does NOT query email-derived keys when email_verified is not true', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    await handler(
      meEvent({ 'bbg:principal': 'arn:aws:iam::1:role/X', email: 'victim@example.com', email_verified: 'false' }),
    );
    const queried = ddbSendMock.mock.calls.map(
      (c) => (c[0] as { input: { ExpressionAttributeValues: Record<string, string> } }).input.ExpressionAttributeValues[':p'],
    );
    expect(queried).not.toContain('user#victim@example.com');
    expect(queried).not.toContain('principal#sso-user#victim@example.com');
  });

  it('DOES query email-derived keys when email_verified === "true"', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    await handler(
      meEvent({ 'bbg:principal': 'arn:aws:iam::1:role/X', email: 'me@example.com', email_verified: 'true' }),
    );
    const queried = ddbSendMock.mock.calls.map(
      (c) => (c[0] as { input: { ExpressionAttributeValues: Record<string, string> } }).input.ExpressionAttributeValues[':p'],
    );
    expect(queried).toContain('user#me@example.com');
    expect(queried).toContain('principal#sso-user#me@example.com');
  });

  it('redacts actor→byAdmin and detail through the allowlist (drops policyArn + unknown keys)', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [
        {
          sk: 'ts#2026-07-30T00:00:00.000Z#a',
          ts: '2026-07-30T00:00:00.000Z',
          type: 'enforcement.applied',
          summary: 'Deny attached',
          actor: { email: 'admin@example.com', sub: 'x' },
          detail: { target: 'model#m', spendUsd: 5, policyArn: 'arn:secret', attachedTo: 'role/x', newSecretField: 'nope' },
        },
      ],
    });
    const r = (await handler(meEvent({ 'bbg:principal': 'arn:aws:iam::1:role/X' }))) as { body: string };
    const item = JSON.parse(r.body).items[0];
    expect(item.byAdmin).toBe(true);
    expect(item.actor).toBeUndefined();
    expect(item.detail.target).toBe('model#m');
    expect(item.detail.spendUsd).toBe(5);
    expect(item.detail.policyArn).toBeUndefined();
    expect(item.detail.attachedTo).toBeUndefined();
    expect(item.detail.newSecretField).toBeUndefined();
  });

  it('merges multiple keys newest-first and truncates to limit', async () => {
    // principal# key returns an older row; user# key returns a newer row.
    ddbSendMock
      .mockResolvedValueOnce({ Items: [{ sk: 'ts#2026-07-29T00:00:00.000Z#a', ts: '2026-07-29T00:00:00.000Z', type: 'budget.created', summary: 'old' }] })
      .mockResolvedValueOnce({ Items: [{ sk: 'ts#2026-07-30T00:00:00.000Z#b', ts: '2026-07-30T00:00:00.000Z', type: 'user.created', summary: 'new' }] });
    const r = (await handler(
      meEvent({ 'bbg:principal': 'arn:aws:iam::1:role/X', 'cognito:username': 'u' }, { limit: '10' }),
    )) as { body: string };
    const items = JSON.parse(r.body).items as Array<{ summary: string }>;
    expect(items.map((i) => i.summary)).toEqual(['new', 'old']);
  });
});

// PR4 central feed /admin/activity — wildcard-only, byDay GSI.
const centralEvent = (
  groups: string[],
  qs: Record<string, string> = {},
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    routeKey: 'GET /admin/activity',
    requestContext: { authorizer: { jwt: { claims: { 'cognito:groups': groups } } } },
    queryStringParameters: qs,
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('GET /admin/activity (central feed)', () => {
  afterEach(() => ddbSendMock.mockReset());

  it('403s a non-admin', async () => {
    const r = (await handler(centralEvent(['Users']))) as { statusCode: number };
    expect(r.statusCode).toBe(403);
  });

  it('403s a per-account (non-wildcard) admin with the super-admin-only message', async () => {
    // A scoped admin: in a BBG-Admin-<account> group (passes requireAdmin) but
    // NOT wildcard, so callerScope.isWildcard is false.
    const r = (await handler(centralEvent(['BBG-Admin-123456789012']))) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/super-admin only/);
  });

  it('queries the byDay GSI newest-first for a wildcard admin', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Items: [
        { principal: 'principal#arn:aws:iam::1:role/X', sk: 'ts#2026-07-30T00:00:00.000Z#a', ts: '2026-07-30T00:00:00.000Z', type: 'threshold.warning', summary: 's', accountId: '1' },
      ],
    });
    const r = (await handler(centralEvent(['BBG-Admin-Wildcard'], { days: '1' }))) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(200);
    const cmd = ddbSendMock.mock.calls[0][0] as { input: { IndexName: string; ScanIndexForward: boolean; KeyConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, string> } };
    expect(cmd.input.IndexName).toBe('byDay');
    expect(cmd.input.ScanIndexForward).toBe(false);
    // `bucket` is a DynamoDB reserved word — must be aliased via #b (else 400/500).
    expect(cmd.input.KeyConditionExpression).toBe('#b = :b');
    expect(cmd.input.ExpressionAttributeNames['#b']).toBe('bucket');
    expect(String(cmd.input.ExpressionAttributeValues[':b'])).toMatch(/^day#\d{4}-\d{2}-\d{2}$/);
    const item = JSON.parse(r.body).items[0];
    expect(item.principal).toBe('principal#arn:aws:iam::1:role/X');
    expect(item.accountId).toBe('1');
  });

  it('clamps days to 1..365 and limit to 1..200', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    const r = (await handler(centralEvent(['BBG-Admin-Wildcard'], { days: '9999', limit: '9999' }))) as { body: string };
    expect(JSON.parse(r.body).days).toBe(365);
    const cmd = ddbSendMock.mock.calls[0][0] as { input: { Limit: number } };
    expect(cmd.input.Limit).toBe(200);
  });

  it('mid-bucket cursor round-trips a FULL GSI key (bucket+sk+principal) — guards the page-2 500', async () => {
    // Page fills exactly; the bucket still has more → mid-bucket resume cursor.
    // The handler anchors its walk at TODAY's bucket, so the LEK bucket must be
    // computed from today (not hard-coded) or the round-trip drifts at each UTC
    // date rollover.
    const todayBucket = `day#${new Date().toISOString().slice(0, 10)}`;
    const lek = {
      bucket: todayBucket,
      sk: 'ts#2026-07-30T00:00:00.000Z#a',
      principal: 'principal#arn:aws:iam::1:role/X',
    };
    ddbSendMock.mockResolvedValueOnce({
      Items: [{ principal: lek.principal, sk: lek.sk, ts: '2026-07-30T00:00:00.000Z', type: 'x', summary: 's' }],
      LastEvaluatedKey: lek,
    });
    const r1 = (await handler(centralEvent(['BBG-Admin-Wildcard'], { limit: '1', days: '7' }))) as { body: string };
    const cursor = JSON.parse(r1.body).cursor as string;
    expect(typeof cursor).toBe('string');
    ddbSendMock.mockReset();

    // Page 2: the resumed Query MUST get an ExclusiveStartKey carrying the
    // base-table PK `principal` (a GSI query rejects a key without it → 500).
    ddbSendMock.mockResolvedValue({ Items: [] });
    await handler(centralEvent(['BBG-Admin-Wildcard'], { cursor, limit: '1' }));
    const cmd = ddbSendMock.mock.calls[0][0] as { input: { ExclusiveStartKey?: Record<string, unknown> } };
    expect(cmd.input.ExclusiveStartKey).toEqual(lek);
  });

  it('keeps the days window stable across pages (floor carried in the cursor)', async () => {
    // Fill page 1 at a bucket boundary → top-of-next-bucket cursor with floor.
    ddbSendMock.mockResolvedValueOnce({
      Items: [{ principal: 'principal#p', sk: 'ts#2026-07-30T00:00:00.000Z#a', ts: 't', type: 'x', summary: 's' }],
      // no LastEvaluatedKey → bucket drained; loop steps back and (full) breaks.
    });
    const r1 = (await handler(centralEvent(['BBG-Admin-Wildcard'], { limit: '1', days: '7' }))) as { body: string };
    const cursor = JSON.parse(r1.body).cursor as string;
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    // Floor is present and is a valid day bucket (stable window across pages).
    expect(decoded.f).toMatch(/^day#\d{4}-\d{2}-\d{2}$/);
  });

  it('ignores a forged central cursor (bad bucket) rather than trusting it', async () => {
    ddbSendMock.mockResolvedValue({ Items: [] });
    const forged = Buffer.from(JSON.stringify({ b: 'not-a-bucket', f: 'day#2026-07-01' }), 'utf8').toString('base64url');
    const r = (await handler(centralEvent(['BBG-Admin-Wildcard'], { cursor: forged, days: '7' }))) as { statusCode: number };
    // Invalid cursor → treated as no cursor (start from today), still 200.
    expect(r.statusCode).toBe(200);
    const cmd = ddbSendMock.mock.calls[0][0] as { input: { ExpressionAttributeValues: Record<string, string> } };
    // Started from today's bucket (not the forged one).
    expect(cmd.input.ExpressionAttributeValues[':b']).not.toBe('not-a-bucket');
  });
});
