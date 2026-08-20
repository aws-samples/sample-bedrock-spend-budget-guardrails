import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly data: DataStack;
  /** When provided, a CloudWatch Synthetics canary hits this URL every 30 min. */
  readonly canaryUrl?: string;
}

export class ObservabilityStack extends cdk.Stack {
  readonly alertTopic: sns.Topic;
  readonly opsDashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { stagePrefix, data, canaryUrl } = props;

    this.alertTopic = new sns.Topic(this, 'BbgAlerts', {
      topicName: `${stagePrefix}-bbg-alerts`,
      displayName: 'Bedrock Budget Guard alerts',
    });

    const alertEmail = this.node.tryGetContext('bbg:alertEmail') as string | undefined;
    if (alertEmail) {
      this.alertTopic.addSubscription(new snsSubs.EmailSubscription(alertEmail));
    }

    const namespace = 'bbg';
    // Powertools `Metrics({ namespace: 'bbg', serviceName: 'bbg' })` adds
    // `service=bbg` as a default dimension on every emitted EMF blob, so every
    // metric below MUST be constructed with `dimensionsMap: { service: 'bbg' }`
    // — the dimensionless stream powertools never publishes to is empty and
    // alarms watching it report "no datapoints received" forever. For metrics
    // emitted with extra dimensions (principal, policyArn, Lambda, …) we use a
    // metric-math SEARCH expression below to aggregate across the high-card
    // dimension while still scoping by service.
    const serviceDim = { service: 'bbg' };
    const meterUnjoined = new cloudwatch.Metric({ namespace, metricName: 'MeterUnjoined', dimensionsMap: serviceDim });
    // MET-1 (F5): the cross-region cwl-forwarder emits CwlForwardFailed for
    // every EventBridge entry PutEvents reported as failed (non-zero
    // FailedEntryCount). A failed entry = metered spend that never reached the
    // home-region meter → under-metering → enforcement never fires. Any
    // failure is worth paging; the forwarder also throws on partial failure so
    // the batch retries and, on exhaustion, lands on the metering DLQ.
    const cwlForwardFailed = new cloudwatch.Metric({
      namespace,
      metricName: 'CwlForwardFailed',
      dimensionsMap: serviceDim,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    const enforcementErrors = new cloudwatch.Metric({ namespace, metricName: 'EnforcementErrors', dimensionsMap: serviceDim });
    // N4 companion: the notify Lambda now emits `NotifyError` from its
    // handler-level catch — the single choke point every failed record passes
    // through (SES send, Cognito reverse-lookup, fetchBudget, etc. all funnel
    // there) — so notify failures are no longer invisible and each failure is
    // counted exactly once. Same namespace/shape as EnforcementErrors above — a
    // Lambda-side failure counter carrying the default `service=bbg` dimension —
    // so the single-stream metric alarm below fires on any notify failure.
    const notifyError = new cloudwatch.Metric({ namespace, metricName: 'NotifyError', dimensionsMap: serviceDim });
    // the enforcement Lambda emits `EnforcementUnattachable` when a
    // breached budget's principal has no attach target AND no scoping
    // condition (e.g. principal#unknown, or a GetFederationToken federated
    // user) — an inert deny would do nothing, so enforcement declines to
    // create one and pages instead. Same namespace/shape (service=bbg
    // default dim) as EnforcementErrors so the single-stream alarm fires.
    const enforcementUnattachable = new cloudwatch.Metric({ namespace, metricName: 'EnforcementUnattachable', dimensionsMap: serviceDim });
    // The pricing-refresher publishes PricingRefreshAge once per day (its cron
    // schedule). Like ReconciliationDelta below, it MUST be read at a 1-day
    // period with the Maximum statistic — otherwise the default 300s/Average
    // read leaves ~287 of 288 daily 5-min windows empty, and with the alarm's
    // `treatMissingData: BREACHING` those empty windows keep it in ALARM even
    // when pricing is fresh. Maximum surfaces the staleness age from the single
    // daily datapoint; 1-day period makes the alarm's evaluation windows line
    // up with the once-daily emission cadence.
    const pricingRefreshAge = new cloudwatch.Metric({
      namespace,
      metricName: 'PricingRefreshAge',
      dimensionsMap: serviceDim,
      statistic: 'Maximum',
      period: cdk.Duration.days(1),
    });
    const pricingGapCount = new cloudwatch.Metric({ namespace, metricName: 'PricingGapCount', dimensionsMap: serviceDim });
    // The refresher truncated its model loop to stay inside the Lambda timeout
    // (emitted once per daily run, 1 = truncated, 0 = complete). Distinct from
    // "refresher went dark" (that shows up as missing PricingRefreshAge): this
    // is "refresher ran but didn't finish", so some models kept stale prices.
    const pricingRefreshIncomplete = new cloudwatch.Metric({
      namespace,
      metricName: 'PricingRefreshIncomplete',
      dimensionsMap: serviceDim,
      statistic: 'Maximum',
      period: cdk.Duration.days(1),
    });
    // Hierarchical (org/OU) discount resolver couldn't reach Organizations (not
    // the management account, or access lost). Any prior-materialized effectivePct
    // persists — see the org-discount-resolver docstring.
    const orgDiscountResolverDegraded = new cloudwatch.Metric({
      namespace,
      metricName: 'OrgDiscountResolverDegraded',
      dimensionsMap: serviceDim,
    });
    const unpricedInvocations = new cloudwatch.Metric({ namespace, metricName: 'UnpricedInvocations', dimensionsMap: serviceDim });
    // The reconciler publishes ReconciliationDelta exactly once per day (06:00
    // UTC cron). The metric MUST therefore be read at a 1-day period with the
    // Maximum statistic: a default 300s/Average period would give the alarm one
    // datapoint-bearing 5-min window per day surrounded by "missing" windows, so
    // its `evaluationPeriods: 3` could never accumulate 3 consecutive *breaching*
    // periods and the alarm would sit OK forever (observed: a large delta never
    // tripped the $1 alarm because only one window per day had data). One day/period makes
    // `evaluationPeriods: 3` mean "3 consecutive days of breach", matching the
    // contract documented in docs/cur-reconciliation.md. Maximum (not Average)
    // so a single large per-principal×usage delta isn't diluted by the dozen
    // sub-dollar deltas emitted in the same array.
    const reconciliationDelta = new cloudwatch.Metric({
      namespace,
      metricName: 'ReconciliationDelta',
      // Per-stage identity: the reconciler emits `stage=<stagePrefix>`
      // alongside the default `service=bbg`. Without the stage dimension,
      // dev's and prod's reconcilers publish to the SAME series and each
      // stage's alarm fires on the other stage's deltas (observed: a dev
      // install that meters almost nothing compared itself against the whole
      // account's CUR and held the prod alarm red for weeks).
      dimensionsMap: { ...serviceDim, stage: stagePrefix },
      statistic: 'Maximum',
      period: cdk.Duration.days(1),
    });
    // CUR-billed Bedrock spend for principals THIS stage never metered:
    // pre-deployment history, another stage's traffic, or a structural bypass
    // (e.g. `bedrock-mantle`). Deliberately dashboard-only — the operator
    // cannot fix it by fixing the meter, so it must not feed the
    // ReconciliationDelta alarm (see the reconciler's population split).
    const reconciliationUnmetered = new cloudwatch.Metric({
      namespace,
      metricName: 'ReconciliationUnmeteredSpend',
      dimensionsMap: { ...serviceDim, stage: stagePrefix },
      statistic: 'Maximum',
      period: cdk.Duration.days(1),
    });
    // High-cardinality emitters (enforcement attach failures, rollover detach/
    // delete failures) emit two flavors per failure: one with the principal
    // or policyArn dimension for drill-down, and one rollup with just the
    // default service=bbg dimension so this single-metric alarm can fire on
    // ANY failure across the population. CloudWatch metric alarms do not
    // accept SEARCH expressions, so the rollup-emit pattern is the only way
    // to alarm across a high-cardinality dimension.
    const enforcementAttachStuck = new cloudwatch.Metric({
      namespace,
      metricName: 'EnforcementAttachStuck',
      dimensionsMap: serviceDim,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    // ENF-2 (B1): rate/count of deny-policy attaches. A compromised or
    // buggy home enforcement Lambda attaching Deny policies en masse across
    // the principal population would spike this. `EnforcementApplied` is
    // emitted once per successful attach (enforcement/index.ts) with the
    // default service=bbg dimension. Alarm on the 5-min Sum crossing a
    // volume ceiling so a mass-enforcement event pages an operator (who can
    // then flip the `bbg:pauseEnforcement` kill-switch). Threshold is a
    // deliberately loose ceiling — routine enforcement is a handful of
    // attaches; dozens in 5 minutes is anomalous.
    const enforcementAppliedRate = new cloudwatch.Metric({
      namespace,
      metricName: 'EnforcementApplied',
      dimensionsMap: serviceDim,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, 'MeterUnjoinedAlarm', {
        alarmName: `${stagePrefix}-bbg-meter-unjoined`,
        metric: meterUnjoined,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        // MET-1 (B5): spend that couldn't be joined to an IAM principal
        // (dropped log/event, cross-region loss, identity-cache miss).
        // Unjoined spend never accumulates on RUNNING_SPEND, so enforcement
        // never fires for it. Sustained non-zero (5 periods) = a real
        // join gap, not a transient race. See
        // docs/runbooks/alarms/meter-unjoined.md.
        alarmDescription:
          'Meter recorded Bedrock spend it could not join to an IAM principal for 5 consecutive periods. That spend never reaches RUNNING_SPEND so enforcement never fires. Check the cwl-forwarder / identity-cache path. See docs/runbooks/alarms/meter-unjoined.md.',
      }),
      new cloudwatch.Alarm(this, 'CwlForwardFailedAlarm', {
        alarmName: `${stagePrefix}-bbg-cwl-forward-failed`,
        metric: cwlForwardFailed,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        // MET-1 (F5): the cross-region cwl-forwarder dropped EventBridge
        // entries (PutEvents FailedEntryCount>0). That spend never reaches the
        // home-region meter, so it never accumulates on RUNNING_SPEND and
        // enforcement never fires for it. The forwarder throws on partial
        // failure so the batch retries and, on exhaustion, lands on the
        // metering DLQ. See docs/runbooks/alarms/cwl-forward-failed.md.
        alarmDescription:
          'cwl-forwarder failed to deliver Bedrock invocation events to the home-region bus (PutEvents FailedEntryCount>0). That cross-region spend never reaches the meter so enforcement never fires. Check the metering DLQ and cwl-forwarder logs. See docs/runbooks/alarms/cwl-forward-failed.md.',
      }),
      new cloudwatch.Alarm(this, 'EnforcementErrorsAlarm', {
        alarmName: `${stagePrefix}-bbg-enforcement-errors`,
        metric: enforcementErrors,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      // N4 companion (see notify Lambda's NotifyError emit). The notify path
      // sends breach/threshold + enforcement emails via SES and does a
      // Cognito principal→email reverse-lookup; both were previously
      // fire-and-forget `.catch` sites that logged but emitted no metric, so
      // a broken notifier (unverified SES sender, throttled Cognito) failed
      // silently and operators never learned budget alerts stopped going out.
      // Mirrors EnforcementErrorsAlarm: any NotifyError in a period pages.
      new cloudwatch.Alarm(this, 'NotifyErrorAlarm', {
        alarmName: `${stagePrefix}-bbg-notify-error`,
        metric: notifyError,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'notify Lambda failed to send a budget alert (SES SendEmail or Cognito principal→email reverse-lookup threw). Threshold/enforcement emails may be silently dropping. Check the notify DLQ and notify logs, and verify the bbg:notifySenderAddress SES identity. See docs/runbooks/notify.md.',
      }),
      // companion to the enforcement Lambda's EnforcementUnattachable
      // emit. Any occurrence means a deny budget exists on a principal BBG
      // cannot attach a scoped deny to, so it is NOT being enforced — the
      // operator must re-key the budget or set it alert-only.
      new cloudwatch.Alarm(this, 'EnforcementUnattachableAlarm', {
        alarmName: `${stagePrefix}-bbg-enforcement-unattachable`,
        metric: enforcementUnattachable,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'A deny budget targets a principal BBG cannot attach a scoped deny to (principal#unknown, or a GetFederationToken federated user with no issuer role). The budget meters + alerts but does NOT enforce. Re-key it to an IAM user/role, principal#sso-user#<email>, or principal#sourceIdentity#<value>, or set action=alert. See docs/runbooks/alarms/enforcement-unattachable.md.',
      }),
      new cloudwatch.Alarm(this, 'OrgDiscountResolverDegradedAlarm', {
        alarmName: `${stagePrefix}-bbg-org-discount-resolver-degraded`,
        metric: orgDiscountResolverDegraded,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'The org/OU discount resolver could not reach AWS Organizations (BBG is not the management account, or access was lost). OU/org discounts stop re-resolving; any effective rate materialized by a prior run keeps applying at its last value until re-authored. Deploy BBG in the Org management account, or manage discounts per-account. See docs/runbooks/alarms/org-discount-resolver-degraded.md.',
      }),
      new cloudwatch.Alarm(this, 'PricingRefreshAgeAlarm', {
        alarmName: `${stagePrefix}-bbg-pricing-refresh-age`,
        metric: pricingRefreshAge,
        threshold: 36 * 3600,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // BREACHING (not the default MISSING): the refresher emits
        // PricingRefreshAge once per daily run, so a refresher that STOPS
        // firing produces no datapoints. Treating missing data as breaching
        // means "refresher went dark" trips the alarm instead of parking it in
        // INSUFFICIENT_DATA — the meter can charge against stale prices for
        // days otherwise. Pairs with the pricing-refresher now emitting the
        // real now-min(fetchedAt) age instead of a hard-coded 0.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        alarmDescription:
          'Bedrock pricing data is >36h stale, or the pricing-refresher stopped emitting PricingRefreshAge entirely (missing data treated as breaching). The meter may be charging against stale prices. Check pricing-refresher logs and its daily schedule. See docs/runbooks/alarms/pricing-refresh-age.md.',
      }),
      new cloudwatch.Alarm(this, 'PricingRefreshIncompleteAlarm', {
        alarmName: `${stagePrefix}-bbg-pricing-refresh-incomplete`,
        metric: pricingRefreshIncomplete,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // NOT_BREACHING: the refresher emits this every run (0 when complete),
        // and "went dark entirely" is already covered by the PricingRefreshAge
        // missing-data=breaching alarm above. This one fires only when a run
        // actually ran but truncated its model loop to beat the timeout.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'pricing-refresher hit its time budget and stopped before pricing every model — some models kept stale prices this run. Usually means the run is bumping the 15min Lambda cap against the throttling Pricing API. Check PricingModelsSkipped + the refresher duration; consider raising memory or trimming per-model GetProducts. See docs/runbooks/alarms/pricing-refresh-age.md.',
      }),
      new cloudwatch.Alarm(this, 'EnforcementAttachStuckAlarm', {
        alarmName: `${stagePrefix}-bbg-enforcement-attach-stuck`,
        metric: enforcementAttachStuck,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'Enforcement Lambda stamped enforcementPolicyArn on a spend row but failed to attach the IAM deny policy. Caller is NOT actually blocked. Operator must manually attach the policy or release-and-retry. See docs/runbooks/enforcement.md cause #6.',
      }),
      // ENF-2 (B1): mass-enforcement rate alarm. Fires when the enforcement
      // Lambda attaches an anomalously high number of deny policies in a
      // 5-min window — the signature of a compromised/buggy home Lambda or a
      // metering bug denying org-wide. Operator response: flip the
      // `bbg:pauseEnforcement` kill-switch and investigate. See
      // docs/runbooks/alarms/enforcement-applied-rate.md.
      new cloudwatch.Alarm(this, 'EnforcementAppliedRateAlarm', {
        alarmName: `${stagePrefix}-bbg-enforcement-applied-rate`,
        metric: enforcementAppliedRate,
        threshold: 25,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'Enforcement Lambda attached >25 bbg-deny-* policies in 5 minutes — possible mass-enforcement (compromised/buggy home Lambda or a metering bug denying org-wide). Operator: set bbg:pauseEnforcement=true and investigate. See docs/runbooks/alarms/enforcement-applied-rate.md.',
      }),
      new cloudwatch.Alarm(this, 'PricingGapCountAlarm', {
        alarmName: `${stagePrefix}-bbg-pricing-gap-count`,
        metric: new cloudwatch.Metric({
          namespace,
          metricName: 'PricingGapCount',
          statistic: 'Maximum',
          period: cdk.Duration.hours(1),
          dimensionsMap: serviceDim,
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 4, // 4 consecutive 1-hour periods so transient gaps don't page
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'A Bedrock model is in ListFoundationModels but has no Pricing API match. Meter emits UnpricedInvocations for any caller using it. Operator: add a manual override via the Pricing UI or wait for the next refresh. See docs/runbooks/alarms/pricing-gap-count.md.',
      }),
      new cloudwatch.Alarm(this, 'UnpricedInvocationsAlarm', {
        alarmName: `${stagePrefix}-bbg-unpriced-invocations`,
        metric: new cloudwatch.Metric({
          namespace,
          metricName: 'UnpricedInvocations',
          statistic: 'Sum',
          period: cdk.Duration.minutes(15),
          dimensionsMap: serviceDim,
        }),
        threshold: 50, // 50 unpriced invocations in 15 min suggests a real gap, not a one-off race
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'Meter received Bedrock invocations it could not price. Token counts recorded; dollar amount missing. Operator: check pricing-refresher logs and the gap surface in the SPA. See docs/runbooks/alarms/unpriced-invocations.md.',
      }),
    ];

    // Period-rollover detach/delete failures. The rollover Lambda used to
    // swallow IAM detach/delete errors with a warn log, leaving bbg-deny-*
    // policies attached past the period boundary (caller stays denied for
    // the next period). It now retries 3x with jittered backoff and emits
    // these metrics so we can alarm on real failure. See
    // docs/runbooks/alarms/period-rollover-detach-failure.md.
    // Same dual-emit pattern as EnforcementAttachStuck above. The Lambda
    // emits both `service=bbg,principal=<...>` (drill-down) and the rollup
    // `service=bbg` (alarmable single stream).
    const periodRolloverDetachFailure = new cloudwatch.Metric({
      namespace,
      metricName: 'PeriodRolloverDetachFailure',
      dimensionsMap: serviceDim,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    alarms.push(
      new cloudwatch.Alarm(this, 'PeriodRolloverDetachFailureAlarm', {
        alarmName: `${stagePrefix}-bbg-period-rollover-detach-failure`,
        metric: periodRolloverDetachFailure,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'period-rollover Lambda failed to detach a bbg-deny-* policy. Caller may stay denied past the period rollover. See docs/runbooks/period-rollover.md cause #2.',
      }),
    );

    // Same dual-emit pattern. Lambda emits `service=bbg,policyArn=<...>`
    // for drill-down plus rollup `service=bbg` for the single-stream alarm.
    const periodRolloverDeleteFailure = new cloudwatch.Metric({
      namespace,
      metricName: 'PeriodRolloverDeleteFailure',
      dimensionsMap: serviceDim,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    alarms.push(
      new cloudwatch.Alarm(this, 'PeriodRolloverDeleteFailureAlarm', {
        alarmName: `${stagePrefix}-bbg-period-rollover-delete-failure`,
        metric: periodRolloverDeleteFailure,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'period-rollover Lambda failed to delete a bbg-deny-* policy after detaching. Stale policy remains in IAM. See docs/runbooks/period-rollover.md cause #3.',
      }),
    );

    // N3 — DLQ depth alarms.
    //
    // Metering DLQ: the metering-DLQ depth alarm is NOT here. Metering DLQs are
    // created per metered region (one per bbg:meteredRegions entry) inside each
    // regional MeteringStack, and a CloudWatch alarm can only trigger a
    // same-region SNS topic — a home-region alarm here structurally cannot read
    // us-east-1/us-east-2's AWS/SQS metric. So each MeteringStack owns its own
    // `${stagePrefix}-bbg-metering-dlq-not-empty-<region>` alarm + regional
    // alerts topic (metering-stack.ts), giving uniform coverage across every
    // metered region instead of just the home region.
    //
    // Notify DLQ: no `${stagePrefix}-bbg-notify-dlq` depth alarm either. The
    // notify Lambda's deadLetterQueue (enforcement-stack.ts) is a Lambda
    // *async-invoke* DLQ, but notify is only ever invoked by a DynamoDB stream
    // event source (no async invoker + no ESM onFailure destination), so that
    // queue can never receive a message — a depth alarm on it would be
    // permanently OK (false assurance). Notify failures ARE observable via the
    // NotifyError metric/alarm above (emitted from the notify handler's catch),
    // which is the real signal.

    // MET-1 (B5): CUR-vs-meter drift in USD, alarmed only on stages that
    // actually meter the account's Bedrock traffic (`bbg:reconciliationAlarmStages`,
    // default `['prod']`). In a shared-account dev+prod install the invocation-log
    // subscription belongs to ONE stage — the other stage meters a sliver of the
    // traffic while its CUR side sees the whole account, so its "reconciliation"
    // is structurally meaningless and its alarm would sit red forever (observed
    // on dev for 13 days). Its metric still publishes per-stage for dashboards;
    // only the alarm is gated. Single-stage forks that deploy only a dev stage
    // should set `bbg:reconciliationAlarmStages: ["dev"]`.
    //
    // This alarms the aggregate `ReconciliationDelta` (service=bbg,
    // stage=<stage>, Maximum/day) — the alarmable rollup companion of the
    // per-principal `ReconciliationDeltaUsd` drill-down metric (Principal
    // dimension, dashboard-only; a metric alarm can't span a high-cardinality
    // dimension). >$1/principal for 3 consecutive days means the meter is
    // silently under- (or over-) counting spend, so budget enforcement may
    // never fire. See docs/runbooks/alarms/reconciliation-delta.md.
    const reconciliationAlarmStages = (this.node.tryGetContext(
      'bbg:reconciliationAlarmStages',
    ) as string[] | undefined) ?? ['prod'];
    if (reconciliationAlarmStages.includes(stagePrefix)) {
      alarms.push(
        new cloudwatch.Alarm(this, 'ReconciliationDeltaAlarm', {
          alarmName: `${stagePrefix}-bbg-reconciliation-delta`,
          metric: reconciliationDelta,
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 3,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            'CUR-vs-meter reconciliation drift exceeded $1 per principal for 3 consecutive days. Both sides are watermarked to bill-complete days (default now-72h; Marketplace-billed model SKUs settle slower than the base 8-24h CUR lag), so this is NOT CUR ingestion lag: the meter and the bill genuinely disagree about spend the meter DID see (dropped log/event, identity-join miss, or stale pricing) and enforcement may be mis-firing. CUR-only spend the stage never metered is excluded — see the ReconciliationUnmeteredSpend metric for that. Cross-check ReconciliationDeltaUsd per-principal and MeterUnjoined. See docs/runbooks/alarms/reconciliation-delta.md.',
        }),
      );
    }

    for (const alarm of alarms) {
      alarm.addAlarmAction(new cwActions.SnsAction(this.alertTopic));
    }

    // CloudWatch Synthetics canary that exercises the SPA URL every 30 min.
    // Plan §3 Op Ex commitment. Skipped when no canaryUrl is configured.
    if (canaryUrl) {
      const canary = new synthetics.Canary(this, 'AppCanary', {
        canaryName: `${stagePrefix}-bbg-app`,
        runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_9_1,
        schedule: synthetics.Schedule.rate(cdk.Duration.minutes(30)),
        timeToLive: cdk.Duration.days(0), // run forever
        startAfterCreation: true,
        cleanup: synthetics.Cleanup.LAMBDA, // delete the helper Lambda when stack is destroyed
        environmentVariables: { APP_URL: canaryUrl },
        test: synthetics.Test.custom({
          handler: 'index.handler',
          // nosemgrep: missing-template-string-indicator
          // The require('Synthetics') and require('SyntheticsLogger')
          // strings are deliberate string args to the canary runtime's
          // built-in module loader; semgrep mistakes them for missing
          // template interpolation.
          code: synthetics.Code.fromInline(
            `const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const APP_URL = process.env.APP_URL;

const pageLoadBlueprint = async function () {
  const page = await synthetics.getPage();
  log.info('Loading ' + APP_URL);
  const response = await page.goto(APP_URL, { waitUntil: ['load', 'networkidle0'], timeout: 30000 });
  if (!response || response.status() < 200 || response.status() > 299) {
    throw new Error('App URL returned status ' + (response ? response.status() : 'no response'));
  }
  // Sanity-check the SPA shell: title is set and the app's root div exists.
  const title = await page.title();
  log.info('Page title: ' + title);
  if (!/Bedrock Budget Guard/i.test(title)) {
    throw new Error('Unexpected page title: ' + title);
  }
  const rootCount = await page.evaluate(() => document.querySelectorAll('#root').length);
  if (rootCount === 0) {
    throw new Error('Expected #root element on the page (SPA shell not rendered)');
  }
};

exports.handler = async () => {
  return await pageLoadBlueprint();
};`,
          ),
        }),
      });

      const canaryFailureMetric = canary.metricFailed({
        period: cdk.Duration.minutes(30),
        statistic: 'Sum',
      });
      const canaryAlarm = new cloudwatch.Alarm(this, 'CanaryFailureAlarm', {
        alarmName: `${stagePrefix}-bbg-canary-failures`,
        metric: canaryFailureMetric,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      canaryAlarm.addAlarmAction(new cwActions.SnsAction(this.alertTopic));
    }

    // Per-Lambda self-cost metrics. Each emit-site sets a `Lambda` dimension
    // via `singleMetric().addDimension('Lambda', '<name>')` so we chart per-
    // Lambda series here. 7-day rolling Sum gives admins a stable read on
    // BBG's own infra cost — Plan §3 Cost Optimization commitment.
    const selfCostMetricFor = (lambdaName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace,
        metricName: 'MeterCostUSD',
        statistic: 'Sum',
        period: cdk.Duration.days(7),
        dimensionsMap: { ...serviceDim, Lambda: lambdaName },
        label: lambdaName,
      });

    const selfCostWidget = new cloudwatch.GraphWidget({
      title: 'BBG Self-Cost (7-day rolling Sum, USD per Lambda)',
      left: [
        selfCostMetricFor('meter'),
        selfCostMetricFor('identity-cache'),
        selfCostMetricFor('enforcement'),
        selfCostMetricFor('pricing-refresher'),
      ],
      width: 24,
    });

    this.opsDashboard = new cloudwatch.Dashboard(this, 'OpsDashboard', {
      dashboardName: `${stagePrefix}-bbg-Operations`,
      defaultInterval: cdk.Duration.hours(1),
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Real-time meter health',
            left: [meterUnjoined, unpricedInvocations],
            right: [pricingRefreshAge],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'Enforcement actions',
            left: [enforcementErrors],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Pricing data quality',
            left: [pricingGapCount, unpricedInvocations],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'CUR reconciliation',
            left: [reconciliationDelta],
            right: [reconciliationUnmetered],
            width: 12,
          }),
        ],
        [selfCostWidget],
        [new cloudwatch.AlarmStatusWidget({ alarms, width: 24 })],
      ],
    });

    // Surface the data tables on the dashboard for at-a-glance read.
    new cloudwatch.SingleValueWidget({
      title: 'RunningSpend (consumed RCU)',
      metrics: [data.runningSpend.metricConsumedReadCapacityUnits()],
      width: 12,
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
  }
}
