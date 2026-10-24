import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { registerLocalCapabilityResultRoutes, LOCAL_RESULT_CAPABILITIES } from "../../server/capability-local-results.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { LOCAL_RESULT_CHUNK_BYTES, LOCAL_RESULT_STORAGE_BYTES } from "../../server/capability-local-result-chunks.js";
import { verifyLocalResultDeployment } from "../../scripts/verify-local-result-deployment.mjs";

const instant = new Date("2026-10-23T08:00:00Z");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
// Fixtures stay entirely in memory; no installation, temp directory, GPU or network.
const report = () => ({ protocol: "gulong-local-capability-result/v1", report_id: "11111111-1111-4111-8111-111111111111",
  local_request_id: "22222222-2222-4222-8222-222222222222", node_id: "local-node-test-0001", compute_group_id: null,
  capability_id: "gulong_engine.embedding", capability_version: "1.0.0", artifact_sha256: "a".repeat(64), consumer_artifact_sha256: "b".repeat(64), matrix_sha256: "c".repeat(64),
  model: { id: "qwen3-embedding-0.6b-q8-0", dimension: 1024 }, asr_languages: [], case_id: "local-embedding-original", started_at: "2026-10-23T07:55:00Z", completed_at: "2026-10-23T07:56:00Z",
  execution: { origin: "local", transport: "http", endpoint_path: "/v1/embeddings" }, status: "completed",
  parameters: { model: "qwen3-embedding-0.6b-q8-0", dimension: 1024, request: { model: "qwen3-embedding-0.6b-q8-0", input: "original", dimensions: 1024 } },
  inline_result: { response: { model: "qwen3-embedding-0.6b-q8-0", object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1024).fill(0.1) }], usage: { prompt_tokens: 1, total_tokens: 1 } } }, outputs: [] });
function wire(input) {
  const request = { request_id: input.local_request_id, capability_id: input.capability_id, capability_version: input.capability_version, parameters: input.parameters, assets: [] };
  const requestBytes = Buffer.from(JSON.stringify(request));
  const source = { protocol: "h3-direct-capabilities/v1", request_id: input.local_request_id, job_id: "44444444-4444-4444-8444-444444444444", owner_sha256: "e".repeat(64), capability_id: input.capability_id, capability_version: input.capability_version, request_sha256: sha(requestBytes), website_verified: false };
  return { ...input, local_direct_source: source, request_body_base64: requestBytes.toString("base64"), response_body_base64: b64({ protocol: source.protocol, request_id: input.local_request_id, job_id: source.job_id, local_direct_source: source, capability_id: input.capability_id, capability_version: input.capability_version, state: input.status === "completed" ? "succeeded" : "failed", terminal: true, result: input.inline_result, artifacts: input.outputs.map(({ content_base64, filename, upload_id, ...o }) => o) }) };
}
function fixture() {
  const app = new OpenAPIHono(), reports = createCapabilityMemoryCollection(), audits = createCapabilityMemoryCollection();
  const tables = new Map([["capabilityLocalResultReports", reports], ["capabilityLocalResultAudits", audits]]);
  const table = (name) => {
    assert.ok(["capabilityLocalResultReports", "capabilityLocalResultAudits", "capabilityLocalResultStorage", "capabilityLocalResultFiles", "capabilityLocalResultChunks"].includes(name), `forbidden non-result collection ${name}`);
    if (!tables.has(name)) tables.set(name, createCapabilityMemoryCollection());
    return tables.get(name);
  };
  const f = { bound: true, allowed: true, instant, binding: { _id: new ObjectId(), nodeId: "local-node-test-0001", userId: new ObjectId(), status: "active", revokedAt: null } };
  let queue = Promise.resolve();
  registerLocalCapabilityResultRoutes(app, {
    requireBinding: async (c) => f.bound ? { binding: f.binding } : { error: c.json({ code: "BINDING_REQUIRED" }, 401) },
    getCollection: async (name) => table(name),
    transaction: (operation) => {
      const pending = queue.then(async () => {
        const before = new Map(); for (const [name, rows] of tables) before.set(name, await rows.find({}).toArray());
        try { return await operation({}); } catch (error) { for (const [name, rows] of tables) rows.rows.splice(0, rows.rows.length, ...(before.get(name) || [])); throw error; }
      }); queue = pending.catch(() => {}); return pending;
    }, enforceRateLimit: async () => ({ allowed: f.allowed }), now: () => f.instant,
  });
  f.call = async (body = report(), method = "POST") => {
    const response = await app.request("https://example.test/api/v1/capability-verifications/local-results", { method, ...(["GET", "HEAD"].includes(method) ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body.local_direct_source ? body : wire(body)) }) });
    return { status: response.status, text: await response.text(), headers: response.headers };
  };
  f.chunk = async (descriptor, bytes) => {
    const response = await app.request("https://example.test/api/v1/capability-verifications/local-results/chunks", { method: "POST", headers: { "content-type": "application/octet-stream", "X-Gulong-Result-Descriptor": Buffer.from(JSON.stringify(descriptor)).toString("base64url") }, body: bytes });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, state: f, app, reports, audits, table };
}

test("local-only result reporting needs binding before parsing a body, never offers GET tasks", async () => {
  const f = fixture(); f.state.bound = false;
  assert.equal((await f.call("x".repeat(300000))).status, 401);
  assert.equal((await f.call(undefined, "GET")).status, 404);
  assert.equal(f.reports.rows.length, 0);
});

test("intake stores original direct evidence but grants no proof, tasks, upload tickets or admission", async () => {
  const f = fixture(), result = await f.call(); const body = JSON.parse(result.text);
  assert.equal(result.status, 202); assert.equal(body.status, "pending-native-review");
  assert.equal(body.output_integrity_verified, true); assert.equal(body.local_direct_tested, false);
  assert.equal(body.verified, false); assert.equal(body.grants_admission, false); assert.equal(body.task_dispatched, false);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(f.reports.rows[0].evidence.local_request_id, report().local_request_id);
  assert.equal(f.audits.rows.length, 1); assert.doesNotMatch(JSON.stringify(f.audits.rows), /vectors|endpoint_path/);
  assert.doesNotMatch(result.text, /url|lease_token|challenge_id|parameters|vectors/);
});

test("original result repeats are idempotent; report/body or local request relabeling conflicts", async () => {
  const f = fixture();
  const replies = await Promise.all([f.call(), f.call()]); assert.deepEqual(replies.map(r => r.status), [202, 200]);
  assert.equal(JSON.parse(replies[1].text).idempotent, true); assert.equal(f.reports.rows.length, 1); assert.equal(f.audits.rows.length, 1);
  assert.equal((await f.call({ ...report(), case_id: "changed-original-case" })).status, 409);
  assert.equal((await f.call({ ...report(), report_id: "33333333-3333-4333-8333-333333333333" })).status, 409);
  assert.equal((await f.call({ ...report(), report_id: "55555555-5555-4555-8555-555555555555", capability_id: "gulong_engine.music", status: "failed", error_code: "ORIGINAL_FAILURE" })).status, 409);
});

test("cross-node/group, arbitrary cloud routes and self-reported trust cannot enter the intake", async () => {
  const f = fixture();
  assert.equal((await f.call({ ...report(), node_id: "another-node-00001" })).status, 403);
  assert.equal((await f.call({ ...report(), compute_group_id: `gug_${"a".repeat(32)}` })).status, 403);
  assert.equal((await f.call({ ...report(), execution: { origin: "website", transport: "https", endpoint_path: "/api/next" } })).status, 400);
  assert.equal((await f.call({ ...report(), execution: { origin: "lan", transport: "https", endpoint_path: "https://example.test/model" } })).status, 400);
  assert.equal((await f.call({ ...report(), verified: true })).status, 400);
  assert.equal(f.reports.rows.length, 0);
});

test("a supplied public signature or validated result remains unverified, never a native attestation", async () => {
  const f = fixture();
  const result = await f.call({ ...report(), inline_result: { ...report().inline_result, validated: true }, native_receipt: { protocol: "untrusted", key_id: "client-key", algorithm: "RS256", payload_base64: "e30=", signature_base64: "eA==" } });
  assert.equal(result.status, 202); assert.equal(JSON.parse(result.text).grants_admission, false);
  assert.equal(f.reports.rows[0].verified, false);
});

test("failed Music3 evidence remains failed and cannot overwrite historical music acceptance", async () => {
  const f = fixture(), payload = { ...report(), capability_id: "minimax_music_3.generate", status: "failed", error_code: "MUSIC_LYRICS_MISMATCH", inline_result: { full_asr: " *music*" } };
  const result = await f.call(payload);
  assert.equal(result.status, 202); assert.equal(JSON.parse(result.text).submitted_status, "failed");
  assert.equal(f.reports.rows[0].evidence.error_code, "MUSIC_LYRICS_MISMATCH");
});

test("bounded JSON rejects secrets, oversized trees, old/future timestamps and output conflicts", async () => {
  const f = fixture();
  for (const key of ["api_key", "accessToken", "private_key", "binding-token", "X-H3-Client-Device"]) assert.equal((await f.call({ ...report(), parameters: { [key]: "never-save" } })).status, 400);
  assert.equal((await f.call({ ...report(), completed_at: "2030-01-01T00:00:00Z" })).status, 400);
  assert.equal((await f.call({ ...report(), started_at: "2020-01-01T00:00:00Z" })).status, 400);
  assert.equal((await f.call("x".repeat(4 * 1024 * 1024 + 1))).status, 413);
  const file = { artifact_id: "artifact-1", role: "transcript_json", filename: "original.json", content_type: "application/json", bytes: 2, sha256: sha(Buffer.from("{}")), content_base64: b64("{}") };
  assert.equal((await f.call({ ...report(), outputs: [file, file] })).status, 413);
  assert.equal((await f.call({ ...report(), outputs: [{ ...file, url: "https://arbitrary.invalid/file" }] })).status, 400);
  assert.equal(f.reports.rows.length, 0);
});

test("audit failure rolls back intake and private errors are not exposed", async () => {
  const f = fixture(); f.audits.insertOne = async () => { throw new Error("database secret"); };
  const result = await f.call(); assert.equal(result.status, 503); assert.doesNotMatch(result.text, /database secret/);
  assert.equal(f.reports.rows.length, 0);
});

test("original nine plus distinct ACE intake identities cannot dispatch or fetch models", async () => {
  assert.equal(LOCAL_RESULT_CAPABILITIES.length, 10); assert.ok(!LOCAL_RESULT_CAPABILITIES.includes("minimax_h3_shared"));
  assert.ok(LOCAL_RESULT_CAPABILITIES.includes("ace_step_1_5.generate"));
  const source = await readFile(new URL("../../server/capability-local-results.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|\.next\s*\(|\.reserve\s*\(|createPresigned|capabilityAutoVerifications|capabilityVerificationChallenges|capabilityOrders|wallets/);
  const config = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));
  assert.ok(config.rewrites.some(r => r.source === "/api/v1/capability-verifications/:path*"));
});

test("normal software publication never starts inference windows or replenishes budgets", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /run:[\s\S]*activate-fixed-music-retest\.mjs --commit/);
  assert.doesNotMatch(workflow, /name: Start the reviewed fixed-music window/);
});

function png(large = false) {
  const crc = (bytes) => { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (kind, data) => { const header = Buffer.alloc(4); header.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(kind), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([header, body, sum]); };
  const width = large ? 1024 : 1, height = large ? 768 : 1;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = large ? randomBytes((width * 3 + 1) * height) : Buffer.from([0, 20, 30, 40]);
  if (large) for (let i = 0; i < height; i++) pixels[i * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function imageReport(bytes = png()) {
  return { ...report(), capability_id: "qwen_image_2_1.text_to_image", capability_version: "2.1", model: { id: "qwen-image21-uc" },
    parameters: { prompt: "fixture only" }, inline_result: { fixture: true },
    outputs: [{ artifact_id: "original-image-0001", role: "primary_image", filename: "original.png", content_type: "image/png", bytes: bytes.length, sha256: sha(bytes), content_base64: bytes.toString("base64") }] };
}

test("collector reads the complete PNG bytes and saves measured dimensions, never native approval", async () => {
  const f = fixture(), result = await f.call(imageReport());
  assert.equal(result.status, 202); assert.equal(JSON.parse(result.text).status, "pending-native-review");
  const observed = f.reports.rows[0].integrity.outputs[0];
  assert.equal(observed.width, 1); assert.equal(observed.height, 1); assert.equal(observed.sha256, imageReport().outputs[0].sha256);
  assert.equal(f.reports.rows[0].verified, false); assert.equal(f.reports.rows[0].grantsAdmission, false);
});

test("truncated, mis-hashed and valid-hash malformed files never enter result storage", async () => {
  for (const change of [p => { p.outputs[0].bytes++; }, p => { p.outputs[0].sha256 = "0".repeat(64); }, p => { p.outputs[0].content_base64 = png().subarray(0, -1).toString("base64"); }]) {
    const f = fixture(), p = imageReport(); change(p);
    assert.equal((await f.call(p)).status, 400); assert.equal(f.reports.rows.length, 0);
  }
  const f = fixture(); assert.equal((await f.call(imageReport(Buffer.from("not a png")))).status, 400);
});

test("raw request SHA, immutable final response, every artifact and noncanonical base64 are checked", async () => {
  const cases = [
    p => { p.request_body_base64 = b64("{}"); },
    p => { const response = JSON.parse(Buffer.from(p.response_body_base64, "base64")); response.state = "running"; response.terminal = false; p.response_body_base64 = b64(response); },
    p => { const response = JSON.parse(Buffer.from(p.response_body_base64, "base64")); response.artifacts[0].bytes++; p.response_body_base64 = b64(response); },
    p => { const response = JSON.parse(Buffer.from(p.response_body_base64, "base64")); response.artifacts.push(response.artifacts[0]); p.response_body_base64 = b64(response); },
    p => { p.outputs[0].content_base64 += "="; },
    p => { p.local_direct_source.website_verified = true; },
  ];
  for (const change of cases) { const f = fixture(), p = wire(imageReport()); change(p); assert.equal((await f.call(p)).status, 400); assert.equal(f.reports.rows.length, 0); }
});

test("all completed media need their complete role sets while original failed evidence remains reportable", async () => {
  for (const capability_id of LOCAL_RESULT_CAPABILITIES.filter(id => !["gulong_engine.agent_chat", "gulong_engine.embedding"].includes(id))) {
    const f = fixture(); assert.equal((await f.call({ ...report(), capability_id })).status, 400, capability_id);
  }
  const f = fixture();
  assert.equal((await f.call({ ...report(), status: "failed", error_code: "ORIGINAL_NATIVE_FAILED", inline_result: null })).status, 202);
  assert.equal(f.reports.rows[0].evidence.status, "failed");
});

test("full embedding vector and actual model must match the original request", async () => {
  for (const change of [p => p.inline_result.response.data[0].embedding.pop(), p => { p.inline_result.response.model = "different"; }, p => { p.model.dimension = 2; }]) {
    const f = fixture(), p = report(); change(p); assert.equal((await f.call(p)).status, 400); assert.equal(f.reports.rows.length, 0);
  }
});

test("UTF-8, repeated JSON keys and credentials inside encoded original JSON are rejected", async () => {
  const f = fixture();
  assert.equal((await f.call('{"report_id":"first","report_id":"second"}')).status, 400);
  const p = wire(report()); const duplicate = Buffer.from(p.request_body_base64, "base64").toString().replace('"assets":[]', '"assets":[],"assets":[]');
  p.request_body_base64 = b64(duplicate); p.local_direct_source.request_sha256 = sha(Buffer.from(duplicate));
  assert.equal((await f.call(p)).status, 400);
  const q = wire(report()), response = JSON.parse(Buffer.from(q.response_body_base64, "base64")); response.headers = { "X-H3-Client-Session": "never-collect-this" }; q.response_body_base64 = b64(response);
  assert.equal((await f.call(q)).status, 400); assert.equal(f.reports.rows.length, 0);
  const r = wire(report()), invalidUtf8 = Buffer.from([0xff]); r.request_body_base64 = invalidUtf8.toString("base64"); r.local_direct_source.request_sha256 = sha(invalidUtf8);
  assert.equal((await f.call(r)).status, 400);
});

test("oversized original files fail explicitly without truncation, URL fallback or new records", async () => {
  const f = fixture(), p = imageReport(); p.outputs[0].bytes = 2 * 1024 * 1024 + 1;
  assert.equal((await f.call(p)).status, 413); assert.equal(f.reports.rows.length, 0);
  const q = wire(imageReport()); q.outputs[0].url = "http://127.0.0.1/private";
  assert.equal((await f.call(q)).status, 400); assert.equal(f.reports.rows.length, 0);
});

test("original JSON output is parsed fully and duplicate keys are rejected even when its hash matches", async () => {
  const f = fixture(), bytes = Buffer.from('{"language":"en","language":"zh"}');
  const p = { ...report(), capability_id: "whisper.transcribe", outputs: [{ artifact_id: "original-json-0001", role: "transcript_json", filename: "transcript.json", content_type: "application/json", bytes: bytes.length, sha256: sha(bytes), content_base64: bytes.toString("base64") }] };
  assert.equal((await f.call(p)).status, 400); assert.equal(f.reports.rows.length, 0);
});

function chunked(bytes, change = {}) {
  const p = { ...imageReport(bytes), ...change };
  p.outputs = p.outputs.map(({ content_base64, ...o }) => ({ ...o, upload_id: "66666666-6666-4666-8666-666666666666" }));
  const payload = wire(p), file = payload.outputs[0];
  const part = (index) => {
    const body = bytes.subarray(index * LOCAL_RESULT_CHUNK_BYTES, Math.min(bytes.length, (index + 1) * LOCAL_RESULT_CHUNK_BYTES));
    return { body, descriptor: { upload_id: file.upload_id, report_id: payload.report_id, local_request_id: payload.local_request_id, job_id: payload.local_direct_source.job_id,
      owner_sha256: payload.local_direct_source.owner_sha256, request_sha256: payload.local_direct_source.request_sha256,
      capability_id: payload.capability_id, capability_version: payload.capability_version, artifact_id: file.artifact_id, filename: file.filename, role: file.role, content_type: file.content_type,
      file_bytes: file.bytes, file_sha256: file.sha256, chunk_index: index, chunk_offset: index * LOCAL_RESULT_CHUNK_BYTES, chunk_bytes: body.length, chunk_sha256: sha(body) } };
  };
  return { payload, part, count: Math.ceil(bytes.length / LOCAL_RESULT_CHUNK_BYTES) };
}
async function upload(f, parts) { for (let i = parts.count - 1; i >= 0; i--) { const p = parts.part(i); assert.equal((await f.chunk(p.descriptor, p.body)).status, 201); } }

test("large original output crosses 2MiB in write-only chunks, reassembles fully and remains unreviewed", async () => {
  const f = fixture(), bytes = png(true), parts = chunked(bytes); assert.ok(bytes.length > 2 * 1024 * 1024);
  await upload(f, parts);
  const result = await f.call(parts.payload); assert.equal(result.status, 202); assert.equal(JSON.parse(result.text).verified, false);
  assert.equal(f.reports.rows[0].integrity.outputs[0].sha256, sha(bytes)); assert.equal(f.reports.rows[0].integrity.outputs[0].width, 1024);
  assert.equal(f.table("capabilityLocalResultFiles").rows[0].status, "sealed");
  assert.equal(f.table("capabilityLocalResultStorage").rows.find(r => r._id === String(f.binding._id)).bytes, bytes.length);
  assert.equal((await f.call(parts.payload)).status, 200); assert.equal(f.audits.rows.length, 1);
  assert.equal((await f.app.request("https://example.test/api/v1/capability-verifications/local-results/chunks")).status, 404);
});

test("concurrent identical chunks store once and changed bytes or fixed file identity cannot overwrite", async () => {
  const f = fixture(), parts = chunked(png()), p = parts.part(0);
  assert.deepEqual((await Promise.all([f.chunk(p.descriptor, p.body), f.chunk(p.descriptor, p.body)])).map(r => r.status), [201, 200]);
  assert.equal(f.table("capabilityLocalResultChunks").rows.length, 1);
  const changed = Buffer.from(p.body); changed[0] ^= 1;
  assert.equal((await f.chunk({ ...p.descriptor, chunk_sha256: sha(changed) }, changed)).status, 409);
  assert.equal((await f.chunk({ ...p.descriptor, job_id: "77777777-7777-4777-8777-777777777777" }, p.body)).status, 409);
  assert.equal(f.table("capabilityLocalResultStorage").rows[0].bytes, p.body.length);
});

test("partial or wrong-offset/hash chunks persist nothing; missing chunks never become a full output", async () => {
  const f = fixture(), parts = chunked(png(true)), p = parts.part(0);
  assert.equal((await f.chunk(p.descriptor, p.body.subarray(0, -1))).status, 400);
  assert.equal((await f.chunk({ ...p.descriptor, chunk_offset: 1 }, p.body)).status, 400);
  assert.equal((await f.chunk({ ...p.descriptor, chunk_sha256: "0".repeat(64) }, p.body)).status, 400);
  assert.equal(f.table("capabilityLocalResultChunks").rows.length, 0);
  assert.equal((await f.chunk(p.descriptor, p.body)).status, 201);
  assert.equal((await f.call(parts.payload)).status, 409); assert.equal(f.reports.rows.length, 0);
});

test("chunked results bind actual account/node/group, original report/request/job and native owner", async () => {
  const f = fixture(), parts = chunked(png()); await upload(f, parts);
  const changedReport = { ...parts.payload, report_id: "77777777-7777-4777-8777-777777777777" };
  assert.equal((await f.call(changedReport)).status, 403);
  f.binding.computeGroupId = `gug_${"a".repeat(32)}`;
  assert.equal((await f.call({ ...parts.payload, compute_group_id: f.binding.computeGroupId })).status, 403);
  f.binding.computeGroupId = null; f.binding._id = new ObjectId();
  assert.equal((await f.call(parts.payload)).status, 403); assert.equal(f.reports.rows.length, 0);
});

test("all chunks present with a wrong whole-file SHA fail without erasing original evidence", async () => {
  const f = fixture(), parts = chunked(png()), p = parts.part(0); p.descriptor.file_sha256 = "0".repeat(64);
  assert.equal((await f.chunk(p.descriptor, p.body)).status, 201);
  parts.payload.outputs[0].sha256 = "0".repeat(64);
  const response = JSON.parse(Buffer.from(parts.payload.response_body_base64, "base64")); response.artifacts[0].sha256 = "0".repeat(64); parts.payload.response_body_base64 = b64(response);
  assert.equal((await f.call(parts.payload)).status, 400);
  assert.equal(f.table("capabilityLocalResultChunks").rows.length, 1); assert.equal(f.reports.rows.length, 0);
});

test("fixed evidence storage budget cannot be reset by another upload UUID or report", async () => {
  const f = fixture(), parts = chunked(png()), p = parts.part(0);
  f.table("capabilityLocalResultStorage").rows.push({ _id: String(f.binding._id), bytes: LOCAL_RESULT_STORAGE_BYTES, files: 1, reports: 0, version: 1 });
  assert.equal((await f.chunk(p.descriptor, p.body)).status, 507);
  assert.equal((await f.chunk({ ...p.descriptor, upload_id: "77777777-7777-4777-8777-777777777777" }, p.body)).status, 507);
  assert.equal(f.table("capabilityLocalResultFiles").rows.length, 0); assert.equal(f.table("capabilityLocalResultChunks").rows.length, 0);
});

test("result audit failure preserves uploaded chunks and rolls back sealing; original retry succeeds once", async () => {
  const f = fixture(), parts = chunked(png()); await upload(f, parts);
  const insert = f.audits.insertOne; f.audits.insertOne = async () => { throw new Error("private audit failure"); };
  assert.equal((await f.call(parts.payload)).status, 503); assert.equal(f.reports.rows.length, 0);
  assert.equal(f.table("capabilityLocalResultFiles").rows[0].status, "receiving"); assert.equal(f.table("capabilityLocalResultChunks").rows.length, 1);
  f.audits.insertOne = insert;
  assert.equal((await f.call(parts.payload)).status, 202); assert.equal(f.table("capabilityLocalResultFiles").rows[0].status, "sealed");
});

test("unauthenticated chunk streams and a busy result-only integrity lock never consume or grant work", async () => {
  const f = fixture(), parts = chunked(png()), p = parts.part(0); f.state.bound = false;
  assert.equal((await f.chunk(p.descriptor, p.body)).status, 401); assert.equal(f.table("capabilityLocalResultFiles").rows.length, 0);
  f.state.bound = true;
  f.table("capabilityLocalResultStorage").rows.push({ _id: "global-output-integrity-lock", until: new Date(+instant + 60000), version: 1, token: "another-integrity-check" });
  assert.equal((await f.call(imageReport())).status, 409); assert.equal(f.reports.rows.length, 0);
  assert.equal(f.table("capabilityLocalResultStorage").rows[0].token, "another-integrity-check");
});

test("different original capability reports stay independent and never share an uploaded file", async () => {
  const f = fixture(), first = chunked(png()); await upload(f, first); assert.equal((await f.call(first.payload)).status, 202);
  const second = chunked(png(), { capability_id: "qwen_image_2_1.multi_image_edit", report_id: "77777777-7777-4777-8777-777777777777", local_request_id: "88888888-8888-4888-8888-888888888888" });
  second.payload.outputs[0].upload_id = "99999999-9999-4999-8999-999999999999";
  second.payload.local_direct_source.job_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const response = JSON.parse(Buffer.from(second.payload.response_body_base64, "base64")); response.job_id = second.payload.local_direct_source.job_id; response.local_direct_source = second.payload.local_direct_source; second.payload.response_body_base64 = b64(response);
  await upload(f, second); assert.equal((await f.call(second.payload)).status, 202);
  assert.equal(f.reports.rows.length, 2); assert.equal(f.table("capabilityLocalResultFiles").rows.length, 2);
  assert.equal(f.table("capabilityLocalResultStorage").rows.find(r => r._id === String(f.binding._id)).reports, 2);
});

test("corrupt evidence counters or locks fail closed rather than recreating a fresh budget", async () => {
  const f = fixture(), p = chunked(png()).part(0);
  f.table("capabilityLocalResultStorage").rows.push({ _id: String(f.binding._id), bytes: -1, files: 0, reports: 0, version: 1 });
  assert.equal((await f.chunk(p.descriptor, p.body)).status, 503); assert.equal(f.table("capabilityLocalResultFiles").rows.length, 0);
  assert.equal(f.table("capabilityLocalResultStorage").rows[0].bytes, -1);
  const g = fixture(); g.table("capabilityLocalResultStorage").rows.push({ _id: "global-output-integrity-lock", until: "unknown", version: 1 });
  assert.equal((await g.call(imageReport())).status, 503); assert.equal(g.reports.rows.length, 0);
  const h = fixture(); h.table("capabilityLocalResultStorage").rows.push({ _id: String(h.binding._id), bytes: 0, files: 0, reports: 64, version: 1 });
  assert.equal((await h.chunk(p.descriptor, p.body)).status, 507); assert.equal((await h.call()).status, 507);
});

test("stored-chunk corruption cannot be hidden by the declared whole-file manifest", async () => {
  const f = fixture(), p = chunked(png()); await upload(f, p);
  f.table("capabilityLocalResultChunks").rows[0].contentBase64 = Buffer.from("corrupted").toString("base64");
  assert.equal((await f.call(p.payload)).status, 409); assert.equal(f.reports.rows.length, 0);
  assert.equal(f.table("capabilityLocalResultFiles").rows[0].status, "receiving");
});

test("an acknowledged original report remains recoverable after the initial seven-day intake window", async () => {
  const f = fixture(); assert.equal((await f.call()).status, 202);
  f.state.instant = new Date(+instant + 8 * 86400000);
  assert.equal((await f.call()).status, 200);
  assert.equal((await f.call({ ...report(), report_id: "33333333-3333-4333-8333-333333333333" })).status, 400);
  assert.equal(f.reports.rows.length, 1);
});

test("Whisper preserves both original transcript files and native provenance without granting trust", async () => {
  const f = fixture(), original = report();
  const file = (role, content_type, text) => { const bytes = Buffer.from(text); return { artifact_id: `original-${role}`, role, filename: role === "transcript_json" ? "transcript.json" : "transcript.txt", content_type, bytes: bytes.length, sha256: sha(bytes), content_base64: bytes.toString("base64") }; };
  const p = wire({ ...original, capability_id: "whisper.transcribe", parameters: { language: "zh" },
    inline_result: { native_job: { job_id: "native-original", model: "whisper-large-v3" } },
    outputs: [file("transcript_json", "application/json", '{"text":"完整原转录"}'), file("transcript_text", "text/plain", "完整原转录\n")] });
  assert.equal((await f.call(p)).status, 202);
  assert.deepEqual(f.reports.rows[0].evidence.inline_result, p.inline_result);
  assert.equal(f.reports.rows[0].evidence.outputs.length, 2);
  const omitted = structuredClone(p); omitted.outputs.pop();
  assert.equal((await fixture().call(omitted)).status, 400);
  const invalid = structuredClone(p); const bytes = Buffer.from([0xff]); Object.assign(invalid.outputs[1], { bytes: 1, sha256: sha(bytes), content_base64: bytes.toString("base64") });
  const response = JSON.parse(Buffer.from(invalid.response_body_base64, "base64")); Object.assign(response.artifacts[1], { bytes: 1, sha256: sha(bytes) }); invalid.response_body_base64 = b64(response);
  assert.equal((await fixture().call(invalid)).status, 400);
});

// Container-only, in-memory bytes. This is not synthesized audio, ASR or a
// native-model quality fixture; the collector must never claim otherwise.
function flacReceiptBytes() {
  const info = Buffer.alloc(34); info.writeUInt16BE(16000, 0); info.writeUInt16BE(16000, 2);
  info.writeBigUInt64BE((48000n << 44n) | (1n << 41n) | (15n << 36n) | 576000n, 10);
  return Buffer.concat([Buffer.from("fLaC"), Buffer.from([128, 0, 0, 34]), info, Buffer.from([0xff, 0xf8, 0x70, 0x18, 0, 0, 0, 0, 0, 0])]);
}
function musicReport(capability_id = "ace_step_1_5.generate") {
  const bytes = flacReceiptBytes();
  return { ...report(), capability_id, capability_version: capability_id === "ace_step_1_5.generate" ? "1.5-turbo-dit-only" : "2.0.0",
    model: { id: "ace-step15-turbo", model: "ACE-Step-1.5-Turbo-DiT-Only" }, asr_languages: ["zh"],
    parameters: { model: "ace-step15-turbo", lyrics: "原始完整歌词0904", duration_seconds: 12 },
    inline_result: { actual_model: { id: "ace-step15-turbo" }, lyric_verification: { transcript: "只唱了开头", verified: false, code: "MUSIC_LYRICS_MISMATCH" } },
    outputs: [{ artifact_id: "original-full-audio", role: "primary_audio", filename: "original.flac", content_type: "audio/flac", bytes: bytes.length, sha256: sha(bytes), content_base64: bytes.toString("base64") }] };
}
test("native ACE and generic v2 preserve complete audio and failed ASR semantics without becoming Music3 passes", async () => {
  for (const capability of ["ace_step_1_5.generate", "gulong_engine.music"]) {
    const f = fixture(), p = musicReport(capability), result = await f.call(p);
    assert.equal(result.status, 202, result.text);
    assert.equal(JSON.parse(result.text).verified, false); assert.equal(JSON.parse(result.text).grants_admission, false);
    assert.equal(f.reports.rows[0].evidence.capability_id, capability);
    assert.deepEqual(f.reports.rows[0].evidence.inline_result, p.inline_result);
    assert.equal(f.reports.rows[0].integrity.outputs[0].sampleRate, 48000);
  }
  assert.equal((await fixture().call({ ...musicReport(), capability_version: "3.0" })).status, 400);
});

test("revoked bindings and result intake limits fail closed with no evidence or work writes", async () => {
  for (const change of [f => f.binding.status = "revoked", f => f.binding.revokedAt = instant, f => f.state.allowed = false]) {
    const f = fixture(); change(f); const r = await f.call(); assert.ok([401, 429].includes(r.status));
    assert.equal(f.reports.rows.length, 0); assert.equal(f.audits.rows.length, 0);
    const p = chunked(png()).part(0); assert.ok([401, 429].includes((await f.chunk(p.descriptor, p.body)).status));
    assert.equal(f.table("capabilityLocalResultChunks").rows.length, 0);
  }
});

test("deployment contract verifier uses only public schema and anonymous authentication rejection", async () => {
  const f = fixture(); f.state.bound = false; const calls = [];
  const app = f.app;
  app.openAPIRegistry.registerComponent("securitySchemes", "accountBinding", { type: "apiKey", in: "header", name: "X-Gulong-Account-Binding" });
  app.doc("/api/openapi.json", { openapi: "3.1.0", info: { title: "fixture", version: "2.17.6" } });
  const result = await verifyLocalResultDeployment("https://example.test", async (url, init) => {
    calls.push({ path: url.pathname, method: init.method || "GET", body: init.body });
    assert.equal(init.headers?.["X-Gulong-Account-Binding"], undefined);
    return app.request(url.href, init);
  });
  assert.deepEqual(calls, [{ path: "/api/openapi.json", method: "GET", body: undefined },
    { path: "/api/v1/capability-verifications/local-results", method: "POST", body: "{}" },
    { path: "/api/v1/capability-verifications/local-results/chunks", method: "POST", body: "{}" }]);
  assert.equal(result.model_requests, 0); assert.equal(result.admission_changes, 0);
  assert.equal(f.reports.rows.length, 0); assert.equal(f.audits.rows.length, 0);
});
