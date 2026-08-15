import { useCallback, useEffect, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { api, type ActivityItem } from '../api/client';
import { ActivityTable } from '../components/ActivityTable';
import { PrincipalActivityModal } from '../components/PrincipalActivityModal';
import type { BbgConfig } from '../config';

const DAYS_OPTIONS = [
  { label: 'Last 7 days', value: '7' },
  { label: 'Last 14 days', value: '14' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 90 days', value: '90' },
  { label: 'Last 365 days', value: '365' },
];

/**
 * Central cross-principal activity feed (super-admin only). Complements the
 * Admin audit log: audit = which operator changed what (14-day CloudWatch
 * window); this = what happened to any principal (365-day durable store).
 * Clicking a principal opens its full timeline in the modal.
 */
export const AdminActivity = ({ config }: { config: BbgConfig }) => {
  const [days, setDays] = useState('7');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [activityPrincipal, setActivityPrincipal] = useState<string | undefined>();

  const load = useCallback(
    async (d: string, cur?: string) => {
      setLoading(true);
      try {
        const data = await api.listActivity(config, { days: parseInt(d, 10), cursor: cur });
        setItems(data.items);
        setNextCursor(data.cursor);
        setError(undefined);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [config],
  );

  useEffect(() => {
    void load(days, cursor);
  }, [load, days, cursor]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={`(${items.length})`}
          description="What happened to your principals — threshold warnings, enforcement, and the budget/user changes behind them, across all principals. Last 365 days of durable history. Super-admin only. (For 'which operator changed what', see Admin audit.)"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={DAYS_OPTIONS.find((o) => o.value === days) ?? DAYS_OPTIONS[0]}
                options={DAYS_OPTIONS}
                onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                  setCursor(undefined);
                  setDays(e.detail.selectedOption.value!);
                }}
                ariaLabel="Lookback window"
              />
              <Button iconName="refresh" loading={loading} onClick={() => void load(days, cursor)} />
            </SpaceBetween>
          }
        >
          Activity
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && <StatusIndicator type="error">Error: {error}</StatusIndicator>}
        <ActivityTable
          items={items}
          variant="admin"
          loading={loading}
          onPrincipalClick={setActivityPrincipal}
          empty={
            <Box textAlign="center" color="inherit">
              <b>No activity in this window.</b>
              <Box variant="p" color="inherit">
                The central feed covers activity recorded since this feature shipped and fills
                forward. Full per-principal history is available from Identities → Activity.
              </Box>
            </Box>
          }
        />
        {nextCursor && (
          <Box textAlign="center">
            <Button onClick={() => setCursor(nextCursor)} loading={loading}>
              Load more
            </Button>
          </Box>
        )}
      </SpaceBetween>
      {activityPrincipal && (
        <PrincipalActivityModal
          config={config}
          principal={activityPrincipal}
          onDismiss={() => setActivityPrincipal(undefined)}
        />
      )}
    </ContentLayout>
  );
};
