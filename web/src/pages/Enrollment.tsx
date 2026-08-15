import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Multiselect, { type MultiselectProps } from '@cloudscape-design/components/multiselect';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import { api } from '../api/client';
import type { BbgConfig } from '../config';

interface EnrollmentProps {
  config: BbgConfig;
}

interface AccountRow {
  id: string;
  name: string;
  email?: string;
  status?: string;
  ouName?: string;
  enrolled: boolean;
  regions: string[];
  /** follow-up: the home (deploy) account is metered locally
   *  by the in-account MeteringStack, not via the cross-account
   *  StackSet. Surfaced as always-enrolled with read-only regions so
   *  operators don't see their own account marked "not enrolled". */
  isHome?: boolean;
}

interface OuRow {
  id: string;
  name: string;
  parentName: string;
  enrolled: boolean;
  regions: string[];
}

// Fallback region list used only if GET /admin/regions fails — the
// authoritative list is fetched dynamically on mount (see useEffect).
const FALLBACK_REGION_OPTIONS = [
  { label: 'us-west-2', value: 'us-west-2' },
  { label: 'us-east-1', value: 'us-east-1' },
  { label: 'us-east-2', value: 'us-east-2' },
  { label: 'eu-west-1', value: 'eu-west-1' },
  { label: 'eu-central-1', value: 'eu-central-1' },
  { label: 'ap-northeast-1', value: 'ap-northeast-1' },
];

export const Enrollment = ({ config }: EnrollmentProps) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [orgData, setOrgData] = useState<Awaited<ReturnType<typeof api.listOrgAccounts>> | undefined>(
    undefined,
  );
  // Bedrock-supported regions fetched from GET /admin/regions on mount.
  // Best-effort: stays on the hardcoded fallback if the call fails.
  const [regionOptions, setRegionOptions] = useState(FALLBACK_REGION_OPTIONS);
  const [accountRows, setAccountRows] = useState<AccountRow[]>([]);
  const [ouRows, setOuRows] = useState<OuRow[]>([]);
  const [statusInstances, setStatusInstances] = useState<
    Awaited<ReturnType<typeof api.getEnrollmentStatus>>['instances']
  >([]);
  // OU StackSet's auto-deployment surface (null when no OUs enrolled).
  const [autoDeployment, setAutoDeployment] = useState<
    Awaited<ReturnType<typeof api.getEnrollmentAutoDeployment>>['ou']
  >(null);
  // whole-org StackSet's auto-deployment surface (null when off).
  const [wholeOrgAd, setWholeOrgAd] = useState<
    Awaited<ReturnType<typeof api.getEnrollmentAutoDeployment>>['wholeOrg']
  >(null);
  // operator's intent for whole-org enrollment. Mutually
  // exclusive with per-OU and per-account enrollments because both
  // StackSets would race to create the same bbg-enforcement role.
  const [wholeOrgEnabled, setWholeOrgEnabled] = useState(false);
  const [wholeOrgRegions, setWholeOrgRegions] = useState<string[]>(['us-west-2']);
  // Home-account metered regions (bbg:meteredRegions). Editable in-UI;
  // hydrated from the SSM config if set, else the deployed env fallback
  // (org.homeMeteredRegions). Changing this redeploys per-region
  // MeteringStacks via the pipeline.
  const [homeRegions, setHomeRegions] = useState<string[]>([]);
  const [homeRegionsDirty, setHomeRegionsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [defaultRegions, setDefaultRegions] = useState<string[]>(['us-west-2']);
  const [pipelineExecution, setPipelineExecution] = useState<string | undefined>(undefined);
  const [partition, setPartition] = useState<{
    externalAccounts: string[];
    orgAccounts: string[];
    ous: string[];
  } | undefined>(undefined);
  const [preflight, setPreflight] = useState<
    Awaited<ReturnType<typeof api.getEnrollmentPreflight>> | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const [org, current, status, pf, ad, regionList] = await Promise.all([
          api.listOrgAccounts(config),
          api.getEnrollmentConfig(config),
          api.getEnrollmentStatus(config).catch(() => ({ instances: [] })),
          api.getEnrollmentPreflight(config).catch(() => undefined),
          api
            .getEnrollmentAutoDeployment(config)
            .catch(() => ({ ou: null as null, wholeOrg: null as null })),
          // Best-effort: fall back to the hardcoded set so the page still
          // works if the regions endpoint is unavailable.
          api.listRegions(config).catch(() => undefined),
        ]);
        setPreflight(pf);
        setAutoDeployment(ad.ou);
        setWholeOrgAd(ad.wholeOrg);
        if (cancelled) return;
        if (regionList && regionList.regions.length > 0) {
          setRegionOptions(regionList.regions.map((r) => ({ label: r, value: r })));
        }
        // hydrate whole-org intent from current SSM config so
        // the toggle reflects what's deployed (and edits to it
        // produce the right diff on Apply).
        if (current.enrolledWholeOrg) {
          setWholeOrgEnabled(true);
          setWholeOrgRegions(current.enrolledWholeOrg.regions);
        } else {
          setWholeOrgEnabled(false);
        }
        setOrgData(org);
        setStatusInstances(status.instances);
        // Account is "enrolled" if it appears in EITHER the SELF_MANAGED
        // (enrolledMemberAccounts, external accounts) OR SERVICE_MANAGED
        // INTERSECTION (enrolledOrgAccounts, in-Org accounts) list.
        // The lambda partitions submissions automatically, so the SPA
        // shouldn't care which bucket each lives in for display.
        const enrolledAcctMap = new Map<string, string[]>();
        for (const a of current.enrolledMemberAccounts) enrolledAcctMap.set(a.accountId, a.regions);
        for (const a of current.enrolledOrgAccounts) enrolledAcctMap.set(a.accountId, a.regions);
        const enrolledOuMap = new Map(current.enrolledOus.map((o) => [o.ouId, o.regions]));
        const homeId = org.homeAccountId;
        // Prefer the SSM-configured meteredRegions (source of truth for the
        // next deploy); fall back to the deployed env value the org endpoint
        // reports. Seeds both the home table row and the editable state.
        const homeRegions = current.meteredRegions ?? org.homeMeteredRegions ?? ['us-west-2'];
        setHomeRegions(homeRegions);
        setHomeRegionsDirty(false);
        // Region defaults derive from what the HOME account meters, not a
        // hardcoded us-west-2: newly-toggled accounts/OUs and a freshly
        // enabled whole-org enrollment most likely want the same regional
        // footprint the operator already chose for home. Each picker stays
        // individually editable after seeding.
        setDefaultRegions(homeRegions);
        if (!current.enrolledWholeOrg) setWholeOrgRegions(homeRegions);
        setAccountRows(
          org.accounts.map((a) => {
            const isHome = a.id === homeId;
            return {
              id: a.id,
              name: a.name,
              email: a.email,
              status: a.status,
              ouName: a.ouName,
              // follow-up: home account is always considered
              // "enrolled" — it's metered by the in-account
              // MeteringStack, not via cross-account StackSet.
              enrolled: isHome || enrolledAcctMap.has(a.id),
              regions: isHome
                ? homeRegions
                : (enrolledAcctMap.get(a.id) ?? homeRegions),
              isHome,
            };
          }),
        );
        const ouNameById = new Map<string, string>([['root', 'Root']]);
        for (const o of org.ous) ouNameById.set(o.id, o.name);
        setOuRows(
          org.ous.map((o) => ({
            id: o.id,
            name: o.name,
            parentName: ouNameById.get(o.parentId) ?? o.parentId,
            enrolled: enrolledOuMap.has(o.id),
            regions: enrolledOuMap.get(o.id) ?? homeRegions,
          })),
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

  const dirty = useMemo(() => {
    if (!orgData) return false;
    return true; // simple — let operator decide; Apply always re-writes.
  }, [orgData]);

  // when whole-org auto-enroll is on, per-OU + per-account
  // selections are kept in SSM unchanged but the synth ignores them
  // (whole-org takes precedence). Operators can curate the underlying
  // selections while whole-org is active and flipping it back off
  // restores the previous deployment shape with no extra clicks.
  const apply = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      if (wholeOrgEnabled && wholeOrgRegions.length === 0) {
        throw new Error(
          'Whole-org auto-enroll is on but no regions are selected. Pick at least one region.',
        );
      }
      if (homeRegionsDirty && homeRegions.length === 0) {
        throw new Error(
          'The home account must meter at least one region. Pick at least one home region.',
        );
      }
      const result = await api.putEnrollmentConfig(config, {
        // send a single picked-accounts list. Lambda
        // partitions in-Org (SERVICE_MANAGED, no bootstrap) vs
        // external (SELF_MANAGED, requires bootstrap CFN) using the
        // Org tree. Home account is filtered out — metered locally.
        enrolledAccounts: accountRows
          .filter((a) => a.enrolled && !a.isHome)
          .map((a) => ({ accountId: a.id, regions: a.regions })),
        enrolledOus: ouRows
          .filter((o) => o.enrolled)
          .map((o) => ({ ouId: o.id, regions: o.regions })),
        enrolledWholeOrg: wholeOrgEnabled
          ? { regions: wholeOrgRegions }
          : undefined,
        // Only send home regions when the operator actually changed them,
        // so a routine account/OU edit never rewrites meteredRegions.
        ...(homeRegionsDirty ? { homeMeteredRegions: homeRegions } : {}),
      });
      setPipelineExecution(result.pipelineExecutionId);
      setPartition(result.partition);
      // Re-fetch status (instance status updates after pipeline runs).
      const status = await api
        .getEnrollmentStatus(config)
        .catch(() => ({ instances: [] }));
      setStatusInstances(status.instances);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (error && !orgData) {
    return (
      <Container header={<Header variant="h1">Enroll accounts</Header>}>
        <Alert type="error" header="Failed to load Organization data">
          {error}
        </Alert>
      </Container>
    );
  }

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h1"
            description={
              orgData?.organizationId
                ? `Organization ${orgData.organizationId} (management account ${orgData.masterAccountId}). Toggle accounts or OUs to enroll, choose regions, then Apply.`
                : 'No AWS Organization detected for this account.'
            }
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Multiselect
                  selectedOptions={defaultRegions.map((r) => ({ label: r, value: r }))}
                  onChange={(e: NonCancelableCustomEvent<MultiselectProps.MultiselectChangeDetail>) =>
                    setDefaultRegions(e.detail.selectedOptions.map((o) => o.value!))
                  }
                  options={regionOptions}
                  placeholder="Default regions"
                  ariaLabel="Default regions for newly-toggled rows"
                />
                <Button variant="primary" loading={saving} disabled={!dirty} onClick={apply}>
                  Apply
                </Button>
              </SpaceBetween>
            }
          >
            Enroll accounts
          </Header>
        }
      >
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(undefined)}>
            {error}
          </Alert>
        )}

        {/* preflight checks. Shown only when at least one
            check failed; OK installs see no banner. */}
        {preflight && preflight.checks.some((c) => c.status === 'fail') && (
          <Alert
            type="warning"
            header={
              preflight.organizationId
                ? 'Org-wide enrollment prerequisites missing'
                : 'No AWS Organization detected'
            }
          >
            {preflight.checks
              .filter((c) => c.status === 'fail')
              .map((c) => (
                <Box key={c.id} margin={{ bottom: 's' }}>
                  <strong>{c.label}:</strong> {c.detail ?? 'Failed'}
                  {c.fix && (
                    <Box variant="code" fontSize="body-s" padding="xxs">
                      {c.fix}
                    </Box>
                  )}
                </Box>
              ))}
            <Box variant="small" color="text-body-secondary">
              Per-account enrollment of external (non-Org) accounts still works after deploying
              the bootstrap CFN — see <code>docs/multi-account-multi-region.md</code> §&nbsp;6.2.1.
            </Box>
          </Alert>
        )}

        {pipelineExecution && (
          <Alert type="success" dismissible onDismiss={() => setPipelineExecution(undefined)}>
            Pipeline execution started: <code>{pipelineExecution}</code>. StackSet update will
            land in ~10–15 minutes; refresh status below to track per-instance progress.
          </Alert>
        )}

        {/* partition summary after Apply. Shows how the server
            split the picked accounts into in-Org (no bootstrap) vs
            external (bootstrap CFN required). */}
        {partition &&
          (partition.externalAccounts.length > 0 ||
            partition.orgAccounts.length > 0 ||
            partition.ous.length > 0) && (
            <Alert type="info" dismissible onDismiss={() => setPartition(undefined)} header="How your selection was applied">
              <ul style={{ marginTop: 0, paddingLeft: '1.2em' }}>
                {partition.orgAccounts.length > 0 && (
                  <li>
                    <strong>{partition.orgAccounts.length} in-Org account(s)</strong> via SERVICE_MANAGED
                    StackSet — no per-member bootstrap CFN required.
                  </li>
                )}
                {partition.ous.length > 0 && (
                  <li>
                    <strong>{partition.ous.length} OU(s)</strong> via SERVICE_MANAGED StackSet with
                    auto-deployment — accounts joining these OUs later auto-enroll.
                  </li>
                )}
                {partition.externalAccounts.length > 0 && (
                  <li>
                    <strong>{partition.externalAccounts.length} external account(s)</strong>{' '}
                    (outside this Org) via SELF_MANAGED StackSet —{' '}
                    <em>each requires AWSCloudFormationStackSetExecutionRole bootstrap CFN</em>{' '}
                    (see <code>docs/multi-account-multi-region.md</code> §&nbsp;6.2.1) before the
                    StackSet instance lands successfully.
                  </li>
                )}
              </ul>
            </Alert>
          )}

        {/* whole-org auto-enroll Toggle. When ON, the per-OU and
            per-account tabs are visually disabled because both StackSet
            paths would race to provision the same bbg-enforcement IAM
            role. The Lambda also enforces this server-side. */}
        <Box margin={{ top: 'm', bottom: 'm' }} padding="m">
          <SpaceBetween size="s">
            <Header
              variant="h2"
              description={
                wholeOrgEnabled
                  ? 'A SERVICE_MANAGED StackSet targets the Org root with accountFilterType=DIFFERENCE excluding this home account, so every other Org account auto-receives the BBG member stack within ~10 min, including new accounts joining later. Whole-org takes precedence over the per-OU and per-account selections below — those stay in SSM and reactivate when whole-org is turned off.'
                  : 'Toggle on to enroll every account in this Organization at once (excluding the home account, which is metered locally). Whole-org takes precedence over the per-OU and per-account selections below — flipping it on suspends those StackSets without losing the selections.'
              }
              actions={
                <Toggle
                  checked={wholeOrgEnabled}
                  onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setWholeOrgEnabled(e.detail.checked)}
                >
                  {wholeOrgEnabled ? 'On' : 'Off'}
                </Toggle>
              }
            >
              Whole-org auto-enroll
            </Header>
            {wholeOrgEnabled && (
              <SpaceBetween size="xs">
                <Box variant="awsui-key-label">Regions</Box>
                <Multiselect
                  selectedOptions={wholeOrgRegions.map((r) => ({ label: r, value: r }))}
                  onChange={(e: NonCancelableCustomEvent<MultiselectProps.MultiselectChangeDetail>) =>
                    setWholeOrgRegions(e.detail.selectedOptions.map((o) => o.value!))
                  }
                  options={regionOptions}
                  placeholder="Pick regions to meter in every Org member"
                  ariaLabel="Whole-org regions"
                />
              </SpaceBetween>
            )}
            {wholeOrgAd && wholeOrgAd.enabled && (
              <Alert type="success" header="Whole-org auto-deployment is live">
                <Box>
                  <strong>StackSet:</strong> <code>{wholeOrgAd.stackSetName}</code>
                </Box>
                <Box>
                  <strong>Targeted:</strong> Org root (
                  {wholeOrgAd.organizationalUnitIds.map((id) => (
                    <code key={id} style={{ marginRight: '0.5em' }}>
                      {id}
                    </code>
                  ))}
                  ) — accountFilterType=DIFFERENCE excludes home + extras.
                </Box>
                <Box>
                  <strong>Retain on account removal:</strong>{' '}
                  {wholeOrgAd.retainStacksOnAccountRemoval ? 'yes' : 'no'}
                </Box>
              </Alert>
            )}
          </SpaceBetween>
        </Box>

        <Tabs
          tabs={[
            {
              id: 'accounts',
              label: `Accounts (${accountRows.filter((r) => r.enrolled).length}/${accountRows.length})`,
              content: (
                <SpaceBetween size="m">
                  <Alert type="info">
                    The <strong>home account</strong> row is metered in-account (not via a
                    cross-account StackSet). Its <strong>Regions</strong> are editable —
                    each region you add gets its own MeteringStack on the next pipeline
                    deploy (~10–15 min). New regions are CDK-bootstrapped automatically by
                    the pipeline before deploying (~2 min extra per region). The home
                    region is always metered and can't be removed.
                  </Alert>
                  <Table
                  items={accountRows}
                  columnDefinitions={[
                    {
                      id: 'enrolled',
                      header: 'Enrolled',
                      cell: (a) =>
                        a.isHome ? (
                          // follow-up: home account is metered
                          // by the in-account MeteringStack — toggle is
                          // read-only "always enrolled".
                          <StatusIndicator type="success">Home (always)</StatusIndicator>
                        ) : (
                          <Toggle
                            checked={a.enrolled}
                            onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) =>
                              setAccountRows((rows) =>
                                rows.map((r) =>
                                  r.id === a.id
                                    ? {
                                        ...r,
                                        enrolled: e.detail.checked,
                                        regions: e.detail.checked ? defaultRegions : r.regions,
                                      }
                                    : r,
                                ),
                              )
                            }
                          />
                        ),
                    },
                    { id: 'name', header: 'Name', cell: (a) => a.name },
                    { id: 'id', header: 'Account ID', cell: (a) => <code>{a.id}</code> },
                    { id: 'email', header: 'Email', cell: (a) => a.email ?? '—' },
                    { id: 'ou', header: 'OU', cell: (a) => a.ouName ?? '—' },
                    {
                      id: 'status',
                      header: 'Org status',
                      cell: (a) =>
                        a.status === 'ACTIVE' ? (
                          <StatusIndicator type="success">Active</StatusIndicator>
                        ) : (
                          <StatusIndicator type="warning">{a.status ?? '?'}</StatusIndicator>
                        ),
                    },
                    {
                      id: 'regions',
                      header: 'Regions',
                      cell: (a) =>
                        a.isHome ? (
                          // Home regions = bbg:meteredRegions. Editable: each
                          // region gets an in-account MeteringStack on the
                          // next deploy. The API force-includes the home
                          // region and blocks un-bootstrapped regions (409).
                          <Multiselect
                            selectedOptions={homeRegions.map((r) => ({ label: r, value: r }))}
                            onChange={(e: NonCancelableCustomEvent<MultiselectProps.MultiselectChangeDetail>) => {
                              setHomeRegions(e.detail.selectedOptions.map((o) => o.value!));
                              setHomeRegionsDirty(true);
                            }}
                            options={regionOptions}
                            placeholder="Home metered regions"
                            ariaLabel="Home-account metered regions"
                          />
                        ) : (
                          <Multiselect
                            selectedOptions={a.regions.map((r) => ({ label: r, value: r }))}
                            onChange={(e: NonCancelableCustomEvent<MultiselectProps.MultiselectChangeDetail>) =>
                              setAccountRows((rows) =>
                                rows.map((r) =>
                                  r.id === a.id
                                    ? { ...r, regions: e.detail.selectedOptions.map((o) => o.value!) }
                                    : r,
                                ),
                              )
                            }
                            options={regionOptions}
                            disabled={!a.enrolled}
                            placeholder="Regions"
                          />
                        ),
                    },
                  ]}
                  variant="embedded"
                  empty="No accounts found in this Organization"
                  />
                </SpaceBetween>
              ),
            },
            {
              id: 'ous',
              label: `Organizational Units (${ouRows.filter((r) => r.enrolled).length}/${ouRows.length})`,
              content: (
                <SpaceBetween size="m">
                  <Alert type="info">
                    Enrolling an OU deploys the BBG member stack to every account currently in that
                    OU and auto-deploys to any account joining the OU later. Requires that the home
                    account is the Org management account (or a delegated CFN StackSet admin).
                  </Alert>
                  {/* live auto-deployment surface for the OU StackSet. */}
                  {autoDeployment && (
                    <Alert
                      type={autoDeployment.enabled ? 'success' : 'warning'}
                      header={`OU StackSet ${autoDeployment.stackSetName}`}
                    >
                      <Box>
                        <strong>Auto-deployment:</strong>{' '}
                        {autoDeployment.enabled ? 'enabled' : 'disabled'} —{' '}
                        {autoDeployment.enabled
                          ? 'new accounts joining the OUs below will receive the member stack within ~10 min.'
                          : 'auto-enrollment is OFF; new OU members must be enrolled manually.'}
                      </Box>
                      <Box>
                        <strong>Retain on account removal:</strong>{' '}
                        {autoDeployment.retainStacksOnAccountRemoval
                          ? 'yes (member stack stays after account leaves the OU)'
                          : 'no (member stack is detached when the account leaves the OU)'}
                      </Box>
                      {autoDeployment.organizationalUnitIds.length > 0 && (
                        <Box>
                          <strong>Targeted OUs:</strong>{' '}
                          {autoDeployment.organizationalUnitIds.map((id) => (
                            <code key={id} style={{ marginRight: '0.5em' }}>
                              {id}
                            </code>
                          ))}
                        </Box>
                      )}
                    </Alert>
                  )}
                  <Table
                    items={ouRows}
                    columnDefinitions={[
                      {
                        id: 'enrolled',
                        header: 'Enrolled',
                        cell: (o) => (
                          <Toggle
                            checked={o.enrolled}
                            onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) =>
                              setOuRows((rows) =>
                                rows.map((r) =>
                                  r.id === o.id
                                    ? {
                                        ...r,
                                        enrolled: e.detail.checked,
                                        regions: e.detail.checked ? defaultRegions : r.regions,
                                      }
                                    : r,
                                ),
                              )
                            }
                          />
                        ),
                      },
                      { id: 'name', header: 'OU name', cell: (o) => o.name },
                      { id: 'id', header: 'OU ID', cell: (o) => <code>{o.id}</code> },
                      { id: 'parent', header: 'Parent', cell: (o) => o.parentName },
                      {
                        id: 'regions',
                        header: 'Regions',
                        cell: (o) => (
                          <Multiselect
                            selectedOptions={o.regions.map((r) => ({ label: r, value: r }))}
                            onChange={(e: NonCancelableCustomEvent<MultiselectProps.MultiselectChangeDetail>) =>
                              setOuRows((rows) =>
                                rows.map((r) =>
                                  r.id === o.id
                                    ? {
                                        ...r,
                                        regions: e.detail.selectedOptions.map((o2) => o2.value!),
                                      }
                                    : r,
                                ),
                              )
                            }
                            options={regionOptions}
                            disabled={!o.enrolled}
                            placeholder="Regions"
                          />
                        ),
                      },
                    ]}
                    variant="embedded"
                    empty="No OUs found in this Organization"
                  />
                </SpaceBetween>
              ),
            },
            {
              id: 'status',
              label: `StackSet status (${statusInstances.length})`,
              content: (
                <Table
                  items={statusInstances}
                  columnDefinitions={[
                    { id: 'account', header: 'Account', cell: (i) => <code>{i.account}</code> },
                    { id: 'region', header: 'Region', cell: (i) => i.region },
                    {
                      id: 'source',
                      header: 'Source',
                      cell: (i) => {
                        // which StackSet shipped the instance.
                        // OU-targeted is the path that auto-enrolls
                        // new accounts when they join.
                        const label = {
                          'self-managed-external': 'External (SELF_MANAGED)',
                          'service-managed-account': 'In-Org account',
                          'service-managed-ou': 'OU auto-deploy',
                          'service-managed-whole-org': 'Whole-org auto-deploy',
                        }[i.source];
                        return label;
                      },
                    },
                    {
                      id: 'status',
                      header: 'Status',
                      cell: (i) => {
                        const t =
                          i.status === 'CURRENT' || i.status === 'SUCCEEDED'
                            ? 'success'
                            : i.status === 'OUTDATED' || i.status === 'PENDING'
                            ? 'in-progress'
                            : 'warning';
                        return <StatusIndicator type={t}>{i.status ?? 'unknown'}</StatusIndicator>;
                      },
                    },
                    { id: 'reason', header: 'Reason', cell: (i) => i.reason ?? '—' },
                  ]}
                  variant="embedded"
                  empty="No StackSet instances yet — Apply enrollments above to deploy."
                />
              ),
            },
          ]}
        />
      </Container>
    </SpaceBetween>
  );
};
