import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHandler } from "../functions/omni-webhook-ingest/index.mjs";

const telegramFixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/telegramUpdate.json"), "utf8")
);
const simulatorFixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/simulatorPayload.json"), "utf8")
);

function makeDeps(overrides = {}) {
  const sqsSent = [];
  let ssmCalls = 0;
  return {
    sqsSent,
    getSsmCalls: () => ssmCalls,
    deps: {
      env: {
        INBOUND_QUEUE_URL: "https://sqs.ap-southeast-1.amazonaws.com/123/omni-inbound-queue",
        WEBHOOK_SECRET_SSM_PATH: "/omniinbox/prod/webhook_secret",
        ALLOW_SIMULATOR: "true",
        ALLOWED_ORIGIN: "https://portal.example.com",
        ...(overrides.env || {}),
      },
      now: () => 1732264205000,
      ssmClient: overrides.ssmClient || {
        async send() {
          ssmCalls += 1;
          return { Parameter: { Value: "super-secret-token" } };
        },
      },
      sqsClient: overrides.sqsClient || {
        async send(cmd) {
          sqsSent.push(cmd.input);
          return { MessageId: "sqs-1" };
        },
      },
    },
  };
}

test("OPTIONS returns 200 with CORS headers", async () => {
  const { deps } = makeDeps({ env: { ALLOWED_ORIGIN: "https://portal.example.com/" } });
  const handler = createHandler(deps);
  const res = await handler({ httpMethod: "OPTIONS" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://portal.example.com");
});

test("unknown channel returns 404", async () => {
  const { deps } = makeDeps();
  const handler = createHandler(deps);
  const res = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "facebook" },
    body: "{}",
  });
  assert.equal(res.statusCode, 404);
});

test("telegram rejects missing or invalid secret token with 403", async () => {
  const { deps, sqsSent } = makeDeps();
  const handler = createHandler(deps);

  const missing = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "telegram" },
    headers: {},
    body: JSON.stringify(telegramFixture),
  });
  assert.equal(missing.statusCode, 403);

  const wrong = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "telegram" },
    headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" },
    body: JSON.stringify(telegramFixture),
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(sqsSent.length, 0);
});

test("telegram valid secret queues message and caches SSM secret across calls", async () => {
  const { deps, sqsSent, getSsmCalls } = makeDeps();
  const handler = createHandler(deps);

  const evt = {
    httpMethod: "POST",
    pathParameters: { channel: "telegram" },
    headers: { "x-telegram-bot-api-secret-token": "super-secret-token" },
    body: JSON.stringify(telegramFixture),
  };

  const res1 = await handler(evt);
  const res2 = await handler(evt);
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(getSsmCalls(), 1);
  assert.equal(sqsSent.length, 2);

  const queued = JSON.parse(sqsSent[0].MessageBody);
  assert.equal(queued.channel, "telegram");
  assert.equal(queued.receivedAt, "2024-11-22T08:30:05.000Z");
  assert.deepEqual(queued.payload, telegramFixture);
});

test("simulator channel obeys ALLOW_SIMULATOR flag and queues fixture when enabled", async () => {
  const disabled = makeDeps({ env: { ALLOW_SIMULATOR: "false" } });
  const hDisabled = createHandler(disabled.deps);
  const resDisabled = await hDisabled({
    httpMethod: "POST",
    pathParameters: { channel: "shopee" },
    body: JSON.stringify(simulatorFixture),
  });
  assert.equal(resDisabled.statusCode, 403);

  const enabled = makeDeps({ env: { ALLOW_SIMULATOR: "true" } });
  const hEnabled = createHandler(enabled.deps);
  const resEnabled = await hEnabled({
    httpMethod: "POST",
    pathParameters: { channel: "shopee" },
    body: JSON.stringify(simulatorFixture),
  });
  assert.equal(resEnabled.statusCode, 200);
  assert.equal(JSON.parse(resEnabled.body).status, "QUEUED");
  assert.equal(enabled.sqsSent.length, 1);
});

test("rejects >64KB payload with 413 and malformed JSON or array with 400", async () => {
  const { deps } = makeDeps();
  const handler = createHandler(deps);

  const huge = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "zalo" },
    body: JSON.stringify({ text: "x".repeat(65 * 1024) }),
  });
  assert.equal(huge.statusCode, 413);

  const badJson = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "zalo" },
    body: "{bad",
  });
  assert.equal(badJson.statusCode, 400);

  const arrBody = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "zalo" },
    body: "[1,2,3]",
  });
  assert.equal(arrBody.statusCode, 400);
});

test("decodes base64Encoded body cleanly", async () => {
  const { deps, sqsSent } = makeDeps();
  const handler = createHandler(deps);
  const res = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "webchat" },
    isBase64Encoded: true,
    body: Buffer.from(JSON.stringify(simulatorFixture), "utf8").toString("base64"),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(sqsSent.length, 1);
});

test("SSM secret cache refreshes after 5m TTL and retries once on secret rotation", async () => {
  let clock = 1732264205000;
  let activeSecret = "secret-v1";
  let ssmCalls = 0;

  const { deps, sqsSent } = makeDeps({
    ssmClient: {
      async send() {
        ssmCalls += 1;
        return { Parameter: { Value: activeSecret } };
      },
    },
  });
  deps.now = () => clock;
  const handler = createHandler(deps);

  const callWith = (token) =>
    handler({
      httpMethod: "POST",
      pathParameters: { channel: "telegram" },
      headers: { "x-telegram-bot-api-secret-token": token },
      body: JSON.stringify(telegramFixture),
    });

  // Initial fetch populates cache
  assert.equal((await callWith("secret-v1")).statusCode, 200);
  assert.equal(ssmCalls, 1);

  // Secret rotates in SSM -> mismatch triggers immediate refresh from SSM without 403 downtime
  activeSecret = "secret-v2";
  assert.equal((await callWith("secret-v2")).statusCode, 200);
  assert.equal(ssmCalls, 2);

  // Within 5m TTL cache is reused
  clock += 60_000;
  assert.equal((await callWith("secret-v2")).statusCode, 200);
  assert.equal(ssmCalls, 2);

  // Past 5m TTL cache expires cleanly
  clock += 5 * 60 * 1000;
  assert.equal((await callWith("secret-v2")).statusCode, 200);
  assert.equal(ssmCalls, 3);
  assert.equal(sqsSent.length, 4);
});

test("REQUIRE_SIMULATOR_AUTH=true rejects anonymous simulator POST with 401 and allows Cognito JWT", async () => {
  const { deps, sqsSent } = makeDeps({ env: { REQUIRE_SIMULATOR_AUTH: "true" } });
  const handler = createHandler(deps);

  const anon = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "shopee" },
    body: JSON.stringify(simulatorFixture),
  });
  assert.equal(anon.statusCode, 401);
  assert.equal(sqsSent.length, 0);

  const authed = await handler({
    httpMethod: "POST",
    pathParameters: { channel: "shopee" },
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify(simulatorFixture),
  });
  assert.equal(authed.statusCode, 200);
  assert.equal(sqsSent.length, 1);
});
