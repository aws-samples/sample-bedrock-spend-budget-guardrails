import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Pagination from '@cloudscape-design/components/pagination';
import PropertyFilter, { type PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useCollection } from '@cloudscape-design/collection-hooks';
import { api } from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { friendlyModelName } from '../components/Model';
import { canonicalProvider } from '../components/providerName';
import { PricingDiscounts } from './PricingDiscounts';
import type { BbgConfig } from '../config';

/**
 * Pricing-dimension kinds matching `lambda/src/shared/pricing.ts`. Each one
 * maps to a usage counter on the Bedrock invocation log; the meter sums
 * `count × pricePerUnit` across every dimension a model has.
 */
const DIMENSION_KINDS = [
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
] as const;
type DimensionKind = (typeof DIMENSION_KINDS)[number];

const DIMENSION_LABEL: Record<DimensionKind, string> = {
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cacheReadTokens: 'Cache read tokens',
  cacheWriteTokens: 'Cache write tokens',
  outputImages: 'Output images',
  inputVideoSeconds: 'Input video (s)',
  outputVideoSeconds: 'Output video (s)',
  inputAudioSeconds: 'Input audio (s)',
  outputAudioSeconds: 'Output audio (s)',
  searchUnits: 'Search units',
  embedTokens: 'Embed tokens',
};

const DIMENSION_DEFAULT_UNIT: Record<DimensionKind, string> = {
  inputTokens: '1K tokens',
  outputTokens: '1K tokens',
  cacheReadTokens: '1K tokens',
  cacheWriteTokens: '1K tokens',
  outputImages: 'image',
  inputVideoSeconds: 'second',
  outputVideoSeconds: 'second',
  inputAudioSeconds: 'second',
  outputAudioSeconds: 'second',
  searchUnits: 'search unit',
  embedTokens: '1K tokens',
};

interface DimensionDef {
  unit: string;
  pricePerUnit: number;
  label?: string;
}

interface PricingRow {
  model: string;
  displayName?: string;
  provider?: string;
  source?: string;
  dimensions: Partial<Record<DimensionKind, DimensionDef>>;
  // Legacy fields, kept for back-compat with old rows.
  inputPer1k?: number;
  outputPer1k?: number;
  cacheReadPer1k?: number;
  cacheWritePer1k?: number;
}

const sourceIndicator = (source: unknown) => {
  switch (source) {
    case 'pricing-api':
      return <StatusIndicator type="success">pricing-api</StatusIndicator>;
    case 'pricing-api-feature-fallback':
      return <StatusIndicator type="info">feature-fallback</StatusIndicator>;
    case 'bulk-api':
      return <StatusIndicator type="info">bulk-api</StatusIndicator>;
    case 'override':
      return <StatusIndicator type="warning">override</StatusIndicator>;
    case 'pricing-api-historical':
      return <StatusIndicator type="pending">historical</StatusIndicator>;
    default:
      return <StatusIndicator type="error">unknown</StatusIndicator>;
  }
};

/** Compact $ price formatter, dropping trailing zeros where safe. */
const fmtPrice = (n: number): string => {
  if (n === 0) return '$0';
  // Use up to 6 decimals, but trim trailing zeros for readability.
  return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
};

/**
 * Canonical vendor-cased provider for a row — from its stored `provider` if
 * present, else derived from the model id. Normalizing BOTH sources through one
 * map is what stops a refresher row (`"OpenAI"`) and an override row (`openai`)
 * rendering as two providers in the filter/sort/column.
 */
const providerOf = (row: PricingRow): string => canonicalProvider(row.provider, row.model);

const numberOrUndef = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * Hydrates a server-side row into a normalized PricingRow with
 * `dimensions` always populated. Legacy rows that only carry
 * `inputPer1k` / `outputPer1k` get a synthesized `inputTokens` / `outputTokens`
 * dimension so the UI renders consistently.
 */
const hydrateRow = (it: Record<string, unknown>): PricingRow => {
  const r: PricingRow = {
    model: String(it.model ?? ''),
    displayName: typeof it.displayName === 'string' ? it.displayName : undefined,
    provider: typeof it.provider === 'string' ? it.provider : undefined,
    inputPer1k: numberOrUndef(it.inputPer1k),
    outputPer1k: numberOrUndef(it.outputPer1k),
    cacheReadPer1k: numberOrUndef(it.cacheReadPer1k),
    cacheWritePer1k: numberOrUndef(it.cacheWritePer1k),
    source: typeof it.source === 'string' ? it.source : undefined,
    dimensions: {},
  };
  const raw = it.dimensions as Record<string, Record<string, unknown>> | undefined;
  if (raw) {
    for (const [k, v] of Object.entries(raw)) {
      if (!DIMENSION_KINDS.includes(k as DimensionKind)) continue;
      const price = numberOrUndef(v.pricePerUnit);
      if (price === undefined) continue;
      r.dimensions[k as DimensionKind] = {
        unit: typeof v.unit === 'string' ? v.unit : DIMENSION_DEFAULT_UNIT[k as DimensionKind],
        pricePerUnit: price,
        label: typeof v.label === 'string' ? v.label : DIMENSION_LABEL[k as DimensionKind],
      };
    }
  }
  // Synthesize from legacy fields when explicit dims are missing.
  const synth = (kind: DimensionKind, val: number | undefined) => {
    if (val === undefined) return;
    if (r.dimensions[kind]) return;
    r.dimensions[kind] = { unit: '1K tokens', pricePerUnit: val, label: DIMENSION_LABEL[kind] };
  };
  synth('inputTokens', r.inputPer1k);
  synth('outputTokens', r.outputPer1k);
  synth('cacheReadTokens', r.cacheReadPer1k);
  synth('cacheWriteTokens', r.cacheWritePer1k);
  // Normalize UNCONDITIONALLY (not just when absent) so a refresher row's
  // vendor-cased "OpenAI" and an override row's derived "openai" collapse to
  // one canonical label that the filter/sort/column all agree on.
  r.provider = providerOf(r);
  return r;
};

/** Comma-separated list of dimension kinds for filter matching. */
const dimensionsKey = (row: PricingRow): string =>
  Object.keys(row.dimensions).sort().join(',');

interface OverrideFormState {
  model: string;
  displayName: string;
  notes: string;
  /** Editable dimension list. */
  dims: Array<{ kind: DimensionKind; unit: string; price: string }>;
}

const blankDim = (kind: DimensionKind): OverrideFormState['dims'][number] => ({
  kind,
  unit: DIMENSION_DEFAULT_UNIT[kind],
  price: '',
});

const formFromRow = (row: PricingRow | undefined): OverrideFormState => {
  if (!row) {
    return {
      model: '',
      displayName: '',
      notes: '',
      // Sensible default for the most common case (token-priced chat model).
      dims: [blankDim('inputTokens'), blankDim('outputTokens')],
    };
  }
  const dims: OverrideFormState['dims'] = [];
  for (const kind of DIMENSION_KINDS) {
    const d = row.dimensions[kind];
    if (!d) continue;
    dims.push({
      kind,
      unit: d.unit,
      price: String(d.pricePerUnit),
    });
  }
  if (dims.length === 0) {
    dims.push(blankDim('inputTokens'), blankDim('outputTokens'));
  }
  return {
    model: row.model,
    displayName: row.displayName ?? '',
    notes: '',
    dims,
  };
};

export const PricingOverrides = ({ config }: { config: BbgConfig }) => {
  const [rows, setRows] = useState<PricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState<{ row?: PricingRow; form: OverrideFormState } | undefined>();
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Array<PricingRow & { dimensionsKey: string }>>([]);
  const { confirm: confirmAction, dialog: confirmDialog } = useConfirm();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listPricing(config);
      setRows((data.items as Array<Record<string, unknown>>).map(hydrateRow));
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openEditor = (row?: PricingRow) =>
    setEditing({ row, form: formFromRow(row) });

  const submit = async () => {
    if (!editing) return;
    const f = editing.form;
    if (!f.model.trim()) {
      setError('Model ID is required.');
      return;
    }
    const dimensions: Record<string, { unit: string; pricePerUnit: number; label?: string }> = {};
    for (const d of f.dims) {
      const price = Number(d.price);
      if (!Number.isFinite(price)) {
        setError(`Price for ${DIMENSION_LABEL[d.kind]} must be a number.`);
        return;
      }
      dimensions[d.kind] = {
        unit: d.unit.trim() || DIMENSION_DEFAULT_UNIT[d.kind],
        pricePerUnit: price,
        label: DIMENSION_LABEL[d.kind],
      };
    }
    if (Object.keys(dimensions).length === 0) {
      setError('Add at least one dimension before saving.');
      return;
    }
    setSaving(true);
    try {
      // Backwards-compat: also send legacy inputPer1k/outputPer1k if those
      // dimensions are present so older readers see real numbers too.
      await api.upsertPricingOverride(config, {
        model: f.model.trim(),
        displayName: f.displayName.trim() || undefined,
        notes: f.notes.trim() || undefined,
        dimensions,
        inputPer1k: dimensions.inputTokens?.pricePerUnit,
        outputPer1k: dimensions.outputTokens?.pricePerUnit,
        cacheReadPer1k: dimensions.cacheReadTokens?.pricePerUnit,
        cacheWritePer1k: dimensions.cacheWriteTokens?.pricePerUnit,
      });
      setEditing(undefined);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: PricingRow) => {
    const ok = await confirmAction({
      title: 'Delete pricing row',
      body: (
        <>
          Delete pricing row for <code>{row.model}</code>? The next refresher run will
          repopulate from the Pricing API.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deletePricingOverride(config, row.model);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const filteringProperties: PropertyFilterProps.FilteringProperty[] = useMemo(
    () => [
      { key: 'provider', operators: ['=', '!=', ':', '!:'], propertyLabel: 'Provider', groupValuesLabel: 'Provider values' },
      { key: 'model', operators: ['=', '!=', ':', '!:'], propertyLabel: 'Model ID', groupValuesLabel: 'Model values' },
      { key: 'displayName', operators: [':', '!:'], propertyLabel: 'Display name', groupValuesLabel: 'Display name values' },
      { key: 'source', operators: ['=', '!='], propertyLabel: 'Source', groupValuesLabel: 'Source values' },
      { key: 'dimensionsKey', operators: [':', '!:'], propertyLabel: 'Dimensions', groupValuesLabel: 'e.g. inputTokens, outputImages' },
    ],
    [],
  );

  const collectionItems: Array<PricingRow & { dimensionsKey: string }> = useMemo(
    () => rows.map((r) => ({ ...r, dimensionsKey: dimensionsKey(r) })),
    [rows],
  );

  const collection = useCollection(collectionItems, {
    filtering: {
      empty: <div>No pricing rows cached yet — invoke the pricing-refresher Lambda.</div>,
      noMatch: <div>No matches.</div>,
    },
    propertyFiltering: {
      filteringProperties,
      empty: <div>No pricing rows cached yet.</div>,
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
          description="Per-Bedrock-model pricing across every dimension a model bills on (tokens, cache, images, video seconds, audio seconds, search units). Refreshed daily from the AWS Pricing API; admins can add overrides for new dimensions or unpriced models."
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                disabled={selected.length !== 1}
                onClick={() => selected[0] && openEditor(selected[0])}
              >
                Edit
              </Button>
              <Button
                disabled={selected.length !== 1}
                onClick={() => selected[0] && void remove(selected[0])}
              >
                Delete
              </Button>
              <Button variant="primary" onClick={() => openEditor()}>
                Add override
              </Button>
            </SpaceBetween>
          }
        >
          Pricing
        </Header>
      }
    >
      {error && <StatusIndicator type="error">Error: {error}</StatusIndicator>}
      {/* per-account custom pricing discount, above the model table. */}
      <SpaceBetween size="l">
      <PricingDiscounts config={config} />
      <Table
        {...collectionProps}
        loading={loading}
        loadingText="Fetching pricing"
        items={items}
        variant="container"
        wrapLines={true}
        selectionType="single"
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        trackBy="model"
        filter={
          <PropertyFilter
            {...propertyFilterProps}
            i18nStrings={{
              filteringAriaLabel: 'Filter pricing',
              filteringPlaceholder: 'Filter by provider, model, source, or dimension',
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
            cell: (r) => r.provider ?? '—',
            sortingField: 'provider',
            isRowHeader: true,
          },
          {
            id: 'displayName',
            header: 'Model name',
            cell: (r) => r.displayName ?? friendlyModelName(r.model),
            sortingField: 'displayName',
          },
          { id: 'model', header: 'Model ID', cell: (r) => r.model, sortingField: 'model' },
          {
            id: 'dimensions',
            header: 'Dimensions',
            cell: (r) => {
              const entries = Object.entries(r.dimensions) as Array<[DimensionKind, DimensionDef]>;
              if (entries.length === 0) return '—';
              return (
                <SpaceBetween direction="horizontal" size="xxs">
                  {entries.map(([kind, dim]) => (
                    <Badge key={kind} color="blue">
                      {DIMENSION_LABEL[kind]}: {fmtPrice(dim.pricePerUnit)} / {dim.unit}
                    </Badge>
                  ))}
                </SpaceBetween>
              );
            },
          },
          {
            id: 'source',
            header: 'Source',
            // Wide enough that the StatusIndicator icon + label (e.g.
            // "pricing-api") stays on one line — the table has wrapLines on, so
            // a too-narrow last column wraps "pricing-a/pi".
            minWidth: 170,
            cell: (r) => sourceIndicator(r.source),
            sortingField: 'source',
          },
        ]}
        empty="No pricing rows cached yet — invoke the pricing-refresher Lambda."
      />
      </SpaceBetween>
      {editing && (
        <Modal
          visible
          size="large"
          onDismiss={() => setEditing(undefined)}
          header={editing.row ? `Edit pricing for ${editing.row.model}` : 'Add pricing override'}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setEditing(undefined)}>
                  Cancel
                </Button>
                <Button variant="primary" loading={saving} onClick={() => void submit()}>
                  Save override
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <Form>
            <SpaceBetween direction="vertical" size="m">
              <FormField
                label="Model ID"
                description="The Bedrock modelId, e.g. anthropic.claude-3-5-sonnet-20240620-v1:0"
              >
                <Input
                  value={editing.form.model}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) =>
                    setEditing({ ...editing, form: { ...editing.form, model: e.detail.value } })
                  }
                  disabled={Boolean(editing.row)}
                />
              </FormField>
              <FormField label="Display name" description="Optional. Shown in the UI when present.">
                <Input
                  value={editing.form.displayName}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) =>
                    setEditing({ ...editing, form: { ...editing.form, displayName: e.detail.value } })
                  }
                />
              </FormField>

              <Header
                variant="h3"
                description="Add one row per dimension this model bills on. Token-only chat models need just inputTokens + outputTokens. Image / video / audio / rerank models add their own dimensions."
                actions={
                  <Button
                    iconName="add-plus"
                    onClick={() => {
                      const used = new Set(editing.form.dims.map((d) => d.kind));
                      const next = DIMENSION_KINDS.find((k) => !used.has(k));
                      if (!next) return;
                      setEditing({
                        ...editing,
                        form: { ...editing.form, dims: [...editing.form.dims, blankDim(next)] },
                      });
                    }}
                    disabled={editing.form.dims.length >= DIMENSION_KINDS.length}
                  >
                    Add dimension
                  </Button>
                }
              >
                Pricing dimensions
              </Header>

              <SpaceBetween direction="vertical" size="s">
                {editing.form.dims.map((d, idx) => {
                  const used = new Set(editing.form.dims.map((x, i) => (i === idx ? '' : x.kind)));
                  return (
                    <Box key={idx} padding="s" variant="div">
                      <SpaceBetween direction="horizontal" size="s" alignItems="end">
                        <FormField label={idx === 0 ? 'Dimension' : ''}>
                          <Select
                            selectedOption={{ value: d.kind, label: DIMENSION_LABEL[d.kind] }}
                            options={DIMENSION_KINDS.filter((k) => !used.has(k)).map((k) => ({
                              value: k,
                              label: DIMENSION_LABEL[k],
                            }))}
                            onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                              const nextKind = e.detail.selectedOption.value as DimensionKind;
                              const nextDims = [...editing.form.dims];
                              nextDims[idx] = {
                                kind: nextKind,
                                unit: DIMENSION_DEFAULT_UNIT[nextKind],
                                price: nextDims[idx].price,
                              };
                              setEditing({ ...editing, form: { ...editing.form, dims: nextDims } });
                            }}
                          />
                        </FormField>
                        <FormField label={idx === 0 ? 'Unit' : ''}>
                          <Input
                            value={d.unit}
                            onChange={(e: NonCancelableCustomEvent<{ value: string }>) => {
                              const nextDims = [...editing.form.dims];
                              nextDims[idx] = { ...nextDims[idx], unit: e.detail.value };
                              setEditing({ ...editing, form: { ...editing.form, dims: nextDims } });
                            }}
                          />
                        </FormField>
                        <FormField label={idx === 0 ? 'Price per unit ($)' : ''}>
                          <Input
                            value={d.price}
                            type="number"
                            inputMode="decimal"
                            onChange={(e: NonCancelableCustomEvent<{ value: string }>) => {
                              const nextDims = [...editing.form.dims];
                              nextDims[idx] = { ...nextDims[idx], price: e.detail.value };
                              setEditing({ ...editing, form: { ...editing.form, dims: nextDims } });
                            }}
                          />
                        </FormField>
                        <Button
                          iconName="remove"
                          variant="link"
                          ariaLabel="Remove dimension"
                          onClick={() => {
                            const nextDims = editing.form.dims.filter((_, i) => i !== idx);
                            setEditing({ ...editing, form: { ...editing.form, dims: nextDims } });
                          }}
                        />
                      </SpaceBetween>
                    </Box>
                  );
                })}
              </SpaceBetween>

              <FormField label="Notes" description="Optional internal note (visible to admins on the row).">
                <Input
                  value={editing.form.notes}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) =>
                    setEditing({ ...editing, form: { ...editing.form, notes: e.detail.value } })
                  }
                />
              </FormField>
            </SpaceBetween>
          </Form>
        </Modal>
      )}
      {confirmDialog}
    </ContentLayout>
  );
};
