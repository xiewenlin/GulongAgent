import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { CAPABILITY_ORDER_PROTOCOL, normalizeCapabilityParameters, normalizeCapabilityReport, registerCapabilityOrderRoutes, validateCapabilityInput, verifyCapabilityAudioDigest } from "../../server/capability-orders.js";
import { GULONG_ENGINE_CAPABILITY_DEFINITIONS } from "../../server/gulong-engine-capabilities.js";

const tts = GULONG_ENGINE_CAPABILITY_DEFINITIONS.find((item) => item.capabilityId === "gulong_engine.tts");
const report = () => ({ capability_id: "gulong_engine.tts", capability_version: "1.0.0", protocol_version: CAPABILITY_ORDER_PROTOCOL,
  installed: true, validated: true, enabled: true, sharing_opt_in: true, supported_voices: ["default", "narrator-1"], max_concurrent: 1,
  validation: { tested_at: new Date().toISOString(), artifact_sha256: "A".repeat(64), test_id: "real-tts-audio-smoke" } });

test("Gulong TTS publishes a bounded voice and audio contract without changing other capabilities", () => {
  assert.ok(tts);
  assert.equal(tts.requiredCapabilityVersion, "1.0.0");
  assert.equal(tts.priceFen, 0);
  assert.deepEqual(tts.assetRules, []);
  assert.deepEqual(tts.outputRules.map((item) => ({ role: item.role, mimeTypes: item.mimeTypes, max: item.max })),
    [{ role: "primary_audio", mimeTypes: ["audio/mpeg", "audio/wav"], max: 1 }]);
  const parameters = normalizeCapabilityParameters({ text: "你好，欢迎使用古龙。" }, tts);
  assert.equal(parameters.voice_id, "default");
  assert.equal(parameters.output_format, "mp3");
  assert.doesNotThrow(() => validateCapabilityInput(tts, parameters, []));
  assert.throws(() => validateCapabilityInput(tts, { ...parameters, text: "   " }, []), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
  assert.throws(() => normalizeCapabilityParameters({ text: "字".repeat(12001) }, tts), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
  assert.throws(() => validateCapabilityInput(tts, normalizeCapabilityParameters({ text: "配音", voice_id: "   " }, tts), []), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
  assert.throws(() => normalizeCapabilityParameters({ text: "配音", output_format: "flac" }, tts), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
});

test("TTS node reports require an exact contract, verified inference and explicit supported voices", () => {
  const ready = normalizeCapabilityReport(report());
  assert.deepEqual(ready.supportedVoices, ["default", "narrator-1"]);
  assert.equal(ready.sharingOptIn, true);
  assert.throws(() => normalizeCapabilityReport({ ...report(), capability_version: "1" }), (error) => error.code === "CAPABILITY_VERSION_UNSUPPORTED");
  assert.throws(() => normalizeCapabilityReport({ ...report(), supported_voices: [] }), (error) => error.code === "TTS_VOICE_REPORT_REQUIRED");
  assert.throws(() => normalizeCapabilityReport({ ...report(), validated: false }), (error) => error.code === "CAPABILITY_NOT_READY");
});

test("TTS catalog stays offline without a real worker and only lists live compatible voices", async () => {
  const ownerId = new ObjectId();
  const nodeOwnerId = new ObjectId();
  const binding = { _id: new ObjectId(), userId: nodeOwnerId, nodeId: "tts-node-1", status: "active", revokedAt: null };
  const reportedCapability = normalizeCapabilityReport(report());
  const nodeReport = { bindingId: binding._id, userId: nodeOwnerId, nodeId: binding.nodeId, protocolVersion: CAPABILITY_ORDER_PROTOCOL,
    reportedAt: new Date(), resources: { running_task_count: 0, max_concurrent_tasks: 1 }, capabilities: [reportedCapability] };
  let online = false;
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => name === "capabilityNodeReports"
      ? { find: (filter) => ({ limit: () => ({ toArray: async () => online && filter["capabilities.capabilityId"] === "gulong_engine.tts" ? [nodeReport] : [] }) }) }
      : { find: () => ({ toArray: async () => [binding] }) },
    authenticate: async () => ({ user: { id: ownerId.toString() }, kind: "desktop-gulong-engine" }),
    requireTrustedMutation: () => null,
  });
  const load = async () => (await (await app.request("http://localhost/api/v1/capability-orders/catalog")).json()).capabilities.find((item) => item.capability_id === "gulong_engine.tts");
  const offline = await load();
  assert.equal(offline.dispatchable, false);
  assert.deepEqual(offline.availability, { verified_node_count: 0, free_slot_count: 0, status: "offline", voice_ids: [] });
  online = true;
  const ready = await load();
  assert.equal(ready.dispatchable, true);
  assert.deepEqual(ready.availability.voice_ids, ["default", "narrator-1"]);
  reportedCapability.sharingOptIn = false;
  assert.equal((await load()).dispatchable, false);
});

test("TTS creation refuses inactive entitlement or absent compatible worker without inserting an order", async () => {
  const userId = new ObjectId();
  let membershipActive = false;
  let inserts = 0;
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => name === "capabilityOrders"
      ? { findOne: async () => null, insertOne: async () => { inserts++; } }
      : { find: () => ({ limit: () => ({ toArray: async () => [] }) }) },
    authenticate: async () => ({ user: { id: userId.toString() }, kind: "desktop-gulong-engine" }),
    requireTrustedMutation: () => null,
    enforceRateLimit: async () => ({ allowed: true }),
    readGulongEngineEntitlement: async () => ({ active: membershipActive }),
  });
  const create = () => app.request("http://localhost/api/v1/capability-orders", { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "gulong-tts-0001" },
    body: JSON.stringify({ capability_id: "gulong_engine.tts", capability_version: "1.0.0", source_channel: "desktop_agent", parameters: { text: "测试配音", voice_id: "default", output_format: "mp3" }, assets: [] }) });
  const forbidden = await create();
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "GULONG_ENGINE_SUBSCRIPTION_REQUIRED");
  membershipActive = true;
  const offline = await create();
  assert.equal(offline.status, 409);
  assert.equal((await offline.json()).code, "CAPABILITY_NO_COMPATIBLE_NODE");
  assert.equal(inserts, 0);
});

test("audio digest verification reads actual COS bytes and detects forged metadata", async () => {
  const audio = Buffer.from("real-audio-payload");
  const sha256 = createHash("sha256").update(audio).digest("hex").toUpperCase();
  const options = { issueDownloadUrl: () => "https://cos.invalid/private-audio", fetchObject: async () => new Response(audio) };
  assert.equal(await verifyCapabilityAudioDigest("private/audio", audio.length, sha256, options), true);
  assert.equal(await verifyCapabilityAudioDigest("private/audio", audio.length, "B".repeat(64), options), false);
  assert.equal(await verifyCapabilityAudioDigest("private/audio", audio.length - 1, sha256, options), false);
  await assert.rejects(() => verifyCapabilityAudioDigest("private/audio", audio.length, sha256,
    { ...options, fetchObject: async () => new Response("missing", { status: 404 }) }), /暂时无法读取/);
});

test("TTS output ticket requires the selected MP3/WAV MIME and binds the SHA-256 headers", async () => {
  const ownerId = new ObjectId();
  const binding = { _id: new ObjectId(), userId: ownerId, nodeId: "tts-output-node", status: "active", revokedAt: null };
  const order = { _id: new ObjectId(), requesterUserId: ownerId, capabilityId: "gulong_engine.tts", sharingScope: "gulong_shared",
    parameters: { text: "你好", voice_id: "default", output_format: "mp3" }, status: "processing", claimId: "tts-claim-0002",
    claimLeaseUntil: new Date(Date.now() + 300_000), assignedNode: { bindingId: binding._id, nodeId: binding.nodeId, userId: ownerId } };
  let issued = null;
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => ({
      capabilityOrders: { findOne: async () => order },
      nodeAccountBindings: { findOne: async () => binding },
      users: { findOne: async () => ({ _id: ownerId, status: "active" }) },
      capabilityOutputUploads: { countDocuments: async () => 0, insertOne: async (value) => { issued = value; } },
    })[name],
    createPresignedPutUrl: () => "https://cos.invalid/signed-put",
    authenticate: async () => ({ error: new Response("unused", { status: 401 }) }),
    requireTrustedMutation: () => null,
  });
  const submit = (contentType) => app.request(`http://localhost/api/v1/capability-orders/${order._id}/outputs/presign`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Gulong-Account-Binding": `gab_${"U".repeat(48)}` },
    body: JSON.stringify({ claim_id: order.claimId, role: "primary_audio", filename: "voice.mp3", content_type: contentType,
      bytes: 1024, sha256: "A".repeat(64) }),
  });
  const wrong = await submit("audio/wav");
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, "INVALID_OUTPUT_MANIFEST");
  assert.equal(issued, null);
  const correct = await submit("audio/mpeg");
  assert.equal(correct.status, 201);
  const ticket = await correct.json();
  assert.equal(ticket.required_headers["Content-Type"], "audio/mpeg");
  assert.equal(ticket.required_headers["x-cos-meta-sha256"], "A".repeat(64));
  assert.equal(issued.role, "primary_audio");
});

test("TTS completion rejects mismatched actual audio hash before consuming its callback event", async () => {
  const ownerId = new ObjectId();
  const binding = { _id: new ObjectId(), userId: ownerId, nodeId: "tts-executor", status: "active", revokedAt: null };
  const order = { _id: new ObjectId(), orderNo: "CAP-TTS-1", requesterUserId: ownerId, capabilityId: "gulong_engine.tts",
    sharingScope: "gulong_shared", parameters: { text: "你好", voice_id: "default", output_format: "mp3" },
    assignedNode: { bindingId: binding._id, nodeId: binding.nodeId, userId: ownerId }, claimId: "tts-claim-0001", status: "processing",
    claimLeaseUntil: new Date(Date.now() + 300_000) };
  const audio = Buffer.from("tts-test-audio");
  const sha256 = createHash("sha256").update(audio).digest("hex").toUpperCase();
  const outputId = "tts-output-0001";
  const grant = { outputId, orderId: order._id, claimId: order.claimId, issuedToBindingId: binding._id,
    role: "primary_audio", contentType: "audio/mpeg", bytes: audio.length, sha256, filename: "voice.mp3",
    objectKey: "capability-orders/test/voice.mp3", status: "issued", expiresAt: new Date(Date.now() + 300_000) };
  let digestMatches = false;
  let insertedEvents = 0;
  let completions = 0;
  const callbacks = { findOne: async () => null, insertOne: async () => { insertedEvents++; }, updateOne: async () => ({}) };
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => ({
      nodeAccountBindings: { findOne: async () => binding },
      users: { findOne: async () => ({ _id: ownerId, status: "active" }) },
      capabilityOrders: { findOne: async () => order, findOneAndUpdate: async (_filter, update) => { completions++; Object.assign(order, update.$set); return order; } },
      capabilityOrderCallbacks: callbacks,
      capabilityOutputUploads: { find: () => ({ toArray: async () => [grant] }), updateMany: async () => ({}) },
    })[name],
    headObject: async () => ({ headers: { "content-length": String(audio.length), "x-cos-meta-sha256": sha256,
      "x-cos-meta-bytes": String(audio.length), "x-cos-meta-capability-order-id": order._id.toString(),
      "x-cos-meta-capability-output-id": outputId, "x-cos-meta-node-id-hash": createHash("sha256").update(binding.nodeId).digest("hex") } }),
    verifyAudioObject: async () => digestMatches,
    authenticate: async () => ({ error: new Response("unused", { status: 401 }) }),
    requireTrustedMutation: () => null,
  });
  const submit = () => app.request("http://localhost/api/v1/capability-orders/callback", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Gulong-Account-Binding": `gab_${"T".repeat(48)}` },
    body: JSON.stringify({ order_id: order._id.toString(), claim_id: order.claimId, event_id: "tts-completed-0001", status: "completed", outputs: [{ output_id: outputId }] }) });
  const rejected = await submit();
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "OUTPUT_CONTENT_HASH_MISMATCH");
  assert.equal(insertedEvents, 0);
  assert.equal(completions, 0);
  digestMatches = true;
  const completed = await submit();
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).order_status, "completed");
  assert.equal(insertedEvents, 1);
  assert.equal(completions, 1);
  assert.equal(order.outputs[0].sha256, sha256);
});
