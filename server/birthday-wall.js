import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection, withDatabaseTransaction } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { fingerprintIp as defaultFingerprintIp, isTrustedBrowserRequest as trustedBrowser, shouldUseSecureSessionCookie } from "./security.js";

export const BIRTHDAY_WALL_LIMIT = 1_000;
export const BIRTHDAY_NOTE_COLORS = ["#FFE5E8", "#FFF0CC", "#DCF1E1", "#DCECFB", "#EAE1FA", "#FFDECA", "#F4E3EE", "#D7F0EC"];
const COOKIE = "gulong_birthday_visitor";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMOJIS = ["🎂", "🎉", "🎈", "🎁", "✨", "💖", "🌷", "🌟", "🍰", "🥳", "🪄", "🦋", "🎊", "🌻", "🍀", "🌈"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const dayInShanghai = (value) => new Date(new Date(value).getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
const publicWall = (wall) => ({ id: String(wall._id), name: wall.name, createdAt: new Date(wall.createdAt).toISOString() });

function cleanText(value, maximum, label, required) {
  if (value == null && !required) return "";
  if (typeof value !== "string") throw failure("INVALID_BIRTHDAY_NOTE", `请填写正确的${label}`);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if ((required && !text) || [...text].length > maximum || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(text)) throw failure("INVALID_BIRTHDAY_NOTE", `${label}${required ? `需填写 1–${maximum}` : `最多填写 ${maximum}`} 个字符，请勿包含控制字符`);
  return text;
}
function parseRequestId(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("INVALID_BIRTHDAY_NOTE", "请填写内容后再提交");
  if (typeof body.clientRequestId !== "string" || !UUID.test(body.clientRequestId)) throw failure("INVALID_REQUEST_ID", "提交标识已失效，请刷新页面后重试");
  return body.clientRequestId.toLowerCase();
}

export function normalizeBirthdayNote(body) {
  return { clientRequestId: parseRequestId(body), name: cleanText(body.name, 40, "署名", false) || "一位祝福你的朋友", message: cleanText(body.message, 500, "生日祝福", true) };
}

export function decorateBirthdayNote(message, choose = randomInt) {
  const theme = /健康|平安|顺利|幸运/.test(message) ? "🍀" : /开心|快乐|幸福/.test(message) ? "🥳" : /爱|喜欢|陪伴/.test(message) ? "💖" : "🎂";
  const emojis = [theme];
  const candidates = EMOJIS.filter((value) => value !== theme);
  const count = 3 + choose(3);
  while (emojis.length < count) emojis.push(candidates.splice(choose(candidates.length), 1)[0]);
  return { emojis: emojis.join(" "), color: BIRTHDAY_NOTE_COLORS[choose(BIRTHDAY_NOTE_COLORS.length)] };
}

export function birthdayWallView(records, now = new Date()) {
  const active = records.filter((record) => record.status === "active");
  const today = dayInShanghai(now);
  return {
    notes: active.map((record) => ({ id: String(record.noteId || record._id), name: record.name, message: record.message, emojis: record.emojis, color: record.color, createdAt: new Date(record.createdAt).toISOString() })),
    stats: { total: active.length, participants: new Set(active.map((record) => record.guestHash)).size, today: active.filter((record) => dayInShanghai(record.createdAt) === today).length },
  };
}

/** User-owned, link-shared walls; public DTOs contain no account or guest IDs. */
export function registerBirthdayWallRoutes(app, dependencies = {}) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const transaction = dependencies.transaction || withDatabaseTransaction;
  const rateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  const isTrustedBrowserRequest = dependencies.isTrustedBrowserRequest || trustedBrowser;
  const fingerprintIp = dependencies.fingerprintIp || defaultFingerprintIp;
  const clock = dependencies.now || (() => new Date());
  let storePromise;
  async function ensureStore() {
    if (!storePromise) storePromise = (async () => {
      const notes = await getCollection("birthdayWallNotes");
      await notes.createIndex({ wallId: 1, status: 1, createdAt: 1 });
      const walls = await getCollection("birthdayWalls");
      await walls.createIndex({ ownerId: 1, requestId: 1 }, { unique: true });
      await walls.createIndex({ ownerId: 1, createdAt: -1 });
    })().catch((error) => { storePromise = null; throw error; });
    await storePromise;
  }
  async function atomic(operation) {
    await ensureStore();
    // UUID conflicts abort the entire transaction, including the capacity count.
    for (let attempt = 0; ; attempt++) {
      try { return await transaction(operation); }
      catch (error) { if (error?.code !== 11000 || attempt >= 2) throw error; }
    }
  }
  function route(method, path, handler) {
    app[method](path, async (c) => {
      c.header("Cache-Control", "private, no-store");
      try { return await handler(c); }
      catch (error) {
        return c.json({ code: typeof error.code === "string" ? error.code : "BIRTHDAY_WALL_UNAVAILABLE", message: error.status && error.status < 500 ? error.message : "生日墙暂时无法保存或读取，请稍后使用原提交重试" }, error.status || 503);
      }
    });
  }
  function visitor(c, create = false) {
    let raw = getCookie(c, COOKIE);
    if (!/^bw_[A-Za-z0-9_-]{43}$/.test(raw || "")) {
      if (!create) throw failure("BIRTHDAY_VISITOR_REQUIRED", "请先刷新生日墙，再提交祝福", 409);
      raw = `bw_${randomBytes(32).toString("base64url")}`;
      setCookie(c, COOKIE, raw, { httpOnly: true, secure: shouldUseSecureSessionCookie(c), sameSite: "Lax", path: "/api/birthday-walls", maxAge: 365 * 24 * 60 * 60 });
    }
    return hash(`birthday-visitor:${raw}`);
  }
  async function limit(c, operation, amount, windowMs = 60_000) {
    const address = fingerprintIp(c.req.header("x-forwarded-for") || "local");
    const rate = await rateLimit(`birthday-wall:${operation}:${address}`, { limit: amount, windowMs });
    if (!rate.allowed) throw failure("RATE_LIMITED", "祝福发送得太快了，请稍后再试", 429);
  }
  function trustedMutation(c) {
    if (!isTrustedBrowserRequest(c) || c.req.header("sec-fetch-site") === "cross-site") throw failure("ORIGIN_REJECTED", "请从生日墙页面提交祝福", 403);
    if (!/^application\/json(?:;|$)/i.test(c.req.header("content-type") || "")) throw failure("INVALID_JSON", "请通过生日墙的祝福输入框提交");
  }
  async function body(c) {
    try { return await c.req.json(); } catch { throw failure("INVALID_JSON", "祝福内容格式不正确，请重新提交"); }
  }
  async function account(c) {
    const auth = dependencies.authenticate ? await dependencies.authenticate(c) : null;
    if (auth?.error) return auth;
    if (!auth?.user?.id) throw failure("UNAUTHORIZED", "请先登录，再创建自己的生日墙", 401);
    return auth;
  }
  function requestedWallId(c) {
    const id = c.req.param("wallId");
    if (!UUID.test(id || "")) throw failure("BIRTHDAY_WALL_NOT_FOUND", "没有找到这面生日墙，请检查收集链接", 404);
    return id.toLowerCase();
  }
  async function findWall(c, session) {
    const wall = await (await getCollection("birthdayWalls")).findOne({ _id: requestedWallId(c), status: "active" }, { session });
    if (!wall) throw failure("BIRTHDAY_WALL_NOT_FOUND", "没有找到这面生日墙，请检查收集链接", 404);
    return wall;
  }

  app.use("/api/birthday-walls", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "填写内容过长，请缩短后再发送" }, 413) }));
  app.use("/api/birthday-walls/:wallId/notes", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "生日祝福内容过长，请缩短后再发送" }, 413) }));

  route("post", "/api/birthday-walls", async (c) => {
    trustedMutation(c);
    const auth = await account(c);
    if (auth.error) return auth.error;
    const input = await body(c);
    const requestId = parseRequestId(input);
    const name = cleanText(input.name, 40, "寿星姓名", true);
    const ownerId = String(auth.user.id);
    const walls = await getCollection("birthdayWalls");
    const recover = (wall) => {
      if (wall.name !== name || wall.status !== "active") throw failure("BIRTHDAY_REQUEST_CONFLICT", "这次创建请求已被使用，请重新填写后再创建", 409);
      return { wall: publicWall(wall), url: `/birthday-wall/${wall._id}`, replayed: true };
    };
    const previous = await walls.findOne({ ownerId, requestId });
    if (previous) return c.json(recover(previous));
    await limit(c, "create", 10, 24 * 60 * 60_000);
    const rate = await rateLimit(`birthday-wall:create-owner:${hash(ownerId)}`, { limit: 10, windowMs: 24 * 60 * 60_000 });
    if (!rate.allowed) throw failure("RATE_LIMITED", "今天创建的生日墙较多，请明天再试", 429);
    const wall = { _id: randomUUID(), ownerId, requestId, name, status: "active", count: 0, createdAt: clock() };
    const saved = await atomic(async (session) => {
      const existing = await walls.findOne({ ownerId, requestId }, { session });
      if (existing) return recover(existing);
      await walls.insertOne(wall, { session });
      return { wall: publicWall(wall), url: `/birthday-wall/${wall._id}`, replayed: false };
    });
    return c.json(saved, saved.replayed ? 200 : 201);
  });

  route("get", "/api/birthday-walls/mine", async (c) => {
    const auth = await account(c);
    if (auth.error) return auth.error;
    await limit(c, "mine", 120);
    await ensureStore();
    const walls = await (await getCollection("birthdayWalls")).find({ ownerId: String(auth.user.id), status: "active" }).sort({ createdAt: -1, _id: -1 }).toArray();
    return c.json({ walls: walls.map(publicWall) });
  });

  route("get", "/api/birthday-walls/:wallId", async (c) => {
    await limit(c, "read", 120);
    await ensureStore();
    const wall = await findWall(c);
    visitor(c, true);
    const records = await (await getCollection("birthdayWallNotes")).find({ wallId: wall._id, status: "active" }).sort({ createdAt: 1, _id: 1 }).limit(BIRTHDAY_WALL_LIMIT + 1).toArray();
    if (records.length > BIRTHDAY_WALL_LIMIT) throw failure("BIRTHDAY_WALL_CAPACITY_ERROR", "生日墙数据需要管理员检查", 503);
    return c.json({ wall: publicWall(wall), ...birthdayWallView(records, clock()) });
  });

  route("post", "/api/birthday-walls/:wallId/notes", async (c) => {
    trustedMutation(c);
    const wall = await findWall(c);
    const guestHash = visitor(c);
    const input = normalizeBirthdayNote(await body(c));
    const fingerprint = hash(JSON.stringify({ name: input.name, message: input.message }));
    const noteId = `${wall._id}:${input.clientRequestId}`;
    const notes = await getCollection("birthdayWallNotes");
    const recover = (existing) => {
      if (existing.guestHash !== guestHash || existing.fingerprint !== fingerprint) throw failure("BIRTHDAY_REQUEST_CONFLICT", "这次提交已被使用，请重新编辑后再发送", 409);
      if (existing.status !== "active") throw failure("BIRTHDAY_NOTE_REMOVED", "这条祝福已被管理员移除", 410);
      return existing;
    };
    const previous = await notes.findOne({ _id: noteId, wallId: wall._id });
    if (previous) return c.json({ note: birthdayWallView([recover(previous)], clock()).notes[0], replayed: true });
    await limit(c, "write", 8, 10 * 60_000);
    const guestRate = await rateLimit(`birthday-wall:visitor:${guestHash}`, { limit: 5, windowMs: 10 * 60_000 });
    if (!guestRate.allowed) throw failure("RATE_LIMITED", "祝福发送得太快了，请稍后再试", 429);
    const createdAt = clock();
    const draft = { _id: noteId, noteId: input.clientRequestId, wallId: wall._id, guestHash, fingerprint, name: input.name, message: input.message, ...decorateBirthdayNote(input.message), createdAt, status: "active" };
    const saved = await atomic(async (session) => {
      const existing = await notes.findOne({ _id: noteId, wallId: wall._id }, { session });
      if (existing) return { note: recover(existing), replayed: true };
      const capacity = await (await getCollection("birthdayWalls")).findOneAndUpdate({ _id: wall._id, status: "active", count: { $lt: BIRTHDAY_WALL_LIMIT } }, { $inc: { count: 1 }, $set: { updatedAt: createdAt } }, { session, returnDocument: "after" });
      if (!capacity) throw failure("BIRTHDAY_WALL_FULL", "生日墙已写满，请先导出留念并联系管理员整理", 409);
      await notes.insertOne(draft, { session });
      return { note: draft, replayed: false };
    });
    return c.json({ note: birthdayWallView([saved.note], createdAt).notes[0], replayed: saved.replayed }, saved.replayed ? 200 : 201);
  });

  route("delete", "/api/admin/birthday-walls/:wallId/notes/:id", async (c) => {
    if (!isTrustedBrowserRequest(c) || c.req.header("sec-fetch-site") === "cross-site") throw failure("ORIGIN_REJECTED", "请求来源不受信任", 403);
    const auth = dependencies.authenticate ? await dependencies.authenticate(c) : null;
    if (auth?.error) return auth.error;
    if (!auth?.user) throw failure("UNAUTHORIZED", "请先登录管理员账号", 401);
    if (auth.user.role !== "admin") throw failure("ADMIN_REQUIRED", "只有管理员可以整理生日墙", 403);
    const wall = await findWall(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) throw failure("BIRTHDAY_NOTE_NOT_FOUND", "没有找到这条祝福", 404);
    const removed = await atomic(async (session) => {
      const notes = await getCollection("birthdayWallNotes");
      const note = await notes.findOne({ _id: `${wall._id}:${id.toLowerCase()}`, wallId: wall._id }, { session });
      if (!note) throw failure("BIRTHDAY_NOTE_NOT_FOUND", "没有找到这条祝福", 404);
      if (note.status !== "active") return false;
      const changed = await notes.updateOne({ _id: note._id, wallId: wall._id, status: "active" }, { $set: { status: "deleted", deletedAt: clock(), deletedBy: auth.user.id }, $unset: { message: "", name: "", emojis: "" } }, { session });
      if (changed.modifiedCount) await (await getCollection("birthdayWalls")).updateOne({ _id: wall._id, count: { $gt: 0 } }, { $inc: { count: -1 }, $set: { updatedAt: clock() } }, { session });
      return Boolean(changed.modifiedCount);
    });
    return c.json({ ok: true, removed });
  });

  if (app.openAPIRegistry) {
    const note = z.object({ id: z.string(), name: z.string(), message: z.string(), emojis: z.string(), color: z.string(), createdAt: z.string() });
    const wall = z.object({ id: z.string().uuid(), name: z.string(), createdAt: z.string() });
    const params = z.object({ wallId: z.string().uuid() });
    const response = (schema) => ({ description: "成功", content: { "application/json": { schema } } });
    const created = z.object({ wall, url: z.string(), replayed: z.boolean() });
    app.openAPIRegistry.registerPath({ method: "post", path: "/api/birthday-walls", tags: ["Birthday Wall"], summary: "登录后为寿星创建独立空生日墙和收集链接；按账号与 UUID 幂等", request: { body: { content: { "application/json": { schema: z.object({ clientRequestId: z.string().uuid(), name: z.string().min(1).max(40) }) } } } }, responses: { 201: response(created), 200: response(created), 401: { description: "请先登录" }, 409: { description: "同一请求内容不一致" } } });
    app.openAPIRegistry.registerPath({ method: "get", path: "/api/birthday-walls/mine", tags: ["Birthday Wall"], summary: "仅查看当前登录账号创建的生日墙", responses: { 200: response(z.object({ walls: z.array(wall) })), 401: { description: "请先登录" } } });
    app.openAPIRegistry.registerPath({ method: "get", path: "/api/birthday-walls/{wallId}", tags: ["Birthday Wall"], summary: "读取独立生日墙、公开祝福与上海时区统计，并建立匿名访客 Cookie", request: { params }, responses: { 200: response(z.object({ wall, notes: z.array(note), stats: z.object({ total: z.number(), participants: z.number(), today: z.number() }) })), 404: { description: "生日墙不存在" } } });
    app.openAPIRegistry.registerPath({ method: "post", path: "/api/birthday-walls/{wallId}/notes", tags: ["Birthday Wall"], summary: "匿名提交此墙的生日祝福；同源、限流、UUID 幂等；不创建图片订单、不扣费", request: { params, body: { content: { "application/json": { schema: z.object({ clientRequestId: z.string().uuid(), name: z.string().max(40).optional(), message: z.string().min(1).max(500) }) } } } }, responses: { 201: response(z.object({ note, replayed: z.boolean() })), 200: response(z.object({ note, replayed: z.boolean() })), 409: { description: "提交冲突、访客身份缺失或生日墙已满" }, 429: { description: "提交过于频繁" } } });
    app.openAPIRegistry.registerPath({ method: "delete", path: "/api/admin/birthday-walls/{wallId}/notes/{id}", tags: ["Birthday Wall"], summary: "管理员移除此生日墙的公开祝福，重复操作不重复减少计数", request: { params: z.object({ wallId: z.string().uuid(), id: z.string().uuid() }) }, responses: { 200: response(z.object({ ok: z.boolean(), removed: z.boolean() })), 401: { description: "需要登录" }, 403: { description: "需要管理员权限" } } });
  }
}
