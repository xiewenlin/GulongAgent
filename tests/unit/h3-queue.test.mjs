import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { calculateH3ClaimPlan, createH3QueueCoordinator } from "../../server/h3-queue.js";

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
    { _id: expiredId, model: "minimax_h3_shared", status: "claimed", createdAt: new Date("2026-08-19T07:00:00.000Z"), claimLeaseUntil: new Date("2026-08-19T07:59:00.000Z") },
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
  assert.equal(expiredUploadCount, 1);

  const second = await coordinator.snapshot(new Date(now.getTime() + 1_000));
  assert.equal(second.queuedCount, 2);
  assert.equal(second.cacheAgeMs, 1_000);
  assert.equal(taskCountReads, 1);
  assert.equal(bindingCountReads, 1);
  assert.equal(expiredUploadCount, 1);
});
