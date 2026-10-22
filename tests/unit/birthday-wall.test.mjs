import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerBirthdayWallRoutes, birthdayWallView, decorateBirthdayNote, normalizeBirthdayNote, BIRTHDAY_NOTE_COLORS } from "../../server/birthday-wall.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";

function fixture({ empty = false } = {}) {
  const app = new OpenAPIHono();
  const collections = new Map();
  const rates = [];
  let queue = Promise.resolve();
  const f = { now: new Date("2026-10-22T04:00:00.000Z"), allowRate: true, role: null, userId: "owner-a", wallId: randomUUID() };
  f.collection = (name) => {
    if (!collections.has(name)) {
      const value = createCapabilityMemoryCollection(name === "birthdayWalls" && !empty ? [{ _id: f.wallId, ownerId: "owner-a", requestId: randomUUID(), name: "小寿星", status: "active", count: 0, createdAt: f.now }] : []);
      value.createIndex = async () => "index";
      collections.set(name, value);
    }
    return collections.get(name);
  };
  registerBirthdayWallRoutes(app, {
    getCollection: async (name) => f.collection(name),
    transaction: (operation) => {
      const pending = queue.then(async () => {
        const before = new Map([...collections].map(([key, value]) => [key, structuredClone(value.rows)]));
        try { return await operation({ fixture: true }); }
        catch (error) {
          for (const [key, value] of collections) value.rows.splice(0, value.rows.length, ...(before.get(key) || []));
          throw error;
        }
      });
      queue = pending.catch(() => {});
      return pending;
    },
    enforceRateLimit: async (key, options) => { rates.push({ key, ...options }); return { allowed: f.allowRate }; },
    fingerprintIp: () => "test-ip-hash",
    isTrustedBrowserRequest: (c) => !c.req.header("origin") || c.req.header("origin") === "https://birthday.example",
    authenticate: async () => f.role ? { user: { id: f.userId, role: f.role } } : null,
    now: () => f.now,
  });
  f.call = async (method = "GET", body, { cookie = "", origin = "https://birthday.example", path = `/api/birthday-walls/${f.wallId}`, headers = {} } = {}) => {
    const response = await app.request(`https://birthday.example${path}`, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie"), headers: response.headers };
  };
  f.visit = async () => (await f.call()).cookie.split(";")[0];
  f.post = (cookie, input = {}, options = {}) => f.call("POST", { clientRequestId: randomUUID(), name: "小星", message: "生日快乐，愿你平安顺利！", ...input }, { cookie, path: `/api/birthday-walls/${f.wallId}/notes`, ...options });
  f.create = (input = {}) => f.call("POST", { clientRequestId: randomUUID(), name: "生日的小朋友", ...input }, { path: "/api/birthday-walls" });
  f.rates = rates;
  return f;
}

test("birthday wall starts empty and establishes a private stable visitor cookie", async () => {
  const f = fixture();
  const first = await f.call();
  assert.deepEqual(first.body, { wall: { id: f.wallId, name: "小寿星", createdAt: f.now.toISOString() }, notes: [], stats: { total: 0, participants: 0, today: 0 } });
  assert.match(first.cookie, /^gulong_birthday_visitor=bw_[A-Za-z0-9_-]{43};/);
  assert.match(first.cookie, /HttpOnly/);
  assert.match(first.cookie, /Secure/);
  assert.match(first.cookie, /SameSite=Lax/);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  const second = await f.call("GET", undefined, { cookie: first.cookie.split(";")[0] });
  assert.equal(second.cookie, null);
});

test("birthday submission adds only server-owned decoration and never publishes visitor identity", async () => {
  const f = fixture();
  const cookie = await f.visit();
  const submitted = await f.post(cookie, { guestHash: "forged", color: "javascript:alert(1)", emojis: "<script>" });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.note.message, "生日快乐，愿你平安顺利！");
  assert.ok(BIRTHDAY_NOTE_COLORS.includes(submitted.body.note.color));
  assert.ok(submitted.body.note.emojis.split(" ").length >= 3);
  assert.equal(submitted.body.note.guestHash, undefined);
  const stored = f.collection("birthdayWallNotes").rows[0];
  assert.notEqual(stored.guestHash, "forged");
  const list = await f.call();
  assert.deepEqual(list.body.stats, { total: 1, participants: 1, today: 1 });
  assert.doesNotMatch(JSON.stringify(list.body), /guestHash|fingerprint|test-ip-hash|deletedBy|bw_/);
  assert.deepEqual(Object.keys(list.body.notes[0]).sort(), ["color", "createdAt", "emojis", "id", "message", "name"]);
});

test("same request is recoverable without a second wish or rate charge", async () => {
  const f = fixture();
  const cookie = await f.visit();
  const clientRequestId = randomUUID();
  const original = await f.post(cookie, { clientRequestId });
  f.allowRate = false;
  const retried = await f.post(cookie, { clientRequestId });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.replayed, true);
  assert.deepEqual(retried.body.note, original.body.note);
  assert.equal(f.collection("birthdayWallNotes").rows.length, 1);
  assert.equal(f.collection("birthdayWalls").rows[0].count, 1);
});

test("concurrent same UUID submissions create one note and one capacity reservation", async () => {
  const f = fixture();
  const cookie = await f.visit();
  const clientRequestId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.post(cookie, { clientRequestId })));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.ok(responses.every((response) => [200, 201].includes(response.status)));
  assert.equal(f.collection("birthdayWallNotes").rows.length, 1);
  assert.equal(f.collection("birthdayWalls").rows[0].count, 1);
});

test("request ID cannot be reused for different text or a different visitor", async () => {
  const f = fixture();
  const cookie = await f.visit();
  const otherCookie = await f.visit();
  const clientRequestId = randomUUID();
  await f.post(cookie, { clientRequestId });
  for (const [identity, message] of [[cookie, "修改后的内容"], [otherCookie, "生日快乐，愿你平安顺利！"]]) {
    const denied = await f.post(identity, { clientRequestId, message });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, "BIRTHDAY_REQUEST_CONFLICT");
  }
  assert.equal(f.collection("birthdayWallNotes").rows.length, 1);
});

test("missing visitor, cross-site, invalid JSON and rate rejection never persist a wish", async () => {
  const f = fixture();
  assert.equal((await f.post("")).body.code, "BIRTHDAY_VISITOR_REQUIRED");
  const cookie = await f.visit();
  assert.equal((await f.post(cookie, {}, { origin: "https://other.example" })).status, 403);
  assert.equal((await f.post(cookie, {}, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await f.call("POST", "not-json", { cookie, path: `/api/birthday-walls/${f.wallId}/notes` })).body.code, "INVALID_JSON");
  f.allowRate = false;
  assert.equal((await f.post(cookie)).status, 429);
  assert.equal(f.collection("birthdayWallNotes").rows.length, 0);
});

test("birthday note limits count Unicode characters, preserve line breaks and reject controls", () => {
  const clientRequestId = randomUUID();
  const maximal = normalizeBirthdayNote({ clientRequestId, name: "友".repeat(40), message: "🎂".repeat(500) });
  assert.equal([...maximal.message].length, 500);
  assert.equal(normalizeBirthdayNote({ clientRequestId, message: "一行\r\n二行" }).message, "一行\n二行");
  assert.equal(normalizeBirthdayNote({ clientRequestId, message: "<script>alert(1)</script>" }).message, "<script>alert(1)</script>");
  for (const invalid of [{ message: " " }, { message: "祝".repeat(501) }, { name: "友".repeat(41), message: "好" }, { message: "好\u0000" }, { message: { html: "你好" } }, { message: "好", clientRequestId: "no-id" }]) {
    assert.throws(() => normalizeBirthdayNote({ clientRequestId, ...invalid }), (error) => error.status === 400);
  }
});

test("statistics use Shanghai midnight and visitor identity, never nickname uniqueness", () => {
  const records = [
    { _id: "1", name: "同名", message: "生日快乐", status: "active", guestHash: "a", createdAt: new Date("2026-10-21T15:59:59Z") },
    { _id: "2", name: "同名", message: "生日快乐", status: "active", guestHash: "b", createdAt: new Date("2026-10-21T16:00:00Z") },
    { _id: "3", name: "另一个昵称", message: "生日快乐", status: "active", guestHash: "a", createdAt: new Date("2026-10-21T16:00:01Z") },
    { _id: "4", status: "deleted", guestHash: "c", createdAt: new Date("2026-10-21T16:00:02Z") },
  ];
  assert.deepEqual(birthdayWallView(records, new Date("2026-10-22T00:00:00Z")).stats, { total: 3, participants: 2, today: 2 });
});

test("concurrent final available slot admits only one wish without dropping earlier content", async () => {
  const f = fixture();
  const cookie = await f.visit();
  f.collection("birthdayWalls").rows[0].count = 999;
  const requests = await Promise.all([f.post(cookie), f.post(cookie)]);
  assert.deepEqual(requests.map((result) => result.status).sort(), [201, 409]);
  assert.equal(requests.find((result) => result.status === 409).body.code, "BIRTHDAY_WALL_FULL");
  assert.equal(f.collection("birthdayWalls").rows[0].count, 1000);
  assert.equal(f.collection("birthdayWallNotes").rows.length, 1);
});

test("failed insertion rolls back reserved capacity", async () => {
  const f = fixture();
  const cookie = await f.visit();
  f.collection("birthdayWallNotes").insertOne = async () => { throw new Error("injected DB failure"); };
  const result = await f.post(cookie);
  assert.equal(result.status, 503);
  assert.equal(f.collection("birthdayWalls").rows[0].count, 0);
  assert.equal(f.collection("birthdayWallNotes").rows.length, 0);
  assert.doesNotMatch(result.body.message, /injected DB failure/);
});

test("administrator removal requires admin, is idempotent and preserves removed-request tombstones", async () => {
  const f = fixture();
  const cookie = await f.visit();
  const clientRequestId = randomUUID();
  const created = await f.post(cookie, { clientRequestId });
  const path = `/api/admin/birthday-walls/${f.wallId}/notes/${created.body.note.id}`;
  assert.equal((await f.call("DELETE", undefined, { path })).status, 401);
  f.role = "user";
  assert.equal((await f.call("DELETE", undefined, { path })).status, 403);
  f.role = "admin";
  assert.equal((await f.call("DELETE", undefined, { path, origin: "https://other.example" })).status, 403);
  assert.deepEqual((await f.call("DELETE", undefined, { path })).body, { ok: true, removed: true });
  assert.deepEqual((await f.call("DELETE", undefined, { path })).body, { ok: true, removed: false });
  assert.equal(f.collection("birthdayWalls").rows[0].count, 0);
  assert.equal((await f.post(cookie, { clientRequestId })).status, 410);
  assert.deepEqual((await f.call()).body.stats, { total: 0, participants: 0, today: 0 });
  assert.equal(f.collection("birthdayWallNotes").rows[0].message, undefined);
});

test("decoration varies in palette and has three to five distinct emoji", () => {
  const first = decorateBirthdayNote("平安健康", () => 0);
  const last = decorateBirthdayNote("爱与陪伴", (maximum) => maximum - 1);
  assert.equal(first.color, BIRTHDAY_NOTE_COLORS[0]);
  assert.equal(last.color, BIRTHDAY_NOTE_COLORS.at(-1));
  assert.equal(first.emojis.split(" ").length, 3);
  assert.equal(last.emojis.split(" ").length, 5);
  assert.equal(new Set(last.emojis.split(" ")).size, 5);
});

test("wall creation requires login, persists authoritative owner and starts genuinely empty", async () => {
  const f = fixture({ empty: true });
  assert.equal((await f.create()).status, 401);
  assert.equal(f.collection("birthdayWalls").rows.length, 0);
  f.role = "user";
  const result = await f.create({ name: " Echo ", ownerId: "someone-else", notes: [{ message: "伪造" }] });
  assert.equal(result.status, 201);
  assert.equal(result.body.wall.name, "Echo");
  assert.match(result.body.wall.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.body.url, `/birthday-wall/${result.body.wall.id}`);
  assert.deepEqual(Object.keys(result.body.wall).sort(), ["createdAt", "id", "name"]);
  assert.equal(f.collection("birthdayWalls").rows[0].ownerId, "owner-a");
  assert.equal(f.collection("birthdayWalls").rows[0].count, 0);
  const publicView = await f.call("GET", undefined, { path: `/api/birthday-walls/${result.body.wall.id}` });
  assert.deepEqual(publicView.body.notes, []);
  assert.deepEqual(publicView.body.stats, { total: 0, participants: 0, today: 0 });
  assert.doesNotMatch(JSON.stringify(publicView.body), /ownerId|requestId|owner-a/);
});

test("wall creation is account-scoped and concurrent idempotent, with conflicting name rejected", async () => {
  const f = fixture({ empty: true });
  f.role = "user";
  const clientRequestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.create({ clientRequestId })));
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(new Set(results.map((result) => result.body.wall.id)).size, 1);
  assert.equal(f.collection("birthdayWalls").rows.length, 1);
  assert.equal((await f.create({ clientRequestId, name: "另一位寿星" })).status, 409);
  f.userId = "owner-b";
  const second = await f.create({ clientRequestId });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.wall.id, results[0].body.wall.id);
});

test("my walls is authenticated and never lists another user's walls", async () => {
  const f = fixture({ empty: true });
  const path = "/api/birthday-walls/mine";
  assert.equal((await f.call("GET", undefined, { path })).status, 401);
  f.role = "user";
  const a = await f.create({ name: "甲" });
  f.userId = "owner-b";
  const b = await f.create({ name: "乙" });
  assert.deepEqual((await f.call("GET", undefined, { path })).body.walls.map((wall) => wall.id), [b.body.wall.id]);
  f.userId = "owner-a";
  assert.deepEqual((await f.call("GET", undefined, { path })).body.walls.map((wall) => wall.id), [a.body.wall.id]);
});

test("notes and statistics are isolated per wall even with identical request UUIDs", async () => {
  const f = fixture();
  const cookie = await f.visit();
  f.role = "user";
  const other = (await f.create({ name: "另一位寿星" })).body.wall.id;
  f.role = null;
  const clientRequestId = randomUUID();
  const first = await f.post(cookie, { clientRequestId, message: "第一面墙" });
  const second = await f.post(cookie, { clientRequestId, message: "第二面墙" }, { path: `/api/birthday-walls/${other}/notes` });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const viewA = (await f.call()).body;
  const viewB = (await f.call("GET", undefined, { path: `/api/birthday-walls/${other}` })).body;
  assert.deepEqual(viewA.notes.map((note) => note.message), ["第一面墙"]);
  assert.deepEqual(viewB.notes.map((note) => note.message), ["第二面墙"]);
  assert.deepEqual(viewA.stats, { total: 1, participants: 1, today: 1 });
  assert.deepEqual(viewB.stats, { total: 1, participants: 1, today: 1 });
  assert.equal(f.collection("birthdayWalls").rows.find((wall) => wall._id === f.wallId).count, 1);
  assert.equal(f.collection("birthdayWalls").rows.find((wall) => wall._id === other).count, 1);
});

test("unknown wall is not auto-created and cross-wall deletion cannot affect another wall", async () => {
  const f = fixture();
  const unknown = randomUUID();
  assert.equal((await f.call("GET", undefined, { path: `/api/birthday-walls/${unknown}` })).status, 404);
  assert.equal(f.collection("birthdayWalls").rows.length, 1);
  const cookie = await f.visit();
  const note = (await f.post(cookie)).body.note;
  f.role = "admin";
  const other = (await f.create()).body.wall.id;
  const result = await f.call("DELETE", undefined, { path: `/api/admin/birthday-walls/${other}/notes/${note.id}` });
  assert.equal(result.status, 404);
  assert.equal((await f.call()).body.notes.length, 1);
});

test("wall creation validates name and applies both owner and IP limits", async () => {
  const f = fixture({ empty: true });
  f.role = "user";
  assert.equal((await f.create({ name: " " })).status, 400);
  assert.equal((await f.create({ name: "寿".repeat(41) })).status, 400);
  const created = await f.create();
  assert.equal(created.status, 201);
  assert.ok(f.rates.some((rate) => rate.key.startsWith("birthday-wall:create-owner:")));
  assert.ok(f.rates.some((rate) => rate.key === "birthday-wall:create:test-ip-hash"));
  f.allowRate = false;
  assert.equal((await f.create()).status, 429);
  assert.equal(f.collection("birthdayWalls").rows.length, 1);
});
