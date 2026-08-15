import type { PreTokenGenerationV2TriggerEvent, PreTokenGenerationV2TriggerHandler } from 'aws-lambda';

/**
 * pre-token-generation V2 trigger that derives a `bbg:scope`
 * claim from the user's Cognito groups.
 *
 * Group naming convention:
 *   - `BBG-Admin-Wildcard` → super-admin: scope = `["*"]`
 *   - `BBG-Admin-<accountId>` (12-digit ID) → per-account admin: scope
 *     adds that account ID
 *   - `Users` and any other group → no scope contribution
 *
 * The claim is emitted as a JSON-encoded string (Cognito V2 trigger
 * accepts string-typed claims; arrays would be valid in V2 but the
 * SDK type for `claimsAndScopeOverrideDetails.claimsToAddOrOverride`
 * is `{ [k: string]: string }`).
 *
 * Wildcard wins: a user in `BBG-Admin-Wildcard` always gets `["*"]`
 * regardless of any per-account group memberships to keep the API-side
 * check simple.
 *
 * F1: also mints a `bbg:principal` claim from the admin-owned
 * `custom:iam_principal` attribute. The API reads /me/* spend+budget
 * identity from this claim, never from the user-writable attribute, so a
 * user can't repoint their own views at another principal's ledger. The
 * attribute is set only by admins (AdminUpdateUserAttributes) and is not
 * in the app client's `writeAttributes`; the claim just carries the
 * already-canonical value the admin stored.
 */
const ACCOUNT_GROUP_PREFIX = 'BBG-Admin-';
const WILDCARD_SUFFIX = 'Wildcard';
const ACCOUNT_ID_RE = /^\d{12}$/;

export const deriveScope = (groups: readonly string[]): string[] => {
  if (groups.includes(`${ACCOUNT_GROUP_PREFIX}${WILDCARD_SUFFIX}`)) return ['*'];
  const accounts = new Set<string>();
  for (const g of groups) {
    if (!g.startsWith(ACCOUNT_GROUP_PREFIX)) continue;
    const tail = g.slice(ACCOUNT_GROUP_PREFIX.length);
    if (ACCOUNT_ID_RE.test(tail)) accounts.add(tail);
  }
  return [...accounts].sort();
};

export const handler: PreTokenGenerationV2TriggerHandler = async (
  event: PreTokenGenerationV2TriggerEvent,
) => {
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const accounts = deriveScope(groups);
  // F1: carry the admin-owned IAM principal into a signed claim. Only emit
  // when set — an unmapped user gets no claim, which the API treats as
  // "no /me/* mapping" (same as before).
  const principal = (event.request.userAttributes['custom:iam_principal'] ?? '').trim();
  const claims: Record<string, string> = { 'bbg:scope': JSON.stringify(accounts) };
  if (principal) claims['bbg:principal'] = principal;
  // Cognito V2 access-token claims must be string-valued; the SPA + API
  // both parse the JSON.
  event.response.claimsAndScopeOverrideDetails = {
    idTokenGeneration: {
      claimsToAddOrOverride: { ...claims },
    },
    accessTokenGeneration: {
      claimsToAddOrOverride: { ...claims },
    },
  };
  return event;
};
