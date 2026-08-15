import { useEffect, useState } from 'react';
import {
  associateWebAuthnCredential,
  confirmUserAttribute,
  deleteWebAuthnCredential,
  fetchAuthSession,
  fetchUserAttributes,
  listWebAuthnCredentials,
  updatePassword,
  updateUserAttributes,
  type AuthWebAuthnCredential as WebAuthnCredential,
} from 'aws-amplify/auth';
import { api } from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useScope } from '../auth/scope-context';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Toggle from '@cloudscape-design/components/toggle';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Modal from '@cloudscape-design/components/modal';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { BbgConfig } from '../config';

type Banner = { kind: 'success' | 'error'; text: string } | undefined;

/**
 * Per-user notification floor. Stored on
 * `custom:notify_pct_floor` as the percentage string. `101`
 * means "never email me about budget threshold crossings" — anything
 * higher than the highest possible budget threshold (100%) effectively
 * disables warn emails while leaving the enforcement-fired channel
 * intact.
 */
const THRESHOLD_FLOOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '50', label: '50% of budget (chattiest)' },
  { value: '75', label: '75% of budget' },
  { value: '80', label: '80% of budget' },
  { value: '90', label: '90% of budget' },
  { value: '100', label: '100% of budget (only when reached)' },
  { value: '101', label: 'Never (no budget-threshold emails)' },
];

export const Profile = ({ config }: { config: BbgConfig }) => {
  const { refreshDisplayName } = useScope();
  const [attrs, setAttrs] = useState<Record<string, string | undefined>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [originalEmail, setOriginalEmail] = useState<string>('');
  const [originalName, setOriginalName] = useState<string>('');
  const [pendingEmailVerification, setPendingEmailVerification] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [credentials, setCredentials] = useState<WebAuthnCredential[]>([]);
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | undefined>();
  const [editingValue, setEditingValue] = useState('');
  const [savingNickname, setSavingNickname] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [credentialsLoading, setCredentialsLoading] = useState(true);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const { confirm: confirmAction, dialog: confirmDialog } = useConfirm();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [banner, setBanner] = useState<Banner>(undefined);

  // Suppress unused config warning while the page only uses Amplify directly.
  void config;

  const refreshCredentials = async () => {
    setCredentialsLoading(true);
    try {
      const [r, n] = await Promise.all([
        listWebAuthnCredentials(),
        api.listPasskeyNicknames(config).catch(() => ({ items: [] as Array<{ credentialId: string; nickname: string }> })),
      ]);
      setCredentials(r.credentials ?? []);
      const map: Record<string, string> = {};
      for (const it of n.items) map[it.credentialId] = it.nickname;
      setNicknames(map);
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    } finally {
      setCredentialsLoading(false);
    }
  };

  const startEdit = (credentialId: string, currentName: string) => {
    setEditingId(credentialId);
    setEditingValue(currentName);
  };

  const cancelEdit = () => {
    setEditingId(undefined);
    setEditingValue('');
  };

  const saveNickname = async (credentialId: string) => {
    setSavingNickname(true);
    setBanner(undefined);
    try {
      const trimmed = editingValue.trim();
      if (!trimmed) {
        setBanner({ kind: 'error', text: 'Nickname cannot be empty.' });
        return;
      }
      await api.setPasskeyNickname(config, credentialId, trimmed);
      setNicknames((prev) => ({ ...prev, [credentialId]: trimmed }));
      setEditingId(undefined);
      setEditingValue('');
      setBanner({ kind: 'success', text: 'Passkey renamed.' });
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    } finally {
      setSavingNickname(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const a = await fetchUserAttributes();
        if (cancelled) return;
        setAttrs(a);
        setOriginalEmail(a.email ?? '');
        setOriginalName(a.name ?? '');
        // Detect Admins group from the JWT so the admin-watch toggle
        // can be gated client-side. Server still authoritatively scopes
        // by IAM in the API.
        const session = await fetchAuthSession();
        const groupsClaim = session.tokens?.idToken?.payload['cognito:groups'];
        const groups = Array.isArray(groupsClaim)
          ? (groupsClaim as string[])
          : typeof groupsClaim === 'string'
            ? [groupsClaim]
            : [];
        if (!cancelled) setIsAdmin(groups.includes('Admins'));
      } catch (err) {
        setBanner({ kind: 'error', text: (err as Error).message });
      }
      await refreshCredentials();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setAttr = (k: string, v: string) => setAttrs((prev) => ({ ...prev, [k]: v }));

  const saveProfile = async () => {
    setSavingProfile(true);
    setBanner(undefined);
    try {
      // F1: `custom:iam_principal` is intentionally NOT writable here. It
      // drives /me/* spend+budget authZ, so it's admin-owned (set via the
      // admin users API) and excluded from this app client's writeAttributes.
      // The field below is read-only display only.
      const updates: Record<string, string> = {};
      const candidates = [
        'name',
        'given_name',
        'family_name',
        'preferred_username',
        'phone_number',
      ] as const;
      for (const k of candidates) {
        if (attrs[k] !== undefined) updates[k] = (attrs[k] ?? '').trim();
      }
      // Notification preferences. Cognito stores 'true'/'false' strings;
      // missing means opt-in by default, so we only persist when the user
      // has touched the toggle.
      const notifyKeys = [
        'custom:notify_pct_floor',
        'custom:notify_enforcement',
        'custom:notify_admin_watch',
      ] as const;
      for (const k of notifyKeys) {
        if (attrs[k] !== undefined) updates[k] = attrs[k] ?? '';
      }
      if (attrs.email && attrs.email !== originalEmail) {
        updates.email = attrs.email;
      }
      const r = await updateUserAttributes({ userAttributes: updates });
      // If email was changed, Cognito returns a confirmation step.
      if (r.email?.nextStep.updateAttributeStep === 'CONFIRM_ATTRIBUTE_WITH_CODE') {
        setPendingEmailVerification(true);
        setBanner({
          kind: 'success',
          text: `Verification code sent to ${attrs.email}. Enter it below to complete the email change.`,
        });
      } else {
        setBanner({ kind: 'success', text: 'Profile saved.' });
        // If the display name changed, refresh the top-right immediately
        // (force-refreshes the ID token so the new `name` claim lands) — no
        // re-login needed.
        const nameChanged = updates.name !== undefined && updates.name !== originalName;
        if (nameChanged) refreshDisplayName();
        setOriginalEmail(attrs.email ?? originalEmail);
        setOriginalName(attrs.name ?? originalName);
      }
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    } finally {
      setSavingProfile(false);
    }
  };

  const confirmEmail = async () => {
    setSavingProfile(true);
    setBanner(undefined);
    try {
      await confirmUserAttribute({ userAttributeKey: 'email', confirmationCode: emailCode });
      setPendingEmailVerification(false);
      setEmailCode('');
      setOriginalEmail(attrs.email ?? originalEmail);
      setBanner({ kind: 'success', text: 'Email updated and verified.' });
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    } finally {
      setSavingProfile(false);
    }
  };

  const enrollPasskey = async () => {
    setEnrolling(true);
    setBanner(undefined);
    try {
      // Amplify v6 wraps the entire WebAuthn ceremony: it calls Cognito's
      // StartWebAuthnRegistration to get the PublicKeyCredentialCreationOptions,
      // invokes navigator.credentials.create() (which prompts the browser
      // for passkey / Touch ID / YubiKey / Windows Hello), and posts back
      // via CompleteWebAuthnRegistration. Browser is the relying-party
      // (origin must match what's configured on the User Pool).
      await associateWebAuthnCredential();
      await refreshCredentials();
      setBanner({
        kind: 'success',
        text: 'Passkey registered. Future sign-ins can use your authenticator (Touch ID, Windows Hello, YubiKey, etc.).',
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      setBanner({
        kind: 'error',
        text:
          msg.includes('NotAllowedError') || msg.includes('cancelled')
            ? 'Passkey enrollment cancelled.'
            : msg,
      });
    } finally {
      setEnrolling(false);
    }
  };

  const removePasskey = async (credentialId: string) => {
    const ok = await confirmAction({
      title: 'Remove passkey',
      body: 'Remove this passkey? You will not be able to sign in with this authenticator anymore.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteWebAuthnCredential({ credentialId });
      await refreshCredentials();
      setBanner({ kind: 'success', text: 'Passkey removed.' });
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    }
  };

  const submitPasswordChange = async () => {
    setBanner(undefined);
    try {
      await updatePassword({ oldPassword, newPassword });
      setShowPasswordChange(false);
      setOldPassword('');
      setNewPassword('');
      setBanner({ kind: 'success', text: 'Password changed.' });
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Manage your name, email, password, and multi-factor authentication.">
          My profile
        </Header>
      }
    >
      <SpaceBetween size="l">
        {banner && (
          <Alert
            type={banner.kind === 'success' ? 'success' : 'error'}
            dismissible
            onDismiss={() => setBanner(undefined)}
          >
            {banner.text}
          </Alert>
        )}

        <Container header={<Header variant="h2">Account</Header>}>
          <KeyValuePairs
            columns={3}
            items={[
              { label: 'User ID (sub)', value: attrs.sub ?? '—' },
              { label: 'Cognito username', value: attrs.preferred_username ?? attrs.email ?? '—' },
              { label: 'Email verified', value: attrs.email_verified === 'true' ? 'Yes' : 'No' },
            ]}
          />
        </Container>

        <Container header={<Header variant="h2">Personal info</Header>}>
          <Form
            actions={
              <Button variant="primary" onClick={() => void saveProfile()} loading={savingProfile}>
                Save
              </Button>
            }
          >
            <SpaceBetween size="m">
              <FormField
                label="Display name"
                description="Shown in the top-right when you're signed in. If left blank, your given/family name is used, then your email."
              >
                <Input
                  value={attrs.name ?? ''}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setAttr('name', e.detail.value)}
                  placeholder="e.g. Alex R."
                />
              </FormField>
              <FormField label="Given name">
                <Input
                  value={attrs.given_name ?? ''}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setAttr('given_name', e.detail.value)}
                />
              </FormField>
              <FormField label="Family name">
                <Input
                  value={attrs.family_name ?? ''}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setAttr('family_name', e.detail.value)}
                />
              </FormField>
              <FormField label="Preferred username">
                <Input
                  value={attrs.preferred_username ?? ''}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setAttr('preferred_username', e.detail.value)}
                />
              </FormField>
              <FormField
                label="Email"
                description="Changing this will send a verification code to the new address."
              >
                <Input
                  value={attrs.email ?? ''}
                  type="email"
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setAttr('email', e.detail.value)}
                />
              </FormField>
              {pendingEmailVerification && (
                <FormField label="Email verification code">
                  <SpaceBetween size="xs" direction="horizontal">
                    <Input value={emailCode} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setEmailCode(e.detail.value)} />
                    <Button onClick={() => void confirmEmail()}>Confirm</Button>
                  </SpaceBetween>
                </FormField>
              )}
              <FormField label="Phone number" description="Optional. E.164 format, e.g. +14155551234.">
                <Input
                  value={attrs.phone_number ?? ''}
                  onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setAttr('phone_number', e.detail.value)}
                />
              </FormField>
              <FormField
                label="IAM principal"
                description="The IAM ARN that records as the caller in CloudTrail when you invoke Bedrock. It scopes your /me/spend and /me/budget views to that principal. Managed by an administrator — contact one to set or change it."
              >
                <Input
                  value={attrs['custom:iam_principal'] ?? ''}
                  placeholder="Not set — ask an administrator to map your IAM principal."
                  readOnly
                  disabled
                />
              </FormField>
            </SpaceBetween>
          </Form>
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              description="Choose which BBG events trigger an email to your verified address. Defaults are on; toggling off persists on save."
            >
              Notification preferences
            </Header>
          }
        >
          <SpaceBetween size="m">
            <FormField
              label="Notify me starting at"
              description="Email me when a budget I'm associated with crosses this threshold or higher. Lower = chattier; choose the percentage where you start wanting to know."
            >
              <Select
                selectedOption={(() => {
                  const raw = attrs['custom:notify_pct_floor'];
                  const fallback =
                    (attrs['custom:notify_50pct'] ?? 'true') !== 'false'
                      ? '50'
                      : (attrs['custom:notify_80pct'] ?? 'true') !== 'false'
                        ? '80'
                        : (attrs['custom:notify_100pct'] ?? 'true') !== 'false'
                          ? '100'
                          : '101';
                  const val = raw && raw !== '' ? raw : fallback;
                  return THRESHOLD_FLOOR_OPTIONS.find((o) => o.value === val) ??
                    THRESHOLD_FLOOR_OPTIONS[0];
                })()}
                onChange={(e: NonCancelableCustomEvent<SelectProps.ChangeDetail>) =>
                  setAttr('custom:notify_pct_floor', e.detail.selectedOption.value ?? '50')
                }
                options={THRESHOLD_FLOOR_OPTIONS}
              />
            </FormField>
            <Toggle
              checked={(attrs['custom:notify_enforcement'] ?? 'true') !== 'false'}
              onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) =>
                setAttr('custom:notify_enforcement', e.detail.checked ? 'true' : 'false')
              }
              description="Sent the moment a bbg-deny-* IAM policy is attached to your principal. Strongly recommended."
            >
              Email me when enforcement fires
            </Toggle>
            {isAdmin && (
              <Toggle
                checked={attrs['custom:notify_admin_watch'] === 'true'}
                onChange={(e: NonCancelableCustomEvent<{ checked: boolean }>) =>
                  setAttr(
                    'custom:notify_admin_watch',
                    e.detail.checked ? 'true' : 'false',
                  )
                }
                description="Admin-only. When on, you receive an email every time enforcement fires anywhere in the system, not just for your own principal. Useful for oncall coverage; can be noisy in larger orgs."
              >
                Admin: all enforcement events
              </Toggle>
            )}
            <Box variant="small" color="text-status-inactive">
              Click <strong>Save</strong> in the Personal info container above to persist changes.
            </Box>
          </SpaceBetween>
        </Container>

        {config.webAuthnEnabled && (
        <Container
          header={
            <Header
              variant="h2"
              description="Use a passkey, security key (YubiKey), or platform authenticator (Touch ID, Windows Hello) to sign in. No passwords or codes needed once enrolled."
              actions={
                <Button variant="primary" onClick={() => void enrollPasskey()} loading={enrolling} iconName="key">
                  Add passkey
                </Button>
              }
            >
              Passkeys
            </Header>
          }
        >
          {credentials.length === 0 && !credentialsLoading && (
            <Box color="text-status-inactive">
              No passkeys enrolled yet. Click <strong>Add passkey</strong> and follow your browser's prompt.
            </Box>
          )}
          {credentials.length > 0 && (
            <Box>
              <SpaceBetween size="s">
                {credentials.map((c, i) => {
                  const id = c.credentialId ?? `cred-${i}`;
                  const displayName =
                    nicknames[id] ?? c.friendlyCredentialName ?? 'Passkey';
                  const isEditing = editingId === id;
                  return (
                    <Container key={id} variant="default">
                      <SpaceBetween size="xs" direction="horizontal">
                        <StatusIndicator type="success">Active</StatusIndicator>
                        <Box>
                          {isEditing ? (
                            <SpaceBetween size="xxs" direction="horizontal">
                              <Input
                                value={editingValue}
                                onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setEditingValue(e.detail.value)}
                                placeholder="Nickname (e.g. 'Work YubiKey')"
                                disabled={savingNickname}
                                autoFocus
                              />
                              <Button
                                variant="primary"
                                onClick={() => void saveNickname(id)}
                                loading={savingNickname}
                                disabled={!editingValue.trim()}
                              >
                                Save
                              </Button>
                              <Button onClick={cancelEdit} disabled={savingNickname}>
                                Cancel
                              </Button>
                            </SpaceBetween>
                          ) : (
                            <SpaceBetween size="xxs" direction="horizontal">
                              <strong>{displayName}</strong>
                              {c.credentialId && (
                                <Button
                                  variant="inline-icon"
                                  iconName="edit"
                                  ariaLabel="Rename passkey"
                                  onClick={() => startEdit(id, displayName)}
                                />
                              )}
                            </SpaceBetween>
                          )}
                          <Box variant="small" color="text-status-inactive">
                            ID {id.slice(0, 12)}…
                            {c.createdAt ? ` · enrolled ${new Date(c.createdAt).toLocaleString()}` : ''}
                            {c.relyingPartyId ? ` · for ${c.relyingPartyId}` : ''}
                          </Box>
                        </Box>
                        {!isEditing && c.credentialId && (
                          <Button
                            variant="link"
                            iconName="remove"
                            onClick={() => void removePasskey(c.credentialId!)}
                          >
                            Remove
                          </Button>
                        )}
                      </SpaceBetween>
                    </Container>
                  );
                })}
              </SpaceBetween>
            </Box>
          )}
        </Container>
        )}

        <Container header={<Header variant="h2">Password</Header>}>
          <Button onClick={() => setShowPasswordChange(true)}>Change password</Button>
        </Container>
      </SpaceBetween>

      {showPasswordChange && (
        <Modal
          visible
          header="Change password"
          onDismiss={() => setShowPasswordChange(false)}
          footer={
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => setShowPasswordChange(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => void submitPasswordChange()}
                disabled={!oldPassword || newPassword.length < 12}
              >
                Save
              </Button>
            </SpaceBetween>
          }
        >
          <Form>
            <SpaceBetween size="m">
              <FormField label="Current password">
                <Input type="password" value={oldPassword} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setOldPassword(e.detail.value)} />
              </FormField>
              <FormField
                label="New password"
                description="At least 12 characters with upper, lower, digit, and symbol."
              >
                <Input type="password" value={newPassword} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setNewPassword(e.detail.value)} />
              </FormField>
            </SpaceBetween>
          </Form>
        </Modal>
      )}
      {confirmDialog}
    </ContentLayout>
  );
};
