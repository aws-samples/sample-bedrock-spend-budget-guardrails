import { useEffect, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { BarChart, LineChart } from '@cloudscape-design/components';
import { api } from '../api/client';
import { friendlyModelName } from '../components/Model';
import { parsePrincipal } from '../components/Principal';
import type { BbgConfig } from '../config';

interface PresetOption {
  value: string;
  label: string;
  description: string;
  /** Optional viz hint: bar, line, table. */
  viz: 'bar' | 'line' | 'table';
  /** Column key for the X axis when viz=bar/line. */
  xKey?: string;
  /** Column key for the Y axis. */
  yKey?: string;
  /** When true, the timeframe selector applies to this preset. */
  timeframed?: boolean;
}

const PRESETS: PresetOption[] = [
  {
    value: 'topSpenders',
    label: 'Top spenders',
    description: 'SUM(spend) by principal (model rows only, so profile users are not double-counted).',
    viz: 'bar',
    xKey: 'principal',
    yKey: 'spendusd',
    timeframed: true,
  },
  {
    value: 'spendByModel',
    label: 'Spend by model',
    description: 'SUM(spend) grouped by model id (excludes inference profile rows).',
    viz: 'bar',
    xKey: 'model',
    yKey: 'spendusd',
    timeframed: true,
  },
  {
    value: 'dailyTrend',
    label: 'Daily spend trend',
    description: 'Total spend per UTC day across the selected timeframe.',
    viz: 'line',
    xKey: 'day',
    yKey: 'spendusd',
    timeframed: true,
  },
  {
    value: 'hourlyToday',
    label: 'Hourly cost today',
    description: 'Total spend per hour, UTC, today only (ignores timeframe).',
    viz: 'line',
    xKey: 'hour',
    yKey: 'spendusd',
  },
  {
    value: 'perPrincipalPerModel',
    label: 'Per-principal × per-model breakdown',
    description: 'Top 100 (principal, model) pairs by spend (model rows only).',
    viz: 'table',
    timeframed: true,
  },
  {
    value: 'spendByRegion',
    label: 'Spend by region',
    description: 'SUM(spend) by source AWS region across the selected timeframe.',
    viz: 'bar',
    xKey: 'region',
    yKey: 'spendusd',
    timeframed: true,
  },
  {
    value: 'spendByAccount',
    label: 'Spend by account',
    description: 'SUM(spend) by AWS account of the calling principal ("(unknown)" for non-ARN principals).',
    viz: 'bar',
    xKey: 'account',
    yKey: 'spendusd',
    timeframed: true,
  },
  {
    value: 'enforcement',
    label: 'Enforcement activity',
    description: 'Principals that hit a deny while enforced, with trigger reason (usd/rpm/tpm).',
    viz: 'table',
    timeframed: true,
  },
];

/** Timeframe options — values mirror the server-side `TIMEFRAMES` enum. */
interface TimeframeOption {
  value: string;
  label: string;
}

const TIMEFRAMES: TimeframeOption[] = [
  { value: 'today', label: 'Today' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'last7d', label: 'Last 7 days' },
  { value: 'last30d', label: 'Last 30 days' },
  { value: 'last90d', label: 'Last 90 days' },
];

const usd = (v: string | undefined) => (v ? `$${Number(v).toFixed(4)}` : '$0.00');

export const Reports = ({ config }: { config: BbgConfig }) => {
  const [preset, setPreset] = useState<PresetOption>(PRESETS[0]);
  // Default to "this month"; only passed to the backend for timeframed presets.
  const [timeframe, setTimeframe] = useState<TimeframeOption>(
    TIMEFRAMES.find((t) => t.value === 'thisMonth') ?? TIMEFRAMES[0],
  );
  const [executionId, setExecutionId] = useState<string | undefined>();
  const [sql, setSql] = useState<string | undefined>();
  const [state, setState] = useState<string | undefined>();
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, string | undefined>>>([]);
  const [error, setError] = useState<string | undefined>();
  const [running, setRunning] = useState(false);

  const runQuery = async () => {
    setRunning(true);
    setError(undefined);
    setRows([]);
    setColumns([]);
    setState(undefined);
    try {
      // Only timeframed presets honour the selector; hourlyToday ignores it.
      const params = preset.timeframed ? { timeframe: timeframe.value } : undefined;
      const r = await api.startReport(config, preset.value, params);
      setExecutionId(r.executionId);
      setSql(r.sql.trim());
    } catch (err) {
      setError((err as Error).message);
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!executionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.pollReport(config, executionId);
        if (cancelled) return;
        setState(r.state);
        if (r.state === 'QUEUED' || r.state === 'RUNNING') {
          timer = setTimeout(() => void poll(), 1500);
          return;
        }
        if (r.state === 'FAILED' || r.state === 'CANCELLED') {
          setError(r.error ?? `Query ${r.state}`);
          setRunning(false);
          return;
        }
        setColumns(r.columns ?? []);
        setRows(r.rows ?? []);
        setRunning(false);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setRunning(false);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer!);
    };
  }, [executionId, config]);

  const renderViz = () => {
    if (!rows.length || !columns.length) return null;
    if (preset.viz === 'table' || !preset.xKey || !preset.yKey) {
      return (
        <Table
          variant="container"
          items={rows}
          columnDefinitions={columns.map((c) => ({
            id: c,
            header: c,
            cell: (r: Record<string, string | undefined>) =>
              c.toLowerCase().includes('spend') || c.toLowerCase().includes('cost') ? usd(r[c]) : r[c] ?? '—',
          }))}
        />
      );
    }
    const x = preset.xKey;
    const y = preset.yKey;
    const data = rows.map((row) => {
      const xVal = row[x] ?? '';
      const display =
        x === 'principal'
          ? parsePrincipal(xVal).display
          : x === 'model'
          ? friendlyModelName(xVal)
          : xVal;
      return { x: display, y: Number(row[y] ?? '0') };
    });
    if (preset.viz === 'bar') {
      return (
        <BarChart
          series={[{ title: y, type: 'bar', data: data.map((d) => ({ x: d.x, y: Number(d.y.toFixed(6)) })) }]}
          xDomain={data.map((d) => d.x)}
          yDomain={[0, Math.max(0.0001, ...data.map((d) => d.y)) * 1.2]}
          xTitle={x}
          yTitle={y === 'spendusd' ? 'USD' : y}
          ariaLabel={preset.label}
          height={320}
        />
      );
    }
    // line
    const linePoints = data.map((d) => ({ x: new Date(d.x), y: d.y }));
    return (
      <LineChart
        series={[{ title: y, type: 'line', data: linePoints }]}
        xScaleType="time"
        xTitle={x}
        yTitle={y === 'spendusd' ? 'USD' : y}
        ariaLabel={preset.label}
        height={320}
      />
    );
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Athena queries against the JSONL ledger of every metered invocation. Pick a preset and run."
        >
          Reports
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container>
          <SpaceBetween size="m">
            <SpaceBetween size="xs" direction="horizontal">
              <Select
                selectedOption={{ value: preset.value, label: preset.label, description: preset.description }}
                options={PRESETS.map((p) => ({ value: p.value, label: p.label, description: p.description }))}
                onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                  const found = PRESETS.find((p) => p.value === e.detail.selectedOption.value);
                  if (found) setPreset(found);
                  setRows([]);
                  setColumns([]);
                  setExecutionId(undefined);
                  setError(undefined);
                  setState(undefined);
                }}
              />
              <Select
                selectedOption={timeframe}
                options={TIMEFRAMES}
                disabled={!preset.timeframed}
                onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                  const found = TIMEFRAMES.find((t) => t.value === e.detail.selectedOption.value);
                  if (found) setTimeframe(found);
                }}
              />
              <Button variant="primary" onClick={() => void runQuery()} loading={running}>
                Run query
              </Button>
            </SpaceBetween>
            <Box variant="small" color="text-status-inactive">
              {preset.description}
            </Box>
          </SpaceBetween>
        </Container>

        {sql && (
          <Container header={<Header variant="h3">SQL</Header>}>
            <Box variant="code">
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{sql}</pre>
            </Box>
          </Container>
        )}

        {state && state !== 'SUCCEEDED' && (
          <Box>
            {error ? (
              <StatusIndicator type="error">{error}</StatusIndicator>
            ) : (
              <SpaceBetween size="xs" direction="horizontal">
                <Spinner />
                <Box>Athena {state.toLowerCase()}…</Box>
              </SpaceBetween>
            )}
          </Box>
        )}

        {state === 'SUCCEEDED' && rows.length === 0 && <Box color="text-status-inactive">No rows.</Box>}
        {state === 'SUCCEEDED' && renderViz()}

        {state === 'SUCCEEDED' && rows.length > 0 && preset.viz !== 'table' && (
          <Container header={<Header variant="h3">Raw rows</Header>}>
            <Table
              variant="embedded"
              items={rows}
              columnDefinitions={columns.map((c) => ({
                id: c,
                header: c,
                cell: (r: Record<string, string | undefined>) =>
                  c.toLowerCase().includes('spend') || c.toLowerCase().includes('cost') ? usd(r[c]) : r[c] ?? '—',
              }))}
            />
          </Container>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
};
