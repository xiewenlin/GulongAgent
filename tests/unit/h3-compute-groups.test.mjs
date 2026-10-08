import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { H3_ACCOUNT_BINDING_HEADER, registerH3SharedRoutes } from "../../server/h3-shared.js";

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
  return {
    records,
    async findOne(filter) { return records.find((record) => matches(record, filter)) || null; },
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
      return record;
    },
  };
}

function fixture({ userGroup = null, nodeGroup = null, taskGroup = userGroup, includeTaskGroup = true, includeTask = true, dependencyGroupReader, userRole = "admin", membershipState = null } = {}) {
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
    createPresignedPutUrl: () => { uploadSignatures++; return "https://cos.example/upload"; },
    createPresignedDownloadUrl: () => "https://cos.example/download",
    headObject: async () => { objectInspections++; throw new Error("unexpected COS inspection"); },
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
