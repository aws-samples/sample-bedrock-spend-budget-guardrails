import { useEffect, useMemo, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import { BarChart, LineChart } from '@cloudscape-design/components';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import { api, type BudgetRow, type SpendRow } from '../api/client';
import { friendlyModelName, ModelCell, parseTarget } from '../components/Model';
import type { BbgConfig } from '../config';

const usd = (v: number): string => `$${v.toFixed(4)}`;

/**
 * Period dropdown — contiguous months from now back to `earliest` (the
 * earliest period that has data, fetched from /me/spend/periods), so the
 * selector auto-extends as history accumulates. 12-month minimum before a
 * year of data exists. Newest-first, default current.
 */
const periodOptions = (earliest?: string, minMonths = 12): SelectProps.Option[] => {
  const now = new Date();
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

/** Display labels for the dimension breakdown chart — same as SpendDashboard. */
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

interface PerModelDim {
  modelLabel: string;
  costsByDim: Record<string, number>;
}

const SpendView = ({ config }: { config: BbgConfig }) => {
  const [rows, setRows] = useState<SpendRow[]>([]);
  const [trend, setTrend] = useState<Array<{ period: string; totalUsd: number }>>([]);
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [unmapped, setUnmapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [earliest, setEarliest] = useState<string | undefined>();
  const periods = useMemo(() => periodOptions(earliest), [earliest]);
  const [period, setPeriod] = useState<SelectProps.Option>(periodOptions()[0]);
  const [showProfileRows, setShowProfileRows] = useState(false);

  // Auto-extend the selector back to the earliest recorded month.
  // Best-effort: on error the 12-month default applies.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.mySpendPeriods(config);
        const oldest = data.periods.at(-1);
        if (!cancelled && oldest) setEarliest(oldest);
      } catch {
        // keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  // Period-scoped fetch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const data = await api.mySpend(config, period.value);
        if (cancelled) return;
        setRows(data.items);
        setUnmapped(Boolean(data.unmapped));
        setError(undefined);
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

  // Trend + budgets, period-independent.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [t, b] = await Promise.all([
          api.mySpendTrend(config, 3),
          api.myBudget(config).catch(() => ({ items: [] as BudgetRow[] })),
        ]);
        if (cancelled) return;
        setTrend(t.items);
        setBudgets(b.items);
      } catch {
        // Non-blocking; the period-scoped fetch already handles error state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  // Aggregates: sum only model-target rows so profile rows don't double-count.
  // dimCost map is summed per model so the breakdown chart shows where the
  // user's bill is coming from (input vs output vs cache vs images, etc.).
  const { totalSpend, distinctModels, byModelByDimension, dimensionsUsed, distinctProfiles, regionsUsed } = useMemo(() => {
    let total = 0;
    const modelCount = new Set<string>();
    const profileCount = new Set<string>();
    const regionSet = new Set<string>();
    const modelDimTotals = new Map<string, Map<string, number>>();
    for (const row of rows) {
      // collect every source region that contributed to this user's
      // spend across all rows, regardless of model/profile bookkeeping.
      for (const code of Object.keys(row.regions ?? {})) regionSet.add(code);
      const target = row.target ?? row.sk;
      const t = parseTarget(target);
      if (t.kind === 'profile') {
        profileCount.add(t.display);
        continue;
      }
      if (t.kind !== 'model') continue;
      total += row.spendUsd;
      const modelLabel = friendlyModelName(t.display);
      modelCount.add(modelLabel);
      if (!modelDimTotals.has(modelLabel)) modelDimTotals.set(modelLabel, new Map());
      const inner = modelDimTotals.get(modelLabel)!;
      const dimCost = row.dimCost ?? {};
      const knownSum = Object.values(dimCost).reduce((a, b) => a + b, 0);
      if (knownSum > 0) {
        for (const [k, v] of Object.entries(dimCost)) inner.set(k, (inner.get(k) ?? 0) + v);
      } else if (row.spendUsd > 0) {
        inner.set('outputTokens', (inner.get('outputTokens') ?? 0) + row.spendUsd);
      }
    }
    const dimensionsUsed = new Set<string>();
    for (const dims of modelDimTotals.values()) for (const k of dims.keys()) dimensionsUsed.add(k);
    const byModelByDimension: PerModelDim[] = [...modelDimTotals.entries()]
      .map(([modelLabel, inner]) => {
        const costsByDim: Record<string, number> = {};
        for (const k of dimensionsUsed) costsByDim[k] = inner.get(k) ?? 0;
        return { modelLabel, costsByDim };
      })
      .sort(
        (a, b) =>
          Object.values(b.costsByDim).reduce((x, y) => x + y, 0) -
          Object.values(a.costsByDim).reduce((x, y) => x + y, 0),
      );
    return {
      totalSpend: total,
      distinctModels: modelCount.size,
      distinctProfiles: profileCount.size,
      byModelByDimension,
      dimensionsUsed,
      regionsUsed: [...regionSet].sort(),
    };
  }, [rows]);

  // Tightest enforceable budget: the matching (principal, target) row
  // with the lowest limitUsd. Unlimited budgets are excluded — they
  // never cap spend, so they don't drive the headroom KPI / alert.
  const tightestBudget = useMemo(() => {
    if (budgets.length === 0) return undefined;
    let tightest: BudgetRow | undefined;
    for (const b of budgets) {
      if (!b.enabled) continue;
      if (b.unlimited) continue;
      if (!tightest || b.limitUsd < tightest.limitUsd) tightest = b;
    }
    return tightest;
  }, [budgets]);

  if (loading) {
    return (
      <ContentLayout header={<Header variant="h1">My spend</Header>}>
        <Box textAlign="center" padding="xxxl">
          <SpaceBetween size="m">
            <Spinner size="large" />
            <Box>Loading…</Box>
          </SpaceBetween>
        </Box>
      </ContentLayout>
    );
  }

  if (error) {
    return (
      <ContentLayout header={<Header variant="h1">My spend</Header>}>
        <Box>
          <StatusIndicator type="error">Error: {error}</StatusIndicator>
        </Box>
      </ContentLayout>
    );
  }

  const tableItems = showProfileRows
    ? rows
    : rows.filter((r) => parseTarget(r.target ?? r.sk).kind !== 'profile');
  const headroomPct = tightestBudget
    ? Math.min(100, Math.round((totalSpend / tightestBudget.limitUsd) * 100))
    : undefined;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Your Bedrock spend, scoped to the IAM principal linked to your Cognito profile."
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
          My spend
        </Header>
      }
    >
      <SpaceBetween size="l">
        {unmapped && (
          <Alert type="info" header="No IAM principal linked to your account">
            Your Cognito profile doesn't have a <code>custom:iam_principal</code> attribute set. Set
            it on the My profile page (or ask an admin to set it on Admin → Users) so BBG can scope
            spend to your IAM identity. Until then this page will be empty.
          </Alert>
        )}

        {tightestBudget && headroomPct !== undefined && headroomPct >= 80 && (
          <Alert
            type={headroomPct >= 100 ? 'error' : 'warning'}
            header={
              headroomPct >= 100
                ? 'Budget exceeded'
                : `${headroomPct}% of your tightest budget used`
            }
          >
            {usd(totalSpend)} of {usd(tightestBudget.limitUsd)} (target:{' '}
            {(() => {
              const t = parseTarget(tightestBudget.target);
              return t.kind === 'model' ? friendlyModelName(t.display) : t.display;
            })()}, resets {tightestBudget.window ?? 'monthly'}).{' '}
            {(() => {
              const blockTh = (tightestBudget.thresholds ?? []).find((x) => x.action === 'block');
              const blockAt =
                blockTh?.at ?? (tightestBudget.action === 'deny' ? 100 : undefined);
              if (blockAt !== undefined && headroomPct >= blockAt) {
                return `Enforcement may be active — Bedrock invocations from your principal will be denied until the next ${tightestBudget.window ?? 'monthly'} window.`;
              }
              return null;
            })()}
          </Alert>
        )}

        <KeyValuePairs
          columns={4}
          items={[
            { label: `Total spend (${period.label})`, value: usd(totalSpend) },
            { label: 'Distinct models used', value: distinctModels },
            { label: 'Distinct profiles', value: distinctProfiles },
            {
              label: 'Regions used',
              value:
                regionsUsed.length === 0
                  ? '—'
                  : regionsUsed.length <= 3
                    ? regionsUsed.join(', ')
                    : `${regionsUsed.length} regions`,
            },
            tightestBudget
              ? { label: 'Headroom remaining', value: usd(Math.max(0, tightestBudget.limitUsd - totalSpend)) }
              : { label: 'Active budget', value: 'None' },
          ]}
        />

        {trend.length > 0 && (
          <LineChart
            series={[
              {
                title: 'Total spend ($)',
                type: 'line',
                data: trend.map((t) => ({ x: t.period, y: Number(t.totalUsd.toFixed(6)) })),
                valueFormatter: (n: number) => `$${n.toFixed(2)}`,
              },
            ]}
            xScaleType="categorical"
            xDomain={trend.map((t) => t.period)}
            yDomain={[0, Math.max(0.01, ...trend.map((t) => t.totalUsd)) * 1.2]}
            xTitle="Month"
            yTitle="USD"
            ariaLabel="Your spend trend, last 3 months"
            height={180}
            statusType="finished"
            hideFilter
            empty="No spend in the last 3 months"
          />
        )}

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
                ...byModelByDimension.map((m) => Object.values(m.costsByDim).reduce((a, b) => a + b, 0)),
              ) * 1.2,
            ]}
            xTitle="Model"
            yTitle="USD"
            ariaLabel="Your per-model spend, broken down by pricing dimension"
            height={260}
            statusType="finished"
            empty="No model spend with dimension data"
          />
        )}

        <Table
          loading={loading}
          loadingText="Loading"
          items={tableItems}
          variant="container"
          header={
            <Header
              variant="h2"
              counter={`(${tableItems.length})`}
              actions={
                <Toggle
                  checked={showProfileRows}
                  onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setShowProfileRows(e.detail.checked)}
                >
                  Show profile rows
                </Toggle>
              }
              description="Each invocation through an inference profile produces a model row and a parallel profile row in DDB so admins can budget on either grain. The model rows alone account for total spend; profile rows are duplicates of the same money for budget visibility."
            >
              Per-target spend
            </Header>
          }
          columnDefinitions={[
            {
              id: 'target',
              header: 'Target',
              cell: (r) => <ModelCell target={r.target ?? r.sk} />,
            },
            { id: 'spend', header: 'Spend', cell: (r) => usd(r.spendUsd) },
            {
              id: 'tokens',
              header: 'Tokens (in / out)',
              cell: (r) => `${r.inputTokens.toLocaleString()} / ${r.outputTokens.toLocaleString()}`,
            },
            {
              id: 'regions',
              header: 'Regions',
              cell: (r) => {
                const codes = Object.keys(r.regions ?? {}).sort();
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
              header: 'Status',
              cell: (r) =>
                r.enforced ? (
                  <StatusIndicator type="error">Enforced</StatusIndicator>
                ) : (
                  <StatusIndicator type="success">OK</StatusIndicator>
                ),
            },
          ]}
          empty="No spend in this period yet"
        />
      </SpaceBetween>
    </ContentLayout>
  );
};

const BudgetView = ({ config }: { config: BbgConfig }) => {
  const [budgetRows, setBudgetRows] = useState<BudgetRow[]>([]);
  const [unmapped, setUnmapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.myBudget(config);
        if (!cancelled) {
          setBudgetRows(r.items);
          setUnmapped(Boolean(r.unmapped));
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
  }, [config]);

  if (error) {
    return (
      <ContentLayout header={<Header variant="h1">My budget</Header>}>
        <Box>
          <StatusIndicator type="error">Error: {error}</StatusIndicator>
        </Box>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Your active budgets and remaining headroom.">
          My budget
        </Header>
      }
    >
      <Box margin={{ bottom: 'm' }}>
        {unmapped ? (
          <Alert type="info" header="No IAM principal linked to your account">
            Your Cognito profile doesn't have a <code>custom:iam_principal</code> attribute set, so
            BBG can't tell which Bedrock spend is yours. Ask an admin to link your Cognito user to
            an IAM ARN on the Admin → Users page, then any per-principal budgets they set will show
            up here.
          </Alert>
        ) : !loading && budgetRows.length === 0 ? (
          <Alert type="info" header="No budgets set for you">
            You don't currently have any per-principal budgets configured. Admins can create one on
            the Budgets page targeted at your IAM principal.
          </Alert>
        ) : null}
      </Box>
      {!unmapped && (
        <Table
          loading={loading}
          loadingText="Loading"
          items={budgetRows}
          variant="container"
          columnDefinitions={[
            {
              id: 'target',
              header: 'Target',
              cell: (r) => <ModelCell target={r.target} />,
            },
            {
              id: 'limit',
              header: 'Limit',
              cell: (r) =>
                r.unlimited ? (
                  <StatusIndicator type="info">Unlimited</StatusIndicator>
                ) : (
                  `$${r.limitUsd.toFixed(4)}`
                ),
            },
            {
              id: 'window',
              header: 'Resets',
              cell: (r) => r.window ?? 'monthly',
            },
            {
              id: 'thresholds',
              header: 'Thresholds',
              cell: (r) => {
                const ts = r.thresholds;
                if (!ts || ts.length === 0) {
                  // No explicit ladder — show what the backend will use as
                  // fallback so users aren't left guessing.
                  return r.action === 'alert' ? 'warn @50/80/100' : 'warn @50/80, block @100';
                }
                return ts
                  .map((t) => `${t.action === 'block' ? 'block' : 'warn'} @${t.at}`)
                  .join(', ');
              },
            },
            {
              id: 'source',
              header: 'Source',
              cell: (r) =>
                r.source === 'default' ? (
                  <StatusIndicator type="pending">Default-budget</StatusIndicator>
                ) : (
                  'Manual'
                ),
            },
            {
              id: 'enabled',
              header: 'Enabled',
              cell: (r) =>
                r.enabled ? (
                  <StatusIndicator type="success">Yes</StatusIndicator>
                ) : (
                  <StatusIndicator type="stopped">No</StatusIndicator>
                ),
            },
          ]}
          empty="No budgets set for you"
        />
      )}
    </ContentLayout>
  );
};

export const MyBudget = ({ config, mode }: { config: BbgConfig; mode: 'spend' | 'budget' }) =>
  mode === 'spend' ? <SpendView config={config} /> : <BudgetView config={config} />;
