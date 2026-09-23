import { createHash } from "node:crypto";
import { getCollection } from "./db.js";
import { enforceRateLimit } from "./rate-limit.js";
import { loginWithChandler, logoutFromChandler, resolveWebsiteLoginEmail, resolveChandlerIdentity, upsertChandlerUser } from "./chandler.js";
import { readEnglishEntitlement } from "./english-coach-products.js";
import { createEnglishSessionStore } from "./desktop-english-sessions.js";

export const ENGLISH_DESKTOP_ROOT = "/api/v1/desktop/english-coach";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const invalid = () => Object.assign(new Error("请输入有效的用户名、邮箱和密码"), { status: 400, code: "VALIDATION_ERROR" });
const bearer = (c) => { const value = String(c.req.header("authorization") || ""); return value.startsWith("Bearer ") ? value.slice(7) : ""; };
async function readBody(c) {
  if (!String(c.req.header("content-type") || "").toLowerCase().startsWith("application/json")) throw invalid();
  const reader = c.req.raw.body?.getReader(); if (!reader) throw invalid();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw invalid(); }
      chunks.push(Buffer.from(part.value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid();
    return data;
  } catch { throw invalid(); } finally { reader.releaseLock(); }
}
function fail(c, error, login = false) {
  c.header("Cache-Control", "no-store, max-age=0");
  const status = Number(error?.status);
  if (status === 429) return c.json({ code: "AUTH_RATE_LIMITED", message: "登录或刷新过于频繁，请稍后重试" }, 429);
  if (status === 400 || status === 422) return c.json({ code: "VALIDATION_ERROR", message: "账号请求无效，请检查输入" }, 400);
  if (status === 401 || status === 403) return c.json({ code: login ? "AUTH_INVALID_CREDENTIALS" : "AUTH_EXPIRED", message: login ? "用户名、邮箱或密码不正确" : "桌面登录已失效，请重新登录" }, 401);
  // Never pass upstream exception bodies (which may contain credentials) to app.onError.
  return c.json({ code: "ACCOUNT_SERVICE_UNAVAILABLE", message: "账号服务暂时不可用，请稍后重试" }, 503);
}
async function verifyPassword(identifier, password) {
  const email = await resolveWebsiteLoginEmail(identifier);
  const auth = await loginWithChandler(email, password);
  try {
    if (!auth?.user?.id || !auth.access_token) throw Object.assign(new Error("登录失败"), { status: 401 });
    // Do not let identity synchronization re-enable a website administrator's local suspension.
    const users = await getCollection("users");
    const blocked = await users.findOne({ $or: [{ chandlerUserId: auth.user.id },
      ...(auth.user.email ? [{ emailNormalized: auth.user.email.trim().toLowerCase() }] : [])],
      status: { $in: ["disabled", "deleted"] } }, { projection: { _id: 1 } });
    if (blocked) throw Object.assign(new Error("账号已停用"), { status: 401 });
    const identity = await resolveChandlerIdentity(auth.user, auth.access_token);
    return await upsertChandlerUser(auth.user, { identity, defaultEdition: "gulong", username: identifier.includes("@") ? undefined : identifier });
  } finally {
    // Password verification grants our independent session, not a Chandler bearer proxy.
    if (auth?.refresh_token) await logoutFromChandler(auth.refresh_token).catch(() => {});
  }
}

export function createEnglishDesktopAuth(dependencies = {}) {
  const sessions = dependencies.sessions || createEnglishSessionStore({ getCollection });
  const verify = dependencies.verifyPassword || verifyPassword;
  const entitlement = dependencies.readEntitlement || readEnglishEntitlement;
  const rateLimit = dependencies.rateLimit || enforceRateLimit;
  async function limited(c, key, limit, windowMs) {
    // The identifier limiter below remains effective even when a proxy header is forged.
    // Treat this header as only a secondary throttle key, never as the sole login guard.
    const ip = digest(String(c.req.header("x-forwarded-for") || "local").slice(0, 256));
    const rate = await rateLimit(`english-desktop:${key}:${ip}`, { limit, windowMs });
    if (!rate.allowed) throw Object.assign(new Error("请求过于频繁"), { status: 429 });
  }
  async function authenticate(c) {
    const token = bearer(c);
    if (!token.startsWith("gec_at_")) return null;
    try {
      const user = await sessions.authenticate(token);
      return { kind: "desktop-english", user: { ...user, id: user._id.toString() }, session: null };
    } catch (error) { return { error: fail(c, error) }; }
  }
  function register(app) {
    app.use(`${ENGLISH_DESKTOP_ROOT}/*`, async (c, next) => { c.header("Cache-Control", "no-store, max-age=0"); c.header("Pragma", "no-cache"); await next(); });
    app.post(`${ENGLISH_DESKTOP_ROOT}/auth/login`, async (c) => {
      try {
        await limited(c, "login", 10, 10 * 60_000);
        const body = await readBody(c);
        const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
        if (!identifier || identifier.length > 320 || /[\r\n\0]/.test(identifier)
          || typeof body.password !== "string" || !body.password || body.password.length > 1024 || body.password.includes("\0")) throw invalid();
        const accountRate = await rateLimit(`english-desktop:identifier:${digest(identifier.toLowerCase())}`, { limit: 20, windowMs: 10 * 60_000 });
        if (!accountRate.allowed) throw Object.assign(new Error("请求过于频繁"), { status: 429 });
        return c.json(await sessions.issue(await verify(identifier, body.password)));
      } catch (error) { return fail(c, error, true); }
    });
    app.post(`${ENGLISH_DESKTOP_ROOT}/auth/refresh`, async (c) => {
      try { await limited(c, "refresh", 120, 60_000); const body = await readBody(c); return c.json(await sessions.refresh(body.refresh_token)); }
      catch (error) { return fail(c, error); }
    });
    app.post(`${ENGLISH_DESKTOP_ROOT}/auth/logout`, async (c) => {
      try { await limited(c, "logout", 120, 60_000); const body = await readBody(c); await sessions.revoke(bearer(c), body.refresh_token); return c.json({ ok: true }); }
      catch (error) { return fail(c, error); }
    });
    app.get(`${ENGLISH_DESKTOP_ROOT}/account`, async (c) => {
      try {
        await limited(c, "account", 180, 60_000);
        const auth = await authenticate(c);
        if (!auth) return c.json({ code: "AUTH_REQUIRED", message: "请先登录古龙官网账号" }, 401);
        if (auth.error) return auth.error;
        const user = auth.user;
        return c.json({ user: { id: user.id, display_name: String(user.displayName || user.username || user.name || "古龙用户"), email: String(user.email || "") }, entitlement: await entitlement(user._id), checked_at: new Date().toISOString() });
      } catch (error) { return fail(c, error); }
    });
  }
  return { register, authenticate };
}
const production = createEnglishDesktopAuth();
export const registerEnglishDesktopAuthRoutes = production.register;
export const authenticateEnglishDesktop = production.authenticate;
