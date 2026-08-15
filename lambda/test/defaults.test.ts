import { describe, expect, it } from 'vitest';
import {
  DEFAULTS_PRINCIPAL,
  DEFAULTS_TARGET,
  isDefaultsRow,
} from '../src/shared/defaults.js';

describe('defaults sentinel row helpers', () => {
  it('isDefaultsRow returns true for the sentinel keys', () => {
    expect(
      isDefaultsRow({ principal: DEFAULTS_PRINCIPAL, target: DEFAULTS_TARGET }),
    ).toBe(true);
  });

  it('isDefaultsRow returns false for any real budget row', () => {
    expect(
      isDefaultsRow({
        principal: 'principal#arn:aws:iam::111111111111:user/alice',
        target: 'model#anthropic.claude-opus-4-7',
      }),
    ).toBe(false);
  });

  it('isDefaultsRow returns false when only principal matches the sentinel', () => {
    expect(
      isDefaultsRow({
        principal: DEFAULTS_PRINCIPAL,
        target: 'model#anthropic.claude-opus-4-7',
      }),
    ).toBe(false);
  });

  it('isDefaultsRow returns false when only target matches the sentinel', () => {
    expect(
      isDefaultsRow({
        principal: 'principal#arn:aws:iam::111111111111:user/alice',
        target: DEFAULTS_TARGET,
      }),
    ).toBe(false);
  });

  it('sentinel keys are short ASCII (<=20 chars) so they sort cleanly', () => {
    // Defensive contract — both keys must be safe to use as DDB keys
    // and never collide with a real principal ARN (which always starts
    // with `principal#arn:aws:iam::...`).
    expect(DEFAULTS_PRINCIPAL.length).toBeLessThanOrEqual(20);
    expect(DEFAULTS_TARGET.length).toBeLessThanOrEqual(20);
    expect(DEFAULTS_PRINCIPAL).not.toContain('arn:');
    expect(DEFAULTS_TARGET).not.toContain('arn:');
  });
});
