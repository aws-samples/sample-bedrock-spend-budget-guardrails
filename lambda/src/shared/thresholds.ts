export type ThresholdAction = 'warn' | 'block';

export interface Threshold {
  at: number;
  action: ThresholdAction;
}

export interface BudgetThresholdSource {
  thresholds?: Threshold[];
  action?: 'deny' | 'alert';
}

const DEFAULT_DENY: Threshold[] = [
  { at: 50, action: 'warn' },
  { at: 80, action: 'warn' },
  { at: 100, action: 'block' },
];

const DEFAULT_ALERT: Threshold[] = [
  { at: 50, action: 'warn' },
  { at: 80, action: 'warn' },
  { at: 100, action: 'warn' },
];

export const resolveThresholds = (row: BudgetThresholdSource): Threshold[] => {
  if (row.thresholds && row.thresholds.length > 0) {
    return [...row.thresholds].sort((a, b) => a.at - b.at);
  }
  return row.action === 'alert' ? DEFAULT_ALERT : DEFAULT_DENY;
};

export const warnPercents = (thresholds: Threshold[]): number[] =>
  thresholds.filter((t) => t.action === 'warn').map((t) => t.at);

export const blockThreshold = (thresholds: Threshold[]): Threshold | undefined =>
  thresholds.find((t) => t.action === 'block');

export const highestCrossedWarn = (
  pct: number,
  thresholds: Threshold[],
  lastNotified = 0,
): number | null => {
  let crossed = -1;
  for (const t of thresholds) {
    if (t.action !== 'warn') continue;
    if (pct >= t.at && t.at > lastNotified) crossed = t.at;
  }
  return crossed > 0 ? crossed : null;
};

export class ThresholdValidationError extends Error {}

export const validateThresholds = (thresholds: Threshold[]): void => {
  if (thresholds.length === 0) {
    throw new ThresholdValidationError('At least one threshold is required.');
  }
  let prev = -Infinity;
  for (let i = 0; i < thresholds.length; i++) {
    const t = thresholds[i];
    if (typeof t.at !== 'number' || !Number.isFinite(t.at) || t.at <= 0 || t.at > 1000) {
      throw new ThresholdValidationError(`Threshold #${i + 1}: \`at\` must be a number in (0, 1000].`);
    }
    if (t.action !== 'warn' && t.action !== 'block') {
      throw new ThresholdValidationError(`Threshold #${i + 1}: \`action\` must be 'warn' or 'block'.`);
    }
    if (t.at <= prev) {
      throw new ThresholdValidationError('Thresholds must have strictly-increasing `at` percentages.');
    }
    if (t.action === 'block') {
      // Check duplicate before position so "two blocks" gives a more
      // specific error than "block must be last."
      const otherBlocks = thresholds.filter((x, j) => j !== i && x.action === 'block');
      if (otherBlocks.length > 0) {
        throw new ThresholdValidationError('Only one `block` threshold per budget is allowed.');
      }
      if (i !== thresholds.length - 1) {
        throw new ThresholdValidationError('The `block` threshold must be the last entry.');
      }
    }
    prev = t.at;
  }
};
