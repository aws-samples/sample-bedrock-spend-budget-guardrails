import { lazy, Suspense, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Spinner from '@cloudscape-design/components/spinner';
import Tabs, { type TabsProps } from '@cloudscape-design/components/tabs';
import type { BbgConfig } from '../config';

// Each tab panel renders the existing per-page component. Lazy-loaded so the
// CodeMirror chunk only ships when the user opens the Manifest tab.
const AdminBudgets = lazy(() =>
  import('./AdminBudgets').then((m) => ({ default: m.AdminBudgets })),
);
const AdminDefaults = lazy(() =>
  import('./AdminDefaults').then((m) => ({ default: m.AdminDefaults })),
);
const AdminManifest = lazy(() =>
  import('./AdminManifest').then((m) => ({ default: m.AdminManifest })),
);

const TabFallback = () => (
  <Box textAlign="center" padding="xxl">
    <Spinner size="large" />
  </Box>
);

/**
 * Single Admin → Budgets page hosting three tabs:
 *   - Budgets         per-row CRUD (existing AdminBudgets)
 *   - Default budget  org-wide default-deny baseline (existing AdminDefaults)
 *   - Manifest        bulk YAML/JSON apply (existing AdminManifest)
 *
 * Active tab persists via `?tab=…` query param so deep-links keep working.
 * Defaults to the Budgets tab when the param is missing or invalid.
 */
export const BudgetsAdminShell = ({ config }: { config: BbgConfig }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = useMemo(() => {
    const t = searchParams.get('tab');
    if (t === 'defaults' || t === 'manifest') return t;
    return 'budgets';
  }, [searchParams]);

  const tabs: TabsProps.Tab[] = [
    {
      id: 'budgets',
      label: 'Budgets',
      content: (
        <Suspense fallback={<TabFallback />}>
          <AdminBudgets config={config} embedded />
        </Suspense>
      ),
    },
    {
      id: 'defaults',
      label: 'Default budget',
      content: (
        <Suspense fallback={<TabFallback />}>
          <AdminDefaults config={config} embedded />
        </Suspense>
      ),
    },
    {
      id: 'manifest',
      label: 'Manifest',
      content: (
        <Suspense fallback={<TabFallback />}>
          <AdminManifest config={config} embedded />
        </Suspense>
      ),
    },
  ];

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Per-row budgets, the org-wide default-deny baseline, and bulk YAML/JSON manifest are three views of the same model. Switch with the tabs below; deep-links via ?tab=defaults or ?tab=manifest."
        >
          Budgets
        </Header>
      }
    >
      <Tabs
        activeTabId={activeId}
        onChange={({ detail }) => {
          const next = new URLSearchParams(searchParams);
          if (detail.activeTabId === 'budgets') next.delete('tab');
          else next.set('tab', detail.activeTabId);
          setSearchParams(next, { replace: true });
        }}
        tabs={tabs}
      />
    </ContentLayout>
  );
};
