# Runbook: MeterUsageMissing

## Signal

The stage's meter received invocation metadata with no supported usage counter. A missing counter can hide spend before pricing lookup, so the alarm fires on any occurrence in 15 minutes. Explicit failures without usage and zero-valued streaming-start records are excluded. Error records with nonzero counters still enter metering.

## Investigation

1. Retrieve the meter's actual log group from its Lambda configuration.
2. Find `Invocation metadata has no supported usage counters` and record the model, operation, and request ID.
3. Inspect only usage and status metadata in the Bedrock invocation logs. Avoid enabling prompt/response capture to troubleshoot billing counters.
4. Compare the operation's documented billing unit with the emitted metadata.

## Resolution

Add a validated extraction path and a sanitized regression fixture. Do not infer one image/video for an arbitrary request. Preserve unknown usage as a visible gap until its billable quantity can be established. See [pricing accuracy](../../pricing-accuracy.md).

After a classification fix, historical breaching points can keep the alarm red until they leave CloudWatch's evaluation window. Check the timestamps and new meter logs before treating an unchanged alarm state as a new missing-usage event.
