import { useEffect, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { api } from '../api/client';
import type { BbgConfig } from '../config';

interface AuditLogProps {
  config: BbgConfig;
}

interface AuditRow {
  '@timestamp'?: string;
  action?: string;
  targetAccountId?: string;
  'operator.email'?: string;
  'operator.sub'?: string;
  detail?: string;
}

const HOURS_OPTIONS = [
  { label: 'Last 1 hour', value: '1' },
  { label: 'Last 6 hours', value: '6' },
  { label: 'Last 24 hours', value: '24' },
  { label: 'Last 7 days', value: '168' },
];

export const AuditLog = ({ config }: AuditLogProps) => {
  const [hours, setHours] = useState('24');
  const [items, setItems] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');

  const fetchAudit = async (h: string): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await api.queryAuditLog(config, parseInt(h, 10));
      setItems(r.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAudit(hours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const filtered = filter
    ? items.filter((r) =>
        JSON.stringify(r).toLowerCase().includes(filter.toLowerCase()),
      )
    : items;

  return (
    <Container
      header={
        <Header
          variant="h1"
          description="Cross-account admin writes. Source: CloudWatch Logs Insights queries against the admin Lambda log groups."
          counter={`(${items.length})`}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={
                  HOURS_OPTIONS.find((o) => o.value === hours) ?? HOURS_OPTIONS[2]
                }
                options={HOURS_OPTIONS}
                onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                  const v = e.detail.selectedOption.value!;
                  setHours(v);
                  void fetchAudit(v);
                }}
              />
              <Button
                iconName="refresh"
                onClick={() => void fetchAudit(hours)}
                loading={loading}
              />
            </SpaceBetween>
          }
        >
          Audit log
        </Header>
      }
    >
      <SpaceBetween size="m">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(undefined)}>
            {error}
          </Alert>
        )}

        <TextFilter
          filteringPlaceholder="Filter by action, account, operator..."
          filteringText={filter}
          onChange={(e: NonCancelableCustomEvent<{ filteringText: string }>) => setFilter(e.detail.filteringText)}
        />

        {loading && items.length === 0 ? (
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        ) : (
          <Table
            items={filtered}
            columnDefinitions={[
              {
                id: 'ts',
                header: 'When',
                cell: (r) => r['@timestamp'] ?? '—',
                width: 200,
              },
              {
                id: 'action',
                header: 'Action',
                cell: (r) => <code>{r.action ?? '—'}</code>,
                width: 200,
              },
              {
                id: 'account',
                header: 'Target account',
                cell: (r) => <code>{r.targetAccountId ?? '*'}</code>,
                width: 160,
              },
              {
                id: 'operator',
                header: 'Operator',
                cell: (r) => r['operator.email'] ?? r['operator.sub'] ?? '—',
                width: 240,
              },
              {
                id: 'detail',
                header: 'Detail',
                cell: (r) => (
                  <Box variant="code" fontSize="body-s">
                    {r.detail ?? ''}
                  </Box>
                ),
              },
            ]}
            variant="embedded"
            empty="No audit events in this window."
            stickyHeader
          />
        )}
      </SpaceBetween>
    </Container>
  );
};
