import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { hashOpaqueToken } from "../../server/security.js";
import { CAPABILITY_ORDER_PROTOCOL, capabilityNodeCanRunOrder, normalizeCapabilityReport, registerCapabilityOrderRoutes } from "../../server/capability-orders.js";

const idValue = (value) => value instanceof ObjectId ? String(value) : value instanceof Date ? +value : value;
const equal = (a, b) => idValue(a) === idValue(b) || (a == null && b == null);
function nested(row, key) {
  if (!row || !key) return row;
  const [part, ...rest] = key.split(".");
  if (Array.isArray(row)) return row.flatMap((item) => nested(item, key));
  return nested(row[part], rest.join("."));
}
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((entry) => matches(row, entry));
    const actual = nested(row, key);
    if (Array.isArray(actual) && !(value && typeof value === "object")) return actual.some((item) => equal(item, value));
    if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) return Object.entries(value).every(([op, expected]) => {
      if (op === "$in") return expected.some((item) => equal(actual, item));
      if (op === "$nin") return !expected.some((item) => equal(actual, item));
      if (op === "$gte") return idValue(actual) >= idValue(expected);
      if (op === "$gt") return idValue(actual) > idValue(expected);
      if (op === "$lte") return idValue(actual) <= idValue(expected);
      if (op === "$lt") return idValue(actual) < idValue(expected);
      throw new Error(`Unexpected operator ${op}`);
    });
    return equal(actual, value);
  });
}
function readyReport(capabilityId = "gulong_engine.text") {
  return { capability_id: capabilityId, capability_version: "1", protocol_version: CAPABILITY_ORDER_PROTOCOL,
    installed: true, validated: true, enabled: true, sharing_opt_in: true, max_concurrent: 2,
    validation: { tested_at: new Date().toISOString(), artifact_sha256: "A".repeat(64) } };
}
function fixture({ userGroup = "group-a", nodeGroup = "group-a", sameAccount = false, clientKind = "desktop-gulong-engine" } = {}) {
  const requester = { _id: new ObjectId(), status: "active", computeGroupId: userGroup };
  const executor = sameAccount ? requester : { _id: new ObjectId(), status: "active" };
  const token = `gab_${"G".repeat(48)}`;
  const binding = { _id: new ObjectId(), userId: executor._id, nodeId: "group-node-0001", status: "active", revokedAt: null,
    tokenHash: hashOpaqueToken(token, "h3-account-binding"), computeGroupId: nodeGroup };
  const rawReport = readyReport();
  const report = { bindingId: binding._id, userId: executor._id, nodeId: binding.nodeId, protocolVersion: CAPABILITY_ORDER_PROTOCOL,
    capabilities: [normalizeCapabilityReport(rawReport)], resources: { running_task_count: 0, max_concurrent_tasks: 2 }, reportedAt: new Date() };
  const rows = { users: sameAccount ? [requester] : [requester, executor], nodeAccountBindings: [binding], capabilityNodeReports: [report], capabilityOrders: [], capabilityOutputUploads: [], capabilityOrderCallbacks: [] };
  const hooks = {};
  const mutate = (row, update) => { Object.assign(row, update.$set || {}); for (const key of Object.keys(update.$unset || {})) delete row[key]; for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value; };
  const getCollection = async (name) => {
    rows[name] ||= [];
    return {
      findOne: async (query) => {
        await hooks.findOne?.(name, query);
        const row = rows[name].find((row) => matches(row, query)) || null;
        // Binding records read from Mongo are snapshots, not live objects.
        return name === "nodeAccountBindings" && row ? { ...row } : row;
      },
      find: (query) => {
        let values = rows[name].filter((row) => matches(row, query));
        const cursor = { sort(order) { values.sort((a, b) => { for (const [key, direction] of Object.entries(order)) { if (idValue(a[key]) < idValue(b[key])) return -direction; if (idValue(a[key]) > idValue(b[key])) return direction; } return 0; }); return this; }, limit(count) { values = values.slice(0, count); return this; }, toArray: async () => values };
        return cursor;
      },
      countDocuments: async (query) => { await hooks.countDocuments?.(name, query); return rows[name].filter((row) => matches(row, query)).length; },
      insertOne: async (row) => { rows[name].push(row); return { insertedId: row._id }; },
      updateOne: async (query, update) => { const row = rows[name].find((entry) => matches(entry, query)); if (row) mutate(row, update); return { matchedCount: row ? 1 : 0 }; },
      updateMany: async (query, update) => { rows[name].filter((row) => matches(row, query)).forEach((row) => mutate(row, update)); return {}; },
      findOneAndUpdate: async (query, update) => { const row = rows[name].find((entry) => matches(entry, query)); if (row) mutate(row, update); return row || null; },
    };
  };
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, { getCollection, authenticate: async () => ({ user: { ...requester, id: String(requester._id) }, kind: clientKind }),
    requireTrustedMutation: () => null, enforceRateLimit: async () => ({ allowed: true }), readGulongEngineEntitlement: async () => ({ active: hooks.membershipActive !== false }), readEnglishEntitlement: async () => ({ active: true }),
    createPresignedDownloadUrl: () => "https://cos.invalid/private-download", createPresignedPutUrl: () => "https://cos.invalid/private-upload" });
  const call = async (path, body, worker = false) => {
    const response = await app.request(`http://localhost/api/v1/capability-orders${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "group-order-0001", ...(worker ? { "X-Gulong-Account-Binding": token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const create = (extra = {}) => call("", { capability_id: "gulong_engine.text", parameters: { prompt: "测试分组" }, ...extra });
  const claim = (extra = {}) => call("/claim", { node_id: binding.nodeId, protocol_version: CAPABILITY_ORDER_PROTOCOL, capabilities: [rawReport], resources: { running_task_count: 0, estimated_total_seconds: 0, max_concurrent_tasks: 2 }, ...extra }, true);
  return { rows, requester, executor, binding, call, create, claim, hooks };
}

test("all capability scheduling uses exact group equality including ungrouped nodes", () => {
  const capability = normalizeCapabilityReport(readyReport());
  const node = { availableSlots: 1, binding: { computeGroupId: "group-a" }, capabilities: [capability] };
  assert.equal(capabilityNodeCanRunOrder(node, { capabilityId: capability.capabilityId, computeGroupId: "group-b" }), false);
  assert.equal(capabilityNodeCanRunOrder(node, { capabilityId: capability.capabilityId, computeGroupId: null }), false);
  assert.equal(capabilityNodeCanRunOrder(node, { capabilityId: capability.capabilityId, computeGroupId: "group-a" }), true);
  assert.equal(capabilityNodeCanRunOrder({ ...node, binding: {} }, { capabilityId: capability.capabilityId }), true);
});

test("capability catalog hides other-group nodes and creation ignores client group spoofing", async () => {
  const f = fixture({ nodeGroup: "group-b" });
  const catalog = await f.call("/catalog");
  const text = catalog.body.capabilities.find((item) => item.capability_id === "gulong_engine.text");
  assert.deepEqual(text.availability, { verified_node_count: 0, free_slot_count: 0, status: "offline" });
  assert.equal((await f.create({ computeGroupId: "group-b" })).status, 409);
  assert.equal(f.rows.capabilityOrders.length, 0);
  f.binding.computeGroupId = "group-a";
  const created = await f.create({ computeGroupId: "group-b" });
  assert.equal(created.status, 201);
  assert.equal(f.rows.capabilityOrders[0].computeGroupId, "group-a");
});

test("a user's own preferred capability node is still rejected when its group differs", async () => {
  const f = fixture({ sameAccount: true, nodeGroup: "group-b" });
  const denied = await f.create({ preferred_node_id: f.binding.nodeId });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "COMPUTE_GROUP_MISMATCH");
  assert.equal(f.rows.capabilityOrders.length, 0);
  f.binding.computeGroupId = "group-a";
  assert.equal((await f.create({ preferred_node_id: f.binding.nodeId })).status, 201);
});

test("legacy image capability catalogs cannot advertise an own-account node from another group", async () => {
  const f = fixture({ sameAccount: true, nodeGroup: "group-b", clientKind: "session" });
  f.rows.capabilityNodeReports[0].capabilities.push(normalizeCapabilityReport(readyReport("qwen_image_2_1.text_to_image")));
  const capabilities = (await f.call("/catalog")).body.capabilities;
  const image = capabilities.find((item) => item.capability_id === "qwen_image_2_1.text_to_image");
  assert.equal(image.dispatchable, false);
  assert.equal(image.availability.verified_node_count, 0);
  f.binding.computeGroupId = "group-a";
  const ready = (await f.call("/catalog")).body.capabilities.find((item) => item.capability_id === image.capability_id);
  assert.equal(ready.dispatchable, true);
  assert.equal(ready.availability.verified_node_count, 1);
});

test("capability claims reject a mismatched current user group and preserve compatible FIFO", async () => {
  const f = fixture();
  const created = await f.create();
  const order = f.rows.capabilityOrders[0];
  f.requester.computeGroupId = "group-b";
  assert.equal((await f.claim({ compute_group_id: "group-a" })).body.task, null);
  assert.equal(order.status, "queued");
  f.requester.computeGroupId = "group-a";
  const claimed = await f.claim();
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.task.id, created.body.order.id);
});

test("ungrouped capability users only use ungrouped bindings", async () => {
  const f = fixture({ userGroup: null, nodeGroup: "group-a" });
  assert.equal((await f.create()).status, 409);
  f.binding.computeGroupId = null;
  assert.equal((await f.create()).status, 201);
  f.binding.computeGroupId = "group-a";
  assert.equal((await f.claim()).body.task, null);
  delete f.binding.computeGroupId;
  assert.ok((await f.claim()).body.task);
});

test("LAN load reports cannot use a different group's faster node or spoof its persisted group", async () => {
  const f = fixture({ sameAccount: true });
  const lanBinding = { ...f.binding, _id: new ObjectId(), nodeId: "faster-lan-node-0002", computeGroupId: "group-b" };
  f.rows.nodeAccountBindings.push(lanBinding);
  await f.create();
  const claimed = await f.claim({ resources: { running_task_count: 0, estimated_total_seconds: 100, max_concurrent_tasks: 2 },
    lan_cluster: { nodes: [{ node_id: lanBinding.nodeId, compute_group_id: "group-a", capabilities: [readyReport()],
      resources: { running_task_count: 0, estimated_total_seconds: 0, max_concurrent_tasks: 2 } }] } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.task.assigned_node.node_id, f.binding.nodeId);
});

test("capability callback, output presign, and worker state reject group changes before issuing tickets or events", async () => {
  const f = fixture();
  await f.create();
  const claimed = (await f.claim()).body.task;
  assert.ok(claimed);
  f.binding.computeGroupId = "group-b";
  const callback = await f.call("/callback", { order_id: claimed.id, claim_id: claimed.claim_id, event_id: "group-progress-0001", status: "progress", progress: 10 }, true);
  assert.equal(callback.status, 403);
  assert.equal(callback.body.code, "COMPUTE_GROUP_MISMATCH");
  const presign = await f.call(`/${claimed.id}/outputs/presign`, { claim_id: claimed.claim_id, role: "result_text", filename: "result.txt", content_type: "text/plain", bytes: 10, sha256: "A".repeat(64) }, true);
  assert.equal(presign.status, 403);
  assert.equal(presign.body.code, "COMPUTE_GROUP_MISMATCH");
  const state = await f.call(`/${claimed.id}/worker-state?claim_id=${claimed.claim_id}`, undefined, true);
  assert.equal(state.status, 403);
  assert.equal(state.body.code, "COMPUTE_GROUP_MISMATCH");
  assert.equal(f.rows.capabilityOutputUploads.length, 0);
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
  assert.equal(f.rows.capabilityOrders[0].status, "claimed");
});

test("callback rejects a changed order snapshot even if the user and node now share the new group", async () => {
  const f = fixture();
  await f.create();
  const claimed = (await f.claim()).body.task;
  f.requester.computeGroupId = "group-b";
  f.binding.computeGroupId = "group-b";
  const response = await f.call("/callback", { order_id: claimed.id, claim_id: claimed.claim_id, event_id: "snapshot-progress-0001", status: "progress", progress: 10 }, true);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "COMPUTE_GROUP_MISMATCH");
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
});

test("output presign refreshes the binding after intermediate storage reads", async () => {
  const f = fixture({ sameAccount: true, clientKind: "session" });
  await f.call("", { capability_id: "qwen_image_2_1.text_to_image", parameters: { prompt: "测试输出" } });
  const claimed = (await f.claim({ capabilities: [readyReport("qwen_image_2_1.text_to_image")] })).body.task;
  f.hooks.countDocuments = (name) => { if (name === "capabilityOutputUploads") f.binding.computeGroupId = "group-b"; };
  const response = await f.call(`/${claimed.id}/outputs/presign`, { claim_id: claimed.claim_id, role: "primary_image", filename: "result.png", content_type: "image/png", bytes: 10, sha256: "A".repeat(64) }, true);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "COMPUTE_GROUP_MISMATCH");
  assert.equal(f.rows.capabilityOutputUploads.length, 0);
});

test("callback refreshes changed or revoked bindings before writing its event", async () => {
  for (const revoke of [false, true]) {
    const f = fixture();
    await f.create();
    const claimed = (await f.claim()).body.task;
    f.hooks.findOne = (name) => {
      if (name === "capabilityOrderCallbacks") {
        if (revoke) f.binding.revokedAt = new Date();
        else f.binding.computeGroupId = "group-b";
      }
    };
    const response = await f.call("/callback", { order_id: claimed.id, claim_id: claimed.claim_id, event_id: "fresh-progress-0001", status: "progress", progress: 10 }, true);
    assert.equal(response.status, revoke ? 401 : 403);
    assert.equal(response.body.code, revoke ? "INVALID_ACCOUNT_BINDING" : "COMPUTE_GROUP_MISMATCH");
    assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
    assert.equal(f.rows.capabilityOrders[0].status, "claimed");
  }
});

test("grouped generic capability orders require membership while ungrouped private orders retain their contract", async () => {
  const f = fixture({ sameAccount: true, clientKind: "session" });
  f.hooks.membershipActive = false;
  const input = { capability_id: "qwen_image_2_1.text_to_image", parameters: { prompt: "一幅山水" } };
  const denied = await f.call("", input);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "GULONG_ENGINE_SUBSCRIPTION_REQUIRED");
  assert.equal(f.rows.capabilityOrders.length, 0);
  f.requester.computeGroupId = null;
  f.binding.computeGroupId = null;
  assert.equal((await f.call("", input)).status, 201);
  assert.ok((await f.claim({ capabilities: [readyReport("qwen_image_2_1.text_to_image")] })).body.task);
});

test("grouped queued orders stop dispatch after membership expires, but claimed callbacks can finish", async () => {
  const f = fixture();
  await f.create();
  f.hooks.membershipActive = false;
  const stopped = await f.claim();
  assert.equal(stopped.body.task, null);
  assert.equal(f.rows.capabilityOrders[0].status, "cancelled");
  const executing = fixture();
  await executing.create();
  const claimed = (await executing.claim()).body.task;
  executing.hooks.membershipActive = false;
  const accepted = await executing.call("/callback", { order_id: claimed.id, claim_id: claimed.claim_id, event_id: "expired-progress-0001", status: "progress", progress: 10 }, true);
  assert.equal(accepted.status, 200);
  assert.equal(executing.rows.capabilityOrders[0].status, "processing");
});

test("same-group historical English shared nodes retain their own sharing scope", async () => {
  const f = fixture({ clientKind: "session" });
  const order = { _id: new ObjectId(), requesterUserId: f.requester._id, orderNo: "CAP-ENGLISH-GROUP-1", capabilityId: "english_coach.speech",
    protocolVersion: CAPABILITY_ORDER_PROTOCOL, computeGroupId: "group-a", sharingScope: "english_shared",
    parameters: { text: "Hello", locale: "en-US", output_format: "wav" }, assets: [], status: "queued", stage: "queued",
    createdAt: new Date(Date.now() - 60_000), nextEligibleAt: new Date(Date.now() - 60_000), autoCancelAt: new Date(Date.now() + 60_000), attempt: 0, maxAttempts: 2 };
  f.rows.capabilityOrders.push(order);
  const claimed = await f.claim({ capabilities: [readyReport("english_coach.speech")] });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.task.id, String(order._id));
  assert.equal(claimed.body.task.capability_id, "english_coach.speech");
});

test("administrator capability orders retain the membership exemption but cannot cross groups", async () => {
  const f = fixture({ sameAccount: true, nodeGroup: "group-b" });
  f.requester.role = "admin";
  f.hooks.membershipActive = false;
  const denied = await f.create({ preferred_node_id: f.binding.nodeId });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "COMPUTE_GROUP_MISMATCH");
  f.binding.computeGroupId = "group-a";
  assert.equal((await f.create({ preferred_node_id: f.binding.nodeId })).status, 201);
  assert.ok((await f.claim()).body.task);
});
