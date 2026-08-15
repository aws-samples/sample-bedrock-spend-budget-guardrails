/**
 * recordActivity contract.
 *
 * The per-principal activity writer must: no-op (never throw) when the table
 * env is unset; write a row keyed by principal with a reverse-chronological
 * `sk`, a TTL, and the event fields when configured; and swallow DDB errors
 * so it never breaks the calling meter/enforcement/admin path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('../src/shared/ddb.js', () => ({
  ddb: { send: (cmd: unknown) => sendMock(cmd) },
}));
vi.mock('../src/shared/powertools.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const importFresh = async () => {
  vi.resetModules();
  return import('../src/shared/activity.js');
};

describe('recordActivity', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });
  afterEach(() => {
    delete process.env.PRINCIPAL_ACTIVITY_TABLE;
  });

  it('is a no-op (no DDB write) when PRINCIPAL_ACTIVITY_TABLE is unset', async () => {
    delete process.env.PRINCIPAL_ACTIVITY_TABLE;
    const { recordActivity } = await importFresh();
    await recordActivity({ principal: 'principal#arn:aws:iam::1:user/a', type: 'budget.created', summary: 's' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('writes a row keyed by principal with a ts# sort key, event fields, and a TTL', async () => {
    process.env.PRINCIPAL_ACTIVITY_TABLE = 'test-activity';
    const { recordActivity } = await importFresh();
    await recordActivity({
      principal: 'principal#arn:aws:iam::1:role/x',
      type: 'enforcement.applied',
      summary: 'Deny attached',
      detail: { target: 'model#m' },
      actor: { email: 'op@example.com' },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const item = (sendMock.mock.calls[0][0] as { input: { Item: Record<string, unknown> } }).input.Item;
    expect(item.principal).toBe('principal#arn:aws:iam::1:role/x');
    expect(String(item.sk).startsWith('ts#')).toBe(true);
    expect(item.type).toBe('enforcement.applied');
    expect(item.summary).toBe('Deny attached');
    expect((item.actor as { email: string }).email).toBe('op@example.com');
    expect(typeof item.ttl).toBe('number');
    expect(item.ttl as number).toBeGreaterThan(Date.now() / 1000);
    // byDay GSI key: bucket = day#<utc-date> derived from the same ISO as sk.
    expect(String(item.bucket)).toMatch(/^day#\d{4}-\d{2}-\d{2}$/);
    expect(String(item.sk)).toContain(String(item.bucket).slice('day#'.length));
    // ARN principal → sparse accountId written.
    expect(item.accountId).toBe('1');
  });

  it('omits accountId for a non-ARN principal (keeps the attribute sparse)', async () => {
    process.env.PRINCIPAL_ACTIVITY_TABLE = 'test-activity';
    const { recordActivity } = await importFresh();
    await recordActivity({ principal: 'user#alice@example.com', type: 'user.created', summary: 's' });
    const item = (sendMock.mock.calls[0][0] as { input: { Item: Record<string, unknown> } }).input.Item;
    expect(item.accountId).toBeUndefined();
    // bucket is still written for the feed regardless of principal shape.
    expect(String(item.bucket)).toMatch(/^day#\d{4}-\d{2}-\d{2}$/);
  });

  it('never throws when the DDB write fails', async () => {
    process.env.PRINCIPAL_ACTIVITY_TABLE = 'test-activity';
    sendMock.mockRejectedValue(new Error('DDB down'));
    const { recordActivity } = await importFresh();
    await expect(
      recordActivity({ principal: 'principal#x', type: 'budget.created', summary: 's' }),
    ).resolves.toBeUndefined();
  });

  it('skips an empty principal', async () => {
    process.env.PRINCIPAL_ACTIVITY_TABLE = 'test-activity';
    const { recordActivity } = await importFresh();
    await recordActivity({ principal: '', type: 'budget.created', summary: 's' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
