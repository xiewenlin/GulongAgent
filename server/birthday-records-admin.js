import { z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { getCollection as databaseCollection, withDatabaseTransaction } from "./db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const iso = (date) => date ? new Date(date).toISOString() : null;
const active = { status: { $ne: "deleted" } };
const revisionOf = (row) => Number.isSafeInteger(row.revision) ? row.revision : 0;
const wallView = (row) => ({ id: String(row._id), name: row.name, ownerId: String(row.ownerId || ""), noteCount: row.count || 0, createdAt: iso(row.createdAt) });
const letterView = (row, detail = false) => ({ id: String(row._id), senderName: row.senderName, recipientName: row.recipientName, date: row.date, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), passwordSet: Boolean(row.passwordHash), characterCount: [...String(row.body || "")].length, revision: revisionOf(row), ...(detail ? { body: row.body, backgroundColor: row.backgroundColor } : {}) });
const noteView = (row) => ({ id: String(row.noteId || row._id), name: row.name, message: row.message, emojis: row.emojis, color: row.color, createdAt: iso(row.createdAt) });

export function normalizeAdminLetterEdit(body) {
  if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0) throw fail("INVALID_REVISION", "记录版本已失效，请重新打开详情");
  function text(field, limit, multiline = false) {
    const value = body[field];
    if (typeof value !== "string") throw fail("INVALID_LOVE_LETTER", "请完整填写署名、收件人和正文");
    const normalized = value.replace(/\r\n?/g, "\n").trim();
    if (!normalized || [...normalized].length > limit || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(normalized) || (!multiline && normalized.includes("\n"))) throw fail("INVALID_LOVE_LETTER", `姓名最多 60 字，正文最多 20000 字，且不能包含控制字符`);
    return normalized;
  }
  if (!/^#[0-9a-f]{6}$/i.test(body.backgroundColor || "")) throw fail("INVALID_LETTER_COLOR", "请选择有效的信纸颜色");
  return { revision: body.revision, senderName: text("senderName", 60), recipientName: text("recipientName", 60), body: text("body", 20000, true), backgroundColor: body.backgroundColor.toUpperCase() };
}

/** Administrator-only content management. Never expose password hashes, visitor IDs or request fingerprints. */
export function registerBirthdayRecordAdminRoutes(app, dependencies) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const transaction = dependencies.transaction || withDatabaseTransaction;
  const now = dependencies.now || (() => new Date());
  let indexes;
  async function ensureStore() {
    if (!indexes) indexes = Promise.all(["birthdayWalls", "loveLetters"].map(async (name) => {
      await (await getCollection(name)).createIndex({ status: 1, createdAt: -1, _id: -1 });
    })).catch((error) => { indexes = null; throw error; });
    await indexes;
  }
  app.use("/api/admin/birthday-records/*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "内容过长，请缩短后再保存" }, 413) }));
  function route(method, path, handler) {
    app[method](path, async (c) => {
      c.header("Cache-Control", "private, no-store");
      try {
        const auth = await dependencies.requireAdmin(c);
        if (auth?.error) return auth.error;
        // Keep this explicit even when a test/embedding provides a bad auth dependency.
        if (!auth?.user?.id || auth.user.role !== "admin") return c.json({ code: "ADMIN_REQUIRED", message: "只有管理员可以管理生日墙和情书" }, 403);
        if (method !== "get") {
          const denied = dependencies.requireTrustedMutation(c);
          if (denied) return denied;
        }
        await ensureStore();
        return await handler(c, auth);
      } catch (error) {
        return c.json({ code: error.status ? error.code : "BIRTHDAY_RECORDS_UNAVAILABLE", message: error.status && error.status < 500 ? error.message : "历史记录暂时无法处理，请稍后重试" }, error.status || 503);
      }
    });
  }
  function target(c) {
    const type = c.req.param("type"), id = c.req.param("id");
    if (!["walls", "letters"].includes(type) || !(type === "walls" ? UUID : TOKEN).test(id || "")) throw fail("RECORD_NOT_FOUND", "没有找到这条记录", 404);
    return { type, id: type === "walls" ? id.toLowerCase() : id, name: type === "walls" ? "birthdayWalls" : "loveLetters" };
  }
  async function audit(auth, action, type, id, session, extra = {}) {
    // The audit never stores letter text, viewing passwords, visitor cookies or hashes.
    await (await getCollection("contentManagementAudit")).insertOne({ actorId: String(auth.user.id), action, recordType: type, recordId: id, createdAt: now(), ...extra }, { session });
  }
  route("get", "/api/admin/birthday-records", async (c) => {
    const type = c.req.query("type") || "walls", q = String(c.req.query("q") || "").trim();
    const page = Number(c.req.query("page") || 1), pageSize = Number(c.req.query("pageSize") || 20);
    if (!["walls", "letters"].includes(type) || q.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw fail("INVALID_FILTER", "搜索词最多 100 字，每页最多 50 条，请检查筛选条件");
    const filter = { ...active };
    if (q) {
      const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fields = type === "walls" ? ["name", "ownerId", "_id"] : ["senderName", "recipientName", "body", "_id"];
      filter.$or = fields.map((field) => ({ [field]: { $regex: pattern, $options: "i" } }));
    }
    const records = await getCollection(type === "walls" ? "birthdayWalls" : "loveLetters");
    const [total, rows] = await Promise.all([
      records.countDocuments(filter, { maxTimeMS: 5000 }),
      records.find(filter, { projection: type === "walls" ? { name: 1, ownerId: 1, count: 1, createdAt: 1 } : { senderName: 1, recipientName: 1, date: 1, createdAt: 1, updatedAt: 1, passwordHash: 1, body: 1, revision: 1 }, maxTimeMS: 5000 }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    ]);
    return c.json({ type, items: rows.map(type === "walls" ? wallView : (row) => letterView(row)), total, page, pageSize });
  });
  route("get", "/api/admin/birthday-records/:type/:id", async (c, auth) => {
    const { type, id, name } = target(c);
    const row = await (await getCollection(name)).findOne({ _id: id, ...active });
    if (!row) throw fail("RECORD_NOT_FOUND", "记录不存在或已删除", 404);
    const record = type === "walls" ? { ...wallView(row), notes: (await (await getCollection("birthdayWallNotes")).find({ wallId: id, status: "active" }).sort({ createdAt: 1, _id: 1 }).limit(1000).toArray()).map(noteView) } : letterView(row, true);
    await audit(auth, "view", type, id);
    return c.json({ type, record });
  });
  route("patch", "/api/admin/birthday-records/:type/:id", async (c, auth) => {
    const { type, id, name } = target(c);
    if (type !== "letters") throw fail("EDIT_UNSUPPORTED", "当前仅支持修改情书内容");
    let input;
    try { input = await c.req.json(); } catch { throw fail("INVALID_JSON", "请检查填写内容后重新保存"); }
    const { revision, ...patch } = normalizeAdminLetterEdit(input);
    const record = await transaction(async (session) => {
      const collection = await getCollection(name);
      const current = await collection.findOne({ _id: id, ...active }, { session });
      if (!current) throw fail("RECORD_NOT_FOUND", "情书不存在或已删除", 404);
      if (revisionOf(current) !== revision) throw fail("RECORD_CHANGED", "记录已被其他管理员修改，请刷新详情后再保存", 409);
      const guard = current.revision === undefined ? { revision: { $exists: false } } : { revision };
      const changed = await collection.findOneAndUpdate({ _id: id, ...active, ...guard }, { $set: { ...patch, revision: revision + 1, updatedAt: now(), updatedBy: String(auth.user.id) } }, { session, returnDocument: "after" });
      if (!changed) throw fail("RECORD_CHANGED", "记录已变化，请刷新详情后再保存", 409);
      await audit(auth, "edit", type, id, session, { revision: revision + 1, fields: Object.keys(patch) });
      return letterView(changed, true);
    });
    return c.json({ ok: true, record });
  });
  route("delete", "/api/admin/birthday-records/:type/:id", async (c, auth) => {
    const { type, id, name } = target(c);
    const removed = await transaction(async (session) => {
      const collection = await getCollection(name);
      const current = await collection.findOne({ _id: id }, { session });
      if (!current || current.status === "deleted") return false;
      const deletedAt = now(), deletedBy = String(auth.user.id);
      const unset = type === "walls" ? { name: "" } : { senderName: "", recipientName: "", body: "", backgroundColor: "", date: "", passwordHash: "", passwordSetAt: "" };
      const changed = await collection.updateOne({ _id: id, ...active }, { $set: { status: "deleted", deletedAt, deletedBy, ...(type === "walls" ? { count: 0 } : {}) }, $unset: unset }, { session });
      if (!changed.modifiedCount) return false;
      if (type === "walls") await (await getCollection("birthdayWallNotes")).updateMany({ wallId: id }, { $set: { status: "deleted", deletedAt, deletedBy }, $unset: { name: "", message: "", emojis: "", color: "" } }, { session });
      await audit(auth, "delete", type, id, session);
      return true;
    });
    return c.json({ ok: true, removed });
  });
  if (app.openAPIRegistry) {
    const record = z.object({ id: z.string() }).passthrough();
    const response = (schema) => ({ description: "成功", content: { "application/json": { schema } } });
    const params = z.object({ type: z.enum(["walls", "letters"]), id: z.string() });
    const common = { tags: ["Birthday Administration"], security: [{ bearerAuth: [] }], responses: { 401: { description: "需要登录" }, 403: { description: "需要管理员权限" } } };
    app.openAPIRegistry.registerPath({ ...common, method: "get", path: "/api/admin/birthday-records", summary: "管理员搜索生日墙/情书，创建时间倒序分页；不返回密码摘要、访客身份或情书正文", request: { query: z.object({ type: z.enum(["walls", "letters"]).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).max(10000).optional(), pageSize: z.coerce.number().int().min(1).max(50).optional() }) }, responses: { ...common.responses, 200: response(z.object({ type: z.string(), items: z.array(record), total: z.number(), page: z.number(), pageSize: z.number() })) } });
    app.openAPIRegistry.registerPath({ ...common, method: "get", path: "/api/admin/birthday-records/{type}/{id}", summary: "管理员查看完整详情并记录访问审计；不返回查看密码", request: { params }, responses: { ...common.responses, 200: response(z.object({ type: z.string(), record })), 404: { description: "已删除或不存在" } } });
    app.openAPIRegistry.registerPath({ ...common, method: "patch", path: "/api/admin/birthday-records/{type}/{id}", summary: "仅修改情书署名、收件人、正文和颜色；保留密码、日期与链接；revision 防并发覆盖并写审计", request: { params, body: { content: { "application/json": { schema: z.object({ revision: z.number().int().min(0), senderName: z.string().min(1).max(60), recipientName: z.string().min(1).max(60), body: z.string().min(1).max(20000), backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i) }) } } } }, responses: { ...common.responses, 200: response(z.object({ ok: z.boolean(), record })), 409: { description: "记录已变化" } } });
    app.openAPIRegistry.registerPath({ ...common, method: "delete", path: "/api/admin/birthday-records/{type}/{id}", summary: "幂等删除内容与密码摘要，墙内祝福同步删除，原链接失效；保留最小防重放墓碑和审计，不影响订单余额", request: { params }, responses: { ...common.responses, 200: response(z.object({ ok: z.boolean(), removed: z.boolean() })) } });
  }
}
