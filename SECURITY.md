# Security Policy

## Reporting a Vulnerability

If you discover a potential security issue in this project we ask that you notify AWS Security via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/). **Please do not create a public GitHub issue for security vulnerabilities.**

## Supported Versions

This is sample code intended to be deployed by users into their own AWS accounts. We support the latest commit on the `main` branch. Older commits and tags are not actively supported.

## Hardening notes

This project demonstrates production-grade patterns and includes security hardening features. However, as sample code, it requires additional security review and testing before production deployment. Notable defenses:

- IAM scoping uses the `iam:PolicyARN` condition key to restrict the enforcement Lambda's `iam:Attach*Policy` / `iam:Detach*Policy` actions to the `arn:aws:iam::<acct>:policy/bbg-deny-*` namespace only.
- All DynamoDB tables and S3 buckets use customer-managed KMS keys.
- All S3 buckets enforce Block Public Access and use Origin Access Control where applicable.
- WAFv2 with AWS managed rule sets is attached to the prod CloudFront distribution.
- A dedicated CloudTrail trail with Bedrock data events enabled has log file validation and KMS encryption.
- `cdk-nag` AwsSolutions checks gate CI; AWS Config managed rules deploy alongside the application.
- The optional gateway uses `sts:SetSourceIdentity` for tamper-resistant end-user attribution.

If you spot a hardening gap, please report it via the AWS Security channel above.
