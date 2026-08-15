import { useEffect, useMemo, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import { useNavigate } from 'react-router';
import Button from '@cloudscape-design/components/button';
import CollectionPreferences from '@cloudscape-design/components/collection-preferences';
import ContentLayout from '@cloudscape-design/components/content-layout';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import Header from '@cloudscape-design/components/header';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useCollection } from '@cloudscape-design/collection-hooks';
import { api } from '../api/client';
import { useScope, formatAccount } from '../auth/scope-context';
import { accountFromPrincipal } from '../components/canonicalArn';
import { PrincipalCell } from '../components/Principal';
import { PrincipalActivityModal } from '../components/PrincipalActivityModal';
import type { BbgConfig } from '../config';

interface IdentityRow {
  principal: string;
  principalType?: string;
  principalArn?: string;
  ssoUser?: string;
  firstSeen?: string;
  lastSeen?: string;
  eventTime?: string;
}

/** Time-range presets for the lookback selector. Hours, capped at 30 days. */
const periodOptions: ReadonlyArray<SelectProps.Option & { hours: number }> = [
  { label: 'Last 1 hour', value: '1', hours: 1 },
  { label: 'Last 6 hours', value: '6', hours: 6 },
  { label: 'Last 24 hours', value: '24', hours: 24 },
  { label: 'Last 7 days', value: '168', hours: 168 },
  { label: 'Last 30 days', value: '720', hours: 720 },
];

export const Identities = ({ config }: { config: BbgConfig }) => {
  const scope = useScope();
  const [rows, setRows] = useState<IdentityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [period, setPeriod] = useState<SelectProps.Option>(periodOptions[0]);
  // principal whose activity timeline is open in the modal.
  const [activityPrincipal, setActivityPrincipal] = useState<string | undefined>();
  // Column visibility. The full IAM ARN is hidden by default — it's the widest
  // value (100+ chars) and would force the table past the viewport; users can
  // re-enable it (or hide sso/firstSeen) via the preferences gear. Also lets
  // wrapLines toggle. Uses columnDisplay (visibleColumns is deprecated).
  const [columnDisplay, setColumnDisplay] = useState<
    ReadonlyArray<{ id: string; visible: boolean }>
  >([
    { id: 'principal', visible: true },
    { id: 'type', visible: true },
    { id: 'account', visible: true },
    { id: 'arn', visible: false },
    { id: 'sso', visible: true },
    { id: 'firstSeen', visible: true },
    { id: 'lastSeen', visible: true },
    { id: 'actions', visible: true },
  ]);
  const [wrapLines, setWrapLines] = useState(false);
  const navigate = useNavigate();

  // Stable comparator instance for the Account column. Cloudscape matches the
  // active sort column by function IDENTITY, so an inline arrow (recreated each
  // render) breaks the sort toggle and warns. Memoize it, keyed on the friendly
  // account-name map it reads. Sorts by the DISPLAYED label, not the raw ARN.
  const accountComparator = useMemo(() => {
    const label = (r: IdentityRow) =>
      formatAccount(accountFromPrincipal(r.principalArn ?? r.principal) ?? '', scope.accountNames);
    return (a: IdentityRow, b: IdentityRow) => label(a).localeCompare(label(b));
  }, [scope.accountNames]);

  // Client-side sorting over the fetched rows (six columns declare a sorting
  // field; without a collection they render inert). Default: most-recently
  // invoked first.
  const collection = useCollection<IdentityRow>(rows, {
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: 'lastSeen' },
        isDescending: true,
      },
    },
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const hours = Number(period.value ?? '1');
    void (async () => {
      try {
        const data = await api.listIdentities(config, hours);
        if (!cancelled) setRows(data.items as IdentityRow[]);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, period]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={`Distinct Bedrock callers seen by the meter (canonicalized from CloudTrail userIdentity) within the selected window. Quiet principals roll off after 30 days of inactivity.`}
          counter={`(${rows.length})`}
          actions={
            <Select
              selectedOption={period}
              onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => setPeriod(e.detail.selectedOption)}
              options={periodOptions}
              ariaLabel="Lookback window"
              expandToViewport
            />
          }
        >
          Identities
        </Header>
      }
    >
      {error && (
        <StatusIndicator type="error">Error: {error}</StatusIndicator>
      )}
      <Table
        {...collection.collectionProps}
        items={collection.items}
        loading={loading}
        loadingText="Loading"
        variant="container"
        // resizableColumns switches on fixed table layout — without it the
        // browser uses auto layout and long ARNs blow the table past the
        // viewport. wrapLines + stickyColumns keep the ends readable if the
        // user re-enables wide columns; stickyHeader for the long list.
        resizableColumns
        wrapLines={wrapLines}
        stickyHeader
        trackBy="principal"
        stickyColumns={{ first: 1, last: 1 }}
        columnDisplay={columnDisplay}
        ariaLabels={{ tableLabel: 'Identities' }}
        preferences={
          <CollectionPreferences
            title="Preferences"
            confirmLabel="Confirm"
            cancelLabel="Cancel"
            preferences={{ wrapLines, contentDisplay: columnDisplay }}
            wrapLinesPreference={{
              label: 'Wrap lines',
              description: 'Wrap long values (e.g. IAM ARNs) instead of truncating.',
            }}
            contentDisplayPreference={{
              title: 'Column preferences',
              options: [
                { id: 'principal', label: 'Principal', alwaysVisible: true },
                { id: 'type', label: 'Type' },
                { id: 'account', label: 'Account' },
                { id: 'arn', label: 'IAM ARN' },
                { id: 'sso', label: 'SSO user' },
                { id: 'firstSeen', label: 'First seen' },
                { id: 'lastSeen', label: 'Last invoked' },
                { id: 'actions', label: 'Actions', alwaysVisible: true },
              ],
            }}
            onConfirm={({ detail }) => {
              if (detail.contentDisplay) setColumnDisplay([...detail.contentDisplay]);
              setWrapLines(Boolean(detail.wrapLines));
            }}
          />
        }
        columnDefinitions={[
          {
            id: 'principal',
            header: 'Principal',
            minWidth: 220,
            isRowHeader: true,
            cell: (r) => <PrincipalCell principal={r.principal} principalType={r.principalType} />,
            sortingField: 'principal',
          },
          { id: 'type', header: 'Type', minWidth: 90, cell: (r) => r.principalType ?? '—', sortingField: 'principalType' },
          {
            id: 'account',
            header: 'Account',
            minWidth: 150,
            // surfaces which AWS account this principal lives in.
            // Useful for multi-account installs where the API filters
            // server-side by scope but ARN is the only visual cue.
            // Friendly name (when known via Org DescribeAccount) keeps
            // it readable for wildcard admins viewing many accounts.
            cell: (r) => {
              const acct = accountFromPrincipal(r.principalArn ?? r.principal);
              return acct ? <code>{formatAccount(acct, scope.accountNames)}</code> : '—';
            },
            // Sort by the DISPLAYED account label, not the raw ARN. Comparator
            // is memoized above (stable identity) so the sort toggle works.
            sortingComparator: accountComparator,
          },
          {
            id: 'arn',
            header: 'IAM ARN',
            minWidth: 240,
            // Hidden by default (see columnDisplay). When re-enabled, trim to
            // "type/name" so it doesn't sprawl; full ARN is copy-to-clipboard.
            // popoverRenderWithPortal is required — the trigger lives inside the
            // table's own overflow-x scroll container.
            cell: (r) => {
              const arn = r.principalArn;
              if (!arn) return '—';
              const m = /^arn:aws:iam::[^:]+:(.+)$/.exec(arn);
              return (
                <CopyToClipboard
                  variant="inline"
                  textToCopy={arn}
                  textToDisplay={<code>{m ? m[1] : arn}</code>}
                  copyButtonAriaLabel="Copy full IAM ARN"
                  copySuccessText="ARN copied"
                  copyErrorText="Could not copy ARN"
                  popoverRenderWithPortal
                />
              );
            },
          },
          { id: 'sso', header: 'SSO user', minWidth: 150, cell: (r) => r.ssoUser ?? '—' },
          {
            id: 'firstSeen',
            header: 'First seen',
            minWidth: 130,
            cell: (r) => (r.firstSeen ? new Date(r.firstSeen).toLocaleString() : '—'),
            sortingField: 'firstSeen',
          },
          {
            id: 'lastSeen',
            header: 'Last invoked',
            minWidth: 130,
            cell: (r) => (r.lastSeen ?? r.eventTime ? new Date((r.lastSeen ?? r.eventTime) as string).toLocaleString() : '—'),
            sortingField: 'lastSeen',
          },
          {
            id: 'actions',
            header: 'Actions',
            // minWidth (NOT width): Actions is the last visible column and under
            // resizableColumns Cloudscape ignores `width` on the last column
            // (it always fills remaining space). Dropping minWidth reintroduces
            // the "Activit/y" wrap. wrapText={false} on both buttons is the
            // other half — SpaceBetween wraps under pressure regardless.
            minWidth: 200,
            cell: (r) => (
              <SpaceBetween size="xs" direction="horizontal">
                <Button
                  variant="inline-link"
                  iconName="add-plus"
                  wrapText={false}
                  onClick={() =>
                    navigate(`/budgets?principal=${encodeURIComponent(r.principal)}`)
                  }
                >
                  Create budget
                </Button>
                <Button
                  variant="inline-link"
                  iconName="status-info"
                  wrapText={false}
                  onClick={() => setActivityPrincipal(r.principal)}
                >
                  Activity
                </Button>
              </SpaceBetween>
            ),
          },
        ]}
        empty="No identities seen in the selected window"
      />
      {activityPrincipal && (
        <PrincipalActivityModal
          config={config}
          principal={activityPrincipal}
          onDismiss={() => setActivityPrincipal(undefined)}
        />
      )}
    </ContentLayout>
  );
};
