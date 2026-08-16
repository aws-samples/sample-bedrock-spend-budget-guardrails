#!/usr/bin/env bash
# CDK bootstrap helper. Inherits the caller's AWS environment.
#
# For a first-time install, prefer ./scripts/install.sh — it does this plus the
# config, connection, deploy, and admin seeding, and is safe to re-run.
set -euo pipefail

ACCOUNT="${BBG_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
REGION="${AWS_REGION:-us-west-2}"

# us-east-1 is always required, even for a single-region install: the CloudFront
# WAF WebACL and any ACM cert are CloudFront-scoped and can only live there.
# Bootstrapping only the home region produces a confusing
# "Invalid principal in policy" failure much later, during cdk deploy.
echo "Bootstrapping CDK in aws://$ACCOUNT/$REGION"
npx cdk bootstrap "aws://$ACCOUNT/$REGION"

if [[ "$REGION" != "us-east-1" ]]; then
  echo "Bootstrapping aws://$ACCOUNT/us-east-1 (required for the CloudFront WAF/cert)"
  npx cdk bootstrap "aws://$ACCOUNT/us-east-1"
fi

echo
echo "Bootstrapped. To finish the install in one command:"
echo "  ./scripts/install.sh --github-owner <your-fork-owner> --email you@example.com"
