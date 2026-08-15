import { createHash } from 'node:crypto';
import { periodFor } from '../shared/ddb.js';

/**
 * Naming helpers for the parallel CUR + Budgets enforcement channel.
 *
 * The real-time meter (`enforcement/`) creates IAM policies named
 * `bbg-deny-<shortHash>-<period>`. This channel uses the distinct prefix
 * `bbg-deny-cur-<shortHash>-<period>` so the two channels never race for
 * the same policy. The shared IAM scope guardrail
 * (`iam:PolicyARN ArnEquals arn:aws:iam::<acct>:policy/bbg-deny-*`)
 * naturally covers both prefixes.
 */

const shortHash = (input: string, len = 12): string =>
  createHash('sha1').update(input).digest('hex').slice(0, len);

/**
 * Stable IAM policy name keyed by (principal, target, period). A new
 * policy is created at each month rollover so `period-rollover` can
 * detach + delete the old one without affecting the next month's deny.
 */
export const curDenyPolicyName = (
  principal: string,
  target: string,
  period: string = periodFor(),
): string => {
  const hash = shortHash(`${principal}|${target}|${period}`);
  return `bbg-deny-cur-${hash}-${period}`;
};

/**
 * Stable AWS Budgets budget name keyed by (principal, target). AWS
 * Budgets names are scoped by account and limited to 100 characters
 * (`:` and `\` and the substring `/action/` are forbidden). We
 * concatenate a short SHA-1 prefix and keep an operator-readable
 * suffix.
 */
export const curBudgetName = (principal: string, target: string): string => {
  const hash = shortHash(`${principal}|${target}`, 16);
  // Make the suffix human-grepable but bounded: trim the principal ARN
  // resource segment and the target dimension.
  const principalSuffix = principal
    .replace(/^principal#(agent-role#)?/, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 30);
  const targetSuffix = target.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 30);
  return `bbg-${hash}-${principalSuffix}-${targetSuffix}`.slice(0, 100);
};
