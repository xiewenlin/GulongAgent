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
    defaultModel: input.default_model ?? null, contractTests: clone(input.contract_tests), asrLanguages: [...(input.asr_languages || [])].sort(),
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


function seed(f, input = payload()) {
  const record = {
    _id: "gca_11111111-1111-4111-8111-111111111111", bindingId: String(BINDING), capabilityId: input.capability_id,
    capabilityVersion: input.capability_version, artifactSha256: input.artifact_sha256, models: clone(input.models),
    defaultModel: input.default_model ?? null, contractTests: clone(input.contract_tests), asrLanguages: [...(input.asr_languages || [])].sort(),
    testedAt: new Date(input.tested_at), expiresAt: new Date(input.expires_at), status: "active", createdAt: NOW,
    testEvidenceSha256: input.test_evidence_sha256, adminConfirmedRealConsumer: true,
  };
  f.rows.capabilityConsumerAcceptances = [record];
  return record;
}
test("manual registration is retired and cannot write or consume a body", async () => {
  const f = fixture();
  assert.equal((await f.call(payload())).status, 410);
  assert.equal((await f.call(payload())).body.code, "MANUAL_ACCEPTANCE_RETIRED");
  assert.equal(f.rows.capabilityConsumerAcceptances, undefined);
  assert.equal(f.rows.capabilityConsumerAcceptanceAudits, undefined);
});
test("retired mutation and read-only status retain administrator and origin checks", async () => {
  const f = fixture(); f.hooks.authenticated = false;
  assert.equal((await f.call()).status, 401); assert.equal((await f.call(payload())).status, 401);
  f.hooks.authenticated = true; f.hooks.admin = false;
  assert.equal((await f.call()).status, 403); assert.equal((await readBindings(f)).status, 403);
  f.hooks.admin = true; f.hooks.trusted = false;
  assert.equal((await f.call(payload())).status, 403);
});
test("pre-existing genuine registry records remain usable without creating new ones", async () => {
  for (const capability of ["agent_chat", "embedding", "music"]) {
    const f = fixture(), input = payload(capability), saved = seed(f, input);
    assert.ok(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: report(input, saved._id), now: NOW }));
    const list = await f.call();
    assert.equal(list.status, 200); assert.equal(list.body.acceptances[0].effective_status, "active");
    assert.equal(list.headers.get("Cache-Control"), "private, no-store");
  }
});
test("forged and mismatched legacy identities, features and evidence fail closed", async () => {
  for (const mutate of [
    (r) => { r.artifactSha256 = "c".repeat(64); }, (r) => { r.bindingId = String(new ObjectId()); },
    (r) => { r.models[0].id = "different"; }, (r) => { r.contractTests.exact_request = false; },
    (r) => { r.status = "revoked"; }, (r) => { r.testEvidenceSha256 = ""; },
    (r) => { r.adminConfirmedRealConsumer = false; }, (r) => { r.expiresAt = NOW; },
    (r) => { r.expiresAt = new Date(+NOW + 31 * 86400000); },
  ]) {
    const f = fixture(), input = payload(), saved = seed(f, input); mutate(saved);
    assert.equal(await findTrustedConsumerAcceptance({ getCollection: f.getCollection, bindingId: BINDING, report: report(input, "gca_11111111-1111-4111-8111-111111111111"), now: NOW }), null);
  }
});
test("binding search is exact for node IDs and literal fuzzy for names", async () => {
  const f = fixture();
  f.rows.nodeAccountBindings[0].nodeName = "节点[测试]";
  let result = await readBindings(f, "?node_id=node-one");
  assert.equal(result.body.bindings.length, 1);
  assert.deepEqual(Object.keys(result.body.bindings[0]).sort(), ["binding_id", "compute_group_id", "node_id", "node_name", "user_id"]);
  assert.equal((await readBindings(f, "?q=" + encodeURIComponent("[测试]"))).body.bindings.length, 1);
  assert.equal((await readBindings(f, "?q=not-present")).body.bindings.length, 0);
});
test("unknown, duplicate and oversized filters are rejected but exact platform route captures work", async () => {
  const f = fixture();
  for (const suffix of ["?unexpected=1", "?limit=51", "?q=a&q=b", "?node_id=" + "x".repeat(257), "?q=" + "x".repeat(101)]) assert.equal((await readBindings(f, suffix)).status, 400);
  assert.equal((await readBindings(f, "?_platform_path=admin%2Fcapability-consumers%2Fbindings")).status, 200);
  assert.equal((await readBindings(f, "?_platform_path=wrong")).status, 400);
});
test("inactive and revoked bindings are not selectable", async () => {
  const f = fixture(); f.rows.nodeAccountBindings[0].status = "revoked";
  assert.deepEqual((await readBindings(f)).body.bindings, []);
});
test("legacy list effective expiry is derived without mutating the stored history", async () => {
  const f = fixture(), saved = seed(f); saved.expiresAt = new Date(+NOW - 1);
  assert.equal((await f.call()).body.acceptances[0].effective_status, "expired");
  assert.equal(saved.status, "active");
  assert.equal((await f.call(undefined, "?unexpected=1")).status, 400);
});
