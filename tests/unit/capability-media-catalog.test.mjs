import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { hashOpaqueToken } from "../../server/security.js";
import { CAPABILITY_ORDER_PROTOCOL, registerCapabilityOrderRoutes } from "../../server/capability-orders.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";

// Only in-memory storage and media-parser replies are fixtures. No disk output,
// download, model request, installed payload or production endpoint is used.
function fixture(suffix) {
  const user = { _id: new ObjectId(), role: "user", status: "active" };
  const token = `gab_${"M".repeat(48)}`;
  const binding = { _id: new ObjectId(), userId: user._id, nodeId: "media-matrix-node", nodeName: "媒体目录测试节点",
    status: "active", revokedAt: null, tokenHash: hashOpaqueToken(token, "h3-account-binding") };
  const inventory = { capability_id: `gulong_engine.${suffix}`, capability_version: "1.0.0",
    protocol_version: CAPABILITY_ORDER_PROTOCOL, installed: true, enabled: true, validated: false, sharing_opt_in: true, max_concurrent: 2,
    models: suffix === "tts" ? [{ id: "tts-a", voice_id: "voice-a" }, { id: "tts-b", voice_id: "voice-b" }]
      : suffix === "image" ? [{ id: "zimage" }]
      : [{ id: "qwen_image_2_1" }], validation: { artifact_sha256: "A".repeat(64) } };
  const collections = new Map();
  const collection = (name) => {
    if (!collections.has(name)) collections.set(name, createCapabilityMemoryCollection());
    return collections.get(name);
  };
  collection("users").rows.push(user);
  collection("nodeAccountBindings").rows.push(binding);
  const app = new OpenAPIHono();
  app.onError((error, c) => c.json({ code: error.code || "TEST_FAILURE", message: error.message }, error.status || 500));
  registerCapabilityOrderRoutes(app, { getCollection: async (name) => collection(name),
    authenticate: async () => ({ user: { ...user, id: String(user._id) }, kind: "desktop-gulong-engine" }),
    requireAdmin: async () => ({ user: { id: String(user._id), role: "admin" } }),
    requireTrustedMutation: () => null, getUserComputeGroupId: async () => null,
    readGulongEngineEntitlement: async () => ({ active: true }), enforceRateLimit: async () => ({ allowed: true }),
    verificationMedia: { issueProbeOutputUpload: async () => { throw new Error("fixture must not upload"); },
      verifyMediaOutputs: async ({ challenge }) => [{ role: suffix === "tts" ? "primary_audio" : "primary_image",
        bytes: 4096, sha256: "B".repeat(64), contentType: suffix === "tts" ? "audio/wav" : "image/png",
        ...(suffix === "tts" ? { durationSeconds: 2, sampleRate: 24000, channels: 1, nonSilent: true }
          : { width: challenge.parameters.width, height: challenge.parameters.height }) }] },
  });
  let request = 0;
  const call = async (path, body, worker = false) => {
    const response = await app.request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `media-matrix-${++request}`,
        ...(worker ? { "X-Gulong-Account-Binding": token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const resources = () => ({ gpu_state: "idle", gpu_observed_at: new Date().toISOString(),
    current_task_remaining_seconds: 0, running_task_count: 0, max_concurrent_tasks: 2 });
  const claim = () => call("/api/v1/capability-orders/claim", { node_id: binding.nodeId, protocol_version: CAPABILITY_ORDER_PROTOCOL,
    capabilities: [inventory], resources: resources() }, true);
  const catalog = async () => {
    const response = await call("/api/v1/capability-orders/catalog?product=worklucky");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.capabilities.find((item) => item.capability_id === inventory.capability_id);
  };
  const pass = async () => {
    const next = await call("/api/v1/capability-verifications/next", { resources: resources() }, true);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const challenge = next.body.challenge;
    assert.ok(challenge, JSON.stringify(next.body));
    assert.equal(challenge.parameters.model, challenge.model.id);
    const result = await call(`/api/v1/capability-verifications/${challenge.id}/result`, {
      lease_token: challenge.lease_token, status: "completed", outputs: [{ output_id: "fixture-output-id" }],
      inline_result: { model: challenge.model.id, ...(suffix === "tts" ? { voice_id: challenge.model.voice_id } : {}) },
    }, true);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.verification.status, "active", JSON.stringify(result.body));
    assert.equal(result.body.verification.verified_model.id, challenge.model.id);
    if (suffix === "tts") assert.deepEqual(result.body.verification.verified_model, challenge.model);
    return result.body.verification.verified_model;
  };
  return { user, inventory, collection, call, claim, catalog, pass };
}

test("automatic native 2K approval is published as the exact readable model matrix", async () => {
  const f = fixture("image_2k");
  assert.equal((await f.call("/api/v1/capability-verifications/report", { capabilities: [f.inventory] }, true)).status, 200);
  assert.deepEqual((await f.catalog()).availability.models, []);
  const approved = await f.pass();
  assert.equal((await f.claim()).status, 200);
  const catalog = await f.catalog();
  assert.equal(catalog.dispatchable, true, JSON.stringify(catalog));
  assert.deepEqual(catalog.availability.models, [approved]);
  assert.deepEqual(approved, { id: "qwen_image_2_1", task: "text_to_image", input_asset_count: 0, width: 2048, height: 2048,
    generation_mode: "fast_lora_6", steps: 6, prompt_enhancement: "none" });
  assert.equal(f.collection("capabilityOrders").rows.length, 0);
});

for (const suffix of ["image", "image_2k"]) {
  test(`automatic ${suffix} creation and claim refuse untested editing/material paths but preserve the tested task`, async () => {
    const f = fixture(suffix);
    await f.call("/api/v1/capability-verifications/report", { capabilities: [f.inventory] }, true);
    const scope = await f.pass();
    await f.claim();
    const asset = { _id: new ObjectId(), ownerId: f.user._id, status: "ready", filename: "reference.png", contentType: "image/png",
      bytes: 1024, sha256: "C".repeat(64), objectKey: "fixture/reference-image" };
    f.collection("capabilityAssetUploads").rows.push(asset);
    const { task, input_asset_count, id: model, ...options } = scope;
    const base = { model, prompt: "新的提示词", ...options, ...(suffix === "image_2k" ? { task } : {}) };
    const create = (changes = {}, assets = []) => f.call("/api/v1/capability-orders", { capability_id: f.inventory.capability_id,
      capability_version: "1.0.0", client_product: "worklucky", parameters: { ...base, ...changes }, assets });
    const reference = [{ asset_id: String(asset._id), role: "reference_image" }];
    const edited = await create(suffix === "image_2k" ? { task: "multi_image_edit" } : {}, reference);
    assert.equal(edited.status, 409, JSON.stringify(edited.body));
    assert.equal(edited.body.code, "CAPABILITY_NO_COMPATIBLE_NODE");
    if (suffix === "image_2k") {
      for (const changes of [{ generation_mode: "standard", steps: 30 }, { width: 1792, height: 2400 }, { prompt_enhancement: "local" }]) {
        const denied = await create(changes);
        assert.equal(denied.status, 409, JSON.stringify(denied.body));
      }
    } else assert.equal((await create({ width: 1024, height: 1024 })).status, 409);
    assert.equal(f.collection("capabilityOrders").rows.length, 0);
    const accepted = await create({ seed: 123 });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const actualOrder = f.collection("capabilityOrders").rows[0];
    const historicalEdit = { ...actualOrder, _id: new ObjectId(), orderNo: "CAP-fixture-untested-edit",
      createdAt: new Date(Date.now() - 5000), assets: [{ ...asset, assetId: String(asset._id), role: "reference_image" }],
      parameters: { ...actualOrder.parameters, ...(suffix === "image_2k" ? { task: "multi_image_edit" } : {}) } };
    f.collection("capabilityOrders").rows.push(historicalEdit);
    const claimed = await f.claim();
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal(claimed.body.task.id, accepted.body.order.id);
    assert.equal(claimed.body.task.parameters.seed, 123);
    assert.deepEqual(claimed.body.task.assets, []);
    assert.equal(historicalEdit.status, "queued", "an older untested editing order must never be claimed through the text-to-image receipt");
    assert.equal(historicalEdit.assignedNode, undefined);
  });

  test(`historical unscoped automatic ${suffix} receipts are hidden and requeued without changing the id-only inventory`, async () => {
    const f = fixture(suffix);
    await f.call("/api/v1/capability-verifications/report", { capabilities: [f.inventory] }, true);
    const scope = await f.pass();
    await f.claim();
    const previous = f.collection("capabilityAutoVerifications").rows[0];
    previous.verifiedModel = { id: scope.id };
    delete previous.contractTests.exact_image_scope;
    assert.equal((await f.catalog()).dispatchable, false);
    assert.deepEqual((await f.catalog()).availability.models, []);
    const listed = await f.call("/api/admin/capability-verifications");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.verifications[0].status, "expired");
    assert.equal(listed.body.verifications[0].verified_model, null);
    const reported = await f.call("/api/v1/capability-verifications/report", { capabilities: [f.inventory] }, true);
    assert.equal(reported.status, 200, JSON.stringify(reported.body));
    assert.equal(reported.body.verifications[0].status, "pending");
    assert.equal(reported.body.verifications[0].verified_model, null);
    assert.deepEqual(f.inventory.models, [{ id: scope.id }]);
    assert.deepEqual(await f.pass(), scope);
    await f.claim();
    assert.deepEqual((await f.catalog()).availability.models, [scope]);
    assert.equal(f.collection("capabilityOrders").rows.length, 0);
  });
}

test("explicit image editing inventory cannot be silently probed as text-to-image", async () => {
  const f = fixture("image_2k");
  f.inventory.models[0].task = "multi_image_edit";
  const reported = await f.call("/api/v1/capability-verifications/report", { capabilities: [f.inventory] }, true);
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.equal(reported.body.verifications[0].status, "adapter_required");
  const next = await f.call("/api/v1/capability-verifications/next", { resources: { gpu_state: "idle", gpu_observed_at: new Date().toISOString(),
    current_task_remaining_seconds: 0, running_task_count: 0, max_concurrent_tasks: 2 } }, true);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.challenge, null);
  assert.equal(f.collection("capabilityOrders").rows.length, 0);
});

test("automatic TTS approval publishes only tested model/voice pairs and rejects crossed or pending pairs", async () => {
  const f = fixture("tts");
  assert.equal((await f.call("/api/v1/capability-verifications/report", { capabilities: [f.inventory] }, true)).status, 200);
  const first = await f.pass();
  assert.equal((await f.claim()).status, 200);
  let catalog = await f.catalog();
  assert.deepEqual(catalog.availability.models, [first]);
  assert.equal(catalog.parameters_schema.properties.model.default, undefined);
  const create = (model, voice) => f.call("/api/v1/capability-orders", { capability_id: "gulong_engine.tts",
    capability_version: "1.0.0", client_product: "worklucky", parameters: { model, voice_id: voice, text: "测试配音", output_format: "wav" } });
  const pending = f.inventory.models.find((model) => model.id !== first.id);
  assert.equal((await create(pending.id, pending.voice_id)).status, 409);
  const second = await f.pass();
  assert.equal((await f.claim()).status, 200);
  catalog = await f.catalog();
  assert.deepEqual(catalog.availability.models, [...f.inventory.models]);
  assert.equal((await create(first.id, second.voice_id)).status, 409);
  assert.equal((await create(second.id, first.voice_id)).status, 409);
  assert.equal(f.collection("capabilityOrders").rows.length, 0);
  const accepted = await create(second.id, second.voice_id);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const claimed = await f.claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.parameters.model, second.id);
  assert.equal(claimed.body.task.parameters.voice_id, second.voice_id);
  assert.equal(f.collection("capabilityOrders").rows.length, 1);
  for (const verification of f.collection("capabilityAutoVerifications").rows) verification.expiresAt = new Date(Date.now() - 1);
  catalog = await f.catalog();
  assert.equal(catalog.dispatchable, false);
  assert.deepEqual(catalog.availability.models, []);
});
