import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import app from "../../server/app.js";
import {
  H3_ACCOUNT_BINDING_HEADER,
  buildH3EarningsSummary,
  calculateH3RevenueSplit,
  calculateH3SharedPrice,
  h3CallbackEventKey,
  normalizeH3TaskInput,
  maskH3NodeId,
  registerH3SharedRoutes,
  reserveH3Wallet,
  settleH3Revenue,
  toH3WorkerTask,
} from "../../server/h3-shared.js";

test("H3 shared pricing uses integer fen and keeps audio free", () => {
  assert.equal(calculateH3SharedPrice({ durationSeconds: 15, imageCount: 2, videoCount: 1 }), 330);
  const normalized = normalizeH3TaskInput({
    source_channel: "desktop_agent",
    model: "minimax_h3_shared",
    prompt: "render",
    duration_seconds: 10,
    profile: "QUALITY",
    priceFen: 1,
    image_count: 99,
    assets: {
      images: [{ asset_id: "66c000000000000000000001", object_key: "h3/requesters/u/assets/a.png" }],
      videos: [],
      audio: [{ asset_id: "66c000000000000000000002", object_key: "h3/requesters/u/assets/a.mp3" }],
    },
  });
  assert.equal(normalized.sourceChannel, "desktop_agent");
  assert.equal(normalized.profile, "quality");
  assert.equal(normalized.imageCount, 1);
  assert.equal(normalized.audioCount, 1);
  assert.equal(normalized.priceFen, 205);
});

test("H3 successful revenue uses integer-fen 50/50 split with platform taking the odd-cent remainder", () => {
  assert.deepEqual(calculateH3RevenueSplit(205), { grossFen: 205, nodeShareFen: 102, platformShareFen: 103 });
  assert.deepEqual(calculateH3RevenueSplit(300), { grossFen: 300, nodeShareFen: 150, platformShareFen: 150 });
});

test("H3 pricing rejects unsupported duration and material counts", () => {
  assert.throws(() => calculateH3SharedPrice({ durationSeconds: 0, imageCount: 0, videoCount: 0 }), /时长或素材数量/);
  assert.throws(() => calculateH3SharedPrice({ durationSeconds: 15, imageCount: 10, videoCount: 0 }), /时长或素材数量/);
  assert.throws(() => normalizeH3TaskInput({ prompt: "x", duration_seconds: 15, assets: { images: [], videos: Array(4).fill({ object_key: "x" }), audio: [] } }), /不能超过 3/);
});

test("H3 callback idempotency is stable per task event status and local job", () => {
  const metadata = { event: "render-completed", status: "completed", local_job_id: "local-1" };
  assert.equal(h3CallbackEventKey("task-1", metadata), h3CallbackEventKey("task-1", { ...metadata }));
  assert.notEqual(h3CallbackEventKey("task-1", metadata), h3CallbackEventKey("task-1", { ...metadata, local_job_id: "local-2" }));
  assert.equal(H3_ACCOUNT_BINDING_HEADER, "X-Gulong-Account-Binding");
});

test("H3 worker task DTO excludes requester and billing identity", () => {
  const task = toH3WorkerTask({
    _id: new ObjectId("66c000000000000000000010"),
    orderNo: "GLH3TEST",
    model: "minimax_h3_shared",
    prompt: "render safely",
    aspectRatio: "16:9",
    durationSeconds: 15,
    profile: "balanced",
    imageCount: 1,
    videoCount: 0,
    audioCount: 0,
    requesterUserId: new ObjectId("66c000000000000000000011"),
    requesterEmailSnapshot: "private@example.com",
    priceFen: 305,
    walletLedgerId: "h3:charge:secret",
    claimedByNode: { bindingId: new ObjectId("66c000000000000000000012") },
  }, {
    assets: [{ type: "image", download_url: "https://example.invalid/signed" }],
    outputUpload: { url: "https://example.invalid/upload", object_key: "h3/tasks/test/output.mp4" },
  });
  assert.deepEqual(Object.keys(task), ["id", "orderNo", "model", "prompt", "aspectRatio", "durationSeconds", "profile", "imageCount", "videoCount", "audioCount", "assets", "output_upload"]);
  const serialized = JSON.stringify(task);
  assert.doesNotMatch(serialized, /requester|private@example\.com|priceFen|walletLedger|bindingId/);
});

test("H3 earnings aggregate only authoritative settled node ledgers and de-duplicate task settlement", async () => {
  const ownerId = new ObjectId("66c000000000000000000021");
  const taskId = new ObjectId("66c000000000000000000022");
  const cursor = (rows) => ({ sort() { return this; }, async toArray() { return rows; } });
  const binding = { _id: new ObjectId(), userId: ownerId, nodeId: "stable-node-earnings-0001", nodeName: "RTX 工作站", status: "active", capabilities: { gpuName: "NVIDIA RTX 4090", vramMb: 24_576 }, lastSeenAt: new Date("2026-08-19T01:59:00.000Z"), createdAt: new Date("2026-08-01T00:00:00.000Z") };
  const task = { _id: taskId, status: "completed", assigneeUserId: ownerId, executedByNode: { nodeId: binding.nodeId, nodeName: binding.nodeName, at: new Date("2026-08-17T02:00:00.000Z") }, settlement: { nodeLedgerKey: "h3:revenue:one:0:node", settledAt: new Date("2026-08-17T02:00:00.000Z") }, completedAt: new Date("2026-08-17T02:00:00.000Z"), createdAt: new Date("2026-08-17T01:00:00.000Z") };
  const ledger = { ledgerKey: "h3:revenue:one:0:node", ownerId, taskId, kind: "h3_node_commission", status: "settled", amountFen: 100, settlementFen: 100, settledAt: new Date("2026-08-17T02:00:00.000Z"), createdAt: new Date("2026-08-17T02:00:00.000Z") };
  const collections = {
    nodeAccountBindings: { find: () => cursor([binding]) },
    h3WalletLedger: { find: () => cursor([ledger, { ...ledger }]) },
    h3SharedTasks: { find: () => cursor([task, { _id: new ObjectId(), status: "failed", assigneeUserId: ownerId, executedByNode: { nodeId: binding.nodeId } }]) },
  };
  const summary = await buildH3EarningsSummary({ getCollection: async (name) => collections[name], userId: ownerId, currentNodeId: binding.nodeId, now: new Date("2026-08-19T02:00:00.000Z") });
  assert.equal(summary.currency, "CNY");
  assert.deepEqual(summary.account, { total_earnings_fen: 100, settled_earnings_fen: 100, pending_earnings_fen: 0, average_daily_earnings_fen: 33, active_days: 3, device_count: 1 });
  assert.equal(summary.current_device.node_id, binding.nodeId);
  assert.equal(summary.current_device.completed_task_count, 1);
  assert.equal(summary.devices[0].gpu_name, "NVIDIA RTX 4090");
  assert.equal(summary.devices[0].online, true);
  assert.equal(maskH3NodeId(binding.nodeId), "stable…0001");
});

test("desktop earnings requires a binding token and rejects a node outside the bound account", async () => {
  const isolated = new OpenAPIHono();
  const ownerId = new ObjectId();
  const binding = { _id: new ObjectId(), userId: ownerId, nodeId: "stable-node-owned-0001", nodeName: "Owned", status: "active", revokedAt: null };
  const cursor = (rows) => ({ sort() { return this; }, async toArray() { return rows; } });
  const collections = {
    nodeAccountBindings: { findOne: async () => binding, find: () => cursor([binding]), updateOne: async () => ({ modifiedCount: 1 }) },
    users: { findOne: async () => ({ _id: ownerId, email: "owner@example.com", status: "active" }) },
    h3WalletLedger: { find: () => cursor([]) },
    h3SharedTasks: { find: () => cursor([]) },
  };
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => collections[name] || { insertOne: async () => ({}), updateOne: async () => ({}) },
    enforceRateLimit: async () => ({ allowed: true }), authenticate: async () => ({ user: { id: ownerId.toString() } }), requireAdmin: async () => ({ user: { id: ownerId.toString(), role: "admin" } }), requireTrustedMutation: () => null, verifyActivationReceipt: async () => { throw new Error("not used"); },
  });
  const missing = await isolated.request("http://localhost/api/desktop/earnings/summary");
  assert.equal(missing.status, 401);
  const forbidden = await isolated.request("http://localhost/api/desktop/earnings/summary?node_id=foreign-node-0001", { headers: { [H3_ACCOUNT_BINDING_HEADER]: `gab_${"e".repeat(48)}` } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "NODE_NOT_OWNED");
});

test("H3 desktop account binding does not enumerate users before activation verification", async () => {
  const isolated = new OpenAPIHono();
  let userLookups = 0;
  const audits = [];
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => name === "users"
      ? { findOne: async () => { userLookups += 1; return null; } }
      : { insertOne: async (record) => { audits.push(record); return { insertedId: new ObjectId() }; }, findOne: async () => null, updateOne: async () => ({}) },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Error("not used") }),
    requireAdmin: async () => ({ error: new Error("not used") }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => { throw Object.assign(new Error("invalid"), { code: "INVALID_ACTIVATION_PROOF" }); },
  });
  const response = await isolated.request("http://localhost/api/desktop/account-bindings/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "unknown@example.com", node_id: "stable-node-0001", node_name: "worker", app_version: "2.1.0", activation_receipt: "forged" }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "INVALID_ACTIVATION_PROOF");
  assert.equal(userLookups, 0);
  assert.equal(audits[0].event, "activation_rejected");
});

test("H3 desktop account binding returns the documented unknown-user response after activation", async () => {
  const isolated = new OpenAPIHono();
  const licenseId = new ObjectId();
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => name === "users"
      ? { findOne: async () => null }
      : { insertOne: async () => ({ insertedId: new ObjectId() }), findOne: async () => null, updateOne: async () => ({}) },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Error("not used") }),
    requireAdmin: async () => ({ error: new Error("not used") }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => ({ record: { _id: licenseId }, payload: { deviceId: "device-proof" } }),
  });
  const response = await isolated.request("http://localhost/api/desktop/account-bindings/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "unknown@example.com", node_id: "stable-node-0001", node_name: "worker", app_version: "2.1.0", activation_receipt: "valid" }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { code: "USER_NOT_FOUND", message: "该邮箱尚未注册古龙账户", register_url: "https://www.sologle.com/" });
});

test("H3 desktop account binding returns a high-entropy token but only persists its hash", async () => {
  const isolated = new OpenAPIHono();
  const licenseId = new ObjectId();
  const userId = new ObjectId();
  const bindingId = new ObjectId();
  let persistedSet = null;
  const collections = {
    users: { findOne: async () => ({ _id: userId, email: "member@example.com", displayName: "Member", status: "active" }) },
    nodeAccountBindings: {
      findOne: async () => null,
      findOneAndUpdate: async (_filter, update) => { persistedSet = update.$set; return { _id: bindingId, userId, nodeId: "stable-node-0001" }; },
    },
  };
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => collections[name] || { insertOne: async () => ({ insertedId: new ObjectId() }), findOne: async () => null, updateOne: async () => ({}) },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Error("not used") }),
    requireAdmin: async () => ({ error: new Error("not used") }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => ({ record: { _id: licenseId }, payload: { deviceId: "device-proof" } }),
  });
  const response = await isolated.request("http://localhost/api/desktop/account-bindings/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "MEMBER@example.com", node_id: "stable-node-0001", node_name: "worker", app_version: "2.1.0", activation_receipt: "valid" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.binding_token, /^gab_[A-Za-z0-9_-]{40,}$/);
  assert.equal(payload.binding.user_id, userId.toString());
  assert.match(persistedSet.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(persistedSet.tokenHash, payload.binding_token);
  assert.equal(Object.values(persistedSet).includes(payload.binding_token), false);
});

test("H3 forged binding token is rejected before any queue access", async () => {
  const isolated = new OpenAPIHono();
  let queueReadsOrWrites = 0;
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => name === "nodeAccountBindings"
      ? { findOne: async () => null }
      : name === "h3SharedTasks"
        ? { findOne: async () => { queueReadsOrWrites += 1; return null; }, findOneAndUpdate: async () => { queueReadsOrWrites += 1; return null; } }
        : { insertOne: async () => ({}), updateOne: async () => ({}), findOne: async () => null },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Error("not used") }),
    requireAdmin: async () => ({ error: new Error("not used") }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => { throw new Error("not used"); },
  });
  const response = await isolated.request("http://localhost/api/h3/tasks/claim", {
    method: "POST",
    headers: { "content-type": "application/json", [H3_ACCOUNT_BINDING_HEADER]: `gab_${"z".repeat(48)}` },
    body: JSON.stringify({ node_id: "stable-node-0001", node_name: "worker", dry_run: false, capabilities: { max_duration_seconds: 15, profiles: ["balanced"], max_image_count: 9, max_video_count: 3, max_audio_count: 3 } }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "INVALID_ACCOUNT_BINDING");
  assert.equal(queueReadsOrWrites, 0);
});

test("H3 wallet reservation is atomic under concurrent different orders", async () => {
  const ownerId = new ObjectId();
  const state = { ownerId, balanceFen: 305, ledgerKeys: [], ledgerEntries: [] };
  const ledgers = new Map();
  const wallets = {
    findOneAndUpdate: async (filter, update) => {
      if (filter.ownerId.toString() !== state.ownerId.toString() || state.balanceFen < filter.balanceFen.$gte || state.ledgerKeys.includes(filter.ledgerKeys.$ne)) return null;
      state.balanceFen += update.$inc.balanceFen;
      state.ledgerKeys.push(...update.$push.ledgerKeys.$each);
      state.ledgerEntries.push(...update.$push.ledgerEntries.$each);
      return { ...state };
    },
    findOne: async (filter) => filter.ledgerKeys && state.ledgerKeys.includes(filter.ledgerKeys) ? { ...state } : null,
  };
  const h3WalletLedger = {
    updateOne: async (filter, update) => {
      if (!ledgers.has(filter.ledgerKey)) ledgers.set(filter.ledgerKey, { ...update.$setOnInsert });
      return { acknowledged: true };
    },
  };
  const getCollection = async (name) => name === "wallets" ? wallets : h3WalletLedger;
  const results = await Promise.all([
    reserveH3Wallet({ getCollection, ownerId, amountFen: 305, ledgerKey: "h3:charge:one", orderNo: "ONE", taskId: new ObjectId() }),
    reserveH3Wallet({ getCollection, ownerId, amountFen: 305, ledgerKey: "h3:charge:two", orderNo: "TWO", taskId: new ObjectId() }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(state.balanceFen, 0);
  assert.equal(state.ledgerKeys.length, 1);
  assert.equal(ledgers.size, 1);
});

test("H3 completion credits node and platform wallets once with separate auditable ledgers", async () => {
  const taskId = new ObjectId();
  const requesterId = new ObjectId();
  const nodeUserId = new ObjectId();
  const platformAdminId = new ObjectId();
  let task = { _id: taskId, orderNo: "H3SPLIT001", requesterUserId: requesterId, requesterRoleSnapshot: "user", status: "completed", chargeStatus: "settled", revenueStatus: "pending", priceFen: 205, retryCount: 0 };
  const walletState = new Map();
  const ledgerState = new Map();
  const sameId = (left, right) => left?.toString?.() === right?.toString?.();
  const setFields = (target, fields = {}) => {
    for (const [key, value] of Object.entries(fields)) {
      if (key.includes(".")) {
        const [parent, child] = key.split(".");
        target[parent] = { ...(target[parent] || {}), [child]: value };
      } else target[key] = value;
    }
  };
  const collections = {
    h3SharedTasks: {
      findOne: async (filter) => sameId(filter._id, task._id) ? task : null,
      updateOne: async (_filter, update) => { setFields(task, update.$set); return { matchedCount: 1, modifiedCount: 1 }; },
    },
    wallets: {
      findOne: async (filter) => walletState.get(filter.ownerId.toString()) || null,
      findOneAndUpdate: async (filter, update) => {
        const key = filter.ownerId.toString();
        const wallet = walletState.get(key);
        if (!wallet || wallet.ledgerKeys.includes(filter.ledgerKeys.$ne)) return null;
        wallet.balanceFen += update.$inc.balanceFen;
        wallet.ledgerKeys.push(...update.$push.ledgerKeys.$each);
        wallet.ledgerEntries.push(...update.$push.ledgerEntries.$each);
        return wallet;
      },
      insertOne: async (record) => {
        const key = record.ownerId.toString();
        if (walletState.has(key)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        walletState.set(key, record);
        return { insertedId: record._id };
      },
    },
    h3WalletLedger: {
      updateOne: async (filter, update) => {
        const current = ledgerState.get(filter.ledgerKey);
        const next = current || { ...update.$setOnInsert };
        setFields(next, update.$set);
        ledgerState.set(filter.ledgerKey, next);
        return { upsertedCount: current ? 0 : 1 };
      },
      findOne: async (filter) => ledgerState.get(filter.ledgerKey) || null,
    },
  };
  const getCollection = async (name) => collections[name];
  await settleH3Revenue({ getCollection, task, executorUserId: nodeUserId, platformAdminUserId: platformAdminId });
  await settleH3Revenue({ getCollection, task, executorUserId: nodeUserId, platformAdminUserId: platformAdminId });
  assert.equal(walletState.get(nodeUserId.toString()).balanceFen, 102);
  assert.equal(walletState.get(platformAdminId.toString()).balanceFen, 103);
  assert.equal(walletState.get(nodeUserId.toString()).ledgerEntries[0].kind, "h3_node_commission");
  assert.equal(walletState.get(platformAdminId.toString()).ledgerEntries[0].kind, "h3_platform_commission");
  assert.equal(ledgerState.size, 2);
  assert.equal(task.revenueStatus, "settled");
  assert.equal(task.settlement.grossFen, 205);
});

test("H3 administrator exemption never opens a commission wallet ledger", async () => {
  const taskId = new ObjectId();
  let task = { _id: taskId, orderNo: "H3EXEMPT001", status: "completed", chargeStatus: "exempt", revenueStatus: "pending", priceFen: 500 };
  let financialCollectionReads = 0;
  const getCollection = async (name) => {
    if (name !== "h3SharedTasks") {
      financialCollectionReads += 1;
      throw new Error(`unexpected financial collection: ${name}`);
    }
    return {
      findOne: async () => task,
      updateOne: async (_filter, update) => { task = { ...task, ...update.$set }; return { modifiedCount: 1 }; },
    };
  };
  const settled = await settleH3Revenue({ getCollection, task, executorUserId: new ObjectId() });
  assert.equal(settled.revenueStatus, "exempt");
  assert.deepEqual(settled.settlement, { grossFen: 0, nodeShareFen: 0, platformShareFen: 0, reason: "administrator_exempt" });
  assert.equal(financialCollectionReads, 0);
});

test("administrator-created H3 tasks queue without wallet deduction or revenue sharing", async () => {
  const isolated = new OpenAPIHono();
  const adminId = new ObjectId();
  let storedTask = null;
  let walletMutations = 0;
  const collections = {
    h3SharedTasks: {
      findOne: async (filter) => filter.idempotencyKey && storedTask?.idempotencyKey === filter.idempotencyKey ? storedTask : null,
      insertOne: async (record) => { storedTask = record; return { insertedId: record._id }; },
      updateOne: async () => ({ modifiedCount: 1 }),
      findOneAndUpdate: async () => { throw new Error("admin task must not reserve a wallet"); },
    },
    wallets: { findOne: async () => ({ ownerId: adminId, balanceFen: 999 }), findOneAndUpdate: async () => { walletMutations += 1; return null; } },
    h3TaskAudits: { insertOne: async () => ({ insertedId: new ObjectId() }) },
  };
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => collections[name] || { findOne: async () => null, insertOne: async () => ({ insertedId: new ObjectId() }), updateOne: async () => ({}) },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: adminId.toString(), email: "admin@example.com", role: "admin" } }),
    requireAdmin: async () => ({ user: { id: adminId.toString(), role: "admin" } }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => { throw new Error("not used"); },
  });
  const response = await isolated.request("http://localhost/api/h3/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "admin-h3-exempt-001" },
    body: JSON.stringify({ source_channel: "website", model: "minimax_h3_shared", prompt: "admin render", duration_seconds: 5, aspect_ratio: "16:9", profile: "balanced", assets: { images: [], videos: [], audio: [] } }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.deepEqual(payload.billing, { chargedFen: 0, remainingBalanceFen: 999, exempt: true });
  assert.equal(payload.task.chargeStatus, "exempt");
  assert.equal(payload.task.revenueStatus, "exempt");
  assert.equal(walletMutations, 0);
  assert.equal(storedTask.activeChargeKey, undefined);
});

test("H3 claim dry-run validates identity and capabilities without touching the queue", async () => {
  const isolated = new OpenAPIHono();
  const bindingId = new ObjectId();
  const userId = new ObjectId();
  let queueReadsOrWrites = 0;
  const collections = {
    nodeAccountBindings: { findOne: async () => ({ _id: bindingId, userId, nodeId: "stable-node-0001", nodeName: "test", status: "active", revokedAt: null }), updateOne: async () => ({ modifiedCount: 1 }) },
    users: { findOne: async () => ({ _id: userId, email: "test@example.com", displayName: "Test", status: "active" }) },
    h3SharedTasks: { findOneAndUpdate: async () => { queueReadsOrWrites += 1; return null; }, findOne: async () => { queueReadsOrWrites += 1; return null; } },
  };
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => collections[name] || { insertOne: async () => ({}), updateOne: async () => ({}), findOne: async () => null },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: userId.toString() } }),
    requireAdmin: async () => ({ user: { id: userId.toString(), role: "admin" } }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => { throw new Error("not used"); },
  });
  const response = await isolated.request("http://localhost/api/h3/tasks/claim", {
    method: "POST",
    headers: { "content-type": "application/json", [H3_ACCOUNT_BINDING_HEADER]: `gab_${"a".repeat(48)}` },
    body: JSON.stringify({ node_id: "stable-node-0001", node_name: "test", dry_run: true, capabilities: { max_duration_seconds: 15, profiles: ["balanced"], vram_mb: 24_576, max_image_count: 9, max_video_count: 3, max_audio_count: 3 } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "gulong-h3-shared", queue: "reachable" });
  assert.equal(queueReadsOrWrites, 0);
});

test("H3 OpenAPI publishes binding, assets, desktop tool, claim and callback contracts", () => {
  const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  for (const path of [
    "/api/desktop/account-bindings/verify",
    "/api/desktop/account-bindings/unbind",
    "/api/desktop/earnings/summary",
    "/api/account/earnings/summary",
    "/api/h3/assets/presign",
    "/api/h3/assets/{id}/complete",
    "/api/h3/tasks",
    "/api/h3/tasks/{id}",
    "/api/h3/tasks/claim",
    "/api/h3/tasks/callback",
    "/api/v1/desktop/agent/tools/minimax-h3-shared",
    "/api/admin/h3/tasks",
    "/api/admin/h3/tasks/{id}",
    "/api/admin/h3/tasks/{id}/cancel",
    "/api/admin/h3/tasks/{id}/retry",
  ]) assert.ok(document.paths[path], `${path} should be documented`);
  assert.equal(document.components.securitySchemes.accountBinding.name, H3_ACCOUNT_BINDING_HEADER);
  assert.deepEqual(document.paths["/api/desktop/earnings/summary"].get.security, [{ accountBinding: [] }]);
  assert.match(document.paths["/api/h3/tasks/claim"].post.description, /max_duration_seconds/);
  assert.match(document.paths["/api/h3/tasks/callback"].post.description, /HEAD/);
});

test("H3 implementation keeps identity, capability, COS ownership and ledger gates together", async () => {
  const [source, db, account, agent, review, vercel] = await Promise.all([
    readFile(new URL("../../server/h3-shared.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/offline-review.js", import.meta.url), "utf8"),
    readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
  ]);
  assert.match(source, /verifyActivationReceipt\(body\.activation_receipt\)[\s\S]+users[\s\S]+USER_NOT_FOUND/);
  assert.match(source, /findOneAndUpdate\(\{ status: "queued", model: H3_SHARED_MODEL, durationSeconds: \{ \$lte: maxDurationSeconds \}/);
  const dryRunBranch = source.indexOf('if (body.dry_run === true) return c.json({ ok: true, service: "gulong-h3-shared", queue: "reachable" });');
  const queueMutation = source.indexOf('findOneAndUpdate({ status: "queued", model: H3_SHARED_MODEL');
  assert.ok(dryRunBranch > -1 && queueMutation > dryRunBranch, "dry-run returns before the first queue mutation so the queue cannot decrease");
  assert.match(source, /imageCount: \{ \$lte: maxImageCount \}[\s\S]+videoCount: \{ \$lte: maxVideoCount \}[\s\S]+audioCount: \{ \$lte: maxAudioCount \}/);
  assert.match(source, /OUTPUT_OBJECT_FORBIDDEN[\s\S]+headObject\(objectKey\)[\s\S]+x-cos-meta-sha256/);
  assert.match(source, /ledgerKeys: \{ \$ne: ledgerKey \}[\s\S]+balanceFen: -amountFen/);
  assert.match(source, /assigneeUserId: auth\.user\._id/);
  assert.match(source, /wallet: \{ balanceFen: integer\(wallet\?\.balanceFen\), unlimited: auth\.user\.role === "admin" \}/);
  assert.match(source, /workerCallbackTask\(task\)/);
  assert.match(source, /kind: "h3_node_commission"[\s\S]+settlementFen/);
  assert.match(account, /id: "earnings", label: "我的收益"/);
  assert.match(account, /\/api\/account\/earnings\/summary/);
  assert.match(db, /uniq_h3_order_no[\s\S]+uniq_h3_idempotency_key[\s\S]+uniq_h3_callback_event[\s\S]+uniq_h3_wallet_ledger/);
  assert.match(account, /WarningCircle/);
  assert.match(account, /kind: "recharge", provider: "offline"/);
  assert.match(agent, /source_channel: "website"/);
  assert.match(agent, /minimax_h3_shared/);
  assert.match(review, /账户余额充值/);
  assert.match(vercel, /"source": "\/api\/desktop\/account-bindings\/:path\*"/);
  assert.match(vercel, /"source": "\/api\/desktop\/earnings\/:path\*"/);
  assert.match(vercel, /"source": "\/api\/h3\/:path\*"/);
  assert.match(vercel, /"source": "\/api\/admin\/h3\/:path\*"/);
});

test("H3 admin filters keep search and pricing copy visible across responsive rows", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.h3-task-filters \{[^}]*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.h3-task-filters > \.button \{[^}]*grid-column: 5 \/ 7;[^}]*white-space: nowrap/);
  assert.match(styles, /\.h3-task-summary \{[^}]*grid-template-columns: max-content minmax\(0, 1fr\)/);
  assert.match(styles, /\.h3-task-summary em \{[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*?\.h3-task-filters \{ grid-template-columns: 1fr 1fr; \}/);
  assert.match(styles, /@media \(max-width: 680px\) \{[\s\S]*?\.h3-task-filters \{ grid-template-columns: 1fr; \}/);
});
