import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// Phải lớn hơn timeout Lambda (10s) và nhỏ hơn Visibility Timeout của SQS (30s/60s)
const STALE_LOCK_MS = 20_000;
const MAX_CONTENT = 4000;

function extractTelegramContent(msg = {}) {
  if (typeof msg.text === "string" && msg.text.trim()) {
    return { content: msg.text, mediaType: undefined };
  }

  let media = null;
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    media = { mediaType: "photo", label: "Hình ảnh" };
  } else if (msg.document) {
    const fileName = String(msg.document.file_name || "").trim();
    media = {
      mediaType: "document",
      label: fileName ? `Tệp: ${fileName}` : "Tệp đính kèm",
    };
  } else if (msg.voice) {
    media = { mediaType: "voice", label: "Tin nhắn thoại" };
  } else if (msg.audio) {
    media = { mediaType: "audio", label: "Âm thanh" };
  } else if (msg.video || msg.video_note) {
    media = { mediaType: "video", label: "Video" };
  } else if (msg.sticker) {
    const emoji = msg.sticker.emoji ? ` ${msg.sticker.emoji}` : "";
    media = { mediaType: "sticker", label: `Sticker${emoji}` };
  } else if (msg.location) {
    media = { mediaType: "location", label: "Vị trí" };
  } else if (msg.contact) {
    media = { mediaType: "contact", label: "Danh bạ" };
  }

  const caption = typeof msg.caption === "string" ? msg.caption.trim() : "";
  if (media && caption) {
    return { content: `[${media.label}] ${caption}`, mediaType: media.mediaType };
  }
  if (media) {
    return {
      content: `[Khách gửi ${media.label} — chưa hỗ trợ hiển thị media]`,
      mediaType: media.mediaType,
    };
  }
  if (caption) {
    return { content: caption, mediaType: undefined };
  }
  return null;
}

export function normalizeInboundPayload(channel, payload, receivedAt, env = process.env, now = Date.now) {
  if (env.ENABLE_FAULT_INJECTION === "true" && payload?.forceError === true) {
    throw new Error("SIMULATED_DLQ_ERROR: Malformed or corrupted channel payload!");
  }

  const parsedReceived = Date.parse(receivedAt);
  const receivedMs = Number.isFinite(parsedReceived) ? parsedReceived : now();

  if (channel === "telegram") {
    const msg = payload?.message;
    if (!msg || msg.chat?.id === undefined || msg.message_id === undefined) {
      return { ignored: true };
    }
    const extracted = extractTelegramContent(msg);
    if (!extracted) return { ignored: true };

    const chatId = String(msg.chat.id);
    const msgId = String(msg.message_id);
    const senderName =
      `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() ||
      msg.from?.username ||
      `Telegram #${chatId}`;
    const rawDateSec = msg.date !== undefined ? Number(msg.date) : NaN;
    const telegramDateSec = Number.isFinite(rawDateSec) ? rawDateSec : null;
    const createdAtMs =
      telegramDateSec !== null
        ? Math.floor(receivedMs / 1000) === telegramDateSec
          ? receivedMs
          : telegramDateSec * 1000
        : receivedMs;

    return {
      ignored: false,
      // message_id chỉ duy nhất trong từng chat nên phải ghép cùng chat.id
      idempotencyKey: `telegram#${chatId}#${msgId}`,
      conversationId: `CONV#telegram#${chatId}`,
      createdAtMs,
      receivedMs,
      telegramDateSec,
      channel: "telegram",
      channelMessageId: msgId,
      senderId: chatId,
      senderName,
      content: extracted.content.slice(0, MAX_CONTENT),
      mediaType: extracted.mediaType,
    };
  }

  const customerId = String(payload?.customerId || "guest_001");
  const extMsgId = String(payload?.externalMessageId || receivedMs);
  const customerName = payload?.customerName || `Khách ${String(channel || "").toUpperCase()}`;
  const content = String(payload?.text ?? payload?.content ?? "");
  if (!content.trim()) return { ignored: true };

  const sentAt = Number(payload?.sentAtMs);

  return {
    ignored: false,
    idempotencyKey: `${channel}#${customerId}#${extMsgId}`,
    conversationId: `CONV#${channel}#${customerId}`,
    createdAtMs: receivedMs,
    receivedMs,
    telegramDateSec: null,
    channel,
    channelMessageId: extMsgId,
    senderId: customerId,
    senderName: customerName,
    content: content.slice(0, MAX_CONTENT),
    clientSentAtMs: Number.isFinite(sentAt) ? sentAt : undefined,
  };
}

export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const ddb =
    deps.ddbClient ||
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const now = deps.now || Date.now;
  const createWsClient =
    deps.createWsClient ||
    ((endpoint) => new ApiGatewayManagementApiClient({ endpoint }));

  const CONV_TABLE = env.CONVERSATIONS_TABLE || "OmniConversations";
  const MSG_TABLE = env.MESSAGES_TABLE || "OmniMessages";
  const IDEM_TABLE = env.IDEMPOTENCY_TABLE || "OmniIdempotency";
  const CONN_TABLE = env.WS_CONNECTIONS_TABLE || "OmniWSConnections";
  const WS_ENDPOINT = env.WS_ENDPOINT || "";

  let wsClient;

  async function claim(key, nowMs) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: IDEM_TABLE,
          Item: {
            messageKey: key,
            state: "PROCESSING",
            lockedAt: nowMs,
            ttl: Math.floor(nowMs / 1000) + 86400,
          },
          ConditionExpression:
            "attribute_not_exists(messageKey) OR (#s = :processing AND lockedAt < :staleBefore)",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: {
            ":processing": "PROCESSING",
            ":staleBefore": nowMs - STALE_LOCK_MS,
          },
        })
      );
      return "CLAIMED";
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: IDEM_TABLE,
          Key: { messageKey: key },
          ConsistentRead: true,
        })
      );
      if (Item?.state === "DONE") return "DUPLICATE";
      throw new Error(`Message ${key} is being processed by another worker; retry later`);
    }
  }

  async function broadcastToAgents(payload) {
    if (!WS_ENDPOINT) return;
    wsClient ??= createWsClient(WS_ENDPOINT);
    const data = Buffer.from(JSON.stringify(payload));
    const nowSec = Math.floor(now() / 1000);

    const connections = [];
    let lastKey;
    do {
      const res = await ddb.send(
        new ScanCommand({ TableName: CONN_TABLE, ExclusiveStartKey: lastKey })
      );
      // Không phát tin inbound thật xuống các kết nối WebSocket chỉ thuộc Simulator
      for (const item of res.Items || []) {
        if (item.clientType === "simulator") continue;
        // Bỏ qua kết nối đã quá hạn TTL vì DynamoDB có thể xóa chậm
        if (Number.isFinite(item.ttl) && item.ttl <= nowSec) continue;
        connections.push(item);
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
          if (
            err.name === "GoneException" ||
            err.statusCode === 410 ||
            err.$metadata?.httpStatusCode === 410
          ) {
            await ddb.send(new DeleteCommand({ TableName: CONN_TABLE, Key: { connectionId } }));
          } else {
            console.warn(`Broadcast to ${connectionId} failed:`, err.message);
          }
        }
      })
    );
  }

  async function processRecord(record) {
    const envelope = JSON.parse(record.body);
    const norm = normalizeInboundPayload(
      envelope.channel,
      envelope.payload,
      envelope.receivedAt,
      env,
      now
    );
    if (norm.ignored) return;

    const nowMs = now();

    const claimResult = await claim(norm.idempotencyKey, nowMs);
    if (claimResult === "DUPLICATE") {
      console.log(`[IDEMPOTENCY] Duplicate message skipped: ${norm.idempotencyKey}`);
      return;
    }

    let finalMessageItem = null;

    // Đọc lại snapshot mới nhất khi có luồng khác vừa cập nhật hội thoại
    for (let attempt = 0; ; attempt += 1) {
      const { Item: existing } = await ddb.send(
        new GetCommand({
          TableName: CONV_TABLE,
          Key: { conversationId: norm.conversationId },
          ConsistentRead: true,
        })
      );

      let effectiveCreatedAtMs = norm.createdAtMs;
      if (
        norm.channel === "telegram" &&
        norm.telegramDateSec !== null &&
        existing?.lastMessageAt
      ) {
        const existingMs = Date.parse(existing.lastMessageAt);
        if (
          Number.isFinite(existingMs) &&
          Math.floor(existingMs / 1000) === norm.telegramDateSec &&
          norm.receivedMs >= existingMs &&
          effectiveCreatedAtMs <= existingMs
        ) {
          effectiveCreatedAtMs = Math.min(
            (norm.telegramDateSec + 1) * 1000 - 1,
            Math.max(norm.createdAtMs, existingMs + 1)
          );
        }
      }

      const createdAt = new Date(effectiveCreatedAtMs).toISOString();
      const messageItem = {
        conversationId: norm.conversationId,
        messageId: `MSG#${String(effectiveCreatedAtMs).padStart(13, "0")}#${norm.channelMessageId}`,
        channel: norm.channel,
        channelMessageId: norm.channelMessageId,
        direction: "INBOUND",
        senderId: norm.senderId,
        senderName: norm.senderName,
        content: norm.content,
        mediaType: norm.mediaType,
        status: "RECEIVED",
        createdAt,
        clientSentAtMs: norm.clientSentAtMs,
      };
      finalMessageItem = messageItem;

      const newer =
        !existing?.lastMessageAt ||
        createdAt > existing.lastMessageAt ||
        (createdAt === existing.lastMessageAt &&
          messageItem.messageId.localeCompare(existing.lastMessageId || "", "en", { numeric: true }) >
            0);

      const names = { "#st": "status" };
      const values = {
        ":pk": "CONV",
        ":c": norm.channel,
        ":cid": norm.senderId,
        ":cname": norm.senderName,
        ":unassigned": "unassigned",
        ":one": 1,
        ":st":
          !existing?.status || (newer && existing.status === "RESOLVED")
            ? "OPEN"
            : existing.status,
      };

      const conditions = [];
      for (const [field, expression] of [
        ["status", "#st"],
        ["lastMessageAt", "lastMessageAt"],
        ["lastMessageId", "lastMessageId"],
      ]) {
        if (existing?.[field] === undefined) {
          conditions.push(`attribute_not_exists(${expression})`);
        } else {
          const token = `:previous${field}`;
          conditions.push(`${expression} = ${token}`);
          values[token] = existing[field];
        }
      }

      const customerNameExpr = newer
        ? "customerName = :cname"
        : "customerName = if_not_exists(customerName, :cname)";
      const preview = newer
        ? ", lastMessage = :lm, lastMessageAt = :lma, lastMessageId = :lid, lastMessageDirection = :dir, lastInboundAt = :lma"
        : "";
      if (newer) {
        Object.assign(values, {
          ":lm": norm.content,
          ":lma": createdAt,
          ":lid": messageItem.messageId,
          ":dir": "INBOUND",
        });
      }

      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: MSG_TABLE,
                  Item: messageItem,
                  ConditionExpression: "attribute_not_exists(messageId)",
                },
              },
              {
                Update: {
                  TableName: CONV_TABLE,
                  Key: { conversationId: norm.conversationId },
                  UpdateExpression:
                    "SET gsi1pk = :pk, channel = :c, customerId = if_not_exists(customerId, :cid), " +
                    `${customerNameExpr}, #st = :st, ` +
                    "assignedAgent = if_not_exists(assignedAgent, :unassigned)" +
                    preview +
                    " ADD unreadCount :one",
                  ConditionExpression: conditions.join(" AND "),
                  ExpressionAttributeNames: names,
                  ExpressionAttributeValues: values,
                },
              },
            ],
          })
        );
        break;
      } catch (err) {
        if (err.name !== "TransactionCanceledException") throw err;
        const [messageResult, conversationResult] = err.CancellationReasons || [];
        if (messageResult?.Code === "ConditionalCheckFailed") break;
        const retryable =
          [messageResult, conversationResult].some((reason) => reason?.Code === "TransactionConflict") ||
          conversationResult?.Code === "ConditionalCheckFailed";
        if (!retryable || attempt >= 2) throw err;
      }
    }

    await ddb.send(
      new UpdateCommand({
        TableName: IDEM_TABLE,
        Key: { messageKey: norm.idempotencyKey },
        UpdateExpression: "SET #s = :done, doneAt = :now",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: { ":done": "DONE", ":now": new Date(now()).toISOString() },
      })
    );

    try {
      const { Item: conv } = await ddb.send(
        new GetCommand({
          TableName: CONV_TABLE,
          Key: { conversationId: norm.conversationId },
          ConsistentRead: true,
        })
      );
      if (conv) {
        const { gsi1pk, lastMessageId, ...conversation } = conv;
        await broadcastToAgents({ event: "NEW_MESSAGE", conversation, message: finalMessageItem });
      }
    } catch (err) {
      console.warn("Broadcast NEW_MESSAGE failed (ignored):", err.message);
    }
  }

  return async (event = {}) => {
    const batchItemFailures = [];
    for (const record of event.Records || []) {
      try {
        await processRecord(record);
      } catch (err) {
        // Tiền tố cố định dùng cho CloudWatch Metric Filter kích hoạt cảnh báo DLQ
        console.error(`[NORMALIZER_FAILURE] record=${record.messageId} reason=${err.message}`);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

export const handler = createHandler();
