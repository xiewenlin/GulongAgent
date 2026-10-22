import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerBirthdayRecordAdminRoutes, normalizeAdminLetterEdit } from "../../server/birthday-records-admin.js";
import { registerBirthdayWallRoutes } from "../../server/birthday-wall.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";

const WALL = "11111111-1111-4111-8111-111111111111";
const OTHER_WALL = "22222222-2222-4222-8222-222222222222";
const LETTER = "L".repeat(43), OTHER_LETTER = "R".repeat(43);
const START = new Date("2026-10-22T01:00:00Z");
function fixture() {
  const app = new OpenAPIHono(), stores = new Map();
  const f = { role: "admin", now: START };
  f.collection = (name) => {
    if (!stores.has(name)) { const value = createCapabilityMemoryCollection(); value.createIndex = async () => "index"; stores.set(name, value); }
    return stores.get(name);
  };
  f.collection("birthdayWalls").rows.push({ _id: WALL, ownerId: "owner-a", requestId: "create-wall", name: "小满", status: "active", count: 1, createdAt: START }, { _id: OTHER_WALL, ownerId: "owner-b", name: "另一面墙", status: "active", count: 1, createdAt: START });
  f.collection("birthdayWallNotes").rows.push({ _id: `${WALL}:note`, wallId: WALL, name: "小星", message: "生日快乐", emojis: "🎂", color: "#FFFFFF", status: "active", createdAt: START }, { _id: `${OTHER_WALL}:note`, wallId: OTHER_WALL, name: "其他人", message: "其他祝福", status: "active", createdAt: START });
  f.collection("loveLetters").rows.push({ _id: LETTER, guestHash: "secret-visitor", requestId: "private-request", fingerprint: "private-fingerprint", passwordHash: "scrypt-secret", senderName: "星河", recipientName: "小满", body: "一封私密的情书\n完整保留", backgroundColor: "#FCE8EE", date: "2026-10-22", createdAt: START }, { _id: OTHER_LETTER, senderName: "北辰", recipientName: "清风", body: "未设密的旧信", backgroundColor: "#FFFFFF", date: "2026-10-21", createdAt: new Date(+START - 1000) });
  f.collection("codexMarketTasks").rows.push({ _id: "protected-order", priceFen: 100 });
  let queue = Promise.resolve();
  const transaction = (operation) => {
    const pending = queue.then(async () => {
      const before = new Map([...stores].map(([key, value]) => [key, structuredClone(value.rows)]));
      try { return await operation({ fixture: true }); }
      catch (error) { for (const [key, value] of stores) value.rows.splice(0, value.rows.length, ...(before.get(key) || [])); throw error; }
    });
    queue = pending.catch(() => {}); return pending;
  };
  registerBirthdayRecordAdminRoutes(app, {
    getCollection: async (name) => f.collection(name), transaction, now: () => f.now,
    requireAdmin: async (c) => f.role ? { user: { id: "admin-a", role: f.role } } : { error: c.json({ message: "请先登录" }, 401) },
    requireTrustedMutation: (c) => c.req.header("origin") === "https://example.test" ? null : c.json({ message: "来源不受信任" }, 403),
  });
  registerBirthdayWallRoutes(app, { getCollection: async (name) => f.collection(name), transaction, enforceRateLimit: async () => ({ allowed: true }), authenticate: async () => ({ user: { id: "owner-a" } }) });
  f.call = async (path = "?type=letters", method = "GET", body, origin = "https://example.test") => {
    const response = await app.request(`https://example.test/api/admin/birthday-records${path}`, { method, headers: { origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  f.app = app; return f;
}
const edit = (revision = 0) => ({ revision, senderName: "新的署名", recipientName: "新的收件人", body: "新的正文\n保留换行", backgroundColor: "#fff8f2" });

test("birthday history management denies anonymous/nonadmin access and cross-origin mutations", async () => {
  const f = fixture(); f.role = null;
  assert.equal((await f.call()).status, 401);
  f.role = "user";
  for (const [path, method, body] of [["", "GET"], [`/letters/${LETTER}`, "GET"], [`/letters/${LETTER}`, "PATCH", edit()], [`/walls/${WALL}`, "DELETE"]]) assert.equal((await f.call(path, method, body)).status, 403);
  f.role = "admin";
  assert.equal((await f.call(`/letters/${LETTER}`, "PATCH", edit(), "https://evil.invalid")).status, 403);
  assert.equal((await f.call(`/walls/${WALL}`, "DELETE", null, "https://evil.invalid")).status, 403);
  assert.equal(f.collection("contentManagementAudit").rows.length, 0);
});

test("history list is descending, paginated, literal fuzzy searchable and never exposes secret fields or bodies", async () => {
  const f = fixture();
  const first = await f.call("?type=letters&pageSize=1");
  assert.equal(first.body.total, 2); assert.equal(first.body.items[0].id, LETTER);
  assert.equal(first.body.items[0].passwordSet, true); assert.equal(first.body.items[0].body, undefined);
  assert.doesNotMatch(JSON.stringify(first.body), /scrypt-secret|secret-visitor|private-request|fingerprint|passwordHash/);
  assert.equal((await f.call("?type=letters&page=2&pageSize=1")).body.items[0].id, OTHER_LETTER);
  assert.equal((await f.call("?type=letters&q=私密")).body.total, 1);
  assert.equal((await f.call("?type=letters&q=.*")).body.total, 0);
  assert.equal((await f.call("?type=walls&q=小满")).body.items[0].id, WALL);
  for (const query of ["?type=wrong", "?page=0", "?pageSize=100", `?q=${"长".repeat(101)}`]) assert.equal((await f.call(query)).status, 400);
});

test("admin detail includes complete content but not viewing credentials and records an audit", async () => {
  const f = fixture();
  const letter = await f.call(`/letters/${LETTER}`);
  assert.equal(letter.body.record.body, "一封私密的情书\n完整保留");
  assert.equal(letter.body.record.revision, 0);
  assert.equal(letter.headers.get("cache-control"), "private, no-store");
  assert.doesNotMatch(JSON.stringify(letter.body), /passwordHash|scrypt-secret|guestHash|requestId/);
  const wall = await f.call(`/walls/${WALL}`);
  assert.equal(wall.body.record.notes.length, 1);
  assert.equal(wall.body.record.notes[0].message, "生日快乐");
  assert.equal(f.collection("contentManagementAudit").rows.length, 2);
  assert.doesNotMatch(JSON.stringify(f.collection("contentManagementAudit").rows), /私密|生日快乐|scrypt-secret/);
});

test("letter edits preserve original link/date/password and reject stale concurrent versions", async () => {
  const f = fixture();
  const results = await Promise.all([f.call(`/letters/${LETTER}`, "PATCH", edit()), f.call(`/letters/${LETTER}`, "PATCH", edit())]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const row = f.collection("loveLetters").rows[0];
  assert.equal(row._id, LETTER); assert.equal(row.passwordHash, "scrypt-secret"); assert.equal(row.date, "2026-10-22"); assert.equal(row.requestId, "private-request");
  assert.equal(row.revision, 1); assert.equal(row.body, edit().body); assert.equal(row.backgroundColor, "#FFF8F2");
  assert.equal(f.collection("contentManagementAudit").rows.filter((r) => r.action === "edit").length, 1);
  assert.equal((await f.call(`/letters/${LETTER}`, "PATCH", edit(1))).status, 200);
});

test("letter editing validates content and cannot inject password, dates or arbitrary database fields", async () => {
  const f = fixture();
  for (const changes of [{ revision: -1 }, { body: "" }, { body: "长".repeat(20001) }, { senderName: "不\n合规" }, { backgroundColor: "javascript:bad" }]) assert.equal((await f.call(`/letters/${LETTER}`, "PATCH", { ...edit(), ...changes })).status, 400);
  assert.equal((await f.call(`/letters/${LETTER}`, "PATCH", { ...edit(), passwordHash: "forged", date: "2099-01-01", guestHash: "forged", status: "deleted" })).status, 200);
  const stored = f.collection("loveLetters").rows[0];
  assert.equal(stored.passwordHash, "scrypt-secret"); assert.equal(stored.date, "2026-10-22"); assert.equal(stored.guestHash, "secret-visitor");
  assert.equal(normalizeAdminLetterEdit({ ...edit(), body: "<script>内容</script>" }).body, "<script>内容</script>");
});

test("wall deletion atomically removes all content, invalidates public link and leaves unrelated data intact", async () => {
  const f = fixture();
  assert.deepEqual((await f.call(`/walls/${WALL}`, "DELETE")).body, { ok: true, removed: true });
  assert.deepEqual((await f.call(`/walls/${WALL}`, "DELETE")).body, { ok: true, removed: false });
  assert.equal((await f.call(`/walls/${WALL}`)).status, 404);
  assert.equal((await f.app.request(`https://example.test/api/birthday-walls/${WALL}`)).status, 404);
  const removedWall = f.collection("birthdayWalls").rows[0];
  assert.equal(removedWall.name, undefined); assert.equal(removedWall.count, 0); assert.equal(removedWall.requestId, "create-wall");
  assert.equal(f.collection("birthdayWallNotes").rows[0].message, undefined);
  assert.equal(f.collection("birthdayWallNotes").rows[1].message, "其他祝福");
  assert.equal(f.collection("loveLetters").rows.length, 2);
  assert.equal(f.collection("codexMarketTasks").rows[0].priceFen, 100);
});

test("letter deletion erases text/password, keeps replay tombstone and cannot be edited or re-listed", async () => {
  const f = fixture();
  assert.deepEqual((await f.call(`/letters/${LETTER}`, "DELETE")).body, { ok: true, removed: true });
  const row = f.collection("loveLetters").rows[0];
  for (const key of ["body", "passwordHash", "senderName", "recipientName", "backgroundColor", "date"]) assert.equal(row[key], undefined);
  assert.equal(row.status, "deleted"); assert.equal(row.requestId, "private-request");
  assert.equal((await f.call()).body.total, 1);
  assert.equal((await f.call(`/letters/${LETTER}`, "PATCH", edit())).status, 404);
  assert.equal((await f.call(`/letters/${LETTER}`)).status, 404);
  assert.deepEqual((await f.call(`/letters/${LETTER}`, "DELETE")).body, { ok: true, removed: false });
});

test("audit failure rolls back deletion and edits without partial content loss", async () => {
  const f = fixture();
  f.collection("contentManagementAudit").insertOne = async () => { throw new Error("private database details"); };
  const result = await f.call(`/walls/${WALL}`, "DELETE");
  assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.body), /private database details/);
  assert.equal(f.collection("birthdayWalls").rows[0].status, "active");
  assert.equal(f.collection("birthdayWallNotes").rows[0].message, "生日快乐");
  assert.equal((await f.call(`/letters/${LETTER}`, "PATCH", edit())).status, 503);
  assert.equal(f.collection("loveLetters").rows[0].body, "一封私密的情书\n完整保留");
});
