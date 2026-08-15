import {
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';

/**
 * A single account in the Organizations tree, annotated with its FULL
 * ancestor chain. `ouPath` is root-first: `[r-xxxx, ou-parent, …, ou-immediate]`
 * (the last element is the account's immediate parent OU; the first is the org
 * root). This is what makes most-specific-wins OU discount resolution possible
 * without any per-account `ListParents` call — the recursion already knows the
 * chain from the direction it descended.
 */
export interface OrgTreeAccount {
  id: string;
  name: string;
  /** Root-first ancestor OU/root IDs. Always starts with the root id. */
  ouPath: string[];
}

export interface OrgTreeOu {
  id: string;
  name: string;
  parentId: string;
}

export interface OrgTree {
  organizationRootId: string;
  accounts: OrgTreeAccount[];
  ous: OrgTreeOu[];
}

/**
 * Walk the Organizations tree top-down from the root, returning every account
 * with its full ancestor `ouPath`. Uses only `ListRoots`,
 * `ListAccountsForParent`, and `ListOrganizationalUnitsForParent` — never
 * `ListParents` (the top-down walk already knows each account's parent from the
 * direction of descent), so the resolver's IAM grant stays minimal.
 *
 * O(#OUs + #account pages); a single pass covers a typical org (<500 accounts,
 * <100 OUs). Throws on any Organizations error (e.g. AccessDenied when the
 * install is not the management account) — callers decide how to degrade.
 */
export const walkOrgTree = async (client: OrganizationsClient): Promise<OrgTree> => {
  const roots = await client.send(new ListRootsCommand({}));
  const organizationRootId = roots.Roots?.[0]?.Id;
  if (!organizationRootId) throw new Error('No Organization root found');

  const accounts: OrgTreeAccount[] = [];
  const ous: OrgTreeOu[] = [];

  // `path` is the root-first ancestor chain of `parentId` INCLUSIVE, so an
  // account directly under `parentId` has ouPath = path.
  const walk = async (parentId: string, path: string[]): Promise<void> => {
    let acctToken: string | undefined;
    do {
      const r = await client.send(
        new ListAccountsForParentCommand({ ParentId: parentId, NextToken: acctToken }),
      );
      for (const a of r.Accounts ?? []) {
        if (!a.Id || !a.Name) continue;
        accounts.push({ id: a.Id, name: a.Name, ouPath: [...path] });
      }
      acctToken = r.NextToken;
    } while (acctToken);

    let ouToken: string | undefined;
    do {
      const r = await client.send(
        new ListOrganizationalUnitsForParentCommand({ ParentId: parentId, NextToken: ouToken }),
      );
      for (const ou of r.OrganizationalUnits ?? []) {
        if (!ou.Id || !ou.Name) continue;
        ous.push({ id: ou.Id, name: ou.Name, parentId });
        await walk(ou.Id, [...path, ou.Id]);
      }
      ouToken = r.NextToken;
    } while (ouToken);
  };

  await walk(organizationRootId, [organizationRootId]);
  return { organizationRootId, accounts, ous };
};
