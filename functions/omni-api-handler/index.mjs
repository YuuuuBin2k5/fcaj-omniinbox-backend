// AWS Lambda: omni-api-handler (Node.js 22.x - arm64 - 128MB - timeout 10s - role: omni-api-role)
// Routes (Cognito Authorizer required):
//   GET  /conversations
//   GET  /conversations/{conversationId}/messages
//   PATCH /conversations/{conversationId}
//   POST /ws-ticket
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

const CONV_INDEX = "gsi-all-by-time";
const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"];
const MAX_FILTER_PAGES = 5;
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
  return email || username || "unknown";
}

class HttpError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function decodeConvId(raw) {
  if (!raw) throw new HttpError(400, "Missing conversationId");
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded) throw new HttpError(400, "Missing conversationId");
    return decoded;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Invalid conversationId encoding");
  }
}

const encodeToken = (key) =>
  key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;

function decodeToken(token) {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid nextToken");
  }
}

const parseLimit = (v) => Math.min(Math.max(parseInt(v, 10) || 50, 1), 100);

function parseBody(event, allowEmpty = false) {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      if (allowEmpty) return {};
      throw new Error();
    }
    return body;
  } catch {
    if (allowEmpty && !event.body) return {};
    throw new HttpError(400, "Invalid JSON body");
  }
}

const publicConversation = (item) => {
  if (!item) return item;
  const { gsi1pk, lastMessageId, ...rest } = item;
  return rest;
};

/**
 * Factory for omni-api-handler allowing dependency injection in unit tests.
 */
export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const ddb =
    deps.ddbClient ||
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const now = deps.now || Date.now;
  const uuid = deps.randomUUID || randomUUID;
  const createWsClient =
    deps.createWsClient ||
    ((endpoint) => new ApiGatewayManagementApiClient({ endpoint }));

  const CONV_TABLE = env.CONVERSATIONS_TABLE || "OmniConversations";
  const MSG_TABLE = env.MESSAGES_TABLE || "OmniMessages";
  const IDEM_TABLE = env.IDEMPOTENCY_TABLE || "OmniIdempotency";
  const CONN_TABLE = env.WS_CONNECTIONS_TABLE || "OmniWSConnections";
  const WS_ENDPOINT = env.WS_ENDPOINT || "";
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "*";

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  };

  const json = (statusCode, body) => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  });

  let wsClient;

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
      for (const item of res.Items || []) {
        if (item.clientType !== "simulator") connections.push(item);
      }
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
          }
        }
      })
    );
  }

  async function listConversations(event) {
    const q = event.queryStringParameters || {};
    const names = {};
    const values = { ":pk": "CONV" };
    const filters = [];

    if (q.channel) {
      filters.push("#ch = :ch");
      names["#ch"] = "channel";
      values[":ch"] = q.channel.toLowerCase();
    }
    if (q.status) {
      if (!STATUSES.includes(q.status)) throw new HttpError(400, "Invalid status filter");
      filters.push("#st = :st");
      names["#st"] = "status";
      values[":st"] = q.status;
    }

    const limit = parseLimit(q.limit);
    let nextKey = decodeToken(q.nextToken);

    if (filters.length === 0) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: CONV_TABLE,
          IndexName: CONV_INDEX,
          KeyConditionExpression: "gsi1pk = :pk",
          ExpressionAttributeValues: values,
          ScanIndexForward: false,
          Limit: limit,
          ExclusiveStartKey: nextKey,
        })
      );
      return json(200, {
        conversations: (res.Items || []).map(publicConversation),
        nextToken: encodeToken(res.LastEvaluatedKey),
      });
    }

    // With FilterExpression, DynamoDB applies Limit BEFORE filtering; loop bounded pages so matches fill cleanly.
    const collected = [];
    for (let page = 0; page < MAX_FILTER_PAGES && collected.length < limit; page += 1) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: CONV_TABLE,
          IndexName: CONV_INDEX,
          KeyConditionExpression: "gsi1pk = :pk",
          FilterExpression: filters.join(" AND "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ScanIndexForward: false,
          Limit: limit,
          ExclusiveStartKey: nextKey,
        })
      );
      for (const item of res.Items || []) {
        collected.push(publicConversation(item));
      }
      nextKey = res.LastEvaluatedKey;
      if (!nextKey) break;
    }

    return json(200, {
      conversations: collected,
      nextToken: encodeToken(nextKey),
    });
  }

  async function listMessages(event) {
    const q = event.queryStringParameters || {};
    const convId = decodeConvId(event.pathParameters?.conversationId);

    const res = await ddb.send(
      new QueryCommand({
        TableName: MSG_TABLE,
        KeyConditionExpression: "conversationId = :cid",
        ExpressionAttributeValues: { ":cid": convId },
        ScanIndexForward: false,
        Limit: parseLimit(q.limit),
        ExclusiveStartKey: decodeToken(q.nextToken),
      })
    );

    return json(200, {
      conversationId: convId,
      messages: (res.Items || []).reverse(),
      nextToken: encodeToken(res.LastEvaluatedKey),
    });
  }

  async function patchConversation(event) {
    const convId = decodeConvId(event.pathParameters?.conversationId);
    const body = parseBody(event);

    const updates = [];
    const names = {};
    const values = {};

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new HttpError(400, "Invalid status");
      updates.push("#st = :st");
      names["#st"] = "status";
      values[":st"] = body.status;
    }
    if (body.assignedAgent !== undefined) {
      const agent = typeof body.assignedAgent === "string" ? body.assignedAgent.trim() : "";
      if (!agent || agent.length > 50) throw new HttpError(400, "Invalid assignedAgent");
      updates.push("assignedAgent = :ag");
      values[":ag"] = agent;
    }
    if (body.unreadCount !== undefined) {
      const n = Number(body.unreadCount);
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "Invalid unreadCount");
      updates.push("unreadCount = :uc");
      values[":uc"] = n;
    }
    if (!updates.length) throw new HttpError(400, "Nothing to update");

    let condition = "attribute_exists(conversationId)";
    if (body.expectedAssignedAgent !== undefined) {
      condition += " AND assignedAgent = :expected";
      values[":expected"] = String(body.expectedAssignedAgent);
    }
    if (body.expectedLastMessageAt !== undefined) {
      condition += " AND lastMessageAt = :expectedLma";
      values[":expectedLma"] = String(body.expectedLastMessageAt);
    }

    let updated;
    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: CONV_TABLE,
          Key: { conversationId: convId },
          UpdateExpression: `SET ${updates.join(", ")}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        })
      );
      updated = res.Attributes;
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: CONV_TABLE,
          Key: { conversationId: convId },
          ConsistentRead: true,
        })
      );
      if (!Item) throw new HttpError(404, "Conversation not found");
      throw new HttpError(409, "Conversation was changed by someone else", {
        conversation: publicConversation(Item),
      });
    }

    const conversation = publicConversation(updated);
    try {
      await broadcastToAgents({ event: "CONVERSATION_UPDATED", conversation });
    } catch (err) {
      console.warn("Broadcast CONVERSATION_UPDATED failed (ignored):", err.message);
    }
    return json(200, { conversation });
  }

  async function createWsTicket(event) {
    const ticket = uuid();
    const nowMs = now();
    const expiresAt = nowMs + 60_000;
    const claims = getClaims(event);
    const body = parseBody(event, true);
    const clientType = body.clientType === "simulator" ? "simulator" : "portal";

    await ddb.send(
      new PutCommand({
        TableName: IDEM_TABLE,
        Item: {
          messageKey: `WSTICKET#${ticket}`,
          agent: resolveAgentId(claims),
          clientType,
          expiresAt,
          ttl: Math.floor(nowMs / 1000) + 300,
        },
      })
    );

    return json(200, { ticket, expiresAt, clientType });
  }

  return async (event = {}) => {
    const method = (event.httpMethod || event.requestContext?.http?.method || "").toUpperCase();
    const resource = event.resource || event.path || "";

    if (method === "OPTIONS") return json(200, {});

    try {
      if (method === "GET" && resource === "/conversations") return await listConversations(event);
      if (method === "GET" && resource === "/conversations/{conversationId}/messages") {
        return await listMessages(event);
      }
      if (method === "PATCH" && resource === "/conversations/{conversationId}") {
        return await patchConversation(event);
      }
      if (method === "POST" && resource === "/ws-ticket") return await createWsTicket(event);

      return json(404, { error: "Route not found" });
    } catch (err) {
      if (err instanceof HttpError) {
        return json(err.statusCode, { error: err.message, ...err.extra });
      }
      if (err.name === "ValidationException") {
        return json(400, { error: "Invalid request" });
      }
      console.error("API Handler Error:", err);
      return json(500, { error: "Internal server error" });
    }
  };
}

export const handler = createHandler();
