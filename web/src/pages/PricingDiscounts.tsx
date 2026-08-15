import { useCallback, useEffect, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { api, type DiscountScope, type PricingDiscountRow } from '../api/client';
import type { BbgConfig } from '../config';
import { useConfirm } from '../components/ConfirmDialog';

const SCOPE_OPTIONS: ReadonlyArray<SelectProps.Option & { value: DiscountScope }> = [
  { value: 'account', label: 'Account', description: '12-digit AWS account ID' },
  { value: 'ou', label: 'Organizational Unit', description: 'ou-… (or root r-…)' },
  { value: 'org', label: 'Organization', description: 'o-… (applies org-wide)' },
];

const scopePlaceholder: Record<DiscountScope, string> = {
  account: '123456789012',
  ou: 'ou-ab12-cdef3456',
  org: 'o-abc123defg',
};

const scopeLabel: Record<DiscountScope, string> = {
  account: 'Account',
  ou: 'OU',
  org: 'Organization',
};

/**
 * Custom pricing discount — a percentage applied to metered spend so dashboards
 * reflect an organization's negotiated (effective) Amazon Bedrock rate rather
 * than public list price. Discounts can be authored at three scopes with
 * most-specific-wins precedence (account > nearest OU > org). For accounts, the
 * table also shows the RESOLVED effective rate and which scope it came from.
 * Deliberately generic wording — not tied to any specific contract construct.
 */
export const PricingDiscounts = ({ config }: { config: BbgConfig }) => {
  const [rows, setRows] = useState<PricingDiscountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState<SelectProps.Option>(SCOPE_OPTIONS[0]);
  const [scopeId, setScopeId] = useState('');
  const [pct, setPct] = useState('');
  const [label, setLabel] = useState('');
  const { confirm: confirmAction, dialog: confirmDialog } = useConfirm();

  // Org tree drives the scope-ID dropdown (accounts / OUs / org). Best-effort:
  // if BBG isn't the Org management account this 403s, and we fall back to a
  // free-text input (org/OU discounts are inactive there anyway).
  const [orgTree, setOrgTree] = useState<{
    organizationId?: string;
    accounts: Array<{ id: string; name: string }>;
    ous: Array<{ id: string; name: string }>;
  } | undefined>();
  const [orgTreeUnavailable, setOrgTreeUnavailable] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listPricingDiscounts(config);
      setRows(data.items);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const org = await api.listOrgAccounts(config);
        if (cancelled) return;
        setOrgTree({
          organizationId: org.organizationId,
          accounts: (org.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
          ous: (org.ous ?? []).map((o) => ({ id: o.id, name: o.name })),
        });
      } catch {
        if (!cancelled) setOrgTreeUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  // Options for the scope-ID dropdown, per selected scope.
  const scopeIdOptions: SelectProps.Options = (() => {
    const s = scope.value as DiscountScope;
    if (!orgTree) return [];
    if (s === 'account')
      return orgTree.accounts.map((a) => ({ value: a.id, label: a.name, description: a.id }));
    if (s === 'ou') return orgTree.ous.map((o) => ({ value: o.id, label: o.name, description: o.id }));
    return orgTree.organizationId
      ? [{ value: orgTree.organizationId, label: 'This organization', description: orgTree.organizationId }]
      : [];
  })();

  const validScopeId = (s: DiscountScope, v: string): boolean => {
    if (s === 'account') return /^\d{12}$/.test(v);
    if (s === 'ou') return /^(ou-[a-z0-9-]+|r-[a-z0-9]+)$/.test(v);
    return /^o-[a-z0-9]+$/.test(v);
  };

  const add = async () => {
    const s = scope.value as DiscountScope;
    const id = scopeId.trim();
    if (!validScopeId(s, id)) {
      setError(`Enter a valid ${scopeLabel[s]} id (e.g. ${scopePlaceholder[s]}).`);
      return;
    }
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setError('Discount must be a number between 0 and 100.');
      return;
    }
    setSaving(true);
    try {
      await api.upsertPricingDiscount(config, { scope: s, scopeId: id, discountPct: n, label: label.trim() || undefined });
      setScopeId('');
      setPct('');
      setLabel('');
      setError(undefined);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: PricingDiscountRow) => {
    const ok = await confirmAction({
      title: 'Remove custom pricing discount',
      body: (
        <>
          Remove the {row.discountPct}% {scopeLabel[row.scope]} discount for <code>{row.scopeId}</code>?
          Effective rates will be re-resolved; affected accounts revert to the next-most-specific
          discount (or list price).
        </>
      ),
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deletePricingDiscount(config, row.scope, row.scopeId);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Show any row an operator authored (discountPct set) OR an account that only
  // INHERITS a materialized rate (effectivePct set, no authored value) — the
  // latter is exactly where the "via OU/org" provenance matters, so it must not
  // be filtered out. Account-0 rows are explicit exclusions (list price).
  const visible = rows.filter((r) => r.discountPct !== undefined || r.effectivePct !== undefined);

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="If your organization has negotiated discounted Amazon Bedrock rates, set a discount so metered spend reflects your effective cost. Set it per account, per OU, or org-wide — the most specific scope wins. OU/org discounts require BBG to be deployed in the Organizations management account."
        >
          Custom pricing discounts
        </Header>
      }
    >
      <SpaceBetween size="m">
        {error && <StatusIndicator type="error">Error: {error}</StatusIndicator>}
        <Table
          items={visible}
          loading={loading}
          loadingText="Loading discounts"
          variant="embedded"
          empty={<Box textAlign="center" color="inherit">No custom pricing discounts set — all accounts metered at list price.</Box>}
          columnDefinitions={[
            { id: 'scope', header: 'Scope', cell: (r) => scopeLabel[r.scope], isRowHeader: true },
            { id: 'scopeId', header: 'ID', cell: (r) => <code>{r.scopeId}</code> },
            {
              id: 'discountPct',
              header: 'Authored',
              // 0 on an account = explicit exclusion (list price). Undefined =
              // this account only inherits from an OU/org (no authored value).
              cell: (r) =>
                r.discountPct === undefined
                  ? '— (inherited)'
                  : r.discountPct === 0
                    ? 'List price (excluded)'
                    : `${r.discountPct}%`,
            },
            {
              id: 'effective',
              header: 'Effective (resolved)',
              // Only account rows carry a materialized effective rate + provenance.
              cell: (r) => {
                if (r.scope !== 'account') return '—';
                if (r.discountPct === 0) return 'List price'; // explicit exclusion
                if (r.effectivePct === undefined)
                  return r.discountPct === undefined ? 'List price' : `${r.discountPct}% (account)`;
                return `${r.effectivePct}% (via ${r.effectiveScope}${r.effectiveScopeId ? ` ${r.effectiveScopeId}` : ''})`;
              },
            },
            { id: 'label', header: 'Label', cell: (r) => r.label ?? '—' },
            { id: 'updatedAt', header: 'Updated', cell: (r) => r.updatedAt ?? '—' },
            {
              id: 'actions',
              header: '',
              // Only authored rows can be removed; an inherited-only account has
              // nothing of its own to delete (change the OU/org discount instead).
              cell: (r) =>
                r.discountPct === undefined ? (
                  '—'
                ) : (
                  <Button variant="inline-link" onClick={() => void remove(r)}>
                    Remove
                  </Button>
                ),
            },
          ]}
        />
        {/* Add / update: an upsert on an existing scope+id replaces its discount. */}
        <SpaceBetween direction="horizontal" size="xs" alignItems="end">
          <FormField label="Scope">
            <Select
              selectedOption={scope}
              onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                setScope(e.detail.selectedOption);
                setScopeId('');
              }}
              options={SCOPE_OPTIONS}
              ariaLabel="Discount scope"
            />
          </FormField>
          <FormField
            label={`${scopeLabel[scope.value as DiscountScope]} ID`}
            description={
              orgTreeUnavailable
                ? 'Org tree unavailable — enter the id manually.'
                : undefined
            }
          >
            {/* Dropdown from the live Org tree so operators pick a real
                account/OU/org by name. Falls back to free-text when the Org
                tree can't be read (BBG not the management account) or the
                selected scope has no options. */}
            {orgTree && scopeIdOptions.length > 0 ? (
              <Select
                selectedOption={
                  scopeIdOptions.find((o) => 'value' in o && o.value === scopeId) ??
                  (scopeId ? { value: scopeId, label: scopeId } : null)
                }
                onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => setScopeId(e.detail.selectedOption.value ?? '')}
                options={scopeIdOptions}
                filteringType="auto"
                placeholder={`Select ${scopeLabel[scope.value as DiscountScope]}`}
                empty="No matching entries in the Org tree"
                ariaLabel={`${scopeLabel[scope.value as DiscountScope]} id`}
              />
            ) : (
              <Input
                value={scopeId}
                onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setScopeId(e.detail.value)}
                placeholder={scopePlaceholder[scope.value as DiscountScope]}
              />
            )}
          </FormField>
          <FormField label="Discount %">
            <Input value={pct} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setPct(e.detail.value)} type="number" placeholder="25" />
          </FormField>
          <FormField label="Label (optional)">
            <Input value={label} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setLabel(e.detail.value)} placeholder="2026 negotiated rate" />
          </FormField>
          <Button variant="primary" loading={saving} onClick={() => void add()}>
            Set discount
          </Button>
        </SpaceBetween>
      </SpaceBetween>
      {confirmDialog}
    </Container>
  );
};
