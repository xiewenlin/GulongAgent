import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync, deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { normalizeProbeOutputRules, validateProbeOutputDescriptor, validateProbeOutputSet } from "../../server/capability-probe-outputs.js";
import { inspectVerificationBinary } from "../../server/capability-verification-media.js";
import { CAPABILITY_PROBE_FIXTURES } from "../../server/capability-probe-fixtures.js";

// Generated payloads stay in memory; registered production source assets are
// read-only. No models, network calls, archive extraction or disk fixtures.
function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(name, bytes) { const h = Buffer.alloc(8), tail = Buffer.alloc(4); h.writeUInt32BE(bytes.length); h.write(name, 4); tail.writeUInt32BE(crc(Buffer.concat([h.subarray(4), bytes]))); return Buffer.concat([h, bytes, tail]); }
function mask() {
  const h = Buffer.alloc(13); h.writeUInt32BE(16); h.writeUInt32BE(16, 4); h[8] = 8;
  const p = Buffer.alloc(16 * 17); for (let y = 4; y < 12; y++) p.fill(255, y * 17 + 5, y * 17 + 13);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", h), chunk("IDAT", deflateSync(p)), chunk("IEND", Buffer.alloc(0))]);
}
function zip(entries, { method = 0, mode = 0x8000, declaredSize } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, bytes] of entries) {
    const n = Buffer.from(name), packed = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc(bytes), 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(declaredSize ?? bytes.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc(bytes), 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(declaredSize ?? bytes.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, n, packed); centrals.push(central, n); offset += local.length + n.length + packed.length;
  }
  const end = Buffer.alloc(22), central = Buffer.concat(centrals); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
const rule = (role, type, max = 1024) => ({ role, content_types: [type], max_bytes: max, min_count: 1, max_count: 1 });

test("native probe output requirements bind role, MIME, count and total safety budgets", () => {
  const requirements = [rule("manifest_json", "application/json"), rule("tracks_jsonl", "application/x-ndjson"), rule("mask_archive", "application/zip")];
  const challenge = { probeKind: "sam-native", probeOutputRules: requirements };
  assert.deepEqual(normalizeProbeOutputRules(requirements), requirements);
  const outputs = requirements.map((r) => ({ role: r.role, contentType: r.content_types[0], bytes: 100 }));
  assert.equal(validateProbeOutputSet(challenge, outputs), true);
  for (const output of [[], outputs.slice(1), [...outputs, outputs[0]], [{ role: "mask_video", contentType: "video/mp4", bytes: 100 }]]) assert.throws(() => validateProbeOutputSet(challenge, output));
  assert.throws(() => validateProbeOutputDescriptor(challenge, { ...outputs[0], bytes: 1025 }));
  assert.throws(() => validateProbeOutputDescriptor(challenge, { ...outputs[0], contentType: "text/html" }));
  assert.throws(() => normalizeProbeOutputRules([rule("manifest_json", "application/json", 2 * 1024 * 1024)]));
  assert.throws(() => normalizeProbeOutputRules([rule("primary_audio", "audio/flac", 64 * 1024 * 1024), rule("manifest_json", "application/json")]));
  assert.deepEqual(normalizeProbeOutputRules(undefined, "chat"), []);
  assert.equal(normalizeProbeOutputRules(undefined, "image")[0].role, "primary_image");
});

test("structured probe files retain full UTF8 JSON/JSONL and reject broken, blank, malicious or overdeep records", () => {
  const a = { frame: 0, landmarks: [[0.1, 0.2, 0.3, 0.9]] }, b = { frame: 1, landmarks: [] };
  assert.deepEqual(inspectVerificationBinary(Buffer.from(JSON.stringify(a)), "application/json").json, a);
  assert.deepEqual(inspectVerificationBinary(Buffer.from(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`), "application/x-ndjson").jsonl, [a, b]);
  for (const [bytes, type] of [[Buffer.from('{"__proto__":{}}'), "application/json"], [Buffer.from("{broken"), "application/json"],
    [Buffer.from("{}\n\n{}"), "application/x-ndjson"], [Buffer.from([0xff,0xfe]), "application/json"],
    [Buffer.from("[".repeat(30) + "0" + "]".repeat(30)), "application/json"]]) assert.throws(() => inspectVerificationBinary(bytes, type));
});

test("stored and deflated mask archives validate actual PNG pixels without extracting any paths", () => {
  for (const method of [0, 8]) {
    const result = inspectVerificationBinary(zip([["masks/object-00001/frame-000000.png", mask()]], { method }), "application/zip");
    assert.equal(result.archiveEntries[0].name, "masks/object-00001/frame-000000.png");
    assert.equal(result.archiveEntries[0].width, 16); assert.equal(result.archiveEntries[0].height, 16);
    assert.equal(result.archiveEntries[0].foregroundRatio, 0.25);
  }
});

test("archive path traversal, links, duplicate entries, bombs, altered CRC and unknown payloads fail closed", () => {
  for (const archive of [zip([["../escape.png", mask()]]), zip([["/absolute.png", mask()]]), zip([["masks\\escape.png", mask()]]),
    zip([["masks/a.png", mask()]], { mode: 0xa000 }), zip([["masks/a.png", mask()], ["masks/a.png", mask()]]),
    zip([["masks/a.png", mask()]], { declaredSize: 5 * 1024 * 1024 }), zip([["run.exe", mask()]]),
    zip([["masks/a.png", mask()]]).subarray(0, -1)]) assert.throws(() => inspectVerificationBinary(archive, "application/zip"));
  const broken = zip([["masks/a.png", mask()]]); broken[43] ^= 1;
  assert.throws(() => inspectVerificationBinary(broken, "application/zip"));
});

test("production fixture assets match their registered source hashes and retain provenance without implying inference acceptance", () => {
  assert.equal(CAPABILITY_PROBE_FIXTURES.length, 3);
  for (const fixture of CAPABILITY_PROBE_FIXTURES) {
    const bytes = fixture.read();
    assert.equal(bytes.length, fixture.descriptor.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.descriptor.sha256);
  }
  const source = readFileSync(new URL("../../server/probe-fixtures/README.md", import.meta.url), "utf8");
  assert.match(source, /not motion-quality/); assert.match(source, /Copyright \(c\) 2022 OpenAI/);
});
