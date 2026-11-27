// AWS Lambda: omni-outbound-sender (Node.js 22.x - arm64 - 256MB - timeout 15s - role: omni-outbound-role)
// Route: POST /messages/reply (Cognito Authorizer required)
// Includes Cross-Team Amendments #1 (UUID-safe agentId), #2 (FAILED / concurrent unreadCount), and #3 (race-safe assignedAgent + strip gsi1pk).
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

const MAX_CONTENT = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a human-readable agent identifier from Cognito JWT claims.
 * Amendment #1: When Cognito generates a UUID cognito:username (Email sign-in), prefers email.
 */
export function resolveAgentId(claims = {}) {
  const username = claims["cognito:username"];
  const email = claims.email;
  if (username && !UUID_RE.test(username)) return username;
  return email || username || null;
}

const publicConversation = (item) => {
  if (!item) return item;
  const { gsi1pk, ...rest } = item;
  return rest;
};

/**
 * Factory for omni-outbound-sender allowing dependency injection in unit tests.
 */
export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const ddb =
    deps.ddbClient ||
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const ssm = deps.ssmClient || new SSMClient({});
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || Date.now;
  const uuid = deps.randomUUID || randomUUID;
  const createWsClient =
    deps.createWsClient ||
    ((endpoint) => new ApiGatewayManagementApiClient({ endpoint }));

  const CONV_TABLE = env.CONVERSATIONS_TABLE || "OmniConversations";
  const MSG_TABLE = env.MESSAGES_TABLE || "OmniMessages";
  const CONN_TABLE = env.WS_CONNECTIONS_TABLE || "OmniWSConnections";
  const WS_ENDPOINT = env.WS_ENDPOINT || "";
  const SSM_PATH = env.TELEGRAM_TOKEN_SSM_PATH || "/omniinbox/prod/telegram_bot_token";
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "*";

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  const respond = (statusCode, obj) => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(obj),
  });

  let cachedTelegramToken = null;
  let wsClient = null;

  async function getTelegramToken() {
    if (cachedTelegramToken) return cachedTelegramToken;
    const res = await ssm.send(new GetParameterCommand({ Name: SSM_PATH, WithDecryption: true }));
    cachedTelegramToken = res.Parameter?.Value || "";
    return cachedTelegramToken;
  }

  async function broadcastToAgents(payload) {
    if (!WS_ENDPOINT) return;
    try {
      wsClient ??= createWsClient(WS_ENDPOINT);
      const connections = [];
      let lastKey;
      do {
        const res = await ddb.send(
          new ScanCommand({ TableName: CONN_TABLE, ExclusiveStartKey: lastKey })
        );
        connections.push(...(res.Items || []));
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);

      const data = Buffer.from(JSON.stringify(payload));
      await Promise.allSettled(
        connections.map(async ({ connectionId }) => {
          try {
            await wsClient.send(
              new PostToConnectionCommand({ ConnectionId: connectionId, Data: data })
            );
          } catch (err) {
            if (
              err.name === "GoneException" ||
              err.statusCode === 410 ||
              err.$metadata?.httpStatusCode === 410
            ) {
              await ddb.send(new DeleteCommand({ TableName: CONN_TABLE, Key: { connectionId } }));
            }
          }
        })
      );
    } catch (err) {
      console.warn("[BROADCAST_FAILED]", err.message);
    }
  }

  async function sendViaTelegram(recipientId, content) {
    try {
      const token = await getTelegramToken();
      if (!token) return { ok: false, errorDetail: "Telegram token not configured" };
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: recipientId, text: content }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!data.ok) return { ok: false, errorDetail: data.description || "Telegram API error" };
      return { ok: true };
    } catch (err) {
      // Never leak raw error message/URL that might contain the bot token
      return { ok: false, errorDetail: `Telegram request failed (${err.name})` };
    }
  }

  return async (event = {}) => {
    const method = (event.httpMethod || event.requestContext?.http?.method || "").toUpperCase();
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders, body: "" };

    try {
      // 1. Agent identity strictly from Cognito JWT
      const claims = event.requestContext?.authorizer?.claims || {};
      const agentId = resolveAgentId(claims);
      if (!agentId) return respond(401, { error: "Unauthorized" });

      // 2. Validate request body
      let body;
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch {
        return respond(400, { error: "Invalid JSON" });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return respond(400, { error: "Invalid JSON" });
      }

      const { conversationId, retryOfMessageId } = body;
      if (typeof conversationId !== "string" || !conversationId.startsWith("CONV#")) {
        return respond(400, { error: "Invalid conversationId" });
      }
      let content = typeof body.content === "string" ? body.content.trim() : "";
      if (!retryOfMessageId && !content) return respond(400, { error: "Missing content" });
      if (content.length > MAX_CONTENT) {
        return respond(400, { error: `Content exceeds ${MAX_CONTENT} chars` });
      }

      // 3. Conversation MUST exist; derive channel & recipientId strictly on server
      const { Item: conv } = await ddb.send(
        new GetCommand({ TableName: CONV_TABLE, Key: { conversationId } })
      );
      if (!conv) return respond(404, { error: "Conversation not found" });

      const [, parsedChannel, ...idParts] = conversationId.split("#");
      const channel = conv.channel;
      const recipientId = idParts.join("#");
      if (!channel || parsedChannel !== channel || !recipientId) {
        return respond(400, { error: "Corrupted conversation record" });
      }

      // 4. Retry: only FAILED OUTBOUND messages can be retried in place
      let existing = null;
      if (retryOfMessageId) {
        const { Item } = await ddb.send(
          new GetCommand({
            TableName: MSG_TABLE,
            Key: { conversationId, messageId: retryOfMessageId },
          })
        );
        if (!Item) return respond(404, { error: "Message to retry not found" });
        if (Item.direction !== "OUTBOUND" || Item.status !== "FAILED") {
          return respond(400, { error: "Only FAILED outbound messages can be retried" });
        }
        existing = Item;
        content = Item.content;
      }

      // 5. Deliver: Telegram = real HTTP Bot API; Shopee/Zalo/WebChat = simulated (no external HTTP)
      let status = "SENT";
      let errorDetail;
      let deliveredVia = "simulator";
      if (channel === "telegram") {
        deliveredVia = "telegram";
        const result = await sendViaTelegram(recipientId, content);
        if (!result.ok) {
          status = "FAILED";
          errorDetail = result.errorDetail;
        }
      }

      // 6. Persist OUTBOUND message
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      let outboundMsg;
      if (existing) {
        await ddb.send(
          new UpdateCommand({
            TableName: MSG_TABLE,
            Key: { conversationId, messageId: existing.messageId },
            UpdateExpression:
              "SET #st = :st, errorDetail = :ed, deliveredVia = :dv, agentId = :ag, retriedAt = :now",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: {
              ":st": status,
              ":ed": errorDetail ?? null,
              ":dv": deliveredVia,
              ":ag": agentId,
              ":now": nowIso,
            },
          })
        );
        outboundMsg = {
          ...existing,
          status,
          errorDetail: errorDetail ?? null,
          deliveredVia,
          agentId,
          retriedAt: nowIso,
        };
      } else {
        outboundMsg = {
          conversationId,
          messageId: `MSG#${String(nowMs).padStart(13, "0")}#OUT-${uuid().slice(0, 8)}`,
          channel,
          channelMessageId: "",
          direction: "OUTBOUND",
          senderId: agentId,
          senderName: agentId,
          content,
          status,
          errorDetail,
          deliveredVia,
          agentId,
          createdAt: nowIso,
        };
        await ddb.send(
          new PutCommand({
            TableName: MSG_TABLE,
            Item: outboundMsg,
            ConditionExpression: "attribute_not_exists(messageId)",
          })
        );
      }

      // 7. Update conversation safely (Amendments #2 & #3):
      //    - On FAILED: do NOT reset unreadCount or overwrite lastMessage/lastMessageAt.
      //    - On SENT: clear unreadCount ONLY if no newer inbound message arrived during delivery;
      //      auto-claim assignedAgent / advance OPEN->IN_PROGRESS ONLY conditionally so concurrent handovers are never overwritten.
      let latestConv = conv;
      if (status === "SENT") {
        const sets = ["unreadCount = :zero"];
        const values = { ":zero": 0, ":prevLma": conv.lastMessageAt };
        if (!existing) {
          sets.push("lastMessage = :lm", "lastMessageAt = :lma");
          values[":lm"] = `[NV] ${content}`.slice(0, 200);
          values[":lma"] = nowIso;
        }

        try {
          const res = await ddb.send(
            new UpdateCommand({
              TableName: CONV_TABLE,
              Key: { conversationId },
              UpdateExpression: `SET ${sets.join(", ")}`,
              ConditionExpression: "attribute_exists(conversationId) AND lastMessageAt = :prevLma",
              ExpressionAttributeValues: values,
              ReturnValues: "ALL_NEW",
            })
          );
          if (res.Attributes) latestConv = res.Attributes;
        } catch (err) {
          if (err.name !== "ConditionalCheckFailedException") throw err;

          const { Item: currentConv } = await ddb.send(
            new GetCommand({ TableName: CONV_TABLE, Key: { conversationId }, ConsistentRead: true })
          );
          if (!currentConv) return respond(404, { error: "Conversation not found" });
          latestConv = currentConv;

          // Newer inbound message arrived in-flight => update preview without clearing unreadCount
          if (!existing) {
            const res = await ddb.send(
              new UpdateCommand({
                TableName: CONV_TABLE,
                Key: { conversationId },
                UpdateExpression: "SET lastMessage = :lm, lastMessageAt = :lma",
                ConditionExpression: "attribute_exists(conversationId)",
                ExpressionAttributeValues: {
                  ":lm": `[NV] ${content}`.slice(0, 200),
                  ":lma": nowIso,
                },
                ReturnValues: "ALL_NEW",
              })
            );
            if (res.Attributes) latestConv = res.Attributes;
          }
        }

        if (!conv.assignedAgent || conv.assignedAgent === "unassigned") {
          try {
            const res = await ddb.send(
              new UpdateCommand({
                TableName: CONV_TABLE,
                Key: { conversationId },
                UpdateExpression: "SET assignedAgent = :ag",
                ConditionExpression: "attribute_not_exists(assignedAgent) OR assignedAgent = :unassigned",
                ExpressionAttributeValues: { ":ag": agentId, ":unassigned": "unassigned" },
                ReturnValues: "ALL_NEW",
              })
            );
            if (res.Attributes) latestConv = res.Attributes;
          } catch (err) {
            if (err.name !== "ConditionalCheckFailedException") throw err;
          }
        }

        if (!conv.status || conv.status === "OPEN") {
          try {
            const res = await ddb.send(
              new UpdateCommand({
                TableName: CONV_TABLE,
                Key: { conversationId },
                UpdateExpression: "SET #st = :inProgress",
                ConditionExpression: "attribute_not_exists(#st) OR #st = :open",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":inProgress": "IN_PROGRESS", ":open": "OPEN" },
                ReturnValues: "ALL_NEW",
              })
            );
            if (res.Attributes) latestConv = res.Attributes;
          } catch (err) {
            if (err.name !== "ConditionalCheckFailedException") throw err;
          }
        }
      }

      // 8. Strip internal gsi1pk and broadcast best-effort
      await broadcastToAgents({
        event: "OUTBOUND_MESSAGE",
        conversation: publicConversation(latestConv),
        message: outboundMsg,
      });

      return respond(200, { ok: status === "SENT", message: outboundMsg });
    } catch (err) {
      console.error("Outbound Sender Error:", err);
      return respond(500, { error: "Internal error" });
    }
  };
}

export const handler = createHandler();
