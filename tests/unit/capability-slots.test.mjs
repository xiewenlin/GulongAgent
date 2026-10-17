import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilitySlotCoordinator, normalizeCapabilityResources } from "../../server/capability-slots.js";

const NOW = new Date("2026-10-17T00:00:00Z");
const LATER = new Date(NOW.getTime() + 300_000);
const clone = (value) => structuredClone(value);

// Pure in-memory fixture: no database, filesystem payloads, orders or GPU work.
function fixture({ conflictAlways = false, duplicateInitialize = false } = {}) {
  const records = new Map();
  let duplicateRaised = false;
  let writes = 0;
  const collection = {
    async findOne({ _id }) { await Promise.resolve(); return clone(records.get(_id) || null); },
    async updateOne({ _id }, update) {
      await Promise.resolve();
      if (!records.has(_id)) records.set(_id, { _id, ...clone(update.$setOnInsert) });
      if (duplicateInitialize && !duplicateRaised) {
        duplicateRaised = true;
        throw Object.assign(new Error("raced initial upsert"), { code: 11000 });
      }
      return { acknowledged: true };
    },
    async findOneAndUpdate({ _id, version }, update) {
      await Promise.resolve();
      const record = records.get(_id);
      if (conflictAlways || !record || record.version !== version) return null;
      const result = { ...record, ...clone(update.$set), version: record.version + update.$inc.version };
      records.set(_id, result);
      writes += 1;
      return clone(result);
    },
  };
  const coordinator = createCapabilitySlotCoordinator({ getCollection: async (name) => {
    assert.equal(name, "capabilityNodeSlots"); return collection;
  } });
  return { coordinator, records, writes: () => writes };
}

function reservation(index, overrides = {}) {
  return { bindingId: "binding-a", nodeId: "node-a", userId: "owner-a", capabilityId: "gulong_engine.agent_chat",
    claimId: `claim-${index}`, taskId: `task-${index}`, maxConcurrentTasks: 3, capabilityMaxConcurrent: 3,
    now: NOW, expiresAt: LATER, ...overrides };
}

test("simultaneous independent claims never exceed a physical node's reserved capacity", async () => {
  const { coordinator } = fixture({ duplicateInitialize: true });
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => coordinator.reserve(reservation(index))));
  assert.equal(results.filter(Boolean).length, 3);
  const state = await coordinator.snapshot({ bindingId: "binding-a", now: NOW });
  assert.equal(state.available, true);
  assert.equal(state.activeCount, 3);
  assert.equal(new Set(state.leases.map((lease) => lease.taskId)).size, 3);
  assert.equal(state.byCapability["gulong_engine.agent_chat"], 3);
});

test("a single capability ceiling and the shared physical ceiling are both enforced", async () => {
  const { coordinator } = fixture();
  assert.ok(await coordinator.reserve(reservation(1, { capabilityMaxConcurrent: 1, maxConcurrentTasks: 2 })));
  assert.equal(await coordinator.reserve(reservation(2, { capabilityMaxConcurrent: 1, maxConcurrentTasks: 2 })), null);
  assert.ok(await coordinator.reserve(reservation(3, { capabilityId: "gulong_engine.embedding", maxConcurrentTasks: 2 })));
  assert.equal(await coordinator.reserve(reservation(4, { capabilityId: "gulong_engine.music", maxConcurrentTasks: 2 })), null);
});

test("repeat reservation returns the stable fenced owner without extending its lease", async () => {
  const { coordinator, writes } = fixture();
  const request = reservation(1);
  const first = await coordinator.reserve(request);
  const repeated = await coordinator.reserve({ ...request, expiresAt: new Date(LATER.getTime() + 10_000) });
  assert.deepEqual(repeated, first);
  assert.equal(writes(), 1);
  assert.equal(await coordinator.reserve({ ...request, taskId: "different-task" }), null);
  assert.equal(await coordinator.reserve({ ...request, claimId: "different-claim" }), null);
  assert.equal(await coordinator.reserve({ ...request, userId: "different-user" }), null);
});

test("exact binding, claim and task fencing isolates renew and release from every other task", async () => {
  const { coordinator } = fixture();
  await coordinator.reserve(reservation(1));
  await coordinator.reserve(reservation(2));
  for (const mismatch of [{ taskId: "task-2" }, { claimId: "claim-2" }, { bindingId: "binding-b" }, { userId: "owner-b" }, { nodeId: "node-b" }]) {
    const invalid = { ...reservation(1), ...mismatch, expiresAt: new Date(LATER.getTime() + 60_000) };
    assert.equal(await coordinator.renew(invalid), null);
    assert.equal(await coordinator.release(invalid), false);
  }
  const renewed = await coordinator.renew({ ...reservation(1), expiresAt: new Date(LATER.getTime() + 60_000) });
  assert.equal(renewed.expiresAt.getTime(), LATER.getTime() + 60_000);
  let state = await coordinator.snapshot({ bindingId: "binding-a", now: NOW });
  assert.equal(state.leases.find((lease) => lease.taskId === "task-2").expiresAt.getTime(), LATER.getTime());
  assert.equal(await coordinator.release(reservation(1)), true);
  assert.equal(await coordinator.release(reservation(1)), false);
  state = await coordinator.snapshot({ bindingId: "binding-a", now: NOW });
  assert.deepEqual(state.leases.map((lease) => lease.taskId), ["task-2"]);
});

test("an expired lease frees capacity but can never be renewed by its old fence", async () => {
  const { coordinator } = fixture();
  const request = reservation(1, { maxConcurrentTasks: 1 });
  await coordinator.reserve(request);
  assert.equal((await coordinator.snapshot({ bindingId: "binding-a", now: LATER })).activeCount, 0);
  assert.equal(await coordinator.renew({ ...request, now: LATER, expiresAt: new Date(LATER.getTime() + 300_000) }), null);
  assert.equal(await coordinator.release({ ...request, now: LATER }), false);
  assert.ok(await coordinator.reserve(reservation(2, { maxConcurrentTasks: 1, now: LATER, expiresAt: new Date(LATER.getTime() + 300_000) })));
  assert.equal((await coordinator.snapshot({ bindingId: "binding-a", now: LATER })).activeCount, 1);
});

test("contention has bounded retries and never returns an unreserved speculative owner", async () => {
  const { coordinator, records, writes } = fixture({ conflictAlways: true });
  assert.equal(await coordinator.reserve(reservation(1)), null);
  assert.equal(writes(), 0);
  assert.equal(records.get("binding-a").leases.length, 0);
});

test("invalid capacities and malformed stored state fail closed", async () => {
  const { coordinator, records } = fixture();
  for (const overrides of [{ maxConcurrentTasks: 0 }, { maxConcurrentTasks: -3 }, { capabilityMaxConcurrent: 0 },
    { maxConcurrentTasks: NaN }, { expiresAt: NOW }, { bindingId: "" }, { taskId: undefined }]) {
    assert.equal(await coordinator.reserve(reservation(1, overrides)), null);
  }
  records.set("binding-a", { _id: "binding-a", version: 0, leases: [{ ...reservation(1), createdAt: NOW, updatedAt: NOW, expiresAt: "invalid" }] });
  assert.equal(await coordinator.reserve(reservation(1)), null);
  assert.equal((await coordinator.snapshot({ bindingId: "binding-a", now: NOW })).available, false);
});

test("normalization prevents negative/invalid resources from manufacturing physical slots", () => {
  assert.deepEqual(normalizeCapabilityResources({ max_concurrent_tasks: 2, running_task_count: -100,
    estimated_total_seconds: -3, extra: "not retained" }), {
    max_concurrent_tasks: 2, running_task_count: 0, estimated_total_seconds: 0,
  });
  assert.equal(normalizeCapabilityResources({ max_concurrent_tasks: 999 }).max_concurrent_tasks, 16);
  assert.equal(normalizeCapabilityResources({ max_concurrent_tasks: "not-a-number" }, 2).max_concurrent_tasks, 2);
  assert.equal(normalizeCapabilityResources({ running_task_count: 1_000_001 }).running_task_count, 1_000_000);
  assert.equal(normalizeCapabilityResources({ running_task_count: 1.5 }).running_task_count, 0);
});
