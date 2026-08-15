/**
 * Runtime configuration. In dev, populated from `web/.env.local` (Vite
 * `import.meta.env.VITE_*`). In prod, the deploy step writes
 * `/config.json` to the S3 bucket, which `loadConfig()` fetches and
 * merges over the env defaults.
 */

export interface BbgConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  userPoolDomain: string;
  apiBaseUrl: string;
  gatewayBaseUrl: string;
  /**
   * Whether WebAuthn / passkey sign-in is enabled on the User Pool for this
   * deploy. The SPA hides its passkey affordances when false so operators
   * never see a button that errors. Written by the Web stack into config.json;
   * defaults to true (both custom-domain and CloudFront-only deploys support
   * passkey).
   */
  webAuthnEnabled: boolean;
}

export const fromEnv = (): BbgConfig => ({
  region: import.meta.env.VITE_AWS_REGION ?? 'us-west-2',
  userPoolId: import.meta.env.VITE_USER_POOL_ID ?? '',
  userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID ?? '',
  userPoolDomain: import.meta.env.VITE_USER_POOL_DOMAIN ?? '',
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  gatewayBaseUrl: import.meta.env.VITE_GATEWAY_BASE_URL ?? '',
  webAuthnEnabled: import.meta.env.VITE_WEBAUTHN_ENABLED !== 'false',
});

export const loadConfig = async (): Promise<BbgConfig> => {
  const env = fromEnv();
  try {
    const resp = await fetch('/config.json', { cache: 'no-store' });
    if (resp.ok) {
      const json = (await resp.json()) as Partial<BbgConfig>;
      return { ...env, ...json };
    }
  } catch {
    // Ignore — fall back to env values.
  }
  return env;
};
