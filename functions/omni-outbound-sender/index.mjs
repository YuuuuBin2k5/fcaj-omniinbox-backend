// AWS Lambda: omni-outbound-sender (Node.js 22.x - arm64 - 256MB - timeout 15s - role: omni-outbound-role)
// Route: POST /messages/reply (Cognito Authorizer required)
// Includes atomic reply ownership guard (409 on unassigned race or foreign assignee), SSM 5m TTL cache,
// Amendment #1 (UUID-safe agentId), #2 (FAILED / concurrent unreadCount), and #3 (strip gsi1pk + WS clientType isolation).
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
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts Cognito JWT claims across both API Gateway REST v1 and HTTP v2 authorizers.
 */
function getClaims(event = {}) {
  return (
    event.requestContext?.authorizer?.claims ||
    event.requestContext?.authorizer?.jwt?.claims ||
    {}
  );
}

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
  const { gsi1pk, lastMessageId, ...rest } = item;
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
  let cachedTokenAt = 0;
  let wsClient = null;

  async function getTelegramToken(forceRefresh = false) {
    const nowMs = now();
    if (!forceRefresh && cachedTelegramToken && nowMs - cachedTokenAt < TOKEN_CACHE_TTL_MS) {
      return { token: cachedTelegramToken, fromCache: true };
    }
    const res = await ssm.send(new GetParameterCommand({ Name: SSM_PATH, WithDecryption: true }));
    cachedTelegramToken = res.Parameter?.Value || "";
    cachedTokenAt = nowMs;
    return { token: cachedTelegramToken, fromCache: false };
  }

  async function broadcastToAgents(payload) {
    if (!WS_ENDPOINT) return;
    try {
      wsClient ??= createWsClient(WS_ENDPOINT);
      const isTelegram = payload?.message?.channel === "telegram";
      const connections = [];
      let lastKey;
      do {
        const res = await ddb.send(
          new ScanCommand({ TableName: CONN_TABLE, ExclusiveStartKey: lastKey })
        );
        for (const item of res.Items || []) {
          // Never push real Telegram outbound messages down Simulator-only connections
          if (isTelegram && item.clientType === "simulator") continue;
          connections.push(item);
        }
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
      let tokenInfo = await getTelegramToken(false);
      if (!tokenInfo.token) return { ok: false, errorDetail: "Telegram token not configured" };

      let res = await fetchImpl(`https://api.telegram.org/bot${tokenInfo.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: recipientId, text: content }),
        signal: AbortSignal.timeout(8000),
      });
      let data = await res.json();

      if (data.ok !== true && data.error_code === 401 && tokenInfo.fromCache) {
        tokenInfo = await getTelegramToken(true);
        if (!tokenInfo.token) return { ok: false, errorDetail: "Telegram token not configured" };
        res = await fetchImpl(`https://api.telegram.org/bot${tokenInfo.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: recipientId, text: content }),
          signal: AbortSignal.timeout(8000),
        });
        data = await res.json();
      }

      if (data.ok !== true) {
        const confirmed =
          data.ok === false &&
          Number.isInteger(data.error_code) &&
          data.error_code >= 400 &&
          data.error_code < 500;
        return {
          ok: false,
          uncertain: !confirmed,
          errorDetail: confirmed ? data.description || "Telegram API error" : "Telegram delivery unconfirmed",
        };
      }
      return { ok: true };
    } catch (err) {
      // Never leak raw error message/URL that might contain the bot token
      return { ok: false, uncertain: true, errorDetail: `Telegram delivery unconfirmed (${err.name})` };
    }
  }

  return async (event = {}) => {
    const method = (event.httpMethod || event.requestContext?.http?.method || "").toUpperCase();
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders, body: "" };

    try {
      // 1. Agent identity strictly from Cognito JWT
      const agentId = resolveAgentId(getClaims(event));
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

      const { conversationId, retryOfMessageId, requestId } = body;
      if (
        requestId !== undefined &&
        (typeof requestId !== "string" || !/^\d{13}-/.test(requestId) || !UUID_RE.test(requestId.slice(14)))
      ) {
        return respond(400, { error: "Invalid requestId" });
      }
      if (typeof conversationId !== "string" || !conversationId.startsWith("CONV#")) {
        return respond(400, { error: "Invalid conversationId" });
      }
      let content = typeof body.content === "string" ? body.content.trim() : "";
      if (!retryOfMessageId && !content) return respond(400, { error: "Missing content" });
      if (content.length > MAX_CONTENT) {
        return respond(400, { error: `Content exceeds ${MAX_CONTENT} chars` });
      }

      // 3. Conversation MUST exist; derive channel & recipientId strictly on server
      let { Item: conv } = await ddb.send(
        new GetCommand({ TableName: CONV_TABLE, Key: { conversationId }, ConsistentRead: true })
      );
      if (!conv) return respond(404, { error: "Conversation not found" });

      const [, parsedChannel, ...idParts] = conversationId.split("#");
      const channel = conv.channel;
      const recipientId = idParts.join("#");
      if (!channel || parsedChannel !== channel || !recipientId) {
        return respond(400, { error: "Corrupted conversation record" });
      }

      // 4. Atomic reply ownership guard BEFORE dispatching external channel calls:
      //    Prevents two agents from overlapping replies to the same unassigned/assigned customer.
      if (conv.assignedAgent && conv.assignedAgent !== "unassigned" && conv.assignedAgent !== agentId) {
        return respond(409, {
          error: "CONVERSATION_ASSIGNED_TO_OTHER",
          message: `Conversation is assigned to ${conv.assignedAgent}`,
          conversation: publicConversation(conv),
        });
      }

      if (!conv.assignedAgent || conv.assignedAgent === "unassigned") {
        try {
          const claimRes = await ddb.send(
            new UpdateCommand({
              TableName: CONV_TABLE,
              Key: { conversationId },
              UpdateExpression: "SET assignedAgent = :ag",
              ConditionExpression:
                "attribute_exists(conversationId) AND (attribute_not_exists(assignedAgent) OR assignedAgent = :unassigned)",
              ExpressionAttributeValues: { ":ag": agentId, ":unassigned": "unassigned" },
              ReturnValues: "ALL_NEW",
            })
          );
          if (claimRes.Attributes) conv = claimRes.Attributes;
        } catch (err) {
          if (err.name !== "ConditionalCheckFailedException") throw err;
          const { Item: current } = await ddb.send(
            new GetCommand({ TableName: CONV_TABLE, Key: { conversationId }, ConsistentRead: true })
          );
          if (!current) return respond(404, { error: "Conversation not found" });
          if (
            current.assignedAgent &&
            current.assignedAgent !== "unassigned" &&
            current.assignedAgent !== agentId
          ) {
            return respond(409, {
              error: "CONVERSATION_ASSIGNED_TO_OTHER",
              message: `Conversation is assigned to ${current.assignedAgent}`,
              conversation: publicConversation(current),
            });
          }
          conv = current;
        }
      }

      // 5. Retry validation: only FAILED OUTBOUND messages can be retried in place
      let existing = null;
      if (retryOfMessageId) {
        const { Item } = await ddb.send(
          new GetCommand({
            TableName: MSG_TABLE,
            Key: { conversationId, messageId: retryOfMessageId },
            ConsistentRead: true,
          })
        );
        if (!Item) return respond(404, { error: "Message to retry not found" });
        if (Item.status === "SENDING" || Item.status === "UNKNOWN") {
          return respond(409, { error: "Delivery is pending or unconfirmed", message: Item });
        }
        if (Item.direction !== "OUTBOUND" || Item.status !== "FAILED") {
          return respond(400, { error: "Only FAILED outbound messages can be retried" });
        }
        existing = Item;
        content = Item.content;
      }

      // 6. Reserve the delivery in OmniMessages before calling Telegram.
      const startedMs = now();
      const deliveredVia = channel === "telegram" ? "telegram" : "simulator";
      const message = existing || {
        conversationId,
        messageId: requestId
          ? `MSG#${requestId.slice(0, 13)}#OUT-${requestId}`
          : `MSG#${String(startedMs).padStart(13, "0")}#OUT-${uuid()}`,
        channel,
        channelMessageId: "",
        direction: "OUTBOUND",
        senderId: agentId,
        senderName: agentId,
        content,
        deliveredVia,
        agentId,
        createdAt: new Date(startedMs).toISOString(),
      };
      const key = { conversationId, messageId: message.messageId };
      try {
        if (existing) {
          await ddb.send(
            new UpdateCommand({
              TableName: MSG_TABLE,
              Key: key,
              UpdateExpression: "SET #st = :sending",
              ConditionExpression: "#st = :failed",
              ExpressionAttributeNames: { "#st": "status" },
              ExpressionAttributeValues: { ":sending": "SENDING", ":failed": "FAILED" },
            })
          );
        } else {
          await ddb.send(
            new PutCommand({
              TableName: MSG_TABLE,
              Item: { ...message, status: "SENDING" },
              ConditionExpression: "attribute_not_exists(messageId)",
            })
          );
        }
      } catch (err) {
        if (err.name !== "ConditionalCheckFailedException") throw err;
        const { Item } = await ddb.send(
          new GetCommand({ TableName: MSG_TABLE, Key: key, ConsistentRead: true })
        );
        if (!existing && Item?.agentId === agentId && Item.content === content) {
          return respond(200, {
            ok: Item.status === "SENT",
            message: Item,
            conversation: publicConversation(conv),
          });
        }
        return respond(409, { error: "Message is already being handled", message: Item });
      }

      const delivery = channel === "telegram" ? await sendViaTelegram(recipientId, content) : { ok: true };
      const status = delivery.ok ? "SENT" : delivery.uncertain ? "UNKNOWN" : "FAILED";
      const errorDetail = delivery.errorDetail ?? null;
      const nowIso = new Date(now()).toISOString();
      const outboundMsg = { ...message, status, errorDetail, deliveredVia, agentId };
      if (existing) outboundMsg.retriedAt = nowIso;
      await ddb.send(
        new UpdateCommand({
          TableName: MSG_TABLE,
          Key: key,
          UpdateExpression:
            "SET #st = :st, errorDetail = :ed, deliveredVia = :dv, agentId = :ag" +
            (existing ? ", retriedAt = :now" : ""),
          ConditionExpression: "#st = :sending",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":st": status,
            ":ed": errorDetail,
            ":dv": deliveredVia,
            ":ag": agentId,
            ":sending": "SENDING",
            ...(existing ? { ":now": nowIso } : {}),
          },
          ReturnValues: "ALL_NEW",
        })
      );

      // 7. Update conversation safely (Amendments #2 & #3):
      //    - On FAILED / UNKNOWN: preserve unreadCount, lastMessage, lastMessageAt, and OPEN status.
      //    - On SENT: clear unreadCount ONLY if no newer inbound message arrived during delivery;
      //      set lastMessageDirection = "OUTBOUND" when updating preview; advance OPEN -> IN_PROGRESS.
      let latestConv = conv;
      try {
        if (status === "SENT") {
          const sets = ["unreadCount = :zero"];
          const values = { ":zero": 0, ":prevLma": conv.lastMessageAt };
          const sameMessage =
            conv.lastMessageId === undefined
              ? "attribute_not_exists(lastMessageId)"
              : "lastMessageId = :prevId";
          if (conv.lastMessageId !== undefined) values[":prevId"] = conv.lastMessageId;
          if (!existing && (!conv.lastMessageAt || nowIso > conv.lastMessageAt)) {
            sets.push(
              "lastMessage = :lm",
              "lastMessageAt = :lma",
              "lastMessageId = :lid",
              "lastMessageDirection = :dir"
            );
            values[":lid"] = outboundMsg.messageId;
            values[":lm"] = `[NV] ${content}`.slice(0, 200);
            values[":lma"] = nowIso;
            values[":dir"] = "OUTBOUND";
          }

          try {
            const res = await ddb.send(
              new UpdateCommand({
                TableName: CONV_TABLE,
                Key: { conversationId },
                UpdateExpression: `SET ${sets.join(", ")}`,
                ConditionExpression: `attribute_exists(conversationId) AND lastMessageAt = :prevLma AND ${sameMessage}`,
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
            if (!currentConv) throw new Error("Conversation no longer exists");
            latestConv = currentConv;

            // Newer inbound message arrived in-flight => update preview without clearing unreadCount
            if (!existing && currentConv.lastMessageAt < nowIso) {
              const res = await ddb.send(
                new UpdateCommand({
                  TableName: CONV_TABLE,
                  Key: { conversationId },
                  UpdateExpression:
                    "SET lastMessage = :lm, lastMessageAt = :lma, lastMessageId = :lid, lastMessageDirection = :dir",
                  ConditionExpression: "lastMessageAt < :lma",
                  ExpressionAttributeValues: {
                    ":lm": `[NV] ${content}`.slice(0, 200),
                    ":lma": nowIso,
                    ":lid": outboundMsg.messageId,
                    ":dir": "OUTBOUND",
                  },
                  ReturnValues: "ALL_NEW",
                })
              );
              if (res.Attributes) latestConv = res.Attributes;
            }
          }

          if (!latestConv.status || latestConv.status === "OPEN") {
            try {
              const res = await ddb.send(
                new UpdateCommand({
                  TableName: CONV_TABLE,
                  Key: { conversationId },
                  UpdateExpression: "SET #st = :inProgress",
                  ConditionExpression:
                    "attribute_exists(conversationId) AND (attribute_not_exists(#st) OR #st = :open)",
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
      } catch (err) {
        console.warn("Delivery saved but conversation update failed:", err.name);
        latestConv = null;
      }

      // 8. Strip internal gsi1pk and broadcast best-effort
      const pubConv = publicConversation(latestConv);
      await broadcastToAgents({
        event: "OUTBOUND_MESSAGE",
        conversation: pubConv,
        message: outboundMsg,
      });

      return respond(200, { ok: status === "SENT", message: outboundMsg, conversation: pubConv });
    } catch (err) {
      console.error("Outbound Sender Error:", err);
      return respond(500, { error: "Could not confirm delivery" });
    }
  };
}

export const handler = createHandler();
