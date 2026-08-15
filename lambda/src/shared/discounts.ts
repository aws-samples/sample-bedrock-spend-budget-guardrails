/**
 * Custom pricing discount scopes + precedence (→ hierarchical extension).
 *
 * A discount can be authored at three scopes, all stored in the Pricing table
 * under the reserved `discount#` namespace (so the existing overrides-exclusion
 * filter and refresher scans keep working unchanged):
 *
 *   account : `discount#<12-digit accountId>`   (unchanged from an earlier change)
 *   ou      : `discount#ou#<ou-id>`              (any depth; org root r-… is just an OU)
 *   org     : `discount#org#<org-id>`
 *
 * The meter never resolves precedence on the hot path. An off-hot-path resolver
 * walks the org tree and MATERIALIZES the winning percentage onto each account's
 * `discount#<accountId>` row as `effectivePct` (+ provenance). The meter reads
 * that one cached row exactly as before. This module holds the pure, shared
 * key/precedence logic used by the resolver, the API, and their tests.
 */

export type DiscountScope = 'account' | 'ou' | 'org';

const DISCOUNT_PREFIX = 'discount#';
const OU_INFIX = 'ou#';
const ORG_INFIX = 'org#';

/** Build the reserved Pricing-table key (the `model` PK value) for a scope. */
export const discountKey = (scope: DiscountScope, scopeId: string): string => {
  if (scope === 'ou') return `${DISCOUNT_PREFIX}${OU_INFIX}${scopeId}`;
  if (scope === 'org') return `${DISCOUNT_PREFIX}${ORG_INFIX}${scopeId}`;
  return `${DISCOUNT_PREFIX}${scopeId}`;
};

/** True for any reserved discount row key (account, ou, or org). */
export const isDiscountKey = (key: string): boolean => key.startsWith(DISCOUNT_PREFIX);

/**
 * Parse a reserved discount key back into its scope + id. Returns undefined for
 * a non-discount key. Note: an account key is `discount#<id>` with no infix, so
 * it's distinguished by NOT starting with `ou#`/`org#` after the prefix.
 */
export const parseDiscountKey = (key: string): { scope: DiscountScope; scopeId: string } | undefined => {
  if (!key.startsWith(DISCOUNT_PREFIX)) return undefined;
  const rest = key.slice(DISCOUNT_PREFIX.length);
  if (rest.startsWith(OU_INFIX)) return { scope: 'ou', scopeId: rest.slice(OU_INFIX.length) };
  if (rest.startsWith(ORG_INFIX)) return { scope: 'org', scopeId: rest.slice(ORG_INFIX.length) };
  return { scope: 'account', scopeId: rest };
};

/** Validate a scopeId for a given scope. Account = 12 digits; ou = `ou-…` or a
 *  root `r-…`; org = `o-…`. Kept liberal on the AWS-id shapes but strict enough
 *  to reject obvious junk / injection. */
export const isValidScopeId = (scope: DiscountScope, scopeId: string): boolean => {
  if (scope === 'account') return /^\d{12}$/.test(scopeId);
  if (scope === 'ou') return /^(ou-[a-z0-9-]+|r-[a-z0-9]+)$/.test(scopeId);
  return /^o-[a-z0-9]+$/.test(scopeId);
};

/** A discount percentage is valid iff it's a finite number in (0, 100]. */
export const isValidPct = (pct: unknown): pct is number =>
  typeof pct === 'number' && Number.isFinite(pct) && pct > 0 && pct <= 100;

/** The authored discount policies, split by scope, that the resolver reads. */
export interface DiscountPolicies {
  /** accountId → pct */
  byAccount: Map<string, number>;
  /** ou-id (or root r-id) → pct */
  byOu: Map<string, number>;
  /** the org-wide pct, if any */
  org?: number;
}

export interface ResolvedDiscount {
  pct: number;
  scope: DiscountScope;
  /** The id of the winning scope (accountId / ou-id / org-id). */
  scopeId: string;
}

/**
 * Most-specific-wins resolution for ONE account. `ouPath` is root-first
 * (`[r-…, ou-parent, …, ou-immediate]`, as produced by walkOrgTree). Precedence:
 *
 *   1. account            — `byAccount[accountId]`
 *   2. nearest OU          — walk ouPath from the DEEPEST (immediate parent) up
 *   3. org root as an OU   — the root id is the first ouPath element, so it's
 *                            naturally the last OU checked in step 2
 *   4. org-wide            — `policies.org`
 *   5. none                — undefined (list price)
 *
 * Single winner; no multiplicative stacking. `orgId` is used only to label an
 * org-scope win.
 */
export const resolveEffectiveDiscount = (
  accountId: string,
  ouPath: readonly string[],
  policies: DiscountPolicies,
  orgId: string | undefined,
): ResolvedDiscount | undefined => {
  const acct = policies.byAccount.get(accountId);
  // An explicit account entry WINS precedence (most-specific). A value of 0 is
  // an explicit EXCLUSION — "meter this account at list price, ignoring any OU/
  // org discount it would otherwise inherit" — so it returns undefined (no
  // discount) but short-circuits BEFORE the OU/org fallthrough below. This is
  // the only way to opt one account out of an inherited discount.
  if (acct !== undefined) {
    return acct > 0 ? { pct: acct, scope: 'account', scopeId: accountId } : undefined;
  }

  // Deepest OU first: reverse the root-first path.
  for (let i = ouPath.length - 1; i >= 0; i -= 1) {
    const ouId = ouPath[i];
    const pct = policies.byOu.get(ouId);
    if (pct !== undefined) return { pct, scope: 'ou', scopeId: ouId };
  }

  if (policies.org !== undefined) {
    return { pct: policies.org, scope: 'org', scopeId: orgId ?? 'org' };
  }
  return undefined;
};
