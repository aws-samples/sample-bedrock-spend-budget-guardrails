import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import { parse, stringify } from 'yaml';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useTheme } from '../theme/ThemeProvider';
import { api, type BudgetRow, type DefaultsConfig } from '../api/client';
import type { BbgConfig } from '../config';

const STARTER_MANIFEST = `apiVersion: bbg/v1
kind: BudgetSet
metadata:
  description: Edit me, then click Apply.
defaults:
  enabled: false
  limitUsd: 100
  window: monthly
  thresholds:
    - { at: 80, action: warn }
    - { at: 100, action: block }
budgets: []
delete: []
`;

interface DiffEntry {
  principal: string;
  target: string;
}
type Change = 'created' | 'updated' | 'removed';
interface DiffRow extends DiffEntry {
  change: Change;
}
interface ApplyResult {
  dryRun: boolean;
  diff: {
    created: DiffEntry[];
    updated: DiffEntry[];
    unchanged: DiffEntry[];
    removed: DiffEntry[];
    defaultsChanged: boolean;
  };
}

const flattenDiff = (r: ApplyResult): DiffRow[] => [
  ...r.diff.created.map((e) => ({ ...e, change: 'created' as const })),
  ...r.diff.updated.map((e) => ({ ...e, change: 'updated' as const })),
  ...r.diff.removed.map((e) => ({ ...e, change: 'removed' as const })),
];

const manifestFromCurrent = (
  budgets: BudgetRow[],
  defaults: DefaultsConfig | undefined,
): string => {
  const obj = {
    apiVersion: 'bbg/v1',
    kind: 'BudgetSet',
    metadata: { description: 'Exported from current state.' },
    defaults: defaults
      ? {
          enabled: Boolean(defaults.enabled),
          limitUsd: Number(defaults.limitUsd ?? 0),
          window: defaults.window ?? 'monthly',
          thresholds: defaults.thresholds ?? [],
        }
      : undefined,
    budgets: budgets.map((b) => ({
      principal: b.principal,
      target: b.target,
      ...(b.unlimited
        ? { unlimited: true }
        : { limitUsd: Number(b.limitUsd ?? 0) }),
      window: b.window ?? 'monthly',
      ...(b.thresholds && b.thresholds.length > 0 ? { thresholds: b.thresholds } : {}),
      enabled: b.enabled,
    })),
  };
  return stringify(obj, { indent: 2 });
};

const CHANGE_PREFIX: Record<Change, string> = {
  created: '+',
  updated: '~',
  removed: '−',
};
const CHANGE_TYPE: Record<Change, 'success' | 'warning' | 'error'> = {
  created: 'success',
  updated: 'warning',
  removed: 'error',
};

export const AdminManifest = ({
  config,
  embedded = false,
}: {
  config: BbgConfig;
  embedded?: boolean;
}) => {
  const { choice } = useTheme();
  // Resolve 'system' to the actual current preference so CodeMirror's
  // theme matches the page chrome.
  const isDark =
    choice === 'dark' ||
    (choice === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [yamlText, setYamlText] = useState<string>(STARTER_MANIFEST);
  const [currentSnapshot, setCurrentSnapshot] = useState<string>(STARTER_MANIFEST);
  const [parseErr, setParseErr] = useState<string | undefined>();
  const [serverErr, setServerErr] = useState<string | undefined>();
  const [diff, setDiff] = useState<ApplyResult | undefined>();
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Pre-fill the editor from current state on mount.
  useEffect(() => {
    void (async () => {
      try {
        const [b, d] = await Promise.all([
          api.listBudgets(config),
          api.getDefaults(config),
        ]);
        const snap = manifestFromCurrent(b.items, d);
        setYamlText(snap);
        setCurrentSnapshot(snap);
      } catch {
        // Keep starter manifest if either call fails.
      }
    })();
  }, [config]);

  // Live, debounced YAML parse — surfaces syntax errors as the user types
  // instead of waiting for the dry-run click. Pure parse-only check; the
  // server still does the structured validation on apply.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        parse(yamlText);
        setParseErr(undefined);
      } catch (e) {
        setParseErr((e as Error).message);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [yamlText]);

  const dryRun = async () => {
    setServerErr(undefined);
    let obj;
    try {
      obj = parse(yamlText);
    } catch (e) {
      setParseErr((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      const result = (await api.applyManifest(config, obj, true)) as ApplyResult;
      setDiff(result);
      setShowConfirm(true);
    } catch (e) {
      setServerErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    let obj;
    try {
      obj = parse(yamlText);
    } catch (e) {
      setParseErr((e as Error).message);
      setShowConfirm(false);
      return;
    }
    setBusy(true);
    setServerErr(undefined);
    try {
      const result = (await api.applyManifest(config, obj, false)) as ApplyResult;
      setDiff(result);
      setShowConfirm(false);
      // Refresh the snapshot so subsequent "Reset to current state" matches
      // post-apply state.
      const [b, d] = await Promise.all([
        api.listBudgets(config),
        api.getDefaults(config),
      ]);
      setCurrentSnapshot(manifestFromCurrent(b.items, d));
    } catch (e) {
      setServerErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyYaml = async () => {
    try {
      await navigator.clipboard.writeText(yamlText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — silently no-op.
    }
  };

  const diffSummary = diff
    ? `${diff.diff.created.length} created · ${diff.diff.updated.length} updated · ${diff.diff.removed.length} removed · ${diff.diff.unchanged.length} unchanged${diff.diff.defaultsChanged ? ' · defaults updated' : ''}`
    : '';

  const diffRows = useMemo(() => (diff ? flattenDiff(diff) : []), [diff]);

  const editorTheme = isDark ? oneDark : 'light';

  const pageHeader = (
    <Header
      variant="h1"
      description="Author your budgets as a YAML/JSON manifest. Versioned in git, applied via Apply (dry-run + diff first). The shape mirrors the per-budget UI on the Budgets tab."
    >
      Manifest
    </Header>
  );

  const tabHeader = (
    <Header variant="h2" description="Author your budgets as a YAML/JSON manifest. Versioned in git, applied via Apply (dry-run + diff first). The shape mirrors the per-budget UI on the Budgets tab." />
  );

  const body = (
    <>
      {embedded && <Box margin={{ top: 'm', bottom: 's' }}>{tabHeader}</Box>}
      <SpaceBetween size="l">
        {parseErr && (
          <Alert type="error" header="YAML parse error">
            {parseErr}
          </Alert>
        )}
        {serverErr && (
          <Alert type="error" header="Server rejected the manifest">
            {serverErr}
          </Alert>
        )}
        {diff && !diff.dryRun && (
          <Alert type="success" header="Applied">
            {diffSummary}
          </Alert>
        )}
        <Container>
          <Form
            actions={
              <SpaceBetween size="xs" direction="horizontal">
                <Button
                  iconName="copy"
                  onClick={() => void copyYaml()}
                  disabled={busy}
                >
                  {copied ? 'Copied!' : 'Copy YAML'}
                </Button>
                <Button
                  onClick={() => setYamlText(currentSnapshot)}
                  disabled={busy}
                >
                  Reset to current state
                </Button>
                <Button onClick={() => setYamlText(STARTER_MANIFEST)} disabled={busy}>
                  Reset to template
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void dryRun()}
                  loading={busy}
                  disabled={Boolean(parseErr)}
                >
                  Dry-run + diff
                </Button>
              </SpaceBetween>
            }
          >
            <CodeMirror
              value={yamlText}
              height="540px"
              theme={editorTheme}
              extensions={[yamlLang()]}
              onChange={setYamlText}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                foldGutter: true,
                bracketMatching: true,
                indentOnInput: true,
              }}
            />
          </Form>
        </Container>
        <Box variant="small">
          See <code>docs/declarative-budgets.md</code> for the full schema reference and an
          AI-authoring workflow.
        </Box>
      </SpaceBetween>
      {showConfirm && diff && (
        <Modal
          visible
          size="large"
          onDismiss={() => setShowConfirm(false)}
          header="Confirm apply"
          footer={
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => setShowConfirm(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void apply()} loading={busy}>
                Apply
              </Button>
            </SpaceBetween>
          }
        >
          <SpaceBetween size="m">
            <Box>
              <SpaceBetween size="xs" direction="horizontal">
                <Badge color="green">+ {diff.diff.created.length} created</Badge>
                <Badge color="blue">~ {diff.diff.updated.length} updated</Badge>
                <Badge color="red">− {diff.diff.removed.length} removed</Badge>
                <Badge color="grey">{diff.diff.unchanged.length} unchanged</Badge>
                {diff.diff.defaultsChanged && (
                  <Badge color="severity-medium">defaults updated</Badge>
                )}
              </SpaceBetween>
            </Box>
            {diffRows.length > 0 ? (
              <Table
                variant="embedded"
                items={diffRows}
                columnDefinitions={[
                  {
                    id: 'change',
                    header: 'Change',
                    width: 130,
                    cell: (r) => (
                      <StatusIndicator type={CHANGE_TYPE[r.change]}>
                        {CHANGE_PREFIX[r.change]} {r.change}
                      </StatusIndicator>
                    ),
                  },
                  { id: 'principal', header: 'Principal', cell: (r) => r.principal },
                  { id: 'target', header: 'Target', cell: (r) => r.target },
                ]}
              />
            ) : diff.diff.defaultsChanged ? (
              <Alert type="info">Only the default-budget config will change.</Alert>
            ) : (
              <Alert type="info">No changes to apply.</Alert>
            )}
          </SpaceBetween>
        </Modal>
      )}
    </>
  );

  if (embedded) return body;
  return <ContentLayout header={pageHeader}>{body}</ContentLayout>;
};
