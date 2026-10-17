import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { findTrustedConsumerAcceptance, registerCapabilityConsumerAcceptanceRoutes } from "../../server/capability-consumer-acceptance.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const BINDING = new ObjectId();
const USER = new ObjectId();
const BASE = "/api/admin/capability-consumers/acceptances";
const eq = (left, right) => left instanceof Date || right instanceof Date ? +new Date(left) === +new Date(right) : String(left) === String(right);
const matches = (record, query) => Object.entries(query).every(([key, value]) => value === null ? record[key] == null : eq(record[key], value));
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
        : { models: [{ id: "exact-music-model" }], default_model: "exact-music-model", asr_languages: ["zh", "en"],
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
      find(query) {
        let values = rows[name].filter((record) => matches(record, query));
        return { sort() { values.sort((a, b) => +b.createdAt - +a.createdAt); return this; }, limit(count) { values = values.slice(0, count); return this; }, async toArray() { return clone(values); } };
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
