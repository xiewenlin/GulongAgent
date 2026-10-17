import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { hashOpaqueToken } from "../../server/security.js";
import { CAPABILITY_ORDER_PROTOCOL, normalizeCapabilityReport, registerCapabilityOrderRoutes } from "../../server/capability-orders.js";
import { registerCapabilityConsumerAcceptanceRoutes } from "../../server/capability-consumer-acceptance.js";

function clone(value) {
  if (value instanceof Date) return new Date(value);
  if (value instanceof ObjectId) return new ObjectId(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
}
const primitive = (value) => value instanceof Date ? +value : value instanceof ObjectId ? String(value) : value;
const equal = (a, b) => primitive(a) === primitive(b) || (a == null && b == null);
function nested(value, key) {
  if (!key) return value;
  if (Array.isArray(value)) return value.flatMap((entry) => nested(entry, key));
  if (value == null) return undefined;
  const [part, ...rest] = key.split(".");
  return nested(value[part], rest.join("."));
}
function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((entry) => matches(row, entry));
    if (key === "$and") return expected.every((entry) => matches(row, entry));
    const actual = nested(row, key);
    if (expected && typeof expected === "object" && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === "$in") return (Array.isArray(actual) ? actual : [actual]).some((entry) => value.some((item) => equal(entry, item)));
        if (operator === "$nin") return !(Array.isArray(actual) ? actual : [actual]).some((entry) => value.some((item) => equal(entry, item)));
        if (operator === "$exists") return (actual !== undefined) === value;
        if (operator === "$ne") return !equal(actual, value);
        if (operator === "$gte") return primitive(actual) >= primitive(value);
        if (operator === "$gt") return primitive(actual) > primitive(value);
        if (operator === "$lte") return primitive(actual) <= primitive(value);
        if (operator === "$lt") return primitive(actual) < primitive(value);
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return Array.isArray(actual) ? actual.some((entry) => equal(entry, expected)) : equal(actual, expected);
  });
}
function mutate(row, update, isInsert = false) {
  if (isInsert) Object.assign(row, clone(update.$setOnInsert || {}));
  Object.assign(row, clone(update.$set || {}));
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
}

function rawCapability(suffix = "agent_chat", maxConcurrent = 3) {
  return {
    capability_id: `gulong_engine.${suffix}`, capability_version: "1.0.0", protocol_version: CAPABILITY_ORDER_PROTOCOL,
    installed: true, validated: true, enabled: true, sharing_opt_in: true, max_concurrent: maxConcurrent,
    validation: { tested_at: new Date(Date.now() - 1000).toISOString(), artifact_sha256: "A".repeat(64),
      contract_tests: suffix === "embedding" ? { exact_request: true, complete_response: true, exact_model_dimension: true }
        : suffix === "music" ? { music_generation: true, whole_audio_asr: true, exact_lyrics: true, exact_duration: true }
          : { exact_request: true, complete_response: true, tools: true, multimodal: true } },
    ...(suffix === "music" ? { asr_languages: ["zh", "en"] } : {}),
    models: suffix === "music" ? [{ id: "verified-music", max_duration_seconds: 300 }] : suffix === "embedding" ? [{ id: "verified-embedding", dimension: 8 }]
      : [{ id: "verified-chat", tools: true, multimodal: true }],
    default_model: suffix === "music" ? "verified-music" : suffix === "embedding" ? null : "verified-chat",
  };
}
function fullRequest() {
  return { model: "verified-chat", messages: [
    { role: "system", content: "完整保留所有消息与供应商字段" },
    { role: "user", content: [{ type: "text", text: "识别图片并调用工具" }, { type: "image_url", image_url: { url: "https://example.invalid/reference.png", detail: "high" } }] },
  ], tools: [{ type: "function", function: { name: "get_weather", description: "query", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  tool_choice: { type: "function", function: { name: "get_weather" } }, temperature: 0.23, stream: false,
  vendor_extension: { preserve: ["every", "field"], nested: { exact: true } } };
}
function parameters(suffix = "agent_chat") {
  return suffix === "music" ? { model: "verified-music", caption: "完整歌曲", lyrics: "第一句唱出黎明\n第二句穿越山岭\n尾声完整不能省略", seconds: 10, seed: 123 }
    : suffix === "embedding" ? { model: "verified-embedding", dimension: 8, request: { model: "verified-embedding", input: ["first", "last"], dimensions: 8, encoding_format: "float" } }
    : { model: "verified-chat", request: fullRequest() };
}

function completeResponse() {
  return { id: "chatcmpl-exact-response", object: "chat.completion", created: 1792267200, model: "verified-chat",
    choices: [{ index: 0, message: { role: "assistant", content: null,
      tool_calls: [{ id: "call-real-contract", type: "function", function: { name: "get_weather", arguments: '{"city":"昆明"}' } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 23, completion_tokens: 13, total_tokens: 36, prompt_tokens_details: { cached_tokens: 2 } },
    service_tier: "default", vendor_extension: { retained: true } };
}

function fixture({ physicalLimit = 3, capabilities = ["agent_chat"], requesterGroup = "group-a", nodeGroup = "group-a" } = {}) {
  const requester = { _id: new ObjectId(), status: "active", role: "user", email: "private-requester@example.invalid", computeGroupId: requesterGroup };
  const executor = { _id: new ObjectId(), status: "active", role: "user", computeGroupId: nodeGroup };
  const outsider = { _id: new ObjectId(), status: "active", role: "user", computeGroupId: "group-other" };
  const token = `gab_${"G".repeat(48)}`;
  const binding = { _id: new ObjectId(), userId: executor._id, nodeId: "verified-node-a", nodeName: "verified consumer", status: "active", revokedAt: null,
    tokenHash: hashOpaqueToken(token, "h3-account-binding"), computeGroupId: nodeGroup };
  const rawReports = capabilities.map((suffix) => rawCapability(suffix, physicalLimit));
  const rows = { users: [requester, executor, outsider], nodeAccountBindings: [binding], capabilityNodeReports: [], capabilityOrders: [],
    capabilityNodeSlots: [], capabilityConsumerAcceptances: [], capabilityConsumerAcceptanceAudits: [], capabilityOutputUploads: [], capabilityOrderCallbacks: [] };
  const publishedObjects = new Map();
  const hooks = { member: true, copies: [], downloadKeys: [], verifiedFlacKeys: [] };
  const getCollection = async (name) => {
    rows[name] ||= [];
    return {
      async findOne(query) { await Promise.resolve(); return clone(rows[name].find((row) => matches(row, query)) || null); },
      find(query) {
        let values = rows[name].filter((row) => matches(row, query));
        return { sort(order) { values.sort((a, b) => { for (const [key, direction] of Object.entries(order)) {
          if (primitive(a[key]) < primitive(b[key])) return -direction;
          if (primitive(a[key]) > primitive(b[key])) return direction;
        } return 0; }); return this; }, limit(count) { values = values.slice(0, count); return this; }, async toArray() {
          const snapshot = clone(values);
          if (name === "capabilityOrders" && query.claimLeaseUntil?.$lte && hooks.afterExpiredSnapshot) {
            const hook = hooks.afterExpiredSnapshot; hooks.afterExpiredSnapshot = null;
            await hook(snapshot);
          }
          return snapshot;
        } };
      },
      async countDocuments(query) { return rows[name].filter((row) => matches(row, query)).length; },
      async insertOne(row) {
        await Promise.resolve();
        if (rows[name].some((entry) => (row._id != null && equal(entry._id, row._id)) || (row.idempotencyKey && entry.idempotencyKey === row.idempotencyKey)
          || (name === "capabilityOrderCallbacks" && row.eventId && row.eventId === entry.eventId && equal(row.orderId, entry.orderId))
          || (name === "capabilityOutputUploads" && row.outputId && row.outputId === entry.outputId))) {
          throw Object.assign(new Error("duplicate unique key"), { code: 11000 });
        }
        rows[name].push(clone(row)); return { insertedId: row._id };
      },
      async updateOne(query, update, options = {}) {
        await Promise.resolve();
        if (name === "capabilityOrderCallbacks" && update.$set?.resultStatus === "completed" && hooks.failFinalCallbackWrite) {
          hooks.failFinalCallbackWrite = false; throw new Error("simulated completion receipt interruption");
        }
        const row = rows[name].find((entry) => matches(entry, query));
        if (row) { mutate(row, update); return { matchedCount: 1, modifiedCount: 1 }; }
        if (options.upsert) {
          const inserted = Object.fromEntries(Object.entries(query).filter(([, value]) => value === null || typeof value !== "object" || value instanceof ObjectId));
          if (inserted._id && rows[name].some((entry) => equal(entry._id, inserted._id))) throw Object.assign(new Error("upsert race"), { code: 11000 });
          mutate(inserted, update, true); rows[name].push(inserted); return { matchedCount: 0, upsertedId: inserted._id };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      },
      async updateMany(query, update) { const matching = rows[name].filter((row) => matches(row, query)); matching.forEach((row) => mutate(row, update)); return { modifiedCount: matching.length }; },
      async findOneAndUpdate(query, update) {
        await Promise.resolve();
        if (name === "capabilityOrders" && update.$set?.status === "completed" && hooks.failOrderCompletionWrite) {
          hooks.failOrderCompletionWrite = false; throw new Error("simulated task completion interruption");
        }
        const row = rows[name].find((entry) => matches(entry, query));
        if (!row) return null;
        mutate(row, update); return clone(row);
      },
    };
  };
  const app = new OpenAPIHono();
  app.onError((error, c) => c.json({ code: error.code || "TEST_INJECTED_FAILURE", message: error.message }, error.status || 500));
  registerCapabilityConsumerAcceptanceRoutes(app, { getCollection, requireAdmin: async () => ({ user: { id: String(requester._id), role: "admin" } }), requireTrustedMutation: () => null });
  registerCapabilityOrderRoutes(app, { getCollection, authenticate: async (c) => {
    const user = c.req.header("X-Test-Account") === "outsider" ? outsider : requester;
    return { user: { ...user, id: String(user._id) }, kind: "desktop-gulong-engine" };
  }, requireTrustedMutation: () => null, enforceRateLimit: async (key) => ({
    allowed: !(hooks.rejectMusicVerification && key.startsWith("capability-music-verify:")) && !(hooks.rejectCallback && key.startsWith("capability-callback:")),
  }),
  readGulongEngineEntitlement: async () => ({ active: hooks.member }), readEnglishEntitlement: async () => ({ active: true }),
  createPresignedDownloadUrl: (objectKey) => { hooks.downloadKeys.push(objectKey); return "https://cos.invalid/private-download"; }, createPresignedPutUrl: () => "https://cos.invalid/private-upload",
  headObject: async (objectKey) => {
    const grant = publishedObjects.get(objectKey) || rows.capabilityOutputUploads.find((entry) => entry.objectKey === objectKey);
    if (!grant) throw new Error("object not found in pure in-memory COS fixture");
    return { headers: { etag: hooks.noSourceEtag ? "" : '"fixture-original-etag"', "content-length": String(grant.bytes), "x-cos-meta-sha256": grant.sha256, "x-cos-meta-bytes": String(grant.bytes),
      "x-cos-meta-capability-order-id": String(grant.orderId), "x-cos-meta-capability-output-id": grant.outputId,
      "x-cos-meta-node-id-hash": createHash("sha256").update(binding.nodeId).digest("hex") } };
  },
  copyObject: async (sourceKey, destinationKey, options) => {
    if (hooks.copyNumericFailure) throw Object.assign(new Error("temporary object publication failure"), { code: 11000 });
    assert.equal(options?.sourceETag, '"fixture-original-etag"', "copy must fence the exact HEAD-validated source version");
    const grant = rows.capabilityOutputUploads.find((entry) => entry.objectKey === sourceKey);
    assert.ok(grant);
    assert.notEqual(destinationKey, sourceKey);
    assert.match(destinationKey, new RegExp(`^capability-orders/${grant.orderId}/published/`));
    publishedObjects.set(destinationKey, clone(grant));
    hooks.copies.push({ sourceKey, destinationKey, options: clone(options) });
    return { ETag: '"fixture-published-etag"' };
  },
  deleteObject: async (objectKey) => { publishedObjects.delete(objectKey); },
  verifyFlacObject: async (grant) => {
    assert.ok(publishedObjects.has(grant.objectKey), "FLAC inspection must read the immutable published copy, not a still-writable upload key");
    hooks.verifiedFlacKeys.push(grant.objectKey);
    return { bytes: grant.bytes, sha256: hooks.flacHashMismatch ? "F".repeat(64) : grant.sha256, durationSeconds: hooks.flacDuration ?? 10 };
  },
  });
  let sequence = 0;
  const call = async (path, body, headers = {}) => {
    const response = await app.request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: {
      "Content-Type": "application/json", "Idempotency-Key": `worklucky-integration-${++sequence}`, ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = { raw: text }; }
    return { status: response.status, body: value };
  };
  const claim = (extra = {}, headers = {}) => call("/api/v1/capability-orders/claim", {
    node_id: binding.nodeId, node_name: binding.nodeName, protocol_version: CAPABILITY_ORDER_PROTOCOL, capabilities: rawReports,
    resources: { max_concurrent_tasks: physicalLimit, running_task_count: 0, estimated_total_seconds: 0 }, ...extra,
  }, { "X-Gulong-Account-Binding": token, ...headers });
  const accept = async (targetBinding = binding, targetReports = rawReports) => {
    for (const report of targetReports) {
      const result = await call("/api/admin/capability-consumers/acceptances", {
        binding_id: String(targetBinding._id), capability_id: report.capability_id, capability_version: report.capability_version,
        artifact_sha256: report.validation.artifact_sha256, test_evidence_sha256: "B".repeat(64), tested_at: report.validation.tested_at,
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), models: report.models, default_model: report.default_model,
        contract_tests: report.validation.contract_tests, admin_confirmed_real_consumer: true,
        ...(report.asr_languages ? { asr_languages: report.asr_languages } : {}),
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      report.validation.acceptance_id = result.body.acceptance.id;
    }
  };
  const advertise = async () => {
    const result = await claim();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.task, null);
  };
  const create = (suffix = "agent_chat", headers = {}) => call("/api/v1/capability-orders", {
    client_product: "worklucky", source_channel: "desktop_agent", capability_id: `gulong_engine.${suffix}`,
    capability_version: "1.0.0", parameters: parameters(suffix),
  }, headers);
  const catalog = () => call("/api/v1/capability-orders/catalog?product=worklucky");
  const callback = (task, body) => call("/api/v1/capability-orders/callback", { order_id: task.id, claim_id: task.claim_id, ...body }, { "X-Gulong-Account-Binding": token });
  return { app, rows, hooks, requester, executor, outsider, binding, token, rawReports, getCollection, call, claim, accept, advertise, create, catalog, callback };
}

test("self-reported validation without administrator acceptance remains offline and cannot create an order", async () => {
  const f = fixture();
  await f.advertise();
  const catalog = await f.catalog();
  assert.equal(catalog.status, 200);
  const chat = catalog.body.capabilities.find((entry) => entry.capability_id === "gulong_engine.agent_chat");
  assert.equal(chat.dispatchable, false);
  assert.equal(chat.availability.status, "offline");
  assert.equal(chat.availability.verified_node_count, 0);
  const created = await f.create();
  assert.equal(created.status, 409);
  assert.equal(created.body.code, "CAPABILITY_NO_COMPATIBLE_NODE");
  assert.equal(f.rows.capabilityOrders.length, 0);
});

test("administrator-accepted exact tools and multimodal requests survive create and claim unchanged", async () => {
  const f = fixture();
  await f.accept(); await f.advertise();
  const catalog = await f.catalog();
  const chat = catalog.body.capabilities.find((entry) => entry.capability_id === "gulong_engine.agent_chat");
  assert.equal(chat.dispatchable, true);
  assert.equal(chat.availability.free_slot_count, 3);
  assert.deepEqual(chat.availability.models, [{ id: "verified-chat", tools: true, multimodal: true }]);
  const created = await f.create();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.order.billing.price_fen, 0);
  assert.deepEqual(f.rows.capabilityOrders[0].parameters.request, fullRequest());
  const claimed = await f.claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.deepEqual(claimed.body.task.parameters.request, fullRequest());
  assert.equal(claimed.body.task.id, created.body.order.id);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 1);
});

test("altered consumer artifacts, models and expired acceptances cannot admit tasks", async () => {
  for (const change of ["artifact", "model", "expiry"]) {
    const f = fixture();
    await f.accept();
    if (change === "artifact") f.rawReports[0].validation.artifact_sha256 = "C".repeat(64);
    if (change === "model") { f.rawReports[0].models[0].id = "unaccepted-model"; f.rawReports[0].default_model = "unaccepted-model"; }
    if (change === "expiry") f.rows.capabilityConsumerAcceptances[0].expiresAt = new Date(Date.now() - 1);
    await f.advertise();
    assert.equal((await f.create()).status, 409);
    assert.equal(f.rows.capabilityOrders.length, 0);
  }
});

test("account-binding authentication and current compute-group equality isolate the real claim route", async () => {
  const f = fixture();
  await f.accept(); await f.advertise();
  const created = await f.create(); assert.equal(created.status, 201);
  assert.equal((await f.claim({}, { "X-Gulong-Account-Binding": `gab_${"F".repeat(48)}` })).status, 401);
  assert.equal((await f.claim({ node_id: "other-node" })).status, 403);
  f.binding.computeGroupId = "other-group";
  const blocked = await f.claim();
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.task, null);
  assert.equal(f.rows.capabilityOrders[0].status, "queued");
  const crossAccount = await f.call(`/api/v1/capability-orders/${created.body.order.id}?product=worklucky`, undefined, { "X-Test-Account": "outsider" });
  assert.equal(crossAccount.status, 404);
  assert.equal(f.rows.capabilityNodeSlots.length, 0);
});

test("fifty concurrent real-route polls cannot reserve more physical slots than the node possesses", async () => {
  const f = fixture({ physicalLimit: 3 });
  await f.accept(); await f.advertise();
  for (let index = 0; index < 50; index += 1) assert.equal((await f.create()).status, 201);
  const responses = await Promise.all(Array.from({ length: 50 }, () => f.claim()));
  assert.ok(responses.every((result) => result.status === 200));
  let claimed = f.rows.capabilityOrders.filter((order) => order.status === "claimed");
  assert.ok(claimed.length > 0 && claimed.length <= 3);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, claimed.length);
  // Fill remaining actual slots after order-CAS race losers release their reservations.
  for (let index = 0; index < 3; index += 1) await f.claim();
  claimed = f.rows.capabilityOrders.filter((order) => order.status === "claimed");
  assert.equal(claimed.length, 3);
  assert.equal((await f.claim()).body.task, null);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 3);
  assert.equal(new Set(claimed.map((order) => order.claimId)).size, 3);
});

test("different accepted capabilities share one physical slot budget rather than multiplying capacity", async () => {
  const f = fixture({ physicalLimit: 2, capabilities: ["agent_chat", "embedding"] });
  await f.accept(); await f.advertise();
  for (const suffix of ["agent_chat", "embedding", "agent_chat", "embedding"]) assert.equal((await f.create(suffix)).status, 201);
  const first = await f.claim(); const second = await f.claim(); const third = await f.claim();
  assert.equal(first.body.task.capability_id, "gulong_engine.agent_chat");
  assert.equal(second.body.task.capability_id, "gulong_engine.embedding");
  assert.equal(third.body.task, null);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 2);
  assert.deepEqual(second.body.task.parameters, parameters("embedding"));
  const catalog = await f.catalog();
  for (const id of ["gulong_engine.agent_chat", "gulong_engine.embedding"]) {
    const availability = catalog.body.capabilities.find((entry) => entry.capability_id === id).availability;
    assert.equal(availability.free_slot_count, 0);
    assert.equal(availability.status, "busy");
  }
});

test("dry-run probes neither advertise new reports nor consume orders or node slots", async () => {
  const f = fixture();
  await f.accept(); await f.advertise();
  assert.equal((await f.create()).status, 201);
  const before = clone(f.rows);
  const result = await f.claim({ dry_run: true, node_name: "must-not-be-persisted", resources: { max_concurrent_tasks: 16, running_task_count: -20, estimated_total_seconds: -10 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.queue, "reachable");
  assert.deepEqual(f.rows, before);
});

test("worker claim DTO contains no requester, email, billing, wallet, acceptance or binding internals", async () => {
  const f = fixture();
  await f.accept(); await f.advertise();
  assert.equal((await f.create()).status, 201);
  f.rows.capabilityOrders[0].walletLedgerId = "private-ledger";
  f.rows.capabilityOrders[0].requesterEmail = f.requester.email;
  const result = await f.claim();
  assert.ok(result.body.task);
  const json = JSON.stringify(result.body.task);
  for (const secret of [f.requester.email, String(f.requester._id), "private-ledger", "tokenHash", "requester", "wallet", "billing", "bindingId", "acceptanceId", "testEvidenceSha256"]) {
    assert.equal(json.includes(secret), false, secret);
  }
  assert.deepEqual(Object.keys(result.body.task.assigned_node).sort(), ["node_id", "node_name"]);
});

test("progress renews only its execution lease and completed returns the entire unmodified OpenAI response", async () => {
  const f = fixture(); await f.accept(); await f.advertise(); await f.create();
  const task = (await f.claim()).body.task;
  const shortLease = new Date(Date.now() + 5000);
  f.rows.capabilityNodeSlots[0].leases[0].expiresAt = shortLease;
  f.rows.capabilityOrders[0].claimLeaseUntil = shortLease;
  const progress = await f.callback(task, { event_id: "progress-exact-0001", status: "started", estimated_total_seconds: 120, elapsed_seconds: 3, progress: 4 });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.equal(progress.body.order_status, "processing");
  assert.ok(f.rows.capabilityNodeSlots[0].leases[0].expiresAt > shortLease);
  assert.equal(f.rows.capabilityOrders[0].status, "processing");
  const result = { response: completeResponse() };
  const completed = await f.callback(task, { event_id: "completed-exact-0001", status: "completed", elapsed_seconds: 12, inline_result: result });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 0);
  const queried = await f.call(`/api/v1/capability-orders/${task.id}?product=worklucky`);
  assert.equal(queried.status, 200);
  assert.deepEqual(queried.body.order.inline_result, result);
});

test("identical completed callback replays once and a changed payload under the same event is rejected", async () => {
  const f = fixture(); await f.accept(); await f.advertise(); await f.create();
  const task = (await f.claim()).body.task;
  const payload = { event_id: "completed-replay-0001", status: "completed", inline_result: { response: completeResponse() } };
  assert.equal((await f.callback(task, payload)).status, 200);
  const original = clone(f.rows.capabilityOrders[0]);
  const replay = await f.callback(task, payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(f.rows.capabilityOrderCallbacks.length, 1);
  assert.deepEqual(f.rows.capabilityOrders[0], original);
  const conflict = await f.callback(task, { ...payload, elapsed_seconds: 999 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "CALLBACK_IDEMPOTENCY_CONFLICT");
  assert.deepEqual(f.rows.capabilityOrders[0], original);
});

test("replay repairs a processing callback receipt after order completion persisted and never loses the original result", async () => {
  const f = fixture(); await f.accept(); await f.advertise(); await f.create();
  const task = (await f.claim()).body.task;
  const payload = { event_id: "completed-postwrite-0001", status: "completed", inline_result: { response: completeResponse() } };
  f.hooks.failFinalCallbackWrite = true;
  assert.equal((await f.callback(task, payload)).status, 500);
  assert.equal(f.rows.capabilityOrders[0].status, "completed");
  assert.equal(f.rows.capabilityOrderCallbacks[0].resultStatus, "processing");
  const original = clone(f.rows.capabilityOrders[0].inlineResult);
  const repaired = await f.callback(task, payload);
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
  assert.equal(repaired.body.idempotent, true);
  assert.equal(repaired.body.order_status, "completed");
  assert.equal(f.rows.capabilityOrderCallbacks[0].resultStatus, "completed");
  assert.equal(f.rows.capabilityOrderCallbacks.length, 1);
  assert.deepEqual(f.rows.capabilityOrders[0].inlineResult, original);
});

test("replay safely resumes when the callback event was recorded but its order write failed", async () => {
  const f = fixture(); await f.accept(); await f.advertise(); await f.create();
  const task = (await f.claim()).body.task;
  const payload = { event_id: "completed-prewrite-0001", status: "completed", inline_result: { response: completeResponse() } };
  f.hooks.failOrderCompletionWrite = true;
  assert.equal((await f.callback(task, payload)).status, 500);
  assert.equal(f.rows.capabilityOrders[0].status, "claimed");
  assert.equal(f.rows.capabilityOrderCallbacks[0].resultStatus, "processing");
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 1);
  const recovered = await f.callback(task, payload);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(f.rows.capabilityOrders[0].status, "completed");
  assert.equal(f.rows.capabilityOrderCallbacks.length, 1);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 0);
});

test("requester cancellation holds capacity until a fenced worker confirms it has stopped", async () => {
  const f = fixture({ physicalLimit: 1 }); await f.accept(); await f.advertise(); await f.create(); await f.create();
  const task = (await f.claim()).body.task;
  const cancelled = await f.call(`/api/v1/capability-orders/${task.id}/cancel?product=worklucky`, { client_product: "worklucky" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.order.status, "cancelled");
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 1);
  assert.equal((await f.claim()).body.task, null);
  const state = await f.call(`/api/v1/capability-orders/${task.id}/worker-state?claim_id=${task.claim_id}`, undefined, { "X-Gulong-Account-Binding": f.token });
  assert.equal(state.body.should_stop, true);
  const stopped = await f.callback(task, { event_id: "worker-stopped-after-cancel-0001", status: "cancelled" });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 0);
  assert.ok((await f.claim()).body.task);
});

test("expired lease progress never revives the old claim or consumes a fresh order", async () => {
  const f = fixture({ physicalLimit: 1 }); await f.accept(); await f.advertise(); await f.create();
  const task = (await f.claim()).body.task;
  const expired = new Date(Date.now() - 1);
  f.rows.capabilityNodeSlots[0].leases[0].expiresAt = expired;
  f.rows.capabilityOrders[0].claimLeaseUntil = expired;
  const progress = await f.callback(task, { event_id: "late-progress-0001", status: "progress", estimated_total_seconds: 90, progress: 20 });
  assert.equal(progress.status, 409);
  assert.equal(progress.body.code, "CLAIM_LEASE_EXPIRED");
  assert.equal(+f.rows.capabilityNodeSlots[0].leases[0].expiresAt, +expired);
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
});

test("stale expired-order recovery cannot release a lease concurrently renewed by progress", async () => {
  const f = fixture({ physicalLimit: 1 }); await f.accept(); await f.advertise(); await f.create(); await f.create();
  const task = (await f.claim()).body.task;
  const order = f.rows.capabilityOrders.find((entry) => String(entry._id) === task.id);
  const oldDeadline = new Date(Date.now() - 1);
  order.status = "processing"; order.stage = "processing"; order.claimLeaseUntil = oldDeadline;
  f.rows.capabilityNodeSlots[0].leases[0].expiresAt = oldDeadline;
  const renewedDeadline = new Date(Date.now() + 300_000);
  f.hooks.afterExpiredSnapshot = async (stale) => {
    assert.equal(stale.length, 1);
    assert.equal(+stale[0].claimLeaseUntil, +oldDeadline);
    // Model a progress request already admitted before deadline: its writes land
    // after the maintenance read, but before maintenance's compare-and-swap.
    order.claimLeaseUntil = renewedDeadline;
    order.progress = 37;
    f.rows.capabilityNodeSlots[0].leases[0].expiresAt = renewedDeadline;
  };
  const queried = await f.call(`/api/v1/capability-orders/${task.id}?product=worklucky`);
  assert.equal(queried.status, 200, JSON.stringify(queried.body));
  assert.equal(queried.body.order.status, "processing");
  assert.equal(queried.body.order.progress, 37);
  assert.equal(order.claimId, task.claim_id);
  assert.equal(+order.claimLeaseUntil, +renewedDeadline);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 1);
  assert.equal(f.rows.capabilityNodeSlots[0].leases[0].taskId, task.id);
  assert.equal(+f.rows.capabilityNodeSlots[0].leases[0].expiresAt, +renewedDeadline);
  assert.equal((await f.claim()).body.task, null);
});

test("an acknowledged failed execution releases only its fenced slot", async () => {
  const f = fixture({ physicalLimit: 2 }); await f.accept(); await f.advertise(); await f.create(); await f.create();
  const first = (await f.claim()).body.task; const second = (await f.claim()).body.task;
  const failed = await f.callback(first, { event_id: "failed-release-0001", status: "failed", retryable: false, error_message: "节点推理失败且已停止" });
  assert.equal(failed.status, 200);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 1);
  assert.equal(f.rows.capabilityNodeSlots[0].leases[0].taskId, second.id);
});

test("cancelled capacity eventually expires without requiring an offline worker acknowledgement", async () => {
  const f = fixture({ physicalLimit: 1 }); await f.accept(); await f.advertise(); await f.create(); await f.create();
  const task = (await f.claim()).body.task;
  const cancelled = await f.call(`/api/v1/capability-orders/${task.id}/cancel?product=worklucky`, { client_product: "worklucky" });
  assert.equal(cancelled.status, 200);
  assert.equal((await f.claim()).body.task, null);
  f.rows.capabilityNodeSlots[0].leases[0].expiresAt = new Date(Date.now() - 1);
  const next = await f.claim();
  assert.equal(next.status, 200);
  assert.ok(next.body.task);
  assert.notEqual(next.body.task.id, task.id);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 1);
  assert.equal(f.rows.capabilityNodeSlots[0].leases[0].taskId, next.body.task.id);
});

test("retryable stopped execution frees its lease without changing another order or duplicating admission", async () => {
  const f = fixture({ physicalLimit: 1 }); await f.accept(); await f.advertise(); await f.create(); await f.create();
  const task = (await f.claim()).body.task;
  const failed = await f.callback(task, { event_id: "retryable-stopped-0001", status: "failed", retryable: true, retry_after_seconds: 60, error_message: "已停止，等待重试" });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.retry_scheduled, true);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 0);
  const next = await f.claim();
  assert.ok(next.body.task);
  assert.notEqual(next.body.task.id, task.id);
  assert.equal(f.rows.capabilityOrders.find((order) => String(order._id) === task.id).status, "queued");
  assert.equal(f.rows.capabilityOrders.length, 2);
});

test("embedding callback preserves full ordered vectors, exact dimensions and usage", async () => {
  const f = fixture({ capabilities: ["embedding"] }); await f.accept(); await f.advertise(); await f.create("embedding");
  const task = (await f.claim()).body.task;
  const response = { object: "list", model: "verified-embedding", data: [
    { object: "embedding", index: 0, embedding: [0, 1, 2, 3, 4, 5, 6, 7] },
    { object: "embedding", index: 1, embedding: [7, 6, 5, 4, 3, 2, 1, 0] },
  ], usage: { prompt_tokens: 7, total_tokens: 7 }, vendor_extension: { kept: "whole response" } };
  const payload = { event_id: "embedding-response-0001", status: "completed", inline_result: { response } };
  const wrongDimension = clone(payload); wrongDimension.inline_result.response.data[1].embedding.pop();
  assert.equal((await f.callback(task, wrongDimension)).status, 409);
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
  assert.equal((await f.callback(task, payload)).status, 200);
  assert.deepEqual(f.rows.capabilityOrders[0].inlineResult.response, response);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 0);
});

test("membership expiring after accepted zero-price admission does not block completion or create any accounting", async () => {
  const f = fixture(); await f.accept(); await f.advertise(); await f.create();
  const task = (await f.claim()).body.task;
  f.hooks.member = false;
  const result = await f.callback(task, { event_id: "completed-after-membership-0001", status: "completed", inline_result: { response: completeResponse() } });
  assert.equal(result.status, 200);
  assert.equal(f.rows.capabilityOrders[0].priceFen, 0);
  assert.equal(f.rows.capabilityOrders[0].chargeStatus, "exempt");
  for (const collection of ["wallets", "walletLedgers", "walletTransactions", "nodeSettlements"]) assert.deepEqual(f.rows[collection] || [], []);
});

function oversizedChunkedCallbackRequest(bindingToken) {
  let pullCount = 0;
  let cancelled = false;
  let paddingLeft = 4 * 1024 * 1024 + 128 * 1024 + 1024;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) { controller.enqueue(encoder.encode('{"padding":"')); return; }
      if (paddingLeft > 0) {
        const size = Math.min(64 * 1024, paddingLeft);
        controller.enqueue(new Uint8Array(size).fill(0x78)); paddingLeft -= size; return;
      }
      controller.enqueue(encoder.encode('"}')); controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request("http://localhost/api/v1/capability-orders/callback", { method: "POST", headers: {
    "Content-Type": "application/json", ...(bindingToken ? { "X-Gulong-Account-Binding": bindingToken } : {}),
  }, body: stream, duplex: "half" });
  return { request, pullCount: () => pullCount, cancelled: () => cancelled };
}

test("authenticated chunked callback without content-length is bounded and cancelled at 413", async () => {
  const f = fixture();
  const chunked = oversizedChunkedCallbackRequest(f.token);
  assert.equal(chunked.request.headers.has("content-length"), false);
  const response = await f.app.request(chunked.request);
  const result = await response.json();
  assert.equal(response.status, 413, JSON.stringify(result));
  assert.equal(result.code, "REQUEST_TOO_LARGE");
  assert.ok(chunked.pullCount() > 1);
  assert.equal(chunked.cancelled(), true);
  assert.equal(f.rows.capabilityOrders.length, 0);
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
  assert.equal(f.rows.capabilityNodeSlots.length, 0);
});

test("anonymous oversized callback fails authentication before its stream is consumed", async () => {
  const f = fixture();
  const chunked = oversizedChunkedCallbackRequest();
  const response = await f.app.request(chunked.request);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "ACCOUNT_BINDING_REQUIRED");
  assert.equal(chunked.pullCount(), 0);
  assert.equal(f.rows.capabilityOrders.length, 0);
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
});

test("music admission honors the accepted model maximum without silently shortening requested seconds", async () => {
  const f = fixture({ capabilities: ["music"] }); await f.accept(); await f.advertise();
  const catalog = await f.catalog();
  const music = catalog.body.capabilities.find((entry) => entry.capability_id === "gulong_engine.music");
  assert.deepEqual(music.availability.models, [{ id: "verified-music", max_duration_seconds: 300 }]);
  const createDuration = (seconds) => f.call("/api/v1/capability-orders", {
    client_product: "worklucky", source_channel: "desktop_agent", capability_id: "gulong_engine.music", capability_version: "1.0.0",
    parameters: { ...parameters("music"), seconds },
  });
  for (const seconds of [301, 600]) {
    const rejected = await createDuration(seconds);
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, "CAPABILITY_NO_COMPATIBLE_NODE");
    assert.equal(f.rows.capabilityOrders.length, 0);
  }
  const created = await createDuration(300);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(f.rows.capabilityOrders[0].parameters.seconds, 300);
  const claimed = await f.claim();
  assert.equal(claimed.body.task.id, created.body.order.id);
  assert.equal(claimed.body.task.parameters.seconds, 300);
});

test("a legacy queued 600-second music order remains queued until an accepted 600-second consumer claims it", async () => {
  const f = fixture({ capabilities: ["music"] }); await f.accept(); await f.advertise();
  const created = await f.create("music"); assert.equal(created.status, 201);
  // Model an old stored order admitted before per-model duration limits existed.
  f.rows.capabilityOrders[0].parameters.seconds = 600;
  const unavailable = await f.claim();
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.body.task, null);
  assert.equal(f.rows.capabilityOrders[0].status, "queued");
  assert.equal(f.rows.capabilityNodeSlots.length, 0);
  const token600 = `gab_${"J".repeat(48)}`;
  const node600 = { _id: new ObjectId(), userId: f.executor._id, nodeId: "verified-music-600-node", nodeName: "accepted 600-second consumer",
    status: "active", revokedAt: null, computeGroupId: f.binding.computeGroupId, tokenHash: hashOpaqueToken(token600, "h3-account-binding") };
  f.rows.nodeAccountBindings.push(node600);
  const capability600 = rawCapability("music"); capability600.models[0].max_duration_seconds = 600;
  await f.accept(node600, [capability600]);
  const claimed = await f.call("/api/v1/capability-orders/claim", {
    node_id: node600.nodeId, node_name: node600.nodeName, protocol_version: CAPABILITY_ORDER_PROTOCOL, capabilities: [capability600],
    resources: { max_concurrent_tasks: 1, running_task_count: 0, estimated_total_seconds: 0 },
  }, { "X-Gulong-Account-Binding": token600 });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.id, created.body.order.id);
  assert.equal(claimed.body.task.parameters.seconds, 600);
  assert.equal(claimed.body.task.assigned_node.node_id, node600.nodeId);
});

test("music completion binds full lyrics ASR to actual validated FLAC output and a stable upload receipt", async () => {
  const f = fixture({ capabilities: ["music"] }); await f.accept(); await f.advertise(); await f.create("music");
  const task = (await f.claim()).body.task;
  const manifest = { claim_id: task.claim_id, role: "primary_audio", filename: "whole-song.flac", content_type: "audio/flac", bytes: 4096, sha256: "D".repeat(64) };
  const granted = await f.call(`/api/v1/capability-orders/${task.id}/outputs/presign`, manifest, { "X-Gulong-Account-Binding": f.token });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  const repeatGrant = await f.call(`/api/v1/capability-orders/${task.id}/outputs/presign`, manifest, { "X-Gulong-Account-Binding": f.token });
  assert.equal(repeatGrant.status, 200);
  assert.equal(repeatGrant.body.output_id, granted.body.output_id);
  assert.equal(f.rows.capabilityOutputUploads.length, 1);
  const changedManifest = await f.call(`/api/v1/capability-orders/${task.id}/outputs/presign`, { ...manifest, bytes: manifest.bytes + 1 }, { "X-Gulong-Account-Binding": f.token });
  assert.equal(changedManifest.status, 409);
  assert.equal(changedManifest.body.code, "OUTPUT_IDEMPOTENCY_CONFLICT");
  assert.equal(f.rows.capabilityOutputUploads.length, 1);
  const verification = { algorithm: "ordered-whole-lyrics-v1", full_audio: true, language: "zh", audio_sha256: manifest.sha256,
    lyrics_sha256: createHash("sha256").update(task.parameters.lyrics).digest("hex"), transcript: task.parameters.lyrics };
  const callback = { event_id: "music-whole-result-0001", status: "completed", outputs: [{ output_id: granted.body.output_id }], inline_result: { lyric_verification: verification } };
  f.hooks.rejectMusicVerification = true;
  for (let retry = 0; retry < 2; retry += 1) {
    const limited = await f.callback(task, callback);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "RATE_LIMITED");
  }
  assert.equal(f.hooks.copies.length, 0);
  assert.equal(f.rows.capabilityOrders[0].status, "claimed");
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
  f.hooks.rejectMusicVerification = false;
  f.hooks.noSourceEtag = true;
  const missingVersion = await f.callback(task, callback);
  assert.equal(missingVersion.status, 409);
  assert.equal(missingVersion.body.code, "OUTPUT_ETAG_REQUIRED");
  assert.equal(f.hooks.copies.length, 0);
  f.hooks.noSourceEtag = false;
  f.hooks.copyNumericFailure = true;
  const unavailablePublication = await f.callback(task, callback);
  assert.equal(unavailablePublication.status, 503, JSON.stringify(unavailablePublication.body));
  assert.equal(unavailablePublication.body.code, "OUTPUT_VERIFICATION_UNAVAILABLE");
  assert.equal(f.rows.capabilityOrders[0].status, "claimed");
  assert.equal(f.rows.capabilityOrderCallbacks.length, 0);
  f.hooks.copyNumericFailure = false;
  f.hooks.flacHashMismatch = true;
  const wrongHash = await f.callback(task, callback);
  assert.equal(wrongHash.status, 409, JSON.stringify(wrongHash.body));
  assert.equal(wrongHash.body.code, "OUTPUT_CONTENT_HASH_MISMATCH");
  f.hooks.flacHashMismatch = false;
  f.hooks.flacDuration = 11;
  const wrongDuration = await f.callback(task, callback);
  assert.equal(wrongDuration.status, 409, JSON.stringify(wrongDuration.body));
  assert.equal(wrongDuration.body.code, "MUSIC_OUTPUT_RECEIPT_MISMATCH");
  // music/v1 seconds is the requested maximum; keep the actual shorter duration.
  f.hooks.flacDuration = 9;
  const missingTail = await f.callback(task, { ...callback, inline_result: { lyric_verification: { ...verification, transcript: "第一句唱出黎明\n第二句穿越山岭" } } });
  assert.equal(missingTail.status, 409);
  assert.equal(missingTail.body.code, "MUSIC_WHOLE_LYRICS_MISMATCH");
  const complete = await f.callback(task, callback);
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal(f.rows.capabilityOrders[0].outputs[0].durationSeconds, 9);
  const retainedKey = f.rows.capabilityOrders[0].outputs[0].objectKey;
  assert.notEqual(retainedKey, granted.body.object_key);
  assert.match(retainedKey, /\/published\//);
  assert.ok(f.hooks.copies.some((entry) => entry.destinationKey === retainedKey && entry.sourceKey === granted.body.object_key));
  assert.equal(new Set(f.hooks.copies.map((entry) => entry.destinationKey)).size, f.hooks.copies.length,
    "each validation attempt needs an isolated publication key, not a concurrently overwriteable shared destination");
  assert.equal(f.rows.capabilityOutputCopies.find((entry) => entry.objectKey === retainedKey)?.status, "retained");
  assert.ok(f.hooks.verifiedFlacKeys.includes(retainedKey));
  await f.call(`/api/v1/capability-orders/${task.id}?product=worklucky`);
  assert.ok(f.hooks.downloadKeys.includes(retainedKey));
  assert.equal(f.hooks.downloadKeys.includes(granted.body.object_key), false);
  assert.deepEqual(f.rows.capabilityOrders[0].inlineResult.lyric_verification, verification);
  assert.equal(f.rows.capabilityNodeSlots[0].leases.length, 0);
});
