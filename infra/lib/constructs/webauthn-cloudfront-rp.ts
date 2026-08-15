import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface WebAuthnCloudFrontRpProps {
  readonly userPoolId: string;
  /** CloudFront distribution domain, e.g. `d111abcdef8.cloudfront.net`. */
  readonly cloudFrontDomain: string;
}

/**
 * Enables Cognito WebAuthn (passkey) sign-in for a NO-CUSTOM-DOMAIN deploy,
 * where the SPA is served from the CloudFront `*.cloudfront.net` URL.
 *
 * WHY THIS EXISTS
 * ---------------
 * WebAuthn needs a Relying-Party ID that is a registrable suffix of the page
 * origin. With a custom domain we set `WebAuthnRelyingPartyID` on the User Pool
 * at synth (in network-and-auth-stack.ts). Without one, the RP ID has to be the
 * *full* CloudFront distribution hostname (`cloudfront.net` is on the Public
 * Suffix List, so the bare apex can't be used) — and that hostname isn't known
 * in the auth stack, which is created BEFORE the Web/CloudFront stack.
 *
 * This construct lives in the Web stack (which DOES know the CloudFront domain)
 * and patches in just the RP ID via SetUserPoolMfaConfig. The pool itself is
 * already created with `WEB_AUTHN` in Policies.SignInPolicy
 * .AllowedFirstAuthFactors (unconditionally, both deploy modes), so the RP ID is
 * the only piece that has to wait for the distribution to exist.
 *
 * Only instantiated in the no-domain case; when a custom domain is configured
 * the auth stack already sets the RP ID at synth and this construct is not
 * created.
 *
 * DO NOT ADD AN `updateUserPool` CALL HERE
 * ----------------------------------------
 * An earlier version of this construct also called `UpdateUserPool` to add
 * WEB_AUTHN to the sign-in policy. `UpdateUserPool` is a COARSE,
 * destructive-replace API: per the API reference, "if you don't provide a value
 * for an attribute, Amazon Cognito sets it to its default value" — it is not a
 * partial patch. That call silently reverted every field it omitted on the live
 * no-domain pool, including:
 *   - `LambdaConfig` → `{}`, dropping the pre-token-generation V2 trigger that
 *     mints the `bbg:scope` / `bbg:principal` claims. Admin authZ reads those
 *     claims (lambda/src/shared/api.ts), so admin endpoints started failing
 *     closed for every user whose token was minted afterwards.
 *   - `AdminCreateUserConfig.InviteMessageTemplate` → dropped (invite emails
 *     lose their branded body) and `UnusedAccountValidityDays` → 0.
 *   - `UserPoolAddOns` → dropped, turning OFF Threat Protection.
 * `AllowedFirstAuthFactors` needs no `UpdateUserPool` at all: `CreateUserPool`
 * has no relying-party-ID parameter, so CloudFormation necessarily creates
 * passkey-enabled pools with WEB_AUTHN set and the RP ID applied separately —
 * which is exactly what the auth stack now does in both deploy modes.
 * SetUserPoolMfaConfig below is a targeted setter and touches nothing else.
 */
export class WebAuthnCloudFrontRp extends Construct {
  constructor(scope: Construct, id: string, props: WebAuthnCloudFrontRpProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Set the WebAuthn relying-party ID to the CloudFront hostname. This is the
    // targeted (non-destructive) MFA/WebAuthn setter — it does not touch the
    // rest of the pool config.
    const setRp = {
      service: 'CognitoIdentityServiceProvider',
      action: 'setUserPoolMfaConfig',
      parameters: {
        UserPoolId: props.userPoolId,
        WebAuthnConfiguration: {
          RelyingPartyId: props.cloudFrontDomain,
          UserVerification: 'preferred',
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of(
        `webauthn-rp-${props.userPoolId}-${props.cloudFrontDomain}`,
      ),
    };

    new cr.AwsCustomResource(this, 'SetRelyingPartyId', {
      resourceType: 'Custom::WebAuthnRelyingPartyId',
      onCreate: setRp,
      onUpdate: setRp,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:SetUserPoolMfaConfig', 'cognito-idp:GetUserPoolMfaConfig'],
          resources: [`arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/${props.userPoolId}`],
        }),
      ]),
      installLatestAwsSdk: false,
    });
  }
}
