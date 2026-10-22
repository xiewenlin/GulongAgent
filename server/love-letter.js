import { createHash, randomBytes } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { fingerprintIp as defaultFingerprintIp, isTrustedBrowserRequest as trustedBrowser, shouldUseSecureSessionCookie } from "./security.js";

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

/** Immutable, link-shared letters. No search/list endpoint or account data is public. */
export function registerLoveLetterRoutes(app, dependencies = {}) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const rateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  const fingerprintIp = dependencies.fingerprintIp || defaultFingerprintIp;
  const isTrustedBrowserRequest = dependencies.isTrustedBrowserRequest || trustedBrowser;
  const clock = dependencies.now || (() => new Date());
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
    if (!/^application\/json(?:;|$)/i.test(c.req.header("content-type") || "")) throw failure("INVALID_JSON", "请通过写情书窗口提交信件");
    const guestHash = visitor(c);
    let body;
    try { body = await c.req.json(); } catch { throw failure("INVALID_JSON", "信件格式不正确，请重新提交"); }
    const { clientRequestId: requestId, ...input } = normalizeLoveLetter(body);
    const fingerprint = hash(JSON.stringify(input));
    const letters = await store();
    const recover = (previous) => {
      if (previous.fingerprint !== fingerprint) throw failure("LOVE_LETTER_REQUEST_CONFLICT", "这次提交标识已用于另一封信，请重新编辑后再提交", 409);
      return { letter: publicLetter(previous), url: `/love-letter/${previous._id}`, replayed: true };
    };
    const previous = await letters.findOne({ guestHash, requestId });
    if (previous) return c.json(recover(previous));
    await limit(`create-ip:${address(c)}`, 30, 24 * 60 * 60_000);
    await limit(`create-visitor:${guestHash}`, 20, 24 * 60 * 60_000);
    const createdAt = new Date(clock());
    const letter = { _id: randomBytes(32).toString("base64url"), guestHash, requestId, fingerprint, ...input, date: dayInShanghai(createdAt), createdAt };
    try { await letters.insertOne(letter); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      // The unique guest/request index is the cross-process concurrency boundary.
      const winner = await letters.findOne({ guestHash, requestId });
      if (!winner) throw error;
      return c.json(recover(winner));
    }
    return c.json({ letter: publicLetter(letter), url: `/love-letter/${letter._id}`, replayed: false }, 201);
  });

  route("get", "/api/love-letters/:id", async (c) => {
    const id = c.req.param("id");
    if (!TOKEN.test(id || "")) throw failure("LOVE_LETTER_NOT_FOUND", "没有找到这封情书，请检查分享链接", 404);
    await limit(`read:${address(c)}`, 120);
    const letter = await (await store()).findOne({ _id: id });
    if (!letter) throw failure("LOVE_LETTER_NOT_FOUND", "没有找到这封情书，请检查分享链接", 404);
    return c.json({ letter: publicLetter(letter) });
  });

  if (app.openAPIRegistry) {
    const letter = z.object({ id: z.string().regex(TOKEN), senderName: z.string(), recipientName: z.string(), body: z.string(), backgroundColor: z.string(), date: z.string(), createdAt: z.string() });
    const response = (schema) => ({ description: "成功", content: { "application/json": { schema } } });
    const created = z.object({ letter, url: z.string(), replayed: z.boolean() });
    app.openAPIRegistry.registerPath({ method: "get", path: "/api/love-letters/session", security: [], tags: ["Love Letters"], summary: "建立同源匿名写信会话；Cookie 必须保留供提交及幂等重试使用", responses: { 200: response(z.object({ ok: z.boolean() })), 403: { description: "不受信任的来源" }, 429: { description: "请求过于频繁" } } });
    app.openAPIRegistry.registerPath({ method: "post", path: "/api/love-letters", security: [], tags: ["Love Letters"], summary: "保存纯文本情书并生成高熵分享链接；同访客与请求 UUID 幂等；日期由服务端按上海时区生成；免登录不扣费", request: { body: { content: { "application/json": { schema: z.object({ clientRequestId: z.string().uuid(), senderName: z.string().min(1).max(60), recipientName: z.string().min(1).max(60), body: z.string().min(1).max(LOVE_LETTER_MAX_LENGTH), backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i) }) } } } }, responses: { 201: response(created), 200: response(created), 400: { description: "信件字段格式不正确" }, 403: { description: "不受信任的来源" }, 409: { description: "匿名会话缺失或提交标识冲突" }, 413: { description: "超过 128 KiB 请求限制" }, 429: { description: "请求过于频繁" } } });
    app.openAPIRegistry.registerPath({ method: "get", path: "/api/love-letters/{id}", security: [], tags: ["Love Letters"], summary: "持有分享链接者免登录阅读完整信件；不包含账户身份或匿名访客标识；禁止缓存与索引", request: { params: z.object({ id: z.string().regex(TOKEN) }) }, responses: { 200: response(z.object({ letter })), 404: { description: "信件不存在" }, 429: { description: "请求过于频繁" } } });
  }
}
