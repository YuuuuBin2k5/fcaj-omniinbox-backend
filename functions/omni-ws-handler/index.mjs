// AWS Lambda: omni-ws-handler (Node.js 22.x - arm64 - 128MB - timeout 10s - role: omni-ws-role)
// WebSocket API routes: $connect (one-time ticket verification), $disconnect, $default (ping/PONG)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const CONNECTION_TTL_SECONDS = 3 * 60 * 60; // 3 hours (API Gateway max WS duration is 2h)

/**
 * Normalizes epoch seconds or milliseconds to epoch milliseconds.
 */
export function toMillis(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Factory for omni-ws-handler allowing dependency injection in unit tests.
 */
export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const ddb =
    deps.ddbClient ||
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const now = deps.now || Date.now;

  const CONN_TABLE = env.WS_CONNECTIONS_TABLE || "OmniWSConnections";
  const IDEM_TABLE = env.IDEMPOTENCY_TABLE || "OmniIdempotency";

  return async (event = {}) => {
    const routeKey = event.requestContext?.routeKey;
    const connectionId = event.requestContext?.connectionId;
    const nowMs = now();

    try {
      if (routeKey === "$connect") {
        if (!connectionId) {
          return { statusCode: 400, body: "Missing connectionId" };
        }
        const ticket = event.queryStringParameters?.ticket;
        if (!ticket) {
          return { statusCode: 401, body: "Missing ticket" };
        }

        // One-time ticket: atomically delete and inspect old record
        let oldItem;
        try {
          const res = await ddb.send(
            new DeleteCommand({
              TableName: IDEM_TABLE,
              Key: { messageKey: `WSTICKET#${ticket}` },
              ConditionExpression: "attribute_exists(messageKey)",
              ReturnValues: "ALL_OLD",
            })
          );
          oldItem = res.Attributes;
        } catch (err) {
          if (err.name === "ConditionalCheckFailedException") {
            return { statusCode: 401, body: "Invalid or used ticket" };
          }
          throw err;
        }

        // Check expiration explicitly because DynamoDB TTL deletion can lag
        if (!oldItem || toMillis(oldItem.expiresAt) <= nowMs) {
          return { statusCode: 401, body: "Expired ticket" };
        }

        const clientType = oldItem.clientType === "simulator" ? "simulator" : "portal";

        await ddb.send(
          new PutCommand({
            TableName: CONN_TABLE,
            Item: {
              connectionId,
              agent: oldItem.agent || "unknown",
              clientType,
              connectedAt: new Date(nowMs).toISOString(),
              ttl: Math.floor(nowMs / 1000) + CONNECTION_TTL_SECONDS,
            },
          })
        );
        return { statusCode: 200, body: "Connected" };
      }

      if (routeKey === "$disconnect") {
        if (!connectionId) {
          return { statusCode: 200, body: "Disconnected" };
        }
        await ddb.send(new DeleteCommand({ TableName: CONN_TABLE, Key: { connectionId } }));
        return { statusCode: 200, body: "Disconnected" };
      }

      // $default (ping keepalive from frontend: {"action":"ping"})
      return { statusCode: 200, body: JSON.stringify({ event: "PONG" }) };
    } catch (err) {
      console.error("WebSocket Handler Error:", err);
      return { statusCode: 500, body: "Internal error" };
    }
  };
}

export const handler = createHandler();
