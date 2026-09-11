import { canonicalizeCurPrincipal, stripCrisPrefix } from '../shared/arn.js';

export interface SpendRow {
  principal?: string;
  spend: number;
  /** CUR resource ARN, or ledger model# target. */
  target?: string;
  account?: string;
}

const modelOf = (target: string | undefined): string | undefined => {
  const model = target?.startsWith('model#') ? target.slice(6)
    : target?.match(/^arn:aws(?:-us-gov|-cn)?:bedrock:[^:]+:[^:]*:foundation-model\/(.+)$/)?.[1];
  return model ? stripCrisPrefix(model) : undefined;
};
const accountOf = (row: SpendRow): string | undefined =>
  row.account || row.principal?.match(/arn:aws(?:-us-gov|-cn)?:(?:iam|sts)::(\d+):/)?.[1];
const modelKey = (row: SpendRow): string | undefined => {
  const model = modelOf(row.target);
  const account = accountOf(row);
  return model && account ? `account-model#${account}/${model}` : undefined;
};

/**
 * Some async CUR rows have a model ARN but no caller identity. Compare the
 * whole account/model on BOTH sides in that case, including any attributed
 * CUR rows for the same model. Never allocate its dollars to an invented role
 * or hide the fact that per-principal validation is unavailable.
 */
export const reconciliationTotals = (cur: SpendRow[], ledger: SpendRow[]) => {
  const pooled = new Set(cur.filter((r) => !r.principal?.trim()).map(modelKey)
    .filter((k): k is string => k !== undefined));
  const curTotals = new Map<string, number>();
  const meterTotals = new Map<string, number>();
  let unattributedSpend = 0;
  const add = (map: Map<string, number>, key: string, spend: number) =>
    map.set(key, (map.get(key) ?? 0) + spend);
  for (const row of cur) {
    const principal = row.principal?.trim();
    if (!principal) unattributedSpend += row.spend;
    const key = modelKey(row);
    add(curTotals, key && pooled.has(key) ? key
      : principal ? `principal#${canonicalizeCurPrincipal(principal)}`
        : `unattributed#${accountOf(row) ?? 'unknown'}`, row.spend);
  }
  for (const row of ledger) {
    if (!row.principal) throw new Error('Ledger spend has no principal');
    const key = modelKey(row);
    add(meterTotals, key && pooled.has(key) ? key : row.principal, row.spend);
  }
  return { curTotals, meterTotals, unattributedSpend, pooledModels: [...pooled].sort() };
};
