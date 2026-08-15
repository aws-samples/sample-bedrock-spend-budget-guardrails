import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import AttributeEditor from '@cloudscape-design/components/attribute-editor';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Toggle from '@cloudscape-design/components/toggle';
import {
  api,
  type BudgetWindow,
  type DefaultsConfig,
  type RateWindowSeconds,
  type Threshold,
  type ThresholdAction,
} from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import type { BbgConfig } from '../config';

const WINDOW_OPTIONS: Array<{ value: BudgetWindow; label: string }> = [
  { value: 'monthly', label: 'Monthly (1st of month, 00:00 UTC)' },
  { value: 'weekly', label: 'Weekly (Mondays, 00:00 UTC)' },
  { value: 'daily', label: 'Daily (00:00 UTC)' },
  { value: '5h', label: '5 hours (00:00 / 05:00 / 10:00 / 15:00 / 20:00 UTC)' },
];

// BBG-RATELIMITS-DEFAULTS — sliding-window choices match per-budget UI.
const RATE_WINDOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '60', label: '60 seconds' },
  { value: '300', label: '5 minutes' },
  { value: '900', label: '15 minutes' },
];

export const AdminDefaults = ({
  config,
  embedded = false,
}: {
  config: BbgConfig;
  embedded?: boolean;
}) => {
  const [cfg, setCfg] = useState<DefaultsConfig | undefined>();
  const [enabled, setEnabled] = useState(false);
  const [limitStr, setLimitStr] = useState('1.00');
  const [windowSel, setWindowSel] = useState<{ value: BudgetWindow; label: string }>(
    WINDOW_OPTIONS[0],
  );
  const [thresholds, setThresholds] = useState<Threshold[]>([
    { at: 80, action: 'warn' },
    { at: 100, action: 'block' },
  ]);
  // BBG-RATELIMITS-DEFAULTS — empty string = "no rate limit" (sent as
  // null on PUT to clear if previously set). User types a positive
  // number to set.
  const [rpmStr, setRpmStr] = useState<string>('');
  const [tpmStr, setTpmStr] = useState<string>('');
  const [rateWindowSel, setRateWindowSel] = useState<{ value: string; label: string }>(
    RATE_WINDOW_OPTIONS[0],
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.getDefaults(config);
        setCfg(r);
        setEnabled(Boolean(r.enabled));
        setLimitStr(Number(r.limitUsd ?? 0).toFixed(2));
        const w = WINDOW_OPTIONS.find((o) => o.value === r.window) ?? WINDOW_OPTIONS[0];
        setWindowSel(w);
        if (r.thresholds && r.thresholds.length > 0) setThresholds(r.thresholds);
        // BBG-RATELIMITS-DEFAULTS — hydrate the form from current SSM
        // state. Absent (undefined / null) = empty input box = "no rate
        // limit set"; non-zero positive numbers populate the input.
        setRpmStr(typeof r.rpm === 'number' && r.rpm > 0 ? String(r.rpm) : '');
        setTpmStr(typeof r.tpm === 'number' && r.tpm > 0 ? String(r.tpm) : '');
        const rwsValue = String(r.rateWindowSeconds ?? 60);
        setRateWindowSel(
          RATE_WINDOW_OPTIONS.find((o) => o.value === rwsValue) ?? RATE_WINDOW_OPTIONS[0],
        );
        setSavedAt(r.updatedAt ?? null);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [config]);

  const submit = async () => {
    if (enabled && !cfg?.enabled) {
      // nosemgrep: javascript-confirm - this is the Cloudscape useConfirm() hook
      // (see ../components/ConfirmDialog and the import above), NOT the blocking
      // window.confirm() the rule targets. The repo mandates useConfirm(); this is it.
      const ok = await confirm({
        title: 'Turn on default-deny baseline?',
        body: (
          <>
            <p>
              When ON, every IAM principal in this account that doesn&apos;t already have
              an explicit budget will get a default budget at <strong>${Number(limitStr).toFixed(2)}</strong>{' '}
              per <strong>{windowSel.label.split(' ')[0].toLowerCase()}</strong> on its
              first Bedrock invocation.
            </p>
            <p>
              Set conservatively. Existing budgets are not affected. You can mark
              individual budgets as <em>Unlimited</em> on the Budgets page to opt them
              out of this default.
            </p>
          </>
        ),
        confirmLabel: 'Turn on',
        destructive: false,
      });
      if (!ok) return;
    }
    setSubmitting(true);
    setErr(undefined);
    try {
      // BBG-RATELIMITS-DEFAULTS — empty input → null (clear); positive
      // → number (set); invalid → reject before PUT.
      const parseRate = (s: string): number | null => {
        const t = s.trim();
        if (t === '') return null;
        const n = Number(t);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('rpm and tpm must be positive numbers');
        }
        return n;
      };
      const rpmVal = parseRate(rpmStr);
      const tpmVal = parseRate(tpmStr);
      const hasRate = rpmVal !== null || tpmVal !== null;
      const next = await api.putDefaults(config, {
        enabled,
        limitUsd: Number(limitStr),
        window: windowSel.value,
        thresholds,
        rpm: rpmVal,
        tpm: tpmVal,
        // Only send rateWindowSeconds when at least one rate field is
        // set; otherwise pass null to clear any leftover value.
        rateWindowSeconds: hasRate
          ? (Number(rateWindowSel.value) as RateWindowSeconds)
          : null,
      });
      setCfg(next);
      setSavedAt(next.updatedAt ?? new Date().toISOString());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    const inner = <Container>Loading…</Container>;
    if (embedded) return inner;
    return (
      <ContentLayout header={<Header variant="h1">Default budget</Header>}>
        {inner}
      </ContentLayout>
    );
  }

  const pageHeader = (
    <Header
      variant="h1"
      description="Org-wide default-deny baseline. When ON, every IAM principal without an explicit budget gets the default values below on its first Bedrock invocation."
    >
      Default budget
    </Header>
  );
  const tabHeader = (
    <Header
      variant="h2"
      description="Org-wide default-deny baseline. When ON, every IAM principal without an explicit budget gets the default values below on its first Bedrock invocation."
    />
  );
  const body = (
    <>
      {embedded && <Box margin={{ top: 'm', bottom: 's' }}>{tabHeader}</Box>}
      <SpaceBetween size="l">
        <Alert type={enabled ? 'warning' : 'info'} statusIconAriaLabel="status">
          {enabled
            ? 'Default-deny baseline is ON. Principals without an explicit budget WILL be enforced.'
            : 'Default-deny baseline is OFF. Only principals with explicit budgets are enforced — same as today.'}
          {savedAt && <span> Last updated {new Date(savedAt).toLocaleString()}.</span>}
        </Alert>
        <Container>
          <Form
            errorText={err}
            actions={
              <Button variant="primary" loading={submitting} onClick={() => void submit()}>
                Save
              </Button>
            }
          >
            <SpaceBetween size="m">
              <FormField
                label="Master toggle"
                description="OFF by default. Existing deployments keep today's behavior until an operator opts in."
              >
                <Toggle checked={enabled} onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setEnabled(e.detail.checked)}>
                  Default-deny baseline enabled
                </Toggle>
              </FormField>
              <FormField label="Default limit (USD)">
                <Input
                  type="number"
                  value={limitStr}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setLimitStr(e.detail.value)}
                  disabled={!enabled}
                />
              </FormField>
              <FormField label="Default window">
                <Select
                  selectedOption={windowSel}
                  onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
                    const v = (e.detail.selectedOption.value ?? 'monthly') as BudgetWindow;
                    setWindowSel(
                      WINDOW_OPTIONS.find((o) => o.value === v) ?? WINDOW_OPTIONS[0],
                    );
                  }}
                  options={WINDOW_OPTIONS}
                  disabled={!enabled}
                />
              </FormField>
              <FormField
                label="Default thresholds"
                description="Stepped warn/block actions for materialized default budgets. Same shape as a regular budget's thresholds."
              >
                <AttributeEditor<Threshold>
                  items={thresholds}
                  addButtonText="Add threshold"
                  removeButtonText="Remove"
                  onAddButtonClick={() => {
                    const last = thresholds[thresholds.length - 1];
                    setThresholds([
                      ...thresholds,
                      { at: last ? Math.min(last.at + 10, 1000) : 100, action: 'warn' },
                    ]);
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
                          disabled={!enabled}
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
                          disabled={!enabled}
                        />
                      ),
                    },
                  ]}
                />
              </FormField>
              {/* BBG-RATELIMITS-DEFAULTS — propagate optional RPM/TPM to
                  every default-materialized budget. Leave blank to skip.
                  Catches runaway agent loops on principals that get a
                  default budget materialized on first invocation. */}
              <FormField
                label="Default rate limits (optional)"
                description="Propagated to every default-materialized budget so runaway agent loops are caught in seconds, before USD enforcement fires. Leave blank to skip."
              >
                <SpaceBetween size="s">
                  <FormField label="RPM (requests per window)">
                    <Input
                      type="number"
                      value={rpmStr}
                      placeholder="e.g. 60"
                      onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setRpmStr(e.detail.value)}
                      disabled={!enabled}
                    />
                  </FormField>
                  <FormField label="TPM (tokens per window — input + output combined)">
                    <Input
                      type="number"
                      value={tpmStr}
                      placeholder="e.g. 50000"
                      onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setTpmStr(e.detail.value)}
                      disabled={!enabled}
                    />
                  </FormField>
                  <FormField label="Window">
                    <Select
                      selectedOption={rateWindowSel}
                      onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) =>
                        setRateWindowSel(
                          RATE_WINDOW_OPTIONS.find(
                            (o) => o.value === e.detail.selectedOption.value,
                          ) ?? RATE_WINDOW_OPTIONS[0],
                        )
                      }
                      options={RATE_WINDOW_OPTIONS}
                      disabled={!enabled || (rpmStr.trim() === '' && tpmStr.trim() === '')}
                    />
                  </FormField>
                </SpaceBetween>
              </FormField>
            </SpaceBetween>
          </Form>
        </Container>
      </SpaceBetween>
      {dialog}
    </>
  );
  if (embedded) return body;
  return <ContentLayout header={pageHeader}>{body}</ContentLayout>;
};
