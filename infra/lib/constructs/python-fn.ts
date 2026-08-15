import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface BbgPythonFunctionProps {
  /** Directory under `lambda/python/` (e.g. `readiness` resolves to
   *  `lambda/python/readiness/`, with `handler.py` as the entry). */
  readonly handlerDir: string;
  /** Lambda handler string. Defaults to `handler.handler`. */
  readonly handler?: string;
  readonly functionName?: string;
  readonly timeout?: Duration;
  readonly memorySize?: number;
  readonly environment?: Record<string, string>;
}

/**
 * Python sibling of {@link BbgNodejsFunction}. Project-wide defaults: Python
 * 3.12 on ARM64 (Graviton), 14-day log retention, X-Ray active tracing.
 *
 * The asset is built by a Docker `pip install` step at synth time — the
 * pipeline runs with `dockerEnabledForSynth: true`. `requirements.txt` deps
 * are pure-Python (boto3 + transitive), so cross-arch bundling is safe.
 */
export class BbgPythonFunction extends lambda.Function {
  constructor(scope: Construct, id: string, props: BbgPythonFunctionProps) {
    const assetPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'lambda',
      'python',
      props.handlerDir,
    );

    super(scope, id, {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: props.handler ?? 'handler.handler',
      code: lambda.Code.fromAsset(assetPath, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash',
            '-c',
            // Install pinned deps into the output, then copy the vendored
            // audit packages + handler alongside them.
            'pip install -r requirements.txt -t /asset-output && cp -r core modes handler.py /asset-output',
          ],
          // Host-side bundling fallback so synth/deploy works without Docker
          // (the CI pipeline has Docker; local dev machines may not). The
          // deps are pure-Python wheels, so host pip output runs on the
          // Lambda runtime regardless of the host's Python version/arch.
          // Returns false to defer to the Docker path when no host
          // python3 + pip is available.
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync('python3 -m pip --version', { stdio: 'ignore' });
              } catch {
                return false;
              }
              execSync(
                `python3 -m pip install --no-input -r requirements.txt -t "${outputDir}"`,
                { cwd: assetPath, stdio: 'inherit' },
              );
              for (const item of ['core', 'modes', 'handler.py']) {
                execSync(`cp -r "${path.join(assetPath, item)}" "${outputDir}/"`, {
                  stdio: 'inherit',
                });
              }
              return true;
            },
          },
        },
      }),
      functionName: props.functionName,
      timeout: props.timeout ?? Duration.seconds(30),
      memorySize: props.memorySize ?? 512,
      tracing: lambda.Tracing.ACTIVE,
      // `logRetention` is deprecated; use an explicit LogGroup (see nodejs-fn.ts).
      logGroup: new logs.LogGroup(scope, `${id}LogGroup`, {
        retention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: props.environment,
    });
  }
}
