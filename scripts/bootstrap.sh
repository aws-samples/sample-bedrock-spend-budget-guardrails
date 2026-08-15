#!/usr/bin/env bash
# One-time bootstrap helper. Inherits the caller's AWS environment.
set -euo pipefail

ACCOUNT="${BBG_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
REGION="${AWS_REGION:-us-west-2}"

echo "Bootstrapping CDK in aws://$ACCOUNT/$REGION"
npx cdk bootstrap "aws://$ACCOUNT/$REGION"

echo
echo "Optional: create a CodeStar Connection for the GitOps pipeline:"
echo "  aws codestar-connections create-connection --provider-type GitHub --connection-name bbg-github"
echo "  aws ssm put-parameter --name /bbg/github-connection-arn --value <arn> --type String"
echo "  npx cdk deploy PipelineStack"
