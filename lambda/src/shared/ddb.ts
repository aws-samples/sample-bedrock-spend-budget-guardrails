import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// `HOME_REGION` is set on Lambdas that may run in a metered region
// different from the home region (where DataStack lives). When unset,
// the SDK falls back to `AWS_REGION` (the Lambda's own region), which
// is correct for the single-region case where home == metered.
const base = new DynamoDBClient({
  region: process.env.HOME_REGION || undefined,
});
export const ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
});

export const periodFor = (date: Date = new Date()): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

export const periodEndEpochFor = (date: Date = new Date()): number => {
  // End of next month, used as TTL on RunningSpend so rollover artifacts are
  // automatically purged after one period of grace.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 1, 0, 0, 0));
  return Math.floor(d.getTime() / 1000);
};

export const oneHourFromNowEpoch = (): number =>
  Math.floor(Date.now() / 1000) + 3600;
