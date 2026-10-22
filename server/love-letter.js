import { createHash, randomBytes } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { fingerprintIp as defaultFingerprintIp, isTrustedBrowserRequest as trustedBrowser, shouldUseSecureSessionCookie, hashPassword, verifyPassword } from "./security.js";

export const LOVE_LETTER_MAX_LENGTH = 20_000;
const COOKIE = "gulong_love_letter_visitor";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const dayInShanghai = (date) => new Date(date.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
const publicLetter = (letter) => ({
  id: letter._id,
  senderName: letter.senderName,
  recipientName: letter.recipientName,
  body: letter.body,
  backgroundColor: letter.backgroundColor,
  date: letter.date,
  createdAt: new Date(letter.createdAt).toISOString(),
});

function cleanText(value, maximum, label, multiline = false) {
  if (typeof value !== "string") throw failure("INVALID_LOVE_LETTER", `请填写${label}`);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text || [...text].length > maximum || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(text) || (!multiline && /\n/.test(text))) {
    throw failure("INVALID_LOVE_LETTER", `${label}需填写 1–${maximum} 个字符，请勿包含控制字符${multiline ? "" : "或换行"}`);
  }
  return text;
}

export function normalizeLoveLetter(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("INVALID_LOVE_LETTER", "请填写信件内容后再提交");
  if (typeof input.clientRequestId !== "string" || !UUID.test(input.clientRequestId)) throw failure("INVALID_REQUEST_ID", "提交标识已失效，请重新打开写信窗口后再试");
  if (typeof input.backgroundColor !== "string" || !/^#[0-9a-f]{6}$/i.test(input.backgroundColor)) throw failure("INVALID_LETTER_COLOR", "请选择有效的信纸背景颜色");
  return {
    clientRequestId: input.clientRequestId.toLowerCase(),
    senderName: cleanText(input.senderName, 60, "署名"),
    recipientName: cleanText(input.recipientName, 60, "收件人"),
    body: cleanText(input.body, LOVE_LETTER_MAX_LENGTH, "信件正文", true),
    backgroundColor: input.backgroundColor.toUpperCase(),
  };
}

export function normalizeLoveLetterPassword(value) {
  if (typeof value !== "string" || [...value].length < 6 || [...value].length > 128 || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw failure("INVALID_VIEWING_PASSWORD", "请设置 6–128 个字符的查看密码，不可全为空白或包含控制字符");
  }
  // Deliberately do not trim, normalize Unicode or restrict character classes.
  return value;
}

const hasPassword = (letter) => typeof letter?.passwordHash === "string" && Boolean(letter.passwordHash);
const removed = () => failure("LOVE_LETTER_REMOVED", "这封情书已被删除，无法继续查看或恢复", 410);
const notFound = () => failure("LOVE_LETTER_NOT_FOUND", "没有找到这封情书，请检查分享链接", 404);

/** Immutable, link-shared letters. No search/list endpoint or account data is public. */
export function registerLoveLetterRoutes(app, dependencies = {}) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const rateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  const fingerprintIp = dependencies.fingerprintIp || defaultFingerprintIp;
  const isTrustedBrowserRequest = dependencies.isTrustedBrowserRequest || trustedBrowser;
  const clock = dependencies.now || (() => new Date());
  const encodePassword = dependencies.hashPassword || hashPassword;
  const comparePassword = dependencies.verifyPassword || verifyPassword;
  let storePromise;
  async function store() {
    if (!storePromise) storePromise = (async () => {
      const letters = await getCollection("loveLetters");
      await letters.createIndex({ guestHash: 1, requestId: 1 }, { unique: true });
      return letters;
    })().catch((error) => { storePromise = null; throw error; });
    return storePromise;
  }
  async function limit(key, amount, windowMs = 60_000) {
    const result = await rateLimit(`love-letter:${key}`, { limit: amount, windowMs });
    if (!result.allowed) throw failure("RATE_LIMITED", "操作较频繁，请稍后再试", 429);
  }
  const address = (c) => fingerprintIp(c.req.header("x-forwarded-for") || "local");
  function trusted(c) {
    if (!isTrustedBrowserRequest(c) || c.req.header("sec-fetch-site") === "cross-site") throw failure("ORIGIN_REJECTED", "请从生日墙的写情书窗口提交", 403);
  }
  async function json(c) {
    if (!/^application\/json(?:;|$)/i.test(c.req.header("content-type") || "")) throw failure("INVALID_JSON", "请通过情书页面提交");
    try { return await c.req.json(); } catch { throw failure("INVALID_JSON", "提交格式不正确，请重新提交"); }
  }
  async function passwordLimit(c, id, operation = "unlock") {
    const ip = address(c);
    await limit(`${operation}-ip:${ip}`, 20, 10 * 60_000);
    await limit(`${operation}-letter-ip:${hash(String(id || ""))}:${ip}`, 6, 10 * 60_000);
  }
  function visitor(c, create = false) {
    let raw = getCookie(c, COOKIE);
    if (!/^llv_[A-Za-z0-9_-]{43}$/.test(raw || "")) {
      if (!create) throw failure("LOVE_LETTER_VISITOR_REQUIRED", "写信会话已失效，请重新打开写信窗口后再试", 409);
      raw = `llv_${randomBytes(32).toString("base64url")}`;
      setCookie(c, COOKIE, raw, { httpOnly: true, secure: shouldUseSecureSessionCookie(c), sameSite: "Lax", path: "/api/love-letters", maxAge: 365 * 24 * 60 * 60 });
    }
    return hash(`love-letter-visitor:${raw}`);
  }
  app.use("/api/love-letters", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.use("/api/love-letters/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.use("/api/love-letters", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "信件内容过长，请缩短后再发送" }, 413) }));
  app.use("/api/love-letters/:id/unlock", bodyLimit({ maxSize: 2 * 1024, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "密码内容过长，请重新输入" }, 413) }));
  app.use("/api/love-letters/:id/password", bodyLimit({ maxSize: 2 * 1024, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "密码内容过长，请重新输入" }, 413) }));
  function route(method, path, handler) {
    app[method](path, async (c) => {
      try { return await handler(c); }
      catch (error) {
        return c.json({
          code: typeof error.code === "string" ? error.code : "LOVE_LETTER_UNAVAILABLE",
          message: error.status && error.status < 500 ? error.message : "情书暂时无法保存或读取，请稍后使用原提交重试",
        }, error.status || 503);
      }
    });
  }

  route("get", "/api/love-letters/session", async (c) => {
    trusted(c);
    await limit(`session:${address(c)}`, 60);
    visitor(c, true);
    return c.json({ ok: true });
  });

  route("post", "/api/love-letters", async (c) => {
    trusted(c);
    const guestHash = visitor(c);
    const body = await json(c);
    const { clientRequestId: requestId, ...input } = normalizeLoveLetter(body);
    const viewingPassword = normalizeLoveLetterPassword(body.viewingPassword);
    // The fast content fingerprint must never contain a password or its hash.
    const fingerprint = hash(JSON.stringify(input));
    const letters = await store();
    const recover = async (previous) => {
      if (previous.status === "deleted") throw removed();
      if (previous.fingerprint !== fingerprint) throw failure("LOVE_LETTER_REQUEST_CONFLICT", "这次提交标识已用于另一封信，请重新编辑后再提交", 409);
      if (!hasPassword(previous)) throw failure("LOVE_LETTER_PASSWORD_REQUIRED", "这封旧情书尚未设置查看密码，请先为原信件设置密码", 409);
      await passwordLimit(c, previous._id, "replay");
      if (!(await comparePassword(viewingPassword, previous.passwordHash))) throw failure("LOVE_LETTER_REQUEST_CONFLICT", "这次提交的查看密码与原信件不同，请使用原密码重试", 409);
      const current = await letters.findOne({ _id: previous._id, passwordHash: previous.passwordHash, status: { $ne: "deleted" } });
      if (!current) throw removed();
      return { letter: publicLetter(current), url: `/love-letter/${current._id}`, replayed: true };
    };
    const previous = await letters.findOne({ guestHash, requestId });
    if (previous) return c.json(await recover(previous));
    await limit(`create-ip:${address(c)}`, 30, 24 * 60 * 60_000);
    await limit(`create-visitor:${guestHash}`, 20, 24 * 60 * 60_000);
    const createdAt = new Date(clock());
    const passwordHash = await encodePassword(viewingPassword);
    const letter = { _id: randomBytes(32).toString("base64url"), guestHash, requestId, fingerprint, ...input, status: "active", passwordHash, passwordSetAt: createdAt, date: dayInShanghai(createdAt), createdAt };
    try { await letters.insertOne(letter); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      // The unique guest/request index is the cross-process concurrency boundary.
      const winner = await letters.findOne({ guestHash, requestId });
      if (!winner) throw error;
      return c.json(await recover(winner));
    }
    return c.json({ letter: publicLetter(letter), url: `/love-letter/${letter._id}`, replayed: false }, 201);
  });

  route("get", "/api/love-letters/:id", async (c) => {
    const id = c.req.param("id");
    if (!TOKEN.test(id || "")) throw notFound();
    await limit(`read:${address(c)}`, 120);
    const letter = await (await store()).findOne({ _id: id, status: { $ne: "deleted" } });
    if (!letter) throw notFound();
    return c.json({ locked: true, passwordSet: hasPassword(letter) });
  });

  route("post", "/api/love-letters/:id/unlock", async (c) => {
    trusted(c);
    const id = c.req.param("id");
    await passwordLimit(c, id);
    const input = await json(c);
    const denied = () => failure("LOVE_LETTER_PASSWORD_INVALID", "查看密码不正确，或信件尚未设置密码，请向写信人确认", 403);
    let password;
    try { password = normalizeLoveLetterPassword(input?.password); } catch { throw denied(); }
    if (!TOKEN.test(id || "")) throw denied();
    const letters = await store();
    const letter = await letters.findOne({ _id: id });
    if (letter?.status === "deleted") throw notFound();
    if (!hasPassword(letter) || !(await comparePassword(password, letter.passwordHash))) throw denied();
    const current = await letters.findOne({ _id: id, passwordHash: letter.passwordHash, status: { $ne: "deleted" } });
    if (!current) throw notFound();
    return c.json({ letter: publicLetter(current) });
  });

  route("post", "/api/love-letters/:id/password", async (c) => {
    trusted(c);
    const id = c.req.param("id");
    await passwordLimit(c, id, "set-password");
    const input = await json(c);
    const password = normalizeLoveLetterPassword(input?.password);
    const denied = () => failure("LOVE_LETTER_OWNER_REQUIRED", "只有原写信设备可以为这封旧情书设置查看密码", 403);
    let guestHash;
    try { guestHash = visitor(c); } catch { throw denied(); }
    if (!TOKEN.test(id || "")) throw denied();
    const letters = await store();
    const letter = await letters.findOne({ _id: id, guestHash });
    if (!letter) throw denied();
    if (letter.status === "deleted") throw notFound();
    const alreadySet = () => failure("LOVE_LETTER_PASSWORD_ALREADY_SET", "这封情书已经设置查看密码，不能重复修改，请使用原密码打开", 409);
    if (hasPassword(letter)) throw alreadySet();
    const passwordHash = await encodePassword(password);
    const saved = await letters.findOneAndUpdate(
      { _id: id, guestHash, status: { $ne: "deleted" }, $or: [{ passwordHash: { $exists: false } }, { passwordHash: null }, { passwordHash: "" }] },
      { $set: { passwordHash, passwordSetAt: new Date(clock()) } },
      { returnDocument: "after" },
    );
    if (!saved) {
      if ((await letters.findOne({ _id: id, guestHash }))?.status === "deleted") throw notFound();
      throw alreadySet();
    }
    return c.json({ ok: true, passwordSet: true });
  });

  if (app.openAPIRegistry) {
    const letter = z.object({ id: z.string().regex(TOKEN), senderName: z.string(), recipientName: z.string(), body: z.string(), backgroundColor: z.string(), date: z.string(), createdAt: z.string() });
    const response = (schema) => ({ description: "成功", content: { "application/json": { schema } } });
    const created = z.object({ letter, url: z.string(), replayed: z.boolean() });
    const password = z.string().min(6).max(128);
    const params = z.object({ id: z.string().regex(TOKEN) });
    const passwordRequest = { params, body: { content: { "application/json": { schema: z.object({ password }) } } } };
    app.openAPIRegistry.registerPath({ method: "get", path: "/api/love-letters/session", security: [], tags: ["Love Letters"], summary: "建立同源匿名写信会话；Cookie 必须保留供提交及幂等重试使用", responses: { 200: response(z.object({ ok: z.boolean() })), 403: { description: "不受信任的来源" }, 429: { description: "请求过于频繁" } } });
    app.openAPIRegistry.registerPath({ method: "post", path: "/api/love-letters", security: [], tags: ["Love Letters"], summary: "保存密码保护的纯文本情书；同访客、请求 UUID、内容与查看密码幂等；上海时区日期；免登录不扣费", request: { body: { content: { "application/json": { schema: z.object({ clientRequestId: z.string().uuid(), senderName: z.string().min(1).max(60), recipientName: z.string().min(1).max(60), body: z.string().min(1).max(LOVE_LETTER_MAX_LENGTH), backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i), viewingPassword: password }) } } } }, responses: { 201: response(created), 200: response(created), 400: { description: "信件或查看密码格式不正确" }, 403: { description: "不受信任的来源" }, 409: { description: "匿名会话缺失、提交冲突或旧信尚未设置密码" }, 413: { description: "超过 128 KiB 请求限制" }, 429: { description: "请求过于频繁" } } });
    app.openAPIRegistry.registerPath({ method: "get", path: "/api/love-letters/{id}", security: [], tags: ["Love Letters"], summary: "只返回信件锁定状态，永不返回姓名或正文；未设密码的旧信同样锁定", request: { params }, responses: { 200: response(z.object({ locked: z.literal(true), passwordSet: z.boolean() })), 404: { description: "信件不存在" }, 429: { description: "请求过于频繁" } } });
    app.openAPIRegistry.registerPath({ method: "post", path: "/api/love-letters/{id}/unlock", security: [], tags: ["Love Letters"], summary: "服务端验证查看密码后返回完整信件；严格限流；不签发访问令牌，刷新需重新输入", request: passwordRequest, responses: { 200: response(z.object({ letter })), 403: { description: "密码不正确或信件未受密码保护" }, 413: { description: "超过 2 KiB 请求限制" }, 429: { description: "密码验证过于频繁" } } });
    app.openAPIRegistry.registerPath({ method: "post", path: "/api/love-letters/{id}/password", security: [], tags: ["Love Letters"], summary: "仅原创建访客 Cookie 可为无密码旧信原子补设密码；禁止覆盖已有密码", request: passwordRequest, responses: { 200: response(z.object({ ok: z.literal(true), passwordSet: z.literal(true) })), 400: { description: "密码格式不正确" }, 403: { description: "不是原创建访客" }, 409: { description: "已设密码，不能修改" }, 413: { description: "超过 2 KiB 请求限制" }, 429: { description: "设置密码过于频繁" } } });
  }
}
