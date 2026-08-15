import { describe, expect, it } from 'vitest';
import {
  ManifestValidationError,
  diffManifest,
  normalizeTarget,
  validateManifest,
} from '../src/shared/manifest.js';

describe('normalizeTarget', () => {
  it('passes through prefixed targets', () => {
    expect(normalizeTarget('model#anthropic.claude-opus-4-7')).toBe(
      'model#anthropic.claude-opus-4-7',
    );
    expect(normalizeTarget('profile#us.anthropic.claude-sonnet-4-6')).toBe(
      'profile#us.anthropic.claude-sonnet-4-6',
    );
  });
  it('prefixes a bare model id with model#', () => {
    expect(normalizeTarget('anthropic.claude-opus-4-7')).toBe(
      'model#anthropic.claude-opus-4-7',
    );
  });
  it('expands * to model#*', () => {
    expect(normalizeTarget('*')).toBe('model#*');
  });
});

describe('validateManifest happy path', () => {
  it('accepts a complete manifest with budgets, defaults, and delete', () => {
    const m = validateManifest({
      apiVersion: 'bbg/v1',
      kind: 'BudgetSet',
      defaults: {
        enabled: true,
        limitUsd: 50,
        window: 'monthly',
        thresholds: [
          { at: 80, action: 'warn' },
          { at: 100, action: 'block' },
        ],
      },
      budgets: [
        {
          principal: 'arn:aws:iam::123456789012:user/alice',
          target: 'anthropic.claude-opus-4-7',
          limitUsd: 200,
          window: 'monthly',
          thresholds: [
            { at: 80, action: 'warn' },
            { at: 100, action: 'block' },
          ],
        },
        {
          principal: 'principal#arn:aws:iam::123456789012:role/Researcher',
          target: '*',
          unlimited: true,
        },
      ],
      delete: [
        {
          principal: 'arn:aws:iam::123456789012:user/bob',
          target: 'anthropic.claude-opus-4-7',
        },
      ],
    });
    expect(m.budgets).toHaveLength(2);
    // Principal + target normalization.
    expect(m.budgets![0].principal).toBe('principal#arn:aws:iam::123456789012:user/alice');
    expect(m.budgets![0].target).toBe('model#anthropic.claude-opus-4-7');
    expect(m.budgets![1].target).toBe('model#*');
    expect(m.budgets![1].unlimited).toBe(true);
    expect(m.delete).toHaveLength(1);
    expect(m.delete![0].principal).toBe('principal#arn:aws:iam::123456789012:user/bob');
  });
});

describe('validateManifest rejects bad input', () => {
  it('rejects wrong apiVersion', () => {
    expect(() => validateManifest({ apiVersion: 'v0', kind: 'BudgetSet' })).toThrow(
      ManifestValidationError,
    );
  });
  it('rejects wrong kind', () => {
    expect(() => validateManifest({ apiVersion: 'bbg/v1', kind: 'Wrong' })).toThrow(
      ManifestValidationError,
    );
  });
  it('rejects missing limitUsd on a non-unlimited budget', () => {
    expect(() =>
      validateManifest({
        apiVersion: 'bbg/v1',
        kind: 'BudgetSet',
        budgets: [{ principal: 'arn:aws:iam::1:user/a', target: '*' }],
      }),
    ).toThrow(/limitUsd is required/);
  });
  it('rejects an unlimited budget with a block threshold', () => {
    expect(() =>
      validateManifest({
        apiVersion: 'bbg/v1',
        kind: 'BudgetSet',
        budgets: [
          {
            principal: 'arn:aws:iam::1:user/a',
            target: '*',
            unlimited: true,
            thresholds: [{ at: 100, action: 'block' }],
          },
        ],
      }),
    ).toThrow(/cannot have a 'block' threshold/);
  });
  it('rejects bad window kind', () => {
    expect(() =>
      validateManifest({
        apiVersion: 'bbg/v1',
        kind: 'BudgetSet',
        defaults: { window: 'fortnightly' as never },
      }),
    ).toThrow(/window/);
  });
});

describe('diffManifest', () => {
  const ALICE = 'principal#arn:aws:iam::1:user/alice';
  const BOB = 'principal#arn:aws:iam::1:user/bob';
  const TGT = 'model#anthropic.claude-opus-4-7';

  it('classifies budgets as created/updated/unchanged', () => {
    const current = [
      { principal: ALICE, target: TGT, limitUsd: 100, window: 'monthly' as const, enabled: true },
      { principal: BOB, target: TGT, limitUsd: 50, window: 'monthly' as const, enabled: true },
    ];
    const m = validateManifest({
      apiVersion: 'bbg/v1',
      kind: 'BudgetSet',
      budgets: [
        { principal: ALICE, target: TGT, limitUsd: 100, window: 'monthly' }, // unchanged
        { principal: BOB, target: TGT, limitUsd: 75, window: 'monthly' }, // updated
        {
          principal: 'arn:aws:iam::1:user/carol',
          target: TGT,
          limitUsd: 200,
          window: 'monthly',
        }, // created
      ],
    });
    const d = diffManifest(current, m);
    expect(d.unchanged.map((x) => x.principal)).toEqual([ALICE]);
    expect(d.updated.map((x) => x.principal)).toEqual([BOB]);
    expect(d.created.map((x) => x.principal)).toEqual([
      'principal#arn:aws:iam::1:user/carol',
    ]);
  });

  it('honors the explicit delete list', () => {
    const current = [
      { principal: ALICE, target: TGT, limitUsd: 100, window: 'monthly' as const, enabled: true },
    ];
    const m = validateManifest({
      apiVersion: 'bbg/v1',
      kind: 'BudgetSet',
      delete: [{ principal: ALICE, target: TGT }],
    });
    const d = diffManifest(current, m);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].principal).toBe(ALICE);
  });

  it('does NOT remove rows that are merely absent from the manifest (no replace mode)', () => {
    const current = [
      { principal: ALICE, target: TGT, limitUsd: 100, window: 'monthly' as const, enabled: true },
    ];
    const m = validateManifest({ apiVersion: 'bbg/v1', kind: 'BudgetSet', budgets: [] });
    const d = diffManifest(current, m);
    expect(d.removed).toHaveLength(0);
    expect(d.created).toHaveLength(0);
    expect(d.updated).toHaveLength(0);
  });

  it('detects defaults change', () => {
    const m = validateManifest({
      apiVersion: 'bbg/v1',
      kind: 'BudgetSet',
      defaults: { enabled: true, limitUsd: 100, window: 'monthly' },
    });
    const d = diffManifest([], m, { enabled: false, limitUsd: 0, window: 'monthly' });
    expect(d.defaultsChanged).toBe(true);
  });

  it('reports defaults unchanged when the values match', () => {
    const m = validateManifest({
      apiVersion: 'bbg/v1',
      kind: 'BudgetSet',
      defaults: { enabled: false, limitUsd: 100, window: 'monthly' },
    });
    const d = diffManifest([], m, { enabled: false, limitUsd: 100, window: 'monthly' });
    expect(d.defaultsChanged).toBe(false);
  });
});
