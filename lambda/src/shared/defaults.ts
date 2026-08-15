import { Threshold } from './thresholds.js';
import type { RateWindowSeconds } from './rate-limits.js';

/**
 * The defaults config lives as a single sentinel row in the Budgets
 * table. Reusing the existing table keeps IAM scoping, DDB stream
 * audit, and the API stack unchanged — admins flip the master toggle
 * via a thin GET/PUT wrapper that targets this one row.
 *
 * Sentinel `principal` + `target` are intentionally short ASCII so
 * they sort cleanly and never collide with any real IAM principal ARN
 * (which always starts with `principal#arn:aws:iam::...`).
 */
export const DEFAULTS_PRINCIPAL = '__defaults__';
export const DEFAULTS_TARGET = '__defaults__';

export interface DefaultsRow {
  principal: typeof DEFAULTS_PRINCIPAL;
  target: typeof DEFAULTS_TARGET;
  /** Master toggle. When false, the meter does NOT materialize default
   *  budgets and behavior is identical to today. */
  enabled: boolean;
  limitUsd: number;
  window?: 'monthly' | 'weekly' | 'daily' | '5h';
  thresholds?: Threshold[];
  /** BBG-RATELIMITS — optional rate-limit fields propagated to every
   *  default-materialized budget. Same semantics as on per-principal
   *  budgets; absence means "no rate limit on the materialized row".
   *  Operators who want runaway-loop protection on every principal-
   *  without-an-explicit-budget set these alongside `limitUsd`. */
  rpm?: number;
  tpm?: number;
  rateWindowSeconds?: RateWindowSeconds;
  updatedAt?: string;
}

export const isDefaultsRow = (row: { principal: string; target: string }): boolean =>
  row.principal === DEFAULTS_PRINCIPAL && row.target === DEFAULTS_TARGET;
