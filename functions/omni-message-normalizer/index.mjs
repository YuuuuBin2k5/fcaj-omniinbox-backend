// AWS Lambda: omni-message-normalizer (Node.js 22.x - arm64 - 256MB - timeout 5s - role: omni-normalizer-role)
// Trigger: SQS omni-inbound-queue (Batch size 5, Report batch item failures, Max concurrency 5)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

const STALE_LOCK_MS = 40_000; // > SQS visibility timeout (30s)
const MAX_CONTENT = 4000;

/**
 * Normalizes Telegram or Simulator webhook payloads into OmniInbox canonical fields.
 */
export function normalizeInboundPayload(channel, payload, receivedAt, env = process.env, now = Date.now) {
  if (env.ENABLE_FAULT_INJECTION === "true" && payload?.forceError === true) {
    throw new Error("SIMULATED_DLQ_ERROR: Malformed or corrupted channel payload!");
  }

  const parsedReceived = Date.parse(receivedAt);
  const receivedMs = Number.isFinite(parsedReceived) ? parsedReceived : now();

  if (channel === "telegram") {
    const msg = payload?.message;
    if (!msg || typeof msg.text !== "string" || !msg.text.trim()) return { ignored: true };
    if (msg.chat?.id === undefined || msg.message_id === undefined) return { ignored: true };

    const chatId = String(msg.chat.id);
    const msgId = String(msg.message_id);
    const senderName =
      `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() ||
      msg.from?.username ||
      `Telegram #${chatId}`;
    const createdAtMs = msg.date ? Number(msg.date) * 1000 : receivedMs;

    return {
      ignored: false,
      // message_id is only unique per chat => must include chat.id
      idempotencyKey: `telegram#${chatId}#${msgId}`,
      conversationId: `CONV#telegram#${chatId}`,
      createdAtMs,
      channel: "telegram",
      channelMessageId: msgId,
      senderId: chatId,
      senderName,
      content: msg.text.slice(0, MAX_CONTENT),
    };
  }

  const customerId = String(payload?.customerId || "guest_001");
  const extMsgId = String(payload?.externalMessageId || receivedMs);
  const customerName = payload?.customerName || `Khách ${String(channel || "").toUpperCase()}`;
  const content = String(payload?.text ?? payload?.content ?? "");
  if (!content.trim()) return { ignored: true };

  const sentAt = Number(payload?.sentAtMs);

  return {
    ignored: false,
    idempotencyKey: `${channel}#${customerId}#${extMsgId}`,
    conversationId: `CONV#${channel}#${customerId}`,
    createdAtMs: receivedMs,
    channel,
    channelMessageId: extMsgId,
    senderId: customerId,
    senderName: customerName,
    content: content.slice(0, MAX_CONTENT),
    clientSentAtMs: Number.isFinite(sentAt) ? sentAt : undefined,
  };
}

/**
 * Factory for omni-message-normalizer allowing dependency injection in unit tests.
 */
export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const ddb =
    deps.ddbClient ||
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const now = deps.now || Date.now;
  const createWsClient =
    deps.createWsClient ||
    ((endpoint) => new ApiGatewayManagementApiClient({ endpoint }));

  const CONV_TABLE = env.CONVERSATIONS_TABLE || "OmniConversations";
  const MSG_TABLE = env.MESSAGES_TABLE || "OmniMessages";
  const IDEM_TABLE = env.IDEMPOTENCY_TABLE || "OmniIdempotency";
  const CONN_TABLE = env.WS_CONNECTIONS_TABLE || "OmniWSConnections";
  const WS_ENDPOINT = env.WS_ENDPOINT || "";

  let wsClient;

  async function claim(key, nowMs) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: IDEM_TABLE,
          Item: {
            messageKey: key,
            state: "PROCESSING",
            lockedAt: nowMs,
            ttl: Math.floor(nowMs / 1000) + 86400,
          },
          ConditionExpression:
            "attribute_not_exists(messageKey) OR (#s = :processing AND lockedAt < :staleBefore)",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: {
            ":processing": "PROCESSING",
            ":staleBefore": nowMs - STALE_LOCK_MS,
          },
        })
      );
      return "CLAIMED";
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: IDEM_TABLE,
          Key: { messageKey: key },
          ConsistentRead: true,
        })
      );
      if (Item?.state === "DONE") return "DUPLICATE";
      throw new Error(`Message ${key} is being processed by another worker; retry later`);
    }
  }

  async function broadcastToAgents(payload) {
    if (!WS_ENDPOINT) return;
    wsClient ??= createWsClient(WS_ENDPOINT);
    const data = Buffer.from(JSON.stringify(payload));

    const connections = [];
    let lastKey;
    do {
      const res = await ddb.send(
        new ScanCommand({ TableName: CONN_TABLE, ExclusiveStartKey: lastKey })
      );
      connections.push(...(res.Items || []));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    await Promise.allSettled(
      connections.map(async ({ connectionId }) => {
        try {
          await wsClient.send(
            new PostToConnectionCommand({ ConnectionId: connectionId, Data: data })
          );
        } catch (err) {
          if (err.name === "GoneException" || err.$metadata?.httpStatusCode === 410) {
            await ddb.send(new DeleteCommand({ TableName: CONN_TABLE, Key: { connectionId } }));
          } else {
            console.warn(`Broadcast to ${connectionId} failed:`, err.message);
          }
        }
      })
    );
  }

  async function processRecord(record) {
    const envelope = JSON.parse(record.body);
    const norm = normalizeInboundPayload(
      envelope.channel,
      envelope.payload,
      envelope.receivedAt,
      env,
      now
    );
    if (norm.ignored) return;

    const nowMs = now();

    // 1. Claim idempotency: PROCESSING -> DONE
    const claimResult = await claim(norm.idempotencyKey, nowMs);
    if (claimResult === "DUPLICATE") {
      console.log(`[IDEMPOTENCY] Duplicate message skipped: ${norm.idempotencyKey}`);
      return;
    }

    // 2. Pre-read conversation to decide status (RESOLVED + customer reply => OPEN)
    const { Item: existing } = await ddb.send(
      new GetCommand({
        TableName: CONV_TABLE,
        Key: { conversationId: norm.conversationId },
        ConsistentRead: true,
      })
    );
    const newStatus = !existing || existing.status === "RESOLVED" ? "OPEN" : existing.status;

    const createdAt = new Date(norm.createdAtMs).toISOString();
    const messageItem = {
      conversationId: norm.conversationId,
      messageId: `MSG#${String(norm.createdAtMs).padStart(13, "0")}#${norm.channelMessageId}`,
      channel: norm.channel,
      channelMessageId: norm.channelMessageId,
      direction: "INBOUND",
      senderId: norm.senderId,
      senderName: norm.senderName,
      content: norm.content,
      status: "RECEIVED",
      createdAt,
      clientSentAtMs: norm.clientSentAtMs,
    };

    // 3. Store message + update conversation atomically
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: MSG_TABLE,
                Item: messageItem,
                ConditionExpression: "attribute_not_exists(messageId)",
              },
            },
            {
              Update: {
                TableName: CONV_TABLE,
                Key: { conversationId: norm.conversationId },
                UpdateExpression:
                  "SET gsi1pk = :pk, channel = :c, customerId = :cid, customerName = :cname, " +
                  "lastMessage = :lm, lastMessageAt = :lma, #st = :st, " +
                  "assignedAgent = if_not_exists(assignedAgent, :unassigned) ADD unreadCount :one",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: {
                  ":pk": "CONV",
                  ":c": norm.channel,
                  ":cid": norm.senderId,
                  ":cname": norm.senderName,
                  ":lm": norm.content,
                  ":lma": createdAt,
                  ":st": newStatus,
                  ":unassigned": "unassigned",
                  ":one": 1,
                },
              },
            },
          ],
        })
      );
    } catch (err) {
      const alreadyStored =
        err.name === "TransactionCanceledException" &&
        (err.CancellationReasons || []).some((r) => r.Code === "ConditionalCheckFailed");
      if (!alreadyStored) throw err;
      console.log(`[IDEMPOTENCY] Message already stored by a previous attempt: ${messageItem.messageId}`);
    }

    // 4. Mark DONE
    await ddb.send(
      new UpdateCommand({
        TableName: IDEM_TABLE,
        Key: { messageKey: norm.idempotencyKey },
        UpdateExpression: "SET #s = :done, doneAt = :now",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: { ":done": "DONE", ":now": new Date(now()).toISOString() },
      })
    );

    // 5. Re-read conversation and best-effort broadcast
    try {
      const { Item: conv } = await ddb.send(
        new GetCommand({
          TableName: CONV_TABLE,
          Key: { conversationId: norm.conversationId },
          ConsistentRead: true,
        })
      );
      if (conv) {
        const { gsi1pk, ...conversation } = conv;
        await broadcastToAgents({ event: "NEW_MESSAGE", conversation, message: messageItem });
      }
    } catch (err) {
      console.warn("Broadcast NEW_MESSAGE failed (ignored):", err.message);
    }
  }

  return async (event = {}) => {
    const batchItemFailures = [];
    for (const record of event.Records || []) {
      try {
        await processRecord(record);
      } catch (err) {
        // Fixed prefix matched by CloudWatch Metric Filter Alarm
        console.error(`[NORMALIZER_FAILURE] record=${record.messageId} reason=${err.message}`);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

export const handler = createHandler();
