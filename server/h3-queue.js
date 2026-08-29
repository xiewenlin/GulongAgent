import { randomBytes } from "node:crypto";

export const H3_QUEUE_SNAPSHOT_TTL_MS = 3_000;
export const H3_QUEUE_REFRESH_LEASE_MS = 5_000;
export const H3_CLAIM_LEASE_MS = 45 * 60_000;
export const H3_MAX_BATCH_CLAIM = 4;
export const H3_LAN_REPORT_MAX_NODES = 64;
const H3_QUEUE_STATE_ID = "minimax_h3_shared";
const H3_NODE_ONLINE_WINDOW_MS = 3 * 60_000;

function safeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function boundedInteger(value, minimum, maximum, fallback = minimum) {
  return Math.min(maximum, Math.max(minimum, safeInteger(value, fallback)));
}

function deterministicJitter(seed, maximum) {
  const text = String(seed || "h3-node");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % Math.max(1, maximum + 1);
}

export function calculateH3ClaimPlan({
  queuedCount,
  activeNodeCount,
  activeTaskCount = 0,
  maxConcurrentTasks = 1,
  batchCapable = false,
  jitterSeed = "",
} = {}) {
  const queued = Math.max(0, safeInteger(queuedCount));
  const nodes = Math.max(1, safeInteger(activeNodeCount, 1));
  const concurrency = boundedInteger(maxConcurrentTasks, 1, H3_LAN_REPORT_MAX_NODES * 8, 1);
  const active = Math.max(0, safeInteger(activeTaskCount));
  const availableSlots = Math.max(0, concurrency - active);
  const fairShare = queued > 0 ? Math.max(1, Math.ceil(queued / nodes)) : 0;
  const batchLimit = batchCapable ? H3_MAX_BATCH_CLAIM : 1;
  const recommendedBatchSize = Math.min(availableSlots, batchLimit, fairShare);
  let basePollAfterMs;
  if (queued === 0) basePollAfterMs = Math.min(30_000, 5_000 + nodes * 250);
  else if (availableSlots === 0) basePollAfterMs = 5_000;
  else if (queued > nodes * 2) basePollAfterMs = 1_000;
  else if (queued >= nodes) basePollAfterMs = 1_500;
  else basePollAfterMs = Math.min(8_000, 2_000 + Math.ceil(nodes / queued) * 500);
  const pollAfterMs = basePollAfterMs + deterministicJitter(jitterSeed, Math.min(1_000, Math.floor(basePollAfterMs / 4)));
  return {
    queuedCount: queued,
    activeNodeCount: Math.max(0, safeInteger(activeNodeCount)),
    activeTaskCount: active,
    maxConcurrentTasks: concurrency,
    availableSlots,
    fairShare,
    recommendedBatchSize,
    pollAfterMs,
  };
}

export function rankH3LanNodes(nodes = []) {
  return [...nodes]
    .map((node) => {
      const runningTaskCount = boundedInteger(node?.runningTaskCount, 0, 64, 0);
      const estimatedTotalSeconds = boundedInteger(node?.estimatedTotalSeconds, 0, 7 * 24 * 60 * 60, 0);
      const maxConcurrentTasks = boundedInteger(node?.capabilities?.maxConcurrentTasks, 1, 8, 1);
      return {
        ...node,
        runningTaskCount,
        estimatedTotalSeconds,
        maxConcurrentTasks,
        availableSlots: Math.max(0, maxConcurrentTasks - runningTaskCount),
      };
    })
    .sort((left, right) => (
      left.estimatedTotalSeconds - right.estimatedTotalSeconds
      || left.runningTaskCount - right.runningTaskCount
      || String(left.nodeId || "").localeCompare(String(right.nodeId || ""))
    ));
}

function publicSnapshot(state, now, stale = false) {
  const refreshedAt = state?.refreshedAt ? new Date(state.refreshedAt) : null;
  return {
    cached: true,
    queuedCount: Math.max(0, safeInteger(state?.queuedCount)),
    activeNodeCount: Math.max(0, safeInteger(state?.activeNodeCount)),
    oldestQueuedAt: state?.oldestQueuedAt ? new Date(state.oldestQueuedAt) : null,
    recoveredLeaseCount: Math.max(0, safeInteger(state?.recoveredLeaseCount)),
    refreshedAt,
    cacheAgeMs: refreshedAt ? Math.max(0, now.getTime() - refreshedAt.getTime()) : null,
    stale,
  };
}

export function createH3QueueCoordinator({ getCollection, model = "minimax_h3_shared" }) {
  async function invalidate() {
    const states = await getCollection("h3QueueState");
    await states.updateOne(
      { _id: H3_QUEUE_STATE_ID },
      { $set: { expiresAt: new Date(0), invalidatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  }

  async function snapshot(now = new Date()) {
    const [states, tasks, bindings, uploads] = await Promise.all([
      getCollection("h3QueueState"),
      getCollection("h3SharedTasks"),
      getCollection("nodeAccountBindings"),
      getCollection("h3OutputUploads"),
    ]);
    let current = await states.findOne({ _id: H3_QUEUE_STATE_ID });
    if (current?.expiresAt && new Date(current.expiresAt) > now) return publicSnapshot(current, now);
    if (!current) {
      try {
        await states.updateOne(
          { _id: H3_QUEUE_STATE_ID },
          { $setOnInsert: { queuedCount: 0, activeNodeCount: 0, refreshedAt: new Date(0), expiresAt: new Date(0), createdAt: now } },
          { upsert: true },
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
      current = await states.findOne({ _id: H3_QUEUE_STATE_ID });
    }
    const refreshOwner = randomBytes(12).toString("hex");
    const locked = await states.findOneAndUpdate(
      {
        _id: H3_QUEUE_STATE_ID,
        $or: [
          { refreshLeaseUntil: { $exists: false } },
          { refreshLeaseUntil: null },
          { refreshLeaseUntil: { $lte: now } },
        ],
      },
      { $set: { refreshLeaseOwner: refreshOwner, refreshLeaseUntil: new Date(now.getTime() + H3_QUEUE_REFRESH_LEASE_MS) } },
      { returnDocument: "after" },
    );
    if (!locked || locked.refreshLeaseOwner !== refreshOwner) {
      return publicSnapshot(current || { queuedCount: 1, activeNodeCount: 1 }, now, true);
    }
    try {
      const expiredTasks = await tasks.find(
        { status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $lte: now } },
        { projection: { _id: 1 } },
      ).sort({ claimLeaseUntil: 1 }).limit(100).toArray();
      const expiredIds = expiredTasks.map((task) => task._id);
      let recoveredLeaseCount = 0;
      if (expiredIds.length) {
        await tasks.updateMany(
          { _id: { $in: expiredIds }, status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $lte: now } },
          {
            $set: { status: "queued", queuedAt: now, updatedAt: now, leaseRecoveryId: refreshOwner, leaseRecoveredAt: now, error: { code: "CLAIM_LEASE_EXPIRED", message: "节点领取租约已过期，任务已重新排队" } },
            $unset: { claimedByNode: "", claimRequestedByNode: "", claimedAt: "", claimLeaseUntil: "", executedByNode: "", progress: "" },
          },
        );
        const recoveredTasks = await tasks.find(
          { _id: { $in: expiredIds }, leaseRecoveryId: refreshOwner },
          { projection: { _id: 1 } },
        ).toArray();
        const recoveredIds = recoveredTasks.map((task) => task._id);
        recoveredLeaseCount = recoveredIds.length;
        if (recoveredIds.length) {
          await uploads.updateMany(
            { taskId: { $in: recoveredIds }, status: "issued" },
            { $set: { status: "expired", expiredAt: now, updatedAt: now }, $unset: { expiresAt: "" } },
          );
        }
      }
      const activeSince = new Date(now.getTime() - H3_NODE_ONLINE_WINDOW_MS);
      const [queuedCount, activeNodeCount, oldest] = await Promise.all([
        tasks.countDocuments({ status: "queued", model }),
        bindings.countDocuments({ status: "active", revokedAt: null, lastSeenAt: { $gte: activeSince } }),
        tasks.findOne({ status: "queued", model }, { sort: { createdAt: 1 }, projection: { createdAt: 1 } }),
      ]);
      const refreshed = {
        queuedCount,
        activeNodeCount,
        oldestQueuedAt: oldest?.createdAt || null,
        recoveredLeaseCount,
        refreshedAt: now,
        expiresAt: new Date(now.getTime() + H3_QUEUE_SNAPSHOT_TTL_MS),
        updatedAt: now,
      };
      await states.updateOne(
        { _id: H3_QUEUE_STATE_ID, refreshLeaseOwner: refreshOwner },
        { $set: refreshed, $unset: { refreshLeaseOwner: "", refreshLeaseUntil: "" } },
      );
      return publicSnapshot(refreshed, now);
    } catch (error) {
      await states.updateOne(
        { _id: H3_QUEUE_STATE_ID, refreshLeaseOwner: refreshOwner },
        { $set: { refreshErrorAt: new Date(), expiresAt: new Date(0) }, $unset: { refreshLeaseOwner: "", refreshLeaseUntil: "" } },
      ).catch(() => {});
      throw error;
    }
  }

  return { invalidate, snapshot };
}
