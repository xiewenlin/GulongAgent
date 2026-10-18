import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilitySlotCoordinator, normalizeCapabilityResources } from "../../server/capability-slots.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";

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

test("fenced reservation estimates are retained, renewed only for their owner, and never exposed as capacity", async () => {
  const { coordinator } = fixture();
  const first = await coordinator.reserve(reservation(1, { estimatedSeconds: 120 }));
  assert.equal(first.estimatedSeconds, 120);
  assert.equal(+first.estimateUpdatedAt, +NOW);
  assert.equal(await coordinator.renew({ ...reservation(1), taskId: "wrong-task", estimatedSeconds: 3 }), null);
  const renewed = await coordinator.renew({ ...reservation(1), now: new Date(+NOW + 10_000),
    expiresAt: new Date(+LATER + 10_000), estimatedSeconds: 40 });
  assert.equal(renewed.estimatedSeconds, 40);
  assert.equal(+renewed.estimateUpdatedAt, +NOW + 10_000);
  assert.equal((await coordinator.snapshot({ bindingId: "binding-a", now: NOW })).activeCount, 1);
});

test("an exclusive verification slot atomically excludes business claims and retains owner idempotency", async () => {
  const { coordinator } = fixture();
  const probe = reservation("probe", { capabilityId: "system.verification", taskId: "gcv-probe", claimId: "gcv-probe",
    exclusive: true, maxConcurrentTasks: 1, capabilityMaxConcurrent: 1 });
  const held = await coordinator.reserve(probe);
  assert.equal(held.exclusive, true);
  assert.deepEqual(await coordinator.reserve(probe), held);
  assert.equal(await coordinator.reserve(reservation(1, { maxConcurrentTasks: 16 })), null);
  assert.equal(await coordinator.reserve({ ...probe, taskId: "other-probe", claimId: "other-probe" }), null);
  assert.equal(await coordinator.release({ ...probe, claimId: "wrong-probe" }), false);
  assert.equal(await coordinator.release(probe), true);
  assert.ok(await coordinator.reserve(reservation(1)));
});

test("a production task atomically blocks an exclusive probe even below the normal slot ceiling", async () => {
  const { coordinator } = fixture();
  assert.ok(await coordinator.reserve(reservation(1, { maxConcurrentTasks: 16 })));
  assert.equal(await coordinator.reserve(reservation("probe", { capabilityId: "system.verification", exclusive: true,
    maxConcurrentTasks: 16, capabilityMaxConcurrent: 16 })), null);
});

test("concurrent exclusive probes and business reservations never overlap physical ownership", async () => {
  for (const probeFirst of [true, false]) {
    const { coordinator } = fixture();
    const probe = reservation("probe", { capabilityId: "system.verification", exclusive: true,
      maxConcurrentTasks: 16, capabilityMaxConcurrent: 16 });
    const business = Array.from({ length: 20 }, (_, index) => reservation(index, { maxConcurrentTasks: 16,
      capabilityMaxConcurrent: 16 }));
    const requests = probeFirst ? [probe, ...business] : [...business, probe];
    const accepted = (await Promise.all(requests.map((request) => coordinator.reserve(request)))).filter(Boolean);
    if (accepted.some((lease) => lease.exclusive === true)) {
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].capabilityId, "system.verification");
    } else assert.ok(accepted.length > 0 && accepted.length <= 16);
    const state = await coordinator.snapshot({ bindingId: "binding-a", now: NOW });
    assert.equal(state.activeCount, accepted.length);
    assert.equal(state.leases.some((lease) => lease.exclusive) && state.leases.length > 1, false);
  }
});

test("batch snapshots use one bounded read and aggregate all capability and exclusive probe leases", async () => {
  const collection = createCapabilityMemoryCollection();
  let reads = 0;
  const find = collection.find;
  collection.find = (filter) => { reads += 1; return find(filter); };
  const coordinator = createCapabilitySlotCoordinator({ getCollection: async () => collection });
  await coordinator.reserve(reservation(1));
  await coordinator.reserve(reservation(2, { capabilityId: "gulong_engine.embedding" }));
  await coordinator.reserve(reservation("probe", { bindingId: "binding-b", nodeId: "node-b", capabilityId: "system.verification", exclusive: true }));
  collection.rows.push({ _id: "binding-corrupt", version: 1, leases: [{ bad: true }] });
  const before = JSON.stringify(collection.rows);
  const states = await coordinator.snapshots({ bindingIds: ["binding-a", "binding-b", "binding-c", "binding-corrupt", "binding-a"], now: NOW });
  assert.equal(reads, 1);
  assert.equal(states.size, 4);
  assert.equal(states.get("binding-a").activeCount, 2);
  assert.equal(states.get("binding-a").byCapability["gulong_engine.embedding"], 1);
  assert.equal(states.get("binding-b").leases[0].exclusive, true);
  assert.equal(states.get("binding-c").available, true);
  assert.equal(states.get("binding-c").activeCount, 0);
  assert.equal(states.get("binding-corrupt").available, false);
  assert.equal(JSON.stringify(collection.rows), before);
});

test("batch snapshot limits and identifiers reject unsafe requests before database access", async () => {
  let reads = 0;
  const coordinator = createCapabilitySlotCoordinator({ getCollection: async () => { reads += 1; throw new Error("must not read"); } });
  for (const bindingIds of [undefined, "binding-a", [""], Array.from({ length: 201 }, (_, index) => `binding-${index}`)]) {
    await assert.rejects(coordinator.snapshots({ bindingIds, now: NOW }), { code: "INVALID_SLOT_SNAPSHOT_REQUEST" });
  }
  assert.equal((await coordinator.snapshots({ bindingIds: [], now: NOW })).size, 0);
  assert.equal(reads, 0);
});
