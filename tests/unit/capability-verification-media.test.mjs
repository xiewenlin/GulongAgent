import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { createCapabilityVerificationMedia, inspectVerificationBinary } from "../../server/capability-verification-media.js";

// All media and COS/database stand-ins are memory-only. These tests do not
// create fixtures on disk, invoke models, install tools or contact a network.
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const NOW = new Date("2026-10-18T12:00:00.000Z");
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const block = Buffer.alloc(data.length + 12);
  block.writeUInt32BE(data.length, 0); block.write(type, 4, "ascii"); data.copy(block, 8);
  block.writeUInt32BE(crc32(block.subarray(4, data.length + 8)), data.length + 8);
  return block;
}
function png(width = 16, height = 8) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) pixels.set([23, 87, 211], row * (width * 3 + 1) + col * 3 + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}
function jpegSegment(marker, body) {
  const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
}
// A complete grayscale baseline JPEG: one quantized DC-zero 8x8 block, one
// symbol in each Huffman table, and a one-byte entropy stream with end padding.
function jpeg() {
  const table = Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]);
  const huffman = (kind) => Buffer.concat([Buffer.from([kind, 1]), Buffer.alloc(15), Buffer.from([0])]);
  return Buffer.concat([Buffer.from([255, 216]), jpegSegment(219, table),
    jpegSegment(192, Buffer.from([8, 0, 1, 0, 1, 1, 1, 17, 0])),
    jpegSegment(196, huffman(0)), jpegSegment(196, huffman(16)),
    jpegSegment(218, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([63, 255, 217])]);
}
function wav({ silent = false, float = false } = {}) {
  const sampleRate = 8000, frames = 2000, bits = float ? 32 : 16, blockAlign = bits / 8;
  const data = Buffer.alloc(frames * blockAlign);
  for (let index = 0; index < frames; index++) {
    const value = silent ? 0 : Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 0.2;
    if (float) data.writeFloatLE(value, index * blockAlign); else data.writeInt16LE(Math.round(value * 32767), index * blockAlign);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(data.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(bits, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function fixture(kind = "image") {
  let instant = new Date(NOW);
  const records = new Map(), objects = new Map(), copies = [], reads = [], removals = [], uploads = [];
  const hooks = { removeFailures: 0, fetchStatus: 200, fetchBytes: null, corruptHead: {}, mutateSourceAfterCopy: false };
  const binding = { _id: "6ab71678e4859d7255789e08" };
  const challenge = { _id: "gcv_12345678-1234-4234-8234-123456789abc", bindingId: binding._id,
    leaseTokenHash: "b".repeat(64), leaseExpiresAt: new Date(+instant + 15 * 60_000), probeKind: kind };
  const clone = (value) => value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
  const matches = (record, query) => Object.entries(query).every(([key, expected]) => expected && typeof expected === "object" && !(expected instanceof Date)
    ? Object.entries(expected).every(([operator, value]) => operator === "$lte" ? record[key] <= value : operator === "$ne" ? record[key] !== value : false)
    : record[key] === expected);
  const collection = {
    async findOne(query) { return clone([...records.values()].find((record) => matches(record, query)) || null); },
    async insertOne(record) { if (records.has(record._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); records.set(record._id, clone(record)); },
    async updateOne(query, update) { const row = [...records.values()].find((record) => matches(record, query)); if (row) Object.assign(row, clone(update.$set || {})); return { modifiedCount: row ? 1 : 0 }; },
    find(query) { let result = [...records.values()].filter((row) => matches(row, query));
      return { sort() { result.sort((a, b) => +a.cleanupAt - +b.cleanupAt); return this; }, limit(count) { result = result.slice(0, count); return this; }, async toArray() { return clone(result); } }; },
  };
  const service = createCapabilityVerificationMedia({ getCollection: async () => collection, now: () => instant,
    issueUploadUrl: (key, options) => { uploads.push({ key, options }); return `https://cos.example.invalid/put/${uploads.length}`; },
    issueDownloadUrl: (key, options) => { reads.push({ key, options }); return `https://cos.example.invalid/get/${encodeURIComponent(key)}`; },
    inspectObject: async (key) => {
      const object = objects.get(key); if (!object) throw new Error("object absent");
      return { headers: { "content-length": String(object.bytes.length), ...object.headers, etag: object.etag, ...hooks.corruptHead } };
    },
    publishObject: async (source, target, options) => {
      copies.push({ source, target, options }); const object = objects.get(source);
      assert.equal(options.sourceETag, object.etag);
      objects.set(target, { ...object, bytes: Buffer.from(object.bytes) });
      if (hooks.mutateSourceAfterCopy) object.bytes.fill(0);
    },
    fetchObject: async (url, options) => {
      assert.equal(options.redirect, "error");
      const key = decodeURIComponent(url.split("/get/")[1]);
      return new Response(hooks.fetchBytes || objects.get(key)?.bytes || null, { status: hooks.fetchStatus });
    },
    removeObject: async (key) => { removals.push(key); if (hooks.removeFailures-- > 0) throw new Error("temporary COS delete failure"); objects.delete(key); },
  });
  const bytes = kind === "tts" ? wav() : png();
  const output = { role: kind === "image" ? "primary_image" : "primary_audio", filename: kind === "image" ? "probe.png" : "probe.wav",
    content_type: kind === "image" ? "image/png" : "audio/wav", bytes: bytes.length, sha256: digest(bytes) };
  async function issue(extra = {}) {
    const ticket = await service.issueProbeOutputUpload({ binding, challenge, output: { ...output, ...extra } });
    objects.set(ticket.object_key, { bytes: Buffer.from(bytes), headers: { ...ticket.headers }, etag: '"source-etag-v1"' });
    return ticket;
  }
  return { service, binding, challenge, output, bytes, records, objects, copies, reads, removals, uploads, hooks, issue,
    advance(ms) { instant = new Date(+instant + ms); }, get now() { return instant; } };
}

test("多文件原生探测按角色签发独立稳定票据，完整校验JSON/JSONL实物而非内联声明", async () => {
  const f = fixture(); f.challenge.probeKind = "native-test";
  f.challenge.probeOutputRules = [
    { role: "manifest_json", content_types: ["application/json"], max_bytes: 1024, min_count: 1, max_count: 1 },
    { role: "tracks_jsonl", content_types: ["application/x-ndjson"], max_bytes: 1024, min_count: 1, max_count: 1 },
  ];
  const refs = [];
  for (const [role, type, text] of [["manifest_json", "application/json", '{"frames":2}'],
    ["tracks_jsonl", "application/x-ndjson", '{"frame":0}\n{"frame":1}\n']]) {
    const bytes = Buffer.from(text), output = { role, filename: role === "manifest_json" ? "manifest.json" : "objects.jsonl",
      content_type: type, bytes: bytes.length, sha256: digest(bytes) };
    const ticket = await f.service.issueProbeOutputUpload({ binding: f.binding, challenge: f.challenge, output });
    f.objects.set(ticket.object_key, { bytes, headers: ticket.headers, etag: `"etag-${role}"` });
    assert.equal((await f.service.issueProbeOutputUpload({ binding: f.binding, challenge: f.challenge, output })).output_id, ticket.output_id);
    refs.push({ output_id: ticket.output_id });
  }
  assert.notEqual(refs[0].output_id, refs[1].output_id);
  await assert.rejects(() => f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: refs.slice(0, 1) }));
  assert.equal(f.copies.length, 0, "incomplete role sets must fail before any object verification work");
  const verified = await f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: refs });
  assert.deepEqual(verified.find((row) => row.role === "manifest_json").json, { frames: 2 });
  assert.deepEqual(verified.find((row) => row.role === "tracks_jsonl").jsonl, [{ frame: 0 }, { frame: 1 }]);
  assert.equal(f.copies.length, 2);
  await assert.rejects(() => f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: [refs[0], refs[0]] }));
});

test("真实PNG像素尺寸和PCM/浮点WAV采样时长由实物解析，未启用JPEG解码器不接纳JPEG", () => {
  assert.deepEqual(inspectVerificationBinary(png(), "image/png"), { actualContentType: "image/png", width: 16, height: 8 });
  assert.throws(() => inspectVerificationBinary(jpeg(), "image/jpeg"), { code: "VERIFICATION_OUTPUT_INVALID" });
  for (const float of [false, true]) {
    const audio = inspectVerificationBinary(wav({ float }), "audio/wav");
    assert.equal(audio.sampleRate, 8000); assert.equal(audio.channels, 1); assert.equal(audio.durationSeconds, 0.25); assert.equal(audio.nonSilent, true);
  }
  assert.equal(inspectVerificationBinary(wav({ silent: true }), "audio/wav").nonSilent, false);
});

test("媒体MIME不能冒用、截断或以不完整音频采样参数冒充实物", () => {
  for (const [bytes, type] of [[png().subarray(0, 30), "image/png"], [jpeg().subarray(0, -2), "image/jpeg"],
    [png(), "image/jpeg"], [wav().subarray(0, -2), "audio/wav"], [Buffer.alloc(50), "audio/wav"]]) {
    assert.throws(() => inspectVerificationBinary(bytes, type));
  }
  const badRate = wav(); badRate.writeUInt32LE(1, 28);
  assert.throws(() => inspectVerificationBinary(badRate, "audio/wav"));
  const nanAudio = wav({ float: true }); nanAudio.writeFloatLE(Number.NaN, 44);
  assert.throws(() => inspectVerificationBinary(nanAudio, "audio/wav"));
});

test("PNG校验CRC和有界像素实物，拒绝伪IDAT与不合法画布", () => {
  const corruptCrc = png(); corruptCrc[29] ^= 1;
  assert.throws(() => inspectVerificationBinary(corruptCrc, "image/png"), /完整性/);
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const invalidPixels = Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", Buffer.from("not-zlib-pixels")), pngChunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => inspectVerificationBinary(invalidPixels, "image/png"), /解压/);
  for (const size of [0, 4096]) {
    const invalidHeader = Buffer.from(header); invalidHeader.writeUInt32BE(size, 0); invalidHeader.writeUInt32BE(size, 4);
    const invalidImage = Buffer.concat([signature, pngChunk("IHDR", invalidHeader), pngChunk("IDAT", deflateSync(Buffer.from([0]))), pngChunk("IEND", Buffer.alloc(0))]);
    assert.throws(() => inspectVerificationBinary(invalidImage, "image/png"));
  }
});

test("探测输出PUT票据稳定且绑定节点、challenge、短租约和精确清单", async () => {
  const f = fixture(), first = await f.issue(), again = await f.issue();
  assert.equal(first.output_id, again.output_id); assert.equal(first.object_key, again.object_key); assert.equal(f.records.size, 1);
  assert.equal(first.method, "PUT"); assert.equal(first.headers["x-cos-meta-verification-id"], f.challenge._id);
  assert.equal(first.headers["x-cos-meta-binding-id"], f.binding._id);
  assert.ok(new Date(first.expires_at) <= f.challenge.leaseExpiresAt); assert.ok(new Date(first.expires_at) <= +f.now + 600_000);
  assert.ok(first.object_key.startsWith(`capability-verifications/${f.challenge._id}/uploads/`));
  await assert.rejects(f.service.issueProbeOutputUpload({ binding: { _id: "another-binding" }, challenge: f.challenge, output: f.output }), { code: "VERIFICATION_OUTPUT_INVALID" });
  await assert.rejects(f.issue({ filename: "changed.png" }), { code: "VERIFICATION_OUTPUT_CONFLICT" });
  await assert.rejects(f.issue({ content_type: "text/html" }), { code: "VERIFICATION_OUTPUT_INVALID" });
});

test("文件名清洗不能生成cleanup拒绝的路径或连续点", async () => {
  const f = fixture(), ticket = await f.issue({ filename: "../../测试图片.png" });
  assert.equal(ticket.object_key.includes(".."), false); assert.equal(ticket.object_key.includes("\\"), false);
});

test("真实SHA与完整长度在私有条件复制之后校验，迟到PUT无法篡改已测实物", async () => {
  const f = fixture(), ticket = await f.issue(); f.hooks.mutateSourceAfterCopy = true;
  const verified = await f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: [{ output_id: ticket.output_id }] });
  assert.equal(f.copies.length, 1); assert.equal(f.copies[0].source, ticket.object_key); assert.equal(f.copies[0].options.sourceETag, '"source-etag-v1"');
  assert.ok(f.copies[0].target.startsWith(`capability-verifications/${f.challenge._id}/verified/`));
  assert.equal(verified[0].sha256, f.output.sha256); assert.equal(verified[0].bytes, f.bytes.length); assert.equal(verified[0].width, 16); assert.equal(verified[0].height, 8);
  assert.equal(digest(f.objects.get(ticket.object_key).bytes) === f.output.sha256, false);
  assert.equal(digest(f.objects.get(f.copies[0].target).bytes), f.output.sha256);
  assert.equal(f.reads[0].options.expires, 120); assert.equal([...f.records.values()][0].status, "verified");
});

test("其他节点/其他challenge/过期票据不能读取或验证输出", async () => {
  const f = fixture(), ticket = await f.issue();
  for (const input of [{ binding: { _id: "other-binding" }, challenge: f.challenge },
    { binding: f.binding, challenge: { ...f.challenge, _id: "gcv_12345678-1234-4234-8234-123456789abd" } }]) {
    await assert.rejects(f.service.verifyMediaOutputs({ ...input, outputs: [{ output_id: ticket.output_id }] }), { code: "VERIFICATION_OUTPUT_INVALID" });
  }
  assert.equal(f.copies.length, 0); f.advance(601_000);
  await assert.rejects(f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: [{ output_id: ticket.output_id }] }), { code: "VERIFICATION_OUTPUT_INVALID" });
  assert.equal(f.copies.length, 0);
});

test("HEAD声明或实际下载字节/SHA任一不符都不能标记已验证", async () => {
  for (const condition of ["head-binding", "head-bytes", "content-sha", "content-overflow", "fetch-unavailable"]) {
    const f = fixture(), ticket = await f.issue();
    if (condition === "head-binding") f.hooks.corruptHead = { "x-cos-meta-binding-id": "other-binding" };
    if (condition === "head-bytes") f.hooks.corruptHead = { "content-length": String(f.bytes.length + 1) };
    if (condition === "content-sha") f.hooks.fetchBytes = Buffer.alloc(f.bytes.length);
    if (condition === "content-overflow") f.hooks.fetchBytes = Buffer.concat([f.bytes, Buffer.from([0])]);
    if (condition === "fetch-unavailable") f.hooks.fetchStatus = 503;
    await assert.rejects(f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: [{ output_id: ticket.output_id }] }),
      (error) => error.code === "VERIFICATION_OUTPUT_INVALID" || error.code === "VERIFICATION_OUTPUT_UNAVAILABLE");
    assert.notEqual([...f.records.values()][0].status, "verified");
  }
});

test("TTS输出票据只接受WAV，实物返回真实非静音状态和时长", async () => {
  const f = fixture("tts"), ticket = await f.issue();
  await assert.rejects(f.issue({ content_type: "audio/mpeg" }), { code: "VERIFICATION_OUTPUT_INVALID" });
  const [output] = await f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: [{ output_id: ticket.output_id }] });
  assert.equal(output.contentType, "audio/wav"); assert.equal(output.durationSeconds, 0.25); assert.equal(output.nonSilent, true); assert.equal(output.sha256, f.output.sha256);
});

test("24小时探测对象清理失败会退避重试，成功后幂等且不删除越界路径", async () => {
  const f = fixture(), ticket = await f.issue();
  await f.service.verifyMediaOutputs({ binding: f.binding, challenge: f.challenge, outputs: [{ output_id: ticket.output_id }] });
  assert.deepEqual(await f.service.cleanup(), { examined: 0, deleted: 0, retry: 0 });
  f.advance(24 * 3600_000 + 1); f.hooks.removeFailures = 1;
  assert.deepEqual(await f.service.cleanup(), { examined: 1, deleted: 0, retry: 1 });
  assert.equal([...f.records.values()][0].cleanupError, "VERIFICATION_OUTPUT_CLEANUP_RETRY");
  assert.deepEqual(await f.service.cleanup(), { examined: 0, deleted: 0, retry: 0 });
  f.advance(600_001); assert.deepEqual(await f.service.cleanup(), { examined: 1, deleted: 1, retry: 0 });
  assert.equal([...f.records.values()][0].status, "deleted"); assert.equal(f.objects.size, 0);
  assert.deepEqual(await f.service.cleanup(), { examined: 0, deleted: 0, retry: 0 });
  f.records.set("malicious-row", { _id: "malicious-row", challengeId: f.challenge._id, status: "issued", cleanupAt: new Date(0), objectKey: "h3/tasks/some-user/private-video.mp4" });
  const before = f.removals.length;
  assert.deepEqual(await f.service.cleanup(), { examined: 1, deleted: 0, retry: 1 });
  assert.equal(f.removals.length, before);
});
