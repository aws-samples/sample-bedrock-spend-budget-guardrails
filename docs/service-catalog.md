# BBG via AWS Service Catalog (Phase A)

This is the **internal-distribution** path: customers who already vet CFN templates through their own central cloud team can import BBG into their own AWS Service Catalog portfolio and self-service-launch the bootstrap product into any account they administer.

There is no AWS-hosted catalog ARN to subscribe to: you import the templates into your own Service Catalog (see Distribution model below).

## What's in this directory

| File | Role |
|---|---|
| [`service-catalog/bbg-bootstrap.cfn.yaml`](../service-catalog/bbg-bootstrap.cfn.yaml) | The product. Writes `/bbg/operator-config` to SSM Parameter Store from operator-supplied values, then prints `cdk deploy PipelineStack` instructions in the stack outputs. No application resources (Lambdas, DDB, Cognito, etc.) created here — those land via the pipeline after the operator triggers the GitHub source. |
| [`service-catalog/bbg-portfolio.cfn.yaml`](../service-catalog/bbg-portfolio.cfn.yaml) | The portfolio + product registration. Wraps `bbg-bootstrap.cfn.yaml` in a Service Catalog `CloudFormationProduct` so per-account admins can launch it from the SC console without raw CFN access. |

Two-step pattern (vs. baking the bootstrap inline) keeps the SC product version pin separate from the portfolio's lifecycle, so upgrading the bootstrap is a `update-provisioning-artifact` rather than a portfolio rebuild.

## Distribution model

You fetch the two CloudFormation templates from this repo and import them into **your own**
AWS Service Catalog. Your Service Catalog admin governs distribution within your AWS
Organization — there is no AWS-hosted BBG portfolio to subscribe to, and no template is
served from anywhere outside your account.

## Operator runbook

### One-time per customer (in the home account, the BBG deploy account)

1. Clone the BBG repo (or fetch the two YAML files only).
2. Upload `bbg-bootstrap.cfn.yaml` to a private S3 bucket in the deploy account, e.g. `s3://my-org-cfn-templates/bbg/bbg-bootstrap.cfn.yaml`. The bucket must allow `cloudformation.amazonaws.com` to GetObject — the standard SC launch flow handles this when the same account hosts both the portfolio and the bucket.
3. Deploy `bbg-portfolio.cfn.yaml` once via:

   ```bash
   aws cloudformation deploy \
     --stack-name bbg-service-catalog \
     --template-file service-catalog/bbg-portfolio.cfn.yaml \
     --parameter-overrides \
       PortfolioOwner='Central cloud team' \
       ProductTemplateUrl='https://my-org-cfn-templates.s3.us-west-2.amazonaws.com/bbg/bbg-bootstrap.cfn.yaml' \
       GranteePrincipalArn='arn:aws:iam::<account>:role/PowerUsers' \
     --capabilities CAPABILITY_IAM
   ```

   Stack outputs surface the new Portfolio ID and Product ID. Add additional principals (per-account admins, SSO permission-set roles) via the SC console or `aws servicecatalog associate-principal-with-portfolio`.

### Per-install (one-time per AWS account that should host BBG)

End user with the granted IAM principal opens **Service Catalog → Products** and launches the `BBG operator-config bootstrap` product. Required parameters:

- `GitHubOwner` — the owner of your fork of this repo.
- `AlertEmail` — receives SNS alarm notifications.

Optional parameters cover the custom domain (HostedZone+DevDomain+ProdDomain), the SES-verified `NotifySenderAddress`, the CUR 2.0 export bucket, and `DisableConfigStack` for accounts where Control Tower / Security Hub already manages AWS Config.

The product launches in <30s and surfaces stack outputs of the form:

```
NextSteps:
  git clone https://github.com/<GitHubOwner>/sample-bedrock-spend-budget-guardrails.git
  cd sample-bedrock-spend-budget-guardrails
  npm install
  npx cdk bootstrap aws://<accountId>/<region>
  npx cdk deploy PipelineStack
```

Run those commands from CloudShell in the same account to materialize the rest of the BBG application (Lambdas, DDB tables, Cognito user pool, the web app hosted on CloudFront).

## Why two CFN templates instead of one

A single template would force every operator to choose between `aws cloudformation deploy` (reasonable for the central cloud team) and the Service Catalog launch flow (the actual UX we want for per-account self-service). Splitting them gives the central team CFN-as-code for the portfolio (CI-friendly, version-pinnable) while end users still get a Service Catalog launch wizard.

## Smoke test

The bootstrap template is `aws cloudformation validate-template`-clean. New installs into a fresh account will run end-to-end; an existing install (where `/bbg/operator-config` already exists in SSM) will fail at CREATE because CFN refuses to manage a resource that's already managed elsewhere. In that case, either delete the existing parameter first or use the direct `cdk deploy PipelineStack` path.

## What this story does NOT cover

- **The actual BBG application deploy** — documented in [`README.md`](../README.md). Either run `./scripts/install.sh` (it detects the `/bbg/operator-config` this product already wrote and continues from the GitHub connection), or `cdk deploy PipelineStack` by hand.
- **Per-account scope claims** — each enrolled account gets its own Cognito user pool by virtue of running its own pipeline. Cross-account scope (one shared web app where a delegated admin sees only their accounts) is the multi-account control plane covered in [`docs/multi-account-multi-region.md`](multi-account-multi-region.md), and is orthogonal to Service Catalog packaging.
