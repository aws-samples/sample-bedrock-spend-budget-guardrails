import { useEffect, useMemo, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import { BarChart, LineChart } from '@cloudscape-design/components';
import { api, type SpendRow } from '../api/client';
import { useScope, formatAccount } from '../auth/scope-context';
import { ModelCell, friendlyModelName, parseTarget } from '../components/Model';
import { parsePrincipal, PrincipalCell } from '../components/Principal';
import type { BbgConfig } from '../config';

/** Display labels for the per-dimension breakdown chart. */
const DIMENSION_LABEL: Record<string, string> = {
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cacheReadTokens: 'Cache read',
  cacheWriteTokens: 'Cache write',
  outputImages: 'Output images',
  inputVideoSeconds: 'Input video (s)',
  outputVideoSeconds: 'Output video (s)',
  inputAudioSeconds: 'Input audio (s)',
  outputAudioSeconds: 'Output audio (s)',
  searchUnits: 'Search units',
  embedTokens: 'Embed tokens',
};

/** Stable display order so the stacked-bar segments don't reshuffle. */
const DIMENSION_ORDER: string[] = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputImages',
  'inputVideoSeconds',
  'outputVideoSeconds',
  'inputAudioSeconds',
  'outputAudioSeconds',
  'searchUnits',
  'embedTokens',
];

/**
 * Builds the period-selector dropdown. Spend rows are keyed by monthly
 * period (YYYY-MM) on RunningSpend, so this is a contiguous list of months
 * from the current month back to `earliest` (the earliest period that
 * actually has data, fetched from /spend/periods). The selector
 * auto-extends as history accumulates — no hardcoded window. A 12-month
 * minimum keeps the dropdown useful before a year of data exists; if
 * `earliest` is older, every month back to it is offered (gaps included, so
 * a quiet month is still selectable). Newest-first; default = current month.
 */
const periodOptions = (earliest?: string, minMonths = 12): SelectProps.Option[] => {
  const now = new Date();
  // How many months back to span: max(minMonths, distance to `earliest`).
  let monthsBack = minMonths;
  if (earliest && /^\d{4}-\d{2}$/.test(earliest)) {
    const [ey, em] = earliest.split('-').map((n) => parseInt(n, 10));
    const dist = (now.getUTCFullYear() - ey) * 12 + (now.getUTCMonth() - (em - 1)) + 1;
    if (dist > monthsBack) monthsBack = dist;
  }
  const opts: SelectProps.Option[] = [];
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const monthName = d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const label = i === 0 ? `${monthName} (current)` : i === 1 ? `${monthName} (previous)` : monthName;
    opts.push({ value: period, label });
  }
  return opts;
};

const usd = (v: number): string => `$${v.toFixed(4)}`;

/**
 * Derive the AWS account ID from a principal ARN. Account granularity ==
 * principal granularity (a principal belongs to exactly one account), so
 * account is a pure derived dimension — no stored field. Matches both `iam`
 * and `sts` ARNs (federated principals are stored as sts ARNs). Principals
 * that aren't full ARNs (`principal#unknown`, sso-user, agent fallbacks) have
 * no recoverable account and render as "(unknown)" — NOT attributed to the
 * home account. Kept byte-for-byte in step with the server's
 * `accountForDisplay` in lambda/src/api/spend/index.ts (the /spend/trend
 * byAccount split) so this chart, the by-account bar chart, and the tables
 * all agree. NOTE: this is display attribution; the server's
 * `accountFromPrincipal` (authorization-scope logic) is also strict now —
 * iam|sts ARN → account, else undefined, with scope checks failing CLOSED —
 * so non-ARN principals are wildcard-admin-only server-side and render as
 * "(unknown)" here.
 */
const accountFor = (principal: string): string => {
  const m = /arn:aws:(?:iam|sts)::(\d+):/.exec(principal);
  return m ? m[1] : '(unknown)';
};

interface PerModel {
  modelLabel: string;
  spend: number;
}
interface PerPrincipal {
  principal: string;
  principalType: string;
  account: string;
  spend: number;
  enforced: boolean;
}

export const SpendDashboard = ({ config }: { config: BbgConfig }) => {
  const scope = useScope();
  const [rows, setRows] = useState<SpendRow[]>([]);
  const [trend, setTrend] = useState<
    Array<{ period: string; totalUsd: number; byAccount?: Record<string, number> }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  // Earliest recorded period drives how far back the selector extends.
  // Starts undefined (12-month default) and widens once /spend/periods
  // resolves. Re-derived whenever scope changes (admin account switch).
  const [earliest, setEarliest] = useState<string | undefined>();
  const periods = useMemo(() => periodOptions(earliest), [earliest]);
  const [period, setPeriod] = useState<SelectProps.Option>(periodOptions()[0]);
  // Off by default: each invocation writes one model row and one
  // identical profile row. Most admins want the canonical (model)
  // view; profile rows are revealed for budget-on-profile scenarios.
  const [showProfileRows, setShowProfileRows] = useState(false);

  // Period-scoped fetch: spend rows for the selected month.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const data = await api.listSpend(config, period.value);
        if (!cancelled) {
          setRows(data.items);
          setError(undefined);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, period.value]);

  // Trend fetch: 6-month total. Independent of the period selector
  // (the trend chart shows recent history regardless of which month
  // the rest of the page is focused on).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.listSpendTrend(config, 6);
        if (!cancelled) setTrend(data.items);
      } catch {
        // Trend is optional; silently skip if it errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  // Period range: fetch the distinct periods that actually have data so the
  // selector auto-extends back to the earliest recorded month. Best-effort —
  // on error the 12-month default still applies. Re-runs on account switch
  // (scope filters the periods server-side).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.listSpendPeriods(config);
        // Response is newest-first; the earliest is the last element.
        const oldest = data.periods.at(-1);
        if (!cancelled && oldest) setEarliest(oldest);
      } catch {
        // Best-effort — keep the 12-month default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, scope.currentAccount]);

  // Derive aggregates. The meter writes BOTH a `target=model#<id>` row
  // AND a `target=profile#<arn>` row for every invocation through an
  // inference profile (so admins can budget on either grain). Aggregates
  // here only sum the model rows to avoid double-counting; profile rows
  // still appear in the per-row table below for budget visibility.
  const {
    totalSpend,
    byModel,
    byPrincipal,
    byModelByDimension,
    dimensionsUsed,
    byRegion,
    byAccount,
  } = useMemo(() => {
    let total = 0;
    const modelTotals = new Map<string, number>();
    const principalTotals = new Map<string, PerPrincipal>();
    // model → dimension → cost (USD)
    const modelDimTotals = new Map<string, Map<string, number>>();
    // region → cost (USD). an earlier change: per-source-region attribution.
    const regionTotals = new Map<string, number>();
    // accountId → cost (USD). an earlier change: per-account aggregation for
    // wildcard admins viewing multi-account spend.
    const accountTotals = new Map<string, number>();

    // Account filter: when the top-nav account selector is set to a
    // specific account (not '' / '*' = all), restrict every aggregate,
    // chart, and table to that account. Server-side scope already enforces
    // authorization; this is a client-side view narrowing for wildcard
    // admins who want to focus on one account.
    const acctFilter = scope.currentAccount;
    const acctFilterActive = !!acctFilter && acctFilter !== '*';

    for (const row of rows) {
      // identity-lens rows (principal#sso-user# / #sourceIdentity#)
      // are the per-identity view of a role's spend — the SAME dollars as
      // the primary role row. Exclude them from EVERY aggregate (totals,
      // byModel, byPrincipal, byRegion, byAccount, byDimension) so nothing
      // double-counts. They're still shown in the per-row table below.
      if (row.identityLens) continue;
      if (acctFilterActive && accountFor(row.principal) !== acctFilter) continue;
      const target = row.target ?? row.sk;
      const t = parseTarget(target);
      // Skip profile rows in totals — the matching model row already
      // accounts for the same spend.
      if (t.kind !== 'model') {
        // We still record `enforced` from profile rows so the principal
        // chip lights up if a profile-level deny is active.
        const existing = principalTotals.get(row.principal);
        if (existing && row.enforced) existing.enforced = true;
        continue;
      }
      total += row.spendUsd;
      const modelLabel = friendlyModelName(t.display);

      modelTotals.set(modelLabel, (modelTotals.get(modelLabel) ?? 0) + row.spendUsd);

      const existing = principalTotals.get(row.principal);
      const parsed = parsePrincipal(row.principal);
      principalTotals.set(row.principal, {
        principal: row.principal,
        principalType: existing?.principalType ?? parsed.type,
        account: existing?.account ?? accountFor(row.principal),
        spend: (existing?.spend ?? 0) + row.spendUsd,
        enforced: (existing?.enforced ?? false) || row.enforced,
      });

      // per-region totals. Legacy rows (pre-region-attribution)
      // have no `regions` map; fall back to bucketing their spend under
      // "(unattributed)" so the operator can see how much spend predates
      // multi-region.
      const regions = row.regions ?? {};
      const regionSum = Object.values(regions).reduce((a, b) => a + b, 0);
      if (regionSum > 0) {
        for (const [code, amount] of Object.entries(regions)) {
          regionTotals.set(code, (regionTotals.get(code) ?? 0) + amount);
        }
      } else if (row.spendUsd > 0) {
        regionTotals.set('(unattributed)', (regionTotals.get('(unattributed)') ?? 0) + row.spendUsd);
      }

      // per-account totals. Account ID is derived from the
      // principal ARN segment. Same-account rows aggregate under the
      // home account; member-account rows surface separately.
      const acct = accountFor(row.principal);
      accountTotals.set(acct, (accountTotals.get(acct) ?? 0) + row.spendUsd);

      // Multi-dim breakdown — sum each dim cost contribution under the
      // model. Falls back to inputTokens+outputTokens-style guess for
      // legacy rows that don't carry dimCost (we approximate evenly so
      // the chart isn't blank for old data).
      if (!modelDimTotals.has(modelLabel)) modelDimTotals.set(modelLabel, new Map());
      const inner = modelDimTotals.get(modelLabel)!;
      const dimCost = row.dimCost ?? {};
      const knownSum = Object.values(dimCost).reduce((a, b) => a + b, 0);
      if (knownSum > 0) {
        for (const [k, v] of Object.entries(dimCost)) {
          inner.set(k, (inner.get(k) ?? 0) + v);
        }
      } else if (row.spendUsd > 0) {
        // Legacy row with no dim breakdown — bucket the whole spend as
        // "outputTokens" so the chart still renders something useful.
        inner.set('outputTokens', (inner.get('outputTokens') ?? 0) + row.spendUsd);
      }
    }

    const byModel: PerModel[] = [...modelTotals.entries()]
      .map(([modelLabel, spend]) => ({ modelLabel, spend }))
      .sort((a, b) => b.spend - a.spend);
    const byPrincipal: PerPrincipal[] = [...principalTotals.values()].sort((a, b) => b.spend - a.spend);

    // Build the {model → {dim → usd}} structure the stacked chart consumes,
    // and the union of dimensions actually present so we don't render
    // empty series.
    const dimensionsUsed = new Set<string>();
    for (const dims of modelDimTotals.values()) {
      for (const k of dims.keys()) dimensionsUsed.add(k);
    }
    const byModelByDimension = byModel.map(({ modelLabel }) => {
      const inner = modelDimTotals.get(modelLabel) ?? new Map<string, number>();
      const costsByDim: Record<string, number> = {};
      for (const k of dimensionsUsed) costsByDim[k] = inner.get(k) ?? 0;
      return { modelLabel, costsByDim };
    });

    const byRegion = [...regionTotals.entries()]
      .map(([region, spend]) => ({ region, spend }))
      .sort((a, b) => b.spend - a.spend);

    const byAccount = [...accountTotals.entries()]
      .map(([account, spend]) => ({ account, spend }))
      .sort((a, b) => b.spend - a.spend);

    return {
      totalSpend: total,
      byModel,
      byPrincipal,
      byModelByDimension,
      dimensionsUsed,
      byRegion,
      byAccount,
    };
  }, [rows, scope.currentAccount]);

  // Per-row table honors the same account filter as the aggregates above,
  // so the table never shows rows the charts/KPIs excluded.
  const perRowItems = useMemo(() => {
    const acctFilter = scope.currentAccount;
    if (!acctFilter || acctFilter === '*') return rows;
    return rows.filter((r) => accountFor(r.principal) === acctFilter);
  }, [rows, scope.currentAccount]);

  // Trend series: one line per account when the trend spans 2+ accounts
  // (and no single-account filter is active), else a single total line.
  // `byAccount` is additive on the API response — an older backend that
  // omits it collapses cleanly to the single total line.
  const trendSeries = useMemo(() => {
    const acctFilter = scope.currentAccount;
    const filterActive = !!acctFilter && acctFilter !== '*';
    const accounts = new Set<string>();
    for (const t of trend) for (const a of Object.keys(t.byAccount ?? {})) accounts.add(a);

    // Single line: no per-account data, or an account filter pins one account.
    if (accounts.size <= 1 || filterActive) {
      // When filtered, prefer this account's byAccount contribution; but if
      // the backend didn't send byAccount at all (deploy skew / older API),
      // fall back to totalUsd — which the server already scope-filtered for
      // non-wildcard admins — instead of a flat $0 line.
      const pick = (t: (typeof trend)[number]): number =>
        filterActive && t.byAccount ? (t.byAccount[acctFilter] ?? 0) : t.totalUsd;
      return [
        {
          title: filterActive
            ? `Spend — ${formatAccount(acctFilter, scope.accountNames)} ($)`
            : 'Total spend ($)',
          type: 'line' as const,
          data: trend.map((t) => ({ x: t.period, y: Number(pick(t).toFixed(6)) })),
          valueFormatter: (n: number) => `$${n.toFixed(2)}`,
        },
      ];
    }
    // Multi-account: one line per account, sorted by total contribution.
    const totalByAcct = new Map<string, number>();
    for (const t of trend)
      for (const [a, v] of Object.entries(t.byAccount ?? {}))
        totalByAcct.set(a, (totalByAcct.get(a) ?? 0) + v);
    const ordered = [...totalByAcct.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
    return ordered.map((acct) => ({
      title: acct === '(unknown)' ? '(unknown)' : formatAccount(acct, scope.accountNames),
      type: 'line' as const,
      data: trend.map((t) => ({ x: t.period, y: Number((t.byAccount?.[acct] ?? 0).toFixed(6)) })),
      valueFormatter: (n: number) => `$${n.toFixed(2)}`,
    }));
  }, [trend, scope.currentAccount, scope.accountNames]);

  if (loading) {
    return (
      <ContentLayout header={<Header variant="h1">Spend dashboard</Header>}>
        <Box textAlign="center" padding="xxl">
          <SpaceBetween size="m">
            <Spinner size="big" />
            <Box>Loading spend…</Box>
          </SpaceBetween>
        </Box>
      </ContentLayout>
    );
  }

  if (error) {
    return (
      <ContentLayout header={<Header variant="h1">Spend dashboard</Header>}>
        <Box>
          <StatusIndicator type="error">Failed to load spend</StatusIndicator>
          <Box variant="code" padding="s">
            {error}
          </Box>
        </Box>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Real-time per-IAM-principal × per-model Bedrock spend, joined from Bedrock invocation logs and CloudTrail data events."
          actions={
            <Select
              selectedOption={period}
              onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => setPeriod(e.detail.selectedOption)}
              options={periods}
              ariaLabel="Period"
              expandToViewport
            />
          }
        >
          Spend dashboard
        </Header>
      }
    >
      <SpaceBetween size="l">
        <KeyValuePairs
          columns={4}
          items={[
            { label: `Total spend (${period.label})`, value: usd(totalSpend) },
            { label: 'Distinct principals', value: byPrincipal.length },
            { label: 'Distinct models', value: byModel.length },
            {
              label: 'Active enforcement',
              value: byPrincipal.filter((p) => p.enforced).length,
            },
          ]}
        />

        {/* Trend: 6-month total spend. Anchors the dashboard with
            "is spend going up or down?" without needing the user to
            cycle through the period selector. */}
        {trend.length > 0 && (
          <LineChart
            series={trendSeries}
            xScaleType="categorical"
            xDomain={trend.map((t) => t.period)}
            // Scale to the tallest plotted series, not the unfiltered total —
            // otherwise a single filtered/small account's line hugs the axis.
            yDomain={[
              0,
              Math.max(0.01, ...trendSeries.flatMap((s) => s.data.map((d) => d.y))) * 1.2,
            ]}
            xTitle="Month"
            yTitle="USD"
            ariaLabel="Spend trend, last 6 months"
            height={220}
            statusType="finished"
            // Single series → hide the series filter; multi-account → show it
            // so admins can isolate one account's line.
            hideFilter={trendSeries.length <= 1}
            empty="No spend in the last 6 months"
          />
        )}

        {/* Top spenders horizontal bar — one bar per principal. The
            most useful single chart on the page: who is spending what,
            sorted descending. Single series, so series-filter dropdown
            is hidden. */}
        {byPrincipal.length > 0 && (
          <BarChart
            horizontalBars
            series={[
              {
                title: 'Spend ($)',
                type: 'bar',
                data: byPrincipal.map((p) => ({
                  x: parsePrincipal(p.principal).display,
                  y: Number(p.spend.toFixed(6)),
                })),
                valueFormatter: (n: number) => `$${n.toFixed(4)}`,
              },
            ]}
            xDomain={byPrincipal.map((p) => parsePrincipal(p.principal).display)}
            yDomain={[0, Math.max(0.0001, ...byPrincipal.map((p) => p.spend)) * 1.2]}
            xTitle="Principal"
            yTitle="USD"
            ariaLabel="Top spenders by principal"
            height={Math.max(180, 60 + byPrincipal.length * 32)}
            statusType="finished"
            hideFilter
            empty="No principal spend yet"
          />
        )}

        {/* Per-model dimension breakdown — stacked bar that splits each
            model's spend across the dimensions it actually billed on
            (input tokens, output tokens, cache, images, etc.). Surfaces
            "Opus 4.7 was 80% output tokens" insight. Series filter IS
            useful here so admins can zoom on a single dimension. */}
        {byModelByDimension.length > 0 && dimensionsUsed.size > 0 && (
          <BarChart
            stackedBars
            series={DIMENSION_ORDER.filter((k) => dimensionsUsed.has(k)).map((kind) => ({
              title: DIMENSION_LABEL[kind] ?? kind,
              type: 'bar' as const,
              data: byModelByDimension.map((m) => ({
                x: m.modelLabel,
                y: Number((m.costsByDim[kind] ?? 0).toFixed(6)),
              })),
              valueFormatter: (n: number) => `$${n.toFixed(4)}`,
            }))}
            xDomain={byModelByDimension.map((m) => m.modelLabel)}
            yDomain={[
              0,
              Math.max(
                0.0001,
                ...byModelByDimension.map((m) =>
                  Object.values(m.costsByDim).reduce((a, b) => a + b, 0),
                ),
              ) * 1.2,
            ]}
            xTitle="Model"
            yTitle="USD"
            ariaLabel="Per-model spend, broken down by pricing dimension"
            height={300}
            statusType="finished"
            empty="No model spend with dimension data"
          />
        )}

        {/* Spend by source region. Useful for spotting which
            metered region drives spend (e.g. a CRIS profile in
            us-east-1 hammering an Opus model). Hidden when there's
            only one region's worth of data — keeps the dashboard
            uncluttered for single-region operators. */}
        {byRegion.length > 1 && (
          <BarChart
            horizontalBars
            series={[
              {
                title: 'Spend by region (USD)',
                type: 'bar',
                data: byRegion.map((r) => ({ x: r.region, y: Number(r.spend.toFixed(6)) })),
                valueFormatter: (n: number) => `$${n.toFixed(4)}`,
              },
            ]}
            xDomain={byRegion.map((r) => r.region)}
            yDomain={[0, Math.max(0.0001, ...byRegion.map((r) => r.spend)) * 1.2]}
            xTitle="Region"
            yTitle="USD"
            ariaLabel="Spend by source AWS region"
            height={Math.max(180, byRegion.length * 40)}
            statusType="finished"
            hideFilter
            empty="No region attribution yet"
          />
        )}

        {/* Spend by account. Visible only when 2+ accounts
            appear (i.e. multi-account install with cross-account
            ingest from an earlier change). Single-account installs and per-
            account-scoped admins (whose API response is filtered
            server-side) only ever see one account, so this stays
            hidden for them. */}
        {byAccount.length > 1 && (
          <BarChart
            horizontalBars
            series={[
              {
                title: 'Spend by account (USD)',
                type: 'bar',
                data: byAccount.map((a) => ({
                  x: formatAccount(a.account, scope.accountNames),
                  y: Number(a.spend.toFixed(6)),
                })),
                valueFormatter: (n: number) => `$${n.toFixed(4)}`,
              },
            ]}
            xDomain={byAccount.map((a) => formatAccount(a.account, scope.accountNames))}
            yDomain={[0, Math.max(0.0001, ...byAccount.map((a) => a.spend)) * 1.2]}
            xTitle="Account"
            yTitle="USD"
            ariaLabel="Spend by AWS account"
            height={Math.max(180, byAccount.length * 40)}
            statusType="finished"
            hideFilter
            empty="No multi-account spend yet"
          />
        )}

        <Table
          items={byPrincipal}
          variant="container"
          header={<Header variant="h2" counter={`(${byPrincipal.length})`}>Top spenders</Header>}
          columnDefinitions={[
            {
              id: 'principal',
              header: 'Principal',
              cell: (r) => <PrincipalCell principal={r.principal} principalType={r.principalType} />,
            },
            {
              id: 'account',
              header: 'Account',
              cell: (r) =>
                r.account === '(unknown)' ? (
                  <Box color="text-status-inactive">(unknown)</Box>
                ) : (
                  formatAccount(r.account, scope.accountNames)
                ),
            },
            {
              id: 'spend',
              header: 'Spend',
              cell: (r) => usd(r.spend),
              sortingField: 'spend',
            },
            {
              id: 'enforced',
              header: 'Status',
              cell: (r) =>
                r.enforced ? (
                  <StatusIndicator type="error">Enforced (denied)</StatusIndicator>
                ) : (
                  <StatusIndicator type="success">Active</StatusIndicator>
                ),
            },
          ]}
          empty={
            <Box textAlign="center" color="inherit">
              <b>No spend yet</b>
              <Box variant="p" color="inherit">
                Run <code>npm run loadgen -- --as alice --model us.anthropic.claude-haiku-4-5-20251001-v1:0 --rps 5 --duration 60s</code> to generate traffic.
              </Box>
            </Box>
          }
        />

        {/* Per-row spend. The meter writes BOTH a model-target row and
            a profile-target row per invocation (two budgeting lenses on
            the same money). Default view hides the profile rows so the
            common case is uncluttered; toggle the checkbox to see them. */}
        <Table
          items={
            showProfileRows
              ? perRowItems
              : perRowItems.filter((r) => parseTarget(r.target ?? r.sk).kind !== 'profile')
          }
          variant="container"
          header={
            <Header
              variant="h2"
              counter={`(${
                showProfileRows
                  ? perRowItems.length
                  : perRowItems.filter((r) => parseTarget(r.target ?? r.sk).kind !== 'profile').length
              })`}
              actions={
                <Toggle
                  checked={showProfileRows}
                  onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setShowProfileRows(e.detail.checked)}
                >
                  Show profile rows
                </Toggle>
              }
              description="Each invocation through an inference profile produces a model row and a parallel profile row in DDB so admins can budget on either grain. The model rows alone account for total spend; the profile rows are duplicates of the same money for budget visibility."
            >
              Per-row spend
            </Header>
          }
          columnDefinitions={[
            {
              id: 'principal',
              header: 'Principal',
              cell: (r) => <PrincipalCell principal={r.principal} />,
            },
            {
              id: 'account',
              header: 'Account',
              cell: (r) => {
                const acct = accountFor(r.principal);
                return acct === '(unknown)' ? (
                  <Box color="text-status-inactive">(unknown)</Box>
                ) : (
                  formatAccount(acct, scope.accountNames)
                );
              },
            },
            {
              id: 'target',
              header: 'Target',
              cell: (r) => <ModelCell target={r.target ?? r.sk} />,
            },
            { id: 'spend', header: 'Spend', cell: (r) => usd(r.spendUsd) },
            { id: 'tokens', header: 'Tokens (in / out)', cell: (r) => `${r.inputTokens.toLocaleString()} / ${r.outputTokens.toLocaleString()}` },
            {
              id: 'regions',
              header: 'Regions',
              cell: (r) => {
                const regions = r.regions ?? {};
                const codes = Object.keys(regions).sort();
                if (codes.length === 0) return <Badge color="grey">—</Badge>;
                return (
                  <SpaceBetween size="xxs" direction="horizontal">
                    {codes.map((code) => (
                      <Badge key={code} color="blue">
                        {code}
                      </Badge>
                    ))}
                  </SpaceBetween>
                );
              },
            },
            {
              id: 'enforced',
              header: 'Enforcement',
              cell: (r) =>
                r.enforced ? (
                  <StatusIndicator type="error">Enforced</StatusIndicator>
                ) : (
                  <StatusIndicator type="success">OK</StatusIndicator>
                ),
            },
          ]}
          empty="No invocations yet"
        />
      </SpaceBetween>
    </ContentLayout>
  );
};
