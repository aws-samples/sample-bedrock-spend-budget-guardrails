import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const eb = new EventBridgeClient({ region: 'us-west-2' });

const main = async () => {
  const pending = await ddb.send(new ScanCommand({ TableName: 'dev-bbg-pending-meter' }));
  console.log(`pending rows: ${pending.Items?.length}`);
  let emitted = 0;
  for (const row of pending.Items ?? []) {
    const id = await ddb.send(new GetCommand({ TableName: 'dev-bbg-identity-cache', Key: { requestId: row.requestId } }));
    if (!id.Item?.principal) {
      console.log(`no identity for ${row.requestId}`);
      continue;
    }
    await eb.send(new PutEventsCommand({
      Entries: [{
        Source: 'bbg.metering',
        DetailType: 'bbg.identity-arrived',
        Detail: JSON.stringify({ requestId: row.requestId, principal: id.Item.principal, modelId: row.modelId }),
      }],
    }));
    emitted++;
  }
  console.log(`emitted ${emitted} identity-arrived events`);
};
void main();
