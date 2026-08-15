import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BbgNodejsFunction } from './constructs/nodejs-fn.js';
import type { DataStack } from './data-stack.js';
import type { NetworkAndAuthStack } from './network-and-auth-stack.js';

export interface GatewayStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly auth: NetworkAndAuthStack;
  readonly data: DataStack;
}

/**
 * Optional end-user-attribution proxy for Bedrock. Disabled by default
 * (`bbg:enableGateway` context flag). When enabled, the gateway Lambda
 * assumes a dedicated role with transitive session tags + sts:SetSourceIdentity
 * before invoking Bedrock so CloudTrail records the human caller even when
 * routing through Bedrock Agents.
 */
export class GatewayStack extends cdk.Stack {
  readonly gatewayFn: BbgNodejsFunction;
  readonly invokeRole: iam.Role;
  readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    const { stagePrefix, auth } = props;

    // The invoke role's name is fixed, so its ARN is computable WITHOUT
    // referencing the role object. That lets the Lambda depend on the ARN
    // (env + sts:AssumeRole grant) while the role's trust policy depends on the
    // Lambda's execution role — no CDK dependency cycle. Trusting the exact
    // Lambda role (instead of the whole account) removes the manual
    // post-deploy tighten flagged during a security review.
    const invokeRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: `${stagePrefix}-bbg-gateway-invoke`,
    });

    this.gatewayFn = new BbgNodejsFunction(this, 'Gateway', {
      functionName: `${stagePrefix}-bbg-gateway`,
      handlerName: 'gateway',
      timeout: Duration.seconds(60),
      memorySize: 1024,
      environment: {
        STAGE_PREFIX: stagePrefix,
        INVOKE_ROLE_ARN: invokeRoleArn,
      },
    });
    this.gatewayFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
        resources: [invokeRoleArn],
      }),
    );

    this.invokeRole = new iam.Role(this, 'BedrockGatewayInvokeRole', {
      roleName: `${stagePrefix}-bbg-gateway-invoke`,
      // Assumable ONLY by the gateway Lambda's execution role (not the whole
      // account) — scoped at synth, no manual post-deploy step.
      assumedBy: new iam.ArnPrincipal(this.gatewayFn.role!.roleArn),
      description: 'Role assumed by the BBG gateway Lambda with transitive session tags.',
    });
    this.invokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
        resources: ['*'],
      }),
    );
    this.invokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agent-runtime:InvokeAgent', 'bedrock-agent-runtime:Retrieve', 'bedrock-agent-runtime:RetrieveAndGenerate'],
        resources: ['*'],
      }),
    );

    this.httpApi = new apigwv2.HttpApi(this, 'GatewayApi', {
      apiName: `${stagePrefix}-bbg-gateway-api`,
      corsPreflight: {
        allowOrigins: ['http://localhost:5173'],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
      },
    });

    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${auth.userPool.userPoolId}`;
    const authorizer = new apigwv2Auth.HttpJwtAuthorizer('GatewayJwt', issuer, {
      jwtAudience: [auth.userPoolClient.userPoolClientId],
    });

    this.httpApi.addRoutes({
      path: '/gateway/invoke',
      methods: [apigwv2.HttpMethod.POST],
      authorizer,
      integration: new apigwv2Int.HttpLambdaIntegration('GatewayIntegration', this.gatewayFn),
    });
    this.httpApi.addRoutes({
      path: '/gateway/agents/{agentId}',
      methods: [apigwv2.HttpMethod.POST],
      authorizer,
      integration: new apigwv2Int.HttpLambdaIntegration('GatewayAgentIntegration', this.gatewayFn),
    });

    new cdk.CfnOutput(this, 'GatewayApiUrl', { value: this.httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'InvokeRoleArn', { value: this.invokeRole.roleArn });
  }
}
