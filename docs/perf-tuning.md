# Performance tuning — Lambda memory sweeps

> Quarterly sweep of every BBG Lambda's memory config to find the lowest-cost setting that still hits its p95 latency target. Driven by [`scripts/power-tune.ts`](../scripts/power-tune.ts), which wraps the [awslabs Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) state machine.

## Why we run this

Lambda CPU scales linearly with memory, so doubling memory often *halves* duration on a CPU-bound function — the same GB-second total at lower wall-clock latency, sometimes for the same or lower cost. Conversely, an over-provisioned hot-path Lambda burns money. The sweep tells us which way each BBG handler tips today.

The recommendations here are advisory: the script does **not** edit `infra/lib/*-stack.ts`. Apply changes by hand after reviewing the table below, then re-deploy via the pipeline.

## Cadence

Run quarterly (target: first Friday of every quarter). Re-run sooner if a handler's logic changes materially — e.g., a new external dependency, a new bulk-read pattern, or a model that meaningfully shifts payload size.

## Operator setup (one-time)

This is operator-side infra. The state machine lives in **your** account, not the BBG CDK. The script just invokes it.

1. **Deploy the Power Tuning state machine via SAR.**
   - SAR app: [`arn:aws:serverlessrepo:us-east-1:451282441545:applications/aws-lambda-power-tuning`](https://serverlessrepo.aws.amazon.com/applications/arn:aws:serverlessrepo:us-east-1:451282441545:applications/aws-lambda-power-tuning)
   - Or follow the README at <https://github.com/alexcasalboni/aws-lambda-power-tuning>.
   - Deploy in the same region as the BBG Lambdas you're tuning (default `us-west-2`).
   - Note the resulting state-machine ARN — you'll pass it to the script.

2. **Grant the script permissions on the tuner ARN.**
   The principal you run the script as needs:

   ```
   states:StartExecution    on the power-tuner state-machine ARN
   states:DescribeExecution on every execution it starts
   lambda:GetFunctionConfiguration on each BBG Lambda (read currentMemorySize)
   ```

   The state machine itself needs `lambda:InvokeFunction` + `lambda:UpdateFunctionConfiguration` on each target Lambda — handled inside the SAR app's IAM role, not by the script.

3. **Set `BBG_POWER_TUNER_ARN`** (optional convenience) so you don't have to pass `--state-machine-arn` on every run:

   ```bash
   export BBG_POWER_TUNER_ARN=arn:aws:states:us-west-2:111122223333:stateMachine:powerTuningStateMachine-xxxx
   ```

## How to run

```bash
# basic — uses BBG_POWER_TUNER_ARN env var
npm run -w @bbg/lambda power-tune

# explicit ARN, custom stage / region, more invocations per config
npm run -w @bbg/lambda power-tune -- \
  --state-machine-arn arn:aws:states:us-west-2:111122223333:stateMachine:powerTuningStateMachine-xxxx \
  --stage-prefix prod \
  --region us-west-2 \
  --num 10
```

The script writes its results back into this file's `## Last run` section between the `BBG-PERF-TUNE-LAST-RUN:START/END` markers. Commit the diff after each quarterly run.

### What the script does

1. For each BBG Lambda (meter, identity-cache, enforcement, pricing-refresher, cur-reconciler, ledger-writer, notify, period-rollover, inference-profile-refresher) it builds a representative payload — gzipped CWL message for the meter, CloudTrail event for identity-cache, DynamoDB Stream record for enforcement / ledger-writer / notify, EventBridge scheduled event for the refreshers.
2. It invokes the Power Tuning state machine with `powerValues = [256, 512, 1024, 2048, 3072]` MB, `num = 5` (or whatever you pass via `--num`), and `strategy = cost`.
3. It picks the *cheapest* config whose p95 latency is below that handler's target.
4. It emits the recommendation alongside the function's current `memorySize` and the estimated $ savings.

### Per-Lambda p95 latency targets

| Lambda | Target p95 | Why |
|---|---|---|
| `meter` | 5 s | hot path — every Bedrock invocation flows through it |
| `identity-cache` | 5 s | hot path — runs on every CloudTrail data event |
| `ledger-writer` | 5 s | DDB-stream consumer; back-pressure cascades to enforcement |
| `notify` | 5 s | DDB-stream consumer; user-visible alert latency |
| `inference-profile-refresher` | 5 s | small list call, no payload variance |
| `period-rollover` | 5 s | once per period, small DDB scan + writes |
| `enforcement` | 30 s | may attach an IAM deny policy + look up SSO mappings |
| `pricing-refresher` | 120 s | walks the Pricing API across hundreds of SKUs |
| `cur-reconciler` | 120 s | runs an Athena query and reconciles the result |

## Caveats

- The synthetic payloads exercise the handler's hot path but **do not** include every branch (e.g., the meter's "identity-arrived" rejoin, the enforcement Lambda's IAM-attach branch). Treat the recommendation as a starting point — verify with real-traffic CloudWatch p95 before committing the change.
- The Power Tuning state machine actually invokes the Lambdas it's measuring. Running this against `prod` will write real data to DynamoDB. Prefer running it in the `dev` stage and trusting the relative numbers, unless `dev` traffic doesn't represent prod payload sizes.
- The state machine itself costs money to run (~$0.50–$2 per full sweep depending on payload size). Keep the cadence to quarterly.

<!-- BBG-PERF-TUNE-LAST-RUN:START -->
## Last run

_(no last run yet — first sweep blocked on operator deploying the awslabs Lambda Power Tuning state machine. Once deployed, run `npm run -w @bbg/lambda power-tune -- --state-machine-arn <arn>` and commit the resulting diff.)_
<!-- BBG-PERF-TUNE-LAST-RUN:END -->
