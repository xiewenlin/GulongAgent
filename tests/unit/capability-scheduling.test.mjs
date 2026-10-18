import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { hashOpaqueToken } from "../../server/security.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { CAPABILITY_ORDER_PROTOCOL, normalizeCapabilityReport, registerCapabilityOrderRoutes } from "../../server/capability-orders.js";
import { SHARED_NODE_SCHEDULING, normalizeGpuLoadReport, projectSharedNodeLoad, compareSharedNodeLoad, boundedGlobalDispatchWait } from "../../server/shared-node-scheduler.js";

// No disk fixtures, database connections, sockets, model requests or build output.
const NOW = new Date("2026-10-18T00:00:00Z");
const gpu = (state, remaining = 0, now = new Date()) => ({ gpu_state: state, gpu_observed_at: now.toISOString(),
  current_task_remaining_seconds: remaining, estimated_total_seconds: remaining, running_task_count: 0, max_concurrent_tasks: 4 });
const rawCapability = () => ({ capability_id: "gulong_engine.text", protocol_version: CAPABILITY_ORDER_PROTOCOL,
  capability_version: "1", installed: true, validated: true, enabled: true, sharing_opt_in: true, max_concurrent: 4,
  validation: { tested_at: new Date().toISOString(), artifact_sha256: "A".repeat(64) } });

test("GPU state requires explicit fresh observation and validates all new resource fields", () => {
  assert.equal(normalizeGpuLoadReport({}, NOW).gpu_state, "unknown");
  assert.equal(normalizeGpuLoadReport({}, NOW).current_task_remaining_seconds, null);
  assert.equal(normalizeGpuLoadReport({ gpu_state: "idle" }, NOW).gpu_state, "unknown");
  assert.equal(normalizeGpuLoadReport(gpu("idle", 0, NOW), NOW).gpu_state, "idle");
  assert.equal(normalizeGpuLoadReport(gpu("idle", 0, new Date(+NOW - 30_001)), NOW).gpu_state, "unknown");
  for (const resources of [null, [], { gpu_state: "free" }, { gpu_observed_at: "bad" },
    { gpu_state: "idle", gpu_observed_at: +NOW },
    gpu("idle", 0, new Date(+NOW + 5_001)), { current_task_remaining_seconds: -1 },
    { current_task_remaining_seconds: 1.5 }, { current_task_remaining_seconds: 2678401 }]) {
    assert.throws(() => normalizeGpuLoadReport(resources, NOW), { code: "INVALID_GPU_LOAD_REPORT", status: 400 });
  }
  assert.equal(normalizeGpuLoadReport({ estimated_total_seconds: 123 }, NOW).current_task_remaining_seconds, 123);
  assert.equal(normalizeGpuLoadReport({ current_task_remaining_seconds: null, estimated_total_seconds: 0 }, NOW).current_task_remaining_seconds, null);
});

test("dispatch ranks fresh idle first; otherwise ranks shortest total remaining work", () => {
  const node = (nodeId, state, remaining) => projectSharedNodeLoad({ nodeId, resources: gpu(state, remaining, NOW), runningTaskCount: 0 }, {}, NOW);
  assert.deepEqual([node("busy-short", "busy", 1), node("idle-long", "idle", 999), node("unknown", "unknown", 30)]
    .sort(compareSharedNodeLoad).map((item) => item.nodeId), ["idle-long", "busy-short", "unknown"]);
  assert.deepEqual([node("busy-long", "busy", 90), node("unknown-short", "unknown", 5)]
    .sort(compareSharedNodeLoad).map((item) => item.nodeId), ["unknown-short", "busy-long"]);
  const unknownEta = projectSharedNodeLoad({ nodeId: "missing-eta", resources: {} }, {}, NOW);
  assert.equal(unknownEta.estimatedTotalSeconds, Infinity);
  assert.deepEqual([unknownEta, node("known-busy", "busy", 600)].sort(compareSharedNodeLoad).map((item) => item.nodeId),
    ["known-busy", "missing-eta"]);
});

test("new server reservations immediately change idle status and projected workload without double-counting", () => {
  const node = { nodeId: "a", resources: gpu("idle", 20, NOW), runningTaskCount: 0 };
  const projected = projectSharedNodeLoad(node, { activeCount: 2, leases: [
    { createdAt: new Date(+NOW - 10_000), estimatedSeconds: 40 },
    { createdAt: NOW, estimatedSeconds: 60 },
  ] }, NOW);
  assert.equal(projected.gpuState, "busy");
  assert.equal(projected.estimatedTotalSeconds, 90);
  assert.equal(projected.runningTaskCount, 2);
  assert.equal(projectSharedNodeLoad({ ...node, resources: gpu("busy", 200, NOW) }, { activeCount: 1,
    leases: [{ createdAt: NOW, estimatedSeconds: 60 }] }, NOW).estimatedTotalSeconds, 200);
  // A CPU task list does not imply that an explicitly idle GPU is occupied.
  assert.equal(projectSharedNodeLoad({ ...node, runningTaskCount: 2 }, {}, NOW).gpuState, "idle");
  assert.equal(projectSharedNodeLoad({ ...node, availableSlots: 8 }, { activeCount: 1,
    leases: [{ createdAt: NOW, estimatedSeconds: 900, exclusive: true }] }, NOW).availableSlots, 0);
  const earlierSnapshot = { ...node, resources: gpu("busy", 20, new Date(+NOW - 1_000)) };
  assert.equal(projectSharedNodeLoad(earlierSnapshot, { activeCount: 2, leases: [
    { createdAt: new Date(+NOW - 2_000), estimatedSeconds: 10 }, // Already in the 20-second snapshot.
    { createdAt: NOW, estimatedSeconds: 60 }, // New reservation, not in that snapshot.
  ] }, NOW).estimatedTotalSeconds, 80);
});

test("global preference is bounded and cannot be extended by repeated polls", () => {
  const initial = boundedGlobalDispatchWait({}, NOW);
  assert.equal(initial.shouldWait, true);
  const order = { schedulerWaitStartedAt: initial.startedAt };
  assert.equal(boundedGlobalDispatchWait(order, new Date(+NOW + 4_999)).shouldWait, true);
  assert.equal(boundedGlobalDispatchWait(order, new Date(+NOW + 5_000)).shouldWait, false);
});

function fixture({ automaticVerification } = {}) {
  const requester = { _id: new ObjectId(), status: "active", computeGroupId: "group-a" };
  const owner = { _id: new ObjectId(), status: "active" };
  const otherOwner = { _id: new ObjectId(), status: "active" };
  const makeBinding = (user, nodeId, letter) => ({ _id: new ObjectId(), userId: user._id, nodeId,
    computeGroupId: "group-a", status: "active", revokedAt: null,
    tokenHash: hashOpaqueToken(`gab_${letter.repeat(48)}`, "h3-account-binding") });
  const local = makeBinding(owner, "local-busy-node", "L");
  const remote = makeBinding(otherOwner, "remote-idle-node", "R");
  const collections = new Map();
  const reads = [];
  const collection = (name) => {
    if (!collections.has(name)) {
      const instance = createCapabilityMemoryCollection();
      for (const method of ["find", "findOne"]) {
        const original = instance[method].bind(instance);
        instance[method] = (...args) => { reads.push({ name, method, query: args[0] }); return original(...args); };
      }
      collections.set(name, instance);
    }
    return collections.get(name);
  };
  collection("users").rows.push(requester, owner, otherOwner);
  collection("nodeAccountBindings").rows.push(local, remote);
  const now = new Date();
  const report = { bindingId: remote._id, userId: remote.userId, nodeId: remote.nodeId,
    protocolVersion: CAPABILITY_ORDER_PROTOCOL, capabilities: [normalizeCapabilityReport(rawCapability())],
    resources: gpu("idle", 0, now), reportedAt: now };
  collection("capabilityNodeReports").rows.push(report);
  const order = { _id: new ObjectId(), orderNo: "CAP-SCHEDULER-1", requesterUserId: requester._id,
    computeGroupId: "group-a", capabilityId: "gulong_engine.text", protocolVersion: CAPABILITY_ORDER_PROTOCOL,
    sharingScope: "gulong_shared", status: "queued", assets: [], parameters: { prompt: "测试调度" },
    createdAt: new Date(+now - 60_000), nextEligibleAt: now, autoCancelAt: new Date(+now + 600_000), etaSeconds: 60, attempt: 0 };
  collection("capabilityOrders").rows.push(order);
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, { getCollection: async (name) => collection(name),
    enforceRateLimit: async () => ({ allowed: true }), readGulongEngineEntitlement: async () => ({ active: true }),
    authenticate: async () => ({ error: new Response("unused", { status: 401 }) }), requireTrustedMutation: () => null,
    ...(automaticVerification ? { automaticVerification } : {}) });
  const claim = async (binding = local, resources = gpu("busy", 20), extra = {}) => {
    const response = await app.request("http://localhost/api/v1/capability-orders/claim", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Gulong-Account-Binding": `gab_${(binding === local ? "L" : "R").repeat(48)}` },
      body: JSON.stringify({ protocol_version: CAPABILITY_ORDER_PROTOCOL, node_id: binding.nodeId,
        capabilities: [rawCapability()], resources, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  return { collection, order, local, remote, report, claim, reads };
}

test("global idle winner is not proxied through a foreign polling account and can claim itself", async () => {
  const f = fixture();
  const waiting = await f.claim();
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.task, null);
  assert.equal(waiting.body.claim_plan.scheduling, SHARED_NODE_SCHEDULING);
  assert.equal(waiting.body.claim_plan.waiting_for_preferred_node, true);
  assert.equal(f.order.status, "queued");
  assert.equal(JSON.stringify(waiting.body).includes(f.remote.nodeId), false);
  const winner = await f.claim(f.remote, gpu("idle"));
  assert.equal(winner.status, 200);
  assert.equal(winner.body.task.id, String(f.order._id));
  assert.equal(winner.body.task.assigned_node.node_id, f.remote.nodeId);
  assert.equal(f.collection("capabilityNodeSlots").rows.find((row) => row._id === String(f.remote._id)).leases[0].estimatedSeconds, 60);
});

test("a silent preferred node cannot starve the oldest compatible order", async () => {
  const f = fixture();
  await f.claim();
  f.order.schedulerWaitStartedAt = new Date(Date.now() - 5_001);
  const result = await f.claim();
  assert.equal(result.status, 200);
  assert.equal(result.body.task.id, String(f.order._id));
  assert.equal(result.body.task.assigned_node.node_id, f.local.nodeId);
});

test("stale, different-group, revoked, disabled and incompatible global reports cannot block a claim", async () => {
  for (const kind of ["stale", "group", "revoked", "disabled", "capability", "not-sharing", "validation-expired"]) {
    const f = fixture();
    if (kind === "stale") f.report.reportedAt = new Date(Date.now() - 181_000);
    if (kind === "group") f.remote.computeGroupId = "group-b";
    if (kind === "revoked") f.remote.status = "revoked";
    if (kind === "disabled") f.collection("users").rows.find((user) => String(user._id) === String(f.remote.userId)).status = "disabled";
    if (kind === "capability") f.report.capabilities[0].capabilityVersion = "incompatible";
    if (kind === "not-sharing") f.report.capabilities[0].sharingOptIn = false;
    if (kind === "validation-expired") f.report.capabilities[0].validation.testedAt = new Date(Date.now() - 31 * 86400_000);
    if (kind === "capability") f.order.capabilityVersion = "1";
    const result = await f.claim();
    assert.equal(result.status, 200, kind);
    assert.ok(result.body.task, kind);
    assert.equal(result.body.task.assigned_node.node_id, f.local.nodeId, kind);
  }
});

test("global comparison preserves the oldest order and dry-run has no advertisements or queue writes", async () => {
  const f = fixture();
  const newer = { ...f.order, _id: new ObjectId(), createdAt: new Date() };
  f.collection("capabilityOrders").rows.push(newer);
  const before = JSON.stringify(f.collection("capabilityNodeReports").rows);
  assert.equal((await f.claim(f.local, gpu("idle"), { dry_run: true })).body.queue, "reachable");
  assert.equal(JSON.stringify(f.collection("capabilityNodeReports").rows), before);
  assert.equal(f.order.schedulerWaitStartedAt, undefined);
  f.report.resources = gpu("busy", 200);
  const result = await f.claim(f.local, gpu("idle"));
  assert.equal(result.body.task.id, String(f.order._id));
  assert.equal(newer.status, "queued");
});

test("same-account LAN dispatch favors explicit idle GPU, not only the shortest reported seconds", async () => {
  const f = fixture();
  f.order.requesterUserId = f.local.userId;
  f.collection("users").rows.find((user) => String(user._id) === String(f.local.userId)).computeGroupId = "group-a";
  f.remote.userId = f.local.userId;
  f.report.userId = f.local.userId;
  const result = await f.claim(f.local, gpu("busy", 1), { lan_cluster: { cluster_id: "local-cluster", nodes: [
    { node_id: f.remote.nodeId, capabilities: [rawCapability()], resources: gpu("idle", 200) },
  ] } });
  assert.equal(result.status, 200);
  assert.equal(result.body.task.assigned_node.node_id, f.remote.nodeId);
});

test("a newly reserved task influences the next claim even when repeated LAN reports still say idle", async () => {
  const f = fixture();
  f.order.requesterUserId = f.local.userId;
  f.collection("users").rows.find((user) => String(user._id) === String(f.local.userId)).computeGroupId = "group-a";
  f.remote.userId = f.local.userId;
  f.report.userId = f.local.userId;
  const newer = { ...f.order, _id: new ObjectId(), orderNo: "CAP-SCHEDULER-2", createdAt: new Date() };
  f.collection("capabilityOrders").rows.push(newer);
  const lan = { lan_cluster: { cluster_id: "local-cluster", nodes: [
    { node_id: f.remote.nodeId, capabilities: [rawCapability()], resources: gpu("busy", 1) },
  ] } };
  const first = await f.claim(f.local, gpu("idle"), lan);
  assert.equal(first.body.task.assigned_node.node_id, f.local.nodeId);
  const second = await f.claim(f.local, gpu("idle"), lan);
  assert.equal(second.body.task.id, String(newer._id));
  assert.equal(second.body.task.assigned_node.node_id, f.remote.nodeId);
});

test("projected lease running counts do not reduce the physical CAS ceiling twice", async () => {
  const f = fixture();
  f.remote.status = "revoked";
  for (let index = 0; index < 4; index += 1) f.collection("capabilityOrders").rows.push({ ...f.order,
    _id: new ObjectId(), orderNo: `CAP-CAPACITY-${index}`, createdAt: new Date(Date.now() + index) });
  const results = [];
  for (let index = 0; index < 5; index += 1) results.push(await f.claim(f.local, gpu("idle")));
  assert.equal(results.filter((result) => result.body.task).length, 4);
  assert.equal(results[4].body.task, null);
});

test("global dispatch batches binding, user and slot reads instead of adding three database reads per node", async () => {
  const proofCalls = [];
  const f = fixture({ automaticVerification: { findTrusted: async ({ bindingId }) => { proofCalls.push(String(bindingId)); return null; } } });
  for (let index = 0; index < 150; index += 1) {
    const user = { _id: new ObjectId(), status: "active" };
    const binding = { _id: new ObjectId(), userId: user._id, nodeId: `global-load-node-${String(index).padStart(3, "0")}`,
      computeGroupId: "group-a", status: "active", revokedAt: null };
    f.collection("users").rows.push(user);
    f.collection("nodeAccountBindings").rows.push(binding);
    f.collection("capabilityNodeReports").rows.push({ ...f.report, bindingId: binding._id, userId: user._id, nodeId: binding.nodeId });
  }
  const result = await f.claim();
  assert.equal(result.status, 200);
  assert.equal(result.body.claim_plan.waiting_for_preferred_node, true);
  const count = (name, method) => f.reads.filter((entry) => entry.name === name && entry.method === method).length;
  assert.equal(count("nodeAccountBindings", "find"), 1);
  assert.equal(count("nodeAccountBindings", "findOne"), 2); // Two authentication fences, not 150 lookups.
  assert.equal(count("users", "find"), 1);
  assert.ok(count("users", "findOne") <= 4); // Authentication and current requester/group only.
  assert.equal(count("capabilityNodeSlots", "find"), 2); // One local batch and one global batch.
  assert.equal(count("capabilityNodeSlots", "findOne"), 0);
  assert.ok(proofCalls.length > 100);
  assert.equal(proofCalls.length, new Set(proofCalls).size); // ready/trust share request-local proof promises.
  const firstRequestCount = proofCalls.filter((id) => id === String(f.local._id)).length;
  await f.claim();
  assert.equal(proofCalls.filter((id) => id === String(f.local._id)).length, firstRequestCount + 1,
    "a later request must recheck its proof rather than inherit a process-wide cache");
});

test("an empty queue never performs global binding, user or report scans", async () => {
  const f = fixture();
  f.collection("capabilityOrders").rows.length = 0;
  const result = await f.claim();
  assert.equal(result.status, 200);
  assert.equal(result.body.task, null);
  assert.equal(f.reads.some((entry) => entry.name === "capabilityNodeReports" && entry.method === "find"), false);
  assert.equal(f.reads.some((entry) => ["nodeAccountBindings", "users"].includes(entry.name) && entry.method === "find"), false);
  assert.equal(f.reads.filter((entry) => entry.name === "capabilityNodeSlots" && entry.method === "find").length, 1);
});
