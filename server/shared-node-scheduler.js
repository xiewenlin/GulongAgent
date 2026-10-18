/** Shared by pull-based consumers. Reports are hints, never execution authority. */
export const SHARED_NODE_SCHEDULING = "fifo_gpu_idle_then_shortest_remaining_v1";
export const GPU_REPORT_MAX_AGE_MS = 30_000;
export const NODE_REPORT_MAX_AGE_MS = 3 * 60_000;
export const GLOBAL_DISPATCH_WAIT_MS = 5_000;
const MAX_REMAINING_SECONDS = 31 * 86400;

const timestamp = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};
const seconds = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_REMAINING_SECONDS ? value : fallback;

export function normalizeGpuLoadReport(resources = {}, now = new Date()) {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    throw Object.assign(new Error("节点资源上报必须是有效对象"), { code: "INVALID_GPU_LOAD_REPORT", status: 400 });
  }
  const state = resources.gpu_state ?? "unknown";
  if (!["idle", "busy", "unknown"].includes(state)) {
    throw Object.assign(new Error("显卡状态必须为 idle、busy 或 unknown"), { code: "INVALID_GPU_LOAD_REPORT", status: 400 });
  }
  const observed = timestamp(resources.gpu_observed_at);
  if (resources.gpu_observed_at != null && (observed === null
    || typeof resources.gpu_observed_at !== "string" && !(resources.gpu_observed_at instanceof Date))) {
    throw Object.assign(new Error("显卡状态采集时间不正确"), { code: "INVALID_GPU_LOAD_REPORT", status: 400 });
  }
  if (observed !== null && observed > +now + 5_000) {
    throw Object.assign(new Error("显卡状态采集时间不能晚于服务器时间"), { code: "INVALID_GPU_LOAD_REPORT", status: 400 });
  }
  if (resources.current_task_remaining_seconds !== undefined && resources.current_task_remaining_seconds !== null
    && (!Number.isSafeInteger(resources.current_task_remaining_seconds) || resources.current_task_remaining_seconds < 0
      || resources.current_task_remaining_seconds > MAX_REMAINING_SECONDS)) {
    throw Object.assign(new Error("当前任务列表总剩余耗时必须为 0 至 2678400 秒的整数"), { code: "INVALID_GPU_LOAD_REPORT", status: 400 });
  }
  return {
    gpu_state: observed !== null && observed >= +now - GPU_REPORT_MAX_AGE_MS ? state : "unknown",
    gpu_observed_at: observed === null ? null : new Date(observed).toISOString(),
    current_task_remaining_seconds: Object.hasOwn(resources, "current_task_remaining_seconds")
      && resources.current_task_remaining_seconds !== undefined
      ? resources.current_task_remaining_seconds
      : seconds(resources.estimated_total_seconds, null),
  };
}

/** New server-side reservations must influence the very next dispatch, even if
 * the worker has not yet included them in its local task-list snapshot. Only
 * post-snapshot reservations are added; older leases remain a lower bound. */
export function projectSharedNodeLoad(node, snapshot = {}, now = new Date()) {
  const leases = Array.isArray(snapshot.leases) ? snapshot.leases : [];
  const estimates = leases.map((lease) => {
    const estimate = seconds(lease.estimatedSeconds, 300);
    const started = timestamp(lease.estimateUpdatedAt ?? lease.createdAt) ?? +now;
    return { createdAt: timestamp(lease.createdAt),
      remaining: Math.max(0, estimate - Math.max(0, Math.floor((+now - started) / 1000))) };
  });
  const reservedSeconds = estimates.reduce((total, lease) => total + lease.remaining, 0);
  const resources = normalizeGpuLoadReport(node.resources || {}, now);
  const snapshotAt = timestamp(resources.gpu_observed_at);
  const addedSeconds = snapshotAt === null ? 0
    : estimates.filter((lease) => lease.createdAt !== null && lease.createdAt > snapshotAt)
      .reduce((total, lease) => total + lease.remaining, 0);
  const activeCount = Number.isSafeInteger(snapshot.activeCount) ? snapshot.activeCount : leases.length;
  return {
    ...node,
    ...(leases.some((lease) => lease.exclusive === true) ? { availableSlots: 0 } : {}),
    gpuState: resources.gpu_state === "idle" && activeCount === 0 ? "idle"
      : activeCount > 0 ? "busy" : resources.gpu_state,
    // Missing ETA is not a zero-second task list. Keep it worse than every
    // measured finite workload rather than rewarding a legacy/unknown report.
    estimatedTotalSeconds: resources.current_task_remaining_seconds === null
      ? Number.POSITIVE_INFINITY : Math.max(resources.current_task_remaining_seconds + addedSeconds, reservedSeconds),
    runningTaskCount: Math.max(seconds(node.runningTaskCount), activeCount),
  };
}

export function compareSharedNodeLoad(left, right) {
  return (left.gpuState === "idle" ? 0 : 1) - (right.gpuState === "idle" ? 0 : 1)
    || left.estimatedTotalSeconds - right.estimatedTotalSeconds
    || left.runningTaskCount - right.runningTaskCount
    || String(left.nodeId).localeCompare(String(right.nodeId));
}

export function boundedGlobalDispatchWait(order, now = new Date()) {
  const since = timestamp(order.schedulerWaitStartedAt);
  return since === null ? { shouldWait: true, startedAt: new Date(now), remainingMs: GLOBAL_DISPATCH_WAIT_MS }
    : { shouldWait: +now - since < GLOBAL_DISPATCH_WAIT_MS, startedAt: new Date(since),
      remainingMs: Math.max(0, GLOBAL_DISPATCH_WAIT_MS - (+now - since)) };
}
