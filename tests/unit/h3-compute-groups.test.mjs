import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { H3_ACCOUNT_BINDING_HEADER, registerH3SharedRoutes } from "../../server/h3-shared.js";
import { createCapabilitySlotCoordinator } from "../../server/capability-slots.js";

const GROUP_A = `gug_${"a".repeat(32)}`;
const GROUP_B = `gug_${"b".repeat(32)}`;
const TOKEN = `gab_${"g".repeat(48)}`;
const CAPABILITIES = { max_duration_seconds: 15, profiles: ["balanced"], sampling_steps: [4], max_image_count: 9, max_video_count: 3, max_audio_count: 3, max_concurrent_tasks: 4 };

function valueAt(document, key) { return key.split(".").reduce((value, part) => value?.[part], document); }
function equal(left, right) {
  if (right == null) return left == null;
  if (Array.isArray(left)) return left.some((item) => equal(item, right));
  if (left instanceof ObjectId || right instanceof ObjectId) return String(left) === String(right);
  if (left instanceof Date || right instanceof Date) return Number(left) === Number(right);
  return left === right;
}
function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((part) => matches(document, part));
    if (key === "$and") return expected.every((part) => matches(document, part));
    const actual = valueAt(document, key);
    if (!expected || typeof expected !== "object" || expected instanceof Date || expected instanceof ObjectId) return equal(actual, expected);
    return Object.entries(expected).every(([operator, value]) => {
      if (operator === "$in") return value.some((candidate) => equal(actual, candidate));
      if (operator === "$nin") return value.every((candidate) => !equal(actual, candidate));
      if (operator === "$exists") return (actual !== undefined) === value;
      if (operator === "$ne") return !equal(actual, value);
      if (operator === "$lte") return actual <= value;
      if (operator === "$gte") return actual >= value;
      if (operator === "$gt") return actual > value;
      throw new Error(`Unhandled test operator ${operator}`);
    });
  });
}
function write(document, fields) {
  for (const [key, value] of Object.entries(fields || {})) {
    const path = key.split(".");
    let target = document;
    for (const part of path.slice(0, -1)) target = target[part] ||= {};
    target[path.at(-1)] = value;
  }
}
function update(document, operation, inserting = false) {
  if (inserting) write(document, operation.$setOnInsert);
  write(document, operation.$set);
  for (const [key, amount] of Object.entries(operation.$inc || {})) write(document, { [key]: Number(valueAt(document, key) || 0) + amount });
  for (const [key, value] of Object.entries(operation.$push || {})) {
    const current = valueAt(document, key) || [];
    const appended = [...current, ...(value.$each || [value])];
    write(document, { [key]: value.$slice ? appended.slice(value.$slice) : appended });
  }
  for (const key of Object.keys(operation.$unset || {})) delete document[key];
}
function collection(records = []) {
  const copy = (value) => value instanceof ObjectId ? new ObjectId(value) : value instanceof Date ? new Date(value)
    : Array.isArray(value) ? value.map(copy) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
  return {
    records,
    async findOne(filter) { return copy(records.find((record) => matches(record, filter)) || null); },
    find(filter) {
      let rows = records.filter((record) => matches(record, filter));
      return { sort(order) { rows.sort((a, b) => { for (const [key, direction] of Object.entries(order)) { const av = valueAt(a, key); const bv = valueAt(b, key); if (av < bv) return -direction; if (av > bv) return direction; } return 0; }); return this; }, limit(count) { rows = rows.slice(0, count); return this; }, async toArray() { return rows; } };
    },
    async insertOne(record) { records.push(record); return { insertedId: record._id }; },
    async updateOne(filter, operation, options = {}) {
      let record = records.find((item) => matches(item, filter));
      const inserting = !record && options.upsert;
      if (inserting) { record = { _id: filter._id || new ObjectId(), ...filter }; records.push(record); }
      if (!record) return { matchedCount: 0, modifiedCount: 0 };
      update(record, operation, inserting);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, operation) { const rows = records.filter((record) => matches(record, filter)); for (const record of rows) update(record, operation); return { modifiedCount: rows.length }; },
    async findOneAndUpdate(filter, operation, options = {}) {
      let record = records.find((item) => matches(item, filter));
      const inserting = !record && options.upsert;
      if (inserting) { record = { _id: filter._id || new ObjectId(), ...filter }; records.push(record); }
      if (!record) return null;
      update(record, operation, inserting);
      return copy(record);
    },
  };
}

function fixture({ userGroup = null, nodeGroup = null, taskGroup = userGroup, includeTaskGroup = true, includeTask = true, dependencyGroupReader, userRole = "admin", membershipState = null, outputReceipt = false, uploadFailure = false } = {}) {
  const app = new OpenAPIHono();
  const owner = { _id: new ObjectId(), role: userRole, status: "active", email: "requester@example.com", computeGroupId: userGroup };
  const nodeOwner = { _id: new ObjectId(), status: "active", email: "node@example.com" };
  const licenseId = new ObjectId();
  const binding = { _id: new ObjectId(), activationLicenseId: licenseId, userId: nodeOwner._id, nodeId: "stable-group-node-0001", nodeName: "分组节点", status: "active", revokedAt: null, computeGroupId: nodeGroup };
  const task = { _id: new ObjectId(), requesterUserId: owner._id, orderNo: "H3-GROUP-TEST", model: "minimax_h3_shared", status: "queued", createdAt: new Date(Date.now() - 60_000), prompt: "原始提示词", originalPrompt: "原始提示词", promptOptimizationEnabled: false, localPromptOptimizationRequired: false, profile: "balanced", videoMode: "all_reference", durationSeconds: 5, samplingSteps: 4, imageCount: 0, videoCount: 0, audioCount: 0, aspectRatio: "16:9", assets: { images: [], videos: [], audio: [] }, autoCancelAt: new Date(Date.now() + 600_000), chargeStatus: "exempt", ...(includeTaskGroup ? { computeGroupId: taskGroup } : {}) };
  const collections = new Map([
    ["users", collection([owner, nodeOwner])],
    ["nodeAccountBindings", collection([binding])],
    ["h3SharedTasks", collection(includeTask ? [task] : [])],
    ["wallets", collection([{ _id: new ObjectId(), ownerId: owner._id, balanceFen: 10_000, ledgerKeys: [], ledgerEntries: [] }])],
    ["subscriptions", collection(membershipState ? [{ _id: new ObjectId(), ownerId: owner._id, products: { gulong_engine_monthly: { enabled: true, status: "active", currentPeriodStart: new Date(Date.now() + (membershipState === "scheduled" ? 86_400_000 : -86_400_000)), currentPeriodEnd: new Date(Date.now() + (membershipState === "expired" ? -1_000 : 2 * 86_400_000)) } } }] : [])],
  ]);
  let uploadSignatures = 0;
  let objectInspections = 0;
  const getCollection = async (name) => { if (!collections.has(name)) collections.set(name, collection()); return collections.get(name); };
  registerH3SharedRoutes(app, {
    getCollection,
    ...(dependencyGroupReader ? { getUserComputeGroupId: dependencyGroupReader(owner) } : {}),
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: String(owner._id), role: owner.role, email: owner.email, computeGroupId: GROUP_B } }),
    requireAdmin: async () => ({ user: { id: String(owner._id), role: "admin" } }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => ({ record: { _id: licenseId }, payload: { deviceId: "stable-device-proof" } }),
    queueCoordinator: { snapshot: async () => ({ queuedCount: 1, activeNodeCount: 1, cached: true }), invalidate: async () => {} },
    createPresignedPutUrl: () => { uploadSignatures++; if (uploadFailure) throw new Error("temporary COS signing failure"); return "https://cos.example/upload"; },
    createPresignedDownloadUrl: () => "https://cos.example/download",
    headObject: async () => {
      objectInspections++;
      if (!outputReceipt) throw new Error("unexpected COS inspection");
      const grant = collections.get("h3OutputUploads").records.at(-1);
      return { headers: { "content-length": "4", "x-cos-meta-bytes": "4", "x-cos-meta-sha256": "A".repeat(64), "x-cos-meta-h3-task-id": String(task._id), "x-cos-meta-h3-upload-grant": grant.grantId } };
    },
  });
  const claim = (extra = {}) => app.request("/api/h3/tasks/claim", { method: "POST", headers: { "Content-Type": "application/json", [H3_ACCOUNT_BINDING_HEADER]: TOKEN }, body: JSON.stringify({ node_id: binding.nodeId, capabilities: CAPABILITIES, ...extra }) });
  const callback = (extra = {}) => {
    const body = new FormData();
    body.set("metadata", JSON.stringify({ task_id: String(task._id), node_id: binding.nodeId, status: "started", estimated_total_seconds: 600, ...extra }));
    return app.request("/api/h3/tasks/callback", { method: "POST", headers: { [H3_ACCOUNT_BINDING_HEADER]: TOKEN }, body });
  };
  // The auth path filters by the opaque token hash; all binding fixtures use the
  // real server hashing function rather than replacing authentication itself.
  return { app, owner, nodeOwner, binding, task, claim, callback, getCollection, collections, get uploadSignatures() { return uploadSignatures; }, get objectInspections() { return objectInspections; } };
}

async function authenticatedFixture(options) {
  const context = fixture(options);
  const { hashOpaqueToken } = await import("../../server/security.js");
  context.binding.tokenHash = hashOpaqueToken(TOKEN, "h3-account-binding");
  return context;
}

async function addGlobalH3Node(context, { group = null, state = "idle", remaining = 90, observedAgoMs = 0 } = {}) {
  const now = new Date();
  const owner = { _id: new ObjectId(), status: "active", email: "other-node@example.com" };
  const binding = { _id: new ObjectId(), userId: owner._id, nodeId: "global-other-account-node-0002", nodeName: "全局节点", status: "active", revokedAt: null,
    computeGroupId: group, lastSeenAt: now, h3ResourcesObservedAt: now,
    h3Resources: { gpu_state: state, gpu_observed_at: new Date(+now - observedAgoMs).toISOString(), current_task_remaining_seconds: remaining, running_task_count: 0 },
    capabilities: { maxDurationSeconds: 15, profiles: ["balanced"], samplingSteps: [4], maxImageCount: 9, maxVideoCount: 3, maxAudioCount: 3, maxConcurrentTasks: 4 } };
  context.collections.get("users").records.push(owner);
  context.collections.get("nodeAccountBindings").records.push(binding);
  return binding;
}

test("H3全局空闲节点优先但不会把跨账号任务或票据交给当前轮询者，5秒后有界回退", async () => {
  const context = await authenticatedFixture();
  const peer = await addGlobalH3Node(context);
  const resources = { gpu_state: "busy", gpu_observed_at: new Date().toISOString(), current_task_remaining_seconds: 10 };
  const waiting = await context.claim({ resources });
  assert.equal(waiting.status, 200);
  const wait = await waiting.json();
  assert.equal(wait.task, null);
  assert.equal(wait.claim_plan.queue_reason_code, "PREFERRED_NODE_POLL_WAIT");
  assert.ok(wait.claim_plan.preferred_node_wait_ms <= 5000);
  assert.equal(context.task.status, "queued");
  assert.equal(context.uploadSignatures, 0);
  assert.equal(JSON.stringify(wait).includes(peer.nodeId), false);
  context.task.schedulerWaitStartedAt = new Date(Date.now() - 6000);
  context.binding.nextClaimAt = new Date(0);
  const fallback = await context.claim({ resources: { ...resources, gpu_observed_at: new Date().toISOString() } });
  assert.equal(fallback.status, 200);
  assert.equal((await fallback.json()).task.assigned_node.node_id, context.binding.nodeId);
  assert.equal(context.uploadSignatures, 1);
});

test("H3全局显卡空闲比较仍严格隔离用户分组", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A });
  await addGlobalH3Node(context, { group: GROUP_B, remaining: 0 });
  const response = await context.claim({ resources: { gpu_state: "busy", gpu_observed_at: new Date().toISOString(), current_task_remaining_seconds: 100 } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.assigned_node.node_id, context.binding.nodeId);
});

test("H3全局已过期显卡状态按unknown处理并回到最短耗时", async () => {
  const context = await authenticatedFixture();
  await addGlobalH3Node(context, { observedAgoMs: 31_000, remaining: 100 });
  const response = await context.claim({ resources: { gpu_state: "busy", gpu_observed_at: new Date().toISOString(), current_task_remaining_seconds: 10 } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.assigned_node.node_id, context.binding.nodeId);
});

test("H3官网存量活跃任务否定节点虚报的idle与零负载", async () => {
  const context = await authenticatedFixture();
  const peer = await addGlobalH3Node(context, { remaining: 0 });
  context.collections.get("h3SharedTasks").records.push({ ...context.task, _id: new ObjectId(), status: "processing",
    claimedByNode: { bindingId: peer._id }, claimLeaseUntil: new Date(Date.now() + 60_000), remainingSeconds: 900 });
  const response = await context.claim({ resources: { gpu_state: "busy", gpu_observed_at: new Date().toISOString(), current_task_remaining_seconds: 10 } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.assigned_node.node_id, context.binding.nodeId);
});

test("H3全局排序纳入其他统一能力的真实槽位与剩余耗时", async () => {
  const context = await authenticatedFixture();
  const peer = await addGlobalH3Node(context, { remaining: 0 });
  const slots = createCapabilitySlotCoordinator({ getCollection: context.getCollection });
  await slots.reserve({ bindingId: String(peer._id), nodeId: peer.nodeId, userId: String(peer.userId),
    capabilityId: "gulong_engine.embedding", claimId: "unified-other-model-work", taskId: "other-capability-task",
    now: new Date(), expiresAt: new Date(Date.now() + 60_000), estimatedSeconds: 900,
    maxConcurrentTasks: 4, capabilityMaxConcurrent: 4 });
  const response = await context.claim({ resources: { gpu_state: "busy", gpu_observed_at: new Date().toISOString(), current_task_remaining_seconds: 10 } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.assigned_node.node_id, context.binding.nodeId);
});

test("H3显卡资源字段无效时拒绝且不会领取订单", async () => {
  for (const resources of [{ gpu_state: "fake-idle" }, "not-an-object", [], null]) {
    const context = await authenticatedFixture();
    const response = await context.claim({ resources });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_GPU_LOAD_REPORT");
    assert.equal(context.task.status, "queued");
    assert.equal(context.uploadSignatures, 0);
  }
});

function probeReservation(context) {
  return { bindingId: String(context.binding._id), nodeId: context.binding.nodeId, userId: String(context.binding.userId),
    capabilityId: "verification.probe", claimId: "gcv-exclusive-physical-slot", taskId: "verification:physical-node",
    exclusive: true, maxConcurrentTasks: 4, capabilityMaxConcurrent: 4, estimatedSeconds: 12,
    now: new Date(), expiresAt: new Date(Date.now() + 60_000) };
}

test("H3新领取与自动探测竞争同一物理CAS槽，任何顺序都不会同时执行", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const context = await authenticatedFixture();
    const slots = createCapabilitySlotCoordinator({ getCollection: context.getCollection });
    const [probe, response] = await Promise.all([slots.reserve(probeReservation(context)), context.claim()]);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(Boolean(probe) && Boolean(result.task), false);
    const snapshot = await slots.snapshot({ bindingId: String(context.binding._id) });
    assert.equal(snapshot.activeCount, 1);
    assert.ok(probe || result.task);
  }
});

test("H3有物理槽后进度续租，失败释放且不改会员零扣费规则", async () => {
  const context = await authenticatedFixture();
  const slots = createCapabilitySlotCoordinator({ getCollection: context.getCollection });
  const claimed = await (await context.claim()).json();
  assert.ok(claimed.task);
  assert.equal(context.task.physicalSlotRequired, true);
  assert.equal(claimed.task.physicalSlotClaimId, undefined);
  assert.equal(claimed.task.physicalSlotRequired, undefined);
  const before = await slots.snapshot({ bindingId: String(context.binding._id) });
  assert.equal(before.activeCount, 1);
  assert.equal(before.leases[0].taskId, `h3:${context.task._id}`);
  assert.equal(before.leases[0].capabilityId, "minimax_h3.video_generation");
  assert.equal((await context.callback({ remaining_seconds: 120 })).status, 200);
  const renewed = await slots.snapshot({ bindingId: String(context.binding._id) });
  assert.equal(renewed.activeCount, 1);
  assert.equal(renewed.leases[0].estimatedSeconds, 120);
  assert.equal((await context.callback({ status: "failed", error_code: "TEST_EXECUTION_FAILED", error_message: "节点任务失败" })).status, 200);
  assert.equal((await slots.snapshot({ bindingId: String(context.binding._id) })).activeCount, 0);
  assert.equal(context.task.chargeStatus, "exempt");
});

test("H3任务CAS失败以及输出票据失败都精确补偿物理槽", async () => {
  for (const uploadFailure of [false, true]) {
    const context = await authenticatedFixture({ uploadFailure });
    if (!uploadFailure) {
      const tasks = context.collections.get("h3SharedTasks");
      const original = tasks.findOneAndUpdate;
      tasks.findOneAndUpdate = (filter, operation, options) => operation.$set?.status === "claimed" ? null : original(filter, operation, options);
    }
    const response = await context.claim();
    assert.equal(response.status, uploadFailure ? 500 : 200);
    assert.equal(context.task.status, "queued");
    const slots = createCapabilitySlotCoordinator({ getCollection: context.getCollection });
    assert.equal((await slots.snapshot({ bindingId: String(context.binding._id) })).activeCount, 0);
  }
});

test("管理员取消运行任务不早放物理槽，节点确认cancelled后才释放", async () => {
  const context = await authenticatedFixture();
  await context.claim();
  const slots = createCapabilitySlotCoordinator({ getCollection: context.getCollection });
  const cancelled = await context.app.request(`/api/admin/h3/tasks/${context.task._id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  assert.equal((await slots.snapshot({ bindingId: String(context.binding._id) })).activeCount, 1);
  assert.equal((await context.callback({ status: "cancelled" })).status, 200);
  assert.equal((await slots.snapshot({ bindingId: String(context.binding._id) })).activeCount, 0);
});

test("新H3物理槽过期拒绝继续运行，旧无槽任务仍按旧合同完成", async () => {
  const context = await authenticatedFixture();
  await context.claim();
  const document = context.collections.get("capabilityNodeSlots").records[0];
  document.leases[0].expiresAt = new Date(Date.now() - 1_000);
  const expired = await context.callback();
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).code, "H3_PHYSICAL_SLOT_EXPIRED");
  assert.equal(context.task.status, "claimed");
  delete context.task.physicalSlotRequired;
  delete context.task.physicalSlotClaimId;
  assert.equal((await context.callback()).status, 200);
  assert.equal(context.task.status, "processing");
});

for (const [name, userGroup, nodeGroup, allowed] of [
  ["同组用户与节点", GROUP_A, GROUP_A, true],
  ["不同组用户与节点", GROUP_A, GROUP_B, false],
  ["有组用户与无组节点", GROUP_A, null, false],
  ["无组用户与有组节点", null, GROUP_A, false],
  ["无组用户与无组节点", null, null, true],
]) {
  test(`H3 分组派单：${name}${allowed ? "允许" : "拒绝"}`, async () => {
    const context = await authenticatedFixture({ userGroup, nodeGroup });
    const response = await context.claim({ compute_group_id: userGroup, computeGroupId: userGroup });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(Boolean(result.task), allowed);
    assert.equal(context.task.status, allowed ? "claimed" : "queued");
    assert.equal(context.uploadSignatures, allowed ? 1 : 0);
    if (allowed) {
      assert.equal(result.task.assigned_node.compute_group_id, userGroup);
      assert.equal(result.task.requester, undefined);
      assert.equal(result.task.priceFen, undefined);
      const progress = await context.callback();
      assert.equal(progress.status, 200);
      assert.equal(context.task.status, "processing");
    }
  });
}

test("历史任务缺失分组字段只能服务当前未分组用户", async () => {
  for (const userGroup of [null, GROUP_A]) {
    const context = await authenticatedFixture({ userGroup, nodeGroup: null, includeTaskGroup: false });
    const response = await context.claim({ compute_group_id: GROUP_A });
    assert.equal(response.status, 200);
    assert.equal(Boolean((await response.json()).task), userGroup === null);
    assert.equal(context.uploadSignatures, userGroup === null ? 1 : 0);
  }
});

test("创建 H3 任务只保存官网数据库用户分组，忽略会话和请求伪造分组", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, includeTask: false });
  const response = await context.app.request("/api/h3/tasks", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "h3-group-created-001" }, body: JSON.stringify({ source_channel: "desktop_agent", model: "minimax_h3_shared", prompt: "测试", duration_seconds: 5, aspect_ratio: "16:9", profile: "balanced", compute_group_id: GROUP_B, computeGroupId: GROUP_B, assets: { images: [], videos: [], audio: [] } }) });
  assert.equal(response.status, 201);
  assert.equal(context.collections.get("h3SharedTasks").records[0].computeGroupId, GROUP_A);
});

test("执行回调重新校验用户当前分组；伪造 metadata 不会越权或写入结果", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A });
  assert.equal((await context.claim()).status, 200);
  context.owner.computeGroupId = GROUP_B;
  const response = await context.callback({ status: "completed", compute_group_id: GROUP_A, video: { object_key: "forged", sha256: "A".repeat(64), bytes: 100, filename: "x.mp4" } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "COMPUTE_GROUP_MISMATCH");
  assert.equal(context.task.status, "claimed");
  assert.equal(context.objectInspections, 0);
  assert.equal(context.collections.get("h3TaskCallbacks")?.records.length || 0, 0);
});

test("执行回调重新读取节点绑定分组，已分配任务也不能跨组提交", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A });
  await context.claim();
  context.binding.computeGroupId = GROUP_B;
  const response = await context.callback({ compute_group_id: GROUP_A });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "COMPUTE_GROUP_MISMATCH");
  assert.equal(context.task.status, "claimed");
});

test("领取后输出票据签发前用户变组时原子回队，禁止签发跨组 COS 票据", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A, dependencyGroupReader: (owner) => {
    let reads = 0;
    return async () => { reads++; if (reads >= 3) owner.computeGroupId = GROUP_B; return owner.computeGroupId; };
  } });
  const response = await context.claim();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "COMPUTE_GROUP_MISMATCH");
  assert.equal(context.task.status, "queued");
  assert.equal(context.task.claimedByNode, undefined);
  assert.equal(context.uploadSignatures, 0);
});

test("同账号 LAN 节点独立分组：只派给任务同组节点而非最快跨组节点", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_B, nodeGroup: GROUP_A });
  const target = { ...context.binding, _id: new ObjectId(), nodeId: "stable-group-node-0002", nodeName: "B组节点", computeGroupId: GROUP_B, tokenHash: "another-token-hash" };
  context.collections.get("nodeAccountBindings").records.push(target);
  const response = await context.claim({ lan_cluster: { cluster_id: "stable-group-lan-0001", observed_at: new Date().toISOString(), nodes: [
    { node_id: context.binding.nodeId, capabilities: CAPABILITIES, running_task_count: 0, estimated_total_seconds: 0, compute_group_id: GROUP_B },
    { node_id: target.nodeId, capabilities: CAPABILITIES, running_task_count: 1, estimated_total_seconds: 400, compute_group_id: GROUP_A },
  ] } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.task.assigned_node.node_id, target.nodeId);
  assert.equal(result.task.assigned_node.compute_group_id, GROUP_B);
  assert.equal(String(context.task.claimedByNode.bindingId), String(target._id));
  assert.equal(String(context.collections.get("h3OutputUploads").records[0].issuedToBindingId), String(target._id));
});

test("同一节点原账号重新绑定保留分组，改绑其他账号自动清空旧分组", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_B, nodeGroup: GROUP_A });
  for (const [email, expectedGroup] of [[context.nodeOwner.email, GROUP_A], [context.owner.email, null]]) {
    const response = await context.app.request("/api/desktop/account-bindings/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, node_id: context.binding.nodeId, node_name: "同一节点", app_version: "2.1.0", activation_receipt: "receipt", compute_group_id: GROUP_A }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).binding.compute_group_id, expectedGroup);
    assert.equal(context.binding.computeGroupId, expectedGroup);
  }
});

for (const state of [null, "expired", "scheduled", "active"]) {
  test(`有组非管理员 H3 创建和领取须有效古龙引擎包月：${state || "未开通"}`, async () => {
    const createContext = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A, includeTask: false, userRole: "user", membershipState: state });
    const created = await createContext.app.request("/api/h3/tasks", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "h3-member-group-create-001" }, body: JSON.stringify({ source_channel: "desktop_agent", model: "minimax_h3_shared", prompt: "普通用户测试", duration_seconds: 5, aspect_ratio: "16:9", profile: "balanced", assets: { images: [], videos: [], audio: [] } }) });
    const active = state === "active";
    assert.equal(created.status, active ? 201 : 403);
    const result = await created.json();
    if (active) assert.equal(result.billing.chargedFen, 0);
    else assert.equal(result.code, "GULONG_ENGINE_SUBSCRIPTION_REQUIRED");
    assert.equal(createContext.collections.get("h3SharedTasks").records.length, active ? 1 : 0);
    assert.equal(createContext.collections.get("wallets").records[0].balanceFen, 10_000);
    assert.equal(createContext.collections.get("h3WalletLedger")?.records.length || 0, 0);

    const claimContext = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A, userRole: "user", membershipState: state });
    const claimed = await claimContext.claim();
    assert.equal(claimed.status, 200);
    assert.equal(Boolean((await claimed.json()).task), active);
    assert.equal(claimContext.uploadSignatures, active ? 1 : 0);
    assert.equal(claimContext.task.status, active ? "claimed" : "queued");
  });
}

test("未分组普通用户仍可按原钱包流程付费创建视频任务", async () => {
  const context = await authenticatedFixture({ userGroup: null, nodeGroup: null, includeTask: false, userRole: "user" });
  const created = await context.app.request("/api/h3/tasks", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "h3-ungrouped-wallet-create-001" }, body: JSON.stringify({ source_channel: "desktop_agent", model: "minimax_h3_shared", prompt: "未分组钱包测试", duration_seconds: 5, aspect_ratio: "16:9", profile: "balanced", assets: { images: [], videos: [], audio: [] } }) });
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.billing.chargedFen, 100);
  assert.equal(result.billing.billingMode, "wallet");
  assert.equal(context.collections.get("wallets").records[0].balanceFen, 9_900);
  assert.equal(context.collections.get("h3WalletLedger").records.length, 1);
});

test("同组会员任务已领取后会员到期仍可回传结果，不阻塞正在运行任务", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A, userRole: "user", membershipState: "active" });
  const claimed = await context.claim();
  assert.equal(claimed.status, 200);
  assert.ok((await claimed.json()).task);
  context.collections.get("subscriptions").records[0].products.gulong_engine_monthly.currentPeriodEnd = new Date(0);
  const result = await context.callback();
  assert.equal(result.status, 200);
  assert.equal(context.task.status, "processing");
});

test("已零费受理的同组原任务到期后仍可领取、完成及幂等回传，零扣费零分佣", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A, userRole: "user", membershipState: "expired", outputReceipt: true });
  Object.assign(context.task, { requireNoCharge: true, chargedFen: 0, billingMode: "gulong_engine_membership", chargeStatus: "member_no_charge", revenueStatus: "not_earned" });
  const claimed = await context.claim();
  assert.ok((await claimed.json()).task, "server-owned free admission survives expiry, including output ticket issuance");
  assert.equal((await context.callback()).status, 200);
  const grant = context.collections.get("h3OutputUploads").records.at(-1);
  const completed = () => context.callback({ status: "completed", event: "render-completed", local_job_id: "free-completion", video: { sha256: "A".repeat(64), bytes: 4, filename: "clip.mp4", object_key: grant.objectKey } });
  assert.equal((await completed()).status, 200);
  assert.equal(context.task.status, "completed");
  assert.equal((await completed()).status, 200);
  assert.equal(context.task.requireNoCharge, true);
  assert.equal(context.task.chargedFen, 0);
  assert.equal(context.task.chargeStatus, "member_no_charge");
  assert.equal(context.task.revenueStatus, "not_earned");
  assert.equal(context.collections.get("wallets").records[0].balanceFen, 10_000);
  assert.equal(context.collections.get("h3WalletLedger")?.records.length || 0, 0);
});

test("零扣费任务GPU启动失败自动重派保留约束和账务，不能跨分组恢复", async () => {
  const context = await authenticatedFixture({ userGroup: GROUP_A, nodeGroup: GROUP_A, userRole: "user", membershipState: "expired" });
  Object.assign(context.task, { requireNoCharge: true, chargedFen: 0, billingMode: "gulong_engine_membership", chargeStatus: "member_no_charge", revenueStatus: "not_earned" });
  assert.ok((await (await context.claim()).json()).task);
  const failure = await context.callback({ status: "failed", error_code: "NODE_EXECUTION_FAILED", error_message: "GPU inference engine recovery failed" });
  assert.equal(failure.status, 200); assert.equal((await failure.json()).requeued, true);
  assert.equal(context.task.status, "queued"); assert.equal(context.task.requireNoCharge, true);
  assert.equal(context.task.chargedFen, 0); assert.equal(context.task.chargeStatus, "member_no_charge");
  assert.equal(context.collections.get("h3WalletLedger")?.records.length || 0, 0);
  context.owner.computeGroupId = GROUP_B;
  assert.equal(Boolean((await (await context.claim()).json()).task), false);
});
