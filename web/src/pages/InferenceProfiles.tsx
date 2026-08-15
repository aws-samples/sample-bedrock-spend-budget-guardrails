import { useEffect, useMemo, useState } from 'react';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import PropertyFilter, { type PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useCollection } from '@cloudscape-design/collection-hooks';
import { api } from '../api/client';
import { friendlyModelName } from '../components/Model';
import { canonicalProvider } from '../components/providerName';
import type { BbgConfig } from '../config';

interface ProfileRow {
  profileArn: string;
  displayName?: string;
  type?: string;
  modelId?: string;
  /** Derived from modelId namespace (e.g. `anthropic.claude-...` → `anthropic`). */
  provider: string;
  /** First two-letter prefix of profileArn slug, e.g. `us`, `eu` for cross-region inference profiles. */
  geography: string;
  fetchedAt?: string;
}

// Canonical vendor-cased provider from the model id (profiles carry no stored
// provider). Shared with the pricing pages so provider display is consistent
// app-wide — e.g. "OpenAI"/"NVIDIA"/"AI21 Labs", never "openai"/"nvidia"/"ai21".
const providerOf = (modelId: string | undefined): string => canonicalProvider(undefined, modelId);

/**
 * Cross-region inference profile IDs are prefixed with the geography
 * (us./eu./apac./ap.) — surfacing this as a column lets admins filter
 * "show me all the EU profiles" or "all global profiles" easily.
 */
const geographyOf = (modelId: string | undefined, profileArn: string): string => {
  if (modelId) {
    const m = modelId.match(/^(us|eu|apac|ap|global)\./);
    if (m) return m[1];
  }
  // Fallback: the ARN's last segment (the inference profile ID) often
  // carries the same prefix.
  const slug = profileArn.split('/').slice(-1)[0] ?? '';
  const m = slug.match(/^(us|eu|apac|ap|global)\./);
  return m?.[1] ?? '—';
};

const typeIndicator = (type: unknown) => {
  switch (type) {
    case 'SYSTEM_DEFINED':
      return <StatusIndicator type="info">System-defined</StatusIndicator>;
    case 'APPLICATION':
      return <StatusIndicator type="success">Application</StatusIndicator>;
    default:
      return <StatusIndicator type="error">{String(type ?? '—')}</StatusIndicator>;
  }
};

export const InferenceProfiles = ({ config }: { config: BbgConfig }) => {
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.listInferenceProfiles(config);
        if (cancelled) return;
        setRows(
          (data.items as Array<Record<string, unknown>>).map((it) => {
            const modelId = typeof it.modelId === 'string' ? it.modelId : undefined;
            const profileArn = String(it.profileArn ?? '');
            return {
              profileArn,
              displayName: typeof it.displayName === 'string' ? it.displayName : undefined,
              type: typeof it.type === 'string' ? it.type : undefined,
              modelId,
              provider: providerOf(modelId),
              geography: geographyOf(modelId, profileArn),
              fetchedAt: typeof it.fetchedAt === 'string' ? it.fetchedAt : undefined,
            };
          }),
        );
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

  const filteringProperties: PropertyFilterProps.FilteringProperty[] = useMemo(
    () => [
      {
        key: 'provider',
        operators: ['=', '!=', ':', '!:'],
        propertyLabel: 'Provider',
        groupValuesLabel: 'Provider values',
      },
      {
        key: 'geography',
        operators: ['=', '!='],
        propertyLabel: 'Geography',
        groupValuesLabel: 'Geography values (us, eu, apac, global)',
      },
      {
        key: 'type',
        operators: ['=', '!='],
        propertyLabel: 'Type',
        groupValuesLabel: 'SYSTEM_DEFINED or APPLICATION',
      },
      {
        key: 'modelId',
        operators: [':', '!:'],
        propertyLabel: 'Model ID',
        groupValuesLabel: 'Model values',
      },
      {
        key: 'displayName',
        operators: [':', '!:'],
        propertyLabel: 'Display name',
        groupValuesLabel: 'Display name values',
      },
      {
        key: 'profileArn',
        operators: [':', '!:'],
        propertyLabel: 'ARN',
        groupValuesLabel: 'ARN substrings',
      },
    ],
    [],
  );

  const collection = useCollection<ProfileRow>(rows, {
    filtering: {
      empty: <div>No inference profiles cached yet — daily refresher hasn't run, or the account has no profiles.</div>,
      noMatch: <div>No matches.</div>,
    },
    propertyFiltering: {
      filteringProperties,
      empty: <div>No inference profiles cached yet.</div>,
      noMatch: <div>No matches.</div>,
    },
    pagination: { pageSize: 50 },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: 'provider' },
        isDescending: false,
      },
    },
  });

  const { items, collectionProps, paginationProps, propertyFilterProps } = collection;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={`(${rows.length})`}
          description="System-defined and application inference profiles, refreshed daily by the inference-profile-refresher Lambda. Click any column to sort; use the filter bar to narrow by provider, geography, type, or model."
        >
          Inference profiles
        </Header>
      }
    >
      {error && <StatusIndicator type="error">Error: {error}</StatusIndicator>}
      <Table
        {...collectionProps}
        loading={loading}
        loadingText="Fetching inference profiles"
        items={items}
        variant="container"
        wrapLines={false}
        filter={
          <PropertyFilter
            {...propertyFilterProps}
            i18nStrings={{
              filteringAriaLabel: 'Filter inference profiles',
              filteringPlaceholder: 'Filter by provider, geography, type, or model',
              clearFiltersText: 'Clear',
              applyActionText: 'Apply',
              cancelActionText: 'Cancel',
              dismissAriaLabel: 'Dismiss',
              groupValuesText: 'Values',
              groupPropertiesText: 'Properties',
              operatorsText: 'Operators',
              operationAndText: 'and',
              operationOrText: 'or',
              operatorContainsText: 'Contains',
              operatorDoesNotContainText: 'Does not contain',
              operatorEqualsText: 'Equals',
              operatorDoesNotEqualText: 'Does not equal',
            }}
          />
        }
        pagination={<Pagination {...paginationProps} />}
        columnDefinitions={[
          {
            id: 'provider',
            header: 'Provider',
            cell: (r) => r.provider,
            sortingField: 'provider',
            isRowHeader: true,
          },
          {
            id: 'displayName',
            header: 'Display name',
            cell: (r) => r.displayName ?? '—',
            sortingField: 'displayName',
          },
          {
            id: 'modelId',
            header: 'Model ID',
            cell: (r) => (r.modelId ? friendlyModelName(r.modelId) : '—'),
            sortingField: 'modelId',
          },
          {
            id: 'geography',
            header: 'Geography',
            cell: (r) => r.geography,
            sortingField: 'geography',
          },
          {
            id: 'type',
            header: 'Type',
            cell: (r) => typeIndicator(r.type),
            sortingField: 'type',
          },
          {
            id: 'profileArn',
            header: 'ARN',
            cell: (r) => r.profileArn,
            sortingField: 'profileArn',
          },
        ]}
        empty="No inference profiles cached yet — daily refresher hasn't run, or the account has no profiles."
      />
    </ContentLayout>
  );
};
