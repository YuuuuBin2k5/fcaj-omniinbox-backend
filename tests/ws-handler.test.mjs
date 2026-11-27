import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, toMillis } from "../functions/omni-ws-handler/index.mjs";

test("toMillis normalizes both epoch seconds and milliseconds", () => {
  assert.equal(toMillis(1732264260), 1732264260000);
  assert.equal(toMillis(1732264260000), 1732264260000);
  assert.equal(toMillis("invalid"), 0);
});

test("$connect rejects missing, already-used, or expired ticket with 401", async () => {
  const condErr = Object.assign(new Error("Missing"), { name: "ConditionalCheckFailedException" });

  const hUsed = createHandler({
    now: () => 1732264200000,
    ddbClient: {
      async send() {
        throw condErr;
      },
    },
  });

  const missing = await hUsed({ requestContext: { routeKey: "$connect", connectionId: "c1" } });
  assert.equal(missing.statusCode, 401);

  const used = await hUsed({
    requestContext: { routeKey: "$connect", connectionId: "c1" },
    queryStringParameters: { ticket: "used-ticket" },
  });
  assert.equal(used.statusCode, 401);

  const hExpired = createHandler({
    now: () => 1732264265000,
    ddbClient: {
      async send() {
        return { Attributes: { agent: "agent.minh", expiresAt: 1732264260000 } };
      },
    },
  });
  const expired = await hExpired({
    requestContext: { routeKey: "$connect", connectionId: "c1" },
    queryStringParameters: { ticket: "expired-ticket" },
  });
  assert.equal(expired.statusCode, 401);
});

test("$connect stores connection with 3h TTL, $disconnect deletes it, $default replies PONG", async () => {
  const ops = [];
  const handler = createHandler({
    now: () => 1732264200000,
    ddbClient: {
      async send(cmd) {
        ops.push({ type: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "DeleteCommand" && cmd.input.TableName === "OmniIdempotency") {
          return {
            Attributes: {
              agent: "agent.minh@omniinbox.local",
              expiresAt: 1732264260000,
            },
          };
        }
        return {};
      },
    },
  });

  const connect = await handler({
    requestContext: { routeKey: "$connect", connectionId: "conn-abc" },
    queryStringParameters: { ticket: "good-ticket" },
  });
  assert.equal(connect.statusCode, 200);
  assert.equal(ops[0].input.Key.messageKey, "WSTICKET#good-ticket");
  assert.equal(ops[1].input.Item.connectionId, "conn-abc");
  assert.equal(ops[1].input.Item.agent, "agent.minh@omniinbox.local");
  assert.equal(ops[1].input.Item.ttl, Math.floor(1732264200000 / 1000) + 10800);

  const ping = await handler({
    requestContext: { routeKey: "$default", connectionId: "conn-abc" },
    body: '{"action":"ping"}',
  });
  assert.equal(ping.statusCode, 200);
  assert.equal(JSON.parse(ping.body).event, "PONG");

  const disconnect = await handler({
    requestContext: { routeKey: "$disconnect", connectionId: "conn-abc" },
  });
  assert.equal(disconnect.statusCode, 200);
  assert.equal(ops[2].input.Key.connectionId, "conn-abc");
});
