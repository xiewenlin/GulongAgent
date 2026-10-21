import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { CAPABILITY_ORDER_DEFINITIONS, normalizeCapabilityParameters, registerCapabilityOrderRoutes } from "../../server/capability-orders.js";

const native = CAPABILITY_ORDER_DEFINITIONS.find((c) => c.capabilityId === "minimax_music_3.generate");
const invalid = (error) => error.status === 400 && error.code === "INVALID_CAPABILITY_PARAMETERS" && /seed/.test(error.message);

test("native Music3 seed is required and default zero is only an authoring hint", () => {
  assert.ok(native.parametersSchema.required.includes("seed"));
  assert.deepEqual(native.parametersSchema.properties.seed, {
    type: "integer", minimum: 0, maximum: 2147483647, default: 0,
    description: "必须显式提交的非负整数；default=0 仅供界面初始化，服务端不补填或随机生成。",
  });
  for (const parameters of [{ prompt: "音乐" }, { prompt: "音乐", seed: undefined }]) {
    assert.throws(() => normalizeCapabilityParameters(parameters, native), invalid);
    assert.equal(parameters.seed, undefined);
  }
});

test("native Music3 preserves explicit endpoints and never mutates input", () => {
  for (const seed of [0, 1, 2147483647]) {
    const parameters = Object.freeze({ prompt: "音乐", seed });
    assert.equal(normalizeCapabilityParameters(parameters, native).seed, seed);
    assert.deepEqual(parameters, { prompt: "音乐", seed });
  }
});

test("native Music3 rejects negative, fractional, out of range and non-numeric seeds", () => {
  for (const seed of [-1, -3, 0.5, 2147483648, Number.MAX_SAFE_INTEGER, "0", "18446744073709551615", "", null, true, {}, []]) {
    assert.throws(() => normalizeCapabilityParameters({ prompt: "音乐", seed }, native), invalid);
  }
});

test("image random seed and independent generic music uint64 contract stay unchanged", () => {
  const image = CAPABILITY_ORDER_DEFINITIONS.find((c) => c.capabilityId === "qwen_image_2_1.text_to_image");
  assert.equal(normalizeCapabilityParameters({ prompt: "图片" }, image).seed, -1);
  assert.equal(normalizeCapabilityParameters({ prompt: "图片", seed: -1 }, image).seed, -1);
  const generic = CAPABILITY_ORDER_DEFINITIONS.find((c) => c.capabilityId === "gulong_engine.music");
  const parameters = { caption: "music", lyrics: "歌词", seconds: 12 };
  for (const seed of [0, 123, "18446744073709551615"]) {
    assert.equal(normalizeCapabilityParameters({ ...parameters, seed }, generic).seed, seed);
  }
  for (const seed of [-1, "18446744073709551616", "-1"]) {
    assert.throws(() => normalizeCapabilityParameters({ ...parameters, seed }, generic), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
  }
  assert.throws(() => normalizeCapabilityParameters(parameters, generic), invalid);
});

function fixture() {
  const owner = new ObjectId();
  const originalKey = "native-music-historical-request";
  const historical = { _id: new ObjectId(), requesterUserId: owner,
    idempotencyKey: createHash("sha256").update(`${owner}:${originalKey}`).digest("hex"),
    capabilityId: native.capabilityId, clientProduct: "worklucky", status: "completed",
    parameters: { prompt: "历史音乐", seed: -1 }, assets: [], createdAt: new Date(), updatedAt: new Date() };
  const collections = new Map([["capabilityOrders", createCapabilityMemoryCollection([historical])]]);
  const getCollection = async (name) => {
    if (!collections.has(name)) collections.set(name, createCapabilityMemoryCollection());
    return collections.get(name);
  };
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, { getCollection, getUserComputeGroupId: async () => null,
    authenticate: async () => ({ kind: "desktop-gulong-engine", user: { id: String(owner), role: "user" } }),
    requireTrustedMutation: () => null, enforceRateLimit: async () => ({ allowed: true }),
    readGulongEngineEntitlement: async () => ({ active: true }),
  });
  return { app, getCollection, historical, originalKey };
}

test("public native catalog exposes explicit seed without opening unverified nodes", async () => {
  const f = fixture();
  const response = await f.app.request("/api/v1/capability-orders/catalog?product=worklucky");
  assert.equal(response.status, 200);
  const capability = (await response.json()).capabilities.find((c) => c.capability_id === native.capabilityId);
  assert.deepEqual(capability.parameters_schema, native.parametersSchema);
  assert.equal(capability.dispatchable, false);
  assert.equal(capability.availability.verified_node_count, 0);
});

test("create rejects bad native seed before any order or ledger write", async () => {
  const f = fixture();
  for (const patch of [{}, { seed: -1 }, { seed: "0" }, { seed: 1.5 }, { seed: 2147483648 }]) {
    const response = await f.app.request("/api/v1/capability-orders", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": f.originalKey },
      body: JSON.stringify({ capability_id: native.capabilityId, client_product: "worklucky", parameters: { prompt: "音乐", ...patch } }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_CAPABILITY_PARAMETERS");
  }
  assert.equal(await (await f.getCollection("capabilityOrders")).countDocuments({}), 1);
  assert.equal(await (await f.getCollection("walletLedger")).countDocuments({}), 0);
  assert.deepEqual((await (await f.getCollection("capabilityOrders")).findOne({ _id: f.historical._id })).parameters, f.historical.parameters);
});

test("valid native seed passes parameter validation but cannot bypass missing node admission", async () => {
  const f = fixture();
  const response = await f.app.request("/api/v1/capability-orders", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "new-valid-native-music-request" },
    body: JSON.stringify({ capability_id: native.capabilityId, client_product: "worklucky", parameters: { prompt: "音乐", seed: 0 } }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CAPABILITY_NO_COMPATIBLE_NODE");
  assert.equal(await (await f.getCollection("capabilityOrders")).countDocuments({}), 1);
});

test("historical native seed stays readable by original id and request key without normalization", async () => {
  const f = fixture();
  for (const suffix of [`/${f.historical._id}`, `/by-request/${f.originalKey}`]) {
    const response = await f.app.request(`/api/v1/capability-orders${suffix}?product=worklucky`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).order.id, String(f.historical._id));
  }
  assert.deepEqual((await (await f.getCollection("capabilityOrders")).findOne({ _id: f.historical._id })).parameters, f.historical.parameters);
});

test("historical terminal native order cancel recovers original record without changing seed", async () => {
  const f = fixture();
  const response = await f.app.request(`/api/v1/capability-orders/by-request/${f.originalKey}/cancel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_product: "worklucky" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.idempotent, true);
  assert.equal(result.order.id, String(f.historical._id));
  assert.equal(result.order.status, "completed");
  assert.deepEqual((await (await f.getCollection("capabilityOrders")).findOne({ _id: f.historical._id })).parameters, f.historical.parameters);
  assert.equal(await (await f.getCollection("capabilityOrders")).countDocuments({}), 1);
});
