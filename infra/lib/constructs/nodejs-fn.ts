import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface BbgNodejsFunctionProps
  extends Omit<nodejs.NodejsFunctionProps, 'runtime' | 'architecture' | 'bundling'> {
  /** Path under `lambda/src/` (e.g. `meter` resolves to `lambda/src/meter/index.ts`). */
  readonly handlerName: string;
}

/**
 * Wraps NodejsFunction with project-wide defaults: ARM64 (Graviton), Node 24,
 * 14-day log retention, sane bundling, and X-Ray active tracing.
 */
export class BbgNodejsFunction extends nodejs.NodejsFunction {
  constructor(scope: Construct, id: string, props: BbgNodejsFunctionProps) {
    const { handlerName, ...rest } = props;
    const entry = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'lambda',
      'src',
      handlerName,
      'index.ts',
    );

    super(scope, id, {
      entry,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      memorySize: rest.memorySize ?? 512,
      timeout: rest.timeout ?? Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      // `logRetention` is deprecated (it provisions a custom-resource Lambda per
      // function); the modern replacement is an explicit LogGroup with the
      // retention set. Parented to `scope` so it's constructable before super().
      logGroup: new logs.LogGroup(scope, `${id}LogGroup`, {
        retention: logs.RetentionDays.TWO_WEEKS,
      }),
      bundling: {
        target: 'node24',
        format: nodejs.OutputFormat.CJS,
        sourceMap: true,
        minify: false,
        externalModules: [
          // Provided by the Lambda runtime; do not bundle.
          '@aws-sdk/*',
        ],
      },
      ...rest,
    });
  }
}
