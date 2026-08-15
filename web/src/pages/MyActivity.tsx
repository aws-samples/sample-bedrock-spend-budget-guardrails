import { useCallback, useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { api, type ActivityItem } from '../api/client';
import { ActivityTable } from '../components/ActivityTable';
import type { BbgConfig } from '../config';

/**
 * BBG self-service activity — a signed-in user's OWN timeline (threshold
 * warnings, enforcement, and the budget/account changes behind them). Subject
 * is resolved server-side from the caller's claims; there's no principal input.
 * The actor is redacted (admin vs system) and detail is allowlisted.
 */
export const MyActivity = ({ config }: { config: BbgConfig }) => {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [unmapped, setUnmapped] = useState(false);
  const [mappedPrincipal, setMappedPrincipal] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.myActivity(config, 100);
      setItems(data.items);
      setUnmapped(Boolean(data.unmapped));
      setMappedPrincipal(data.mappedPrincipal !== false);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="What has happened to your principals — threshold warnings, enforcement, and the budget/account changes behind them. Last 365 days."
        >
          My activity
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && <StatusIndicator type="error">Error: {error}</StatusIndicator>}
        {unmapped && (
          <Alert type="info" header="No IAM principal linked to your account">
            Your Cognito profile doesn't have a <code>custom:iam_principal</code> attribute set, so
            some activity may be missing. Set it on the My profile page (or ask an admin) so BBG can
            scope activity to your IAM identity.{' '}
            {mappedPrincipal ? '' : 'Showing account-lifecycle events only.'}
          </Alert>
        )}
        <ActivityTable items={items} variant="self" loading={loading} />
      </SpaceBetween>
    </ContentLayout>
  );
};
