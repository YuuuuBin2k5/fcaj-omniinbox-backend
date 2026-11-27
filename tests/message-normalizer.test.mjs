import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHandler, normalizeInboundPayload } from "../functions/omni-message-normalizer/index.mjs";

const telegramFixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/telegramUpdate.json"), "utf8")
);
const simulatorFixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/simulatorPayload.json"), "utf8")
);

function createNormalizerDdbMock({
  idemItem = null,
  convItem = null,
  connections = [{ connectionId: "conn-1" }, { connectionId: "conn-gone" }],
  claimError = null,
  transactError = null,
  concurrentStatus = null,
} = {}) {
  const calls = {
    put: [],
    get: [],
    transact: [],
    update: [],
    scan: [],
    del: [],
  };

  let savedConv = convItem;

  const ddbClient = {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "PutCommand") {
        calls.put.push(cmd.input);
        if (claimError) throw claimError;
        return {};
      }
      if (name === "GetCommand") {
        calls.get.push(cmd.input);
        if (cmd.input.TableName === "OmniIdempotency") return { Item: idemItem };
        if (cmd.input.TableName === "OmniConversations") return { Item: savedConv };
        return {};
      }
      if (name === "TransactWriteCommand") {
        calls.transact.push(cmd.input);
        if (transactError) throw transactError;
        if (concurrentStatus && calls.transact.length === 1) {
          savedConv = { ...savedConv, status: concurrentStatus };
          throw Object.assign(new Error("Concurrent conversation update"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
          });
        }
        const u = cmd.input.TransactItems[1].Update;
        savedConv = {
          conversationId: u.Key.conversationId,
          gsi1pk: "CONV",
          channel: u.ExpressionAttributeValues[":c"],
          customerId: u.ExpressionAttributeValues[":cid"],
          customerName: u.ExpressionAttributeValues[":cname"],
          lastMessage: u.ExpressionAttributeValues[":lm"] ?? savedConv?.lastMessage,
          lastMessageAt: u.ExpressionAttributeValues[":lma"] ?? savedConv?.lastMessageAt,
          status: u.ExpressionAttributeValues[":st"],
          assignedAgent: savedConv?.assignedAgent || "unassigned",
          unreadCount: (savedConv?.unreadCount || 0) + 1,
        };
        return {};
      }
      if (name === "UpdateCommand") {
        calls.update.push(cmd.input);
        return {};
      }
      if (name === "ScanCommand") {
        calls.scan.push(cmd.input);
        return { Items: connections };
      }
      if (name === "DeleteCommand") {
        calls.del.push(cmd.input);
        return {};
      }
      return {};
    },
  };

  return { ddbClient, calls };
}

test("normalizeInboundPayload creates chat.id-scoped idempotencyKey for Telegram and clientSentAtMs for Simulator", () => {
  const tg = normalizeInboundPayload("telegram", telegramFixture, "2024-11-22T08:30:05.000Z");
  assert.equal(tg.idempotencyKey, "telegram#678901234#998877");
  assert.equal(tg.conversationId, "CONV#telegram#678901234");
  assert.equal(tg.senderName, "Văn A Nguyễn");

  const sim = normalizeInboundPayload("shopee", simulatorFixture, "2024-11-22T08:30:05.000Z");
  assert.equal(sim.idempotencyKey, "shopee#shopee_user_889#sim_0001");
  assert.equal(sim.clientSentAtMs, 1732264200000);
});

test("processes Telegram update atomically, strips gsi1pk on WS broadcast, and deletes 410 connection", async () => {
  const { ddbClient, calls } = createNormalizerDdbMock();
  const wsPayloads = [];
  const handler = createHandler({
    env: { WS_ENDPOINT: "https://ws.example.com/prod", ENABLE_FAULT_INJECTION: "false" },
    ddbClient,
    now: () => 1732264205000,
    createWsClient: () => ({
      async send(cmd) {
        if (cmd.input.ConnectionId === "conn-gone") {
          const err = new Error("Gone");
          err.name = "GoneException";
          throw err;
        }
        wsPayloads.push(JSON.parse(Buffer.from(cmd.input.Data).toString("utf8")));
      },
    }),
  });

  const res = await handler({
    Records: [
      {
        messageId: "rec-1",
        body: JSON.stringify({
          channel: "telegram",
          receivedAt: "2024-11-22T08:30:05.000Z",
          payload: telegramFixture,
        }),
      },
    ],
  });

  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(calls.transact.length, 1);
  assert.equal(calls.update[0].ExpressionAttributeValues[":done"], "DONE");
  assert.equal(wsPayloads.length, 1);
  assert.equal(wsPayloads[0].event, "NEW_MESSAGE");
  assert.equal(wsPayloads[0].conversation.gsi1pk, undefined);
  assert.equal(wsPayloads[0].message.messageId, "MSG#1732264200000#998877");
  assert.equal(calls.del.length, 1);
  assert.equal(calls.del[0].Key.connectionId, "conn-gone");
});

test("skips DONE duplicates without failing batch, but retries fresh PROCESSING lock", async () => {
  const condErr = Object.assign(new Error("Cond"), { name: "ConditionalCheckFailedException" });

  // Case 1: DONE duplicate -> skipped cleanly
  const doneMock = createNormalizerDdbMock({
    claimError: condErr,
    idemItem: { state: "DONE" },
  });
  const hDone = createHandler({ ddbClient: doneMock.ddbClient, now: () => 1732264205000 });
  const rDone = await hDone({
    Records: [
      {
        messageId: "rec-dup",
        body: JSON.stringify({
          channel: "shopee",
          receivedAt: "2024-11-22T08:30:05.000Z",
          payload: simulatorFixture,
        }),
      },
    ],
  });
  assert.deepEqual(rDone, { batchItemFailures: [] });
  assert.equal(doneMock.calls.transact.length, 0);

  // Case 2: fresh PROCESSING lock -> fails batch item so SQS retries later
  const procMock = createNormalizerDdbMock({
    claimError: condErr,
    idemItem: { state: "PROCESSING", lockedAt: 1732264200000 },
  });
  const hProc = createHandler({ ddbClient: procMock.ddbClient, now: () => 1732264205000 });
  const rProc = await hProc({
    Records: [
      {
        messageId: "rec-lock",
        body: JSON.stringify({
          channel: "shopee",
          receivedAt: "2024-11-22T08:30:05.000Z",
          payload: simulatorFixture,
        }),
      },
    ],
  });
  assert.deepEqual(rProc, { batchItemFailures: [{ itemIdentifier: "rec-lock" }] });
});

test("reopens RESOLVED conversation to OPEN while keeping assignedAgent", async () => {
  const { ddbClient, calls } = createNormalizerDdbMock({
    convItem: {
      conversationId: "CONV#shopee#shopee_user_889",
      status: "RESOLVED",
      assignedAgent: "agent.minh@omniinbox.local",
      unreadCount: 0,
    },
  });
  const handler = createHandler({ ddbClient, now: () => 1732264205000 });
  await handler({
    Records: [
      {
        messageId: "rec-reopen",
        body: JSON.stringify({
          channel: "shopee",
          receivedAt: "2024-11-22T08:30:05.000Z",
          payload: simulatorFixture,
        }),
      },
    ],
  });

  const convUpdate = calls.transact[0].TransactItems[1].Update;
  assert.equal(convUpdate.ExpressionAttributeValues[":st"], "OPEN");
  assert.match(convUpdate.UpdateExpression, /assignedAgent = if_not_exists\(assignedAgent, :unassigned\)/);
});

test("fault injection is ignored unless ENABLE_FAULT_INJECTION=true", async () => {
  const offMock = createNormalizerDdbMock();
  const hOff = createHandler({
    env: { ENABLE_FAULT_INJECTION: "false" },
    ddbClient: offMock.ddbClient,
    now: () => 1732264205000,
  });
  const rOff = await hOff({
    Records: [
      {
        messageId: "rec-safe",
        body: JSON.stringify({
          channel: "shopee",
          receivedAt: "2024-11-22T08:30:05.000Z",
          payload: { ...simulatorFixture, forceError: true },
        }),
      },
    ],
  });
  assert.deepEqual(rOff, { batchItemFailures: [] });

  const onMock = createNormalizerDdbMock();
  const hOn = createHandler({
    env: { ENABLE_FAULT_INJECTION: "true" },
    ddbClient: onMock.ddbClient,
    now: () => 1732264205000,
  });
  const rOn = await hOn({
    Records: [
      {
        messageId: "rec-dlq",
        body: JSON.stringify({
          channel: "shopee",
          receivedAt: "2024-11-22T08:30:05.000Z",
          payload: { ...simulatorFixture, forceError: true },
        }),
      },
    ],
  });
  assert.deepEqual(rOn, { batchItemFailures: [{ itemIdentifier: "rec-dlq" }] });
});

test("a late message is stored without moving the preview backward", async () => {
  const { ddbClient, calls } = createNormalizerDdbMock({
    convItem: { status: "RESOLVED", lastMessageAt: "2025-01-01T00:00:00.000Z", lastMessage: "Newer" },
  });
  const handler = createHandler({ env: {}, ddbClient });
  const result = await handler({ Records: [{
    messageId: "late",
    body: JSON.stringify({ channel: "telegram", payload: telegramFixture }),
  }] });
  assert.deepEqual(result.batchItemFailures, []);
  const [message, conversation] = calls.transact[0].TransactItems;
  assert.ok(message.Put.Item.messageId);
  assert.doesNotMatch(conversation.Update.UpdateExpression, /lastMessage =/);
  assert.equal(conversation.Update.ExpressionAttributeValues[":st"], "RESOLVED");
  assert.match(conversation.Update.UpdateExpression, /ADD unreadCount/);
});

test("the normalizer retries a transaction that loses a concurrent status update", async () => {
  const { ddbClient, calls } = createNormalizerDdbMock({
    convItem: { status: "OPEN", lastMessageAt: "2023-01-01T00:00:00.000Z" },
    concurrentStatus: "IN_PROGRESS",
  });
  const handler = createHandler({ env: {}, ddbClient });
  const result = await handler({ Records: [{
    messageId: "concurrent",
    body: JSON.stringify({ channel: "telegram", payload: telegramFixture }),
  }] });
  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(calls.transact.length, 2);
  const { Update } = calls.transact[1].TransactItems[1];
  assert.match(Update.ConditionExpression, /#st = :previousstatus/);
  assert.equal(Update.ExpressionAttributeValues[":st"], "IN_PROGRESS");
});

test("extracts Telegram media/caption/sticker instead of silently dropping attachments", () => {
  const photoWithCaption = normalizeInboundPayload(
    "telegram",
    {
      message: {
        message_id: 501,
        date: 1732264300,
        chat: { id: 678901234 },
        from: { first_name: "Minh" },
        photo: [{ file_id: "p1" }],
        caption: "Đã chuyển khoản đơn #123 ạ",
      },
    },
    "2024-11-22T08:31:40.200Z"
  );
  assert.equal(photoWithCaption.ignored, false);
  assert.equal(photoWithCaption.mediaType, "photo");
  assert.equal(photoWithCaption.content, "[Hình ảnh] Đã chuyển khoản đơn #123 ạ");

  const stickerOnly = normalizeInboundPayload(
    "telegram",
    {
      message: {
        message_id: 502,
        date: 1732264301,
        chat: { id: 678901234 },
        sticker: { emoji: "👍" },
      },
    },
    "2024-11-22T08:31:41.100Z"
  );
  assert.equal(stickerOnly.ignored, false);
  assert.equal(stickerOnly.mediaType, "sticker");
  assert.match(stickerOnly.content, /Sticker 👍/);
});

test("same-second Telegram message after agent outbound reply reopens RESOLVED -> OPEN and updates preview", async () => {
  // Outbound reply happened at 1732264205.450Z (within second 1732264205)
  const { ddbClient, calls } = createNormalizerDdbMock({
    convItem: {
      conversationId: "CONV#telegram#678901234",
      status: "RESOLVED",
      assignedAgent: "agent.minh@omniinbox.local",
      lastMessage: "[NV] Cảm ơn anh",
      lastMessageAt: "2024-11-22T08:30:05.450Z",
      lastMessageId: "MSG#1732264205450#OUT-1",
      unreadCount: 0,
    },
  });

  // Telegram reports date=1732264205 (second precision) while ingest receivedAt is .200Z (earlier ms in same sec)
  // or slightly delayed/same sec -> normalizer bumps effectiveCreatedAtMs past .450Z safely inside that second
  const handler = createHandler({
    ddbClient,
    now: () => 1732264205800,
  });

  const sameSecondUpdate = {
    message: {
      message_id: 998900,
      date: 1732264205,
      chat: { id: 678901234 },
      from: { first_name: "Văn A", last_name: "Nguyễn Mới" },
      text: "Khoan shop ơi đổi size XL nhé",
    },
  };

  const res = await handler({
    Records: [
      {
        messageId: "rec-same-sec",
        body: JSON.stringify({
          channel: "telegram",
          receivedAt: "2024-11-22T08:30:05.600Z",
          payload: sameSecondUpdate,
        }),
      },
    ],
  });

  assert.deepEqual(res, { batchItemFailures: [] });
  const [putMsg, updConv] = calls.transact[0].TransactItems;
  assert.equal(updConv.Update.ExpressionAttributeValues[":st"], "OPEN");
  assert.equal(updConv.Update.ExpressionAttributeValues[":dir"], "INBOUND");
  assert.equal(updConv.Update.ExpressionAttributeValues[":cname"], "Văn A Nguyễn Mới");
  assert.match(updConv.Update.UpdateExpression, /customerName = :cname/);
  assert.ok(putMsg.Put.Item.createdAt > "2024-11-22T08:30:05.450Z");
});

test("uses 20s STALE_LOCK_MS and skips simulator-only WS connections during broadcast", async () => {
  const delivered = [];
  const { ddbClient, calls } = createNormalizerDdbMock({
    connections: [
      { connectionId: "conn-portal", clientType: "portal" },
      { connectionId: "conn-sim", clientType: "simulator" },
    ],
  });
  const nowMs = 1732264250000;
  const handler = createHandler({
    env: { WS_ENDPOINT: "https://ws.example.com/prod" },
    ddbClient,
    now: () => nowMs,
    createWsClient: () => ({
      async send(cmd) {
        delivered.push(cmd.input.ConnectionId);
      },
    }),
  });

  await handler({
    Records: [
      {
        messageId: "rec-scope",
        body: JSON.stringify({
          channel: "telegram",
          receivedAt: new Date(nowMs).toISOString(),
          payload: telegramFixture,
        }),
      },
    ],
  });

  assert.equal(calls.put[0].ExpressionAttributeValues[":staleBefore"], nowMs - 20_000);
  assert.deepEqual(delivered, ["conn-portal"]);
});
