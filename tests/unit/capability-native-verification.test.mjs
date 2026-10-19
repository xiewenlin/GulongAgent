import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { createNativeCapabilityVerificationAdapters, NATIVE_PROBE_VERSIONS, automaticNativeNodeMatchesOrder, nativeVerificationAvailability } from "../../server/capability-native-verification.js";
import { normalizeAutoVerificationInventory } from "../../server/capability-auto-verification.js";
import { POSE_VIDEO_FIXTURE } from "../../server/capability-probe-fixtures.js";
import { normalizeCapabilityParameters, CAPABILITY_ORDER_DEFINITIONS, capabilityNodeCanRunOrder, normalizeCapabilityReport, registerCapabilityOrderRoutes, CAPABILITY_ORDER_PROTOCOL } from "../../server/capability-orders.js";

// Protocol/validator stand-ins are memory-only. Actual COS byte inspection has
// separate tests; none of these tests invokes or claims a real installed model.
const ids = { "qwen_image_2_1.multi_image_edit": "qwen-image21-uc", "minimax_music_3.generate": "MiniMax-Music3",
  "sam.video_track": "sam-video-3.1", "whisper.transcribe": "whisper-large-v3-turbo", "mediapipe.video_analysis": "mediapipe-pose-full-0.10.14" };
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(id) {
  const inventory = { capabilityId: id, capabilityVersion: NATIVE_PROBE_VERSIONS[id][0], asrLanguages: ["en"] };
  const model = { id: ids[id], ...(id === "minimax_music_3.generate" ? { max_duration_seconds: 300 } : {}) };
  const rows = []; let mediaCalls = 0;
  const adapter = createNativeCapabilityVerificationAdapters({ verifyMediaOutputs: async () => { mediaCalls++; return rows; } })[id];
  const probe = adapter.createProbe({ inventory, model, nonce: "gcv-1234abcdef" });
  const challenge = { capabilityId: id, capabilityVersion: inventory.capabilityVersion, inventory, model, parameters: probe.parameters,
    probeInputs: probe.inputAssets || [], probeOutputRules: probe.outputRules };
  const inlineResult = { model: model.id, ...(probe.inputAssets?.length ? { input_sha256: probe.inputAssets[0].sha256 } : {}) };
  const mask = (name) => ({ name, width: 512, height: 512, foregroundRatio: 0.3, sha256: "a".repeat(64), bytes: 1000 });
  if (id.includes("multi_image_edit")) rows.push({ role: "primary_image", actualContentType: "image/png", width: 512, height: 512 });
  else if (id === "minimax_music_3.generate") {
    rows.push({ role: "primary_audio", contentType: "audio/flac", bytes: 1000, sha256: "a".repeat(64), durationSeconds: 12, sampleRate: 44100 });
    inlineResult.lyric_verification = { algorithm: "ordered-whole-lyrics-v1", full_audio: true, language: "en", audio_sha256: "a".repeat(64),
      lyrics_sha256: sha(probe.parameters.lyrics), transcript: probe.parameters.lyrics };
  } else if (id === "whisper.transcribe") rows.push({ role: "transcript_json", json: { result: { language: "en" }, transcription: [{ offsets: { from: 0, to: 11000 },
    text: "And so my fellow Americans ask not what your country can do for you ask what you can do for your country" }] } });
  else if (id === "sam.video_track") {
    rows.push({ role: "manifest_json", json: { schema: "sam31-object-multiplex-evidence-v1", sourceFrameCount: 16, framesProcessed: 16, promptFrameCounts: [16], prompts: ["person"], trace: "objects.jsonl" } },
      { role: "tracks_jsonl", jsonl: Array.from({ length: 16 }, (_, frame) => ({ frame, objectId: 1, concept: "person", visible: true, mask: `masks/object-00001/frame-${String(frame).padStart(6, "0")}.png` })) },
      { role: "mask_archive", archiveEntries: Array.from({ length: 16 }, (_, frame) => mask(`masks/object-00001/frame-${String(frame).padStart(6, "0")}.png`)) });
  } else {
    rows.push({ role: "analysis_json", json: { sourceSha256: POSE_VIDEO_FIXTURE.sha256, evidence: { decodedFrames: 16, poseFrames: 16, maskFrames: 16 } } },
      { role: "pose_tracks_jsonl", jsonl: Array.from({ length: 16 }, (_, frame) => ({ frame, time: frame / 8,
        landmarks: Array.from({ length: 33 }, () => [0.1,0.2,0.01,0.9]), mask: `masks/${String(frame).padStart(6, "0")}.png` })) },
      { role: "person_layers_archive", archiveEntries: Array.from({ length: 16 }, (_, frame) => mask(`masks/${String(frame).padStart(6, "0")}.png`)) });
  }
  const outputs = probe.outputRules.map((rule) => ({ output_id: `output-${rule.role}` }));
  return { adapter, inventory, model, probe, challenge, inlineResult, outputs, rows, get mediaCalls() { return mediaCalls; },
    result: () => adapter.validateResult({ challenge, inlineResult, outputs, binding: { _id: "memory-bound-node" } }) };
}

test("native adapters retain actual component IDs and revisions instead of inventing model names or numeric versions", () => {
  assert.deepEqual(createNativeCapabilityVerificationAdapters(), {});
  for (const id of Object.keys(ids)) {
    const f = fixture(id);
    assert.equal(f.adapter.supports(f.inventory, f.model), true);
    assert.equal(f.adapter.supports({ ...f.inventory, capabilityVersion: "unknown-native-revision" }, f.model), false);
    assert.equal(f.adapter.supports(f.inventory, { ...f.model, id: "display-name-not-model" }), false);
    const normalized = normalizeAutoVerificationInventory({ capability_id: id, capability_version: f.inventory.capabilityVersion,
      artifact_sha256: "a".repeat(64), models: [f.model] });
    assert.equal(normalized.capabilityVersion, f.inventory.capabilityVersion);
    const capability = CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === id);
    assert.deepEqual(normalizeCapabilityParameters(f.probe.parameters, capability), f.probe.parameters);
  }
});

test("legacy native Qwen text-to-image exposes only its exact automatic model scopes in availability.models", () => {
  const id = "qwen_image_2_1.text_to_image";
  const scope = { id: "qwen-image21-uc", task: "text_to_image", input_asset_count: 0, width: 512, height: 512, steps: 4, guidance_scale: 4, batch_size: 1 };
  const report = { automaticVerification: true, trustedAcceptance: true, contractTests: { exact_image_scope: true }, models: [scope] };
  assert.deepEqual(nativeVerificationAvailability(id, [report, report]), { models: [scope] });
  for (const patch of [{ automaticVerification: false }, { trustedAcceptance: false }, { contractTests: {} },
    { models: [{ ...scope, width: 2048 }] }, { models: [{ ...scope, id: "unknown-native-model" }] }]) {
    assert.deepEqual(nativeVerificationAvailability(id, [{ ...report, ...patch }]), { models: [] });
  }
  assert.deepEqual(nativeVerificationAvailability(id, []), { models: [] });
});

test("the authenticated native Qwen catalog route returns its real automatic model without injecting a model parameter", async () => {
  const requester = { _id: new ObjectId(), status: "active", role: "user" }, executor = { _id: new ObjectId(), status: "active", role: "user" };
  const binding = { _id: new ObjectId(), userId: executor._id, nodeId: "native-qwen-node", status: "active", revokedAt: null,
    autoVerificationPolicy: "capability-v2", autoVerificationCapabilityIds: ["qwen_image_2_1.text_to_image"] };
  const scope = { id: "qwen-image21-uc", task: "text_to_image", input_asset_count: 0, width: 512, height: 512, steps: 4, guidance_scale: 4, batch_size: 1 };
  const report = normalizeCapabilityReport({ capability_id: "qwen_image_2_1.text_to_image", capability_version: "2.1", protocol_version: CAPABILITY_ORDER_PROTOCOL,
    installed: true, enabled: true, validated: true, sharing_opt_in: true, validation: { tested_at: new Date(), artifact_sha256: "a".repeat(64) } });
  const collections = new Map(), collection = (name) => {
    if (!collections.has(name)) collections.set(name, createCapabilityMemoryCollection());
    return collections.get(name);
  };
  collection("users").rows.push(requester, executor); collection("nodeAccountBindings").rows.push(binding);
  collection("capabilityNodeReports").rows.push({ _id: new ObjectId(), bindingId: binding._id, userId: executor._id, nodeId: binding.nodeId,
    protocolVersion: CAPABILITY_ORDER_PROTOCOL, capabilities: [report], reportedAt: new Date(), resources: { max_concurrent_tasks: 1, running_task_count: 0 } });
  const app = new OpenAPIHono(); let accepted = true;
  registerCapabilityOrderRoutes(app, { getCollection: async (name) => collection(name), getUserComputeGroupId: async () => null,
    enforceRateLimit: async () => ({ allowed: true }), requireTrustedMutation: () => null,
    authenticate: async () => ({ kind: "desktop-gulong-engine", user: { ...requester, id: String(requester._id) } }),
    findTrustedConsumerAcceptance: async () => accepted ? { source: "automatic", models: [scope], defaultModel: scope.id, contractTests: { exact_image_scope: true }, asrLanguages: [] } : null });
  const catalog = async () => {
    const response = await app.request("http://localhost/api/v1/capability-orders/catalog?product=gulong_engine");
    assert.equal(response.status, 200);
    return (await response.json()).capabilities.find((row) => row.capability_id === "qwen_image_2_1.text_to_image");
  };
  const ready = await catalog();
  assert.equal(ready.availability.verified_node_count, 1); assert.deepEqual(ready.availability.models, [scope]);
  assert.equal(ready.parameters_schema.properties.model, undefined); assert.equal(ready.parameters_schema.additionalProperties, false);
  accepted = false;
  const offline = await catalog(); assert.equal(offline.availability.verified_node_count, 0); assert.deepEqual(offline.availability.models, []);
});

test("each native probe is bounded and fixture-backed; media outputs are never synthesized from a validated flag", async () => {
  for (const id of Object.keys(ids)) {
    const f = fixture(id), result = await f.result();
    assert.equal(result.verifiedModel.id, f.model.id);
    assert.equal(result.contractTests.exact_native_scope, true);
    assert.equal(f.probe.budget.max_inferences, 1);
    assert.ok((f.probe.budget.max_audio_seconds || 0) <= 12);
    assert.ok((f.probe.budget.max_video_frames || 0) <= 16);
    assert.equal(f.mediaCalls, 1);
    const report = { automaticVerification: true, trustedAcceptance: true, contractTests: result.contractTests, models: [result.verifiedModel] };
    const order = { capabilityId: id, parameters: f.probe.parameters, assets: (f.probe.inputAssets || []).map(({ role }) => ({ role })) };
    assert.equal(automaticNativeNodeMatchesOrder(report, order), true, id);
    assert.equal(nativeVerificationAvailability(id, [report]).native_profiles.length, 1);
    assert.equal(nativeVerificationAvailability(id, [{ ...report, trustedAcceptance: false }]).native_profiles.length, 0);
    assert.equal(automaticNativeNodeMatchesOrder({ ...report, contractTests: {} }, order), false);
  }
});

test("native wrong models, substituted inputs, URLs and missing output references fail before any media reads", async () => {
  for (const mutate of [(f) => { f.inlineResult.model = "other"; }, (f) => { f.inlineResult.input_sha256 = "b".repeat(64); },
    (f) => { f.inlineResult.url = "https://untrusted.invalid/output"; }, (f) => { f.outputs.pop(); }]) {
    const f = fixture("sam.video_track"); mutate(f);
    await assert.rejects(f.result); assert.equal(f.mediaCalls, 0);
  }
});

test("full-frame SAM requires matching complete tracks and actual nonempty masks, not a manifest renamed tracks", async () => {
  for (const mutate of [(f) => f.rows[0].json.sourceFrameCount--, (f) => f.rows[1].jsonl.pop(),
    (f) => { f.rows[1].jsonl[0].concept = "unmapped"; }, (f) => { f.rows[2].archiveEntries[0].foregroundRatio = 0; },
    (f) => { f.rows[2].archiveEntries[0].width = 256; }, (f) => { f.rows[1].jsonl[0].mask = "../../outside.png"; }]) {
    const f = fixture("sam.video_track"); mutate(f); await assert.rejects(f.result);
  }
});

test("pose probes require all continuous frames, exactly 33 finite landmarks and genuine linked masks", async () => {
  for (const mutate of [(f) => f.rows[1].jsonl.pop(), (f) => { f.rows[1].jsonl[0].frame = 3; },
    (f) => { f.rows[1].jsonl[0].landmarks.pop(); }, (f) => { f.rows[1].jsonl[0].landmarks[0][0] = Infinity; },
    (f) => { f.rows[0].json.sourceSha256 = "c".repeat(64); }, (f) => { f.rows[2].archiveEntries = []; }]) {
    const f = fixture("mediapipe.video_analysis"); mutate(f); await assert.rejects(f.result);
  }
});

test("Whisper must cover the complete original English audio and final sentence with original ordered segment timestamps", async () => {
  for (const mutate of [(f) => { f.rows[0].json.transcription[0].text = "my fellow Americans"; },
    (f) => { f.rows[0].json.transcription[0].offsets.to = 7000; }, (f) => { f.rows[0].json.transcription[0].offsets.from = 9000; },
    (f) => { f.rows[0].json.result.language = "zh"; }]) {
    const f = fixture("whisper.transcribe"); mutate(f); await assert.rejects(f.result);
  }
});

test("native music scope is the tested FLAC duration, not the original advertised 300-second range", async () => {
  const f = fixture("minimax_music_3.generate"), result = await f.result();
  assert.equal(result.verifiedModel.max_duration_seconds, 12);
  const report = { automaticVerification: true, trustedAcceptance: true, contractTests: result.contractTests, models: [result.verifiedModel] };
  assert.equal(automaticNativeNodeMatchesOrder(report, { capabilityId: f.inventory.capabilityId, parameters: { ...f.probe.parameters, duration_seconds: 13 }, assets: [] }), false);
  f.inlineResult.lyric_verification.transcript = "Blue sky";
  await assert.rejects(f.result);
});

test("cross-account native sharing requires opt-in, exact automatic proof, same group and a physical slot; legacy own-account admission is preserved", async () => {
  const f = fixture("sam.video_track"), result = await f.result();
  const raw = { capability_id: f.inventory.capabilityId, capability_version: f.inventory.capabilityVersion, protocol_version: "gulong-capability-orders-v1",
    installed: true, validated: true, enabled: true, sharing_opt_in: true, validation: { tested_at: new Date(), artifact_sha256: "a".repeat(64) },
    automaticVerification: true, trustedAcceptance: true, contractTests: { exact_native_scope: true } };
  const normalized = normalizeCapabilityReport(raw);
  assert.equal(normalized.automaticVerification, undefined, "client booleans must not be promoted into server trust");
  assert.equal(normalized.sharingOptIn, true);
  const node = { availableSlots: 1, nodeId: "native-node", binding: { userId: "executor", computeGroupId: "same-group" }, capabilities: [normalized] };
  const order = { capabilityId: f.inventory.capabilityId, requesterUserId: "requester", computeGroupId: "same-group", sharingScope: "gulong_shared",
    parameters: f.probe.parameters, assets: [{ role: "source_video" }] };
  assert.equal(capabilityNodeCanRunOrder(node, order), false);
  assert.equal(capabilityNodeCanRunOrder(node, { ...order, requesterUserId: "executor", sharingScope: undefined }), true,
    "an unrelated migration does not repeal the old own-node contract");
  const approved = { ...normalized, automaticVerification: true, trustedAcceptance: true, contractTests: result.contractTests, models: [result.verifiedModel] };
  node.capabilities = [approved];
  assert.equal(capabilityNodeCanRunOrder(node, order), true);
  assert.equal(capabilityNodeCanRunOrder({ ...node, availableSlots: 0 }, order), false);
  assert.equal(capabilityNodeCanRunOrder(node, { ...order, computeGroupId: "other-group" }), false);
  assert.equal(capabilityNodeCanRunOrder({ ...node, capabilities: [{ ...approved, sharingOptIn: false }] }, order), false);
  assert.equal(capabilityNodeCanRunOrder(node, { ...order, parameters: { ...order.parameters, sample_fps: 24 } }), false);
  assert.equal(capabilityNodeCanRunOrder(node, { ...order, parameters: { ...order.parameters, text_prompts: ["person", "bag"] } }), false);
});
