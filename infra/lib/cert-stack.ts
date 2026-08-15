import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface CertStackProps extends cdk.StackProps {
  readonly hostedZoneName: string; // e.g. "example.com"
  readonly hostedZoneId: string;
}

/**
 * CloudFront requires its ACM certificates to live in us-east-1, while the
 * rest of BBG runs in us-west-2. This stack lives in us-east-1 and exports
 * a wildcard cert for the project's domain. Cross-region references are
 * resolved automatically by CDK when the consuming stack imports
 * `certificateArn`.
 *
 * Wildcard scope keeps every future subdomain (dev, prod, ephemeral
 * preview, sibling apps under the same zone) covered by one cert.
 */
export class CertStack extends cdk.Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, {
      ...props,
      crossRegionReferences: true,
      env: {
        // Force us-east-1 regardless of stage env.
        account: props.env?.account,
        region: 'us-east-1',
      },
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    this.certificate = new acm.Certificate(this, 'WildcardCert', {
      domainName: `*.${props.hostedZoneName}`,
      subjectAlternativeNames: [props.hostedZoneName],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    new cdk.CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}
