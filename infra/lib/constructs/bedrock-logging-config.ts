import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface BedrockLoggingConfigProps {
  readonly logGroup: logs.LogGroup;
  readonly region: string;
}

/**
 * Custom resource that calls bedrock:PutModelInvocationLoggingConfiguration
 * on first deploy so model invocation logs land in our CloudWatch log group.
 * Calls Delete on stack removal so we don't leave orphaned config.
 */
export class BedrockLoggingConfig extends Construct {
  constructor(scope: Construct, id: string, props: BedrockLoggingConfigProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Bedrock requires a role it can assume to write the logs.
    const deliveryRole = new iam.Role(this, 'DeliveryRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${props.region}:${stack.account}:*` },
        },
      }),
    });
    props.logGroup.grantWrite(deliveryRole);

    new cr.AwsCustomResource(this, 'PutLoggingConfig', {
      resourceType: 'Custom::BedrockLoggingConfig',
      onCreate: {
        service: 'bedrock',
        action: 'PutModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: props.logGroup.logGroupName,
              roleArn: deliveryRole.roleArn,
            },
            textDataDeliveryEnabled: false,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            videoDataDeliveryEnabled: false,
          },
        },
        region: props.region,
        physicalResourceId: cr.PhysicalResourceId.of(`bedrock-logging-${props.region}`),
      },
      onUpdate: {
        service: 'bedrock',
        action: 'PutModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: props.logGroup.logGroupName,
              roleArn: deliveryRole.roleArn,
            },
            textDataDeliveryEnabled: false,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            videoDataDeliveryEnabled: false,
          },
        },
        region: props.region,
        physicalResourceId: cr.PhysicalResourceId.of(`bedrock-logging-${props.region}`),
      },
      onDelete: {
        service: 'bedrock',
        action: 'DeleteModelInvocationLoggingConfiguration',
        region: props.region,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
            'bedrock:GetModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [deliveryRole.roleArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
  }
}
