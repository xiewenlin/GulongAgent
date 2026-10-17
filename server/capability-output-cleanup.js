import { timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { getCollection as databaseCollection } from "./db.js";
import { deleteObject } from "./cos.js";

export const CAPABILITY_OUTPUT_CLEANUP_PATH = "/api/cron/capability-output-cleanup";
const PUT_LIFETIME_MS = 60 * 60_000;
const objectId = (value) => value instanceof ObjectId ? value.toHexString() : typeof value === "string" && /^[a-f0-9]{24}$/i.test(value) ? value.toLowerCase() : null;
const safeFilename = (value) => typeof value === "string" && value.length > 0 && value.length <= 240
  && !/[\\/%\x00-\x1f\x7f]/.test(value) && value !== "." && value !== ".." && !value.includes("..");

// Deletion is deliberately narrower than the upload API. A database row alone
// never grants authority to delete an arbitrary COS object or another order.
export function isOwnedCapabilityOutputKey(record, kind) {
  const orderId = objectId(record?.orderId);
  const outputId = record?.outputId;
  if (!orderId || typeof outputId !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(outputId) || typeof record.objectKey !== "string") return false;
  const prefix = `capability-orders/${orderId}/${kind === "copy" ? "published" : "outputs"}/${outputId}-`;
  if (!record.objectKey.startsWith(prefix)) return false;
  const suffix = record.objectKey.slice(prefix.length);
  if (kind === "copy") {
    const match = /^([a-f0-9]{16,64})-(.+)$/i.exec(suffix);
    return !!match && safeFilename(match[2]);
  }
  return safeFilename(suffix);
}

const isReferenced = (order, key) => Array.isArray(order?.outputs) && order.outputs.some((output) => output?.objectKey === key);
const retryDelay = (attempt) => Math.min(60 * 60_000, 60_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));

export async function cleanupCapabilityOutputs({
  getCollection = databaseCollection, removeObject = deleteObject, now = new Date(), limit = 50,
} = {}) {
  const size = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 50;
  const summary = { examined: 0, deleted: 0, retained: 0, rejected: 0, retry: 0 };
  const copies = await getCollection("capabilityOutputCopies");
  const uploads = await getCollection("capabilityOutputUploads");
  const orders = await getCollection("capabilityOrders");
  const dueRetry = { $or: [{ nextCleanupAt: { $exists: false } }, { nextCleanupAt: { $lte: now } }] };

  async function inspect(record, collection, kind) {
    summary.examined += 1;
    const filter = { _id: record._id, objectKey: record.objectKey, ...(kind === "copy" ? { status: "staging" } : {}) };
    if (!isOwnedCapabilityOutputKey(record, kind)) {
      // Preserve evidence for review; do not retry an unsafe path indefinitely.
      await collection.updateOne(filter, { $set: { ...(kind === "copy" ? { status: "rejected" } : { cleanupStatus: "rejected" }), cleanupError: "OUTPUT_CLEANUP_PATH_REJECTED", cleanupCheckedAt: now }, $unset: { nextCleanupAt: "" } });
      summary.rejected += 1;
      return;
    }
    try {
      // Fresh read immediately before deletion, including after interrupted
      // completion writes: a published output in the order always wins.
      const order = await orders.findOne({ _id: new ObjectId(objectId(record.orderId)) }, { projection: { outputs: 1 } });
      if (isReferenced(order, record.objectKey)) {
        await collection.updateOne(filter, { $set: { ...(kind === "copy" ? { status: "retained" } : { cleanupStatus: "retained" }), cleanupCheckedAt: now }, $unset: { expiresAt: "", nextCleanupAt: "", cleanupError: "" } });
        summary.retained += 1;
        return;
      }
      await removeObject(record.objectKey);
      await collection.updateOne(filter, { $set: { ...(kind === "copy" ? { status: "deleted" } : { cleanupStatus: "deleted" }), deletedAt: now, cleanupCheckedAt: now }, $unset: { nextCleanupAt: "", cleanupError: "" } });
      summary.deleted += 1;
    } catch {
      // Never persist raw SDK messages, signed URLs or credentials.
      const attempts = Math.max(0, Number.isSafeInteger(record.cleanupAttempts) ? record.cleanupAttempts : 0) + 1;
      await collection.updateOne(filter, { $set: { cleanupError: "OUTPUT_CLEANUP_RETRY", cleanupAttempts: attempts, cleanupCheckedAt: now, nextCleanupAt: new Date(now.getTime() + retryDelay(attempts)) } });
      summary.retry += 1;
    }
  }

  const pendingCopies = await copies.find({ status: "staging", expiresAt: { $lte: now }, ...dueRetry }).sort({ expiresAt: 1, _id: 1 }).limit(size).toArray();
  for (const record of pendingCopies) await inspect(record, copies, "copy");
  const remaining = size - summary.examined;
  if (remaining > 0) {
    // Completed callbacks may remove expiresAt. Derive the original one-hour
    // PUT expiry from createdAt, and wait until then to prevent a still-valid
    // ticket from recreating a source object after it has been retired.
    const candidates = await uploads.find({
      cleanupStatus: { $nin: ["deleted", "retained", "rejected"] },
      $and: [dueRetry, { $or: [{ expiresAt: { $lte: now } }, { createdAt: { $lte: new Date(now.getTime() - PUT_LIFETIME_MS) } }] }],
    }).sort({ createdAt: 1, _id: 1 }).limit(remaining).toArray();
    for (const record of candidates) {
      const expiry = record.expiresAt ? new Date(record.expiresAt).getTime() : new Date(record.createdAt).getTime() + PUT_LIFETIME_MS;
      if (!Number.isFinite(expiry) || expiry > now.getTime()) continue;
      await inspect(record, uploads, "upload");
    }
  }
  return summary;
}

function authorized(header, secret) {
  const expected = Buffer.from(`Bearer ${secret}`); const actual = Buffer.from(String(header || ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function registerCapabilityOutputCleanupRoutes(app, dependencies = {}) {
  app.get(CAPABILITY_OUTPUT_CLEANUP_PATH, async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const secret = String((dependencies.readCronSecret || (() => process.env.CRON_SECRET))() || "").trim();
    if (!secret) return c.json({ code: "CRON_NOT_CONFIGURED", message: "共享能力输出清理任务尚未配置" }, 503);
    if (!authorized(c.req.header("authorization"), secret)) return c.json({ code: "UNAUTHORIZED", message: "无权执行共享能力输出清理任务" }, 401);
    try {
      const cleanup = await cleanupCapabilityOutputs({ ...dependencies, limit: 50 });
      return c.json({ ok: true, cleanup, completedAt: new Date().toISOString() });
    } catch {
      return c.json({ code: "CAPABILITY_OUTPUT_CLEANUP_UNAVAILABLE", message: "共享能力输出清理暂时不可用，请稍后重试" }, 503);
    }
  });
  app.openAPIRegistry?.registerComponent("securitySchemes", "capabilityCleanupCronBearer", {
    type: "http", scheme: "bearer", bearerFormat: "CRON_SECRET",
    description: "仅服务器定时维护密钥，不接受用户、管理员或桌面绑定令牌。",
  });
  app.openAPIRegistry?.registerPath({ method: "get", path: CAPABILITY_OUTPUT_CLEANUP_PATH, tags: ["Operations"],
    security: [{ capabilityCleanupCronBearer: [] }],
    summary: "受控清理能力订单孤立输出对象", description: "仅 CRON_SECRET Bearer 可调用；每轮最多检查50个对象。先校验精确订单专属路径并读取订单引用，任何正被引用的对象均保留；清理过期staging副本及原PUT票据过期后的源对象。删除失败保留重试，不返回对象路径或COS错误详情。",
    responses: { 200: { description: "计数汇总，不返回对象地址" }, 401: { description: "Cron鉴权失败" }, 503: { description: "Cron未配置" } },
  });
}
