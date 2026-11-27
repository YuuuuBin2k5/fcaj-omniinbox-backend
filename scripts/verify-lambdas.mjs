import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const FUNCTIONS_DIR = path.join(ROOT, "functions");

const EXPECTED_FUNCTIONS = [
  { name: "omni-webhook-ingest", phase: "core" },
  { name: "omni-message-normalizer", phase: "core" },
  { name: "omni-api-handler", phase: "core" },
  { name: "omni-ws-handler", phase: "core" },
  { name: "omni-outbound-sender", phase: "core" },
  { name: "omni-ai-suggester", phase: "optional-phase-2" },
];

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm;
const SECRET_PATTERNS = [
  { name: "Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Retired Claude 3 Haiku ID", re: /anthropic\.claude-3-haiku-20240307-v1:0/i },
];

const errors = [];

for (const fn of EXPECTED_FUNCTIONS) {
  const entry = path.join(FUNCTIONS_DIR, fn.name, "index.mjs");
  if (!fs.existsSync(entry)) {
    errors.push(`[${fn.name}] Missing entrypoint: functions/${fn.name}/index.mjs`);
    continue;
  }

  const syntax = spawnSync(process.execPath, ["--check", entry], { encoding: "utf8" });
  if (syntax.status !== 0) {
    errors.push(`[${fn.name}] Syntax error:\n${syntax.stderr || syntax.stdout}`);
  }

  const src = fs.readFileSync(entry, "utf8");
  for (const match of src.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec.startsWith("node:") && !spec.startsWith("@aws-sdk/")) {
      errors.push(
        `[${fn.name}] Disallowed non-runtime import "${spec}" — must be self-contained ("node:*" or "@aws-sdk/*").`
      );
    }
  }

  for (const rule of SECRET_PATTERNS) {
    if (rule.re.test(src)) {
      errors.push(`[${fn.name}] Matched forbidden pattern (${rule.name}).`);
    }
  }

  if (!/export\s+(?:const|function)\s+createHandler\b/.test(src)) {
    errors.push(`[${fn.name}] Must export createHandler(deps) for unit testability.`);
  }
  if (!/export\s+const\s+handler\b/.test(src)) {
    errors.push(`[${fn.name}] Must export AWS Lambda entrypoint "export const handler".`);
  }
}

if (errors.length > 0) {
  console.error("❌ verify-lambdas failed:\n - " + errors.join("\n - "));
  process.exit(1);
}

console.log(`✅ verify-lambdas OK — ${EXPECTED_FUNCTIONS.length} Lambda functions verified (self-contained ESM, Node 22.x compatible).`);
