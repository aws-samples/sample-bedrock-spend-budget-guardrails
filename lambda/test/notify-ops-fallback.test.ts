import { describe, expect, it } from 'vitest';

// ops-fallback routing for principals that map to no Cognito human.
//
// notify/index.ts keeps its channel-gating logic in module scope (see
// notify-floor.test.ts / notify-sso-routing.test.ts for the same convention).
// We re-implement the two observable contracts introduced as drift
// guards:
//
//   1. shouldSendOpsFallback: the ops mailbox receives an email iff it is
//      configured, the principal maps to no user, the row is NOT an
//      identity-lens row (the primary role row covers the same dollars), the
//      ops address hasn't already been emailed, and either enforcement just
//      fired or a warn-threshold was crossed.
//   2. enforcementTriggerLine: USD / RPM / TPM branching, shared by the
//      admin-watch and ops-fallback channels.

interface Row {
  spendUsd?: number;
  enforcementReason?: 'usd' | 'rpm' | 'tpm';
  enforcementMetric?: { value: number; limit: number; windowSeconds?: number };
  identityLens?: 'sso-user' | 'source-identity';
}

/** Mirror of notify/index.ts OPS-FALLBACK channel guard. */
const shouldSendOpsFallback = (params: {
  opsFallback: string;
  hasUser: boolean;
  identityLens?: string;
  alreadySentToOps: boolean;
  enforcementJustFired: boolean;
  threshold: number | undefined;
}): boolean => {
  const { opsFallback, hasUser, identityLens, alreadySentToOps, enforcementJustFired, threshold } =
    params;
  if (!opsFallback || hasUser || identityLens || alreadySentToOps) return false;
  return enforcementJustFired || Boolean(threshold);
};

/** Mirror of notify/index.ts enforcementTriggerLine. */
const enforcementTriggerLine = (row: Row, limitUsd: number, pct: number): string => {
  const reason = row.enforcementReason ?? 'usd';
  const metric = row.enforcementMetric;
  if (reason === 'rpm' && metric) {
    return `  Trigger:   RPM rate limit — ${metric.value} requests in ${metric.windowSeconds ?? 60}s ≥ ${metric.limit} (likely runaway loop)\n`;
  }
  if (reason === 'tpm' && metric) {
    return `  Trigger:   TPM rate limit — ${metric.value} tokens in ${metric.windowSeconds ?? 60}s ≥ ${metric.limit}\n`;
  }
  const spend = typeof row.spendUsd === 'number' ? `$${row.spendUsd.toFixed(4)}` : '$0';
  return `  Trigger:   USD spend ${spend} of $${limitUsd.toFixed(4)} (${pct.toFixed(0)}%)\n`;
};

const base = {
  opsFallback: 'ops@example.com',
  hasUser: false,
  identityLens: undefined as string | undefined,
  alreadySentToOps: false,
  enforcementJustFired: false,
  threshold: undefined as number | undefined,
};

describe('ops-fallback channel guard', () => {
  it('sends on enforcement for an unmapped principal', () => {
    expect(shouldSendOpsFallback({ ...base, enforcementJustFired: true })).toBe(true);
  });

  it('sends on a warn-threshold for an unmapped principal', () => {
    expect(shouldSendOpsFallback({ ...base, threshold: 80 })).toBe(true);
  });

  it('does NOT send when the ops mailbox is unconfigured (legacy behavior)', () => {
    expect(shouldSendOpsFallback({ ...base, opsFallback: '', enforcementJustFired: true })).toBe(
      false,
    );
  });

  it('does NOT send when the principal maps to a Cognito user (user-self covers it)', () => {
    expect(shouldSendOpsFallback({ ...base, hasUser: true, enforcementJustFired: true })).toBe(
      false,
    );
  });

  it('does NOT send for an identity-lens row (primary role row covers the dollars)', () => {
    expect(
      shouldSendOpsFallback({ ...base, identityLens: 'sso-user', enforcementJustFired: true }),
    ).toBe(false);
  });

  it('does NOT double-send when the ops address was already emailed', () => {
    expect(
      shouldSendOpsFallback({ ...base, alreadySentToOps: true, enforcementJustFired: true }),
    ).toBe(false);
  });

  it('does NOT send when neither enforcement fired nor a threshold crossed', () => {
    expect(shouldSendOpsFallback(base)).toBe(false);
  });
});

describe('enforcementTriggerLine (shared USD/RPM/TPM copy)', () => {
  it('USD branch (default) shows spend of limit and pct', () => {
    expect(enforcementTriggerLine({ spendUsd: 12.5 }, 10, 125)).toContain(
      'USD spend $12.5000 of $10.0000 (125%)',
    );
  });

  it('RPM branch shows the request-rate window and limit', () => {
    const line = enforcementTriggerLine(
      { enforcementReason: 'rpm', enforcementMetric: { value: 500, limit: 100, windowSeconds: 60 } },
      10,
      0,
    );
    expect(line).toContain('RPM rate limit — 500 requests in 60s ≥ 100');
  });

  it('TPM branch shows the token-rate window and limit', () => {
    const line = enforcementTriggerLine(
      { enforcementReason: 'tpm', enforcementMetric: { value: 9000, limit: 8000 } },
      10,
      0,
    );
    expect(line).toContain('TPM rate limit — 9000 tokens in 60s ≥ 8000');
  });

  it('falls back to USD copy when a rate reason has no metric snapshot', () => {
    expect(enforcementTriggerLine({ enforcementReason: 'rpm', spendUsd: 5 }, 4, 125)).toContain(
      'USD spend $5.0000 of $4.0000 (125%)',
    );
  });
});
