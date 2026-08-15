import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Multiselect, { type MultiselectProps } from '@cloudscape-design/components/multiselect';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import type { ButtonDropdownProps } from '@cloudscape-design/components/button-dropdown';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import { api } from '../api/client';
import { canonicalizeIamArn } from '../components/canonicalArn';
import { useConfirm } from '../components/ConfirmDialog';
import type { BbgConfig } from '../config';

interface UserRow {
  username: string;
  status: string;
  enabled: boolean;
  createdAt?: string;
  lastModifiedAt?: string;
  attributes: Record<string, string>;
  groups: string[];
}

type Banner = { kind: 'success' | 'error' | 'info'; text: string } | undefined;

/**
 * Per-user notification floor. Same options as the Profile
 * page; admin override of the same Cognito attr.
 */
const THRESHOLD_FLOOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '50', label: '50% of budget (chattiest)' },
  { value: '75', label: '75% of budget' },
  { value: '80', label: '80% of budget' },
  { value: '90', label: '90% of budget' },
  { value: '100', label: '100% of budget (only when reached)' },
  { value: '101', label: 'Never (no budget-threshold emails)' },
];

export const AdminUsers = ({ config }: { config: BbgConfig }) => {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [identities, setIdentities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>(undefined);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRow | undefined>();
  const { confirm: confirmAction, dialog: confirmDialog } = useConfirm();

  const refresh = async () => {
    setLoading(true);
    try {
      const [u, g, ids] = await Promise.all([
        api.listAdminUsers(config),
        api.listAdminGroups(config),
        // Identities power the IAM-principal Autosuggest dropdown — every
        // distinct Bedrock caller the meter has seen, ranked by recency.
        // Falls back to an empty list if the call fails so the modal still
        // works in free-form mode.
        api.listIdentities(config).catch(() => ({ items: [] as Array<{ principal: string }> })),
      ]);
      setUsers(u.items);
      setGroups(g.items.map((it) => it.name ?? '').filter(Boolean));
      setIdentities(
        ids.items
          .map((it) => it.principal)
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          // Strip the `principal#` key prefix the meter uses internally so
          // the dropdown shows clean ARNs.
          .map((p) => p.replace(/^principal#/, ''))
          .filter((p, i, arr) => arr.indexOf(p) === i)
          .sort(),
      );
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiBaseUrl]);

  const handleAction = async (action: string, fn: () => Promise<unknown>) => {
    setBanner(undefined);
    try {
      await fn();
      await refresh();
      setBanner({ kind: 'success', text: `${action} successful.` });
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={`(${users.length})`}
          description="Manage Cognito users in this pool: create, edit attributes, change roles via group membership, force password reset, disable, delete."
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              <Button iconName="refresh" onClick={() => void refresh()} loading={loading}>
                Refresh
              </Button>
              <Button variant="primary" iconName="add-plus" onClick={() => setCreating(true)}>
                Create user
              </Button>
            </SpaceBetween>
          }
        >
          Users
        </Header>
      }
    >
      <SpaceBetween size="m">
        {banner && (
          <Alert
            type={banner.kind}
            dismissible
            onDismiss={() => setBanner(undefined)}
          >
            {banner.text}
          </Alert>
        )}
        <Table
          loading={loading}
          loadingText="Loading users"
          items={users}
          variant="container"
          resizableColumns
          columnDefinitions={[
            {
              id: 'name',
              header: 'Name',
              minWidth: 160,
              cell: (r) =>
                [r.attributes.given_name, r.attributes.family_name].filter(Boolean).join(' ') || '—',
              sortingField: 'name',
              isRowHeader: true,
            },
            {
              id: 'email',
              header: 'Email',
              minWidth: 220,
              cell: (r) => r.attributes.email ?? '—',
              sortingField: 'email',
            },
            {
              id: 'groups',
              header: 'Groups',
              minWidth: 110,
              cell: (r) => (r.groups.length ? r.groups.join(', ') : '—'),
            },
            {
              id: 'status',
              header: 'Status',
              minWidth: 130,
              cell: (r) =>
                !r.enabled ? (
                  <StatusIndicator type="stopped">Disabled</StatusIndicator>
                ) : r.status === 'CONFIRMED' ? (
                  <StatusIndicator type="success">Confirmed</StatusIndicator>
                ) : (
                  <StatusIndicator type="warning">{r.status}</StatusIndicator>
                ),
            },
            {
              id: 'iam',
              header: 'IAM principal',
              minWidth: 220,
              maxWidth: 360,
              cell: (r) => {
                // Trim to "type/name" so the column doesn't sprawl horizontally.
                // Full ARN visible in the Edit modal.
                const arn = r.attributes['custom:iam_principal'];
                if (!arn) return '—';
                const m = arn.match(/^arn:aws:iam::[^:]+:(.+)$/);
                return m ? m[1] : arn;
              },
            },
            {
              id: 'actions',
              header: 'Actions',
              width: 200,
              minWidth: 200,
              cell: (r) => (
                <SpaceBetween size="xs" direction="horizontal">
                  <Button variant="normal" iconName="edit" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <ButtonDropdown
                    expandToViewport
                    onItemClick={({ detail }: { detail: ButtonDropdownProps.ItemClickDetails }) => {
                      if (detail.id === 'enable') {
                        void handleAction('Enable', () => api.enableAdminUser(config, r.username));
                      } else if (detail.id === 'disable') {
                        void handleAction('Disable', () => api.disableAdminUser(config, r.username));
                      } else if (detail.id === 'reset') {
                        void handleAction('Force password reset', () =>
                          api.resetAdminUserPassword(config, r.username),
                        );
                      } else if (detail.id === 'delete') {
                        void confirmAction({
                          title: 'Delete user',
                          body: (
                            <>
                              Delete user <code>{r.username}</code>? They will not be
                              able to sign in. Their passkeys, nicknames, and budgets
                              are not auto-deleted.
                            </>
                          ),
                          confirmLabel: 'Delete',
                          destructive: true,
                        }).then((ok) => {
                          if (ok) {
                            void handleAction('Delete', () =>
                              api.deleteAdminUser(config, r.username),
                            );
                          }
                        });
                      }
                    }}
                    items={[
                      r.enabled
                        ? { id: 'disable', text: 'Disable user' }
                        : { id: 'enable', text: 'Enable user' },
                      { id: 'reset', text: 'Force password reset' },
                      { id: 'delete', text: 'Delete user', disabled: false },
                    ]}
                  >
                    Actions
                  </ButtonDropdown>
                </SpaceBetween>
              ),
            },
          ]}
          empty="No users in this pool"
        />
      </SpaceBetween>

      {creating && (
        <CreateUserModal
          config={config}
          groups={groups}
          identities={identities}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {editing && (
        <EditUserModal
          config={config}
          groups={groups}
          identities={identities}
          user={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await refresh();
          }}
        />
      )}
      {confirmDialog}
    </ContentLayout>
  );
};

const CreateUserModal = ({
  config,
  groups,
  identities,
  onClose,
  onCreated,
}: {
  config: BbgConfig;
  groups: string[];
  identities: string[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) => {
  const [email, setEmail] = useState('');
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [team, setTeam] = useState('');
  const [iamPrincipal, setIamPrincipal] = useState('');
  // Empty by default — the server generates a strong random one when blank.
  const [tempPwd, setTempPwd] = useState('');
  const [permanent, setPermanent] = useState(false);
  const [sendInvite, setSendInvite] = useState(true);
  const [selectedGroups, setSelectedGroups] = useState<MultiselectProps.Option[]>([
    { value: 'Users', label: 'Users' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [createdInfo, setCreatedInfo] = useState<{ username: string; temporaryPassword: string } | undefined>();

  const groupOptions = useMemo<MultiselectProps.Option[]>(
    () => groups.map((g) => ({ value: g, label: g })),
    [groups],
  );

  const submit = async () => {
    setSubmitting(true);
    setErr(undefined);
    try {
      const r = await api.createAdminUser(config, {
        email,
        givenName: givenName || undefined,
        familyName: familyName || undefined,
        team: team || undefined,
        // Canonicalize assumed-role → role so the meter's RunningSpend
        // writes (which always use the base role) match this user's
        // /me/spend lookup key.
        iamPrincipal: iamPrincipal ? canonicalizeIamArn(iamPrincipal) : undefined,
        groups: selectedGroups.map((g) => g.value!).filter(Boolean),
        temporaryPassword: tempPwd || undefined,
        permanent,
        sendInvite,
      });
      setCreatedInfo({ username: r.username, temporaryPassword: r.temporaryPassword });
      await onCreated();
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible
      onDismiss={onClose}
      header="Create user"
      footer={
        <SpaceBetween size="xs" direction="horizontal">
          <Button onClick={onClose} disabled={submitting}>
            {createdInfo ? 'Close' : 'Cancel'}
          </Button>
          {!createdInfo && (
            <Button variant="primary" onClick={() => void submit()} loading={submitting}>
              Create
            </Button>
          )}
        </SpaceBetween>
      }
    >
      {createdInfo ? (
        <Alert type="success" header={`User ${createdInfo.username} created`}>
          {sendInvite ? (
            <>
              An invitation email with the temporary password has been sent
              to <code>{createdInfo.username}</code>.
            </>
          ) : (
            <>
              Temporary password: <code>{createdInfo.temporaryPassword}</code>
              <br />
              Hand this to the user out-of-band — Cognito did not email it.
            </>
          )}
          <br />
          {permanent
            ? 'The password is permanent — the user signs in directly with it.'
            : 'The user will be prompted to choose a new password on first sign-in.'}
        </Alert>
      ) : (
        <Form errorText={err}>
          <SpaceBetween size="m">
            <FormField label="Email">
              <Input value={email} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setEmail(e.detail.value)} placeholder="user@example.com" />
            </FormField>
            <FormField label="Given name">
              <Input value={givenName} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setGivenName(e.detail.value)} />
            </FormField>
            <FormField label="Family name">
              <Input value={familyName} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setFamilyName(e.detail.value)} />
            </FormField>
            <FormField
              label="IAM principal"
              description="Optional. Bedrock IAM ARN to scope this user's /me/spend view. Pick from the list of distinct Bedrock callers the meter has seen, or type a new ARN if it hasn't called Bedrock yet."
            >
              <Autosuggest
                value={iamPrincipal}
                onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setIamPrincipal(e.detail.value)}
                options={identities.map((arn) => ({ value: arn }))}
                placeholder="arn:aws:iam::123456789012:role/MyBedrockRole"
                empty="No callers detected yet"
                enteredTextLabel={(v: string) => `Use "${v}"`}
                filteringType="auto"
                ariaLabel="IAM principal"
              />
            </FormField>
            <FormField label="Team" description="Optional cost-allocation tag.">
              <Input value={team} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setTeam(e.detail.value)} />
            </FormField>
            <FormField label="Groups">
              <Multiselect
                selectedOptions={selectedGroups}
                options={groupOptions}
                onChange={(e: NonCancelableCustomEvent<MultiselectProps.MultiselectChangeDetail>) => setSelectedGroups([...e.detail.selectedOptions])}
                placeholder="Choose groups"
              />
            </FormField>
            <FormField
              label="Temporary password (optional)"
              description="Leave blank to have BBG generate a strong random one. Cognito's password policy requires 12+ chars with all four character classes."
            >
              <Input
                value={tempPwd}
                type="password"
                onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setTempPwd(e.detail.value)}
                placeholder="(auto-generate)"
              />
            </FormField>
            <FormField
              label="Delivery"
              description="An invitation email lets the user sign in immediately. Disable when handing the password off in person."
            >
              <SpaceBetween size="xs">
                <Toggle checked={sendInvite} onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setSendInvite(e.detail.checked)}>
                  Send invitation email to the user (default)
                </Toggle>
                <Toggle checked={permanent} onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setPermanent(e.detail.checked)}>
                  Permanent password — skip force-reset on first sign-in
                </Toggle>
              </SpaceBetween>
            </FormField>
          </SpaceBetween>
        </Form>
      )}
    </Modal>
  );
};

const EditUserModal = ({
  config,
  groups,
  identities,
  user,
  onClose,
  onSaved,
}: {
  config: BbgConfig;
  groups: string[];
  identities: string[];
  user: UserRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) => {
  const [displayName, setDisplayName] = useState(user.attributes.name ?? '');
  const [givenName, setGivenName] = useState(user.attributes.given_name ?? '');
  const [familyName, setFamilyName] = useState(user.attributes.family_name ?? '');
  const [email, setEmail] = useState(user.attributes.email ?? '');
  const [team, setTeam] = useState(user.attributes['custom:team'] ?? '');
  const [iamPrincipal, setIamPrincipal] = useState(user.attributes['custom:iam_principal'] ?? '');
  // Notification prefs — Cognito stores 'true'/'false'; missing → opt-in
  // for the user-self channels, opt-OUT for the admin-watch channel.
  const parseNotify = (k: string) => user.attributes[k] !== 'false';
  const parseOptIn = (k: string) => user.attributes[k] === 'true';
  // per-user threshold floor. Compat-derive from the legacy 3
  // toggles when the explicit floor attr is missing — keeps in-flight
  // users behaving the same way they did before this story.
  const initialFloor = (() => {
    const explicit = user.attributes['custom:notify_pct_floor'];
    if (explicit && explicit !== '') return explicit;
    if (parseNotify('custom:notify_50pct')) return '50';
    if (parseNotify('custom:notify_80pct')) return '80';
    if (parseNotify('custom:notify_100pct')) return '100';
    return '101';
  })();
  const [notifyFloor, setNotifyFloor] = useState(initialFloor);
  const [notifyEnforce, setNotifyEnforce] = useState(parseNotify('custom:notify_enforcement'));
  const [notifyAdminAll, setNotifyAdminAll] = useState(
    parseOptIn('custom:notify_admin_watch'),
  );
  const isUserAdmin = user.groups.includes('Admins');
  const [selected, setSelected] = useState<MultiselectProps.Option[]>(
    user.groups.map((g) => ({ value: g, label: g })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const groupOptions = useMemo<MultiselectProps.Option[]>(
    () => groups.map((g) => ({ value: g, label: g })),
    [groups],
  );

  const submit = async () => {
    setSubmitting(true);
    setErr(undefined);
    try {
      await api.updateAdminUser(config, user.username, {
        name: displayName,
        givenName,
        familyName,
        email: email !== user.attributes.email ? email : undefined,
        team,
        // Canonicalize assumed-role → role so the meter's RunningSpend
        // writes (which always use the base role) match.
        iamPrincipal: iamPrincipal ? canonicalizeIamArn(iamPrincipal) : '',
        notifyThresholdFloor: Number(notifyFloor),
        notifyEnforcement: notifyEnforce,
        notifyAdminWatch: notifyAdminAll,
      });
      await api.setAdminUserGroups(
        config,
        user.username,
        selected.map((s) => s.value!).filter(Boolean),
      );
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={`Edit ${user.username}`}
      footer={
        <SpaceBetween size="xs" direction="horizontal">
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={submitting}>
            Save
          </Button>
        </SpaceBetween>
      }
    >
      <Form errorText={err}>
        <SpaceBetween size="m">
          <Container>
            <SpaceBetween size="xxs">
              <strong>Username (immutable):</strong> {user.username}
              <br />
              <strong>Status:</strong> {user.status} {user.enabled ? '(enabled)' : '(disabled)'}
            </SpaceBetween>
          </Container>
          <FormField
            label="Display name"
            description="Shown in the SPA top-right when this user is signed in. Blank → falls back to given/family name, then email."
          >
            <Input value={displayName} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setDisplayName(e.detail.value)} />
          </FormField>
          <FormField label="Given name">
            <Input value={givenName} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setGivenName(e.detail.value)} />
          </FormField>
          <FormField label="Family name">
            <Input value={familyName} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setFamilyName(e.detail.value)} />
          </FormField>
          <FormField
            label="Email"
            description="Changing this triggers a verification code to the new address; the user must confirm via the API or their next sign-in."
          >
            <Input value={email} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setEmail(e.detail.value)} />
          </FormField>
          <FormField label="Team">
            <Input value={team} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setTeam(e.detail.value)} />
          </FormField>
          <FormField
            label="IAM principal"
            description="Bedrock IAM ARN to scope /me/spend etc. Pick from the list of distinct Bedrock callers the meter has seen, or type a new ARN."
          >
            <Autosuggest
              value={iamPrincipal}
              onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setIamPrincipal(e.detail.value)}
              options={identities.map((arn) => ({ value: arn }))}
              placeholder="arn:aws:iam::123456789012:role/MyBedrockRole"
              empty="No callers detected yet"
              enteredTextLabel={(v: string) => `Use "${v}"`}
              filteringType="auto"
              ariaLabel="IAM principal"
            />
          </FormField>
          <FormField label="Groups">
            <Multiselect
              selectedOptions={selected}
              options={groupOptions}
              onChange={(e: NonCancelableCustomEvent<MultiselectProps.MultiselectChangeDetail>) => setSelected([...e.detail.selectedOptions])}
              placeholder="Choose groups"
            />
          </FormField>
          <FormField
            label="Notification preferences"
            description="Email events sent to this user's verified address. Defaults are on. Admin overrides apply immediately on save."
          >
            <SpaceBetween size="xs">
              <FormField
                label="Notify starting at"
                description="Lowest budget-threshold percentage that triggers a warn email. Lower = chattier; choose the percentage where the user starts wanting to know."
              >
                <Select
                  selectedOption={
                    THRESHOLD_FLOOR_OPTIONS.find((o) => o.value === notifyFloor) ??
                    THRESHOLD_FLOOR_OPTIONS[0]
                  }
                  onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) =>
                    setNotifyFloor(e.detail.selectedOption.value ?? '50')
                  }
                  options={THRESHOLD_FLOOR_OPTIONS}
                />
              </FormField>
              <Toggle
                checked={notifyEnforce}
                onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setNotifyEnforce(e.detail.checked)}
              >
                Enforcement (deny attached)
              </Toggle>
              {isUserAdmin && (
                <Toggle
                  checked={notifyAdminAll}
                  onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) => setNotifyAdminAll(e.detail.checked)}
                  description="Admin-only opt-in: receive every enforcement email across the org, not just for this user's own principal. Useful for oncall coverage."
                >
                  Admin: all enforcement events
                </Toggle>
              )}
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
};
