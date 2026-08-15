import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import type { BbgConfig } from '../config';

/** A single row from GET /admin/spend or GET /me/spend. */
export interface SpendRow {
  principal: string;
  sk: string;
  period?: string;
  target?: string;
  spendUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Per-dimension USD cost map, e.g. { inputTokens: 0.03, outputImages: 0.40 }. */
  dimCost?: Record<string, number>;
  /** Per-dimension usage counts. */
  dimUsage?: Record<string, number>;
  /**
   * per-region cost attribution. Keys are AWS region codes
   * (`us-west-2`, `us-east-1`, ...); values are USD totals attributed
   * to that source region. Empty map for legacy rows that pre-date
   * the region-attribution write path.
   */
  regions?: Record<string, number>;
  /** True when an enforcement deny policy is currently attached. */
  enforced: boolean;
  /**
   * BBG-RATELIMITS — what triggered the active enforcement. Set
   * alongside `enforced=true` when the backend stamps a deny policy.
   * Absent / undefined for legacy rows; treat as 'usd' for back-compat.
   */
  enforcementReason?: EnforcementReason;
  /**
   * BBG-RATELIMITS — value/limit/window snapshot at deny time, used
   * by the SPA status cell + release-confirmation copy.
   */
  enforcementMetric?: EnforcementMetric;
  /**
   * identity-lens rows: the per-identity view of a role's spend
   * (principal is `principal#sso-user#<email>` / `principal#sourceIdentity#
   * <value>`). Excluded from dashboard aggregates (they duplicate the
   * primary role row's dollars) and shown in the per-row table with a
   * badge. `issuerPrincipal` is the role the deny attaches to.
   */
  identityLens?: 'sso-user' | 'source-identity';
  issuerPrincipal?: string;
}

export interface SpendResponse {
  period: string;
  items: SpendRow[];
  /** Set on /me/spend when the caller has no `custom:iam_principal` mapped. */
  unmapped?: boolean;
}

export type ThresholdAction = 'warn' | 'block';

export interface Threshold {
  at: number;
  action: ThresholdAction;
}

export type BudgetWindow = 'monthly' | 'weekly' | 'daily' | '5h';

/**
 * BBG-RATELIMITS — sliding window length in seconds for rpm/tpm.
 * Mirrors the lambda-side `RateWindowSeconds`. Closed set: 60, 300, 900.
 */
export type RateWindowSeconds = 60 | 300 | 900;

/**
 * BBG-RATELIMITS — reason field stamped on a RunningSpend row when
 * enforcement attaches a deny policy. Powers the SPA's status cell
 * and the per-spend-row release confirm copy.
 */
export type EnforcementReason = 'usd' | 'rpm' | 'tpm';

/**
 * BBG-RATELIMITS — snapshot of what was measured at deny time. The SPA
 * reads this off the matching SpendRow to render "Enforced (RPM 42 ≥
 * 20 in 60s)" instead of just "Enforced (deny)".
 */
export interface EnforcementMetric {
  value: number;
  limit: number;
  windowSeconds?: RateWindowSeconds;
}

export interface BudgetRow {
  principal: string;
  target: string;
  limitUsd: number;
  action: 'deny' | 'alert';
  /** Optional explicit threshold list. When absent, the backend falls
   *  back to the default cadence (warn at 50/80, block at 100% for
   *  `action: 'deny'`; warn at 50/80/100 for `action: 'alert'`). */
  thresholds?: Threshold[];
  /** Reset cadence. Defaults to `monthly` when absent. */
  window?: BudgetWindow;
  /** when true, enforcement is suppressed for this budget;
   *  meter still records spend. */
  unlimited?: boolean;
  /** 'default' on rows materialized from the org-wide
   *  default-deny baseline; 'manual' otherwise. */
  source?: 'manual' | 'default';
  enabled: boolean;
  condition?: { tagKey: string; tagValue: string };
  /**
   * BBG-RATELIMITS — request rate limit per `rateWindowSeconds`. When
   * set, enforcement attaches a deny policy on breach independently
   * of `limitUsd`. Pass `null` on PUT to clear an existing limit.
   */
  rpm?: number | null;
  /**
   * BBG-RATELIMITS — token rate limit per `rateWindowSeconds` (input +
   * output combined). Pass `null` on PUT to clear.
   */
  tpm?: number | null;
  /**
   * BBG-RATELIMITS — sliding window length for rpm/tpm. Defaults to 60
   * server-side. Pass `null` on PUT to reset to default.
   */
  rateWindowSeconds?: RateWindowSeconds | null;
}

/** default-deny baseline config (one row in Budgets, sentinel-keyed). */
export interface DefaultsConfig {
  enabled: boolean;
  limitUsd: number;
  window: BudgetWindow;
  thresholds: Threshold[];
  /** BBG-RATELIMITS-DEFAULTS — optional rate limits propagated to every
   *  default-materialized budget. Absence (undefined) means "no rate
   *  limit". Pass `null` on PUT to clear an existing value. */
  rpm?: number | null;
  tpm?: number | null;
  rateWindowSeconds?: RateWindowSeconds | null;
  updatedAt?: string | null;
}

export interface BudgetResponse {
  items: BudgetRow[];
  /** Set by /me/budget when the caller has no `custom:iam_principal` mapped. */
  unmapped?: boolean;
}

/** a single Bedrock-capable IAM principal from the readiness audit. */
export interface ReadinessPrincipal {
  arn: string;
  name: string;
  principal_type: string;
  tags: Record<string, string>;
  is_identity_center_role: boolean;
  /** How Bedrock access was granted: "explicit" (a named bedrock: action)
   *  or "broad" (only via the "*" admin wildcard). */
  access_via?: 'explicit' | 'broad';
}

/**
 * the readiness audit findings (subset of the
 * bedrock-attribution-audit AccountFindings.to_dict() shape the SPA renders).
 * Field names are snake_case because they come straight from the Python
 * dataclass.
 */
export interface ReadinessFindings {
  account_id: string;
  account_name?: string | null;
  readiness: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  readiness_reasoning?: string;
  recommendations?: string[];
  warnings?: string[];
  total_bedrock_spend_30d_usd?: number;
  total_bedrock_spend_90d_usd?: number;
  spend_attribution_status?: string;
  bedrock_regions_with_activity?: string[];
  tag_coverage?: {
    total_principals: number;
    pct_with_team: number;
    pct_with_cost_center: number;
    pct_with_environment: number;
    pct_with_project: number;
  };
  candidate_principals?: ReadinessPrincipal[];
  application_inference_profiles?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
}

/**
 * org-mode: the org-level rollup returned when the audit auto-pivots
 * to an Organizations management-account sweep. `accounts` are full
 * per-account findings; the SPA renders a readiness rollup over them.
 */
export interface ReadinessOrgFindings {
  organization_id?: string | null;
  management_account_id: string;
  total_org_bedrock_spend_30d_usd?: number;
  total_org_bedrock_spend_90d_usd?: number;
  accounts?: ReadinessFindings[];
  accounts_skipped?: Array<{ account_id: string; name?: string; reason?: string }>;
}

const authHeaders = async (): Promise<Record<string, string>> => {
  try {
    const session = await fetchAuthSession({ forceRefresh: false });
    const token = session.tokens?.idToken?.toString();
    if (token) return { authorization: `Bearer ${token}` };
  } catch {
    // No active session — return no auth header; API will 401.
  }
  return {};
};

let staleTokenSignoutTriggered = false;

/**
 * On a 401 from the JWT authorizer, the cached ID token is stale or invalid.
 * Sign the user out so the AuthGate forces a fresh sign-in (and a freshly
 * minted token with the latest claims like `cognito:groups`).
 *
 * Throwing first lets the caller surface a useful error before the reload
 * so devs see what happened in the console.
 */
const handleStaleToken = async (): Promise<void> => {
  if (staleTokenSignoutTriggered) return;
  staleTokenSignoutTriggered = true;
  try {
    await signOut();
  } catch {
    // ignore
  }
  // Reload so AuthGate re-evaluates fetchAuthSession from a clean slate.
  if (typeof window !== 'undefined') {
    window.location.assign(window.location.origin);
  }
};

const request = async <T>(
  config: BbgConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  if (!config.apiBaseUrl) throw new Error('API base URL is not configured');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(await authHeaders()),
  };
  const resp = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (resp.status === 401) {
    void handleStaleToken();
    throw new Error('Session expired. Refreshing…');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}: ${text || method + ' ' + path}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
};

/**
 * an earlier change/BBG-activity: one row of a principal's activity timeline. Shared by
 * the per-principal modal, the self-service /me/activity view, and the central
 * /admin/activity feed (hoisted here so those consumers don't each redeclare
 * it). `principal`/`accountId` are only populated on the cross-principal feed;
 * on the self-service view `actor` is redacted to `byAdmin`.
 */
export interface ActivityItem {
  ts: string;
  type: string;
  summary: string;
  detail?: Record<string, unknown>;
  actor?: { sub?: string; email?: string };
  /** Central feed only: which principal the event is about. */
  principal?: string;
  /** Central feed only: the principal's AWS account, when derivable. */
  accountId?: string;
  /** Self-service view only: true when an admin (not the system) acted. */
  byAdmin?: boolean;
}

export interface ActivityResponse {
  items: ActivityItem[];
  /** Opaque pagination cursor; absent when there are no more rows. */
  cursor?: string;
  /** /me/activity: true when the caller has no mapped IAM principal. */
  unmapped?: boolean;
  /** /me/activity: true when a bbg:principal claim resolved. */
  mappedPrincipal?: boolean;
}

export type DiscountScope = 'account' | 'ou' | 'org';

/** A row from GET /admin/pricing/discounts — an authored discount at some scope,
 *  plus (for account rows) the resolver-materialized effective rate + provenance. */
export interface PricingDiscountRow {
  scope: DiscountScope;
  scopeId: string;
  /** Legacy alias for account rows. */
  accountId?: string;
  /** Authored value at this scope (absent on an account row that only inherits). */
  discountPct?: number;
  label?: string;
  updatedAt?: string;
  /** Resolver-materialized effective rate (account rows only). */
  effectivePct?: number;
  effectiveScope?: DiscountScope;
  effectiveScopeId?: string;
}

/** Build the ?principal=&target= query string for budget mutations. Uses
 *  encodeURIComponent (RFC 3986), NOT URLSearchParams — the latter
 *  form-encodes a space as '+', which API Gateway would hand the Lambda as a
 *  literal '+' and mis-key a sessionTag/sourceIdentity principal containing a
 *  space. Matches the sibling /admin/principal-activity route's encoding. */
const budgetQs = (principal: string, target: string): string =>
  `principal=${encodeURIComponent(principal)}&target=${encodeURIComponent(target)}`;

/** Convenience wrappers used by pages. */
export const api = {
  listSpend: (config: BbgConfig, period?: string) =>
    request<SpendResponse>(config, 'GET', `/admin/spend${period ? `?period=${period}` : ''}`),
  listSpendTrend: (config: BbgConfig, months = 6) =>
    request<{
      months: number;
      items: Array<{
        period: string;
        totalUsd: number;
        // Per-account split (multi-account installs). Additive — absent on
        // older backends; when a per-account filter is active the SPA then
        // falls back to `totalUsd` (already scope-filtered) rather than a
        // flat $0 line. Keys are true ARN accounts or '(unknown)'.
        byAccount?: Record<string, number>;
      }>;
    }>(config, 'GET', `/admin/spend/trend?months=${months}`),
  mySpendTrend: (config: BbgConfig, months = 3) =>
    request<{ months: number; items: Array<{ period: string; totalUsd: number }>; unmapped?: boolean }>(
      config,
      'GET',
      `/me/spend/trend?months=${months}`,
    ),
  listSpendPeriods: (config: BbgConfig) =>
    request<{ periods: string[] }>(config, 'GET', '/admin/spend/periods'),
  mySpendPeriods: (config: BbgConfig) =>
    request<{ periods: string[]; unmapped?: boolean }>(config, 'GET', '/me/spend/periods'),
  mySpend: (config: BbgConfig, period?: string) =>
    request<SpendResponse>(config, 'GET', `/me/spend${period ? `?period=${period}` : ''}`),
  listBudgets: (config: BbgConfig) => request<BudgetResponse>(config, 'GET', '/admin/budgets'),
  myBudget: (config: BbgConfig) => request<BudgetResponse>(config, 'GET', '/me/budget'),
  createBudget: (config: BbgConfig, body: Omit<BudgetRow, 'enabled'> & { enabled?: boolean }) =>
    request<BudgetRow>(config, 'POST', '/admin/budgets', body),
  // Budget mutations pass principal + target as QUERY params (not path
  // segments): both embed an ARN whose '/' breaks HTTP-API path matching. The
  // exported signatures are unchanged, so callers (AdminBudgets.tsx) need no edit.
  updateBudget: (
    config: BbgConfig,
    principal: string,
    target: string,
    body: Omit<BudgetRow, 'enabled'> & { enabled?: boolean },
  ) => request<BudgetRow>(config, 'PUT', `/admin/budget?${budgetQs(principal, target)}`, body),
  deleteBudget: (config: BbgConfig, principal: string, target: string) =>
    request<void>(config, 'DELETE', `/admin/budget?${budgetQs(principal, target)}`),
  toggleBudget: (config: BbgConfig, principal: string, target: string) =>
    request<BudgetRow>(config, 'POST', `/admin/budget/toggle?${budgetQs(principal, target)}`),
  releaseBudget: (config: BbgConfig, principal: string, target: string) =>
    request<{ released: boolean; policyArn?: string; reason?: string }>(
      config,
      'POST',
      `/admin/budget/release?${budgetQs(principal, target)}`,
    ),
  // default-deny baseline config.
  getDefaults: (config: BbgConfig) =>
    request<DefaultsConfig>(config, 'GET', '/admin/defaults'),
  putDefaults: (config: BbgConfig, body: Partial<DefaultsConfig>) =>
    request<DefaultsConfig>(config, 'PUT', '/admin/defaults', body),
  // declarative manifest apply (with dry-run flag).
  applyManifest: (config: BbgConfig, manifest: unknown, dryRun: boolean) =>
    request<unknown>(config, 'POST', '/admin/budgets:apply', { manifest, dryRun }),
  listIdentities: (config: BbgConfig, periodHours = 1) =>
    request<{
      items: Array<{
        principal: string;
        principalType?: string;
        principalArn?: string;
        ssoUser?: string;
        firstSeen?: string;
        lastSeen?: string;
        eventTime?: string;
      }>;
      periodHours: number;
    }>(config, 'GET', `/admin/identities?periodHours=${periodHours}`),
  // per-principal activity timeline (newest first). Optional cursor
  // resumes from a prior page (carries only the DynamoDB sort key).
  listPrincipalActivity: (config: BbgConfig, principal: string, limit = 50, cursor?: string) =>
    request<ActivityResponse>(
      config,
      'GET',
      // principal is a QUERY param (not a path segment): its embedded ARN has a
      // `/` that HTTP-API path matching would reject. See api-stack.ts an earlier change.
      `/admin/principal-activity?principal=${encodeURIComponent(principal)}&limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    ),
  // BBG self-service: the signed-in user's OWN activity timeline (redacted).
  // Returns the most recent `limit` events across the caller's keys (merged,
  // newest-first). Not paginated — the caller's history is bounded and a single
  // page is the design; raise `limit` (max 200) rather than adding a cursor.
  myActivity: (config: BbgConfig, limit = 100) =>
    request<ActivityResponse>(config, 'GET', `/me/activity?limit=${limit}`),
  // Central cross-principal activity feed (super-admin only). byDay GSI-backed.
  listActivity: (
    config: BbgConfig,
    opts: { limit?: number; days?: number; type?: string; cursor?: string } = {},
  ) => {
    const p = new URLSearchParams();
    p.set('limit', String(opts.limit ?? 50));
    p.set('days', String(opts.days ?? 7));
    if (opts.type) p.set('type', opts.type);
    if (opts.cursor) p.set('cursor', opts.cursor);
    return request<ActivityResponse>(config, 'GET', `/admin/activity?${p.toString()}`);
  },
  // pre-onboarding readiness audit (async start/poll, like reports).
  startReadiness: (config: BbgConfig) =>
    request<{ jobId: string; state: string }>(config, 'POST', '/admin/readiness'),
  pollReadiness: (config: BbgConfig, jobId: string) =>
    request<{
      jobId: string;
      state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NOT_FOUND';
      scope?: 'account' | 'org';
      accountId?: string;
      error?: string;
      findings?: ReadinessFindings;
      orgFindings?: ReadinessOrgFindings;
      setupScript?: string;
      startedAt?: string;
      completedAt?: string;
    }>(config, 'GET', `/admin/readiness/${encodeURIComponent(jobId)}`),
  listInferenceProfiles: (config: BbgConfig) =>
    request<{ items: Array<Record<string, unknown>> }>(config, 'GET', '/admin/inference-profiles'),
  // Bedrock-supported region list, derived dynamically from AWS public
  // global-infrastructure SSM params (with a static fallback server-side).
  listRegions: (config: BbgConfig) =>
    request<{ regions: string[] }>(config, 'GET', '/admin/regions'),
  listAgentSessions: (config: BbgConfig) =>
    request<{ items: Array<Record<string, unknown>> }>(config, 'GET', '/admin/agent-sessions'),
  startReport: (config: BbgConfig, template: string, params?: Record<string, string>) =>
    request<{ executionId: string; sql: string }>(config, 'POST', '/admin/reports/query', { template, params }),
  pollReport: (config: BbgConfig, executionId: string) =>
    request<{
      state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
      error?: string;
      columns?: string[];
      rows?: Array<Record<string, string | undefined>>;
    }>(config, 'GET', `/admin/reports/${encodeURIComponent(executionId)}`),
  listAdminUsers: (config: BbgConfig) =>
    request<{
      items: Array<{
        username: string;
        status: string;
        enabled: boolean;
        createdAt?: string;
        lastModifiedAt?: string;
        attributes: Record<string, string>;
        groups: string[];
      }>;
    }>(config, 'GET', '/admin/users'),
  listAdminGroups: (config: BbgConfig) =>
    request<{ items: Array<{ name?: string; description?: string }> }>(config, 'GET', '/admin/users/groups'),
  createAdminUser: (
    config: BbgConfig,
    body: {
      email: string;
      name?: string;
      givenName?: string;
      familyName?: string;
      team?: string;
      iamPrincipal?: string;
      groups?: string[];
      temporaryPassword?: string;
      permanent?: boolean;
      sendInvite?: boolean;
    },
  ) => request<{ username: string; temporaryPassword: string }>(config, 'POST', '/admin/users', body),
  updateAdminUser: (
    config: BbgConfig,
    username: string,
    body: {
      name?: string;
      givenName?: string;
      familyName?: string;
      email?: string;
      team?: string;
      iamPrincipal?: string;
      notify50pct?: boolean;
      notify80pct?: boolean;
      notify100pct?: boolean;
      notifyEnforcement?: boolean;
      notifyAdminWatch?: boolean;
      /** per-user threshold floor; 50/75/80/90/100, or 101 for never. */
      notifyThresholdFloor?: number;
    },
  ) =>
    request<{ username: string; updated: string[] }>(
      config,
      'PUT',
      `/admin/users/${encodeURIComponent(username)}`,
      body,
    ),
  setAdminUserGroups: (config: BbgConfig, username: string, groups: string[]) =>
    request<{ username: string; groups: string[] }>(
      config,
      'PUT',
      `/admin/users/${encodeURIComponent(username)}/groups`,
      { groups },
    ),
  disableAdminUser: (config: BbgConfig, username: string) =>
    request<{ username: string; enabled: boolean }>(
      config,
      'POST',
      `/admin/users/${encodeURIComponent(username)}/disable`,
    ),
  enableAdminUser: (config: BbgConfig, username: string) =>
    request<{ username: string; enabled: boolean }>(
      config,
      'POST',
      `/admin/users/${encodeURIComponent(username)}/enable`,
    ),
  resetAdminUserPassword: (config: BbgConfig, username: string) =>
    request<{ username: string; reset: boolean }>(
      config,
      'POST',
      `/admin/users/${encodeURIComponent(username)}/reset-password`,
    ),
  deleteAdminUser: (config: BbgConfig, username: string) =>
    request<void>(config, 'DELETE', `/admin/users/${encodeURIComponent(username)}`),
  listPricing: (config: BbgConfig) =>
    request<{ items: Array<Record<string, unknown>> }>(config, 'GET', '/admin/pricing/overrides'),
  upsertPricingOverride: (
    config: BbgConfig,
    body: {
      model: string;
      inputPer1k?: number;
      outputPer1k?: number;
      cacheReadPer1k?: number;
      cacheWritePer1k?: number;
      dimensions?: Record<string, { unit: string; pricePerUnit: number; label?: string }>;
      displayName?: string;
      notes?: string;
    },
  ) => request<Record<string, unknown>>(config, 'POST', '/admin/pricing/overrides', body),
  deletePricingOverride: (config: BbgConfig, model: string) =>
    request<void>(config, 'DELETE', `/admin/pricing/override?model=${encodeURIComponent(model)}`),
  // Custom pricing discounts — account / OU / org scopes.
  listPricingDiscounts: (config: BbgConfig) =>
    request<{ items: PricingDiscountRow[] }>(config, 'GET', '/admin/pricing/discounts'),
  upsertPricingDiscount: (
    config: BbgConfig,
    body: { scope: DiscountScope; scopeId: string; discountPct: number; label?: string },
  ) => request<Record<string, unknown>>(config, 'POST', '/admin/pricing/discounts', body),
  deletePricingDiscount: (config: BbgConfig, scope: DiscountScope, scopeId: string) =>
    request<void>(
      config,
      'DELETE',
      `/admin/pricing/discounts?scope=${scope}&scopeId=${encodeURIComponent(scopeId)}`,
    ),
  listPasskeyNicknames: (config: BbgConfig) =>
    request<{ items: Array<{ credentialId: string; nickname: string; updatedAt?: string }> }>(
      config,
      'GET',
      '/me/passkey-nicknames',
    ),
  setPasskeyNickname: (config: BbgConfig, credentialId: string, nickname: string) =>
    request<{ credentialId: string; nickname: string }>(
      config,
      'PUT',
      `/me/passkey-nicknames/${encodeURIComponent(credentialId)}`,
      { nickname },
    ),
  // org enrollment.
  listOrgAccounts: (config: BbgConfig) =>
    request<{
      organizationId?: string;
      masterAccountId?: string;
      // follow-up: home account ID + regions BBG meters in
      // the home account itself (not via cross-account StackSet).
      homeAccountId?: string;
      homeMeteredRegions?: string[];
      rootId: string;
      ous: Array<{ id: string; name: string; parentId: string }>;
      accounts: Array<{
        id: string;
        name: string;
        email?: string;
        status?: string;
        ouId?: string;
        ouName?: string;
      }>;
    }>(config, 'GET', '/admin/org/accounts'),
  getEnrollmentConfig: (config: BbgConfig) =>
    request<{
      // SELF_MANAGED — external accounts requiring per-member bootstrap CFN
      enrolledMemberAccounts: Array<{ accountId: string; regions: string[] }>;
      // SERVICE_MANAGED INTERSECTION — in-Org accounts (no bootstrap)
      enrolledOrgAccounts: Array<{ accountId: string; regions: string[] }>;
      enrolledOus: Array<{ ouId: string; regions: string[] }>;
      // SERVICE_MANAGED DIFFERENCE — whole-org auto-enroll
      enrolledWholeOrg?: { regions: string[]; excludeAccountIds?: string[] };
      // Home-account metered regions (bbg:meteredRegions). undefined =>
      // not set in SSM; the deployed cdk.json/env fallback is authoritative
      // (the UI then shows org.homeMeteredRegions from listOrgAccounts).
      meteredRegions?: string[];
    }>(config, 'GET', '/admin/enrollment/config'),
  // an earlier change/32: OU + whole-org StackSet auto-deployment configuration.
  getEnrollmentAutoDeployment: (config: BbgConfig) =>
    request<{
      ou: {
        stackSetName: string;
        enabled: boolean;
        retainStacksOnAccountRemoval: boolean;
        organizationalUnitIds: string[];
      } | null;
      wholeOrg: {
        stackSetName: string;
        enabled: boolean;
        retainStacksOnAccountRemoval: boolean;
        organizationalUnitIds: string[];
      } | null;
    }>(config, 'GET', '/admin/enrollment/auto-deployment'),
  putEnrollmentConfig: (
    config: BbgConfig,
    body: {
      // SPA passes a single picked-accounts list; the Lambda
      // partitions in-Org vs external server-side. enrolledOus stays
      // explicit because OU IDs and account IDs are distinct shapes.
      enrolledAccounts: Array<{ accountId: string; regions: string[] }>;
      enrolledOus: Array<{ ouId: string; regions: string[] }>;
      // optional whole-org auto-enroll (mutually exclusive with
      // enrolledOus + the in-Org subset of enrolledAccounts).
      enrolledWholeOrg?: { regions: string[]; excludeAccountIds?: string[] };
      // Home-account metered regions (bbg:meteredRegions). Optional —
      // omitted leaves the current home-region config untouched. New
      // regions are CDK-bootstrapped automatically by the pipeline before
      // deploy; the response's bootstrapPending lists them.
      homeMeteredRegions?: string[];
    },
  ) =>
    request<{
      ok: boolean;
      pipelineExecutionId?: string;
      homeMeteredRegions?: string[];
      // Regions the pipeline will auto-bootstrap before deploying (adds
      // ~2 min each). Informational — nothing for the operator to do.
      bootstrapPending?: string[];
      partition?: {
        externalAccounts: string[];
        orgAccounts: string[];
        ous: string[];
      };
    }>(config, 'POST', '/admin/enrollment/config', body),
  getEnrollmentStatus: (config: BbgConfig) =>
    request<{
      instances: Array<{
        account: string;
        region: string;
        status?: string;
        reason?: string;
        // an earlier change/32: which StackSet the instance came from. Lets the
        // SPA distinguish auto-enrolled members (service-managed-ou,
        // service-managed-whole-org) from explicitly-listed accounts
        // (self-managed-external, service-managed-account).
        source:
          | 'self-managed-external'
          | 'service-managed-account'
          | 'service-managed-ou'
          | 'service-managed-whole-org';
      }>;
    }>(config, 'GET', '/admin/enrollment/status'),
  // preflight.
  getEnrollmentPreflight: (config: BbgConfig) =>
    request<{
      organizationId?: string;
      masterAccountId?: string;
      isOrgMaster?: boolean;
      ready: boolean;
      checks: Array<{
        id: string;
        label: string;
        status: 'ok' | 'fail';
        detail?: string;
        fix?: string;
      }>;
    }>(config, 'GET', '/admin/enrollment/preflight'),
  // audit log viewer.
  queryAuditLog: (config: BbgConfig, hours: number) =>
    request<{
      items: Array<Record<string, string>>;
      hours: number;
      logGroups: string[];
    }>(config, 'GET', `/admin/audit?hours=${hours}`),
};
