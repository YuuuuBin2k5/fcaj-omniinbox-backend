import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, resolveAgentId } from "../functions/omni-api-handler/index.mjs";

test("resolveAgentId prefers email when Cognito generates a UUID cognito:username", () => {
  assert.equal(
    resolveAgentId({
      "cognito:username": "550e8400-e29b-41d4-a716-446655440000",
      email: "agent.minh@omniinbox.local",
    }),
    "agent.minh@omniinbox.local"
  );
  assert.equal(
    resolveAgentId({
      "cognito:username": "agent.lan@omniinbox.local",
      email: "agent.lan@omniinbox.local",
    }),
    "agent.lan@omniinbox.local"
  );
});

test("GET /conversations queries gsi-all-by-time, strips gsi1pk, and returns nextToken=null at end", async () => {
  const queries = [];
  const handler = createHandler({
    ddbClient: {
      async send(cmd) {
        if (cmd.constructor.name === "QueryCommand") {
          queries.push(cmd.input);
          return {
            Items: [
              {
                conversationId: "CONV#telegram#678901234",
                gsi1pk: "CONV",
                channel: "telegram",
                status: "OPEN",
              },
            ],
            LastEvaluatedKey: undefined,
          };
        }
        return {};
      },
    },
  });

  const res = await handler({
    httpMethod: "GET",
    resource: "/conversations",
    queryStringParameters: { channel: "Telegram", status: "OPEN", limit: "25" },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(queries[0].IndexName, "gsi-all-by-time");
  assert.equal(queries[0].ScanIndexForward, false);
  assert.equal(queries[0].Limit, 25);
  assert.equal(body.nextToken, null);
  assert.equal(body.conversations[0].gsi1pk, undefined);
});

test("GET /conversations/{conversationId}/messages decodes %23 and reverses newest-first order", async () => {
  const queries = [];
  const handler = createHandler({
    ddbClient: {
      async send(cmd) {
        queries.push(cmd.input);
        return {
          Items: [
            { messageId: "MSG#2#b", content: "second" },
            { messageId: "MSG#1#a", content: "first" },
          ],
          LastEvaluatedKey: { conversationId: "CONV#telegram#1", messageId: "MSG#1#a" },
        };
      },
    },
  });

  const res = await handler({
    httpMethod: "GET",
    resource: "/conversations/{conversationId}/messages",
    pathParameters: { conversationId: "CONV%23telegram%231" },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(queries[0].ExpressionAttributeValues[":cid"], "CONV#telegram#1");
  assert.equal(body.conversationId, "CONV#telegram#1");
  assert.deepEqual(
    body.messages.map((m) => m.messageId),
    ["MSG#1#a", "MSG#2#b"]
  );
  assert.ok(typeof body.nextToken === "string" && body.nextToken.length > 0);
});

test("PATCH /conversations/{id} returns 409 with current conversation (without gsi1pk) on conflict", async () => {
  const handler = createHandler({
    ddbClient: {
      async send(cmd) {
        if (cmd.constructor.name === "UpdateCommand") {
          const err = new Error("Condition failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (cmd.constructor.name === "GetCommand") {
          return {
            Item: {
              conversationId: "CONV#shopee#u1",
              gsi1pk: "CONV",
              assignedAgent: "agent.lan@omniinbox.local",
              status: "IN_PROGRESS",
            },
          };
        }
        return {};
      },
    },
  });

  const res = await handler({
    httpMethod: "PATCH",
    resource: "/conversations/{conversationId}",
    pathParameters: { conversationId: "CONV%23shopee%23u1" },
    body: JSON.stringify({
      assignedAgent: "agent.minh@omniinbox.local",
      expectedAssignedAgent: "unassigned",
    }),
  });

  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.conversation.assignedAgent, "agent.lan@omniinbox.local");
  assert.equal(body.conversation.gsi1pk, undefined);
});

test("PATCH validates bad payload and broadcasts CONVERSATION_UPDATED on success", async () => {
  const broadcasts = [];
  const handler = createHandler({
    env: { WS_ENDPOINT: "https://ws.example.com/prod" },
    ddbClient: {
      async send(cmd) {
        if (cmd.constructor.name === "UpdateCommand") {
          return {
            Attributes: {
              conversationId: "CONV#shopee#u1",
              gsi1pk: "CONV",
              status: "RESOLVED",
              assignedAgent: "agent.minh@omniinbox.local",
            },
          };
        }
        if (cmd.constructor.name === "ScanCommand") {
          return { Items: [{ connectionId: "c1" }] };
        }
        return {};
      },
    },
    createWsClient: () => ({
      async send(cmd) {
        broadcasts.push(JSON.parse(Buffer.from(cmd.input.Data).toString("utf8")));
      },
    }),
  });

  const bad = await handler({
    httpMethod: "PATCH",
    resource: "/conversations/{conversationId}",
    pathParameters: { conversationId: "CONV#shopee#u1" },
    body: JSON.stringify({ status: "BOGUS" }),
  });
  assert.equal(bad.statusCode, 400);

  const ok = await handler({
    httpMethod: "PATCH",
    resource: "/conversations/{conversationId}",
    pathParameters: { conversationId: "CONV#shopee#u1" },
    body: JSON.stringify({ status: "RESOLVED" }),
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, "CONVERSATION_UPDATED");
  assert.equal(broadcasts[0].conversation.gsi1pk, undefined);
});

test("POST /ws-ticket writes 60s one-time WSTICKET# with UUID-safe agent claim", async () => {
  const puts = [];
  const handler = createHandler({
    now: () => 1732264200000,
    randomUUID: () => "11111111-2222-3333-4444-555555555555",
    ddbClient: {
      async send(cmd) {
        puts.push(cmd.input);
        return {};
      },
    },
  });

  const res = await handler({
    httpMethod: "POST",
    resource: "/ws-ticket",
    requestContext: {
      authorizer: {
        claims: {
          "cognito:username": "550e8400-e29b-41d4-a716-446655440000",
          email: "agent.minh@omniinbox.local",
        },
      },
    },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ticket, "11111111-2222-3333-4444-555555555555");
  assert.equal(body.expiresAt, 1732264260000);
  assert.equal(puts[0].Item.messageKey, "WSTICKET#11111111-2222-3333-4444-555555555555");
  assert.equal(puts[0].Item.agent, "agent.minh@omniinbox.local");
});
