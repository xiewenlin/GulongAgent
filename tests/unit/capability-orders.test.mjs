import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import {
  CAPABILITY_ORDER_DEFINITIONS,
  CAPABILITY_ORDER_PROTOCOL,
  capabilityNodeCanRunOrder,
  normalizeCapabilityParameters,
  normalizeCapabilityReport,
  registerCapabilityOrderRoutes,
  validateCapabilityInput,
} from "../../server/capability-orders.js";

const READY_REPORT = () => ({
  capability_id: "qwen_image_2_1.text_to_image",
  capability_version: "2.1",
  protocol_version: CAPABILITY_ORDER_PROTOCOL,
  installed: true,
  validated: true,
  enabled: true,
  max_concurrent: 2,
  validation: {
    tested_at: new Date().toISOString(),
    artifact_sha256: "A".repeat(64),
    runtime_version: "local-runtime-1",
    test_id: "real-inference-smoke-1",
  },
});

test("unified capability catalog registers callable services but keeps H3 on the legacy route", () => {
  assert.equal(CAPABILITY_ORDER_PROTOCOL, "gulong-capability-orders-v1");
  const ids = new Set(CAPABILITY_ORDER_DEFINITIONS.map((item) => item.capabilityId));
  for (const id of [
    "qwen_image_2_1.text_to_image",
    "qwen_image_2_1.multi_image_edit",
    "minimax_music_3.generate",
    "yue_2.generate",
    "breeze_tts_2.synthesize",
    "whisper.transcribe",
    "sam.segment",
    "sam.video_track",
    "mediapipe.pose_track",
    "mediapipe.video_analysis",
    "dwpose.estimate",
    "prompt.optimize_translate",
    "minimax_h3.video_generation",
  ]) assert.ok(ids.has(id), id);
  const h3 = CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === "minimax_h3.video_generation");
  assert.equal(h3.legacyRoute, "/api/h3/tasks");
  assert.equal(CAPABILITY_ORDER_DEFINITIONS.every((item) => item.priceFen === 0), true);
  assert.equal(ids.has("orientation-detector"), false);
  assert.equal(CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === "yue_2.generate").commercialUse, "license_review_required");
  assert.equal(CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === "breeze_tts_2.synthesize").commercialUse, "license_review_required");
  for (const id of ["sam.segment", "mediapipe.pose_track", "dwpose.estimate", "breeze_tts_2.synthesize"]) {
    assert.equal(CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === id).dispatchable, false, id);
  }
  assert.equal(CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === "sam.video_track").dispatchable, true);
  assert.equal(CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === "mediapipe.video_analysis").dispatchable, true);
});

test("each callable capability publishes a strict versioned parameter, asset and output contract", () => {
  for (const capability of CAPABILITY_ORDER_DEFINITIONS.filter((item) => !item.legacyRoute && item.dispatchable)) {
    assert.equal(capability.parametersSchemaVersion, "1.0.0", capability.capabilityId);
    assert.equal(capability.parametersSchema.type, "object", capability.capabilityId);
    assert.equal(capability.parametersSchema.additionalProperties, false, capability.capabilityId);
    assert.ok(Array.isArray(capability.assetRules), capability.capabilityId);
    assert.ok(Array.isArray(capability.outputRules) && (capability.outputRules.length || capability.inlineResult), capability.capabilityId);
    for (const rule of [...capability.assetRules, ...capability.outputRules]) {
      assert.match(rule.role, /^[a-z][a-z0-9_]*$/);
      assert.ok(rule.max >= rule.min);
      assert.ok(rule.maxBytes > 0);
      assert.ok(rule.mimeTypes.length > 0);
    }
  }
  const qwen = CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === "qwen_image_2_1.text_to_image");
  const normalized = normalizeCapabilityParameters({ prompt: "山海之间的机械龙" }, qwen);
  assert.equal(normalized.width, 1024);
  assert.equal(normalized.steps, 30);
  assert.equal(normalized.seed, -1);
  assert.throws(() => normalizeCapabilityParameters({ prompt: "test", hidden_runtime_flag: true }, qwen), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
  assert.throws(() => normalizeCapabilityParameters({ prompt: "test", steps: 101 }, qwen), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
});

test("asset roles, mime types and counts are capability specific", () => {
  const edit = CAPABILITY_ORDER_DEFINITIONS.find((item) => item.capabilityId === "qwen_image_2_1.multi_image_edit");
  const parameters = normalizeCapabilityParameters({ prompt: "换成夜景" }, edit);
  const image = { assetId: "asset-a", role: "reference_image", contentType: "image/png", bytes: 1024 };
  assert.doesNotThrow(() => validateCapabilityInput(edit, parameters, [image]));
  assert.throws(() => validateCapabilityInput(edit, parameters, []), (error) => error.code === "INVALID_INPUT_ROLE_COUNT");
  assert.throws(() => validateCapabilityInput(edit, parameters, [{ ...image, role: "source_video" }]), (error) => error.code === "UNSUPPORTED_INPUT_ROLE");
  assert.throws(() => validateCapabilityInput(edit, parameters, [{ ...image, contentType: "video/mp4" }]), (error) => error.code === "UNSUPPORTED_INPUT_MIME");
});

test("only installed, recently validated and enabled capabilities enter scheduling", () => {
  const report = normalizeCapabilityReport(READY_REPORT());
  assert.equal(report.installed, true);
  assert.equal(report.validated, true);
  assert.equal(report.enabled, true);
  assert.equal(report.capabilityId, "qwen_image_2_1.text_to_image");
  for (const field of ["installed", "validated", "enabled"]) {
    const invalid = READY_REPORT();
    invalid[field] = false;
    assert.throws(() => normalizeCapabilityReport(invalid), (error) => error.code === "CAPABILITY_NOT_READY");
  }
  const stale = READY_REPORT();
  stale.validation.tested_at = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
  assert.throws(() => normalizeCapabilityReport(stale), (error) => error.code === "CAPABILITY_VALIDATION_EXPIRED");
  const accessory = READY_REPORT();
  accessory.capability_id = "model-bin-volume";
  assert.throws(() => normalizeCapabilityReport(accessory), (error) => error.code === "UNKNOWN_CAPABILITY");
  const wrongProtocol = READY_REPORT();
  wrongProtocol.protocol_version = "gulong-capability-orders-v0";
  assert.throws(() => normalizeCapabilityReport(wrongProtocol), (error) => error.code === "PROTOCOL_VERSION_UNSUPPORTED");
  const adapterRequired = READY_REPORT();
  adapterRequired.capability_id = "dwpose.estimate";
  assert.throws(() => normalizeCapabilityReport(adapterRequired), (error) => error.code === "CAPABILITY_ADAPTER_REQUIRED");
});

test("scheduler respects the requested capability, free slots and preferred node", () => {
  const ready = normalizeCapabilityReport(READY_REPORT());
  const node = { nodeId: "same-account-node-a", availableSlots: 1, capabilities: [ready] };
  assert.equal(capabilityNodeCanRunOrder(node, { capabilityId: ready.capabilityId }), true);
  assert.equal(capabilityNodeCanRunOrder({ ...node, availableSlots: 0 }, { capabilityId: ready.capabilityId }), false);
  assert.equal(capabilityNodeCanRunOrder(node, { capabilityId: ready.capabilityId, preferredNodeId: "same-account-node-b" }), false);
});

test("OpenAPI publishes the versioned create, claim, output and callback contracts", () => {
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    authenticate: async () => ({ error: new Response("unauthorized", { status: 401 }) }),
    requireTrustedMutation: () => null,
  });
  const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  for (const [path, method] of [
    ["/api/v1/capability-orders/catalog", "get"],
    ["/api/v1/capability-assets/presign", "post"],
    ["/api/v1/capability-assets/{id}/complete", "post"],
    ["/api/v1/capability-orders", "post"],
    ["/api/v1/capability-orders/{id}", "get"],
    ["/api/v1/capability-orders/{id}/cancel", "post"],
    ["/api/v1/capability-orders/{id}/worker-state", "get"],
    ["/api/v1/capability-orders/claim", "post"],
    ["/api/v1/capability-orders/{id}/outputs/presign", "post"],
    ["/api/v1/capability-orders/callback", "post"],
  ]) assert.ok(document.paths[path]?.[method], `${method.toUpperCase()} ${path}`);
  assert.match(document.paths["/api/v1/capability-orders/claim"].post.description, /installed=true/);
  assert.match(document.paths["/api/v1/capability-orders/callback"].post.description, /续租 300 秒/);
  assert.match(document.paths["/api/v1/capability-orders/{id}/outputs/presign"].post.description, /required_headers/);
});

test("claim dry-run validates a real capability report without touching the order queue", async () => {
  const userId = new ObjectId();
  const binding = { _id: new ObjectId(), userId, nodeId: "stable-capability-node-0001", nodeName: "本机创作节点", status: "active", revokedAt: null };
  let queueReads = 0;
  const collections = {
    nodeAccountBindings: { findOne: async () => binding },
    users: { findOne: async () => ({ _id: userId, status: "active" }) },
    capabilityNodeReports: { updateOne: async () => ({ modifiedCount: 1 }) },
    capabilityOrders: { find: () => { queueReads += 1; throw new Error("dry-run must not read queue"); } },
  };
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => collections[name],
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Response("unused", { status: 401 }) }),
    requireTrustedMutation: () => null,
  });
  const response = await app.request("http://localhost/api/v1/capability-orders/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gulong-Account-Binding": `gab_${"A".repeat(48)}` },
    body: JSON.stringify({ protocol_version: CAPABILITY_ORDER_PROTOCOL, node_id: binding.nodeId, node_name: binding.nodeName, dry_run: true, capabilities: [READY_REPORT()], resources: { running_task_count: 0, estimated_total_seconds: 0, max_concurrent_tasks: 2 } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.queue, "reachable");
  assert.deepEqual(payload.eligible_capability_ids, ["qwen_image_2_1.text_to_image"]);
  assert.equal(queueReads, 0);
});

test("worker state exposes cancellation and output presign returns the complete PUT contract", async () => {
  const userId = new ObjectId();
  const orderId = new ObjectId();
  const binding = { _id: new ObjectId(), userId, nodeId: "stable-capability-node-0002", nodeName: "执行节点", status: "active", revokedAt: null };
  const baseOrder = { _id: orderId, requesterUserId: userId, assignedNode: { nodeId: binding.nodeId }, claimId: "claim-0000000000000001", status: "processing", capabilityId: "qwen_image_2_1.text_to_image", claimLeaseUntil: new Date(Date.now() + 240_000) };
  let insertedOutput = null;
  const collections = {
    nodeAccountBindings: { findOne: async () => binding },
    users: { findOne: async () => ({ _id: userId, status: "active" }) },
    capabilityOrders: { findOne: async () => baseOrder },
    capabilityOutputUploads: { countDocuments: async () => 0, insertOne: async (value) => { insertedOutput = value; return { insertedId: new ObjectId() }; } },
  };
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => collections[name],
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Response("unused", { status: 401 }) }),
    requireTrustedMutation: () => null,
    createPresignedPutUrl: () => "https://cos.invalid/signed-put",
  });
  const headers = { "Content-Type": "application/json", "X-Gulong-Account-Binding": `gab_${"B".repeat(48)}` };
  const stateResponse = await app.request(`http://localhost/api/v1/capability-orders/${orderId}/worker-state?claim_id=${baseOrder.claimId}`, { headers });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.should_stop, false);
  assert.equal(state.next_poll_after_seconds, 15);
  const outputResponse = await app.request(`http://localhost/api/v1/capability-orders/${orderId}/outputs/presign`, {
    method: "POST",
    headers,
    body: JSON.stringify({ claim_id: baseOrder.claimId, role: "primary_image", filename: "result.png", content_type: "image/png", bytes: 12345, sha256: "C".repeat(64) }),
  });
  assert.equal(outputResponse.status, 201);
  const ticket = await outputResponse.json();
  assert.equal(ticket.method, "PUT");
  assert.equal(ticket.upload_url, "https://cos.invalid/signed-put");
  assert.equal(ticket.expires_in_seconds, 3600);
  assert.deepEqual(ticket.required_headers, ticket.headers);
  assert.equal(ticket.complete_via.output_reference.output_id, ticket.output_id);
  assert.equal(insertedOutput.role, "primary_image");
});

test("new progress callbacks renew the assigned claim lease for exactly five minutes", async () => {
  const userId = new ObjectId();
  const orderId = new ObjectId();
  const binding = { _id: new ObjectId(), userId, nodeId: "stable-capability-node-0003", status: "active", revokedAt: null };
  const order = { _id: orderId, requesterUserId: userId, assignedNode: { nodeId: binding.nodeId }, claimId: "claim-0000000000000002", status: "claimed", capabilityId: "qwen_image_2_1.text_to_image", claimLeaseUntil: new Date(Date.now() + 60_000), attempt: 1, maxAttempts: 2, etaSeconds: 180 };
  let renewal = null;
  const callbacks = { findOne: async () => null, insertOne: async () => ({ insertedId: new ObjectId() }), updateOne: async () => ({ modifiedCount: 1 }) };
  const collections = {
    nodeAccountBindings: { findOne: async () => binding },
    users: { findOne: async () => ({ _id: userId, status: "active" }) },
    capabilityOrders: {
      findOne: async () => order,
      findOneAndUpdate: async (_filter, update) => {
        renewal = update.$set.claimLeaseUntil;
        return { ...order, ...update.$set };
      },
    },
    capabilityOrderCallbacks: callbacks,
  };
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => collections[name],
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Response("unused", { status: 401 }) }),
    requireTrustedMutation: () => null,
  });
  const before = Date.now();
  const response = await app.request("http://localhost/api/v1/capability-orders/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gulong-Account-Binding": `gab_${"D".repeat(48)}` },
    body: JSON.stringify({ order_id: orderId.toString(), claim_id: order.claimId, event_id: "job-0001:progress:1", status: "progress", stage: "inference", progress: 25, elapsed_seconds: 30, eta_seconds: 90 }),
  });
  assert.equal(response.status, 200);
  assert.ok(renewal instanceof Date);
  assert.ok(renewal.getTime() >= before + 299_000 && renewal.getTime() <= Date.now() + 301_000);
});

test("worker DTO and database indexes keep requester privacy and callback idempotency", async () => {
  const [source, db] = await Promise.all([
    readFile(new URL("../../server/capability-orders.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
  ]);
  const worker = source.slice(source.indexOf("function workerOrder"), source.indexOf("export function registerCapabilityOrderRoutes"));
  assert.doesNotMatch(worker, /requester|email|priceFen|chargeStatus|wallet/i);
  assert.match(worker, /assigned_node/);
  assert.match(worker, /output_upload/);
  assert.match(source, /requesterUserId: auth\.user\._id/);
  assert.match(source, /issuedToBindingId: auth\.binding\._id/);
  assert.match(source, /OUTPUT_RECEIPT_MISMATCH/);
  assert.match(db, /uniq_capability_order_callback_event/);
  assert.match(db, /uniq_capability_order_idempotency/);
});
