import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createEnglishSessionStore, createGulongEngineSessionStore } from "../../server/desktop-english-sessions.js";
import { createEnglishDesktopAuth, ENGLISH_DESKTOP_ROOT as root } from "../../server/desktop-english-auth.js";
import { createGulongEngineDesktopAuth, GULONG_ENGINE_DESKTOP_ROOT as greenRoot } from "../../server/desktop-gulong-auth.js";

function fixture(green = false) {
  let time = Date.parse("2026-09-24T00:00:00Z");
  const rows = new Map(); const user = { _id: "stable-owner-1", status: "active", email: "demo@example.test", username: "Demo" };
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (value && typeof value === "object" && "$gt" in value) return +row[key] > +value.$gt;
    if (Array.isArray(row[key])) return row[key].includes(value);
    return row[key] === value;
  });
  const collection = {
    createIndex: async () => "ttl", insertOne: async (doc) => { rows.set(doc._id, structuredClone(doc)); },
    findOne: async (query) => structuredClone([...rows.values()].find((row) => matches(row, query)) || null),
    updateOne: async (query, update) => {
      const row = [...rows.values()].find((candidate) => matches(candidate, query));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, structuredClone(update.$set || {}));
      for (const [key, value] of Object.entries(update.$push || {})) row[key].push(value);
      return { modifiedCount: 1 };
    },
  };
  const sessions = (green ? createGulongEngineSessionStore : createEnglishSessionStore)({ now: () => new Date(time), getCollection: async (name) => name === "users"
    ? { findOne: async (query) => matches(user, query) ? structuredClone(user) : null } : collection });
  return { sessions, rows, user, advance: (milliseconds) => { time += milliseconds; } };
}
const authExpired = (error) => error.code === "AUTH_EXPIRED";
test("tokens contain random secrets but Mongo documents contain only digests; revoked access cannot authenticate", async () => {
  const f = fixture(); const pair = await f.sessions.issue(f.user);
  assert.equal(pair.expires_in, 900);
  assert.equal((await f.sessions.authenticate(pair.access_token))._id, f.user._id);
  const stored = JSON.stringify([...f.rows.values()]);
  for (const secret of [pair.access_token, pair.refresh_token]) assert.equal(stored.includes(secret), false);
  await f.sessions.revoke(pair.access_token);
  await assert.rejects(f.sessions.authenticate(pair.access_token), authExpired);
  await assert.rejects(f.sessions.refresh(pair.refresh_token), authExpired);
});
test("refresh rotates atomically; proven replay revokes family while random guesses cannot revoke it", async () => {
  const f = fixture(); const first = await f.sessions.issue(f.user);
  await assert.rejects(f.sessions.refresh(first.refresh_token.slice(0, -43) + "a".repeat(43)), authExpired);
  const second = await f.sessions.refresh(first.refresh_token);
  assert.notEqual(second.refresh_token, first.refresh_token);
  await assert.rejects(f.sessions.authenticate(first.access_token), authExpired);
  assert.equal((await f.sessions.authenticate(second.access_token))._id, f.user._id);
  await assert.rejects(f.sessions.refresh(first.refresh_token), authExpired);
  await assert.rejects(f.sessions.authenticate(second.access_token), authExpired);
});
test("concurrent refresh cannot mint two usable sessions from one refresh token", async () => {
  const f = fixture(); const pair = await f.sessions.issue(f.user);
  const results = await Promise.allSettled([f.sessions.refresh(pair.refresh_token), f.sessions.refresh(pair.refresh_token)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(f.sessions.authenticate(results.find((r) => r.status === "fulfilled").value.access_token), authExpired);
});
test("expired access, absolute refresh expiry and disabled users are denied", async () => {
  const f = fixture(); const pair = await f.sessions.issue(f.user);
  f.advance(901_000); await assert.rejects(f.sessions.authenticate(pair.access_token), authExpired);
  const rotated = await f.sessions.refresh(pair.refresh_token);
  f.user.status = "disabled";
  await assert.rejects(f.sessions.authenticate(rotated.access_token), authExpired);
  await assert.rejects(f.sessions.refresh(rotated.refresh_token), authExpired);
  f.user.status = "active"; f.advance(31 * 86_400_000);
  await assert.rejects(f.sessions.refresh(rotated.refresh_token), authExpired);
});
function routes(options = {}, green = false) {
  const f = fixture(green); const app = new Hono();
  const auth = (green ? createGulongEngineDesktopAuth : createEnglishDesktopAuth)({ sessions: f.sessions, rateLimit: async () => ({ allowed: true }),
    verifyPassword: async (identifier, password) => {
      if (identifier !== "Demo" || password !== "dummy-test-only") throw Object.assign(new Error("secret upstream payload"), { status: 401 });
      return f.user;
    }, readEntitlement: async (owner) => ({ product: green ? "gulong_engine" : "english_coach", active: false, status: "inactive", owner }), ...options });
  auth.register(app);
  const selectedRoot = green ? greenRoot : root;
  const post = (path, body, token) => app.request(`${selectedRoot}/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { ...f, app, auth, post };
}
test("desktop route login supports username, never returns upstream token, and reads inactive English entitlement", async () => {
  const f = routes(); const response = await f.post("login", { identifier: "Demo", password: "dummy-test-only" });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  const pair = await response.json(); assert.match(pair.access_token, /^gec_at_/);
  const account = await f.app.request(`${root}/account`, { headers: { Authorization: `Bearer ${pair.access_token}` } });
  const view = await account.json(); assert.equal(account.status, 200); assert.equal(view.user.id, f.user._id); assert.equal(view.entitlement.active, false);
  assert.ok(Number.isFinite(Date.parse(view.checked_at)));
  assert.equal(JSON.stringify(view).includes(pair.access_token), false);
  await f.post("logout", { refresh_token: pair.refresh_token }, pair.access_token);
  assert.equal((await f.app.request(`${root}/account`, { headers: { Authorization: `Bearer ${pair.access_token}` } })).status, 401);
});
test("login errors are sanitized, excessive inputs and rate limiting fail before password verification", async () => {
  const f = routes(); const wrong = await f.post("login", { identifier: "Demo", password: "incorrect" });
  assert.equal(wrong.status, 401); assert.equal((await wrong.text()).includes("secret upstream"), false);
  assert.equal((await f.post("login", { identifier: "Demo", password: "x".repeat(20_000) })).status, 400);
  const blocked = routes({ rateLimit: async () => ({ allowed: false }), verifyPassword: () => assert.fail("rate limit did not gate verification") });
  assert.equal((await blocked.post("login", { identifier: "Demo", password: "dummy" })).status, 429);
});
test("dedicated authenticate declines unrelated bearer credentials and rejects malformed own tokens", async () => {
  const f = routes(); let result;
  f.app.get("/test", async (c) => { result = await f.auth.authenticate(c); return result?.error || c.json({ handled: !!result }); });
  const unrelated = await f.app.request("/test", { headers: { Authorization: "Bearer chandler-token" } });
  assert.deepEqual(await unrelated.json(), { handled: false });
  assert.equal((await f.app.request("/test", { headers: { Authorization: "Bearer gec_at_invalid" } })).status, 401);
});

test("green desktop auth issues isolated gge tokens and reads only its independent entitlement", async () => {
  const green = routes({}, true);
  const response = await green.post("login", { identifier: "Demo", password: "dummy-test-only" });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.match(tokens.access_token, /^gge_at_/);
  assert.match(tokens.refresh_token, /^gge_rt_/);
  const account = await green.app.request(`${greenRoot}/account`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(account.status, 200);
  assert.equal((await account.json()).entitlement.product, "gulong_engine");
  const english = routes();
  assert.equal((await english.app.request(`${root}/account`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  const rotated = await green.post("refresh", { refresh_token: tokens.refresh_token });
  assert.equal(rotated.status, 200);
  assert.match((await rotated.json()).access_token, /^gge_at_/);
  assert.equal((await green.app.request(`${greenRoot}/account`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
});
