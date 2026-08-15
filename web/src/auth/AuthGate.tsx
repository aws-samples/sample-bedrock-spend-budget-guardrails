import { useEffect, useState, type ReactNode } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import {
  confirmResetPassword,
  confirmSignIn,
  fetchAuthSession,
  resetPassword,
  signIn,
  signOut as amplifySignOut,
} from 'aws-amplify/auth';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'sign-in' }
  | { kind: 'new-password' }
  | { kind: 'forgot-start' }
  | { kind: 'forgot-confirm'; username: string }
  | { kind: 'signed-in' };

interface AuthCtx {
  email: string;
  /**
   * Friendly name for the top-nav: standard Cognito `name`, else
   * `given_name [family_name]`, else falls back to the email. Always
   * non-empty when signed in.
   */
  displayName: string;
  signOut: () => void;
}

interface AuthGateProps {
  children: (ctx: AuthCtx) => ReactNode;
}

/**
 * Derive the display name from an ID-token payload. Prefers the standard
 * `name` attribute, then `given_name [family_name]`, then the email. Returns
 * '' if nothing is present (caller falls back to its known email).
 */
export const displayNameFromPayload = (payload: Record<string, unknown> | undefined): string => {
  if (!payload) return '';
  const name = (payload.name as string | undefined)?.trim();
  if (name) return name;
  const given = (payload.given_name as string | undefined)?.trim();
  const family = (payload.family_name as string | undefined)?.trim();
  const composed = [given, family].filter(Boolean).join(' ');
  if (composed) return composed;
  return (payload.email as string | undefined)?.trim() ?? '';
};

export const AuthGate = ({ children }: AuthGateProps) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await fetchAuthSession();
        const idEmail = s.tokens?.idToken?.payload.email as string | undefined;
        if (s.tokens?.idToken && idEmail) {
          if (!cancelled) {
            setEmail(idEmail);
            setDisplayName(displayNameFromPayload(s.tokens.idToken.payload) || idEmail);
            setPhase({ kind: 'signed-in' });
          }
          return;
        }
      } catch {
        // fall through
      }
      if (!cancelled) setPhase({ kind: 'sign-in' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSignOut = async () => {
    try {
      await amplifySignOut();
    } catch {
      // ignore
    }
    setEmail('');
    setDisplayName('');
    setPassword('');
    setCode('');
    setError(undefined);
    setPhase({ kind: 'sign-in' });
  };

  const handleSignIn = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const r = await signIn({ username: email, password });
      if (r.isSignedIn) {
        const s = await fetchAuthSession();
        const e = (s.tokens?.idToken?.payload.email as string) ?? email;
        setEmail(e);
        setDisplayName(displayNameFromPayload(s.tokens?.idToken?.payload) || e);
        setPhase({ kind: 'signed-in' });
        setPassword('');
        return;
      }
      const next = r.nextStep.signInStep;
      if (next === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setPhase({ kind: 'new-password' });
        setPassword('');
        return;
      }
      setError(`Unsupported sign-in challenge: ${next}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * First-factor WebAuthn sign-in. Cognito returns an `allowCredentials`
   * list containing every WebAuthn credential the user has registered
   * (platform passkey, hardware security key like a YubiKey, etc.); the
   * browser then drives the picker (`navigator.credentials.get`) and
   * lets the user choose which authenticator to use.
   *
   * Note on Chrome/Mac: when a platform passkey is registered the system
   * sheet may show Touch ID by default — click "Other devices" / "Use a
   * different passkey" to pick a USB security key.
   */
  const handlePasskeySignIn = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const r = await signIn({
        username: email,
        options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' },
      });
      if (r.isSignedIn) {
        const s = await fetchAuthSession();
        const e = (s.tokens?.idToken?.payload.email as string) ?? email;
        setEmail(e);
        setDisplayName(displayNameFromPayload(s.tokens?.idToken?.payload) || e);
        setPhase({ kind: 'signed-in' });
        return;
      }
      setError(`Unexpected sign-in step: ${r.nextStep.signInStep}`);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      setError(
        msg.includes('NotAllowedError') || msg.includes('cancelled')
          ? 'Passkey / security key sign-in cancelled.'
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleNewPassword = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const r = await confirmSignIn({ challengeResponse: password });
      if (r.isSignedIn) {
        const s = await fetchAuthSession();
        const e = (s.tokens?.idToken?.payload.email as string) ?? email;
        setEmail(e);
        setDisplayName(displayNameFromPayload(s.tokens?.idToken?.payload) || e);
        setPhase({ kind: 'signed-in' });
        setPassword('');
        return;
      }
      setError(`Unexpected sign-in step after new password: ${r.nextStep.signInStep}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotStart = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await resetPassword({ username: email });
      setPhase({ kind: 'forgot-confirm', username: email });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotConfirm = async () => {
    if (phase.kind !== 'forgot-confirm') return;
    setSubmitting(true);
    setError(undefined);
    try {
      await confirmResetPassword({
        username: phase.username,
        confirmationCode: code,
        newPassword: password,
      });
      setPhase({ kind: 'sign-in' });
      setError('Password reset. Sign in with your new password.');
      setCode('');
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (phase.kind === 'loading') {
    return (
      <Box textAlign="center" padding="xxxl">
        <SpaceBetween size="m">
          <Spinner size="big" />
          <Box>Checking session…</Box>
        </SpaceBetween>
      </Box>
    );
  }

  if (phase.kind === 'signed-in') {
    return <>{children({ email, displayName: displayName || email, signOut: () => void onSignOut() })}</>;
  }

  // All sign-in / reset variants share the same centered Cloudscape card.
  return (
    <Box padding="xxl">
      <div style={{ maxWidth: 480, margin: '40px auto' }}>
        <Container
          header={
            <Header
              variant="h1"
              description="Real-time per-IAM-principal × per-model Bedrock spend metering and budget enforcement."
            >
              Bedrock Budget Guard
            </Header>
          }
        >
          {error && (
            <Box margin={{ bottom: 'm' }}>
              <Alert
                type={error.includes('reset') ? 'success' : 'error'}
                dismissible
                onDismiss={() => setError(undefined)}
              >
                {error}
              </Alert>
            </Box>
          )}

          {phase.kind === 'sign-in' && (
            <Form
              actions={
                <SpaceBetween size="xs" direction="horizontal">
                  <Button
                    variant="link"
                    onClick={() => {
                      setPhase({ kind: 'forgot-start' });
                      setError(undefined);
                    }}
                  >
                    Forgot password?
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void handleSignIn()}
                    loading={submitting}
                    disabled={!email || !password}
                  >
                    Sign in
                  </Button>
                </SpaceBetween>
              }
            >
              <SpaceBetween size="m">
                <FormField label="Email">
                  <Input
                    value={email}
                    onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setEmail(e.detail.value)}
                    placeholder="admin@example.com"
                    autoFocus
                  />
                </FormField>
                <FormField label="Password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setPassword(e.detail.value)}
                  />
                </FormField>
                <Box textAlign="center">
                  <Button
                    variant="normal"
                    iconName="key"
                    onClick={() => void handlePasskeySignIn()}
                    disabled={!email || submitting}
                  >
                    Sign in with passkey or security key
                  </Button>
                  <Box variant="small" color="text-status-inactive" margin={{ top: 'xs' }}>
                    The browser will pick the authenticator. To use a hardware key (e.g. YubiKey)
                    when a passkey is also registered, click "Use a different passkey" or
                    "Other devices" in the system prompt.
                  </Box>
                </Box>
              </SpaceBetween>
            </Form>
          )}

          {phase.kind === 'new-password' && (
            <Form
              actions={
                <Button
                  variant="primary"
                  onClick={() => void handleNewPassword()}
                  loading={submitting}
                  disabled={password.length < 12}
                >
                  Set password & sign in
                </Button>
              }
            >
              <SpaceBetween size="m">
                <Alert type="info">
                  This is your first sign-in. Choose a permanent password of at least 12 characters with
                  upper, lower, digit and symbol.
                </Alert>
                <FormField label="New password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setPassword(e.detail.value)}
                    autoFocus
                  />
                </FormField>
              </SpaceBetween>
            </Form>
          )}

          {phase.kind === 'forgot-start' && (
            <Form
              actions={
                <SpaceBetween size="xs" direction="horizontal">
                  <Button
                    variant="link"
                    onClick={() => {
                      setPhase({ kind: 'sign-in' });
                      setError(undefined);
                    }}
                  >
                    Back to sign-in
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void handleForgotStart()}
                    loading={submitting}
                    disabled={!email}
                  >
                    Send reset code
                  </Button>
                </SpaceBetween>
              }
            >
              <SpaceBetween size="m">
                <FormField label="Email">
                  <Input
                    value={email}
                    onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setEmail(e.detail.value)}
                    placeholder="you@example.com"
                    autoFocus
                  />
                </FormField>
              </SpaceBetween>
            </Form>
          )}

          {phase.kind === 'forgot-confirm' && (
            <Form
              actions={
                <SpaceBetween size="xs" direction="horizontal">
                  <Button
                    variant="link"
                    onClick={() => {
                      setPhase({ kind: 'sign-in' });
                      setError(undefined);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void handleForgotConfirm()}
                    loading={submitting}
                    disabled={!code || password.length < 12}
                  >
                    Reset password
                  </Button>
                </SpaceBetween>
              }
            >
              <SpaceBetween size="m">
                <Alert type="info">A reset code was emailed to {phase.username}.</Alert>
                <FormField label="Reset code">
                  <Input value={code} onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setCode(e.detail.value)} autoFocus />
                </FormField>
                <FormField label="New password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e: NonCancelableCustomEvent<{ value: string }>) => setPassword(e.detail.value)}
                  />
                </FormField>
              </SpaceBetween>
            </Form>
          )}

          {phase.kind === 'signed-out' && (
            <Box>
              You're signed out.{' '}
              <Link onFollow={() => setPhase({ kind: 'sign-in' })}>Sign back in</Link>.
            </Box>
          )}
        </Container>
      </div>
    </Box>
  );
};
