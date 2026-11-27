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
  connections = [{ connectionId: "c1", clientType: "portal" }],
  failConditionalUnreadOnce = false,
  failClaimCondition = false,
  telegramFetchResult = { ok: true, json: async () => ({ ok: true }) },
} = {}) {
  const puts = [];
  const updates = [];
  const broadcasts = [];
  const broadcastTargets = [];
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
        if (vals[":dir"]) convState.lastMessageDirection = vals[":dir"];
        if (vals[":ag"] && cmd.input.TableName === "OmniConversations") convState.assignedAgent = vals[":ag"];
        if (vals[":inProgress"]) convState.status = vals[":inProgress"];
        return { Attributes: { ...convState } };
      }
      if (name === "ScanCommand") return { Items: connections };
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
        return { Parameter: { Value: `secret-bot-token-${ssmCalls}` } };
      },
    },
    fetch: async (url) => {
      fetchUrl = url;
      fetchCalls += 1;
      if (typeof telegramFetchResult === "function") return telegramFetchResult(url, fetchCalls);
      return telegramFetchResult;
    },
    createWsClient: () => ({
      async send(cmd) {
        broadcastTargets.push(cmd.input.ConnectionId);
        broadcasts.push(JSON.parse(Buffer.from(cmd.input.Data).toString("utf8")));
      },
    }),
  });

  return {
    handler,
    puts,
    updates,
    broadcasts,
    broadcastTargets,
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
  assert.equal(body.conversation.lastMessageDirection, "OUTBOUND");
  assert.equal(body.conversation.gsi1pk, undefined);
  assert.match(getFetchUrl(), /secret-bot-token-1\/sendMessage$/);
});

test("Unknown Telegram result preserves conversation unread/preview and redacts token", async () => {
  const { handler, updates, broadcasts, getConvState } = makeOutboundHarness({
    telegramFetchResult: () => {
      throw new Error("Network failure https://api.telegram.org/botsecret-bot-token-1/sendMessage");
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
  assert.ok(!body.message.errorDetail.includes("secret-bot-token"));
  // Only the initial unassigned->agent claim may update OmniConversations; unread/preview MUST stay untouched
  const convUpdates = updates.filter((update) => update.TableName === "OmniConversations");
  assert.equal(convUpdates.length, 1);
  assert.equal(convUpdates[0].UpdateExpression, "SET assignedAgent = :ag");
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

test("Ownership Guard: rejects reply with 409 when conversation is already assigned or claimed by another agent", async () => {
  // Case 1: Concurrent claim race lost to agent.lan before calling Telegram
  const raced = makeOutboundHarness({ failClaimCondition: true });
  const rRace = await raced.handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({ conversationId: "CONV#telegram#678901234", content: "Em gửi ạ" }),
  });
  assert.equal(rRace.statusCode, 409);
  const raceBody = JSON.parse(rRace.body);
  assert.equal(raceBody.error, "CONVERSATION_ASSIGNED_TO_OTHER");
  assert.equal(raceBody.conversation.assignedAgent, "agent.lan@omniinbox.local");
  assert.equal(raceBody.conversation.gsi1pk, undefined);
  assert.equal(raced.getFetchCalls(), 0);

  // Case 2: Conversation already assigned to agent.lan
  const foreign = makeOutboundHarness({
    conv: {
      conversationId: "CONV#telegram#678901234",
      gsi1pk: "CONV",
      channel: "telegram",
      lastMessage: "Khách hỏi",
      lastMessageAt: "2024-11-22T08:30:00.000Z",
      status: "IN_PROGRESS",
      assignedAgent: "agent.lan@omniinbox.local",
      unreadCount: 1,
    },
  });
  const rForeign = await foreign.handler({
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({ conversationId: "CONV#telegram#678901234", content: "Em chen ngang" }),
  });
  assert.equal(rForeign.statusCode, 409);
  assert.equal(foreign.getFetchCalls(), 0);
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
    conv: {
      conversationId: "CONV#telegram#678901234",
      gsi1pk: "CONV",
      channel: "telegram",
      lastMessage: "Khách hỏi",
      lastMessageAt: "2024-11-22T08:30:00.000Z",
      status: "OPEN",
      assignedAgent: "agent.minh@omniinbox.local",
      unreadCount: 2,
    },
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
    conv: {
      conversationId,
      gsi1pk: "CONV",
      channel: "telegram",
      lastMessage: "Khách hỏi",
      lastMessageAt: "2024-11-22T08:30:00.000Z",
      status: "OPEN",
      assignedAgent: "agent@example.com",
      unreadCount: 1,
    },
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

test("replaying a request ID returns the existing message and conversation without a second Telegram call", async () => {
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
  assert.ok(second.conversation);
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

test("Telegram WS broadcast skips simulator connections and auto-refreshes SSM token on 401", async () => {
  const { handler, broadcastTargets, getSsmCalls, getFetchCalls } = makeOutboundHarness({
    connections: [
      { connectionId: "conn-portal", clientType: "portal" },
      { connectionId: "conn-sim", clientType: "simulator" },
    ],
    telegramFetchResult: (_url, attempt) => ({
      json: async () =>
        attempt === 2
          ? { ok: false, error_code: 401, description: "Unauthorized" }
          : { ok: true },
    }),
  });

  const evt = {
    httpMethod: "POST",
    requestContext: { authorizer: { claims: { email: "agent.minh@omniinbox.local" } } },
    body: JSON.stringify({
      conversationId: "CONV#telegram#678901234",
      content: "Lần 1",
      requestId: "1732264205000-11111111-1111-1111-1111-111111111111",
    }),
  };
  await handler(evt); // caches token v1, attempt 1 succeeds
  const res2 = await handler({
    ...evt,
    body: JSON.stringify({
      conversationId: "CONV#telegram#678901234",
      content: "Lần 2",
      requestId: "1732264206000-22222222-2222-2222-2222-222222222222",
    }),
  }); // attempt 2 gets 401 from cache -> refreshes token v2 -> attempt 3 succeeds

  assert.equal(JSON.parse(res2.body).ok, true);
  assert.equal(getSsmCalls(), 2);
  assert.equal(getFetchCalls(), 3);
  assert.deepEqual(broadcastTargets, ["conn-portal", "conn-portal"]);
});
