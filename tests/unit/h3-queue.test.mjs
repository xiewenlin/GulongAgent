import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { calculateH3ClaimPlan, createH3QueueCoordinator, rankH3LanNodes } from "../../server/h3-queue.js";

test("H3每次派单优先显式空闲显卡，再比较剩余总耗时", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  const capabilities = { maxConcurrentTasks: 4 };
  const busy = { nodeId: "node-a-busy", capabilities, runningTaskCount: 1, estimatedTotalSeconds: 10,
    resources: { gpu_state: "busy", gpu_observed_at: now.toISOString(), current_task_remaining_seconds: 10 } };
  const idle = { nodeId: "node-b-idle", capabilities, runningTaskCount: 0, estimatedTotalSeconds: 90,
    resources: { gpu_state: "idle", gpu_observed_at: now.toISOString(), current_task_remaining_seconds: 90 } };
  assert.equal(rankH3LanNodes([busy, idle], now)[0].nodeId, idle.nodeId);
  idle.runningTaskCount = 1;
  idle.estimatedTotalSeconds += 300;
  assert.equal(rankH3LanNodes([busy, idle], now)[0].nodeId, busy.nodeId);
});

test("H3过期、缺失和被活跃任务否定的空闲状态不能取得空闲优先权", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  const node = (nodeId, gpu_state, observed, runningTaskCount = 0) => ({ nodeId, capabilities: {}, runningTaskCount, estimatedTotalSeconds: 100,
    resources: { gpu_state, ...(observed ? { gpu_observed_at: observed } : {}) } });
  const ranked = rankH3LanNodes([
    node("stale", "idle", new Date(+now - 31_000).toISOString()),
    node("missing", "idle"),
    node("contradicted", "idle", now.toISOString(), 1),
    node("valid", "idle", now.toISOString()),
  ], now);
  assert.equal(ranked[0].nodeId, "valid");
  assert.equal(ranked.find((item) => item.nodeId === "stale").gpuState, "unknown");
  assert.equal(ranked.find((item) => item.nodeId === "missing").gpuState, "unknown");
  assert.equal(ranked.find((item) => item.nodeId === "contradicted").gpuState, "busy");
});

test("H3缺失剩余耗时不当作零耗时，明确上报0仍可用", () => {
  const ranked = rankH3LanNodes([
    { nodeId: "unknown", resources: {} },
    { nodeId: "measured", resources: { current_task_remaining_seconds: 20 } },
    { nodeId: "zero", resources: { current_task_remaining_seconds: 0 } },
  ]);
  assert.deepEqual(ranked.map((node) => node.nodeId), ["zero", "measured", "unknown"]);
  assert.equal(ranked[2].estimatedTotalSeconds, Number.POSITIVE_INFINITY);
});

test("H3 queue assigns a bounded fair batch from queue pressure and node capacity", () => {
  const busyQueue = calculateH3ClaimPlan({ queuedCount: 40, activeNodeCount: 4, maxConcurrentTasks: 8, batchCapable: true, jitterSeed: "node-a" });
  assert.equal(busyQueue.fairShare, 10);
  assert.equal(busyQueue.recommendedBatchSize, 4);
  assert.ok(busyQueue.pollAfterMs >= 1_000 && busyQueue.pollAfterMs <= 1_250);

  const legacyNode = calculateH3ClaimPlan({ queuedCount: 40, activeNodeCount: 4, maxConcurrentTasks: 8, batchCapable: false });
  assert.equal(legacyNode.recommendedBatchSize, 1);

  const underloaded = calculateH3ClaimPlan({ queuedCount: 2, activeNodeCount: 10, maxConcurrentTasks: 4, batchCapable: true });
  assert.equal(underloaded.recommendedBatchSize, 1);

  const fullNode = calculateH3ClaimPlan({ queuedCount: 20, activeNodeCount: 2, activeTaskCount: 4, maxConcurrentTasks: 4, batchCapable: true });
  assert.equal(fullNode.recommendedBatchSize, 0);
  assert.equal(fullNode.availableSlots, 0);

  const emptyQueue = calculateH3ClaimPlan({ queuedCount: 0, activeNodeCount: 100, maxConcurrentTasks: 4, batchCapable: true, jitterSeed: "node-z" });
  assert.equal(emptyQueue.recommendedBatchSize, 0);
  assert.ok(emptyQueue.pollAfterMs >= 30_000 && emptyQueue.pollAfterMs <= 31_000);
});

test("H3 queue snapshot is shared for three seconds and recovers expired claim leases once", async () => {
  const now = new Date("2026-08-19T08:00:00.000Z");
  const expiredId = new ObjectId();
  const queuedId = new ObjectId();
  let state = null;
  let taskCountReads = 0;
  let bindingCountReads = 0;
  let expiredUploadCount = 0;
  const tasks = [
    { _id: expiredId, model: "minimax_h3_shared", status: "claimed", requireNoCharge: true, chargeStatus: "member_no_charge", billingMode: "gulong_engine_membership", chargedFen: 0, createdAt: new Date("2026-08-19T07:00:00.000Z"), claimLeaseUntil: new Date("2026-08-19T07:59:00.000Z") },
    { _id: queuedId, model: "minimax_h3_shared", status: "queued", createdAt: new Date("2026-08-19T07:30:00.000Z") },
  ];
  const applyUpdate = (target, update) => {
    if (update.$setOnInsert && !target.createdAt) Object.assign(target, update.$setOnInsert);
    if (update.$set) Object.assign(target, update.$set);
    for (const key of Object.keys(update.$unset || {})) delete target[key];
  };
  const collections = {
    h3QueueState: {
      findOne: async () => state && { ...state },
      updateOne: async (_filter, update) => {
        if (!state) state = { _id: "minimax_h3_shared" };
        applyUpdate(state, update);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      findOneAndUpdate: async (_filter, update) => {
        if (!state) return null;
        applyUpdate(state, update);
        return { ...state };
      },
    },
    h3SharedTasks: {
      find: (filter) => filter.leaseRecoveryId
        ? { toArray: async () => tasks.filter((task) => task.leaseRecoveryId === filter.leaseRecoveryId).map((task) => ({ _id: task._id })) }
        : {
          sort: () => ({
            limit: () => ({
              toArray: async () => tasks.filter((task) => ["claimed", "processing"].includes(task.status) && task.claimLeaseUntil <= now).map((task) => ({ _id: task._id })),
            }),
          }),
        },
      updateMany: async (filter, update) => {
        let modifiedCount = 0;
        for (const task of tasks) {
          if (filter._id.$in.some((id) => id.equals(task._id)) && ["claimed", "processing"].includes(task.status) && task.claimLeaseUntil <= now) {
            applyUpdate(task, update);
            modifiedCount += 1;
          }
        }
        return { modifiedCount };
      },
      countDocuments: async () => {
        taskCountReads += 1;
        return tasks.filter((task) => task.status === "queued" && task.model === "minimax_h3_shared").length;
      },
      findOne: async () => [...tasks].filter((task) => task.status === "queued").sort((left, right) => left.createdAt - right.createdAt)[0] || null,
    },
    nodeAccountBindings: {
      countDocuments: async () => { bindingCountReads += 1; return 5; },
    },
    h3OutputUploads: {
      updateMany: async () => { expiredUploadCount += 1; return { modifiedCount: 1 }; },
    },
  };
  const coordinator = createH3QueueCoordinator({ getCollection: async (name) => collections[name] });
  const first = await coordinator.snapshot(now);
  assert.equal(first.queuedCount, 2);
  assert.equal(first.activeNodeCount, 5);
  assert.equal(first.recoveredLeaseCount, 1);
  assert.equal(first.oldestQueuedAt.toISOString(), "2026-08-19T07:00:00.000Z");
  assert.equal(tasks[0].status, "queued");
  assert.equal(tasks[0].requireNoCharge, true);
  assert.equal(tasks[0].chargedFen, 0);
  assert.equal(tasks[0].chargeStatus, "member_no_charge");
  assert.equal(tasks[0].billingMode, "gulong_engine_membership");
  assert.equal(expiredUploadCount, 1);

  const second = await coordinator.snapshot(new Date(now.getTime() + 1_000));
  assert.equal(second.queuedCount, 2);
  assert.equal(second.cacheAgeMs, 1_000);
  assert.equal(taskCountReads, 1);
  assert.equal(bindingCountReads, 1);
  assert.equal(expiredUploadCount, 1);
});
