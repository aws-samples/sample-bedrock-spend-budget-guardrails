import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import Table from '@cloudscape-design/components/table';
import type { TableProps } from '@cloudscape-design/components/table';
import type { ActivityItem } from '../api/client';
import { PrincipalCell } from './Principal';

/**
 * Shared renderer for an activity timeline, used by the per-principal modal
 * (variant "self"-less admin drill-down), the self-service /me/activity view
 * (variant "self" — no actor emails, an admin/system "By" column), and the
 * central /admin/activity feed (variant "admin" — adds a Principal column).
 */
export type ActivityTableVariant = 'principal' | 'self' | 'admin';

/** Badge color by event family — enforcement = red, warnings = amber,
 *  releases/positives = green, user/budget config = blue. */
export const activityBadgeColor = (
  type: string,
): 'red' | 'blue' | 'green' | 'grey' | 'severity-medium' => {
  if (type === 'enforcement.applied' || type === 'enforcement.unattachable') return 'red';
  if (type === 'threshold.warning') return 'severity-medium';
  if (type === 'enforcement.released' || type === 'enforcement.rolled_over') return 'green';
  if (type.startsWith('budget.') || type.startsWith('user.')) return 'blue';
  return 'grey';
};

interface ActivityTableProps {
  items: ActivityItem[];
  variant: ActivityTableVariant;
  loading?: boolean;
  /** Table container variant — modal uses "borderless", pages use "container". */
  tableVariant?: TableProps.Variant;
  /** Opened when a row's Principal is clicked (admin feed only). */
  onPrincipalClick?: (principal: string) => void;
  empty?: React.ReactNode;
}

export const ActivityTable = ({
  items,
  variant,
  loading,
  tableVariant = 'container',
  onPrincipalClick,
  empty,
}: ActivityTableProps) => {
  const columns: TableProps.ColumnDefinition<ActivityItem>[] = [
    {
      id: 'ts',
      header: 'When',
      minWidth: 150,
      cell: (r) => new Date(r.ts).toLocaleString(),
    },
    // Central feed: which principal the event is about.
    ...(variant === 'admin'
      ? ([
          {
            id: 'principal',
            header: 'Principal',
            minWidth: 200,
            cell: (r) => {
              if (!r.principal) return '—';
              if (!onPrincipalClick) return <PrincipalCell principal={r.principal} />;
              const p = r.principal;
              return (
                <Link variant="primary" onFollow={() => onPrincipalClick(p)}>
                  <PrincipalCell principal={p} />
                </Link>
              );
            },
          },
        ] as TableProps.ColumnDefinition<ActivityItem>[])
      : []),
    {
      id: 'type',
      header: 'Event',
      minWidth: 150,
      cell: (r) => <Badge color={activityBadgeColor(r.type)}>{r.type}</Badge>,
    },
    { id: 'summary', header: 'Summary', minWidth: 300, cell: (r) => r.summary },
    // "By": admin surfaces show the actor email; the self-service view only
    // reveals whether an admin or the system acted (never a colleague's email).
    variant === 'self'
      ? {
          id: 'by',
          header: 'By',
          minWidth: 140,
          cell: (r) => (r.byAdmin ? 'An administrator' : '(system)'),
        }
      : {
          id: 'actor',
          header: 'By',
          minWidth: 140,
          cell: (r) => r.actor?.email ?? '(system)',
        },
  ];

  return (
    <Table
      items={items}
      loading={loading}
      loadingText="Loading activity"
      variant={tableVariant}
      wrapLines
      resizableColumns={tableVariant !== 'borderless'}
      columnDefinitions={columns}
      empty={
        empty ?? (
          <Box textAlign="center" color="inherit">
            No activity recorded yet.
          </Box>
        )
      }
    />
  );
};
