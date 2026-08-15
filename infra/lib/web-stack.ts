import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3Deployment from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import type { ApiStack } from './api-stack.js';
import type { NetworkAndAuthStack } from './network-and-auth-stack.js';
import { WebAuthnCloudFrontRp } from './constructs/webauthn-cloudfront-rp.js';

export interface WebStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly auth: NetworkAndAuthStack;
  readonly api: ApiStack;
  /** Optional. When provided, CloudFront uses this as an alternate domain name + cert. */
  readonly domainName?: string;
  readonly certificate?: acm.ICertificate;
  readonly hostedZoneName?: string;
  readonly hostedZoneId?: string;
  /** Optional WAFv2 WebACL ARN (must be us-east-1 / scope=CLOUDFRONT). */
  readonly webAclArn?: string;
}

/**
 * Static React/Vite/Cloudscape app hosted on S3 + CloudFront with OAC.
 *
 * When `domainName` + `certificate` are provided, the distribution attaches
 * the alternate domain name and a Route53 alias record points the domain at
 * the distribution. Otherwise CloudFront keeps its random *.cloudfront.net
 * subdomain — useful for first-deploy bootstrap before the cert is issued.
 */
export class WebStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly hostingBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });

    const { stagePrefix } = props;
    const removalPolicy = stagePrefix === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const autoDelete = stagePrefix !== 'prod';

    // Customer-managed KMS key for the hosting bucket. SSE-KMS satisfies
    // Control Tower CT.S3.PR.10; using a CMK (vs. AWS-managed `aws/s3`)
    // lets CDK auto-grant the CloudFront OAC `kms:Decrypt` so static
    // assets are readable through the distribution.
    const webHostingKey = new kms.Key(this, 'WebHostingKey', {
      description: `${stagePrefix} BBG web hosting bucket encryption key`,
      enableKeyRotation: true,
      removalPolicy,
    });

    this.hostingBucket = new s3.Bucket(this, 'WebHosting', {
      bucketName: `${stagePrefix}-bbg-web-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: webHostingKey,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: autoDelete,
    });

    const domainConfig = props.domainName && props.certificate
      ? {
          domainNames: [props.domainName],
          certificate: props.certificate,
        }
      : {};

    // Security response headers for every viewer response. Without this the
    // admin UI is iframeable (clickjack into /admin/budgets:apply,
    // /admin/enrollment/config, /admin/users) and ships no HSTS. The CSP's
    // `frame-ancestors 'none'` (with X-Frame-Options DENY for legacy browsers)
    // blocks framing; Strict-Transport-Security, X-Content-Type-Options and
    // Referrer-Policy round out the hardening. The CSP is scoped to 'self'
    // plus the AWS endpoints the SPA calls at boot (config.json, API Gateway,
    // Cognito sign-in); `style-src 'unsafe-inline'` is required by Cloudscape.
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${stagePrefix}-bbg-web-security-headers`,
      comment: 'BBG web security response headers (clickjacking + HSTS hardening)',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self'",
            "connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com",
            "form-action 'self'",
            'upgrade-insecure-requests',
          ].join('; '),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.hostingBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(props.webAclArn ? { webAclId: props.webAclArn } : {}),
      ...domainConfig,
    });

    // Route53 alias when we have the domain+cert+zone trio.
    if (props.domainName && props.hostedZoneName && props.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });
      new route53.ARecord(this, 'AliasA', {
        zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      });
      new route53.AaaaRecord(this, 'AliasAAAA', {
        zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      });
    }

    // The SPA reads /config.json at boot via web/src/config.ts. Build it
    // here from CFN outputs of the auth + api stacks so the build never
    // ships with a stale or missing config (which would drop the SPA into
    // its local-dev escape hatch and break sign-in).
    const appUrl = props.domainName
      ? `https://${props.domainName}`
      : `https://${this.distribution.distributionDomainName}`;

    // WebAuthn / passkey relying-party ID must be a registrable suffix of the
    // page origin. With a custom domain the auth stack already set the RP ID at
    // synth. Without one, the RP ID has to be the full CloudFront hostname
    // (`cloudfront.net` is a public suffix), which is only known HERE — so we
    // patch just the RP ID onto the pool via a custom resource that runs after
    // the distribution exists. Either way the SPA can offer passkey.
    if (!props.domainName) {
      new WebAuthnCloudFrontRp(this, 'WebAuthnRp', {
        userPoolId: props.auth.userPool.userPoolId,
        cloudFrontDomain: this.distribution.distributionDomainName,
      });
    }

    const runtimeConfig = {
      region: cdk.Stack.of(this).region,
      userPoolId: props.auth.userPool.userPoolId,
      userPoolClientId: props.auth.userPoolClient.userPoolClientId,
      userPoolDomain: props.auth.userPoolDomain.domainName,
      apiBaseUrl: props.api.httpApi.apiEndpoint,
      gatewayBaseUrl: '',
      cloudfrontUrl: `https://${this.distribution.distributionDomainName}`,
      appUrl,
      // Passkey is available in both the custom-domain and no-domain paths (the
      // WebAuthnCloudFrontRp custom resource enables it for the latter). Kept as
      // an explicit flag so the SPA can hide passkey affordances if a future
      // deploy mode can't support WebAuthn.
      webAuthnEnabled: true,
    };

    // Deploy `web/dist/` if it exists, plus a freshly-rendered /config.json
    // so the SPA can sign in against this stage's Cognito + API regardless
    // of whether anyone ran scripts/dump-config locally.
    const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
    // The SPA bundle (`web/dist`) is built by the pipeline before synth. In the
    // local dev flow it may not exist yet — `Source.asset` on a missing dir
    // throws `CannotFindAsset` and aborts the whole synth (flagged during a
    // security review). Guard it: deploy the bundle when present, otherwise
    // deploy just config.json so synth/deploy still succeeds. Build with
    // `npm --workspace web run build` to include the SPA.
    const hasWebDist = fs.existsSync(webDist);
    if (!hasWebDist) {
      cdk.Annotations.of(this).addWarning(
        `web/dist not found at ${webDist} — deploying config.json only. Run \`npm --workspace web run build\` first to include the SPA bundle.`,
      );
    }
    new s3Deployment.BucketDeployment(this, 'WebDeploy', {
      sources: [
        ...(hasWebDist ? [s3Deployment.Source.asset(webDist, { exclude: ['**/.DS_Store'] })] : []),
        s3Deployment.Source.jsonData('config.json', runtimeConfig),
      ],
      destinationBucket: this.hostingBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
      // CDK's BucketDeployment provider Lambda defaults to 128 MB. The asset
      // unzip + `aws s3 sync` of the Cloudscape SPA bundle exceeds that and
      // gets OOM-killed (Runtime.OutOfMemory), failing the deploy. 1 GB gives
      // ample headroom as the bundle grows.
      memoryLimit: 1024,
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${this.distribution.distributionDomainName}` });
    if (props.domainName) {
      new cdk.CfnOutput(this, 'AppUrl', { value: `https://${props.domainName}` });
    }
    new cdk.CfnOutput(this, 'HostingBucketName', { value: this.hostingBucket.bucketName });
  }
}
