import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BbgNodejsFunction } from './constructs/nodejs-fn.js';
import type { DataStack } from './data-stack.js';

export interface CurStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly data: DataStack;
}

/**
 * CUR 2.0 IAM-principal-allocation reconciliation.
 *
 * The CUR 2.0 export itself must be created once via the Billing console (the
 * UI-only `Include caller identity (IAM principal) allocation data` checkbox
 * sets the undocumented `INCLUDE_IAM_PRINCIPAL_DATA: TRUE` table-config flag,
 * which the bcm-data-exports CreateExport API doesn't expose). See README.
 *
 * Once that one-time export exists, this stack:
 *   1. Creates a Glue database + crawler that scans the export's S3 prefix
 *      daily so the schema stays in sync as AWS adds CUR columns.
 *   2. Deploys the reconciler Lambda that queries Athena against the crawled
 *      table and compares per-principal totals against the meter's
 *      RunningSpend. Drift > $1 or 5% raises a CloudWatch alarm.
 */
export class CurStack extends cdk.Stack {
  readonly reconciler: BbgNodejsFunction;

  constructor(scope: Construct, id: string, props: CurStackProps) {
    super(scope, id, props);

    const { stagePrefix, data } = props;

    // Required: where the operator pointed the BCM Data Export's S3
    // destination. Reading from operator-config keeps the bucket name out of
    // the committed repo.
    const curS3Bucket = this.node.tryGetContext('bbg:curS3Bucket') as string | undefined;
    const curS3Prefix = (this.node.tryGetContext('bbg:curS3Prefix') as string | undefined) ?? 'cur2-iam';

    // Glue database for the crawled CUR table. Database name is per-stage so
    // dev and prod don't collide if both reconcile.
    const curDb = new glue.CfnDatabase(this, 'CurDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: `${stagePrefix}_bbg_cur`,
        description: 'CUR 2.0 export with line_item_iam_principal column. Crawled daily.',
      },
    });

    if (curS3Bucket) {
      const crawlerRole = new iam.Role(this, 'CurCrawlerRole', {
        assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
      });
      crawlerRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::${curS3Bucket}`,
            `arn:aws:s3:::${curS3Bucket}/${curS3Prefix}/*`,
          ],
        }),
      );

      new glue.CfnCrawler(this, 'CurCrawler', {
        name: `${stagePrefix}-bbg-cur-crawler`,
        role: crawlerRole.roleArn,
        databaseName: curDb.ref,
        targets: {
          s3Targets: [{ path: `s3://${curS3Bucket}/${curS3Prefix}/` }],
        },
        // Daily at 02:00 UTC, four hours before the reconciler runs at 06:00.
        schedule: { scheduleExpression: 'cron(0 2 * * ? *)' },
        // Update the schema in place rather than creating a new table on each
        // crawl so the reconciler's CUR_TABLE env var stays stable. Using the
        // default CRAWL_EVERYTHING recrawl behavior because AWS periodically
        // adds CUR columns and we want them to flow through. The
        // CRAWL_NEW_FOLDERS_ONLY optimization isn't compatible with
        // UPDATE_IN_DATABASE — Glue forces UpdateBehavior=LOG when scoped to
        // new folders, which would silently drop schema changes.
        schemaChangePolicy: {
          updateBehavior: 'UPDATE_IN_DATABASE',
          deleteBehavior: 'LOG',
        },
        configuration: JSON.stringify({
          Version: 1.0,
          CrawlerOutput: {
            Partitions: { AddOrUpdateBehavior: 'InheritFromTable' },
          },
        }),
      });
    }

    // The crawled table's name is the leaf S3 prefix segment by Glue
    // convention (e.g. "data" inside `s3://<your-cur-bucket>/cur2-iam/<exportName>/data/`).
    // Operator can override via `bbg:curTable` if their layout differs.
    const curTable = (this.node.tryGetContext('bbg:curTable') as string | undefined) ?? 'data';

    this.reconciler = new BbgNodejsFunction(this, 'CurReconciler', {
      functionName: `${stagePrefix}-bbg-cur-reconciler`,
      handlerName: 'cur-reconciler',
      timeout: Duration.minutes(10),
      memorySize: 1024,
      environment: {
        STAGE_PREFIX: stagePrefix,
        ATHENA_WORKGROUP: data.athenaWorkGroup.name,
        ATHENA_RESULTS_BUCKET: data.athenaResultsBucket.bucketName,
        // Database created by this stack; table populated by the daily crawler.
        CUR_DATABASE: curDb.ref,
        CUR_TABLE: curTable,
        // Meter side of the reconciliation: the S3/Athena ledger (per-event
        // spend deltas with a recordedat timestamp). RunningSpend's
        // month-running totals can't be windowed to the reconciliation
        // watermark, so the reconciler no longer reads them.
        LEDGER_DATABASE: data.glueDatabase.ref,
        LEDGER_TABLE: data.glueLedgerTable.ref,
      },
    });

    // Athena reads the ledger JSONL with the caller's (reconciler's) creds.
    data.ledgerBucket.grantRead(this.reconciler);
    data.athenaResultsBucket.grantReadWrite(this.reconciler);
    data.key.grantEncryptDecrypt(this.reconciler);

    this.reconciler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:GetWorkGroup',
        ],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:workgroup/${data.athenaWorkGroup.name}`,
        ],
      }),
    );
    this.reconciler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions'],
        resources: ['*'],
      }),
    );
    if (curS3Bucket) {
      // Athena reads CUR parquet files directly; the reconciler's role is the
      // one Athena uses (StartQueryExecution path). Scope to the prefix.
      this.reconciler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::${curS3Bucket}`,
            `arn:aws:s3:::${curS3Bucket}/${curS3Prefix}/*`,
          ],
        }),
      );
    }
    this.reconciler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bbg' } },
      }),
    );

    const schedulerRole = new iam.Role(this, 'CurSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    this.reconciler.grantInvoke(schedulerRole);

    new scheduler.CfnSchedule(this, 'DailyReconcile', {
      name: `${stagePrefix}-bbg-cur-reconcile`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 6 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: this.reconciler.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });
  }
}
