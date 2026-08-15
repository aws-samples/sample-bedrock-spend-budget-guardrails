import { useEffect, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Modal from '@cloudscape-design/components/modal';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { api, type ActivityItem } from '../api/client';
import type { BbgConfig } from '../config';
import { ActivityTable } from './ActivityTable';

/**
 * per-principal activity timeline. Opened from the Identities table
 * (and the central /admin/activity feed); shows the durable log of warnings,
 * enforcement, and identity/budget changes for one principal (newest first).
 * Renders the shared ActivityTable in its borderless (in-modal) variant.
 */
export const PrincipalActivityModal = ({
  config,
  principal,
  onDismiss,
}: {
  config: BbgConfig;
  principal: string;
  onDismiss: () => void;
}) => {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const data = await api.listPrincipalActivity(config, principal);
        if (!cancelled) {
          setItems(data.items);
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
  }, [config, principal]);

  return (
    <Modal visible onDismiss={onDismiss} header={`Activity — ${principal.replace(/^principal#/, '')}`} size="large">
      {loading ? (
        <Box textAlign="center" padding="l">
          <Spinner size="large" />
        </Box>
      ) : error ? (
        <StatusIndicator type="error">Error: {error}</StatusIndicator>
      ) : (
        <ActivityTable
          items={items}
          variant="principal"
          tableVariant="borderless"
          empty={
            <Box textAlign="center" color="inherit">
              No activity recorded yet for this principal.
            </Box>
          }
        />
      )}
    </Modal>
  );
};
