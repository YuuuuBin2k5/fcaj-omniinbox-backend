import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const FUNCTIONS_DIR = path.join(ROOT, "functions");
const DIST_DIR = path.join(ROOT, "dist");
const CORE_ONLY = process.argv.includes("--core-only");

const FUNCTIONS = [
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

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds a single-file POSIX ZIP archive containing index.mjs at the root with 0644 permissions
 * so AWS Lambda extracts and executes it reliably regardless of host OS (Windows/macOS/Linux).
 */
function buildSingleFileZip(entryName, rawContent) {
  const nameBuf = Buffer.from(entryName, "utf8");
  const compressed = zlib.deflateRawSync(rawContent);
  const crc = crc32(rawContent);
  const uncompSize = rawContent.length;
  const compSize = compressed.length;

  // Fixed DOS timestamp for deterministic reproducible builds (2026-01-01 00:00:00)
  const modTime = 0x0000;
  const modDate = 0x5c21;

  const localHeader = Buffer.alloc(30 + nameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
  localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
  localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
  localHeader.writeUInt16LE(8, 8); // Compression method: 8 (deflate)
  localHeader.writeUInt16LE(modTime, 10);
  localHeader.writeUInt16LE(modDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compSize, 18);
  localHeader.writeUInt32LE(uncompSize, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28); // Extra field length
  nameBuf.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + nameBuf.length);
  centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory header signature
  centralHeader.writeUInt16LE((3 << 8) | 20, 4); // Version made by: Unix (3), 2.0
  centralHeader.writeUInt16LE(20, 6); // Version needed
  centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
  centralHeader.writeUInt16LE(8, 10); // Deflate
  centralHeader.writeUInt16LE(modTime, 12);
  centralHeader.writeUInt16LE(modDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compSize, 20);
  centralHeader.writeUInt32LE(uncompSize, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30); // Extra length
  centralHeader.writeUInt16LE(0, 32); // Comment length
  centralHeader.writeUInt16LE(0, 34); // Disk number start
  centralHeader.writeUInt16LE(0, 36); // Internal attributes
  centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // External POSIX permissions
  centralHeader.writeUInt32LE(0, 42); // Relative offset of local header
  nameBuf.copy(centralHeader, 46);

  const cdOffset = localHeader.length + compressed.length;
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralHeader.length, 12);
  endRecord.writeUInt32LE(cdOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, compressed, centralHeader, endRecord]);
}

fs.mkdirSync(DIST_DIR, { recursive: true });

const targets = FUNCTIONS.filter((f) => !CORE_ONLY || f.core);
for (const fn of targets) {
  const srcPath = path.join(FUNCTIONS_DIR, fn.name, "index.mjs");
  const zipPath = path.join(DIST_DIR, `${fn.name}.zip`);
  const content = fs.readFileSync(srcPath);
  const zipBuf = buildSingleFileZip("index.mjs", content);
  fs.writeFileSync(zipPath, zipBuf);
  const tag = fn.core ? "CORE" : "OPTIONAL PHASE 2 (Day 9 Go/No-Go)";
  console.log(`📦 [${tag}] dist/${fn.name}.zip (${zipBuf.length} bytes)`);
}
