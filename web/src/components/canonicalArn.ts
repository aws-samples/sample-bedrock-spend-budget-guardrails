/**
 * Canonicalizes a Bedrock-caller ARN into the form the meter writes
 * to DynamoDB. Mirrors the lambda-side canonicalize() in
 * `lambda/src/shared/arn.ts` so admin-set / self-set IAM principals
 * match what the spend API queries on.
 *
 * Rules:
 *   - `arn:aws:sts::<acct>:assumed-role/<RoleName>/<session>`
 *     → `arn:aws:iam::<acct>:role/<RoleName>`
 *   - `arn:aws:iam::<acct>:user/<name>` — passthrough
 *   - `arn:aws:iam::<acct>:role/<name>` — passthrough
 *   - Anything else — passthrough (the meter's canonicalize handles
 *     SSO reserved-role variants directly off CloudTrail data, not from
 *     this user-facing field).
 */
export const canonicalizeIamArn = (arn: string): string => {
  const trimmed = arn.trim();
  const m = trimmed.match(
    /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]*$/,
  );
  if (m) {
    const [, account, roleName] = m;
    return `arn:aws:iam::${account}:role/${roleName}`;
  }
  return trimmed;
};

/** extract the 12-digit account ID from a principal ARN.
 *  Mirrors `accountFromPrincipal` in lambda/src/shared/iam-cross-account.ts.
 *  Returns the empty string when no account segment is present. */
export const accountFromPrincipal = (principal: string): string => {
  const match = /arn:aws:(?:iam|sts)::(\d+):/.exec(principal);
  return match ? match[1] : '';
};
