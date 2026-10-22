import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { LOVE_LETTER_MAX_LENGTH, normalizeLoveLetter, registerLoveLetterRoutes } from "../../server/love-letter.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";

function fixture() {
  const app = new OpenAPIHono();
  const letters = createCapabilityMemoryCollection();
  const indexes = [];
  const rates = [];
  letters.createIndex = async (fields, options) => { indexes.push({ fields, options }); return "index"; };
  const insert = letters.insertOne.bind(letters);
  letters.insertOne = async (row) => {
    if (letters.rows.some((existing) => existing.guestHash === row.guestHash && existing.requestId === row.requestId)) throw Object.assign(new Error("duplicate guest request"), { code: 11000 });
    return insert(row);
  };
  const f = { app, letters, indexes, rates, now: new Date("2026-10-22T15:59:59.000Z"), allowRate: true, failDatabase: false };
  registerLoveLetterRoutes(app, {
    getCollection: async (name) => { assert.equal(name, "loveLetters"); if (f.failDatabase) throw new Error("private connection credential failure"); return letters; },
    enforceRateLimit: async (key, options) => { rates.push({ key, ...options }); return { allowed: f.allowRate }; },
    fingerprintIp: () => "test-ip",
    isTrustedBrowserRequest: (c) => !c.req.header("origin") || c.req.header("origin") === "https://letter.example",
    now: () => f.now,
  });
  f.call = async (path, { method = "GET", input, cookie = "", headers = {} } = {}) => {
    const response = await app.request(`https://letter.example${path}`, { method, headers: { origin: "https://letter.example", ...(cookie ? { cookie } : {}), ...(input !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(input !== undefined ? { body: typeof input === "string" ? input : JSON.stringify(input) } : {}) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: response.headers, cookie: response.headers.get("set-cookie") };
  };
  f.session = async () => (await f.call("/api/love-letters/session")).cookie.split(";")[0];
  f.post = (cookie, input = {}, extra = {}) => f.call("/api/love-letters", { method: "POST", input: { clientRequestId: randomUUID(), senderName: "小满", recipientName: "小星", body: "见字如面。\n愿我们一起，看遍春夏秋冬。 💓", backgroundColor: "#fff4ed", ...input }, cookie, ...extra });
  return f;
}

test("love letter session uses a stable HttpOnly cookie and no credential is returned in JSON", async () => {
  const f = fixture();
  const first = await f.call("/api/love-letters/session");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true });
  assert.match(first.cookie, /^gulong_love_letter_visitor=llv_[A-Za-z0-9_-]{43};/);
  for (const policy of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\/api\/love-letters/]) assert.match(first.cookie, policy);
  const again = await f.call("/api/love-letters/session", { cookie: first.cookie.split(";")[0] });
  assert.equal(again.cookie, null);
  assert.equal(f.letters.rows.length, 0);
});

test("love letters retain full multiline Unicode text and only publish the explicit letter DTO", async () => {
  const f = fixture();
  const cookie = await f.session();
  const message = `亲爱的：\r\n${"愿".repeat(19_980)}\r\n想你 💓`;
  const result = await f.post(cookie, { body: message, date: "1999-01-01", ownerId: "forged-owner", guestHash: "forged-guest" });
  assert.equal(result.status, 201);
  assert.match(result.body.letter.id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.body.url, `/love-letter/${result.body.letter.id}`);
  assert.equal(result.body.letter.body, message.replace(/\r\n/g, "\n"));
  assert.equal(result.body.letter.backgroundColor, "#FFF4ED");
  assert.equal(result.body.letter.date, "2026-10-22");
  assert.deepEqual(Object.keys(result.body.letter).sort(), ["backgroundColor", "body", "createdAt", "date", "id", "recipientName", "senderName"]);
  const read = await f.call(`/api/love-letters/${result.body.letter.id}`);
  assert.deepEqual(read.body, { letter: result.body.letter });
  assert.doesNotMatch(JSON.stringify(read.body), /guestHash|ownerId|requestId|fingerprint|test-ip|forged/);
  assert.deepEqual(f.indexes, [{ fields: { guestHash: 1, requestId: 1 }, options: { unique: true } }]);
});

test("letter date is fixed in Shanghai time across midnight and idempotent retries", async () => {
  const f = fixture();
  const cookie = await f.session();
  const requestId = randomUUID();
  const first = await f.post(cookie, { clientRequestId: requestId });
  f.now = new Date("2026-10-22T16:00:00.000Z");
  const replay = await f.post(cookie, { clientRequestId: requestId });
  const next = await f.post(cookie);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.letter, first.body.letter);
  assert.equal(first.body.letter.date, "2026-10-22");
  assert.equal(next.body.letter.date, "2026-10-23");
});

test("concurrent submissions are one immutable letter and changed contents conflict", async () => {
  const f = fixture();
  const cookie = await f.session();
  const clientRequestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.post(cookie, { clientRequestId })));
  assert.equal(results.filter((item) => item.status === 201).length, 1);
  assert.ok(results.every((item) => [200, 201].includes(item.status)));
  assert.equal(new Set(results.map((item) => item.body.url)).size, 1);
  assert.equal(f.letters.rows.length, 1);
  for (const changed of [{ body: "另一段正文" }, { senderName: "别的署名" }, { recipientName: "别的收件人" }, { backgroundColor: "#000000" }]) {
    const conflict = await f.post(cookie, { clientRequestId, ...changed });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "LOVE_LETTER_REQUEST_CONFLICT");
  }
  f.allowRate = false;
  assert.equal((await f.post(cookie, { clientRequestId })).status, 200);
});

test("different visitors cannot recover each other's request or enumerate letters", async () => {
  const f = fixture();
  const firstCookie = await f.session();
  const otherCookie = await f.session();
  const clientRequestId = randomUUID();
  const a = await f.post(firstCookie, { clientRequestId });
  const b = await f.post(otherCookie, { clientRequestId });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.notEqual(a.body.url, b.body.url);
  assert.notEqual(f.letters.rows[0].guestHash, f.letters.rows[1].guestHash);
  assert.equal((await f.call("/api/love-letters")).status, 404);
  for (const value of ["mine", randomUUID(), "a".repeat(43), "a".repeat(44)]) assert.equal((await f.call(`/api/love-letters/${value}`)).status, 404);
  assert.equal(f.letters.rows.length, 2);
});

test("session, origin, JSON and validation failures persist no letter", async () => {
  const f = fixture();
  const cookie = await f.session();
  assert.equal((await f.post("")).body.code, "LOVE_LETTER_VISITOR_REQUIRED");
  assert.equal((await f.post(cookie, {}, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await f.post(cookie, {}, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await f.call("/api/love-letters/session", { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await f.post(cookie, {}, { headers: { "content-type": "text/plain" } })).status, 400);
  assert.equal((await f.call("/api/love-letters", { method: "POST", cookie, input: "{broken" })).body.code, "INVALID_JSON");
  for (const input of [{ clientRequestId: "forged" }, { senderName: " " }, { senderName: "a".repeat(61) }, { recipientName: "a\nb" }, { body: "\u0000" }, { body: " " }, { body: "💓".repeat(LOVE_LETTER_MAX_LENGTH + 1) }, { backgroundColor: "url(https://evil.example)" }]) assert.equal((await f.post(cookie, input)).status, 400);
  assert.equal(f.letters.rows.length, 0);
});

test("payload and IP/visitor limits protect writes while returning Chinese failures", async () => {
  const f = fixture();
  const cookie = await f.session();
  assert.equal((await f.post(cookie, { body: "x".repeat(140_000) })).status, 413);
  assert.equal((await f.post(cookie)).status, 201);
  assert.ok(f.rates.some((r) => r.key === "love-letter:create-ip:test-ip" && r.limit === 30));
  assert.ok(f.rates.some((r) => r.key.startsWith("love-letter:create-visitor:") && r.limit === 20));
  f.allowRate = false;
  const denied = await f.post(cookie);
  assert.equal(denied.status, 429);
  assert.equal(denied.body.message, "操作较频繁，请稍后再试");
  assert.equal(f.letters.rows.length, 1);
});

test("read, creation and failure responses are private no-store noindex no-referrer", async () => {
  const f = fixture();
  const cookie = await f.session();
  const create = await f.post(cookie);
  const read = await f.call(`/api/love-letters/${create.body.letter.id}`);
  const missing = await f.call("/api/love-letters/bad");
  const tooLarge = await f.post(cookie, { body: "x".repeat(140_000) });
  for (const response of [create, read, missing, tooLarge]) {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});

test("storage errors expose no internal credentials and failed index init may retry", async () => {
  const f = fixture();
  const cookie = await f.session();
  f.failDatabase = true;
  const failed = await f.post(cookie);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "LOVE_LETTER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(failed.body), /credential|connection|private/);
  f.failDatabase = false;
  assert.equal((await f.post(cookie)).status, 201);
});

test("HTML-looking letter text stays literal and color cannot carry markup", () => {
  const input = { clientRequestId: randomUUID(), senderName: "<img>", recipientName: "读者", body: '<script>alert("hi")</script>\n**原文**', backgroundColor: "#AbCdEf" };
  const parsed = normalizeLoveLetter(input);
  assert.equal(parsed.body, input.body);
  assert.equal(parsed.senderName, "<img>");
  assert.equal(parsed.backgroundColor, "#ABCDEF");
  assert.throws(() => normalizeLoveLetter({ ...input, backgroundColor: 'red;url("evil")' }), /背景颜色/);
});

test("OpenAPI exposes the exact session/create/read contract without public enumeration", () => {
  const f = fixture();
  const spec = f.app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "test", version: "test" } });
  assert.deepEqual(Object.keys(spec.paths).sort(), ["/api/love-letters", "/api/love-letters/session", "/api/love-letters/{id}"]);
  assert.ok(spec.paths["/api/love-letters"].post.responses[201]);
  assert.equal(spec.paths["/api/love-letters"].get, undefined);
  assert.equal(spec.paths["/api/love-letters"].post.requestBody.content["application/json"].schema.properties.body.maxLength, 20_000);
});
