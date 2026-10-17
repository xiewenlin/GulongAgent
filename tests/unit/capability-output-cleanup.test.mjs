import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { CAPABILITY_OUTPUT_CLEANUP_PATH, cleanupCapabilityOutputs, isOwnedCapabilityOutputKey, registerCapabilityOutputCleanupRoutes } from "../../server/capability-output-cleanup.js";

const now = new Date("2026-10-17T10:00:00Z");
const past = new Date(now.getTime() - 7200000);
const future = new Date(now.getTime() + 7200000);
const value = (item) => item instanceof ObjectId ? String(item) : item instanceof Date ? +item : item;
function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((part) => matches(row, part));
    if (key === "$and") return expected.every((part) => matches(row, part));
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof ObjectId) && !(expected instanceof Date)) return Object.entries(expected).every(([op, right]) => {
      if (op === "$exists") return (actual !== undefined) === right;
      if (op === "$in") return right.some((entry) => value(entry) === value(actual));
      if (op === "$nin") return !right.some((entry) => value(entry) === value(actual));
      if (op === "$lte") return value(actual) <= value(right);
      throw new Error(`Unhandled query ${op}`);
    });
    return value(actual) === value(expected);
  });
}
function fixture() {
  const rows = { capabilityOutputCopies: [], capabilityOutputUploads: [], capabilityOrders: [] };
  const deleted = []; const hooks = {};
  const getCollection = async (name) => ({
    find: (query) => { let result = rows[name].filter((row) => matches(row, query)); return { sort() { return this; }, limit(n) { result = result.slice(0, n); return this; }, toArray: async () => result }; },
    findOne: async (query) => { if (name === "capabilityOrders") await hooks.readOrder?.(); return rows[name].find((row) => matches(row, query)) || null; },
    updateOne: async (query, update) => { const row = rows[name].find((item) => matches(item, query)); if (!row) return { matchedCount: 0 }; Object.assign(row, update.$set || {}); for (const key of Object.keys(update.$unset || {})) delete row[key]; return { matchedCount: 1 }; },
  });
  const removeObject = async (key) => { await hooks.remove?.(key); deleted.push(key); };
  const add = (kind = "copy", extra = {}) => {
    const orderId = new ObjectId(); const outputId = "test_output-123456";
    const record = { _id: new ObjectId(), orderId, outputId, claimId: "test-claim", createdAt: past, expiresAt: past,
      status: kind === "copy" ? "staging" : "issued", objectKey: `capability-orders/${orderId}/${kind === "copy" ? "published" : "outputs"}/${outputId}-${kind === "copy" ? `${"a".repeat(24)}-` : ""}生成结果.flac`, ...extra };
    rows[kind === "copy" ? "capabilityOutputCopies" : "capabilityOutputUploads"].push(record); return record;
  };
  const run = (extra) => cleanupCapabilityOutputs({ getCollection, removeObject, now, ...extra });
  return { rows, deleted, hooks, getCollection, removeObject, add, run };
}

test("expired unreferenced staging copies are deleted exactly and repeat cleanup is idempotent", async () => {
  const f = fixture(); const row = f.add();
  assert.equal(isOwnedCapabilityOutputKey(row, "copy"), true);
  assert.deepEqual(await f.run(), { examined: 1, deleted: 1, retained: 0, rejected: 0, retry: 0 });
  assert.deepEqual(f.deleted, [row.objectKey]); assert.equal(row.status, "deleted");
  assert.equal((await f.run()).examined, 0); assert.equal(f.deleted.length, 1);
});

test("interrupted completion keeps every object referenced by an order, regardless of status", async () => {
  const f = fixture(); const copy = f.add(); const source = f.add("upload", { status: "completed" });
  f.rows.capabilityOrders.push({ _id: copy.orderId, status: "completed", outputs: [{ objectKey: copy.objectKey }] },
    { _id: source.orderId, status: "cancelled", outputs: [{ objectKey: source.objectKey }] });
  const result = await f.run(); assert.equal(result.retained, 2); assert.deepEqual(f.deleted, []);
  assert.equal(copy.status, "retained"); assert.equal("expiresAt" in copy, false);
  assert.equal(source.cleanupStatus, "retained"); assert.equal("expiresAt" in source, false);
  assert.equal((await f.run()).examined, 0);
});

test("cleanup rejects foreign, escaped, nested and malformed paths instead of expanding deletion", async () => {
  const f = fixture();
  for (const change of [
    (key) => key.replace("published/", "outputs/"),
    (key) => key.replace(/capability-orders\/[^/]+/, `capability-orders/${new ObjectId()}`),
    (key) => `${key}/other.flac`, (key) => key.replace("生成结果.flac", "../secret.flac"),
    (key) => key.replace("生成结果.flac", "%2e%2e.flac"), (key) => key.replace("生成结果.flac", "a\\b.flac"),
    (key) => key.replace("a".repeat(24), "abc"),
  ]) { const row = f.add(); row.objectKey = change(row.objectKey); }
  const result = await f.run(); assert.equal(result.rejected, 7); assert.deepEqual(f.deleted, []);
  assert.ok(f.rows.capabilityOutputCopies.every((row) => row.status === "rejected"));
});

test("COS and order-read failures keep staging, sanitize errors and retry with backoff", async () => {
  const f = fixture(); const row = f.add(); let fail = true;
  f.hooks.remove = async () => { if (fail) throw new Error("secret signed URL credential must not be saved"); };
  assert.equal((await f.run()).retry, 1); assert.equal(row.status, "staging");
  assert.equal(row.cleanupError, "OUTPUT_CLEANUP_RETRY"); assert.equal(JSON.stringify(row).includes("credential"), false);
  assert.equal(row.cleanupAttempts, 1); assert.equal((await f.run()).examined, 0);
  fail = false; assert.equal((await f.run({ now: new Date(now.getTime() + 60001) })).deleted, 1);
  assert.equal(row.status, "deleted"); assert.equal("cleanupError" in row, false);
  const other = f.add(); f.hooks.readOrder = async () => { throw new Error("db unavailable"); };
  assert.equal((await f.run()).retry, 1); assert.equal(other.status, "staging"); assert.equal(f.deleted.length, 1);
});

test("original PUT sources wait for ticket expiry, derive removed expiry and protect live references", async () => {
  const f = fixture(); const expired = f.add("upload"); const completed = f.add("upload", { status: "completed" }); delete completed.expiresAt;
  const stillWritable = f.add("upload", { status: "completed", expiresAt: future });
  const newTicket = f.add("upload", { createdAt: now, expiresAt: future });
  const invalid = f.add("upload", { objectKey: "other-project/model.bin" });
  const result = await f.run(); assert.equal(result.deleted, 2); assert.equal(result.rejected, 1);
  assert.equal(expired.cleanupStatus, "deleted"); assert.equal(completed.cleanupStatus, "deleted");
  assert.equal(stillWritable.cleanupStatus, undefined); assert.equal(newTicket.cleanupStatus, undefined);
  assert.equal(invalid.cleanupStatus, "rejected"); assert.ok(f.deleted.every((key) => key.includes("/outputs/")));
});

test("one invocation never inspects more than fifty output objects across collections", async () => {
  const f = fixture(); for (let i = 0; i < 60; i += 1) f.add(); f.add("upload");
  const first = await f.run({ limit: 100000 }); assert.equal(first.examined, 50); assert.equal(first.deleted, 50);
  const second = await f.run(); assert.equal(second.deleted, 11); assert.equal(f.deleted.length, 61);
});

test("cleanup endpoint is secret-gated, uncached, bounded, and returns no object locations", async () => {
  const f = fixture(); f.add(); let secret = ""; const app = new OpenAPIHono();
  registerCapabilityOutputCleanupRoutes(app, { getCollection: f.getCollection, removeObject: f.removeObject, now, readCronSecret: () => secret });
  const missing = await app.request(CAPABILITY_OUTPUT_CLEANUP_PATH); assert.equal(missing.status, 503);
  secret = "test-cron-secret";
  for (const authorization of [undefined, "Bearer wrong", "test-cron-secret"]) {
    const response = await app.request(CAPABILITY_OUTPUT_CLEANUP_PATH, { headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401); assert.match(response.headers.get("Cache-Control"), /no-store/);
  }
  assert.deepEqual(f.deleted, []);
  const ok = await app.request(CAPABILITY_OUTPUT_CLEANUP_PATH, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(ok.status, 200); const text = await ok.text();
  assert.equal(text.includes("published"), false); assert.equal(text.includes("objectKey"), false); assert.equal(text.includes(secret), false);
  assert.equal(JSON.parse(text).cleanup.deleted, 1);
  assert.ok(app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } }).paths[CAPABILITY_OUTPUT_CLEANUP_PATH].get);
});

test("both target schedules wire protected cleanup without making minute timer scan all outputs", () => {
  const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(vercel.crons.find((entry) => entry.path === CAPABILITY_OUTPUT_CLEANUP_PATH), { path: CAPABILITY_OUTPUT_CLEANUP_PATH, schedule: "23 * * * *" });
  const deployment = readFileSync(new URL("../../deploy/tencent/deploy-release.sh", import.meta.url), "utf8");
  assert.match(deployment, /flock --nonblock 9/); assert.match(deployment, /cleanup_hour="\$\(date -u \+%Y%m%d%H\)"/);
  assert.match(deployment, /previous_hour" != "\$cleanup_hour/); assert.match(deployment, /capability_cleanup_auth_check/);
  assert.match(deployment, /api\/cron\/h3-output-cleanup/); assert.match(deployment, /api\/cron\/capability-output-cleanup/);
});

test("maintenance infrastructure failures return a sanitized retryable response", async () => {
  const app = new OpenAPIHono();
  registerCapabilityOutputCleanupRoutes(app, { readCronSecret: () => "test-only-secret", getCollection: async () => { throw new Error("mongodb://private:password@example.test"); } });
  const response = await app.request(CAPABILITY_OUTPUT_CLEANUP_PATH, { headers: { authorization: "Bearer test-only-secret" } });
  assert.equal(response.status, 503); const text = await response.text();
  assert.equal(JSON.parse(text).code, "CAPABILITY_OUTPUT_CLEANUP_UNAVAILABLE");
  assert.equal(text.includes("mongodb"), false); assert.equal(text.includes("password"), false);
});
