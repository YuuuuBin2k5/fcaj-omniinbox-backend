import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEMPLATE_PATH = path.join(ROOT, "infra", "template.yaml");

test("SAM infra/template.yaml has valid structure, 4 tables, SQS/DLQ, 6 IAM roles, 6 CodeUri paths and zero secrets", () => {
  assert.ok(fs.existsSync(TEMPLATE_PATH), "Missing infra/template.yaml");
  const yaml = fs.readFileSync(TEMPLATE_PATH, "utf8");

  assert.ok(!yaml.includes("\t"), "YAML template must not contain tab characters");
  assert.match(yaml, /^AWSTemplateFormatVersion:\s*['"]2010-09-09['"]/m);
  assert.match(yaml, /^Transform:\s*AWS::Serverless-2016-10-31/m);

  for (const table of ["OmniConversations", "OmniMessages", "OmniIdempotency", "OmniWSConnections"]) {
    assert.ok(yaml.includes(`TableName: ${table}`), `Missing DynamoDB table ${table}`);
  }
  assert.ok(yaml.includes("IndexName: gsi-all-by-time"));
  assert.ok(yaml.includes("AttributeName: ttl"));

  for (const queue of ["omni-inbound-queue", "omni-inbound-dlq"]) {
    assert.ok(yaml.includes(`QueueName: ${queue}`), `Missing SQS queue ${queue}`);
  }
  assert.ok(yaml.includes("maxReceiveCount: 5"));

  const fnNames = [
    "omni-webhook-ingest",
    "omni-message-normalizer",
    "omni-api-handler",
    "omni-ws-handler",
    "omni-outbound-sender",
    "omni-ai-suggester",
  ];
  for (const fn of fnNames) {
    assert.ok(yaml.includes(`FunctionName: ${fn}`), `Missing FunctionName ${fn}`);
    assert.ok(yaml.includes(`CodeUri: ../functions/${fn}/`), `Missing CodeUri for ${fn}`);
    assert.ok(
      fs.existsSync(path.join(ROOT, "functions", fn, "index.mjs")),
      `CodeUri directory missing index.mjs for ${fn}`
    );
  }

  for (const role of [
    "omni-ingest-role",
    "omni-normalizer-role",
    "omni-api-role",
    "omni-ws-role",
    "omni-outbound-role",
    "omni-ai-role",
  ]) {
    assert.ok(yaml.includes(`RoleName: ${role}`), `Missing IAM role ${role}`);
  }

  assert.ok(yaml.includes("Runtime: nodejs22.x"));
  assert.ok(yaml.includes("- arm64"));
  assert.ok(yaml.includes("RetentionInDays: 7"));
  assert.ok(yaml.includes('"[NORMALIZER_FAILURE]"'));
  assert.ok(yaml.includes("TreatMissingData: notBreaching"));
  assert.ok(yaml.includes("Condition: IsAiEnabled"));

  // Đảm bảo không nhúng secret hay model đã ngừng hỗ trợ vào template
  assert.doesNotMatch(yaml, /\bAKIA[0-9A-Z]{16}\b/);
  assert.doesNotMatch(yaml, /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/);
  assert.doesNotMatch(yaml, /anthropic\.claude-3-haiku-20240307-v1:0/i);
});
