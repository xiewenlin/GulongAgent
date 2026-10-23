// Anchor expiry to a monotonic receipt time, not the user's system clock.
export function nodePresenceSnapshot(result, receivedAt) {
  const checked = Date.parse(result?.checked_at);
  return (Array.isArray(result?.bindings) ? result.bindings : []).map(row => ({ ...row,
    presenceReceivedAt: receivedAt,
    presenceRemainingMs: Number.isFinite(checked) && typeof row.online_expires_at === "string" ? Math.max(0, Date.parse(row.online_expires_at) - checked) : NaN,
    presenceSnapshotValid: Number.isFinite(checked) && result.presence_unavailable !== true,
  }));
}
export function nodePresenceView(row, now, unavailable = false) {
  if (unavailable || !row.presenceSnapshotValid || !["online", "offline"].includes(row.online_status)
    || typeof row.online !== "boolean" || row.online !== (row.online_status === "online")) return { status: "unknown", label: "状态未知" };
  if (row.online && (!Number.isFinite(row.presenceRemainingMs) || !Number.isFinite(row.presenceReceivedAt) || now < row.presenceReceivedAt)) return { status: "unknown", label: "状态未知" };
  return row.online && now - row.presenceReceivedAt < row.presenceRemainingMs ? { status: "online", label: "在线" } : { status: "offline", label: "离线" };
}
