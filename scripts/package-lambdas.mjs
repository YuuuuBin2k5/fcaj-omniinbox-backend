import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const FUNCTIONS_DIR = path.join(ROOT, "functions");
const CORE_ONLY = process.argv.includes("--core-only");

export const FUNCTIONS = [
  { name: "omni-webhook-ingest", core: true },
  { name: "omni-message-normalizer", core: true },
  { name: "omni-api-handler", core: true },
  { name: "omni-ws-handler", core: true },
  { name: "omni-outbound-sender", core: true },
  { name: "omni-ai-suggester", core: false },
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Đóng gói file index.mjs chuẩn POSIX (quyền 0644 ở gốc ZIP) để AWS Lambda chạy ổn định trên mọi HĐH
export function buildSingleFileZip(entryName, rawContent) {
  const nameBuf = Buffer.from(entryName, "utf8");
  const compressed = zlib.deflateRawSync(rawContent);
  const crc = crc32(rawContent);
  const uncompSize = rawContent.length;
  const compSize = compressed.length;

  // Cố định timestamp DOS (2026-01-01) để kết quả build lặp lại giống nhau
  const modTime = 0x0000;
  const modDate = 0x5c21;

  const localHeader = Buffer.alloc(30 + nameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(modTime, 10);
  localHeader.writeUInt16LE(modDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compSize, 18);
  localHeader.writeUInt32LE(uncompSize, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);
  nameBuf.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + nameBuf.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE((3 << 8) | 20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(modTime, 12);
  centralHeader.writeUInt16LE(modDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compSize, 20);
  centralHeader.writeUInt32LE(uncompSize, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // Gắn quyền thực thi POSIX 0644 cho Lambda
  centralHeader.writeUInt32LE(0, 42);
  nameBuf.copy(centralHeader, 46);

  const cdOffset = localHeader.length + compressed.length;
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralHeader.length, 12);
  endRecord.writeUInt32LE(cdOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, compressed, centralHeader, endRecord]);
}

export function packageLambdas({
  coreOnly = CORE_ONLY,
  distDir = path.join(ROOT, "dist", coreOnly ? "core" : "all"),
  functionsDir = FUNCTIONS_DIR,
} = {}) {
  fs.mkdirSync(distDir, { recursive: true });
  const results = [];
  const targets = FUNCTIONS.filter((f) => !coreOnly || f.core);
  for (const fn of targets) {
    const srcPath = path.join(functionsDir, fn.name, "index.mjs");
    const zipPath = path.join(distDir, `${fn.name}.zip`);
    const content = fs.readFileSync(srcPath);
    const zipBuf = buildSingleFileZip("index.mjs", content);
    fs.writeFileSync(zipPath, zipBuf);
    results.push({ name: fn.name, core: fn.core, zipPath, bytes: zipBuf.length });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const item of packageLambdas()) {
    const tag = item.core ? "CORE" : "OPTIONAL PHASE 2 (Day 9 Go/No-Go)";
    console.log(`📦 [${tag}] ${path.relative(ROOT, item.zipPath)} (${item.bytes} bytes)`);
  }
}
