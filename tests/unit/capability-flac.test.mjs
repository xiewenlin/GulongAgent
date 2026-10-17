import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectFlacStream } from "../../server/capability-flac.js";

// All fixtures are generated in memory; no fixture files, native audio tools,
// temporary directories or model/GPU work are needed.
function crc(bytes, bits, polynomial) {
  let value = 0;
  const mask = (1 << bits) - 1;
  for (const byte of bytes) {
    value ^= byte << (bits - 8);
    for (let bit = 0; bit < 8; bit += 1) value = ((value << 1) ^ ((value & (1 << (bits - 1))) ? polynomial : 0)) & mask;
  }
  return value;
}
function flac({ sampleRate = 8000, channels = 1, bitsPerSample = 16, totalSamples = 16000, metadata = null } = {}) {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(16000, 0); info.writeUInt16BE(16000, 2);
  const packed = (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bitsPerSample - 1) << 36n) | BigInt(totalSamples);
  info.writeBigUInt64BE(packed, 10);
  const header = Buffer.from([metadata ? 0 : 128, 0, 0, 34]);
  const frameHeader = Buffer.from([0xff, 0xf8, 0x74, 0x08, 0, 0x3e, 0x7f]);
  const frame = Buffer.concat([frameHeader, Buffer.from([crc(frameHeader, 8, 0x07), 0, 0, 0])]);
  const footer = Buffer.alloc(2); footer.writeUInt16BE(crc(frame, 16, 0x8005));
  return Buffer.concat([Buffer.from("fLaC"), header, info, ...(metadata ? [metadata] : []), frame, footer]);
}
async function* chunks(buffer, size = buffer.length) {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}
const coded = (code) => (error) => error.code === code && error.status >= 400 && /[\u3400-\u9fff]/u.test(error.message);

test("FLAC stream verifies complete actual bytes/SHA and derives duration from native STREAMINFO", async () => {
  const buffer = flac();
  const expected = createHash("sha256").update(buffer).digest("hex");
  assert.deepEqual(await inspectFlacStream(chunks(buffer), { expectedBytes: buffer.length, expectedSha256: expected.toUpperCase() }), {
    bytes: buffer.length, sha256: expected, durationSeconds: 2, sampleRate: 8000, channels: 1, bitsPerSample: 16, totalSamples: 16000, contentType: "audio/flac",
  });
});

test("FLAC header may cross every chunk boundary and Uint8Array chunks remain supported", async () => {
  const buffer = flac();
  const a = await inspectFlacStream(chunks(buffer, 1));
  async function* typed() { for (const byte of buffer) yield Uint8Array.of(byte); }
  assert.deepEqual(await inspectFlacStream(typed()), a);
});

test("FLAC parser skips bounded additional metadata without buffering its payload", async () => {
  const padding = Buffer.concat([Buffer.from([0x81, 0, 0, 64]), Buffer.alloc(64)]);
  const buffer = flac({ metadata: padding });
  assert.equal((await inspectFlacStream(chunks(buffer, 3))).durationSeconds, 2);
});

test("FLAC rejects wrong magic, ID3 prefix and wrong STREAMINFO type or length", async () => {
  const wrong = flac(); wrong.write("RIFF", 0, "ascii");
  await assert.rejects(inspectFlacStream(chunks(wrong)), coded("FLAC_MAGIC_INVALID"));
  await assert.rejects(inspectFlacStream(chunks(Buffer.concat([Buffer.from("ID3"), flac()]))), coded("FLAC_MAGIC_INVALID"));
  for (const [position, value] of [[4, 0x81], [7, 33], [7, 35]]) {
    const buffer = flac(); buffer[position] = value;
    await assert.rejects(inspectFlacStream(chunks(buffer)), coded("FLAC_STREAMINFO_INVALID"));
  }
});

test("FLAC rejects empty/truncated signature, header, STREAMINFO and missing audio frames", async () => {
  const buffer = flac();
  for (const length of [0, 1, 4, 7, 8, 17, 41, 42, 43, 47, 49]) await assert.rejects(inspectFlacStream(chunks(buffer.subarray(0, length))), coded("FLAC_TRUNCATED"));
  const padding = Buffer.concat([Buffer.from([0x81, 0, 0, 64]), Buffer.alloc(10)]);
  await assert.rejects(inspectFlacStream(chunks(flac({ metadata: padding }).subarray(0, 56))), coded("FLAC_TRUNCATED"));
});

test("FLAC rejects unknown duration and invalid binary stream properties", async () => {
  await assert.rejects(inspectFlacStream(chunks(flac({ totalSamples: 0 }))), coded("FLAC_DURATION_UNKNOWN"));
  await assert.rejects(inspectFlacStream(chunks(flac({ sampleRate: 0 }))), coded("FLAC_STREAMINFO_INVALID"));
  await assert.rejects(inspectFlacStream(chunks(flac({ bitsPerSample: 1 }))), coded("FLAC_STREAMINFO_INVALID"));
  const badBlock = flac(); badBlock.writeUInt16BE(1, 8);
  await assert.rejects(inspectFlacStream(chunks(badBlock)), coded("FLAC_STREAMINFO_INVALID"));
});

test("FLAC rejects frames with wrong sync, channel, bit-depth or sample-rate declarations", async () => {
  for (const [position, value] of [[42, 0], [45, 0x18], [45, 0x02], [44, 0x79], [45, 0x09]]) {
    const buffer = flac(); buffer[position] = value;
    await assert.rejects(inspectFlacStream(chunks(buffer)), coded("FLAC_FRAME_INVALID"));
  }
});

test("FLAC verifies entire stream, not only a matching header, against upload byte/hash receipts", async () => {
  const buffer = flac();
  await assert.rejects(inspectFlacStream(chunks(buffer), { expectedBytes: buffer.length + 1 }), coded("FLAC_BYTES_MISMATCH"));
  await assert.rejects(inspectFlacStream(chunks(buffer), { expectedSha256: "0".repeat(64) }), coded("FLAC_HASH_MISMATCH"));
  const expected = createHash("sha256").update(buffer).digest("hex");
  const modified = Buffer.from(buffer); modified[modified.length - 1] ^= 1;
  await assert.rejects(inspectFlacStream(chunks(modified), { expectedSha256: expected }), coded("FLAC_HASH_MISMATCH"));
});

test("FLAC byte limits stop oversized streams and close their generator", async () => {
  const buffer = flac(); let closed = false;
  async function* large() { try { yield buffer; yield Buffer.alloc(100); } finally { closed = true; } }
  await assert.rejects(inspectFlacStream(large(), { maxBytes: 60 }), coded("FLAC_SIZE_LIMIT_EXCEEDED"));
  assert.equal(closed, true);
});

test("FLAC metadata safety budgets reject excessive declarations, duplicates and blocks", async () => {
  const padding = Buffer.concat([Buffer.from([0x81, 0, 0, 64]), Buffer.alloc(64)]);
  await assert.rejects(inspectFlacStream(chunks(flac({ metadata: padding })), { maxHeaderBytes: 64 }), coded("FLAC_HEADER_LIMIT_EXCEEDED"));
  const duplicate = Buffer.concat([Buffer.from([0x80, 0, 0, 34]), Buffer.alloc(34)]);
  await assert.rejects(inspectFlacStream(chunks(flac({ metadata: duplicate }))), coded("FLAC_STREAMINFO_INVALID"));
  const invalid = Buffer.from([0xff, 0, 0, 0]);
  await assert.rejects(inspectFlacStream(chunks(flac({ metadata: invalid }))), coded("FLAC_STREAMINFO_INVALID"));
  const blocks = Buffer.concat(Array.from({ length: 129 }, (_, index) => Buffer.from([index === 128 ? 0x81 : 1, 0, 0, 0])));
  await assert.rejects(inspectFlacStream(chunks(flac({ metadata: blocks }))), coded("FLAC_HEADER_LIMIT_EXCEEDED"));
});

test("FLAC rejects non-async/non-byte inputs and validates expected receipt configuration", async () => {
  await assert.rejects(inspectFlacStream(flac()), coded("FLAC_STREAM_REQUIRED"));
  async function* textStream() { yield "fLaC"; }
  await assert.rejects(inspectFlacStream(textStream()), coded("FLAC_STREAM_INVALID"));
  await assert.rejects(inspectFlacStream(chunks(flac()), { maxBytes: 0 }), coded("FLAC_LIMIT_INVALID"));
  await assert.rejects(inspectFlacStream(chunks(flac()), { maxHeaderBytes: 1 }), coded("FLAC_LIMIT_INVALID"));
  await assert.rejects(inspectFlacStream(chunks(flac()), { expectedBytes: -1 }), coded("FLAC_EXPECTED_BYTES_INVALID"));
  await assert.rejects(inspectFlacStream(chunks(flac()), { expectedSha256: "not-a-sha" }), coded("FLAC_EXPECTED_HASH_INVALID"));
});

test("FLAC network/read failures are retryable Chinese failures without exposing underlying details", async () => {
  async function* unavailable() { yield flac().subarray(0, 10); throw new Error("sensitive upstream socket details"); }
  await assert.rejects(inspectFlacStream(unavailable()), (error) => error.code === "FLAC_STREAM_UNAVAILABLE" && error.status === 503 && !error.message.includes("sensitive"));
});
