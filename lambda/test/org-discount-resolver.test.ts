/**
 * org-discount-resolver — materializes the most-specific winning discount onto
 * each account's discount#<acct> row, off the meter hot path. Guards: no-op when
 * only account scopes exist; correct materialization for OU/org inheritance;
 * graceful degrade when Organizations is denied; stale-clear when a winning
 * scope disappears.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ddbSend = vi.fn();
const orgSend = vi.fn();

vi.mock('@aws-sdk/lib-dynamodb', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: (c: unknown) => ddbSend(c) }) } };
});
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/client-organizations', () => {
  class Cmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    OrganizationsClient: class {
      send(c: unknown) {
        return orgSend(c);
      }
    },
    ListRootsCommand: class extends Cmd {},
    ListAccountsForParentCommand: class extends Cmd {},
    ListOrganizationalUnitsForParentCommand: class extends Cmd {},
    DescribeOrganizationCommand: class extends Cmd {},
  };
});
vi.mock('../src/shared/powertools.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metrics: { addMetric: vi.fn(), publishStoredMetrics: vi.fn() },
  MetricUnit: { Count: 'Count' },
}));

process.env.PRICING_TABLE = 'test-pricing';
const { handler } = await import('../src/org-discount-resolver/index.js');

// Scan returns discount rows; helper builds a single-page Scan result.
const scanRows = (rows: Record<string, unknown>[]) => ({ Items: rows });

beforeEach(() => {
  ddbSend.mockReset();
  orgSend.mockReset();
});

describe('org-discount-resolver', () => {
  it('no-ops (no Organizations call) when only account-scoped discounts exist', async () => {
    ddbSend.mockResolvedValueOnce(
      scanRows([{ model: 'discount#111111111111', discountPct: 25 }]),
    );
    const r = await handler();
    expect(r).toEqual({ resolved: 0, degraded: false });
    // Only the Scan happened; Organizations never touched.
    expect(orgSend).not.toHaveBeenCalled();
  });

  it('gracefully degrades when Organizations is denied (non-mgmt account)', async () => {
    ddbSend.mockResolvedValueOnce(scanRows([{ model: 'discount#org#o-abc', discountPct: 10 }]));
    orgSend.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' }));
    const r = await handler();
    expect(r.degraded).toBe(true);
    expect(r.resolved).toBe(0);
  });

  it('materializes an OU discount onto the inheriting account row', async () => {
    // Policies: ou-eng = 30%. Tree: account 200000000000 under ou-eng.
    ddbSend.mockResolvedValueOnce(scanRows([{ model: 'discount#ou#ou-eng', discountPct: 30 }]));
    // Subsequent ddb sends are the materialize UpdateCommands → resolve ok.
    ddbSend.mockResolvedValue({});
    orgSend.mockImplementation((cmd: { constructor: { name: string }; input: { ParentId?: string } }) => {
      const n = cmd.constructor.name;
      if (n === 'ListRootsCommand') return Promise.resolve({ Roots: [{ Id: 'r-root' }] });
      if (n === 'DescribeOrganizationCommand') return Promise.resolve({ Organization: { Id: 'o-abc' } });
      if (n === 'ListAccountsForParentCommand') {
        return Promise.resolve({ Accounts: cmd.input.ParentId === 'ou-eng' ? [{ Id: '200000000000', Name: 'eng' }] : [] });
      }
      if (n === 'ListOrganizationalUnitsForParentCommand') {
        return Promise.resolve({ OrganizationalUnits: cmd.input.ParentId === 'r-root' ? [{ Id: 'ou-eng', Name: 'Eng' }] : [] });
      }
      return Promise.resolve({});
    });

    const r = await handler();
    expect(r.degraded).toBe(false);
    expect(r.resolved).toBe(1);
    // Find the UpdateCommand that materialized the account row.
    const updates = ddbSend.mock.calls
      .map((c) => c[0] as { input?: { Key?: { model?: string }; ExpressionAttributeValues?: Record<string, unknown> } })
      .filter((c) => c.input?.Key?.model === 'discount#200000000000' && c.input.ExpressionAttributeValues?.[':p'] !== undefined);
    expect(updates).toHaveLength(1);
    const vals = updates[0].input!.ExpressionAttributeValues!;
    expect(vals[':p']).toBe(30);
    expect(vals[':s']).toBe('ou');
    expect(vals[':sid']).toBe('ou-eng');
  });

  it('clears a stale materialized value when no OU/org policy remains', async () => {
    // Account row still carries an old effectivePct, but there are no OU/org
    // policies now → resolver should REMOVE the materialized fields.
    ddbSend.mockResolvedValueOnce(
      scanRows([{ model: 'discount#300000000000', effectivePct: 30 }]),
    );
    ddbSend.mockResolvedValue({});
    const r = await handler();
    expect(r).toEqual({ resolved: 0, degraded: false });
    const removes = ddbSend.mock.calls
      .map((c) => c[0] as { input?: { Key?: { model?: string }; UpdateExpression?: string } })
      .filter((c) => c.input?.Key?.model === 'discount#300000000000' && c.input.UpdateExpression?.startsWith('REMOVE'));
    expect(removes).toHaveLength(1);
  });
});
