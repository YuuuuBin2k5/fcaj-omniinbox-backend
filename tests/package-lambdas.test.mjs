import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { buildSingleFileZip, crc32, packageLambdas } from "../scripts/package-lambdas.mjs";

function inspectSingleFileZip(zipBuf) {
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, "Local header signature mismatch");
  const nameLen = zipBuf.readUInt16LE(26);
  const extraLen = zipBuf.readUInt16LE(28);
  const compSize = zipBuf.readUInt32LE(18);
  const uncompSize = zipBuf.readUInt32LE(22);
  const expectedCrc = zipBuf.readUInt32LE(14);
  const entryName = zipBuf.subarray(30, 30 + nameLen).toString("utf8");

  const dataStart = 30 + nameLen + extraLen;
  const compressed = zipBuf.subarray(dataStart, dataStart + compSize);
  const raw = zlib.inflateRawSync(compressed);
  assert.equal(raw.length, uncompSize);
  assert.equal(crc32(raw), expectedCrc);

  const cdOffset = dataStart + compSize;
  assert.equal(zipBuf.readUInt32LE(cdOffset), 0x02014b50, "Central directory signature mismatch");
  const externalAttr = zipBuf.readUInt32LE(cdOffset + 38);
  const eocdOffset = cdOffset + 46 + nameLen;
  assert.equal(zipBuf.readUInt32LE(eocdOffset), 0x06054b50, "EOCD signature mismatch");

  return { entryName, externalAttr, raw };
}

test("buildSingleFileZip creates valid root index.mjs ZIP with POSIX 0644 permissions", () => {
  const source = Buffer.from('export const handler = async () => ({ statusCode: 200 });\n', "utf8");
  const zipBuf = buildSingleFileZip("index.mjs", source);
  const parsed = inspectSingleFileZip(zipBuf);

  assert.equal(parsed.entryName, "index.mjs");
  assert.equal(parsed.externalAttr, (0o100644 << 16) >>> 0);
  assert.deepEqual(parsed.raw, source);
});

test("packageLambdas --core-only builds 5 valid core ZIPs without optional Phase 2 AI", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-zip-test-"));
  try {
    const built = packageLambdas({ coreOnly: true, distDir: tmpDir });
    assert.equal(built.length, 5);
    assert.ok(!fs.existsSync(path.join(tmpDir, "omni-ai-suggester.zip")));

    for (const item of built) {
      const zipBuf = fs.readFileSync(item.zipPath);
      const parsed = inspectSingleFileZip(zipBuf);
      const original = fs.readFileSync(
        path.resolve(import.meta.dirname, `../functions/${item.name}/index.mjs`)
      );
      assert.equal(parsed.entryName, "index.mjs");
      assert.deepEqual(parsed.raw, original);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
