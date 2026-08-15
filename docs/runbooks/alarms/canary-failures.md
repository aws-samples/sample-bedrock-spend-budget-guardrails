# Runbook: `CanaryFailure`

## Symptom

CloudWatch alarm `<stage>-bbg-canary-failures` fires when the CloudWatch Synthetics canary `<stage>-bbg-app` reports any failure (`Failed > 0`) within a 30-minute period (`treatMissingData: NOT_BREACHING`). The canary is created by `ObservabilityStack` only when `bbg:canaryUrl` context is set; it loads the SPA URL every 30 minutes, asserts a 2xx response, asserts the page title matches `/Bedrock Budget Guard/i`, and asserts `#root` rendered. Any of those failing trips the alarm.

Default threshold: `> 0` failed runs over 1 period (30 min).

## Severity guidance

- **Sev3** — two or more consecutive failures, or any failure during business hours that suggests the SPA is down for real users (CloudFront 5xx, Cognito login broken, API Gateway 5xx). Page the on-call.
- **Sev4** — single transient failure (DNS blip, one-off CloudFront edge issue) that self-recovered on the next run. File a ticket and watch.

## Likely causes (in order)

1. **CloudFront / S3 origin returning non-2xx.** CloudFront origin access misconfigured after a redeploy, the SPA bundle in S3 was deleted or replaced with a malformed `index.html`, or the origin's bucket policy got tightened.
2. **WAF rule blocking the canary's User-Agent.** The Synthetics runtime's User-Agent contains `CloudWatchSynthetics`. If a new managed WAF rule group was added that blocks bot-like UAs, the canary gets `403`.
3. **Page title regression.** Someone renamed the app title in `web/src/index.html` or `web/src/App.tsx` away from "Bedrock Budget Guard". The canary asserts `/Bedrock Budget Guard/i.test(title)`; an unrelated rename will trip it.
4. **`#root` not in DOM.** The SPA shell failed to render — usually a JS bundle 404 (cache invalidation race after deploy), a CSP violation blocking the bundle, or a runtime error in the bundle's top-level code.
5. **Cognito Hosted UI redirect-loop or login broken.** The canary loads the SPA URL directly; if the entry-point requires auth and the redirect target is misconfigured, page never reaches `load`/`networkidle0`.
6. **Synthetics runtime upgrade or service-side regression** — rare. The runtime pinned in the stack is `SYNTHETICS_NODEJS_PUPPETEER_9_1`; if AWS deprecates that version, canaries silently fail to start.

## Investigation

```bash
# List recent canary runs and their status
aws synthetics describe-canaries-last-run --names dev-bbg-app --region us-west-2

# Get a specific run's detail (substitute the runId from the previous command)
aws synthetics get-canary-runs --name dev-bbg-app --region us-west-2 --max-results 5

# Open the canary's screenshot + HAR artifacts in S3
aws synthetics get-canary --name dev-bbg-app --region us-west-2 \
  --query 'Canary.ArtifactS3Location' --output text

# Manually exercise the SPA URL the canary uses
curl -I "$(aws ssm get-parameter --name /bbg/operator-config --region us-west-2 \
  --query 'Parameter.Value' --output text | jq -r '.canaryUrl // .appUrl')"

# Check CloudFront 5xx error rate during the same window
aws cloudwatch get-metric-statistics --namespace AWS/CloudFront --metric-name 5xxErrorRate \
  --dimensions Name=DistributionId,Value=<distId> Name=Region,Value=Global \
  --start-time $(date -u -v-2H '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 300 --statistics Average --region us-east-1
```

The canary writes a screenshot of the page right before the assertion fails — pull the latest from the canary's S3 artifact bucket. That's almost always the fastest path to root cause.

## Remediation

- **CloudFront / S3 broken**: redeploy the WebStack (`cdk deploy 'DevAppStage/Web-us-west-2'`) and invalidate the CloudFront distribution.
  ```bash
  aws cloudfront create-invalidation --distribution-id <id> --paths '/*'
  ```
- **WAF blocking the canary**: add an IP allowlist rule for the Synthetics runtime's egress IP range, OR add a User-Agent allowlist for `CloudWatchSynthetics`. The canary's runtime IPs are documented in [Synthetics canary networking](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Canaries.html).
- **Page title regression**: revert the rename in `web/src/index.html` so `<title>` again contains "Bedrock Budget Guard". (Alternatively, update the canary inline script in `infra/lib/observability-stack.ts` if the rename was intentional.)
- **Bundle missing**: confirm `web/dist/` was uploaded by the deploy. Re-run the WebStack deploy.
- **Cognito redirect broken**: check that the SPA's Cognito callback URL list includes the canary URL host. Update `bbg:cognitoCallbackUrls` operator-config and redeploy.

Acceptance: next canary run succeeds; alarm transitions to OK within 30 minutes.

## Related Lambda runbooks

- [`api`](../api.md) — backend the SPA calls; if the canary's `networkidle0` is timing out, the API may be erroring.
- (No single Lambda owns the SPA — the CloudFront / S3 / WebStack origin is the relevant component, see [`docs/architecture.md`](../../architecture.md) §"Web tier".)
