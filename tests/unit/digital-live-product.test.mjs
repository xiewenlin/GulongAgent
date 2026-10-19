import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { registerCapabilityOrderRoutes, normalizeCapabilityReport, CAPABILITY_ORDER_PROTOCOL } from "../../server/capability-orders.js";
import { digitalLiveConfig, digitalLiveReport, digitalLiveNodeMatchesOrder, digitalLiveAvailability, digitalLiveParameterError, DIGITAL_LIVE_TEXT_MODEL, DIGITAL_LIVE_CAPABILITY_IDS } from "../../server/digital-live-product.js";
import { hashOpaqueToken } from "../../server/security.js";

// Real Hono create/claim/callback/recovery routes; model proofs and Mongo are
// isolated in memory. None of these assertions is a real consumer/model run.
function fixture({ model = DIGITAL_LIVE_TEXT_MODEL, active = true, approved = true, sameGroup = true } = {}) {
  const requester = { _id: new ObjectId(), status: "active", role: "user", computeGroupId: "group-one" };
  const executor = { _id: new ObjectId(), status: "active", role: "user" };
  const token = `gab_${"D".repeat(48)}`;
  const binding = { _id: new ObjectId(), userId: executor._id, nodeId: "digital-live-memory-node", nodeName: "数字直播隔离测试节点", status: "active", revokedAt: null,
    computeGroupId: sameGroup ? "group-one" : "group-two", tokenHash: hashOpaqueToken(token, "h3-account-binding"),
    autoVerificationPolicy: "capability-v2", autoVerificationCapabilityIds: ["gulong_engine.agent_chat"] };
  const models = [{ id: model, tools: false, multimodal: false }];
  const raw = { capability_id: "gulong_engine.agent_chat", capability_version: "1.0.0", protocol_version: CAPABILITY_ORDER_PROTOCOL,
    installed: true, enabled: true, validated: true, sharing_opt_in: true, max_concurrent: 1, models, default_model: model,
    validation: { tested_at: new Date(), artifact_sha256: "a".repeat(64), contract_tests: { exact_request: true, complete_response: true } } };
  const stores = new Map(), writes = [];
  const collection = (name) => {
    if (!stores.has(name)) {
      const rows = createCapabilityMemoryCollection();
      for (const method of ["insertOne", "updateOne", "updateMany", "findOneAndUpdate"]) {
        const original = rows[method].bind(rows); rows[method] = (...args) => { writes.push(name); return original(...args); };
      }
      stores.set(name, rows);
    }
    return stores.get(name);
  };
  collection("users").rows.push(requester, executor); collection("nodeAccountBindings").rows.push(binding);
  collection("capabilityNodeReports").rows.push({ _id: new ObjectId(), bindingId: binding._id, userId: executor._id, nodeId: binding.nodeId,
    protocolVersion: CAPABILITY_ORDER_PROTOCOL, capabilities: [normalizeCapabilityReport(raw)], reportedAt: new Date(), resources: { max_concurrent_tasks: 1, running_task_count: 0 } });
  const acceptance = () => approved ? { source: "automatic", models, defaultModel: model, testedAt: new Date(), artifactSha256: "A".repeat(64),
    contractTests: { exact_request: true, complete_response: true }, asrLanguages: [] } : null;
  const app = new OpenAPIHono();
  app.onError((error, c) => c.json({ code: error.code || "MEMORY_TEST_FAILURE", message: error.message }, error.status || 500));
  registerCapabilityOrderRoutes(app, { getCollection: async (name) => collection(name), getUserComputeGroupId: async (id) => String(id) === String(requester._id) ? requester.computeGroupId : binding.computeGroupId,
    enforceRateLimit: async () => ({ allowed: true }), requireTrustedMutation: () => null, readGulongEngineEntitlement: async () => ({ active }),
    findTrustedConsumerAcceptance: async () => acceptance(), automaticVerification: { findTrusted: async () => acceptance() },
    authenticate: async (c) => c.req.header("authorization") === "Bearer other" ? { kind: "desktop-gulong-engine", user: { id: String(new ObjectId()), role: "user" } }
      : c.req.header("authorization") === "Bearer english" ? { kind: "desktop-english", user: { id: String(requester._id), role: "user" } }
        : c.req.header("authorization") === "Bearer owner" ? { kind: "desktop-gulong-engine", user: { ...requester, id: String(requester._id) } }
          : { error: c.json({ code: "AUTH_REQUIRED" }, 401) },
  });
  const key = "digital-live:stable-request-01";
  const parameters = { model: DIGITAL_LIVE_TEXT_MODEL, request: { model: DIGITAL_LIVE_TEXT_MODEL, messages: [{ role: "user", content: "original prompt" }], max_tokens: 32, stream: false } };
  const body = { client_product: "digital_live", client_request_id: key, capability_id: "gulong_engine.agent_chat", capability_version: "1.0.0", source_channel: "desktop_agent", parameters, assets: [] };
  const call = async (path, data, { worker = false, account = "owner", headerKey } = {}) => {
    const response = await app.request(`http://localhost${path}`, { method: data === undefined ? "GET" : "POST", headers: {
      "Content-Type": "application/json", ...(worker ? { "X-Gulong-Account-Binding": token } : account ? { Authorization: `Bearer ${account}` } : {}),
      ...(headerKey ? { "Idempotency-Key": headerKey } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  const catalog = async () => {
    const result = await call("/api/v1/capability-orders/catalog?product=digital_live"); assert.equal(result.status, 200);
    return result.body.capabilities.find((item) => item.capability_id === "gulong_engine.agent_chat");
  };
  const resources = () => ({ gpu_state: "idle", gpu_observed_at: new Date().toISOString(), current_task_remaining_seconds: 0, running_task_count: 0, max_concurrent_tasks: 1 });
  const claim = () => call("/api/v1/capability-orders/claim", { protocol_version: CAPABILITY_ORDER_PROTOCOL, node_id: binding.nodeId, node_name: binding.nodeName, capabilities: [raw], resources: resources() }, { worker: true });
  const noAccounting = () => assert.equal(writes.some((name) => /wallet|ledger|payment|subscription|settlement/i.test(name)), false);
  return { app, key, body, call, catalog, claim, collection, requester, binding, noAccounting };
}

test("digital live config is a distinct included product, never an invented realtime endpoint or second SKU", async () => {
  const f = fixture(), result = await f.call("/api/v1/desktop/digital-live/config", undefined, { account: "" });
  assert.equal(result.status, 200); assert.equal(result.body.product, "digital_live");
  assert.equal(result.body.subscription.monthly_price_fen, 99900); assert.equal(result.body.subscription.separate_purchase, false);
  assert.equal(result.body.subscription.required_capability, "digital_live.use"); assert.equal(result.body.capability_orders.paid_fallback, false);
  assert.equal(result.body.realtime.status, "integration_required"); assert.equal(result.body.realtime.session_url, null);
  assert.equal(result.body.avatar.dispatchable, false); assert.deepEqual(result.body.capability_orders.capability_ids, DIGITAL_LIVE_CAPABILITY_IDS);
  assert.equal((await f.call("/api/v1/desktop/digital-live/config?product=worklucky")).status, 400);
  const document = f.app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "digital live only", version: "1" } });
  assert.ok(document.components.schemas.DigitalLiveSharedCapabilityContract);
  assert.ok(document.paths["/api/v1/desktop/digital-live/config"].get);
  assert.equal(digitalLiveConfig(99900).capability_orders.text_model, DIGITAL_LIVE_TEXT_MODEL);
});

test("the catalog counts only the exact requested automatically proved model, not another installed Qwen", async () => {
  const correct = await fixture().catalog(); assert.equal(correct.dispatchable, true); assert.equal(correct.availability.verified_node_count, 1);
  assert.deepEqual(correct.availability.models.map((model) => model.id), [DIGITAL_LIVE_TEXT_MODEL]);
  for (const options of [{ model: "Qwen3-1.7B" }, { approved: false }, { sameGroup: false }]) {
    const entry = await fixture(options).catalog(); assert.equal(entry.dispatchable, false); assert.equal(entry.availability.verified_node_count, 0);
    assert.deepEqual(entry.availability.models, []);
  }
  assert.equal(digitalLiveReport({ automaticVerification: false, trustedAcceptance: true, capabilityId: "gulong_engine.agent_chat", models: [{ id: DIGITAL_LIVE_TEXT_MODEL }] }), null);
  const base = { capabilityId: "gulong_engine.agent_chat", automaticVerification: true, trustedAcceptance: true };
  const atomic = digitalLiveAvailability(base.capabilityId, [{ ...base, models: [{ id: DIGITAL_LIVE_TEXT_MODEL, tools: true, multimodal: false }] },
    { ...base, models: [{ id: DIGITAL_LIVE_TEXT_MODEL, tools: false, multimodal: true }] }]);
  assert.equal(atomic.models.length, 2); assert.equal(atomic.models.some((model) => model.tools && model.multimodal), false);
});

test("digital-live native image and ASR filters never accept another model family and TTS must preserve a real model/voice pair", () => {
  const accepted = (capabilityId, models) => digitalLiveReport({ capabilityId, models, automaticVerification: true, trustedAcceptance: true });
  assert.deepEqual(accepted("qwen_image_2_1.text_to_image", [{ id: "zimage" }, { id: "qwen-image21-uc", width: 512 }]).models, [{ id: "qwen-image21-uc", width: 512 }]);
  assert.equal(accepted("whisper.transcribe", [{ id: "unverified-asr" }]), null);
  assert.equal(accepted("gulong_engine.tts", [{ id: "tts-no-voice" }]), null);
  const report = accepted("gulong_engine.tts", [{ id: "voice-model", voice_id: "voice-one" }]);
  const order = { clientProduct: "digital_live", capabilityId: "gulong_engine.tts", parameters: { model: "voice-model", voice_id: "voice-two", text: "test" } };
  assert.equal(digitalLiveNodeMatchesOrder(report, order), false);
  assert.equal(digitalLiveNodeMatchesOrder(report, { ...order, parameters: { ...order.parameters, voice_id: "voice-one" } }), true);
  assert.ok(digitalLiveParameterError(order.capabilityId, order.parameters, { text: "test" }));
});

test("digital live admission is zero-price, stable by client_request_id and isolated from WorkLucky and other accounts", async () => {
  const f = fixture(), created = await f.call("/api/v1/capability-orders", f.body);
  assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.order.client_product, "digital_live");
  assert.equal(created.body.order.client_request_id, f.key); assert.equal(created.body.order.billing.price_fen, 0);
  assert.equal(created.body.order.billing.charge_status, "exempt");
  const retry = await f.call("/api/v1/capability-orders", f.body); assert.equal(retry.body.idempotent, true); assert.equal(retry.body.order.id, created.body.order.id);
  const base = `/api/v1/capability-orders/by-request/${f.key}`;
  assert.equal((await f.call(`${base}?product=digital_live`)).body.order.id, created.body.order.id);
  assert.equal((await f.call(`${base}?product=worklucky`)).status, 409);
  assert.equal((await f.call(`${base}?product=digital_live`, undefined, { account: "other" })).status, 404);
  assert.equal((await f.call("/api/v1/capability-orders", { ...f.body, client_product: "worklucky" }, { headerKey: f.key })).status, 409);
  assert.equal(f.collection("capabilityOrders").rows.length, 1); f.noAccounting();
});

test("cancel-before-create preserves digital live identity and tombstone and never starts or bills a late request", async () => {
  const f = fixture(), cancelled = await f.call(`/api/v1/capability-orders/by-request/${f.key}/cancel`, { client_product: "digital_live" });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.order.cancellation_tombstone, true);
  assert.equal(cancelled.body.order.client_request_id, f.key);
  const late = await f.call("/api/v1/capability-orders", f.body); assert.equal(late.status, 201); assert.equal(late.body.order.status, "cancelled");
  assert.equal((await f.claim()).body.task, null); f.noAccounting();
});

test("inactive memberships, mismatched keys, wrong models and unproved consumers cannot create digital live orders", async () => {
  const expired = fixture({ active: false }); assert.equal((await expired.call("/api/v1/capability-orders", expired.body)).status, 403); expired.noAccounting();
  const unknown = fixture({ model: "Qwen3-1.7B" });
  assert.equal((await unknown.call("/api/v1/capability-orders", unknown.body)).body.code, "CAPABILITY_NO_COMPATIBLE_NODE");
  const f = fixture();
  assert.equal((await f.call("/api/v1/capability-orders", f.body, { headerKey: "different-original-request" })).status, 400);
  assert.equal((await f.call("/api/v1/capability-orders", { ...f.body, idempotency_key: "different-original-request" })).status, 400);
  const result = await f.call("/api/v1/capability-orders", { ...f.body, parameters: { model: "Qwen3-1.7B", request: { model: "Qwen3-1.7B", messages: [{ role: "user", content: "test" }] } } });
  assert.equal(result.status, 409); assert.equal(result.body.code, "DIGITAL_LIVE_MODEL_UNAVAILABLE");
  assert.equal((await f.call("/api/v1/capability-orders/catalog?product=digital_live", undefined, { account: "english" })).status, 403);
  for (const item of [expired, unknown, f]) { assert.equal(item.collection("capabilityOrders").rows.length, 0); item.noAccounting(); }
});

test("the shared node consumes digital live through the original fenced protocol and returns the complete result once", async () => {
  const f = fixture(), created = await f.call("/api/v1/capability-orders", f.body), claimed = await f.claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body)); assert.equal(claimed.body.task.id, created.body.order.id);
  assert.equal(claimed.body.task.client_product, "digital_live");
  assert.deepEqual(claimed.body.task.parameters, f.body.parameters);
  const task = claimed.body.task;
  const response = { id: "memory-not-model-run", object: "chat.completion", model: DIGITAL_LIVE_TEXT_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "whole result" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } };
  const event = { order_id: task.id, claim_id: task.claim_id, event_id: "digital-live-memory:completed", status: "completed", inline_result: { response }, outputs: [] };
  const completed = await f.call("/api/v1/capability-orders/callback", event, { worker: true });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal((await f.call("/api/v1/capability-orders/callback", event, { worker: true })).body.idempotent, true);
  const view = await f.call(`/api/v1/capability-orders/${task.id}?product=digital_live`);
  assert.deepEqual(view.body.order.inline_result.response, response); f.noAccounting();
  const order = f.collection("capabilityOrders").rows[0];
  assert.equal(digitalLiveNodeMatchesOrder({ capabilityId: order.capabilityId, trustedAcceptance: true, automaticVerification: true, models: [{ id: "Qwen3-1.7B" }] }, order), false);
});
