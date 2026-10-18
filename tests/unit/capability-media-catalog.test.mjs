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
    assert.deepEqual(result.body.verification.verified_model, challenge.model);
    return challenge.model;
  };
  return { inventory, collection, call, claim, catalog, pass };
}

test("automatic native 2K approval is published as the exact readable model matrix", async () => {
  const f = fixture("image_2k");
  assert.equal((await f.call("/api/v1/capability-verifications/report", { capabilities: [f.inventory] }, true)).status, 200);
  assert.deepEqual((await f.catalog()).availability.models, []);
  const approved = await f.pass();
  assert.equal((await f.claim()).status, 200);
  const catalog = await f.catalog();
  assert.equal(catalog.dispatchable, true, JSON.stringify(catalog));
  assert.deepEqual(catalog.availability.models, [{ id: "qwen_image_2_1" }]);
  assert.deepEqual(approved, { id: "qwen_image_2_1" });
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
