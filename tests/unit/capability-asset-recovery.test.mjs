import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { registerCapabilityOrderRoutes } from "../../server/capability-orders.js";
import { singleWriteBucketReady } from "../../server/cos.js";
import { isDefiniteMissingCosObject } from "../../server/cos-object-presence.js";

// All storage, signatures and bodies stay in memory. No actual COS upload,
// credentials, model, service or file fixture is created by these tests.
function fixture() {
  const owner = new ObjectId(), other = new ObjectId(), stores = new Map(), signatures = [], heads = new Map(), hooks = {};
  const collection = (name) => {
    if (!stores.has(name)) {
      const rows = createCapabilityMemoryCollection();
      if (name === "capabilityAssetUploads") {
        const insert = rows.insertOne.bind(rows), update = rows.updateOne.bind(rows);
        rows.insertOne = async (record) => {
          if (record.assetRequestKey && rows.rows.some((row) => row.assetRequestKey === record.assetRequestKey)) throw Object.assign(new Error("duplicate request"), { code: 11000 });
          return insert(record);
        };
        rows.updateOne = async (filter, change, options) => { await hooks.beforeUpdate?.(rows.rows, filter, change); return update(filter, change, options); };
      }
      stores.set(name, rows);
    }
    return stores.get(name);
  };
  const app = new OpenAPIHono();
  app.onError((error, c) => c.json({ code: error.code || "TEST_ROUTE_FAILURE", message: error.message }, error.status || 500));
  let headMode = "normal", writePolicy = true, headReads = 0;
  registerCapabilityOrderRoutes(app, {
    getCollection: async (name) => collection(name), getUserComputeGroupId: async () => null,
    requireTrustedMutation: () => null, enforceRateLimit: async () => ({ allowed: true }),
    readGulongEngineEntitlement: async () => ({ active: true }), readEnglishEntitlement: async () => ({ active: true }),
    authenticate: async (c) => {
      const token = c.req.header("authorization");
      if (!["Bearer owner", "Bearer other", "Bearer english"].includes(token)) return { error: c.json({ code: "AUTH_REQUIRED" }, 401) };
      return { kind: token === "Bearer english" ? "desktop-english" : "desktop-gulong-engine", user: { id: String(token === "Bearer other" ? other : owner), role: "user" } };
    },
    ensureBrowserUploadCors: async () => {},
    assertSingleWriteUploads: async () => { if (writePolicy !== true) throw Object.assign(new Error("memory-only storage policy"), { status: writePolicy, code: writePolicy === 409 ? "ASSET_WRITE_ONCE_UNAVAILABLE" : "ASSET_STORAGE_STATUS_UNAVAILABLE" }); },
    createPresignedPutUrl: (key, options) => { signatures.push({ key, options }); return "https://cos.invalid/write-once"; },
    headObject: async (key) => {
      headReads++;
      if (hooks.headError) throw hooks.headError;
      if (headMode === "null") return null;
      if (headMode === "unavailable") throw Object.assign(new Error("storage unavailable"), { statusCode: 403 });
      if (!heads.has(key)) throw Object.assign(new Error("not found"), { statusCode: 404, code: "NoSuchKey" });
      return heads.get(key);
    }, deleteObject: async (key) => heads.delete(key),
  });
  const body = { request_key: "task-1234:attachment-1", client_product: "worklucky", capability_id: "qwen_image_2_1.multi_image_edit", role: "reference_image",
    filename: "source.png", content_type: "image/png", bytes: 100, sha256: "a".repeat(64) };
  const call = async (path, data, account = "owner") => {
    const response = await app.request(`http://localhost${path}`, { method: data === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(account ? { Authorization: `Bearer ${account}` } : {}), "Idempotency-Key": "order-asset-recovery-0001" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  };
  const presign = (patch = {}) => call("/api/v1/capability-assets/presign", { ...body, ...patch });
  const query = (product = "worklucky", account = "owner") => call(`/api/v1/capability-assets/by-request/${body.request_key}?product=${product}`, undefined, account);
  const uploaded = (record) => heads.set(record.objectKey, { headers: { "content-length": String(record.bytes), "x-cos-meta-sha256": record.sha256,
    "content-type": record.contentType, "x-cos-meta-bytes": String(record.bytes), "x-cos-meta-owner-id": String(record.ownerId), "x-cos-meta-capability-asset-id": String(record._id) } });
  return { owner, collection, signatures, heads, hooks, body, call, presign, query, uploaded,
    get records() { return collection("capabilityAssetUploads").rows; }, get headReads() { return headReads; },
    set headMode(value) { headMode = value; }, set writePolicy(value) { writePolicy = value; } };
}

test("lost presign responses recover one original asset and an expiring signed write-once grant", async () => {
  const f = fixture(), first = await f.presign(), retry = await f.query();
  assert.equal(first.status, 201); assert.equal(retry.status, 200); assert.equal(f.records.length, 1);
  for (const response of [first, retry]) {
    assert.equal(response.body.stage, "awaiting_upload"); assert.equal(response.body.can_upload, true); assert.equal(response.body.can_complete, false);
    assert.equal(response.body.headers["x-cos-forbid-overwrite"], "true"); assert.match(response.cache, /private, no-store/);
  }
  assert.equal(first.body.asset_id, retry.body.asset_id); assert.equal(first.body.object_key, retry.body.object_key);
  assert.equal(first.body.expires_at, retry.body.expires_at); assert.equal(retry.body.asset.sha256, "A".repeat(64));
  assert.ok(f.signatures.every((entry) => entry.options.expires <= 3600));
});

test("concurrent retries keep one asset identity and conflict on changed product or manifest", async () => {
  const f = fixture(), replies = await Promise.all(Array.from({ length: 24 }, () => f.presign()));
  assert.ok(replies.every((r) => [200, 201].includes(r.status)), JSON.stringify(replies));
  assert.equal(new Set(replies.map((r) => r.body.asset_id)).size, 1); assert.equal(f.records.length, 1);
  for (const patch of [{ filename: "changed.png" }, { sha256: "b".repeat(64) }, { bytes: 101 }, { client_product: "gulong_engine" }]) {
    const result = await f.presign(patch); assert.equal(result.status, 409); assert.equal(result.body.code, "IDEMPOTENCY_KEY_CONFLICT");
  }
});

test("a successful PUT with a lost response recovers uploaded, completes idempotently and never grants another PUT", async () => {
  const f = fixture(), initial = await f.presign(); f.uploaded(f.records[0]);
  const uploaded = await f.query();
  assert.equal(uploaded.body.stage, "uploaded"); assert.equal(uploaded.body.can_complete, true); assert.equal(uploaded.body.can_upload, false);
  assert.equal(uploaded.body.upload_url, undefined); assert.equal(f.signatures.length, 1);
  const path = `/api/v1/capability-assets/${initial.body.asset_id}/complete?product=worklucky`;
  const completed = await f.call(path, {}), replay = await f.call(path, {}), ready = await f.query();
  assert.equal(completed.status, 200); assert.equal(completed.body.idempotent, false); assert.equal(replay.body.idempotent, true);
  assert.deepEqual(completed.body.asset, replay.body.asset); assert.deepEqual(ready.body.asset, completed.body.asset);
  assert.equal(ready.body.stage, "ready"); assert.equal(ready.body.upload_url, undefined); assert.equal(f.signatures.length, 1);
});

test("unknown, empty, mismatching or expired COS state fails closed without upload grants", async () => {
  for (const mode of ["unavailable", "null", "mismatch", "expired"]) {
    const f = fixture(); await f.presign();
    if (mode === "expired") f.records[0].expiresAt = new Date(0);
    else if (mode === "mismatch") { f.uploaded(f.records[0]); f.heads.get(f.records[0].objectKey).headers["content-length"] = "101"; }
    else f.headMode = mode;
    const result = await f.query();
    assert.equal(result.status, mode === "expired" ? 410 : mode === "mismatch" ? 409 : 503);
    assert.equal(result.body.can_upload, false); assert.equal(result.body.upload_url, undefined); assert.equal(f.signatures.length, 1);
    assert.equal(f.records[0].status, "uploading", "a GET never marks/deletes the user's asset");
  }
});

test("non-object 404, delete markers and inconsistent NoSuchKey cannot renew PUT or permit completion", async () => {
  for (const error of [{statusCode:404}, {statusCode:404,code:"NoSuchBucket"}, {statusCode:403,code:"NoSuchKey"},
    {statusCode:404,code:"NoSuchKey",headers:{"x-cos-delete-marker":"true"}}]) {
    const f=fixture(),initial=await f.presign();f.hooks.headError=error;
    const queried=await f.query();assert.equal(queried.status,503);assert.equal(queried.body.can_upload,false);
    assert.equal(queried.body.upload_url,undefined);assert.equal(f.signatures.length,1);
    const completed=await f.call(`/api/v1/capability-assets/${initial.body.asset_id}/complete?product=worklucky`,{});
    assert.equal(completed.status,503);assert.equal(f.records[0].status,"uploading");
  }
  const f=fixture();await f.presign();f.hooks.headError={statusCode:404,code:"Error",headers:{"x-cos-request-id":"direct-private-cos-head"}};
  const confirmed=await f.query();assert.equal(confirmed.status,200);assert.equal(confirmed.body.can_upload,true);
});

const numericCosHeadMissing = () => ({ statusCode: 404, code: "404", name: "404", headers: {
  "server": "tencent-cos", "content-length": "0", "content-type": "application/xml", "x-cos-request-id": "synthetic-direct-cos-head",
} });

test("the SDK numeric empty COS HEAD shape is definite missing with case-insensitive direct headers", () => {
  assert.equal(isDefiniteMissingCosObject(numericCosHeadMissing()), true);
  assert.equal(isDefiniteMissingCosObject({ statusCode: 404, code: "404", headers: {
    "Server": "tencent-cos", "Content-Length": "0", "X-Cos-Request-Id": "synthetic-direct-cos-head",
  } }), true);
});

test("numeric status codes cannot widen missing detection to proxy, nonempty, denied or deleted objects", () => {
  for (const patch of [
    { statusCode: 403 }, { statusCode: 500 }, { code: "403" }, { code: "NoSuchBucket" }, { code: "AccessDenied" },
    { code: 404 }, { headers: {} }, { headers: { "server": "tencent-cos", "content-length": "0" } },
    { headers: { "x-cos-request-id": "synthetic-id", "content-length": "0", "server": "proxy" } },
    { headers: { "x-cos-request-id": "synthetic-id", "server": "tencent-cos" } },
    { headers: { "x-cos-request-id": "synthetic-id", "server": "tencent-cos", "content-length": "100" } },
    { headers: { ...numericCosHeadMissing().headers, "x-cos-delete-marker": "true" } },
  ]) assert.equal(isDefiniteMissingCosObject({ ...numericCosHeadMissing(), ...patch }), false, JSON.stringify(patch));
});

test("numeric missing recovery keeps the original asset and expiry without any upload or database mutation", async () => {
  const f = fixture(), first = await f.presign(), before = JSON.stringify(f.records);
  f.hooks.headError = numericCosHeadMissing();
  const recovered = await f.query();
  assert.equal(recovered.status, 200); assert.equal(recovered.body.stage, "awaiting_upload");
  assert.equal(recovered.body.can_upload, true); assert.equal(recovered.body.can_complete, false);
  assert.equal(recovered.body.asset_id, first.body.asset_id); assert.equal(recovered.body.object_key, first.body.object_key);
  assert.equal(recovered.body.expires_at, first.body.expires_at); assert.deepEqual(recovered.body.headers, first.body.headers);
  assert.equal(JSON.stringify(f.records), before); assert.equal(f.heads.size, 0); assert.equal(f.records.length, 1);
  f.records[0].expiresAt = new Date(0);
  const expired = await f.query();
  assert.equal(expired.status, 410); assert.equal(expired.body.can_upload, false); assert.equal(expired.body.upload_url, undefined);
});

test("numeric missing cannot complete or delete an object and unknown HEADs still return safe 503", async () => {
  const f = fixture(), first = await f.presign(), before = JSON.stringify(f.records);
  f.hooks.headError = numericCosHeadMissing();
  const complete = await f.call(`/api/v1/capability-assets/${first.body.asset_id}/complete?product=worklucky`, {});
  assert.equal(complete.status, 409); assert.equal(complete.body.code, "ASSET_OBJECT_NOT_FOUND");
  f.hooks.headError = { ...numericCosHeadMissing(), headers: { ...numericCosHeadMissing().headers, server: "proxy" } };
  const unknown = await f.query();
  assert.equal(unknown.status, 503); assert.equal(unknown.body.code, "ASSET_RECOVERY_UNAVAILABLE");
  assert.equal(unknown.body.stage, "unknown"); assert.equal(unknown.body.can_upload, false); assert.equal(unknown.body.can_complete, false);
  assert.equal(unknown.body.upload_url, undefined); assert.equal(f.signatures.length, 1);
  assert.equal(JSON.stringify(f.records), before); assert.equal(f.heads.size, 0);
});

test("storage versioning or an unknown write-once policy never creates an unsafe PUT credential", async () => {
  assert.equal(singleWriteBucketReady({ VersioningConfiguration: {} }), true);
  for (const config of [undefined, {}, { VersioningConfiguration: null }, { VersioningConfiguration: [] },
    { VersioningConfiguration: { Status: "Enabled" } }, { VersioningConfiguration: { Status: "Suspended" } }]) assert.equal(singleWriteBucketReady(config), false);
  for (const policy of [409, 503]) {
    const f = fixture(); f.writePolicy = policy;
    const result = await f.presign(); assert.equal(result.status, policy); assert.equal(f.signatures.length, 0);
    assert.equal(result.body.upload_url, undefined); assert.equal(f.records.length, 1);
    f.writePolicy = true;
    const recovered = await f.query(); assert.equal(recovered.status, 200); assert.equal(recovered.body.asset_id, result.body.asset_id);
    assert.equal(f.records.length, 1);
  }
});

test("asset recovery, completion and order reuse enforce account, product, capability and role scopes", async () => {
  const f = fixture(), first = await f.presign(); f.uploaded(f.records[0]);
  for (const [product, account, status] of [["worklucky", "other", 404], ["gulong_engine", "owner", 409], ["worklucky", "english", 403], ["worklucky", "", 401]]) {
    const result = await f.query(product, account); assert.equal(result.status, status); assert.equal(result.body.upload_url, undefined);
    assert.equal(result.body.asset, undefined);
  }
  const complete = `/api/v1/capability-assets/${first.body.asset_id}/complete`;
  assert.equal((await f.call(`${complete}?product=gulong_engine`, {})).status, 409);
  assert.equal((await f.call(`${complete}?product=worklucky`, {}, "other")).status, 404);
  assert.equal((await f.call(`${complete}?product=worklucky`, {})).status, 200);
  for (const patch of [{ client_product: "gulong_engine" }, { capability_id: "qwen_image_2_1.text_to_image" }, { assets: [{ asset_id: first.body.asset_id, role: "source_image" }] }]) {
    const result = await f.call("/api/v1/capability-orders", { client_product: "worklucky", capability_id: "qwen_image_2_1.multi_image_edit",
      capability_version: "2.1", parameters: { prompt: "test", width: 512, height: 512 }, assets: [{ asset_id: first.body.asset_id, role: "reference_image" }], ...patch });
    assert.equal(result.status, 409); assert.equal(result.body.code, "ASSET_SCOPE_MISMATCH");
  }
  assert.equal(f.collection("capabilityOrders").rows.length, 0);
});

test("invalid recoverable manifests fail before persistence and completion cannot return a receipt after a lost state CAS", async () => {
  for (const patch of [{ request_key: "short" }, { request_key: null }, { request_key: 123 }, { role: "source_video" },
    { client_product: "unknown" }, { capability_id: "gulong_engine.video" }, { filename: undefined }, { bytes: 100.5 }]) {
    const f = fixture(); const result = await f.presign(patch); assert.equal(result.status, 400); assert.equal(f.records.length, 0); assert.equal(f.signatures.length, 0);
  }
  const contradictory = fixture();
  assert.equal((await contradictory.call("/api/v1/capability-assets/presign?product=gulong_engine", contradictory.body)).status, 400);
  assert.equal(contradictory.records.length, 0);
  const f = fixture(), initial = await f.presign(); f.uploaded(f.records[0]);
  f.hooks.beforeUpdate = async (rows, _filter, update) => { if (update.$set?.status === "ready") rows[0].status = "rejected"; };
  const result = await f.call(`/api/v1/capability-assets/${initial.body.asset_id}/complete?product=worklucky`, {});
  assert.equal(result.status, 409); assert.equal(result.body.code, "ASSET_STATE_CONFLICT"); assert.equal(result.body.asset, undefined);
  const db = readFileSync(new URL("../../server/db.js", import.meta.url), "utf8");
  assert.match(db, /uniq_capability_asset_request/); assert.match(db, /partialFilterExpression: \{ assetRequestKey: \{ \$type: "string"/);
});

test("legacy unkeyed uploads retain their old receipt even when an old client sends a product hint", async () => {
  const f = fixture(), initial = await f.presign({ request_key: undefined });
  assert.equal(initial.status, 201); assert.equal(initial.body.stage, undefined); assert.equal(f.records[0].clientProduct, undefined);
  assert.equal(f.records[0].assetRequestKey, undefined);
  f.uploaded(f.records[0]);
  const completed = await f.call(`/api/v1/capability-assets/${initial.body.asset_id}/complete?product=worklucky`, {});
  assert.equal(completed.status, 200);
  const replay = await f.call(`/api/v1/capability-assets/${initial.body.asset_id}/complete`, {});
  assert.equal(replay.status, 200); assert.deepEqual(replay.body.asset, completed.body.asset);
  assert.equal((await f.query()).status, 404, "legacy assets do not invent a retrospective recovery key");
});

test("digital-live assets use their own product scope instead of WorkLucky recovery credentials", async () => {
  const f = fixture(), initial = await f.presign({ client_product: "digital_live" });
  assert.equal(initial.status, 201); assert.equal(initial.body.client_product, "digital_live");
  assert.equal((await f.query("digital_live")).body.asset_id, initial.body.asset_id);
  assert.equal((await f.query("worklucky")).status, 409);
  f.uploaded(f.records[0]);
  const completed = await f.call(`/api/v1/capability-assets/${initial.body.asset_id}/complete?product=digital_live`, {});
  assert.equal(completed.status, 200); assert.equal((await f.query("digital_live")).body.stage, "ready");
});
