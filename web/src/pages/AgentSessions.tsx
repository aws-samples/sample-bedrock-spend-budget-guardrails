import { useEffect, useState } from 'react';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Pagination from '@cloudscape-design/components/pagination';
import { useCollection } from '@cloudscape-design/collection-hooks';
import { api } from '../api/client';
import type { BbgConfig } from '../config';

interface AgentSessionRow {
  agentSessionId: string;
  endUser?: string;
  agentId?: string;
  firstSeen?: string;
  lastSeen?: string;
}

export const AgentSessions = ({ config }: { config: BbgConfig }) => {
  const [rows, setRows] = useState<AgentSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.listAgentSessions(config);
        if (!cancelled) setRows((data.items as unknown) as AgentSessionRow[]);
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

  const collection = useCollection<AgentSessionRow>(rows, {
    pagination: { pageSize: 50 },
    sorting: { defaultState: { sortingColumn: { sortingField: 'lastSeen' }, isDescending: true } },
  });

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={`(${rows.length})`}
          description="Bedrock Agent (and multi-agent collaboration) conversations the meter has correlated to a Cognito user via the optional gateway. Each row aggregates every InvokeAgent + InvokeModel hop in the chain."
        >
          Agent sessions
        </Header>
      }
    >
      {error && <StatusIndicator type="error">Error: {error}</StatusIndicator>}
      <Table
        {...collection.collectionProps}
        loading={loading}
        loadingText="Fetching agent sessions"
        items={collection.items}
        variant="container"
        pagination={<Pagination {...collection.paginationProps} />}
        columnDefinitions={[
          {
            id: 'session',
            header: 'Session ID',
            cell: (r) => r.agentSessionId.slice(0, 16) + '…',
            sortingField: 'agentSessionId',
          },
          { id: 'endUser', header: 'End user', cell: (r) => r.endUser ?? '—', sortingField: 'endUser' },
          { id: 'agentId', header: 'Agent ID', cell: (r) => r.agentId ?? '—', sortingField: 'agentId' },
          {
            id: 'firstSeen',
            header: 'First invoked',
            cell: (r) => (r.firstSeen ? new Date(r.firstSeen).toLocaleString() : '—'),
            sortingField: 'firstSeen',
          },
          {
            id: 'lastSeen',
            header: 'Last invoked',
            cell: (r) => (r.lastSeen ? new Date(r.lastSeen).toLocaleString() : '—'),
            sortingField: 'lastSeen',
          },
        ]}
        empty="No agent sessions seen yet. The optional gateway stack must be enabled (bbg:enableGateway=true) and a user must have invoked an agent through it."
      />
    </ContentLayout>
  );
};
