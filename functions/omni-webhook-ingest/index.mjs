// AWS Lambda: omni-webhook-ingest (Node.js 22.x - arm64 - 128MB - timeout 5s - role: omni-ingest-role)
// Route: POST /webhook/{channel} (Public — Telegram verified via SSM secret header; Simulator gated by ALLOW_SIMULATOR)
import { timingSafeEqual } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ALLOWED_CHANNELS = ["telegram", "shopee", "zalo", "webchat"];
const MAX_BODY_BYTES = 64 * 1024;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Factory for omni-webhook-ingest allowing dependency injection in unit tests.
 */
export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const sqs = deps.sqsClient || new SQSClient({});
  const ssm = deps.ssmClient || new SSMClient({});
  const now = deps.now || Date.now;

  let cachedSecret = null;

  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  const reply = (statusCode, body) => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  });

  async function getWebhookSecret() {
    if (cachedSecret) return cachedSecret;
    const secretPath = env.WEBHOOK_SECRET_SSM_PATH || "/omniinbox/prod/webhook_secret";
    const res = await ssm.send(
      new GetParameterCommand({ Name: secretPath, WithDecryption: true })
    );
    cachedSecret = res.Parameter?.Value || "";
    return cachedSecret;
  }

  return async (event = {}) => {
    const method = (event.httpMethod || event.requestContext?.http?.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return reply(200, {});
    }

    // 1. Whitelist channel
    const channel = (event.pathParameters?.channel || "").toLowerCase();
    if (!ALLOWED_CHANNELS.includes(channel)) {
      return reply(404, { ok: false, error: "Unknown channel" });
    }

    // 2. Source authentication
    if (channel === "telegram") {
      const headers = Object.fromEntries(
        Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
      );
      const provided = headers["x-telegram-bot-api-secret-token"] || "";
      let secret;
      try {
        secret = await getWebhookSecret();
      } catch (err) {
        console.error("Cannot read webhook secret from SSM:", err);
        return reply(500, { ok: false, error: "Server misconfiguration" });
      }
      if (!secret || !safeEqual(provided, secret)) {
        console.warn("Rejected Telegram webhook: invalid secret token");
        return reply(403, { ok: false, error: "Forbidden" });
      }
    } else if (env.ALLOW_SIMULATOR !== "true") {
      return reply(403, { ok: false, error: "Simulator channels are disabled" });
    }

    // 3. Body size & JSON object validation
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";

    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return reply(413, { ok: false, error: "Payload too large" });
    }

    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return reply(400, { ok: false, error: "Invalid JSON" });
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return reply(400, { ok: false, error: "Body must be a JSON object" });
    }

    const queueUrl = env.INBOUND_QUEUE_URL;
    if (!queueUrl) {
      console.error("INBOUND_QUEUE_URL is not configured");
      return reply(500, { ok: false, error: "Queue not configured" });
    }

    // 4. Assign receivedAt once (preserved across SQS retries) and enqueue
    const envelope = {
      channel,
      receivedAt: new Date(now()).toISOString(),
      payload,
    };

    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(envelope),
        })
      );
      return reply(200, { ok: true, status: "QUEUED", channel });
    } catch (err) {
      console.error("Webhook Ingest Error:", err);
      return reply(500, { ok: false, error: "Failed to enqueue message" });
    }
  };
}

export const handler = createHandler();
