import { NODE_REPORT_MAX_AGE_MS } from "./shared-node-scheduler.js";

// Administrator display only: heartbeat freshness is not transport discovery,
// model admission, GPU idleness or permission to dispatch a task.
export const NODE_PRESENCE_WINDOW_MS = NODE_REPORT_MAX_AGE_MS;
export async function readSharedNodeHeartbeats(getCollection, bindings, now) {
  if (!bindings.length) return [];
  const batches = await Promise.all([
    ["capabilityNodeReports", false], ["capabilityAutoVerifications", true],
  ].map(async ([collection, stringId]) => (await getCollection(collection)).aggregate([
    { $match: { $or: bindings.map(b => ({ bindingId: stringId ? String(b._id) : b._id, nodeId: b.nodeId })), reportedAt: { $type: "date" } } },
    { $group: { _id: { bindingId: "$bindingId", nodeId: "$nodeId" }, lastSeenAt: { $max: "$reportedAt" } } },
    { $limit: bindings.length },
  ], { maxTimeMS: 1500 }).toArray()));
  return batches.flat().map(row => ({ bindingId: String(row._id.bindingId), nodeId: row._id.nodeId, lastSeenAt: row.lastSeenAt }));
}

export function projectSharedNodePresence(binding, heartbeats, now, unavailable = false) {
  const instant = +new Date(now);
  const values = [binding.lastSeenAt, ...heartbeats.filter(row => String(row.bindingId) === String(binding._id) && row.nodeId === binding.nodeId).map(row => row.lastSeenAt)];
  const times = values.filter(v => v != null).map(v => v instanceof Date ? +v : typeof v === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN);
  const valid = times.filter(value => Number.isFinite(value) && value <= instant);
  const seen = valid.length ? Math.max(...valid) : null;
  const unknown = unavailable || !Number.isFinite(instant) || times.some(value => !Number.isFinite(value) || value > instant);
  const online = !unknown && binding.status === "active" && !binding.revokedAt && seen !== null && instant - seen < NODE_PRESENCE_WINDOW_MS;
  return { online, online_status: unknown ? "unknown" : online ? "online" : "offline",
    last_seen_at: seen === null ? null : new Date(seen).toISOString(), online_expires_at: seen === null ? null : new Date(seen + NODE_PRESENCE_WINDOW_MS).toISOString() };
}
