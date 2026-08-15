import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { BbgNodejsFunction } from './constructs/nodejs-fn.js';

export interface NetworkAndAuthStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  /** Custom domain for the deployed app (e.g. sample-bedrock-spend-budget-guardrails-dev.example.com). */
  readonly domainName?: string;
}

export class NetworkAndAuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: NetworkAndAuthStackProps) {
    super(scope, id, props);

    const { stagePrefix, domainName } = props;
    const removalPolicy = stagePrefix === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const siteUrl = domainName ? `https://${domainName}` : 'the BBG sign-in page';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${stagePrefix}-bbg`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      userInvitation: {
        emailSubject: 'Welcome to Bedrock Budget Guard',
        emailBody: [
          '<p>Hi,</p>',
          '<p>An administrator created a Bedrock Budget Guard account for you.</p>',
          // nosemgrep: html-in-template-string - not a browser DOM sink and no untrusted
          // input. `siteUrl` derives from the operator-set `bbg:domainNames` CDK context
          // (a deploy-time config value, see stages/app-stage.ts), and this string is a
          // Cognito user-invitation email body rendered by Cognito's email service.
          `<p><strong>Sign in:</strong> <a href="${siteUrl}">${siteUrl}</a></p>`,
          '<p><strong>Username:</strong> {username}<br/>',
          '<strong>Temporary password:</strong> {####}</p>',
          '<p>You\'ll be prompted to set a permanent password on first sign-in. The temporary password expires in 3 days.</p>',
          '<p>— Bedrock Budget Guard</p>',
        ].join('\n'),
        smsMessage: `BBG account created. Username: {username}, temp password: {####}. Sign in: ${siteUrl}`,
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      // MFA via WebAuthn / passkey only — no TOTP, no SMS.
      mfa: cognito.Mfa.OFF,
      featurePlan: cognito.FeaturePlan.PLUS, // Required for WebAuthn.
      // First-factor sign-in: password OR passkey (FIDO2 / YubiKey / platform
      // authenticator). Configured at the User Pool level so the AppClient
      // can negotiate either.
      //
      // Set UNCONDITIONALLY — including on no-custom-domain deploys. The
      // relying-party ID is a separate setting (SetUserPoolMfaConfig, patched
      // in later by WebAuthnCloudFrontRp when there's no domain), and Cognito
      // accepts WEB_AUTHN as a first-auth factor before an RP ID exists: the
      // CreateUserPool API has no RP-ID parameter at all, so CloudFormation
      // itself necessarily creates every passkey-enabled pool this way. Gating
      // this on `domainName` is what left no-domain pools with passkey off.
      signInPolicy: {
        allowedFirstAuthFactors: { password: true, passkey: true },
      },
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      customAttributes: {
        iam_principal: new cognito.StringAttribute({ mutable: true }),
        sso_email: new cognito.StringAttribute({ mutable: true }),
        team: new cognito.StringAttribute({ mutable: true }),
        // Notification preferences — string 'true'/'false'/'' (empty
        // defaults to opt-in for the user-self channels and opt-out
        // for the admin-watch channel). Read by lambda/src/notify on
        // every send.
        notify_50pct: new cognito.StringAttribute({ mutable: true, maxLen: 5 }),
        notify_80pct: new cognito.StringAttribute({ mutable: true, maxLen: 5 }),
        notify_100pct: new cognito.StringAttribute({ mutable: true, maxLen: 5 }),
        notify_enforcement: new cognito.StringAttribute({ mutable: true, maxLen: 5 }),
        // Per-user notification floor — only emit threshold-crossing
        // emails for budget thresholds at or above this percentage.
        // Persisted as the numeric percent ('50' / '75' / '80' / '90'
        // / '100') or '101' for "never". Missing falls back to the
        // legacy 3 toggles via notify Lambda's compat read.
        notify_pct_floor: new cognito.StringAttribute({ mutable: true, maxLen: 4 }),
        // Per-admin opt-in: when set to 'true' on a user in the Admins
        // group, that user receives a copy of EVERY enforcement email
        // across the org (not just for their own IAM principal).
        // Cognito caps custom attribute names at 20 chars — keep this
        // short.
        notify_admin_watch: new cognito.StringAttribute({
          mutable: true,
          maxLen: 5,
        }),
      },
      removalPolicy,
      deletionProtection: stagePrefix === 'prod',
    });

    // WebAuthn relying-party ID + user-verification policy. The CDK L2
    // exposes signInPolicy.allowedFirstAuthFactors but not these two fields
    // (as of aws-cdk-lib 2.170), so we drop down to the L1 properties.
    if (domainName) {
      const cfnPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
      cfnPool.addPropertyOverride('WebAuthnRelyingPartyID', domainName);
      cfnPool.addPropertyOverride('WebAuthnUserVerification', 'required');
    }

    new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Admins',
      description: 'BBG administrators (full read/write of budgets and overrides)',
    });
    new cognito.CfnUserPoolGroup(this, 'UsersGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Users',
      description: 'BBG end users (read-only their own spend and budget)',
    });
    // super-admin group. Members get scope=["*"]; bypasses any
    // per-account scope check on admin endpoints.
    new cognito.CfnUserPoolGroup(this, 'BbgAdminWildcardGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'BBG-Admin-Wildcard',
      description: 'BBG super-admin (scope=["*"], administers every enrolled account)',
    });

    // pre-token-generation V2 trigger. Derives a `bbg:scope`
    // claim listing the account IDs a user can administer based on
    // BBG-Admin-<accountId> group memberships. Empty array = end user
    // with no admin rights (scope check fails closed).
    //
    // V2 (over V1) is required for the `claimsAndScopeOverrideDetails`
    // shape. V2 needs feature plan ≥ ESSENTIALS. We don't pin the tier
    // in the template:
    //  - Default for new pools is ESSENTIALS, which suffices.
    //  - Pools that operators have manually upgraded to PLUS for
    //    Threat Protection / advanced security stay PLUS — pinning
    //    ESSENTIALS in CFN would force-disable Threat Protection on
    //    those pools (CFN error: "The following features need to be
    //    disabled for the ESSENTIALS pricing tier configured: Threat
    //    Protection").
    const cfnPool = this.userPool.node.defaultChild as cognito.CfnUserPool;

    const preTokenGen = new BbgNodejsFunction(this, 'PreTokenGen', {
      functionName: `${stagePrefix}-bbg-pre-token-gen`,
      handlerName: 'pre-token-gen',
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      environment: { STAGE_PREFIX: stagePrefix },
    });

    // Cognito invokes the trigger; allow it.
    preTokenGen.addPermission('AllowCognitoInvoke', {
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      sourceArn: this.userPool.userPoolArn,
      action: 'lambda:InvokeFunction',
    });

    // L2 `userPool.addTrigger(PRE_TOKEN_GENERATION, fn)` only writes the
    // V1 LambdaArn; the V2 shape needs LambdaVersion='V2_0' which only
    // the L1 LambdaConfig.PreTokenGenerationConfig knob exposes.
    cfnPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig', {
      LambdaArn: preTokenGen.functionArn,
      LambdaVersion: 'V2_0',
    });

    // F8: the Vite dev-server callback (http://localhost:5173) is only valid
    // for local development — never register it as a redirect target on prod.
    const isProd = stagePrefix === 'prod';
    const callbackUrls = [
      ...(isProd ? [] : ['http://localhost:5173/callback']),
      ...(domainName ? [`https://${domainName}/callback`] : []),
    ];
    const logoutUrls = [
      ...(isProd ? [] : ['http://localhost:5173']),
      ...(domainName ? [`https://${domainName}`] : []),
    ];
    // The SPA authenticates via the Amplify SDK's USER_AUTH (SRP + passkey /
    // "choose your auth") flow — the Cloudscape-native login — NOT the Cognito
    // hosted-UI OAuth redirect. So callback/logout URLs are only needed by
    // operators who want the hosted UI. A prod deploy with no configured domain
    // legitimately has zero callback URLs (prod drops the localhost fallback);
    // rather than fail synth, we simply omit the `oAuth` block below when there
    // are no callback URLs, so a fresh single-account deploy works out of the
    // box with no DNS/domain prerequisite. (Cognito rejects an OAuth-enabled
    // client with an empty callbackUrls list, which is why we can't pass an
    // empty oAuth block — we drop it entirely instead.)
    const enableHostedUiOAuth = callbackUrls.length > 0;

    // F1: lock down which attributes the SPA (this app client) may write via
    // updateUserAttributes. Notably EXCLUDES `custom:iam_principal` — that
    // attribute drives /me/* spend+budget authZ and is admin-owned (set only
    // via AdminUpdateUserAttributes in the users Lambda). Leaving it
    // self-writable let any signed-in user repoint their /me views at another
    // principal's ledger. `readAttributes` is left at the default (all) so the
    // Profile page can still display the admin-set value.
    const appClientWriteAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({
        fullname: true,
        givenName: true,
        familyName: true,
        preferredUsername: true,
        phoneNumber: true,
        email: true,
      })
      .withCustomAttributes('notify_pct_floor', 'notify_enforcement', 'notify_admin_watch');

    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: `${stagePrefix}-bbg-app`,
      // userAuth (USER_AUTH / "choose your auth") is required for passkey
      // sign-in and for associating WebAuthn credentials. F8: no
      // USER_PASSWORD_AUTH — the SPA only ever uses SRP + passkey, and
      // enabling plaintext-password auth needlessly widens the
      // credential-stuffing surface.
      authFlows: { userSrp: true, user: true },
      writeAttributes: appClientWriteAttributes,
      generateSecret: false,
      preventUserExistenceErrors: true,
      // Hosted-UI OAuth is optional (SPA uses USER_AUTH/SRP+passkey). Only
      // register it when a domain provides callback URLs — Cognito rejects an
      // OAuth-enabled client with an empty callbackUrls list.
      ...(enableHostedUiOAuth
        ? {
            oAuth: {
              flows: { authorizationCodeGrant: true },
              scopes: [
                cognito.OAuthScope.OPENID,
                cognito.OAuthScope.EMAIL,
                cognito.OAuthScope.PROFILE,
              ],
              callbackUrls,
              logoutUrls,
            },
          }
        : {}),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Hosted UI domain. Stage-prefixed so dev and prod don't collide.
    // Override via cdk.json context `bbg:cognitoDomainPrefix` (string or
    // per-stage object map).
    const overrideRaw = this.node.tryGetContext('bbg:cognitoDomainPrefix') as
      | string
      | Record<string, string>
      | undefined;
    const overridePrefix =
      typeof overrideRaw === 'string' ? overrideRaw : overrideRaw?.[stagePrefix];
    const defaultPrefix =
      `${stagePrefix}-bbg-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`.toLowerCase();
    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: overridePrefix ?? defaultPrefix },
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'UserPoolDomain', { value: this.userPoolDomain.domainName });
    new cdk.CfnOutput(this, 'UserPoolIssuer', {
      value: `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}`,
    });
  }
}
