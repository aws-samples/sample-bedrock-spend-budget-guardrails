import { Threshold, validateThresholds } from './thresholds.js';
import { Window, WINDOWS } from './period.js';
import {
  RATE_WINDOWS,
  type RateWindowSeconds,
} from './rate-limits.js';

/**
 * declarative budget manifest. Pure-TS schema validators + a
 * diff helper used by both the API endpoint and its tests. Whatever
 * the SPA YAML/Form editor produces, it goes through `validateManifest`
 * before reaching the server.
 *
 * `apply` semantics: upsert everything in `budgets`; remove everything
 * in `delete`; leave anything in current state but absent from the
 * manifest UNCHANGED. We deliberately do NOT support a "replace whole
 * world" mode in v1 — too easy to nuke production by forgetting an
 * entry.
 */

export interface ManifestBudget {
  principal: string;
  target: string;
  limitUsd?: number;
  window?: Window;
  thresholds?: Threshold[];
  unlimited?: boolean;
  enabled?: boolean;
  condition?: { tagKey: string; tagValue: string };
  /** BBG-RATELIMITS — request rate limit per `rateWindowSeconds`. */
  rpm?: number;
  /** BBG-RATELIMITS — token rate limit per `rateWindowSeconds` (input + output combined). */
  tpm?: number;
  /** BBG-RATELIMITS — sliding window length in seconds (60, 300, or 900). */
  rateWindowSeconds?: RateWindowSeconds;
}

export interface ManifestDefaults {
  enabled?: boolean;
  limitUsd?: number;
  window?: Window;
  thresholds?: Threshold[];
  /** BBG-RATELIMITS-DEFAULTS — rate limits propagated to every
   *  default-materialized budget. Same semantics as on per-budget
   *  entries. */
  rpm?: number;
  tpm?: number;
  rateWindowSeconds?: RateWindowSeconds;
}

export interface ManifestDeleteRef {
  principal: string;
  target: string;
}

export interface BudgetManifest {
  apiVersion: string;
  kind: string;
  metadata?: {
    description?: string;
  };
  defaults?: ManifestDefaults;
  budgets?: ManifestBudget[];
  delete?: ManifestDeleteRef[];
}

export class ManifestValidationError extends Error {}

const SUPPORTED_API_VERSION = 'bbg/v1';
const SUPPORTED_KIND = 'BudgetSet';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Normalize an operator-ergonomic target string into the canonical
 * RunningSpend shape. `model#…` / `profile#…` / wildcard pass through;
 * a bare model id gets the `model#` prefix; `*` becomes `model#*`.
 */
export const normalizeTarget = (target: string): string => {
  if (target.startsWith('model#') || target.startsWith('profile#')) return target;
  if (target === '*') return 'model#*';
  return `model#${target}`;
};

const normalizePrincipal = (principal: string): string =>
  principal.startsWith('principal#') ? principal : `principal#${principal}`;

/**
 * BBG-SESSIONTAG — session-tag condition charset. `condition.tagKey` /
 * `tagValue` flow into `buildDenyPolicy()` (shared/policies.ts) as an
 * `aws:PrincipalTag/<tagKey>` IAM Condition key and its StringEquals
 * value. Restrict both to the AWS tag charset (letters, digits, space,
 * and `_ . : / = + - @`) and cap length, so operator-supplied text can
 * never smuggle extra keys/values (quotes, braces, commas) into the
 * Condition block. */
const TAG_CHARSET = /^[A-Za-z0-9_ .:/=+@-]+$/;

/**
 * Validate an optional session-tag condition. Returns an error string
 * (suitable for a 400 response) or `undefined` when the input is clean
 * or absent. Both `tagKey` and `tagValue` must be present, in-charset,
 * and within AWS's tag-length limits. Mirrors `validateRateLimits` in
 * the budgets API — no throw, so both the API endpoint and
 * `validateManifest` can share it.
 */
export const validateCondition = (
  condition: unknown,
  label = 'condition',
): string | undefined => {
  if (condition === undefined || condition === null) return undefined;
  if (!isObject(condition)) {
    return `${label} must be an object with tagKey and tagValue.`;
  }
  const { tagKey, tagValue } = condition as { tagKey?: unknown; tagValue?: unknown };
  if (typeof tagKey !== 'string' || tagKey.length === 0) {
    return `${label}.tagKey is required.`;
  }
  if (typeof tagValue !== 'string' || tagValue.length === 0) {
    return `${label}.tagValue is required.`;
  }
  if (tagKey.length > 128 || !TAG_CHARSET.test(tagKey)) {
    return `${label}.tagKey must be <=128 chars from letters, digits, space, and _ . : / = + - @`;
  }
  if (tagValue.length > 256 || !TAG_CHARSET.test(tagValue)) {
    return `${label}.tagValue must be <=256 chars from letters, digits, space, and _ . : / = + - @`;
  }
  return undefined;
};

export const validateManifest = (raw: unknown): BudgetManifest => {
  if (!isObject(raw)) {
    throw new ManifestValidationError('Manifest must be an object.');
  }
  if (raw.apiVersion !== SUPPORTED_API_VERSION) {
    throw new ManifestValidationError(`apiVersion must be '${SUPPORTED_API_VERSION}'.`);
  }
  if (raw.kind !== SUPPORTED_KIND) {
    throw new ManifestValidationError(`kind must be '${SUPPORTED_KIND}'.`);
  }
  const out: BudgetManifest = {
    apiVersion: SUPPORTED_API_VERSION,
    kind: SUPPORTED_KIND,
  };
  if (isObject(raw.metadata)) out.metadata = raw.metadata as { description?: string };
  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) {
      throw new ManifestValidationError('defaults must be an object.');
    }
    const d = raw.defaults as ManifestDefaults;
    if (d.window !== undefined && !(WINDOWS as readonly string[]).includes(d.window)) {
      throw new ManifestValidationError(
        `defaults.window must be one of ${WINDOWS.join(', ')}.`,
      );
    }
    if (d.limitUsd !== undefined && (typeof d.limitUsd !== 'number' || d.limitUsd < 0)) {
      throw new ManifestValidationError('defaults.limitUsd must be a non-negative number.');
    }
    if (d.thresholds) validateThresholds(d.thresholds);
    // BBG-RATELIMITS-DEFAULTS — same field-level checks as per-budget
    // rate limits. Defaults are never `unlimited` (they always
    // materialize as `action: 'deny'`), so no unlimited-vs-rate clash.
    if (d.rpm !== undefined && (typeof d.rpm !== 'number' || !Number.isFinite(d.rpm) || d.rpm <= 0)) {
      throw new ManifestValidationError('defaults.rpm must be a positive number.');
    }
    if (d.tpm !== undefined && (typeof d.tpm !== 'number' || !Number.isFinite(d.tpm) || d.tpm <= 0)) {
      throw new ManifestValidationError('defaults.tpm must be a positive number.');
    }
    if (
      d.rateWindowSeconds !== undefined &&
      !(RATE_WINDOWS as readonly number[]).includes(d.rateWindowSeconds)
    ) {
      throw new ManifestValidationError(
        `defaults.rateWindowSeconds must be one of ${RATE_WINDOWS.join(', ')}.`,
      );
    }
    out.defaults = d;
  }
  if (raw.budgets !== undefined) {
    if (!Array.isArray(raw.budgets)) {
      throw new ManifestValidationError('budgets must be an array.');
    }
    out.budgets = raw.budgets.map((b: unknown, i: number) => {
      if (!isObject(b)) {
        throw new ManifestValidationError(`budgets[${i}] must be an object.`);
      }
      if (typeof b.principal !== 'string' || !b.principal) {
        throw new ManifestValidationError(`budgets[${i}].principal is required.`);
      }
      if (typeof b.target !== 'string' || !b.target) {
        throw new ManifestValidationError(`budgets[${i}].target is required.`);
      }
      const unlimited = Boolean(b.unlimited);
      const limitUsd = b.limitUsd as number | undefined;
      if (!unlimited && (typeof limitUsd !== 'number' || limitUsd < 0)) {
        throw new ManifestValidationError(
          `budgets[${i}].limitUsd is required and must be non-negative (or set unlimited: true).`,
        );
      }
      if (b.window !== undefined && !(WINDOWS as readonly string[]).includes(b.window as string)) {
        throw new ManifestValidationError(
          `budgets[${i}].window must be one of ${WINDOWS.join(', ')}.`,
        );
      }
      if (b.thresholds) {
        validateThresholds(b.thresholds as Threshold[]);
        if (unlimited && (b.thresholds as Threshold[]).some((t) => t.action === 'block')) {
          throw new ManifestValidationError(
            `budgets[${i}]: unlimited budgets cannot have a 'block' threshold.`,
          );
        }
      }
      // BBG-RATELIMITS — rate fields are independent of limitUsd. Same
      // shape rules as the API validator: positive numbers; supported
      // window only; mutually-exclusive with `unlimited`.
      const rpm = b.rpm as number | undefined;
      const tpm = b.tpm as number | undefined;
      const rws = b.rateWindowSeconds as number | undefined;
      if (rpm !== undefined && (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm <= 0)) {
        throw new ManifestValidationError(
          `budgets[${i}].rpm must be a positive number.`,
        );
      }
      if (tpm !== undefined && (typeof tpm !== 'number' || !Number.isFinite(tpm) || tpm <= 0)) {
        throw new ManifestValidationError(
          `budgets[${i}].tpm must be a positive number.`,
        );
      }
      if (rws !== undefined && !(RATE_WINDOWS as readonly number[]).includes(rws)) {
        throw new ManifestValidationError(
          `budgets[${i}].rateWindowSeconds must be one of ${RATE_WINDOWS.join(', ')}.`,
        );
      }
      if (unlimited && (rpm !== undefined || tpm !== undefined)) {
        throw new ManifestValidationError(
          `budgets[${i}]: unlimited budgets cannot have rpm or tpm rate limits.`,
        );
      }
      // BBG-SESSIONTAG — validate the optional session-tag condition so
      // operator input can't inject into the deny policy's Condition block.
      const conditionErr = validateCondition(b.condition, `budgets[${i}].condition`);
      if (conditionErr) throw new ManifestValidationError(conditionErr);
      return {
        principal: normalizePrincipal(b.principal),
        target: normalizeTarget(b.target),
        limitUsd: unlimited ? 0 : (limitUsd as number),
        window: b.window as Window | undefined,
        thresholds: b.thresholds as Threshold[] | undefined,
        unlimited: unlimited || undefined,
        enabled: b.enabled === undefined ? true : Boolean(b.enabled),
        condition: b.condition as ManifestBudget['condition'],
        rpm,
        tpm,
        rateWindowSeconds: rws as RateWindowSeconds | undefined,
      };
    });
  }
  if (raw.delete !== undefined) {
    if (!Array.isArray(raw.delete)) {
      throw new ManifestValidationError('delete must be an array.');
    }
    out.delete = raw.delete.map((r: unknown, i: number) => {
      if (!isObject(r) || typeof r.principal !== 'string' || typeof r.target !== 'string') {
        throw new ManifestValidationError(`delete[${i}] must have string principal + target.`);
      }
      return {
        principal: normalizePrincipal(r.principal),
        target: normalizeTarget(r.target),
      };
    });
  }
  return out;
};

export interface DiffEntry {
  principal: string;
  target: string;
}

export interface ManifestDiff {
  created: DiffEntry[];
  updated: DiffEntry[];
  unchanged: DiffEntry[];
  removed: DiffEntry[];
  defaultsChanged: boolean;
}

interface CurrentBudget {
  principal: string;
  target: string;
  limitUsd?: number;
  window?: Window;
  thresholds?: Threshold[];
  unlimited?: boolean;
  enabled?: boolean;
  /** BBG-SESSIONTAG — same shape as ManifestBudget; included in the diff
   *  comparison so a manifest apply notices session-tag condition changes
   *  (previously omitted → a condition-only change showed as unchanged). */
  condition?: { tagKey: string; tagValue: string };
  /** BBG-RATELIMITS — same shape as ManifestBudget; included in the
   *  diff comparison so manifest applies notice rate-field changes. */
  rpm?: number;
  tpm?: number;
  rateWindowSeconds?: RateWindowSeconds;
}

const sameBudget = (a: ManifestBudget, b: CurrentBudget): boolean => {
  if (Boolean(a.unlimited) !== Boolean(b.unlimited)) return false;
  if (!a.unlimited && (a.limitUsd ?? 0) !== (b.limitUsd ?? 0)) return false;
  if ((a.window ?? 'monthly') !== (b.window ?? 'monthly')) return false;
  if (Boolean(a.enabled) !== Boolean(b.enabled ?? true)) return false;
  const at = JSON.stringify(a.thresholds ?? null);
  const bt = JSON.stringify(b.thresholds ?? null);
  if (at !== bt) return false;
  // BBG-SESSIONTAG — compare the session-tag condition too. Omitting it
  // meant a condition-only change (e.g. tagValue team-a → team-b) diffed
  // as "unchanged" and the apply loop skipped the write, silently
  // dropping the change. Normalize absent → null so both encode the same.
  const ac = a.condition ? { tagKey: a.condition.tagKey, tagValue: a.condition.tagValue } : null;
  const bc = b.condition ? { tagKey: b.condition.tagKey, tagValue: b.condition.tagValue } : null;
  if (JSON.stringify(ac) !== JSON.stringify(bc)) return false;
  // BBG-RATELIMITS — treat undefined and 0 as the same (both mean "no limit").
  if ((a.rpm ?? 0) !== (b.rpm ?? 0)) return false;
  if ((a.tpm ?? 0) !== (b.tpm ?? 0)) return false;
  if ((a.rateWindowSeconds ?? 60) !== (b.rateWindowSeconds ?? 60)) return false;
  return true;
};

export const diffManifest = (
  current: CurrentBudget[],
  manifest: BudgetManifest,
  currentDefaults?: ManifestDefaults,
): ManifestDiff => {
  const out: ManifestDiff = {
    created: [],
    updated: [],
    unchanged: [],
    removed: [],
    defaultsChanged: false,
  };
  const currentByKey = new Map<string, CurrentBudget>();
  for (const c of current) currentByKey.set(`${c.principal}${c.target}`, c);

  for (const m of manifest.budgets ?? []) {
    const key = `${m.principal}${m.target}`;
    const cur = currentByKey.get(key);
    if (!cur) {
      out.created.push({ principal: m.principal, target: m.target });
    } else if (sameBudget(m, cur)) {
      out.unchanged.push({ principal: m.principal, target: m.target });
    } else {
      out.updated.push({ principal: m.principal, target: m.target });
    }
  }
  for (const d of manifest.delete ?? []) {
    const key = `${d.principal}${d.target}`;
    if (currentByKey.has(key)) {
      out.removed.push({ principal: d.principal, target: d.target });
    }
  }
  if (manifest.defaults && currentDefaults) {
    const before = JSON.stringify({
      enabled: Boolean(currentDefaults.enabled),
      limitUsd: currentDefaults.limitUsd ?? 0,
      window: currentDefaults.window ?? 'monthly',
      thresholds: currentDefaults.thresholds ?? null,
      rpm: currentDefaults.rpm ?? null,
      tpm: currentDefaults.tpm ?? null,
      rateWindowSeconds: currentDefaults.rateWindowSeconds ?? null,
    });
    const after = JSON.stringify({
      enabled: Boolean(manifest.defaults.enabled),
      limitUsd: manifest.defaults.limitUsd ?? currentDefaults.limitUsd ?? 0,
      window: manifest.defaults.window ?? currentDefaults.window ?? 'monthly',
      thresholds: manifest.defaults.thresholds ?? currentDefaults.thresholds ?? null,
      rpm: manifest.defaults.rpm ?? currentDefaults.rpm ?? null,
      tpm: manifest.defaults.tpm ?? currentDefaults.tpm ?? null,
      rateWindowSeconds:
        manifest.defaults.rateWindowSeconds ?? currentDefaults.rateWindowSeconds ?? null,
    });
    out.defaultsChanged = before !== after;
  } else if (manifest.defaults && !currentDefaults) {
    out.defaultsChanged = true;
  }
  return out;
};
