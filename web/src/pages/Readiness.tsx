import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator, {
  type StatusIndicatorProps,
} from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { api, type ReadinessFindings, type ReadinessOrgFindings, type ReadinessPrincipal } from '../api/client';
import { useScope, formatAccount } from '../auth/scope-context';
import type { BbgConfig } from '../config';

type JobState = 'idle' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

const POLL_INTERVAL_MS = 3000;

/** Map the audit's readiness verdict to a Cloudscape status indicator. */
const readinessIndicator = (
  verdict: ReadinessFindings['readiness'],
): { type: StatusIndicatorProps.Type; label: string } => {
  switch (verdict) {
    case 'GREEN':
      return { type: 'success', label: 'GREEN — ready for Tier 1' };
    case 'YELLOW':
      return { type: 'warning', label: 'YELLOW — cleanup recommended' };
    case 'RED':
      return { type: 'error', label: 'RED — Tier 2 first' };
    default:
      return { type: 'pending', label: 'UNKNOWN — insufficient data' };
  }
};

const usd = (n: number | undefined): string =>
  `$${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const Readiness = ({ config }: { config: BbgConfig }) => {
  const scope = useScope();
  const [state, setState] = useState<JobState>('idle');
  const [auditScope, setAuditScope] = useState<'account' | 'org'>('account');
  const [findings, setFindings] = useState<ReadinessFindings | undefined>();
  const [orgFindings, setOrgFindings] = useState<ReadinessOrgFindings | undefined>();
  const [setupScript, setSetupScript] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const pollRef = useRef<number | undefined>(undefined);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== undefined) {
      window.clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
  }, []);

  // Clear the interval if the component unmounts mid-run.
  useEffect(() => stopPolling, [stopPolling]);

  const run = useCallback(async () => {
    setError(undefined);
    setFindings(undefined);
    setOrgFindings(undefined);
    setSetupScript(undefined);
    setState('RUNNING');
    try {
      const { jobId } = await api.startReadiness(config);
      stopPolling();
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const res = await api.pollReadiness(config, jobId);
            if (res.state === 'SUCCEEDED') {
              stopPolling();
              setAuditScope(res.scope ?? 'account');
              setFindings(res.findings);
              setOrgFindings(res.orgFindings);
              setSetupScript(res.setupScript);
              setState('SUCCEEDED');
            } else if (res.state === 'FAILED') {
              stopPolling();
              setError(res.error ?? 'The readiness audit failed.');
              setState('FAILED');
            }
            // RUNNING / NOT_FOUND (eventual consistency) — keep polling.
          } catch (err) {
            stopPolling();
            setError((err as Error).message);
            setState('FAILED');
          }
        })();
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setError((err as Error).message);
      setState('FAILED');
    }
  }, [config, stopPolling]);

  const downloadSetupScript = useCallback(() => {
    if (!setupScript || !findings) return;
    const blob = new Blob([setupScript], { type: 'text/x-shellscript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `setup-tier1-${findings.account_id}.sh`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [setupScript, findings]);

  const principals: ReadinessPrincipal[] = findings?.candidate_principals ?? [];
  const verdict = findings ? readinessIndicator(findings.readiness) : undefined;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="One-click pre-onboarding check. Runs a read-only audit of this account's Bedrock spend, IAM principals, tag posture, and resources, then scores Tier 1 IAM Principal Cost Tracking readiness."
          actions={
            <Button
              variant="primary"
              iconName="status-positive"
              loading={state === 'RUNNING'}
              onClick={() => void run()}
            >
              {state === 'RUNNING' ? 'Running…' : 'Run readiness check'}
            </Button>
          }
        >
          Readiness
        </Header>
      }
    >
      <SpaceBetween size="l">
        {state === 'idle' && (
          <Alert type="info" header="Run a readiness check">
            This scans the BBG home account across all Bedrock regions. A full scan can take
            a couple of minutes — the page polls and updates automatically when it finishes.
          </Alert>
        )}

        {state === 'RUNNING' && (
          <Container>
            <Box textAlign="center" padding="l">
              <SpaceBetween size="s" alignItems="center">
                <Spinner size="large" />
                <Box variant="p" color="text-status-info">
                  Auditing this account's Bedrock footprint — spend, principals, tags, and
                  resources across all regions…
                </Box>
              </SpaceBetween>
            </Box>
          </Container>
        )}

        {state === 'FAILED' && error && (
          <Alert type="error" header="Readiness check failed">
            {error}
          </Alert>
        )}

        {state === 'SUCCEEDED' && auditScope === 'org' && orgFindings && (
          <SpaceBetween size="l">
            <Container
              header={
                <Header
                  variant="h2"
                  description={`Organization sweep from management account ${orgFindings.management_account_id}${
                    orgFindings.organization_id ? ` (${orgFindings.organization_id})` : ''
                  }.`}
                >
                  Organization readiness
                </Header>
              }
            >
              <ColumnLayout columns={4} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">Management account</Box>
                  <Box>
                    <code>{orgFindings.management_account_id}</code>
                  </Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Accounts audited</Box>
                  <Box>{(orgFindings.accounts ?? []).length}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Skipped</Box>
                  <Box>{(orgFindings.accounts_skipped ?? []).length}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Org spend (90d)</Box>
                  <Box>{usd(orgFindings.total_org_bedrock_spend_90d_usd)}</Box>
                </div>
              </ColumnLayout>
            </Container>

            <Table
              header={
                <Header variant="h2" counter={`(${(orgFindings.accounts ?? []).length})`}>
                  Per-account readiness
                </Header>
              }
              variant="container"
              items={[...(orgFindings.accounts ?? [])].sort(
                (a, b) => (b.total_bedrock_spend_90d_usd ?? 0) - (a.total_bedrock_spend_90d_usd ?? 0),
              )}
              columnDefinitions={[
                {
                  id: 'account',
                  header: 'Account',
                  cell: (a) => <code>{a.account_id}</code>,
                  sortingField: 'account_id',
                },
                { id: 'name', header: 'Name', cell: (a) => a.account_name ?? '—' },
                {
                  id: 'readiness',
                  header: 'Readiness',
                  cell: (a) => {
                    const v = readinessIndicator(a.readiness);
                    return <StatusIndicator type={v.type}>{a.readiness}</StatusIndicator>;
                  },
                  sortingField: 'readiness',
                },
                {
                  id: 'spend',
                  header: 'Spend (90d)',
                  cell: (a) => usd(a.total_bedrock_spend_90d_usd),
                  sortingField: 'total_bedrock_spend_90d_usd',
                },
                {
                  id: 'principals',
                  header: 'Bedrock-capable principals',
                  cell: (a) => a.tag_coverage?.total_principals ?? a.candidate_principals?.length ?? 0,
                },
              ]}
              empty="No member accounts audited"
            />

            {(orgFindings.accounts_skipped?.length ?? 0) > 0 && (
              <Alert type="warning" header={`Skipped ${orgFindings.accounts_skipped?.length} account(s)`}>
                <SpaceBetween size="xxs">
                  {orgFindings.accounts_skipped?.map((s, i) => (
                    <Box key={i} variant="p">
                      <code>{s.account_id}</code> {s.name ? `(${s.name})` : ''} — {s.reason ?? 'unknown'}
                    </Box>
                  ))}
                </SpaceBetween>
              </Alert>
            )}
          </SpaceBetween>
        )}

        {state === 'SUCCEEDED' && auditScope === 'account' && findings && verdict && (
          <SpaceBetween size="l">
            <Container
              header={
                <Header
                  variant="h2"
                  description={findings.readiness_reasoning}
                  actions={
                    setupScript ? (
                      <Button iconName="download" onClick={downloadSetupScript}>
                        Download setup-tier1.sh
                      </Button>
                    ) : undefined
                  }
                >
                  Tier 1 readiness
                </Header>
              }
            >
              <SpaceBetween size="l">
                <StatusIndicator type={verdict.type}>{verdict.label}</StatusIndicator>
                <ColumnLayout columns={4} variant="text-grid">
                  <div>
                    <Box variant="awsui-key-label">Account</Box>
                    <Box>
                      <code>{formatAccount(findings.account_id, scope.accountNames)}</code>
                    </Box>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Bedrock-capable principals</Box>
                    <Box>{findings.tag_coverage?.total_principals ?? principals.length}</Box>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Spend (30d)</Box>
                    <Box>{usd(findings.total_bedrock_spend_30d_usd)}</Box>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Active regions</Box>
                    <Box>{(findings.bedrock_regions_with_activity ?? []).length}</Box>
                  </div>
                </ColumnLayout>
              </SpaceBetween>
            </Container>

            {(findings.recommendations?.length ?? 0) > 0 && (
              <Container header={<Header variant="h2">Recommendations</Header>}>
                <SpaceBetween size="xs">
                  {findings.recommendations?.map((r, i) => (
                    <Box key={i} variant="p">
                      {i + 1}. {r}
                    </Box>
                  ))}
                </SpaceBetween>
              </Container>
            )}

            <Table
              header={
                <Header variant="h2" counter={`(${principals.length})`}>
                  Bedrock-capable IAM principals
                </Header>
              }
              variant="container"
              items={principals}
              columnDefinitions={[
                { id: 'name', header: 'Name', cell: (p) => p.name, sortingField: 'name' },
                {
                  id: 'type',
                  header: 'Type',
                  cell: (p) => p.principal_type,
                  sortingField: 'principal_type',
                },
                {
                  id: 'access',
                  header: 'Access',
                  cell: (p) =>
                    p.access_via === 'broad' ? (
                      <Badge color="grey">Admin wildcard</Badge>
                    ) : (
                      <Badge color="green">Bedrock policy</Badge>
                    ),
                  sortingField: 'access_via',
                },
                {
                  id: 'sso',
                  header: 'Identity Center?',
                  cell: (p) => (p.is_identity_center_role ? 'yes' : '—'),
                },
                {
                  id: 'tags',
                  header: 'Tags',
                  cell: (p) => {
                    const entries = Object.entries(p.tags ?? {});
                    return entries.length
                      ? entries.map(([k, v]) => `${k}=${v}`).join(', ')
                      : '—';
                  },
                },
                { id: 'arn', header: 'ARN', cell: (p) => <code>{p.arn}</code> },
              ]}
              empty="No Bedrock-capable principals found in this account"
            />

            {(findings.warnings?.length ?? 0) > 0 && (
              <Alert type="warning" header="Warnings">
                <SpaceBetween size="xxs">
                  {findings.warnings?.map((w, i) => (
                    <Box key={i} variant="p">
                      {w}
                    </Box>
                  ))}
                </SpaceBetween>
              </Alert>
            )}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
};
