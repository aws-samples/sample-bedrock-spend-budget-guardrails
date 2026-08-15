#!/usr/bin/env tsx
/**
 * Seeds Cognito users in the deployed User Pool from environment
 * variables — nothing is hardcoded so this repo can be safely shared.
 *
 *   BBG_ADMIN_EMAIL   — primary Admins-group user (required)
 *   BBG_USER_EMAIL    — non-admin Users-group user (optional)
 *   BBG_TEMP_PASSWORD — initial password (required)
 *   BBG_STAGE_PREFIX  — `dev` or `prod` (defaults to dev)
 *
 * Neither user is given `custom:iam_principal`, so the UI reads real
 * Bedrock spend keyed against the actual IAM identity each user
 * presents in CloudTrail when they invoke models.
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const stagePrefix = process.env.BBG_STAGE_PREFIX ?? 'dev';
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';
const adminEmail = process.env.BBG_ADMIN_EMAIL;
const userEmail = process.env.BBG_USER_EMAIL;
const tempPassword = process.env.BBG_TEMP_PASSWORD;

if (!adminEmail) {
  throw new Error('BBG_ADMIN_EMAIL env var is required (e.g. ops@example.com).');
}
if (!tempPassword) {
  throw new Error('BBG_TEMP_PASSWORD env var is required (choose a strong temporary password).');
}

const cfn = new CloudFormationClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });

interface SeedUser {
  email: string;
  group: 'Admins' | 'Users';
}

const seed: SeedUser[] = [
  { email: adminEmail, group: 'Admins' },
  ...(userEmail ? [{ email: userEmail, group: 'Users' as const }] : []),
];

const main = async (): Promise<void> => {
  const stacks = await cfn.send(new DescribeStacksCommand({ StackName: `${stagePrefix}-bbg-auth` }));
  const userPoolId = stacks.Stacks?.[0]?.Outputs?.find(
    (o: { OutputKey?: string; OutputValue?: string }) => o.OutputKey === 'UserPoolId',
  )?.OutputValue;
  if (!userPoolId) throw new Error(`UserPoolId output not found on ${stagePrefix}-bbg-auth — has the auth stack deployed?`);

  console.log(`[seed-cognito] stage=${stagePrefix} userPoolId=${userPoolId} users=${seed.map((s) => s.email).join(', ')}`);

  for (const u of seed) {
    const userAttributes = [
      { Name: 'email', Value: u.email },
      { Name: 'email_verified', Value: 'true' },
    ];

    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: u.email,
          UserAttributes: userAttributes,
          TemporaryPassword: tempPassword,
          MessageAction: 'SUPPRESS',
        }),
      );
      console.log(`[seed-cognito] created ${u.email} (group ${u.group})`);
    } catch (err) {
      if ((err as { name?: string }).name === 'UsernameExistsException') {
        console.log(`[seed-cognito] ${u.email} exists`);
      } else {
        throw err;
      }
    }

    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: u.email,
        Password: tempPassword,
        Permanent: true,
      }),
    );
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: u.email,
        GroupName: u.group,
      }),
    );
  }

  const admin = seed.find((u) => u.group === 'Admins');
  if (admin) {
    console.log(`[seed-cognito] login as: ${admin.email} / ${tempPassword}`);
  }
};

void main();
