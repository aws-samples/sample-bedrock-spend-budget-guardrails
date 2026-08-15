import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import AttributeEditor from '@cloudscape-design/components/attribute-editor';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Checkbox from '@cloudscape-design/components/checkbox';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import type { ButtonDropdownProps } from '@cloudscape-design/components/button-dropdown';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { api, type BudgetRow, type BudgetWindow, type RateWindowSeconds, type SpendRow, type Threshold, type ThresholdAction } from '../api/client';
import { useScope } from '../auth/scope-context';
import { accountFromPrincipal } from '../components/canonicalArn';
import { useConfirm } from '../components/ConfirmDialog';
import { friendlyModelName, parseTarget } from '../components/Model';
import { PrincipalCell } from '../components/Principal';
import type { BbgConfig } from '../config';

interface BudgetWithStatus extends BudgetRow {
  spendUsd: number;
  enforced: boolean;
  /** BBG-RATELIMITS — pulled from the matched SpendRow so the table
   *  can render "Enforced (RPM 42 ≥ 20 in 60s)" rather than a plain
   *  "Enforced (deny)". */
  enforcementReason?: 'usd' | 'rpm' | 'tpm';
  enforcementMetric?: { value: number; limit: number; windowSeconds?: number };
}

const usd = (v: number): string => `$${v.toFixed(4)}`;

/** BBG-RATELIMITS — short label for the Limit cell. */
const compactNumber = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
};

const rateWindowLabel = (w?: RateWindowSeconds | null): string => {
  if (w === 300) return '5min';
  if (w === 900) return '15min';
  return '60s'; // default
};

export const AdminBudgets = ({
  config,
  embedded = false,
}: {
  config: BbgConfig;
  /** When true, omit the page-level ContentLayout/Header — the parent
   *  shell (BudgetsAdminShell) provides them around the tabs. */
  embedded?: boolean;
}) => {
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [spend, setSpend] = useState<SpendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [showCreate, setShowCreate] = useState(false);
  const [prefillPrincipal, setPrefillPrincipal] = useState<string | undefined>();
  const [editing, setEditing] = useState<BudgetRow | undefined>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm: confirmAction, dialog: confirmDialog } = useConfirm();

  // Honor `?principal=<arn>` (e.g. from the Identities page "Create budget"
  // link) by opening the create modal with the principal pre-filled, then
  // strip the param so refresh doesn't re-trigger.
  useEffect(() => {
    const fromUrl = searchParams.get('principal');
    if (fromUrl) {
      setPrefillPrincipal(fromUrl);
      setShowCreate(true);
      const next = new URLSearchParams(searchParams);
      next.delete('principal');
      setSearchParams(next, { replace: true });
    }
    // Only run on first mount / when the URL changes externally.
  }, [searchParams, setSearchParams]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [b, s] = await Promise.all([api.listBudgets(config), api.listSpend(config)]);
      setBudgets(b.items);
      setSpend(s.items);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiBaseUrl]);

  const rows: BudgetWithStatus[] = useMemo(() => {
    return budgets.map((b) => {
      // Find the spend row that matches this budget for the current period.
      const match = spend.find((s) => s.principal === b.principal && (s.target === b.target || s.sk.endsWith(`#${b.target}`)));
      return {
        ...b,
        spendUsd: match?.spendUsd ?? 0,
        enforced: match?.enforced ?? false,
        // BBG-RATELIMITS — surface what triggered the deny so the
        // Status cell can show "Enforced (RPM)" with the metric.
        enforcementReason: match?.enforcementReason,
        enforcementMetric: match?.enforcementMetric,
      };
    });
  }, [budgets, spend]);

  const handleDelete = async (row: BudgetRow) => {
    const ok = await confirmAction({
      title: 'Delete budget',
      body: (
        <>
          Delete budget for <code>{row.principal}</code> on <code>{row.target}</code>?
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteBudget(config, row.principal, row.target);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleToggle = async (row: BudgetRow) => {
    try {
      await api.toggleBudget(config, row.principal, row.target);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRelease = async (row: BudgetWithStatus) => {
    const ok = await confirmAction({
      title: 'Release enforcement',
      body: (
        <>
          Release enforcement for <code>{row.principal}</code> on <code>{row.target}</code>?
          This detaches the <code>bbg-deny-*</code> policy and lets the principal invoke
          Bedrock again. The budget itself stays active and will re-enforce if spend climbs
          back over the limit.
        </>
      ),
      confirmLabel: 'Release',
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.releaseBudget(config, row.principal, row.target);
      if (!r.released) {
        setError(r.reason ?? 'Nothing to release');
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const pageHeader = (
    <Header
      variant="h1"
      description="Per-principal × per-target budgets. When spend ≥ limit and action=deny, an IAM deny policy attaches to the principal in seconds."
      actions={
        <SpaceBetween size="xs" direction="horizontal">
          <Button iconName="refresh" onClick={() => void refresh()} loading={loading}>
            Refresh
          </Button>
          <Button iconName="add-plus" variant="primary" onClick={() => setShowCreate(true)}>
            Create budget
          </Button>
        </SpaceBetween>
      }
    >
      Budgets
    </Header>
  );
  const tabHeader = (
    <Header
      variant="h2"
      description="Per-principal × per-target budgets. When spend ≥ limit and a `block` threshold fires, an IAM deny policy attaches to the principal in seconds."
      actions={
        <SpaceBetween size="xs" direction="horizontal">
          <Button iconName="refresh" onClick={() => void refresh()} loading={loading}>
            Refresh
          </Button>
          <Button iconName="add-plus" variant="primary" onClick={() => setShowCreate(true)}>
            Create budget
          </Button>
        </SpaceBetween>
      }
    />
  );
  const body = (
    <>
      {embedded && <Box margin={{ top: 'm', bottom: 's' }}>{tabHeader}</Box>}
      <SpaceBetween size="m">
        {error && (
          <StatusIndicator type="error">Error: {error}</StatusIndicator>
        )}
        <Table
          loading={loading}
          loadingText="Fetching budgets"
          items={rows}
          variant="container"
          resizableColumns
          columnDefinitions={[
            {
              id: 'principal',
              header: 'Principal',
              minWidth: 200,
              cell: (r) => <PrincipalCell principal={r.principal} />,
              sortingField: 'principal',
              isRowHeader: true,
            },
            {
              id: 'target',
              header: 'Target',
              minWidth: 130,
              cell: (r) => {
                const t = parseTarget(r.target);
                return t.kind === 'model' ? friendlyModelName(t.display) : t.display;
              },
            },
            {
              id: 'limit',
              header: 'Limit',
              minWidth: 120,
              cell: (r) => {
                if (r.unlimited) {
                  return <StatusIndicator type="info">Unlimited</StatusIndicator>;
                }
                const window = rateWindowLabel(r.rateWindowSeconds);
                // BBG-RATELIMITS — combine USD + rate caps into one
                // compact cell. Each part is on its own line so the
                // column stays narrow but everything is visible.
                const parts: string[] = [usd(r.limitUsd)];
                if (typeof r.rpm === 'number' && r.rpm > 0) parts.push(`${compactNumber(r.rpm)} req / ${window}`);
                if (typeof r.tpm === 'number' && r.tpm > 0) parts.push(`${compactNumber(r.tpm)} tok / ${window}`);
                return (
                  <SpaceBetween size="xxs">
                    {parts.map((p, i) => (
                      <Box key={i} variant={i === 0 ? 'span' : 'small'}>
                        {p}
                      </Box>
                    ))}
                  </SpaceBetween>
                );
              },
            },
            {
              id: 'window',
              header: 'Window',
              minWidth: 80,
              cell: (r) => r.window ?? 'monthly',
            },
            { id: 'spend', header: 'Current spend', minWidth: 110, cell: (r) => usd(r.spendUsd) },
            {
              id: 'progress',
              header: 'Used',
              minWidth: 80,
              cell: (r) => {
                const pct = r.limitUsd > 0 ? Math.min(100, Math.round((r.spendUsd / r.limitUsd) * 100)) : 0;
                const color = pct >= 100 ? 'error' : pct >= 80 ? 'warning' : 'success';
                return (
                  <StatusIndicator type={color}>{pct}%</StatusIndicator>
                );
              },
            },
            {
              id: 'status',
              header: 'Status',
              minWidth: 200,
              cell: (r) => {
                if (r.unlimited) {
                  return <StatusIndicator type="info">Unlimited (no enforcement)</StatusIndicator>;
                }
                if (r.enforced) {
                  // BBG-RATELIMITS — render the trigger so the
                  // operator can see at a glance whether this was a
                  // dollar overrun or a runaway-loop rate trip.
                  const reason = r.enforcementReason ?? 'usd';
                  const m = r.enforcementMetric;
                  if (reason === 'rpm' && m) {
                    return (
                      <StatusIndicator type="error">
                        Enforced (RPM {m.value}≥{m.limit} in {m.windowSeconds ?? 60}s)
                      </StatusIndicator>
                    );
                  }
                  if (reason === 'tpm' && m) {
                    return (
                      <StatusIndicator type="error">
                        Enforced (TPM {compactNumber(m.value)}≥{compactNumber(m.limit)} in {m.windowSeconds ?? 60}s)
                      </StatusIndicator>
                    );
                  }
                  return <StatusIndicator type="error">Enforced (USD)</StatusIndicator>;
                }
                if (!r.enabled) {
                  return <StatusIndicator type="stopped">Disabled</StatusIndicator>;
                }
                if (r.limitUsd > 0 && r.spendUsd >= r.limitUsd) {
                  return (
                    <StatusIndicator type="warning">
                      {r.action === 'alert' ? 'Over limit (alert only)' : 'Over limit, pending'}
                    </StatusIndicator>
                  );
                }
                return (
                  <StatusIndicator type="success">
                    {r.action === 'alert' ? 'Active (alert)' : 'Active (deny)'}
                  </StatusIndicator>
                );
              },
            },
            {
              id: 'actions',
              header: 'Actions',
              width: 220,
              minWidth: 220,
              cell: (r) => (
                <SpaceBetween size="xs" direction="horizontal">
                  {r.enforced && (
                    <Button
                      variant="normal"
                      iconName="status-warning"
                      onClick={() => void handleRelease(r)}
                    >
                      Release
                    </Button>
                  )}
                  <Button variant="normal" iconName="edit" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <ButtonDropdown
                    expandToViewport
                    onItemClick={({ detail }: { detail: ButtonDropdownProps.ItemClickDetails }) => {
                      if (detail.id === 'toggle') void handleToggle(r);
                      else if (detail.id === 'delete') void handleDelete(r);
                    }}
                    items={[
                      { id: 'toggle', text: r.enabled ? 'Disable budget' : 'Enable budget' },
                      { id: 'delete', text: 'Delete budget' },
                    ]}
                  >
                    More
                  </ButtonDropdown>
                </SpaceBetween>
              ),
            },
          ]}
          empty="No budgets configured"
        />
      </SpaceBetween>
      {showCreate && (
        <BudgetModal
          config={config}
          prefillPrincipal={prefillPrincipal}
          onClose={() => {
            setShowCreate(false);
            setPrefillPrincipal(undefined);
          }}
          onSaved={async () => {
            setShowCreate(false);
            setPrefillPrincipal(undefined);
            await refresh();
          }}
        />
      )}
      {editing && (
        <BudgetModal
          config={config}
          existing={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await refresh();
          }}
        />
      )}
      {confirmDialog}
    </>
  );
  if (embedded) return body;
  return <ContentLayout header={pageHeader}>{body}</ContentLayout>;
};

const BudgetModal = ({
  config,
  existing,
  prefillPrincipal,
  onClose,
  onSaved,
}: {
  config: BbgConfig;
  /** When provided, the modal is in edit mode and PUT-saves; otherwise POST-creates. */
  existing?: BudgetRow;
  /** Pre-fill the principal input when creating (e.g. from the Identities page). */
  prefillPrincipal?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) => {
  const isEdit = Boolean(existing);
  const scope = useScope();
  // follow-up: when caller has single-account scope, pre-fill
  // the principal field with `arn:aws:iam::<accountId>:` so they don't
  // accidentally type a different account's ARN and 403 on submit.
  // Wildcard admins start blank.
  const initialPrincipal =
    existing?.principal ??
    prefillPrincipal ??
    (scope.scopes.length === 1 && !scope.isWildcard
      ? `arn:aws:iam::${scope.scopes[0]}:`
      : '');
  const [principal, setPrincipal] = useState(initialPrincipal);
  const [target, setTarget] = useState(existing?.target ?? '');
  const [limitStr, setLimitStr] = useState(existing ? existing.limitUsd.toFixed(2) : '1.00');
  const [unlimited, setUnlimited] = useState(Boolean(existing?.unlimited));
  const defaultThresholds = (deriveDefault: BudgetRow | undefined): Threshold[] => {
    if (deriveDefault?.thresholds && deriveDefault.thresholds.length > 0) return deriveDefault.thresholds;
    if (deriveDefault?.action === 'alert') {
      return [
        { at: 50, action: 'warn' },
        { at: 80, action: 'warn' },
        { at: 100, action: 'warn' },
      ];
    }
    return [
      { at: 50, action: 'warn' },
      { at: 80, action: 'warn' },
      { at: 100, action: 'block' },
    ];
  };
  const [thresholds, setThresholds] = useState<Threshold[]>(defaultThresholds(existing));
  const windowLabels: Record<BudgetWindow, string> = {
    monthly: 'Monthly (1st of month, 00:00 UTC)',
    weekly: 'Weekly (Mondays, 00:00 UTC)',
    daily: 'Daily (00:00 UTC)',
    '5h': '5 hours (00:00 / 05:00 / 10:00 / 15:00 / 20:00 UTC)',
  };
  const [windowSel, setWindowSel] = useState<{ value: BudgetWindow; label: string }>(() => {
    const w = (existing?.window ?? 'monthly') as BudgetWindow;
    return { value: w, label: windowLabels[w] };
  });

  // BBG-RATELIMITS — rate-limit form state. Empty string = "no limit"
  // (encoded as null on PUT to clear an existing value, or undefined on
  // POST). Window defaults to 60s. The Select stores the value as a
  // string for Cloudscape compatibility; we convert to number on submit.
  const [rpmStr, setRpmStr] = useState<string>(
    existing?.rpm != null ? String(existing.rpm) : '',
  );
  const [tpmStr, setTpmStr] = useState<string>(
    existing?.tpm != null ? String(existing.tpm) : '',
  );
  const rateWindowLabels: Record<string, string> = {
    '60': '60 seconds',
    '300': '5 minutes',
    '900': '15 minutes',
  };
  const [rateWindowSel, setRateWindowSel] = useState<{ value: string; label: string }>(() => {
    const v = String(existing?.rateWindowSeconds ?? 60);
    return { value: v, label: rateWindowLabels[v] ?? rateWindowLabels['60'] };
  });

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const validate = (list: Threshold[]): string | undefined => {
    if (list.length === 0) return 'At least one threshold is required.';
    let blockSeen = false;
    let prev = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!Number.isFinite(t.at) || t.at <= 0 || t.at > 1000) {
        return `Threshold #${i + 1}: percentage must be in (0, 1000].`;
      }
      if (t.at <= prev) return 'Thresholds must have strictly-increasing percentages.';
      if (t.action === 'block') {
        if (blockSeen) return 'Only one block threshold per budget is allowed.';
        if (i !== list.length - 1) return 'The block threshold must be the last entry.';
        blockSeen = true;
      }
      prev = t.at;
    }
    return undefined;
  };

  const submit = async () => {
    setSubmitting(true);
    setErr(undefined);
    // Unlimited budgets opt out of enforcement, so they don't need a
    // block threshold. Skip threshold validation in that mode (warn-only
    // thresholds remain allowed for spend visibility emails but aren't
    // required).
    if (!unlimited) {
      const localErr = validate(thresholds);
      if (localErr) {
        setErr(localErr);
        setSubmitting(false);
        return;
      }
    }
    if (unlimited && thresholds.some((t) => t.action === 'block')) {
      setErr('Unlimited budgets cannot have a block threshold.');
      setSubmitting(false);
      return;
    }
    try {
      const block = thresholds.find((t) => t.action === 'block');
      // BBG-RATELIMITS — turn the form fields into the API payload.
      // Empty string on edit becomes `null` so the API clears the
      // existing value; empty string on create becomes `undefined`
      // so we don't write the field at all. Validation: positive
      // integer when present.
      const parseRate = (raw: string): number | null | undefined => {
        const trimmed = raw.trim();
        if (trimmed === '') return isEdit ? null : undefined;
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('rpm and tpm must be positive numbers');
        }
        return n;
      };
      const rpmVal = parseRate(rpmStr);
      const tpmVal = parseRate(tpmStr);
      const hasRate = (typeof rpmVal === 'number' && rpmVal > 0) ||
        (typeof tpmVal === 'number' && tpmVal > 0);
      if (unlimited && hasRate) {
        setErr('Unlimited budgets cannot have rpm or tpm rate limits.');
        setSubmitting(false);
        return;
      }
      const body = {
        principal,
        target: target.startsWith('model#') || target.startsWith('profile#') ? target : `model#${target}`,
        limitUsd: Number(limitStr),
        // Legacy `action` is derived from whether a block threshold exists,
        // for back-compat with any consumer still reading the old field.
        action: (unlimited || !block ? 'alert' : 'deny') as 'deny' | 'alert',
        thresholds: unlimited ? thresholds.filter((t) => t.action !== 'block') : thresholds,
        window: windowSel.value,
        unlimited,
        enabled: existing?.enabled ?? true,
        rpm: rpmVal,
        tpm: tpmVal,
        rateWindowSeconds: hasRate
          ? (Number(rateWindowSel.value) as RateWindowSeconds)
          : (isEdit ? null : undefined),
      };
      if (isEdit && existing) {
        await api.updateBudget(config, existing.principal, existing.target, body);
      } else {
        await api.createBudget(config, body);
      }
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  };

  const setTemplate = (preset: 'block' | 'warn-block' | 'multi-warn'): void => {
    if (preset === 'block') setThresholds([{ at: 100, action: 'block' }]);
    else if (preset === 'warn-block')
      setThresholds([
        { at: 80, action: 'warn' },
        { at: 100, action: 'block' },
      ]);
    else
      setThresholds([
        { at: 50, action: 'warn' },
        { at: 80, action: 'warn' },
        { at: 100, action: 'warn' },
      ]);
  };

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={isEdit ? 'Edit budget' : 'Create budget'}
      footer={
        <SpaceBetween size="xs" direction="horizontal">
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={submitting}>
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </SpaceBetween>
      }
    >
      <Form errorText={err}>
        <SpaceBetween size="m">
          <FormField
            label="Principal"
            description={
              isEdit
                ? 'Cannot be changed; delete and re-create to move a budget to a different principal.'
                : 'Canonical principal key: an IAM user/role ARN, principal#sso-user#<email>, or principal#sourceIdentity#<value>. SSO/source-identity keys enforce by attaching a scoped deny to the underlying role. Example: arn:aws:iam::123456789012:user/bbg-demo-alice'
            }
            // follow-up: warn the user before they submit a
            // principal whose account is outside their scope. Server
            // would 403; this just makes the failure mode obvious.
            warningText={(() => {
              if (isEdit || scope.isWildcard || principal === '') return undefined;
              const acct = accountFromPrincipal(principal);
              if (!acct || scope.scopes.includes(acct)) return undefined;
              return `Account ${acct} is not in your scope (${scope.scopes.join(', ')}). Submit will return 403.`;
            })()}
          >
            <Input
              value={principal}
              onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setPrincipal(e.detail.value)}
              placeholder="arn:aws:iam::ACCT:user/alice"
              disabled={isEdit}
            />
          </FormField>
          <FormField
            label="Target"
            description={
              isEdit
                ? 'Cannot be changed; delete and re-create to retarget.'
                : 'Either a model id (e.g. anthropic.claude-sonnet-4-6), a wildcard (*), or a full profile ARN. Will be prefixed with model# automatically if no prefix is given.'
            }
          >
            <Input
              value={target}
              onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setTarget(e.detail.value)}
              placeholder="anthropic.claude-sonnet-4-6"
              disabled={isEdit}
            />
          </FormField>
          <FormField
            label="Enforcement"
            description="Unlimited budgets keep recording spend for visibility, but never trigger a deny policy. Use for legitimate power users (researchers, build agents, etc.) who shouldn't be capped."
          >
            <Checkbox
              checked={unlimited}
              onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setUnlimited(e.detail.checked)}
            >
              Unlimited (no enforcement)
            </Checkbox>
          </FormField>
          {!unlimited && (
            <FormField label="Limit (USD)">
              <Input
                type="number"
                value={limitStr}
                onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setLimitStr(e.detail.value)}
              />
            </FormField>
          )}
          <FormField
            label="Reset window"
            description="When the budget resets to zero. Anchored to UTC. Daily / 5-hour windows are useful for student / classroom-style limits where one bad prompt shouldn't burn the whole month."
          >
            <Select
              selectedOption={windowSel}
              onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                const v = (e.detail.selectedOption.value ?? 'monthly') as BudgetWindow;
                setWindowSel({ value: v, label: windowLabels[v] });
              }}
              options={(Object.keys(windowLabels) as BudgetWindow[]).map((w) => ({
                value: w,
                label: windowLabels[w],
              }))}
            />
          </FormField>
          {!unlimited && (
            <Box variant="div" padding={{ vertical: 'xs' }}>
              <Header
                variant="h3"
                description="Optional. Stops runaway agent loops before dollar spend accumulates. Most useful for Claude Code / agent deployments where a tool-use loop can burn through hundreds of dollars in minutes. Leave blank to use the dollar limit only."
              >
                Rate limits
              </Header>
              <SpaceBetween size="m">
                <FormField
                  label="Requests per window"
                  description="Maximum requests this principal can make in the sliding window before BBG attaches a deny policy. Leave blank for no RPM limit."
                >
                  <Input
                    type="number"
                    value={rpmStr}
                    onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setRpmStr(e.detail.value)}
                    placeholder="e.g. 20"
                  />
                </FormField>
                <FormField
                  label="Tokens per window"
                  description="Maximum tokens (input + output combined) per sliding window. Catches context-stuffing and prompt-caching loops that pure RPM can miss. Leave blank for no TPM limit."
                >
                  <Input
                    type="number"
                    value={tpmStr}
                    onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setTpmStr(e.detail.value)}
                    placeholder="e.g. 50000"
                  />
                </FormField>
                <FormField
                  label="Sliding window"
                  description="How far back BBG looks when summing requests/tokens. 60s catches agent loops fastest; 5min/15min smooth out legitimate bursts."
                >
                  <Select
                    selectedOption={rateWindowSel}
                    onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                      const v = String(e.detail.selectedOption.value ?? '60');
                      setRateWindowSel({ value: v, label: rateWindowLabels[v] ?? rateWindowLabels['60'] });
                    }}
                    options={Object.keys(rateWindowLabels).map((k) => ({
                      value: k,
                      label: rateWindowLabels[k],
                    }))}
                  />
                </FormField>
              </SpaceBetween>
            </Box>
          )}
          <FormField
            label="Thresholds"
            description={
              unlimited
                ? 'Optional warn-only thresholds for spend-visibility emails. Block thresholds are not allowed on unlimited budgets.'
                : 'Stepped warn/block actions as the spend crosses each percentage of the budget. Increasing percentages only; at most one block, which must be last.'
            }
          >
            <SpaceBetween size="xs">
              <SpaceBetween size="xs" direction="horizontal">
                <Box variant="small">Templates:</Box>
                <Button onClick={() => setTemplate('warn-block')}>Warn @80, Block @100</Button>
                <Button onClick={() => setTemplate('block')}>Block @100 only</Button>
                <Button onClick={() => setTemplate('multi-warn')}>Warn @50/80/100 (no block)</Button>
              </SpaceBetween>
              <AttributeEditor<Threshold>
                items={thresholds}
                addButtonText="Add threshold"
                removeButtonText="Remove"
                onAddButtonClick={() => {
                  const last = thresholds[thresholds.length - 1];
                  const next: Threshold = {
                    at: last ? Math.min(last.at + 10, 1000) : 100,
                    action: 'warn',
                  };
                  setThresholds([...thresholds, next]);
                }}
                onRemoveButtonClick={({ detail }) => {
                  const next = thresholds.slice();
                  next.splice(detail.itemIndex, 1);
                  setThresholds(next);
                }}
                definition={[
                  {
                    label: 'At %',
                    control: (item: Threshold, idx: number) => (
                      <Input
                        type="number"
                        value={String(item.at)}
                        onChange={(e: NonCancelableCustomEvent<{ value: string }>) => {
                          const next = thresholds.slice();
                          next[idx] = { ...item, at: Number(e.detail.value) };
                          setThresholds(next);
                        }}
                      />
                    ),
                  },
                  {
                    label: 'Action',
                    control: (item: Threshold, idx: number) => (
                      <Select
                        selectedOption={
                          item.action === 'block'
                            ? { value: 'block', label: 'Block (deny)' }
                            : { value: 'warn', label: 'Warn (email)' }
                        }
                        onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                          const next = thresholds.slice();
                          next[idx] = {
                            ...item,
                            action: (e.detail.selectedOption.value ?? 'warn') as ThresholdAction,
                          };
                          setThresholds(next);
                        }}
                        options={[
                          { value: 'warn', label: 'Warn (email)' },
                          { value: 'block', label: 'Block (deny)' },
                        ]}
                      />
                    ),
                  },
                ]}
              />
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
};
