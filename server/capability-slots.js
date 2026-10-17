const COLLECTION = "capabilityNodeSlots";
const MAX_CONCURRENT_TASKS = 16;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

/** Never retain untrusted resource fields or let negative running counts create slots. */
export function normalizeCapabilityResources(resources = {}, fallbackMaxConcurrent = 1) {
  return {
    max_concurrent_tasks: boundedInteger(resources?.max_concurrent_tasks,
      boundedInteger(fallbackMaxConcurrent, 1, 1, MAX_CONCURRENT_TASKS), 1, MAX_CONCURRENT_TASKS),
    running_task_count: boundedInteger(resources?.running_task_count, 0, 0, 1_000_000),
    estimated_total_seconds: boundedInteger(resources?.estimated_total_seconds, 0, 0, 31 * 86400),
  };
}

function id(value) {
  if (value === null || value === undefined) return null;
  const result = String(value);
  return result.length > 0 && result.length <= 256 && result.trim() === result ? result : null;
}

function date(value) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

function owner(input) {
  const result = {};
  for (const key of ["bindingId", "nodeId", "userId", "capabilityId", "claimId", "taskId"]) {
    result[key] = id(input[key]);
    if (!result[key]) return null;
  }
  return result;
}

function cloneLease(lease) {
  return { ...lease, createdAt: new Date(lease.createdAt), updatedAt: new Date(lease.updatedAt), expiresAt: new Date(lease.expiresAt) };
}

function activeLeases(document, bindingId, now) {
  if (!document || !Number.isSafeInteger(document.version) || document.version < 0 || !Array.isArray(document.leases)) return null;
  const result = [];
  for (const lease of document.leases) {
    if (!lease || !owner(lease) || lease.bindingId !== bindingId || !date(lease.expiresAt)
      || !date(lease.createdAt) || !date(lease.updatedAt)) return null;
    if (new Date(lease.expiresAt) > now) result.push(cloneLease(lease));
  }
  return result;
}

function sameOwner(left, right) {
  return ["bindingId", "nodeId", "userId", "capabilityId", "claimId", "taskId"].every((key) => left[key] === right[key]);
}

function sameFence(lease, input) {
  return lease.bindingId === id(input.bindingId) && lease.claimId === id(input.claimId) && lease.taskId === id(input.taskId)
    && (!input.nodeId || lease.nodeId === id(input.nodeId)) && (!input.userId || lease.userId === id(input.userId));
}

/**
 * One CAS document is the physical node's admission boundary across all capabilities.
 * Callers must reserve before order CAS, compensate a lost order CAS with release,
 * and pass capacity conservatively reduced by any untracked running work.
 * Reservation records are internal only; never include them in a worker task DTO.
 */
export function createCapabilitySlotCoordinator({ getCollection, maxRetries = 12 }) {
  if (typeof getCollection !== "function") throw new TypeError("getCollection is required");
  const retries = boundedInteger(maxRetries, 12, 1, 64);

  async function initialize(collection, bindingId, now) {
    try {
      await collection.updateOne({ _id: bindingId }, {
        $setOnInsert: { version: 0, leases: [], createdAt: now, updatedAt: now },
      }, { upsert: true });
    } catch (error) {
      // Concurrent first use can race the unique _id upsert; the winner is read below.
      if (error?.code !== 11000) throw error;
    }
  }

  async function compareAndSwap(collection, document, leases, now) {
    const result = await collection.findOneAndUpdate({ _id: document._id, version: document.version }, {
      $set: { leases, updatedAt: now }, $inc: { version: 1 },
    }, { returnDocument: "after" });
    const updated = result && (Object.hasOwn(result, "value") ? result.value : result);
    return Boolean(updated && updated._id === document._id && updated.version === document.version + 1);
  }

  async function reserve(input) {
    const identity = owner(input);
    const now = date(input.now ?? new Date());
    const expiresAt = date(input.expiresAt);
    const totalLimit = boundedInteger(input.maxConcurrentTasks, 0, 0, MAX_CONCURRENT_TASKS);
    const capabilityLimit = boundedInteger(input.capabilityMaxConcurrent, 0, 0, MAX_CONCURRENT_TASKS);
    if (!identity || !now || !expiresAt || expiresAt <= now || totalLimit < 1 || capabilityLimit < 1) return null;
    const collection = await getCollection(COLLECTION);
    await initialize(collection, identity.bindingId, now);
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const document = await collection.findOne({ _id: identity.bindingId });
      const active = activeLeases(document, identity.bindingId, now);
      if (!active) return null;
      const existing = active.find((lease) => lease.claimId === identity.claimId || lease.taskId === identity.taskId);
      if (existing) return sameOwner(existing, identity) ? cloneLease(existing) : null;
      if (active.length >= totalLimit || active.filter((lease) => lease.capabilityId === identity.capabilityId).length >= capabilityLimit) return null;
      const lease = { ...identity, createdAt: now, updatedAt: now, expiresAt };
      if (await compareAndSwap(collection, document, [...active, lease], now)) return cloneLease(lease);
    }
    return null; // Contention never creates a speculative/unreserved claim.
  }

  async function renew(input) {
    const bindingId = id(input.bindingId);
    const now = date(input.now ?? new Date());
    const expiresAt = date(input.expiresAt);
    if (!bindingId || !id(input.claimId) || !id(input.taskId) || !now || !expiresAt || expiresAt <= now) return null;
    const collection = await getCollection(COLLECTION);
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const document = await collection.findOne({ _id: bindingId });
      const active = activeLeases(document, bindingId, now);
      if (!active) return null;
      const position = active.findIndex((lease) => sameFence(lease, input));
      if (position < 0) return null; // Expired leases cannot be revived by stale workers.
      const lease = { ...active[position], updatedAt: now, expiresAt: new Date(Math.max(active[position].expiresAt.getTime(), expiresAt.getTime())) };
      const next = [...active];
      next[position] = lease;
      if (await compareAndSwap(collection, document, next, now)) return cloneLease(lease);
    }
    return null;
  }

  async function release(input) {
    const bindingId = id(input.bindingId);
    const now = date(input.now ?? new Date());
    if (!bindingId || !id(input.claimId) || !id(input.taskId) || !now) return false;
    const collection = await getCollection(COLLECTION);
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const document = await collection.findOne({ _id: bindingId });
      const active = activeLeases(document, bindingId, now);
      if (!active) return false;
      const remaining = active.filter((lease) => !sameFence(lease, input));
      if (remaining.length === active.length) return false;
      if (await compareAndSwap(collection, document, remaining, now)) return true;
    }
    return false;
  }

  async function snapshot({ bindingId: rawBindingId, now: rawNow } = {}) {
    const bindingId = id(rawBindingId);
    const now = date(rawNow ?? new Date());
    const empty = { available: false, activeCount: 0, byCapability: {}, leases: [] };
    if (!bindingId || !now) return empty;
    const document = await (await getCollection(COLLECTION)).findOne({ _id: bindingId });
    if (!document) return { ...empty, available: true };
    const leases = activeLeases(document, bindingId, now);
    if (!leases) return empty;
    const byCapability = {};
    for (const lease of leases) byCapability[lease.capabilityId] = (byCapability[lease.capabilityId] || 0) + 1;
    return { available: true, activeCount: leases.length, byCapability, leases };
  }

  return { reserve, renew, release, snapshot };
}
