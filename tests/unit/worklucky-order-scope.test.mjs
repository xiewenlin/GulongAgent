import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { CAPABILITY_ORDER_PROTOCOL, normalizeCapabilityReport, registerCapabilityOrderRoutes } from "../../server/capability-orders.js";

const primitive = (value) => value instanceof ObjectId ? String(value) : value instanceof Date ? +value : value;
const equal = (a, b) => primitive(a) === primitive(b) || (a == null && b == null);
function nested(row, key) {
  if (!key || !row) return row;
  const [first, ...rest] = key.split(".");
  if (Array.isArray(row)) return row.flatMap((entry) => nested(entry, key));
  return nested(row[first], rest.join("."));
}
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((part) => matches(row, part));
    const actual = nested(row, key);
    if (Array.isArray(actual) && !(value && typeof value === "object")) return actual.some((entry) => equal(entry, value));
    if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof ObjectId)) return Object.entries(value).every(([op, expected]) => {
      if (op === "$in") return expected.some((entry) => equal(actual, entry));
      if (op === "$nin") return !expected.some((entry) => equal(actual, entry));
      if (op === "$gt") return primitive(actual) > primitive(expected);
      if (op === "$gte") return primitive(actual) >= primitive(expected);
      if (op === "$lt") return primitive(actual) < primitive(expected);
      if (op === "$lte") return primitive(actual) <= primitive(expected);
      return false;
    });
    return equal(actual, value);
  });
}
const requestKey = (owner, key) => createHash("sha256").update(`${owner}:${key}`).digest("hex");

function fixture() {
  const owner = new ObjectId(); const other = new ObjectId(); const node = "scope-node-0001";
  const binding = { _id: new ObjectId(), userId: owner, nodeId: node, status: "active", revokedAt: null, computeGroupId: null };
  const report = normalizeCapabilityReport({ capability_id: "gulong_engine.text", capability_version: "1", protocol_version: CAPABILITY_ORDER_PROTOCOL,
    installed: true, validated: true, enabled: true, max_concurrent: 2,
    validation: { tested_at: new Date().toISOString(), artifact_sha256: "A".repeat(64), test_id: "memory-only-not-real-consumer" } });
  const rows = { users: [{ _id: owner, status: "active" }], capabilityOrders: [], capabilityOutputUploads: [], nodeAccountBindings: [binding], capabilityNodeReports: [{ bindingId: binding._id, userId: owner, nodeId: node,
    protocolVersion: CAPABILITY_ORDER_PROTOCOL, capabilities: [report], resources: { running_task_count: 0, max_concurrent_tasks: 2 }, reportedAt: new Date() }] };
  const hooks = {};
  const mutate = (row, update) => {
    Object.assign(row, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
  };
  const getCollection = async (name) => {
    rows[name] ||= [];
    return {
      findOne: async (query) => rows[name].find((row) => matches(row, query)) || null,
      find: (query) => { let found = rows[name].filter((row) => matches(row, query)); return { limit(n) { found = found.slice(0, n); return this; }, sort() { return this; }, toArray: async () => found }; },
      countDocuments: async (query) => rows[name].filter((row) => matches(row, query)).length,
      insertOne: async (row) => {
        if (name === "capabilityOrders" && hooks.insertRace) { rows[name].push(hooks.insertRace(row)); throw Object.assign(new Error("duplicate"), { code: 11000 }); }
        rows[name].push(row); return { insertedId: row._id };
      },
      updateOne: async (query, update, options) => {
        const row = rows[name].find((entry) => matches(entry, query));
        if (row) mutate(row, update);
        else if (options?.upsert) rows[name].push({ ...update.$setOnInsert });
        return { matchedCount: row ? 1 : 0 };
      },
      updateMany: async (query, update) => { rows[name].filter((row) => matches(row, query)).forEach((row) => mutate(row, update)); return {}; },
    };
  };
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, { getCollection, getUserComputeGroupId: async () => null,
    slotCoordinator: { snapshot: async () => ({ available: true, activeCount: 0, byCapability: {}, leases: [] }), release: async () => true },
    findTrustedConsumerAcceptance: async () => true,
    authenticate: async (c) => c.req.header("authorization") === "Bearer memory-owner" ? { kind: "desktop-gulong-engine", user: { id: String(owner), role: "user" } }
      : c.req.header("authorization") === "Bearer memory-english" ? { kind: "desktop-english", user: { id: String(owner), role: "user" } }
      : c.req.header("authorization") === "Bearer memory-other" ? { kind: "desktop-gulong-engine", user: { id: String(other), role: "user" } } : { error: c.json({ code: "AUTH_REQUIRED" }, 401) },
    requireTrustedMutation: () => null, enforceRateLimit: async () => ({ allowed: true }),
    readGulongEngineEntitlement: async () => ({ active: true }), createPresignedDownloadUrl: () => "https://cos.invalid/private",
  });
  const call = (suffix, body, token = "memory-owner", key = "request-scope-0001") => app.request(`/api/v1/capability-orders${suffix}`, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const seed = (clientProduct, extra = {}) => {
    const now = new Date(); const row = { _id: new ObjectId(), orderNo: "CAP-SENSITIVE", requesterUserId: owner, idempotencyKey: requestKey(owner, "request-scope-0001"),
      protocolVersion: CAPABILITY_ORDER_PROTOCOL, capabilityId: "gulong_engine.text", status: "completed", priceFen: 0, inlineResult: { text: "private-result-do-not-disclose" },
      assets: [], createdAt: now, updatedAt: now, ...(clientProduct ? { clientProduct } : {}), ...extra };
    rows.capabilityOrders.push(row); return row;
  };
  const create = (extra = {}) => call("", { capability_id: "gulong_engine.text", parameters: { prompt: "test" }, ...extra });
  return { rows, hooks, owner, other, call, seed, create };
}

test("capability product selectors reject unknown, null and duplicate products", async () => {
  const f = fixture();
  for (const query of ["product=other", "product=", "product=worklucky&product=worklucky"]) assert.equal((await f.call(`/catalog?${query}`)).status, 400);
  for (const product of [null, false, "other", ["worklucky"]]) assert.equal((await f.create({ client_product: product })).status, 400);
  assert.equal((await f.call("/catalog?product=worklucky")).status, 200);
  assert.equal((await f.call("/catalog?product=gulong_engine")).status, 200);
});

test("the explicit Gulong product marker has its own idempotent identity and native shared models stay closed without proof", async () => {
  const f = fixture();
  const created = await f.create({ client_product: "gulong_engine" });
  assert.equal(created.status, 201);
  assert.equal(f.rows.capabilityOrders[0].clientProduct, "gulong_engine");
  assert.equal((await f.create({ client_product: "worklucky" })).status, 409);
  const before = f.rows.capabilityOrders.length;
  const native = await f.call("", { client_product: "gulong_engine", capability_id: "minimax_music_3.generate",
    parameters: { prompt: "Simple short melody", lyrics: "Blue sky", duration_seconds: 12, sample_rate: 44100, output_format: "flac", language: "auto", seed: 1 } },
  "memory-owner", "native-without-consumer");
  assert.equal(native.status, 409);
  assert.equal((await native.json()).code, "CAPABILITY_NO_COMPATIBLE_NODE");
  assert.equal(f.rows.capabilityOrders.length, before);
  assert.equal(f.rows.wallets, undefined);
  assert.equal((await f.call("/catalog?product=gulong_engine", undefined, "memory-english")).status, 403);
});

test("order read and cancellation check product scope before revealing any record", async () => {
  for (const clientProduct of [undefined, "worklucky"]) {
    const f = fixture(); const row = f.seed(clientProduct); const wrongQuery = clientProduct ? "" : "?product=worklucky"; const wrongBody = clientProduct ? {} : { client_product: "worklucky" };
    for (const response of [await f.call(`/${row._id}${wrongQuery}`), await f.call(`/by-request/request-scope-0001${wrongQuery}`),
      await f.call(`/${row._id}/cancel`, wrongBody), await f.call("/by-request/request-scope-0001/cancel", wrongBody)]) {
      assert.equal(response.status, 409); const text = await response.text();
      assert.equal(text.includes("private-result-do-not-disclose"), false); assert.equal(text.includes("CAP-SENSITIVE"), false);
    }
    assert.equal(row.status, "completed");
    const correct = await f.call(`/${row._id}${clientProduct ? "?product=worklucky" : ""}`); assert.equal(correct.status, 200);
    assert.equal((await f.call(`/${row._id}?product=worklucky`, undefined, "memory-other")).status, 404);
    assert.equal((await f.call(`/by-request/request-scope-0001?product=worklucky`, undefined, "memory-other")).status, 404);
  }
});

test("WorkLucky cancel-before-create persists product and prevents late duplicate execution", async () => {
  const f = fixture();
  const cancel = await f.call("/by-request/request-scope-0001/cancel", { client_product: "worklucky" });
  assert.equal(cancel.status, 200); assert.equal(f.rows.capabilityOrders.length, 1);
  assert.equal(f.rows.capabilityOrders[0].clientProduct, "worklucky"); assert.equal(f.rows.capabilityOrders[0].cancellationTombstone, true);
  assert.equal((await cancel.clone().json()).order.client_product, "worklucky");
  const repeated = await f.call("/by-request/request-scope-0001/cancel", { client_product: "worklucky" }); assert.equal(repeated.status, 200);
  const late = await f.create({ client_product: "worklucky" }); assert.equal(late.status, 201);
  const view = await late.json(); assert.equal(view.order.status, "cancelled"); assert.equal(view.order.cancellation_tombstone, true);
  assert.equal((await f.create()).status, 409); assert.equal(f.rows.capabilityOrders.length, 1);
});

test("duplicate insert race checks product before returning a cancellation tombstone", async () => {
  for (const tombstoneProduct of [undefined, "worklucky"]) {
    const f = fixture();
    f.hooks.insertRace = (row) => ({ ...row, clientProduct: tombstoneProduct, cancellationTombstone: true, status: "cancelled", capabilityId: null, requestFingerprint: undefined });
    const response = await f.create({ client_product: "worklucky" });
    assert.equal(response.status, tombstoneProduct ? 201 : 409);
    assert.equal(f.rows.capabilityOrders.length, 1);
    if (!tombstoneProduct) assert.equal("order" in await response.json(), false);
  }
});

test("anonymous and switched accounts cannot cancel or recover another user's request", async () => {
  const f = fixture(); const row = f.seed("worklucky", { status: "queued", autoCancelAt: new Date(Date.now() + 600000) });
  assert.equal((await f.call(`/${row._id}?product=worklucky`, undefined, null)).status, 401);
  assert.equal((await f.call(`/${row._id}/cancel`, { client_product: "worklucky" }, "memory-other")).status, 404);
  assert.equal(row.status, "queued");
  const otherCancel = await f.call("/by-request/request-scope-0001/cancel", { client_product: "worklucky" }, "memory-other");
  assert.equal(otherCancel.status, 200); assert.equal(row.status, "queued");
  assert.equal(f.rows.capabilityOrders.length, 2); assert.notEqual(String(f.rows.capabilityOrders[1].requesterUserId), String(row.requesterUserId));
});

test("English desktop credentials cannot exploit product-marked cancellation tombstones", async () => {
  const f = fixture(); const row = f.seed("worklucky", { cancellationTombstone: true, capabilityId: null, status: "cancelled" });
  for (const [path, body] of [["/catalog?product=worklucky"], [`/${row._id}?product=worklucky`], ["/by-request/request-scope-0001?product=worklucky"],
    [`/${row._id}/cancel`, { client_product: "worklucky" }], ["/by-request/request-scope-0001/cancel", { client_product: "worklucky" }],
    ["", { capability_id: "gulong_engine.text", client_product: "worklucky", parameters: { prompt: "test" } }]]) {
    const response = await f.call(path, body, "memory-english"); assert.equal(response.status, 403);
    assert.equal("order" in await response.json(), false);
  }
  assert.equal(f.rows.capabilityOrders.length, 1); assert.equal(row.status, "cancelled");
});
