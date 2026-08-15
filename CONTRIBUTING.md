# Contributing to Bedrock Budget Guard

Thank you for your interest in contributing! This project is published under [aws-samples](https://github.com/aws-samples). We welcome bug reports, feature requests, and pull requests.


## Reporting bugs / suggesting features

Open a GitHub issue. Include:

- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- AWS region(s) involved
- Relevant CloudWatch alarm names or `bbg/Operations` dashboard widgets if the issue is operational
- For pricing-table issues: the `modelId`, the relevant Pricing API SKU JSON, and what `Pricing` row content is wrong

## Pull requests

1. Fork the repo and create a feature branch off `main`.
2. Use **conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `perf:`).
3. Update `CHANGELOG.md` under `[Unreleased]` with your change — do this in the PR, not at release time. Every published change ships in a numbered release, and the release notes are generated from these entries.
4. Run `npm run build && npm test && npx cdk synth` locally — `cdk-nag` AwsSolutions checks must pass clean.
5. Open the PR against `main`. There is no PR-triggered CI in this repo, so run the checks in step 4 locally before opening it.

## Local development

See the [README quickstart](README.md#quickstart). Note: BBG inherits whatever AWS credentials your shell already has — **do not** set `AWS_PROFILE` in any commit; the user's existing environment is the source of truth.

## Code style

- TypeScript strict mode, ES modules, Node 20.
- Prettier + ESLint configurations live at the repo root and are applied across all workspaces.
- Lambda handler files export a single `handler` function and are unit-tested with Vitest.
- CDK stacks: one stack per file, props interfaces co-located with the stack class.

## Security disclosures

See [SECURITY.md](SECURITY.md). Do **not** open public GitHub issues for security vulnerabilities.

## Code of conduct

This project follows the [Amazon Open Source Code of Conduct](CODE_OF_CONDUCT.md).
