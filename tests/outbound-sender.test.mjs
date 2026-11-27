import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../functions/omni-outbound-sender/index.mjs";

function makeOutboundHarness({
  conv = {
    conversationId: "CONV#telegram#678901234",
    gsi1pk: "CONV",
    channel: "telegram",
    lastMessage: "Khách hỏi",
    lastMessageAt: "2024-11-22T08:30:00.000Z",
    status: "OPEN",
    assignedAgent: "unassigned",
    unreadCount: 2,
  },
  msgToRetry = null,
  failConditionalUnreadOnce = false,
  failClaimCondition = false,
  telegramFetchResult = { ok: true, json: async () => ({ ok: true }) },
} = {}) {
  const puts = [];
  const updates = [];
  const broadcasts = [];
  let ssmCalls = 0;
  let fetchUrl = null;
  let convState = { ...conv };
  let fetchCalls = 0;
  const messages = new Map(msgToRetry ? [[msgToRetry.messageId, { ...msgToRetry }]] : []);
  function conflict() {
    return Object.assign(new Error("Conditional check failed"), { name: "ConditionalCheckFailedException" });
  }

  const ddbClient = {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "GetCommand") {
        if (cmd.input.TableName === "OmniConversations") return { Item: { ...convState } };
        if (cmd.input.TableName === "OmniMessages") return { Item: messages.get(cmd.input.Key.messageId) };
      }
      if (name === "PutCommand") {
        if (messages.has(cmd.input.Item.messageId)) throw conflict();
        messages.set(cmd.input.Item.messageId, cmd.input.Item);
        puts.push(cmd.input.Item);
        return {};
      }
      if (name === "UpdateCommand") {
        updates.push(cmd.input);
        const cond = cmd.input.ConditionExpression || "";
        if (cmd.input.TableName === "OmniMessages") {
          const msg = messages.get(cmd.input.Key.messageId);
          const vals = cmd.input.ExpressionAttributeValues;
          if (msg?.status !== (vals[":failed"] || vals[":sending"])) throw conflict();
          messages.set(msg.messageId, { ...msg, status: vals[":st"] || vals[":sending"] });
          return {};
        }
        if (failConditionalUnreadOnce && cond.includes("lastMessageAt = :prevLma")) {
          const err = new Error("Newer inbound arrived");
          err.name = "ConditionalCheckFailedException";
          // Simulate newer inbound customer message updating convState
          convState = {
            ...convState,
            lastMessage: "Tin nhắn mới xen giữa",
            lastMessageAt: "2024-11-22T08:30:04.000Z",
            unreadCount: 3,
          };
          throw err;
        }
        if (failClaimCondition && cond.includes("assignedAgent = :unassigned")) {
          const err = new Error("Already handed over");
          err.name = "ConditionalCheckFailedException";
          convState = { ...convState, assignedAgent: "agent.lan@omniinbox.local" };
          throw err;
        }
        const vals = cmd.input.ExpressionAttributeValues || {};
        if (vals[":zero"] === 0) convState.unreadCount = 0;
        if (vals[":lm"]) convState.lastMessage = vals[":lm"];
        if (vals[":lma"]) convState.lastMessageAt = vals[":lma"];
        if (vals[":ag"] && cmd.input.TableName === "OmniConversations") convState.assignedAgent = vals[":ag"];
        if (vals[":inProgress"]) convState.status = vals[":inProgress"];
        return { Attributes: { ...convState } };
      }
      if (name === "ScanCommand") return { Items: [{ connectionId: "c1" }] };
      return {};
    },
  };

  const handler = createHandler({
    env: { WS_ENDPOINT: "https://ws.example.com/prod" },
    now: () => 1732264205000,
    randomUUID: () => "abcdef12-0000-0000-0000-000000000000",
    ddbClient,
    ssmClient: {
      async send() {
        ssmCalls += 1;
        return { Parameter: { Value: "secret-bot-token-value" } };
      },
    },
    fetch: async (url) => {
      fetchUrl = url;
      fetchCalls += 1;
      if (typeof telegramFetchResult === "function") return telegramFetchResult();
      return telegramFetchResult;
    },
    createWsClient: () => ({
      async send(cmd) {
        broadcasts.push(JSON.parse(Buffer.from(cmd.input.Data).toString("utf8")));
      },
    }),
  });

  return {
    handler,
    puts,
    updates,
    broadcasts,
    getSsmCalls: () => ssmCalls,
    getFetchUrl: () => fetchUrl,
    getFetchCalls: () => fetchCalls,
    getConvState: () => convState,
  };
}

test("rejects missing JWT claims with 401 and resolves UUID username to email", async () => {
  const { handler, getFetchUrl } = makeOutboundHarness();
  const unauth = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ conversationId: "CONV#telegram#678901234", content: "Hi" }),
  });
  assert.equal(unauth.statusCode, 401);

  const ok = await handler({
    httpMethod: "POST",
    requestContext: {
      authorizer: {
        claims: {
          "cognito:username": "550e8400-e29b-41d4-a716-446655440000",
          email: "agent.minh@omniinbox.local",
        },
      },
    },
    body: JSON.stringify({
      conversationId: "CONV#telegram#678901234",
      channel: "shopee", // spoofed client field must be ignored
      recipientId: "999999", // spoofed recipient must be ignored
      content: "Dạ còn size L ạ",
    }),
  });

  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.ok, true);
  assert.equal(body.message.agentId, "agent.minh@omniinbox.local");
  assert.equal(body.message.channel, "telegram");
  assert.equal(body.message.deliveredVia, "telegram");
  assert.match(getFetchUrl(), /secret-bot-token-value\/sendMessage$/);
});

test("Unknown Telegram result preserves conversation and redacts token", async () => {
  const { handler, updates, broadcasts, getConvState } = makeOutboundHarness({
    telegramFetchResult: () => {
      throw new Error("Network failure https://api.telegram.org/botsecret-bot-token-value/sendMessage");
    },
  });

  const res = await handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({ conversationId: "CONV#telegram#678901234", content: "Xin chào" }),
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.message.status, "UNKNOWN");
  assert.ok(!body.message.errorDetail.includes("secret-bot-token-value"));
  // Conversation must NOT have unreadCount reset or lastMessage overwritten on FAILED
  assert.equal(updates.filter((update) => update.TableName === "OmniConversations").length, 0);
  assert.equal(getConvState().unreadCount, 2);
  assert.equal(getConvState().lastMessage, "Khách hỏi");
  assert.equal(broadcasts[0].conversation.gsi1pk, undefined);
});

test("Amendment #2: newer customer message arriving in-flight keeps unreadCount > 0", async () => {
  const { handler, broadcasts, getConvState } = makeOutboundHarness({
    failConditionalUnreadOnce: true,
  });

  const res = await handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({ conversationId: "CONV#telegram#678901234", content: "Shop kiểm tra ngay ạ" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(getConvState().unreadCount, 3);
  assert.equal(getConvState().lastMessage, "[NV] Shop kiểm tra ngay ạ");
  assert.equal(broadcasts[0].conversation.unreadCount, 3);
});

test("Amendment #3: concurrent A->B handover is never overwritten by A reply and gsi1pk is stripped", async () => {
  const { handler, broadcasts, getConvState } = makeOutboundHarness({
    failClaimCondition: true,
  });

  const res = await handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({ conversationId: "CONV#telegram#678901234", content: "Em gửi ạ" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(getConvState().assignedAgent, "agent.lan@omniinbox.local");
  assert.equal(broadcasts[0].conversation.assignedAgent, "agent.lan@omniinbox.local");
  assert.equal(broadcasts[0].conversation.gsi1pk, undefined);
});

test("Simulator channels set deliveredVia=simulator without external HTTP calls", async () => {
  const { handler, getFetchUrl } = makeOutboundHarness({
    conv: {
      conversationId: "CONV#shopee#shopee_user_889",
      gsi1pk: "CONV",
      channel: "shopee",
      lastMessage: "Áo còn size M không?",
      lastMessageAt: "2024-11-22T08:30:00.000Z",
      status: "IN_PROGRESS",
      assignedAgent: "agent.minh@omniinbox.local",
      unreadCount: 1,
    },
  });

  const res = await handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({ conversationId: "CONV#shopee#shopee_user_889", content: "Dạ còn ạ" }),
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.message.deliveredVia, "simulator");
  assert.equal(getFetchUrl(), null);
});

test("retryOfMessageId retries only OUTBOUND FAILED messages and updates existing record", async () => {
  const { handler, updates } = makeOutboundHarness({
    msgToRetry: {
      conversationId: "CONV#telegram#678901234",
      messageId: "MSG#1732264201000#OUT-1111",
      direction: "OUTBOUND",
      status: "FAILED",
      content: "Nội dung thử lại",
    },
  });

  const res = await handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({
      conversationId: "CONV#telegram#678901234",
      retryOfMessageId: "MSG#1732264201000#OUT-1111",
    }),
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.message.messageId, "MSG#1732264201000#OUT-1111");
  assert.equal(body.message.status, "SENT");
  assert.equal(updates[0].TableName, "OmniMessages");
});

test("two concurrent retries reserve one Telegram delivery", async () => {
  const conversationId = "CONV#telegram#678901234";
  const messageId = "MSG#1732264201000#OUT-retry";
  const { handler, getFetchCalls } = makeOutboundHarness({
    msgToRetry: { conversationId, messageId, direction: "OUTBOUND", status: "FAILED", content: "Test" },
  });
  const event = {
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent@example.com" } } },
    body: JSON.stringify({ conversationId, retryOfMessageId: messageId }),
  };
  const results = await Promise.all([handler(event), handler(event)]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  assert.equal(getFetchCalls(), 1);
});

test("replaying a request ID returns the existing message without a second Telegram call", async () => {
  const { handler, getFetchCalls } = makeOutboundHarness();
  const event = {
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent@example.com" } } },
    body: JSON.stringify({
      conversationId: "CONV#telegram#678901234",
      content: "Test",
      requestId: "1732264205000-abcdef12-0000-0000-0000-000000000000",
    }),
  };
  const first = JSON.parse((await handler(event)).body);
  const second = JSON.parse((await handler(event)).body);
  assert.equal(second.message.messageId, first.message.messageId);
  assert.equal(second.message.status, "SENT");
  assert.equal(getFetchCalls(), 1);
});

test("a confirmed Telegram rejection remains retryable", async () => {
  const { handler } = makeOutboundHarness({
    telegramFetchResult: { json: async () => ({ ok: false, error_code: 400, description: "Rejected" }) },
  });
  const result = await handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent@example.com" } } },
    body: JSON.stringify({ conversationId: "CONV#telegram#678901234", content: "Test" }),
  });
  assert.equal(JSON.parse(result.body).message.status, "FAILED");
});
