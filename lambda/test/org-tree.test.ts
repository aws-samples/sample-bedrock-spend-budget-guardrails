/**
 * shared/org-tree.ts — the top-down Organizations walk that emits each account's
 * FULL root-first ancestor ouPath (the input to OU-discount precedence). The key
 * property: an account nested N OUs deep gets an ouPath of [root, …, immediate].
 */
import { describe, expect, it, vi } from 'vitest';
import { walkOrgTree } from '../src/shared/org-tree';

// A tiny fake Organizations client driven by a fixture tree:
//   r-root
//   ├─ (account 100000000000 directly under root)
//   └─ ou-eng
//       ├─ (account 200000000000 under ou-eng)
//       └─ ou-sandbox
//           └─ (account 300000000000 under ou-sandbox)
const ACCOUNTS: Record<string, { Id: string; Name: string }[]> = {
  'r-root': [{ Id: '100000000000', Name: 'root-acct' }],
  'ou-eng': [{ Id: '200000000000', Name: 'eng-acct' }],
  'ou-sandbox': [{ Id: '300000000000', Name: 'sandbox-acct' }],
};
const CHILD_OUS: Record<string, { Id: string; Name: string }[]> = {
  'r-root': [{ Id: 'ou-eng', Name: 'Engineering' }],
  'ou-eng': [{ Id: 'ou-sandbox', Name: 'Sandbox' }],
  'ou-sandbox': [],
};

const fakeClient = () => ({
  send: vi.fn(async (cmd: { constructor: { name: string }; input: { ParentId?: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'ListRootsCommand') return { Roots: [{ Id: 'r-root' }] };
    if (name === 'ListAccountsForParentCommand')
      return { Accounts: ACCOUNTS[cmd.input.ParentId ?? ''] ?? [] };
    if (name === 'ListOrganizationalUnitsForParentCommand')
      return { OrganizationalUnits: CHILD_OUS[cmd.input.ParentId ?? ''] ?? [] };
    throw new Error(`unexpected command ${name}`);
  }),
});

describe('walkOrgTree', () => {
  it('emits each account with its full root-first ancestor ouPath', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await walkOrgTree(fakeClient() as any);
    expect(tree.organizationRootId).toBe('r-root');
    const byId = Object.fromEntries(tree.accounts.map((a) => [a.id, a.ouPath]));
    expect(byId['100000000000']).toEqual(['r-root']);
    expect(byId['200000000000']).toEqual(['r-root', 'ou-eng']);
    expect(byId['300000000000']).toEqual(['r-root', 'ou-eng', 'ou-sandbox']);
    // OUs recorded with their parents.
    expect(tree.ous).toEqual([
      { id: 'ou-eng', name: 'Engineering', parentId: 'r-root' },
      { id: 'ou-sandbox', name: 'Sandbox', parentId: 'ou-eng' },
    ]);
  });

  it('throws when no root is returned (caller decides how to degrade)', async () => {
    const client = { send: vi.fn(async () => ({ Roots: [] })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(walkOrgTree(client as any)).rejects.toThrow(/No Organization root/);
  });
});
