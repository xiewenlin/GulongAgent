import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { findTrustedConsumerAcceptance, registerCapabilityConsumerAcceptanceRoutes } from "../../server/capability-consumer-acceptance.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const BINDING = new ObjectId();
const USER = new ObjectId();
const BASE = "/api/admin/capability-consumers/acceptances";
const BINDINGS = "/api/admin/capability-consumers/bindings";
const eq = (left, right) => left instanceof Date || right instanceof Date ? +new Date(left) === +new Date(right) : String(left) === String(right);
const matches = (record, query) => Object.entries(query).every(([key, value]) => {
  if (key === "$or") return value.some((entry) => matches(record, entry));
  if (value && typeof value === "object" && "$regex" in value) return typeof record[key] === "string" && new RegExp(value.$regex, value.$options || "").test(record[key]);
  return value === null ? record[key] == null : eq(record[key], value);
});
function clone(value) {
  if (value instanceof ObjectId) return new ObjectId(value);
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
}

function payload(capability = "agent_chat", extra = {}) {
  return {
    binding_id: String(BINDING), capability_id: `gulong_engine.${capability}`, capability_version: "1.0.0",
    artifact_sha256: "a".repeat(64), test_evidence_sha256: "b".repeat(64),
    tested_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 7 * 86400_000).toISOString(), admin_confirmed_real_consumer: true,
    ...(capability === "agent_chat" ? { models: [{ id: "exact-chat-model", tools: true, multimodal: false }], default_model: "exact-chat-model",
      contract_tests: { exact_request: true, complete_response: true, tools: true } }
      : capability === "embedding" ? { models: [{ id: "exact-vector-model", dimension: 1024 }], default_model: null,
        contract_tests: { exact_request: true, complete_response: true, exact_model_dimension: true } }
        : { models: [{ id: "exact-music-model", max_duration_seconds: 300 }], default_model: "exact-music-model", asr_languages: ["zh", "en"],
          contract_tests: { music_generation: true, whole_audio_asr: true, exact_lyrics: true, exact_duration: true } }),
    ...extra,
  };
}

function report(input, acceptanceId) {
  return { capabilityId: input.capability_id, capabilityVersion: input.capability_version, models: clone(input.models),
    defaultModel: input.default_model ?? null, contractTests: clone(input.contract_tests), asrLanguages: input.asr_languages || [],
    validation: { artifactSha256: input.artifact_sha256, acceptanceId } };
}

function fixture({ auditFails = false, activationFails = false } = {}) {
  const rows = { nodeAccountBindings: [{ _id: BINDING, userId: USER, nodeId: "node-one", status: "active", revokedAt: null }] };
  const hooks = { admin: true, authenticated: true, trusted: true };
  const getCollection = async (name) => {
    rows[name] ||= [];
    return {
      async findOne(query) { return clone(rows[name].find((record) => matches(record, query)) || null); },
      find(query, options) {
        if (name === "nodeAccountBindings") hooks.bindingProjection = clone(options?.projection);
        let values = rows[name].filter((record) => matches(record, query));
        return { sort(order) { values.sort((a, b) => { for (const [key, direction] of Object.entries(order)) {
          const left = a[key] instanceof ObjectId ? String(a[key]) : a[key];
          const right = b[key] instanceof ObjectId ? String(b[key]) : b[key];
          if (left < right) return -direction;
          if (left > right) return direction;
        } return 0; }); return this; }, limit(count) { values = values.slice(0, count); return this; }, async toArray() { return clone(values); } };
      },
      async insertOne(record) {
        if (auditFails && name === "capabilityConsumerAcceptanceAudits") throw new Error("audit storage unavailable");
        rows[name].push(clone(record)); return { insertedId: record._id };
      },
      async findOneAndUpdate(query, update) {
        if (activationFails) return null;
        const current = rows[name].find((record) => matches(record, query));
        if (!current) return null;
        Object.assign(current, clone(update.$set)); return clone(current);
      },
    };
  };
  const app = new OpenAPIHono();
  registerCapabilityConsumerAcceptanceRoutes(app, { getCollection, now: () => NOW,
    requireAdmin: async (c) => !hooks.authenticated ? { error: c.json({ code: "UNAUTHORIZED", message: "请登录" }, 401) }
      : !hooks.admin ? { error: c.json({ code: "FORBIDDEN", message: "仅管理员可操作" }, 403) } : { user: { id: String(USER), role: "admin" } },
    requireTrustedMutation: (c) => hooks.trusted ? null : c.json({ code: "ORIGIN_REJECTED", message: "来源不受信任" }, 403),
  });
  const call = async (body, suffix = "") => {
    const response = await app.request(`http://localhost${BASE}${suffix}`, { method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { rows, hooks, getCollection, call, app };
}

async function readBindings(f, suffix = "") {
  const response = await f.app.request(`http://localhost${BINDINGS}${suffix}`);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("acceptance creation and listing always require administrator authentication and mutation origin", async () => {
  const f = fixture();
  f.hooks.authenticated = false;
  assert.equal((await f.call()).status, 401);
  assert.equal((await f.call(payload())).status, 401);
  f.hooks.authenticated = true; f.hooks.admin = false;
  assert.equal((await f.call()).status, 403);
  assert.equal((await f.call(payload())).status, 403);
  f.hooks.admin = true; f.hooks.trusted = false;
  assert.equal((await f.call(payload())).status, 403);
  assert.equal(f.rows.capabilityConsumerAcceptances, undefined);
});

test("only explicit administrator confirmation creates a versioned auditable acceptance", async () => {
  const f = fixture();
  assert.equal((await f.call(payload("agent_chat", { admin_confirmed_real_consumer: false }))).status, 400);
  const input = payload();
  const result = await f.call(input);
  assert.equal(result.status, 201);
  assert.match(result.body.acceptance.id, /^gca_[a-f0-9-]{36}$/);
  assert.equal(result.body.acceptance.status, "active");
  assert.equal(result.body.acceptance.effective_status, "active");
  assert.equal(result.headers.get("Cache-Control"), "private, no-store");
  assert.equal(f.rows.capabilityConsumerAcceptanceAudits.length, 1);
  assert.equal(f.rows.capabilityConsumerAcceptanceAudits[0].actorUserId, String(USER));
  const accepted = await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: report(input, result.body.acceptance.id), now: NOW });
  assert.ok(accepted);
  assert.equal(accepted.testEvidenceSha256, "B".repeat(64));
});

test("self-reported validation and forged acceptance IDs cannot open a consumer", async () => {
  const f = fixture();
  const input = payload();
  const fake = report(input, "gca_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: fake, now: NOW }), null);
  delete fake.validation.acceptanceId;
  fake.validated = true;
  assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: fake, now: NOW }), null);
});

test("binding, version, artifact, model matrix, defaults and feature contract must match exactly", async () => {
  const f = fixture();
  const input = payload();
  const created = await f.call(input);
  const correct = report(input, created.body.acceptance.id);
  const differences = [
    { capabilityVersion: "2.0.0" }, { capabilityId: "gulong_engine.embedding" },
    { validation: { ...correct.validation, artifactSha256: "c".repeat(64) } },
    { models: [{ id: "substituted-model", tools: true, multimodal: false }], defaultModel: "substituted-model" },
    { models: [{ id: "exact-chat-model", tools: false, multimodal: false }] },
    { contractTests: { ...correct.contractTests, multimodal: true } }, { defaultModel: "unaccepted-default" },
  ];
  for (const difference of differences) assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection,
    bindingId: BINDING, report: { ...correct, ...difference }, now: NOW }), null);
  assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: new ObjectId(), report: correct, now: NOW }), null);
});

test("vector dimensions and music whole-audio ASR language attestations are exact, not booleans", async () => {
  const f = fixture();
  for (const capability of ["embedding", "music"]) {
    const input = payload(capability);
    const created = await f.call(input);
    assert.equal(created.status, 201);
    const correct = report(input, created.body.acceptance.id);
    assert.ok(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: correct, now: NOW }));
    const changed = capability === "embedding" ? { ...correct, models: [{ id: input.models[0].id, dimension: 768 }] }
      : { ...correct, asrLanguages: ["en"] };
    assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: changed, now: NOW }), null);
    if (capability === "music") {
      const overstatedLimit = { ...correct, models: [{ ...correct.models[0], max_duration_seconds: 600 }] };
      assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: overstatedLimit, now: NOW }), null);
      const reducedLimit = { ...correct, models: [{ ...correct.models[0], max_duration_seconds: 299 }] };
      assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: reducedLimit, now: NOW }), null);
    }
  }
  const missingProof = payload("music"); delete missingProof.contract_tests.whole_audio_asr;
  assert.equal((await f.call(missingProof)).status, 409);
});

test("expiry, revocation and the thirty-day maximum remain authoritative", async () => {
  const f = fixture();
  for (const extra of [
    { tested_at: new Date(NOW.getTime() + 1).toISOString() },
    { tested_at: new Date(NOW.getTime() - 31 * 86400_000).toISOString() },
    { expires_at: new Date(NOW.getTime() + 30 * 86400_000 + 1).toISOString() }, { expires_at: NOW.toISOString() },
  ]) assert.equal((await f.call(payload("agent_chat", extra))).status, 400);
  const input = payload();
  const created = await f.call(input);
  const correct = report(input, created.body.acceptance.id);
  assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: correct, now: new Date(input.expires_at) }), null);
  f.rows.capabilityConsumerAcceptances[0].status = "revoked";
  assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: correct, now: NOW }), null);
});

test("unknown fields, wrong model schemas, unsupported capabilities and oversize payloads are rejected", async () => {
  const f = fixture();
  for (const input of [payload("agent_chat", { extra: "untrusted" }), payload("agent_chat", { capability_id: "gulong_engine.video" }),
    payload("agent_chat", { capability_version: "latest" }), payload("agent_chat", { models: [{ id: "model", tools: true, multimodal: false, dimension: 768 }] }),
    payload("embedding", { models: [{ id: "model", dimension: -1 }] }), payload("music", { asr_languages: ["auto"] }),
    payload("music", { models: [{ id: "model" }] }), payload("music", { models: [{ id: "model", max_duration_seconds: 0 }] }),
    payload("music", { models: [{ id: "model", max_duration_seconds: 601 }] }),
    payload("agent_chat", { contract_tests: { exact_request: true, complete_response: true, fabricated_proof: true } }),
  ]) assert.equal((await f.call(input)).status, 400);
  assert.equal((await f.call(payload("agent_chat", { padding: "X".repeat(65 * 1024) }))).status, 413);
  assert.equal((await f.call(undefined, "?limit=101")).status, 400);
});

test("a revoked or absent account binding cannot be granted a live acceptance", async () => {
  const f = fixture();
  f.rows.nodeAccountBindings[0].status = "revoked";
  assert.equal((await f.call(payload())).status, 409);
  assert.equal((await f.call(payload("agent_chat", { binding_id: String(new ObjectId()) }))).status, 409);
});

test("audit or activation storage failure never leaves an active admissible acceptance", async () => {
  for (const mode of [{ auditFails: true }, { activationFails: true }]) {
    const f = fixture(mode);
    const input = payload();
    const result = await f.call(input);
    assert.equal(result.status, 503);
    const record = f.rows.capabilityConsumerAcceptances[0];
    assert.equal(record.status, "pending_audit");
    assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING,
      report: report(input, record._id), now: NOW }), null);
  }
});

test("administrator list filters without exposing binding tokens and registers both OpenAPI paths", async () => {
  const f = fixture();
  await f.call(payload()); await f.call(payload("embedding"));
  const result = await f.call(undefined, "?capability_id=gulong_engine.embedding&status=active&limit=1");
  assert.equal(result.status, 200);
  assert.equal(result.body.acceptances.length, 1);
  assert.equal(result.body.acceptances[0].capability_id, "gulong_engine.embedding");
  assert.equal(JSON.stringify(result.body).includes("tokenHash"), false);
  const paths = f.app.openAPIRegistry.definitions.filter((entry) => entry.type === "route").map((entry) => entry.route);
  assert.ok(paths.some((entry) => entry.path === BASE && entry.method === "get"));
  assert.ok(paths.some((entry) => entry.path === BASE && entry.method === "post"));
});

test("binding lookup remains administrator-only, read-only and uncached", async () => {
  const f = fixture();
  f.hooks.authenticated = false;
  let result = await readBindings(f);
  assert.equal(result.status, 401);
  assert.equal(result.headers.get("Cache-Control"), "private, no-store");
  f.hooks.authenticated = true; f.hooks.admin = false;
  assert.equal((await readBindings(f)).status, 403);
  f.hooks.admin = true; f.hooks.trusted = false;
  const before = clone(f.rows);
  result = await readBindings(f);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(f.rows, before);
});

test("binding lookup returns only five safe fields and excludes inactive or revoked records", async () => {
  const f = fixture();
  Object.assign(f.rows.nodeAccountBindings[0], { nodeName: "摄影节点", computeGroupId: "group-a", tokenHash: "fake-test-token-hash",
    emailSnapshot: "private@example.invalid", credential: "fake-test-credential", updatedAt: NOW });
  f.rows.nodeAccountBindings.push(
    { _id: new ObjectId(), userId: USER, nodeId: "revoked-node", status: "revoked", revokedAt: null, updatedAt: NOW },
    { _id: new ObjectId(), userId: USER, nodeId: "revoked-with-active-status", status: "active", revokedAt: NOW, updatedAt: NOW },
  );
  const result = await readBindings(f);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.bindings, [{ binding_id: String(BINDING), node_id: "node-one", node_name: "摄影节点", user_id: String(USER), compute_group_id: "group-a" }]);
  const json = JSON.stringify(result.body);
  for (const forbidden of ["tokenHash", "emailSnapshot", "credential", "fake-test", "private@example.invalid"]) assert.equal(json.includes(forbidden), false);
  assert.deepEqual(Object.keys(f.hooks.bindingProjection).sort(), ["_id", "computeGroupId", "deviceName", "nodeId", "nodeName", "updatedAt", "userId"].sort());
});

test("binding lookup supports exact node IDs and literal fuzzy node-name, device-name and ID searches", async () => {
  const f = fixture();
  Object.assign(f.rows.nodeAccountBindings[0], { nodeName: "摄影.*节点", deviceName: "工作站甲", updatedAt: NOW });
  f.rows.nodeAccountBindings.push({ _id: new ObjectId(), userId: USER, nodeId: "OTHER-NODE-ID", nodeName: "other workstation", deviceName: "工作站乙", status: "active", revokedAt: null, updatedAt: new Date(+NOW - 1) });
  assert.equal((await readBindings(f, "?node_id=node-one")).body.bindings.length, 1);
  assert.equal((await readBindings(f, "?node_id=NODE-ONE")).body.bindings.length, 0);
  assert.equal((await readBindings(f, `?q=${encodeURIComponent("摄影")}`)).body.bindings[0].node_id, "node-one");
  assert.equal((await readBindings(f, `?q=${encodeURIComponent("工作站乙")}`)).body.bindings[0].node_id, "OTHER-NODE-ID");
  assert.equal((await readBindings(f, "?q=other-node")).body.bindings[0].node_id, "OTHER-NODE-ID");
  assert.equal((await readBindings(f, "?q=.*")).body.bindings.length, 1, "regex syntax must be searched literally, not executed");
  assert.equal((await readBindings(f, `?node_id=node-one&q=${encodeURIComponent("乙")}`)).body.bindings.length, 0);
});

test("binding lookup enforces strict bounded queries and newest-first fifty-record output", async () => {
  const f = fixture();
  f.rows.nodeAccountBindings = Array.from({ length: 75 }, (_, index) => ({ _id: new ObjectId(), userId: USER,
    nodeId: `node-${index}`, deviceName: `设备${index}`, status: "active", revokedAt: null, updatedAt: new Date(+NOW + index) }));
  const result = await readBindings(f);
  assert.equal(result.body.bindings.length, 50);
  assert.equal(result.body.bindings[0].node_id, "node-74");
  assert.equal(result.body.bindings.at(-1).node_id, "node-25");
  assert.equal(result.body.bindings[0].node_name, "设备74");
  assert.equal(result.body.bindings[0].compute_group_id, null);
  assert.equal((await readBindings(f, "?limit=7")).body.bindings.length, 7);
  for (const query of ["?limit=51", "?limit=0", "?limit=1.5", "?unknown=value", "?node_id[$ne]=anything", "?q=one&q=two",
    "?node_id=one&node_id=two", "?q=%20", "?q=%00", "?node_id=bad%20id", `?q=${"x".repeat(101)}`, `?node_id=${"x".repeat(257)}`]) {
    assert.equal((await readBindings(f, query)).status, 400, query);
  }
  const document = f.app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  const route = document.paths[BINDINGS].get;
  assert.ok(route);
  assert.deepEqual(route.security, [{ sessionCookie: [] }]);
  assert.equal(route.parameters.find((entry) => entry.name === "limit").schema.maximum, 50);
  assert.equal(route.responses[200].content["application/json"].schema.properties.bindings.items.properties.user_id.type.includes("string"), true);
});

test("deployed route captures do not become binding-search or acceptance-list filters", async () => {
  const f = fixture();
  const nodeId = "85254b9d69e4e3307049020c58bab89f2edae70a50817c37ca561194105512d1";
  f.rows.nodeAccountBindings[0].nodeId = nodeId;
  const route = "admin/capability-consumers/bindings";
  for (const capture of [`_platform_path=${route}`, "path=bindings", `route=${route}`, "route=admin&route=capability-consumers&route=bindings"]) {
    for (const filter of [`node_id=${nodeId}`, `q=${nodeId}`]) {
      const result = await readBindings(f, `?${filter}&${capture}`);
      assert.equal(result.status, 200, capture);
      assert.equal(result.body.bindings[0].binding_id, String(BINDING));
    }
  }
  await f.call(payload());
  const listed = await f.call(undefined, `?binding_id=${BINDING}&_platform_path=admin/capability-consumers/acceptances&path=acceptances`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.acceptances.length, 1);
  for (const capture of ["path=other", "route=other", "_platform_path=admin/users", "path=bindings&path=bindings", `q=${nodeId}&q=other`]) {
    assert.equal((await readBindings(f, `?node_id=${nodeId}&${capture}`)).status, 400, capture);
  }
  assert.equal((await f.call(undefined, `?binding_id=${BINDING}&binding_id=${BINDING}`)).status, 400);
  f.hooks.admin = false;
  assert.equal((await readBindings(f, `?node_id=${nodeId}&path=bindings`)).status, 403);
});

test("acceptance effective_status derives expiry without mutating stored status or other lifecycle states", async () => {
  const f = fixture();
  for (let index = 0; index < 5; index += 1) assert.equal((await f.call(payload())).status, 201);
  const records = f.rows.capabilityConsumerAcceptances;
  records[1].expiresAt = NOW;
  records[2].status = "revoked";
  records[3].status = "pending_audit"; records[3].expiresAt = new Date(+NOW - 1);
  records[4].expiresAt = "invalid-legacy-date";
  const before = clone(records);
  const result = await f.call();
  assert.equal(result.status, 200);
  const statuses = new Map(result.body.acceptances.map((entry) => [entry.id, entry.effective_status]));
  assert.deepEqual(records.map((entry) => statuses.get(entry._id)), ["active", "expired", "revoked", "pending_audit", "expired"]);
  assert.equal(result.body.acceptances.find((entry) => entry.id === records[1]._id).status, "active");
  assert.deepEqual(records, before);
});
