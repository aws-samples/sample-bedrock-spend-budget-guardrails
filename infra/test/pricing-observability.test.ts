import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DataStack } from '../lib/data-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';

describe('pricing and metering observability', () => {
  const app = new cdk.App();
  const env = { account: '111122223333', region: 'us-west-2' };
  const data = new DataStack(app, 'Data', { env, stagePrefix: 'prod' });
  const stack = new ObservabilityStack(app, 'Observability', { env, stagePrefix: 'prod', data });
  const template = Template.fromStack(stack);

  it('evaluates the daily gap gauge once per day', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'prod-bbg-pricing-gap-count',
      Period: 86400, EvaluationPeriods: 1, Statistic: 'Maximum',
    });
  });
  it('isolates every application metric alarm by stage', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    for (const alarm of alarms) {
      const p = alarm.Properties;
      if (p.Namespace !== 'bbg') continue;
      expect(p.Dimensions).toContainEqual({ Name: 'stage', Value: 'prod' });
    }
  });
  it('alarms on missing usage and stale reviewed prices', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'prod-bbg-meter-usage-missing', MetricName: 'MeterUsageMissing', Threshold: 0,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'prod-bbg-pricing-fallback-age', Threshold: 2592000,
    });
  });
});
