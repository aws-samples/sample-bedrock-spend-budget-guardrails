/**
 * Regression guard for the no-custom-domain WebAuthn/passkey path.
 *
 * History: the no-domain deploy enabled passkey with a second custom resource
 * that called `UpdateUserPool` to add WEB_AUTHN to the sign-in policy.
 * `UpdateUserPool` is a coarse, destructive-replace API — "if you don't provide
 * a value for an attribute, Amazon Cognito sets it to its default value" — so it
 * reverted every field it omitted on the live pool, including the
 * pre-token-generation trigger that mints the `bbg:scope` admin-authZ claim, the
 * invite-message template, and Threat Protection (UserPoolAddOns).
 *
 * The fix: put WEB_AUTHN in the pool's sign-in policy at synth in BOTH deploy
 * modes, and let the web-stack custom resource patch in only the relying-party
 * ID (via the targeted, non-destructive SetUserPoolMfaConfig). These tests pin
 * that shape so nobody reintroduces the destructive call.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { NetworkAndAuthStack } from '../lib/network-and-auth-stack.js';
import { WebAuthnCloudFrontRp } from '../lib/constructs/webauthn-cloudfront-rp.js';

const authTemplate = (domainName?: string): Template => {
  const app = new cdk.App();
  const stack = new NetworkAndAuthStack(app, 'Auth', {
    stagePrefix: 'prod',
    domainName,
    env: { account: '123456789012', region: 'us-west-2' },
  });
  return Template.fromStack(stack);
};

describe.each([
  ['no custom domain', undefined],
  ['custom domain', 'bbg.example.com'],
])('User Pool passkey config (%s)', (_label, domainName) => {
  const template = authTemplate(domainName as string | undefined);

  it('allows WEB_AUTHN as a first-auth factor', () => {
    // Previously gated on `domainName`, which is what left no-domain pools
    // with passkey off and motivated the destructive UpdateUserPool patch.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] },
      },
    });
  });

  it('keeps the pre-token-generation V2 trigger that mints bbg:scope', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0];
    expect(pool?.Properties?.LambdaConfig?.PreTokenGenerationConfig?.LambdaVersion).toBe('V2_0');
  });

  it('keeps self-signup off and Threat Protection on', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
    });
  });
});

describe('WebAuthnCloudFrontRp (no-domain relying-party patch)', () => {
  const rpTemplate = (): Template => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Web', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new WebAuthnCloudFrontRp(stack, 'WebAuthnRp', {
      userPoolId: 'us-west-2_abc123',
      cloudFrontDomain: 'd111abcdef8.cloudfront.net',
    });
    return Template.fromStack(stack);
  };

  it('sets the relying-party ID to the full CloudFront hostname', () => {
    const template = rpTemplate();
    const resources = template.findResources('Custom::WebAuthnRelyingPartyId');
    const create = JSON.parse(Object.values(resources)[0]?.Properties?.Create as string) as {
      action: string;
      parameters: { WebAuthnConfiguration: { RelyingPartyId: string } };
    };
    expect(create.action).toBe('setUserPoolMfaConfig');
    expect(create.parameters.WebAuthnConfiguration.RelyingPartyId).toBe(
      'd111abcdef8.cloudfront.net',
    );
  });

  it('NEVER calls the destructive UpdateUserPool API', () => {
    const template = rpTemplate();
    // Assert over the whole synthesized template so any future custom resource
    // (or IAM grant) that reintroduces UpdateUserPool trips this test.
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).not.toMatch(/updateUserPool/i);
    expect(rendered).not.toMatch(/UpdateUserPool/);
  });

  it('grants only the targeted MFA-config permissions', () => {
    const template = rpTemplate();
    const policies = template.findResources('AWS::IAM::Policy');
    const actions = Object.values(policies)
      .flatMap((p) => (p.Properties?.PolicyDocument?.Statement ?? []) as { Action?: unknown }[])
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a): a is string => typeof a === 'string')
      .filter((a) => a.startsWith('cognito-idp:'));
    expect(actions).toEqual(
      expect.arrayContaining([
        'cognito-idp:SetUserPoolMfaConfig',
        'cognito-idp:GetUserPoolMfaConfig',
      ]),
    );
    expect(actions).not.toContain('cognito-idp:UpdateUserPool');
  });
});
