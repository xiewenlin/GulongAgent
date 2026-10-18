import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCapabilityAutoVerificationService, registerCapabilityAutoVerificationRoutes,
  normalizeAutoVerificationInventory, AUTO_VERIFICATION_COLLECTION } from "../../server/capability-auto-verification.js";

// These test fixtures live only in memory. No installation, extraction, model
// invocation, build output or on-disk fixture is created by this test file.
const NOW = new Date("2026-10-18T10:00:00.000Z");
const BINDING = new ObjectId("6ab71678e4859d7255789e08");
const USER = new ObjectId("6ab71678e4859d7255789e09");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const copy = (value) => {
  if (value instanceof ObjectId) return new ObjectId(value);
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
};
const get = (value, path) => path.split(".").reduce((item, key) => item?.[key], value);
function set(value, path, item) {
  const keys = path.split("."); let current = value;
  for (const key of keys.slice(0, -1)) current = current[key] ||= {};
  current[keys.at(-1)] = copy(item);
}
function equal(a, b) { return a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : a === b; }
function matches(record, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((item) => matches(record, item));
    const actual = get(record, key);
    if (expected && typeof expected === "object" && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === "$in") return value.some((item) => equal(actual, item));
        if (operator === "$ne") return !equal(actual, value);
        if (operator === "$gt") return actual > value;
        if (operator === "$gte") return actual >= value;
        if (operator === "$lt") return actual < value;
        if (operator === "$lte") return actual <= value;
        if (operator === "$not") return !matches({ value: actual }, { value });
        throw new Error(`Unsupported test operator ${operator}`);
      });
    }
    return equal(actual, expected);
  });
}
function apply(record, update, inserted = false) {
  if (inserted) for (const [key, value] of Object.entries(update.$setOnInsert || {})) set(record, key, value);
  for (const [key, value] of Object.entries(update.$set || {})) set(record, key, value);
  for (const [key, value] of Object.entries(update.$inc || {})) set(record, key, (get(record, key) || 0) + value);
  for (const key of Object.keys(update.$unset || {})) { const keys = key.split("."); const parent = keys.slice(0, -1).reduce((item, part) => item?.[part], record); if (parent) delete parent[keys.at(-1)]; }
}
function fixture(options = {}) {
  let instant = new Date(NOW);
  const binding = { _id: BINDING, userId: USER, nodeId: "test-node", computeGroupId: "group-one", status: "active", revokedAt: null };
  const rows = { nodeAccountBindings: [copy(binding)] };
  const hooks = { calls: [], allow: true, idle: true, acquire: true, acquired: [], released: [], media: null, mediaCalls: 0, auth: true, admin: true, auditFails: false, snapshotFails: false };
  const getCollection = async (name) => {
    rows[name] ||= [];
    return {
      async findOne(query) { return copy(rows[name].find((record) => matches(record, query)) || null); },
      find(query) {
        let found = rows[name].filter((record) => matches(record, query));
        return { sort(order) { found.sort((a, b) => { for (const [key, direction] of Object.entries(order)) { if (get(a, key) < get(b, key)) return -direction; if (get(a, key) > get(b, key)) return direction; } return 0; }); return this; }, limit(limit) { found = found.slice(0, limit); return this; }, async toArray() { return copy(found); } };
      },
      async updateOne(query, update, config = {}) {
        if (name === "capabilityVerificationChallenges" && hooks.snapshotFails && update.$set?.parameters) throw new Error("snapshot database unavailable");
        let record = rows[name].find((item) => matches(item, query)); let inserted = false;
        if (!record && config.upsert) { record = { _id: query._id }; rows[name].push(record); inserted = true; }
        if (record) apply(record, update, inserted);
        return { modifiedCount: record ? 1 : 0 };
      },
      async updateMany(query, update) { const found = rows[name].filter((item) => matches(item, query)); found.forEach((item) => apply(item, update)); return { modifiedCount: found.length }; },
      async findOneAndUpdate(query, update) { const record = rows[name].find((item) => matches(item, query)); if (!record) return null; apply(record, update); return copy(record); },
      async insertOne(record) { if (name === "capabilityVerificationAudits" && hooks.auditFails) throw new Error("offline audit");
        if (rows[name].some((item) => equal(item._id, record._id))) throw Object.assign(new Error("test duplicate key"), { code: 11000 });
        rows[name].push(copy(record)); return { insertedId: record._id }; },
    };
  };
  const dependencies = { getCollection, now: () => instant,
    enforceRateLimit: async (key, config) => { hooks.calls.push({ key, config }); return { allowed: hooks.allow }; },
    canProbe: async ({ resources }) => { hooks.resources = resources; return hooks.idle; },
    acquireExecution: async (value) => { hooks.acquired.push(copy(value)); return hooks.acquire; },
    releaseExecution: async (value) => { hooks.released.push(copy(value)); },
    issueProbeOutputUpload: async ({ challenge, output }) => ({ output_id: "one-output", object_key: `verification/${challenge._id}/${output.filename}`, url: "https://example.invalid/put", method: "PUT", headers: {}, expires_at: new Date(+instant + 60_000) }),
    verifyMediaOutputs: async () => { hooks.mediaCalls += 1; if (hooks.media instanceof Error) throw hooks.media; return copy(hooks.media); },
    ...options,
  };
  const service = createCapabilityAutoVerificationService(dependencies);
  return { service, getCollection, rows, hooks, binding, advance(milliseconds) { instant = new Date(+instant + milliseconds); }, now: () => instant };
}
function inventory(capability = "agent_chat", override = {}) {
  return { capability_id: `gulong_engine.${capability}`, capability_version: "1.0.0", installed: true, enabled: true, sharing_opt_in: true,
    validation: { artifact_sha256: "a".repeat(64) }, models: capability === "embedding" ? [{ id: "exact-vector", dimension: 3 }]
      : capability === "music" ? [{ id: "exact-music", max_duration_seconds: 300 }] : [{ id: "exact-chat", tools: false, multimodal: false }],
    ...(capability === "music" ? { asr_languages: ["en"] } : {}), ...override };
}
async function reportAndNext(f, input = inventory()) {
  await f.service.report({ binding: f.binding, reports: [input] });
  const result = await f.service.next({ binding: f.binding, resources: { gpu_state: "idle" } });
  assert.ok(result.challenge);
  return result.challenge;
}
function chatResult(challenge) {
  return { response: { id: "chat-test", object: "chat.completion", model: challenge.model.id,
    choices: [{ index: 0, message: { role: "assistant", content: challenge.parameters.request.messages[0].content.split(": ").at(-1) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } };
}
function vectorResult(challenge) { return { response: { object: "list", model: challenge.model.id, data: [
  { object: "embedding", index: 0, embedding: [1, 0, 0] }, { object: "embedding", index: 1, embedding: [0, 1, 0] },
], usage: { prompt_tokens: 10, total_tokens: 10 } } }; }
function submit(f, challenge, extra = {}) { return f.service.submit({ binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token,
  status: "completed", inlineResult: Object.hasOwn(extra, "inlineResult") ? extra.inlineResult : chatResult(challenge), ...extra }); }

test("untrusted inventory does not open a model and its validated boolean is ignored", async () => {
  const f = fixture(); const input = inventory();
  input.validated = true; input.validation.contract_tests = { exact_request: true, complete_response: true };
  const response = await f.service.report({ binding: f.binding, reports: [input] });
  assert.equal(response.verifications[0].status, "pending");
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: input }), null);
  assert.equal(f.rows.wallets, undefined); assert.equal(f.rows.capabilityOrders, undefined);
});

test("inventory fingerprint binds exact artifact, full matrix, dimensions and defaults", () => {
  const baseline = normalizeAutoVerificationInventory(inventory());
  assert.equal(normalizeAutoVerificationInventory({ capabilityId: "gulong_engine.agent_chat", capabilityVersion: "1.0.0", installed: true, enabled: true,
    artifactSha256: "A".repeat(64), models: [{ id: "exact-chat", tools: false, multimodal: false }] }).matrixSha256, baseline.matrixSha256);
  for (const input of [inventory("agent_chat", { models: [{ id: "other", tools: false, multimodal: false }] }),
    inventory("agent_chat", { validation: { artifact_sha256: "b".repeat(64) } }),
    inventory("agent_chat", { models: [{ id: "exact-chat", tools: true, multimodal: false }] })]) assert.notEqual(normalizeAutoVerificationInventory(input).matrixSha256, baseline.matrixSha256);
  assert.notEqual(normalizeAutoVerificationInventory(inventory("embedding")).matrixSha256,
    normalizeAutoVerificationInventory(inventory("embedding", { models: [{ id: "exact-vector", dimension: 4 }] })).matrixSha256);
});

test("malformed, duplicate and oversized model inventories are rejected", async () => {
  const f = fixture();
  for (const input of [inventory("embedding", { models: [{ id: "x", dimension: 0 }] }), inventory("music", { models: [{ id: "x", max_duration_seconds: 601 }] }),
    inventory("agent_chat", { models: ["x"] }), inventory("agent_chat", { models: [{ id: "x", tools: false, multimodal: false, nested: {} }] }),
    inventory("agent_chat", { default_model: "missing" }), inventory("agent_chat", { validation: { artifact_sha256: "fake" } }),
    inventory("agent_chat", { models: Array(65).fill({ id: "x", tools: false, multimodal: false }) }),
    inventory("agent_chat", { models: Array(2).fill({ id: "x", tools: false, multimodal: false }) })]) {
    await assert.rejects(() => f.service.report({ binding: f.binding, reports: [input] }), (error) => error.status === 400);
  }
});

test("dry-run authenticates and rate limits without leases, probes or budget consumption", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  const before = copy(f.rows);
  assert.equal((await f.service.next({ binding: f.binding, dryRun: true })).queue, "reachable");
  assert.deepEqual(f.rows, before);
  assert.ok(f.hooks.calls.some((call) => call.key.endsWith(":next")));
});

test("unknown adapters and untested tool or multimodal features are never silently approved", async () => {
  const f = fixture();
  for (const input of [inventory("video", { models: [{ id: "h3" }] }), inventory("agent_chat", { models: [{ id: "x", tools: true, multimodal: false }] }),
    inventory("agent_chat", { models: [{ id: "x", tools: false, multimodal: true }] })]) {
    const response = await f.service.report({ binding: f.binding, reports: [input] });
    assert.equal(response.verifications.find((item) => item.model.id === input.models[0].id && item.status !== "invalidated").status, "adapter_required");
  }
  assert.equal((await f.service.next({ binding: f.binding })).challenge, null);
});

test("missing actual COS verifier keeps music at adapter_required", async () => {
  const f = fixture({ verifyMediaOutputs: undefined });
  const response = await f.service.report({ binding: f.binding, reports: [inventory("music")] });
  assert.equal(response.verifications[0].status, "adapter_required");
});

test("an unknown consumer contract version never inherits the current verifier", async () => {
  const f = fixture(); const report = inventory("agent_chat", { capability_version: "2.0.0" });
  const result = await f.service.report({ binding: f.binding, reports: [report] });
  assert.equal(result.verifications[0].status, "adapter_required");
  assert.equal((await f.service.next({ binding: f.binding })).challenge, null);
});

test("legacy numeric versions are capability-specific rather than a global version relaxation", async () => {
  const custom = { supports: () => true, createProbe: () => ({ probeKind: "legacy-image", budget: { max_inferences: 1 }, parameters: { prompt: "probe" } }),
    validateResult: ({ challenge }) => ({ verifiedModel: challenge.model, contractTests: { native_image_output: true } }) };
  const variants = [
    ["qwen_image_2_1.text_to_image", "2.1", "pending"], ["qwen_image_2_1.text_to_image", "1.0.0", "adapter_required"],
    ["gulong_engine.image", "1", "pending"], ["gulong_engine.image", "2.1", "adapter_required"],
    ["gulong_engine.image_2k", "1", "adapter_required"], ["gulong_engine.image_2k", "1.0.0", "pending"],
    ["gulong_engine.tts", "1", "adapter_required"], ["gulong_engine.agent_chat", "1", "adapter_required"],
  ];
  for (const [capabilityId, capabilityVersion, expected] of variants) {
    const f = fixture({ adapters: { [capabilityId]: custom } });
    const report = { ...inventory(), capability_id: capabilityId, capability_version: capabilityVersion };
    assert.equal((await f.service.report({ binding: f.binding, reports: [report] })).verifications[0].status, expected, `${capabilityId}:${capabilityVersion}`);
  }
  const f = fixture(); const report = { ...inventory(), capability_id: "gulong_engine.text", capability_version: "1", models: [{ id: "native-text" }] };
  const challenge = await reportAndNext(f, report);
  assert.equal(challenge.capability_version, "1");
  const nonce = challenge.parameters.prompt.split(": ").at(-1);
  assert.equal((await submit(f, challenge, { inlineResult: { text: nonce } })).verification.status, "active");
  assert.equal((await f.service.findTrusted({ bindingId: BINDING, report })).capabilityVersion, "1");
});

test("custom declared versions cannot override a known capability's secure allowlist", async () => {
  const adapter = { versions: ["2.1"], supports: () => true,
    createProbe: () => ({ probeKind: "custom", budget: { max_inferences: 1 }, parameters: {} }), validateResult: () => ({}) };
  const f = fixture({ adapters: { "example.test": adapter, "gulong_engine.agent_chat": adapter } });
  const custom = { ...inventory(), capability_id: "example.test", capability_version: "2.1" };
  const unknown = { ...inventory(), capability_id: "gulong_engine.agent_chat", capability_version: "2.1" };
  const report = await f.service.report({ binding: f.binding, reports: [custom, unknown] });
  assert.equal(report.verifications.find((item) => item.capability_id === "example.test").status, "pending");
  assert.equal(report.verifications.find((item) => item.capability_id === "gulong_engine.agent_chat").status, "adapter_required");
});

test("sharing must be explicitly opted in before probing or admitting a model", async () => {
  for (const sharing of [undefined, false, "true", 1]) {
    const f = fixture(); const input = inventory("agent_chat", { sharing_opt_in: sharing });
    assert.equal(normalizeAutoVerificationInventory(input).enabled, false);
    assert.equal((await f.service.report({ binding: f.binding, reports: [input] })).verifications[0].status, "disabled");
    assert.equal((await f.service.next({ binding: f.binding })).challenge, null);
  }
  const camel = inventory("agent_chat", { sharing_opt_in: undefined, sharingOptIn: true });
  assert.equal(normalizeAutoVerificationInventory(camel).enabled, true);
  const f = fixture(); const challenge = await reportAndNext(f, camel); await submit(f, challenge);
  assert.ok(await f.service.findTrusted({ bindingId: BINDING, report: camel }));
  const optedOut = { ...camel, sharingOptIn: false };
  await f.service.report({ binding: f.binding, reports: [optedOut] });
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: optedOut }), null);
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: camel }), null);
});

test("node-side idle report cannot bypass independent busy or missing server guard", async () => {
  for (const mode of [false, null]) {
    const f = fixture(mode === null ? { canProbe: undefined } : {});
    f.hooks.idle = false;
    await f.service.report({ binding: f.binding, reports: [inventory()] });
    const result = await f.service.next({ binding: f.binding, resources: { gpu_state: "idle", running_task_count: 0 } });
    assert.equal(result.code, "VERIFICATION_NODE_BUSY");
    assert.equal(f.rows.capabilityVerificationBudgets, undefined);
  }
});

test("exclusive execution reservation happens before budget consumption and releases every unsuccessful probe", async () => {
  const f = fixture(); f.hooks.acquire = false;
  await f.service.report({ binding: f.binding, reports: [inventory()] });
  const result = await f.service.next({ binding: f.binding });
  assert.equal(result.code, "VERIFICATION_NODE_BUSY");
  assert.equal((f.rows.capabilityVerificationBudgets || []).length, 0);
  assert.equal(f.hooks.acquired.length, 1);
  assert.equal(f.hooks.released.length, 1);
  assert.equal(f.hooks.acquired[0].challengeId, f.hooks.released[0].challengeId);
  f.hooks.acquire = true;
  const challenge = (await f.service.next({ binding: f.binding })).challenge;
  assert.ok(challenge); await submit(f, challenge);
  assert.equal(f.hooks.released.at(-1).challengeId, challenge.id);
});

test("matrix rollback schedules a new verification rather than resurrecting old approval", async () => {
  const f = fixture(); const original = inventory(); const challenge = await reportAndNext(f, original); await submit(f, challenge);
  await f.service.report({ binding: f.binding, reports: [inventory("agent_chat", { validation: { artifact_sha256: "b".repeat(64) } })] });
  await f.service.report({ binding: f.binding, reports: [original] });
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: original }), null);
  assert.ok((await f.service.next({ binding: f.binding })).challenge);
});

test("random pure text challenge returns exact model and bounded no-charge request", async () => {
  const f = fixture(); const challenge = await reportAndNext(f);
  assert.match(challenge.id, /^gcv_[a-f0-9-]{36}$/);
  assert.equal(challenge.parameters.request.model, "exact-chat");
  assert.equal(challenge.parameters.request.max_tokens, 32);
  assert.equal(challenge.parameters.request.stream, false);
  assert.deepEqual(challenge.budget, { max_inferences: 1, max_output_tokens: 32, max_audio_seconds: 12 });
  assert.equal(Buffer.from(challenge.lease_token, "base64url").length, 32);
  assert.equal(f.hooks.resources.gpu_state, "idle");
  assert.equal(JSON.stringify(f.rows).includes(challenge.lease_token), false);
  const result = await submit(f, challenge);
  assert.equal(result.verification.status, "active");
  const trusted = await f.service.findTrusted({ bindingId: BINDING, report: inventory() });
  assert.equal(trusted.source, "automatic"); assert.equal(trusted.models.length, 1);
  assert.deepEqual(trusted.contractTests, { exact_request: true, complete_response: true });
  assert.equal(+new Date(trusted.expiresAt) - +new Date(trusted.testedAt), 7 * 86400_000);
  assert.equal(f.rows.capabilityVerificationAudits.length, 1);
});

const clientSecret = (byte = 1) => Buffer.alloc(32, byte).toString("base64url");

test("controlled request replays the same challenge before busy checking without spending another budget", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  const requestId = "node-verify-20261018-once"; const leaseToken = clientSecret();
  const first = await f.service.next({ binding: f.binding, requestId, leaseToken });
  assert.equal(first.challenge.lease_token, leaseToken); assert.equal(first.request_id, requestId);
  f.hooks.idle = false; f.hooks.acquire = false;
  const replay = await f.service.next({ binding: f.binding, requestId, leaseToken });
  assert.equal(replay.recovered, true); assert.equal(replay.challenge.id, first.challenge.id);
  assert.equal(replay.state, "leased"); assert.equal(replay.lease_valid, true);
  assert.equal(replay.challenge.lease_token, undefined); assert.equal(f.hooks.acquired.length, 1);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 1);
  assert.equal(JSON.stringify(f.rows).includes(leaseToken), false);
  await assert.rejects(() => f.service.next({ binding: f.binding, requestId, leaseToken: clientSecret(2) }), (error) => error.code === "VERIFICATION_REQUEST_CONFLICT");
});

test("controlled creation concurrency reserves one request and never duplicates probe budget", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.service.next({ binding: f.binding, requestId: "same-controlled-key", leaseToken: clientSecret() })));
  assert.equal(responses.filter((item) => item.challenge?.lease_token).length, 1);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 1);
  assert.equal(f.rows.capabilityVerificationChallenges.length, 1);
  assert.ok(responses.every((item) => ["preparing", "leased"].includes(item.state)));
});

test("controlled fields require a canonical 32-byte secret and a bounded safe request key", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  for (const input of [{ requestId: "key" }, { leaseToken: clientSecret() }, { requestId: "../bad", leaseToken: clientSecret() },
    { requestId: "x".repeat(129), leaseToken: clientSecret() }, { requestId: "key", leaseToken: "a".repeat(32) }, { requestId: "key", leaseToken: `${clientSecret()}=` }]) {
    await assert.rejects(() => f.service.next({ binding: f.binding, ...input }), (error) => error.code === "VERIFICATION_REQUEST_ID_INVALID");
  }
  assert.equal(f.rows.capabilityVerificationBudgets, undefined);
});

test("request and challenge recovery are authenticated, read-only, secret-free and return exact 404 semantics", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  const requestId = "recovery-key"; const leaseToken = clientSecret();
  const original = await f.service.next({ binding: f.binding, requestId, leaseToken });
  const before = copy(f.rows);
  const byKey = await f.service.byRequest({ binding: f.binding, requestId, leaseToken });
  const byId = await f.service.getChallenge({ binding: f.binding, challengeId: original.challenge.id, leaseToken });
  assert.deepEqual(byKey, byId); assert.deepEqual(f.rows, before);
  assert.equal(byKey.challenge.parameters.request.model, "exact-chat");
  assert.equal(JSON.stringify(byKey).includes(leaseToken), false);
  assert.equal(JSON.stringify(byKey).includes("leaseTokenHash"), false);
  await assert.rejects(() => f.service.byRequest({ binding: f.binding, requestId: "never-created", leaseToken }), (error) => error.code === "VERIFICATION_REQUEST_NOT_FOUND" && error.status === 404);
  await assert.rejects(() => f.service.getChallenge({ binding: f.binding, challengeId: "gcv_11111111-1111-4111-8111-111111111111", leaseToken }), (error) => error.code === "VERIFICATION_CHALLENGE_NOT_FOUND" && error.status === 404);
  await assert.rejects(() => f.service.getChallenge({ binding: f.binding, challengeId: original.challenge.id, leaseToken: clientSecret(2) }), (error) => error.code === "VERIFICATION_REQUEST_CONFLICT");
  const other = { ...copy(f.binding), _id: new ObjectId(), nodeId: "other-node" }; f.rows.nodeAccountBindings.push(other);
  await assert.rejects(() => f.service.byRequest({ binding: other, requestId, leaseToken }), (error) => error.status === 404);
});

test("terminal and old request associations survive subsequent retries without rerunning models", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  const leaseToken = clientSecret(); const requestId = "failed-original-key";
  const first = (await f.service.next({ binding: f.binding, requestId, leaseToken })).challenge;
  await submit(f, first, { status: "failed", inlineResult: undefined });
  f.advance(60_000);
  const second = (await f.service.next({ binding: f.binding, requestId: "second-key", leaseToken: clientSecret(2) })).challenge;
  assert.ok(second); assert.notEqual(second.id, first.id);
  const recovered = await f.service.next({ binding: f.binding, requestId, leaseToken });
  assert.equal(recovered.state, "failed"); assert.equal(recovered.lease_valid, false);
  assert.equal(recovered.challenge.id, first.id);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 2);
  assert.equal((await submit(f, first, { status: "failed", inlineResult: undefined })).idempotent, true);
});

test("completed request is terminal and expiry never restarts the original idempotency key", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  const requestId = "completed-key"; const leaseToken = clientSecret();
  const original = await f.service.next({ binding: f.binding, requestId, leaseToken });
  await submit(f, original.challenge);
  const completed = await f.service.next({ binding: f.binding, requestId, leaseToken });
  assert.equal(completed.state, "active"); assert.equal(completed.lease_valid, false);
  assert.equal(completed.challenge.id, original.challenge.id);
  f.advance(8 * 86400_000);
  assert.equal((await f.service.byRequest({ binding: f.binding, requestId, leaseToken })).state, "active");
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 1);
  const pending = fixture(); await pending.service.report({ binding: pending.binding, reports: [inventory()] });
  await pending.service.next({ binding: pending.binding, requestId, leaseToken }); pending.advance(15 * 60_000);
  const expired = await pending.service.next({ binding: pending.binding, requestId, leaseToken });
  assert.equal(expired.state, "expired"); assert.equal(expired.lease_valid, false);
  assert.equal(pending.rows.capabilityVerificationBudgets[0].count, 1);
});

test("busy requests remain not-issued and interrupted creation cannot be recovered as executable", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] }); f.hooks.idle = false;
  const requestId = "not-issued-key"; const leaseToken = clientSecret();
  assert.equal((await f.service.next({ binding: f.binding, requestId, leaseToken })).state, "not_issued");
  f.hooks.idle = true;
  assert.equal((await f.service.next({ binding: f.binding, requestId, leaseToken })).state, "not_issued");
  assert.equal(f.hooks.acquired.length, 0);
  f.hooks.snapshotFails = true;
  await assert.rejects(() => f.service.next({ binding: f.binding, requestId: "interrupted-key", leaseToken }), /snapshot database unavailable/);
  const interrupted = await f.service.byRequest({ binding: f.binding, requestId: "interrupted-key", leaseToken });
  assert.equal(interrupted.state, "failed"); assert.equal(interrupted.lease_valid, false); assert.equal(interrupted.challenge, null);
});

test("wrong nonce, substituted model and excess tokens fail without opening admission", async () => {
  for (const mutate of [(result) => { result.response.choices[0].message.content = "OK"; }, (result) => { result.response.model = "other"; },
    (result) => { result.response.usage.completion_tokens = 33; }]) {
    const f = fixture(); const challenge = await reportAndNext(f); const result = chatResult(challenge); mutate(result);
    assert.equal((await submit(f, challenge, { inlineResult: result })).verification.status, "failed");
    assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: inventory() }), null);
    assert.equal(f.rows.capabilityVerificationAudits, undefined);
  }
});

test("node identity, account, compute group and token forgery are rejected", async () => {
  const f = fixture(); const challenge = await reportAndNext(f);
  await assert.rejects(() => submit(f, challenge, { leaseToken: "z".repeat(43) }), (error) => error.code === "VERIFICATION_LEASE_INVALID");
  await assert.rejects(() => submit(f, challenge, { binding: { ...f.binding, nodeId: "other" } }), (error) => error.code === "INVALID_ACCOUNT_BINDING");
  await assert.rejects(() => submit(f, challenge, { binding: { ...f.binding, userId: new ObjectId() } }), (error) => error.code === "INVALID_ACCOUNT_BINDING");
  f.rows.nodeAccountBindings[0].computeGroupId = "group-two";
  await assert.rejects(() => submit(f, challenge), (error) => error.code === "INVALID_ACCOUNT_BINDING");
  f.binding.computeGroupId = "group-two";
  await assert.rejects(() => submit(f, challenge), (error) => error.code === "COMPUTE_GROUP_MISMATCH");
});

test("revoked binding cannot report, claim, upload, submit or read admission", async () => {
  const f = fixture(); const challenge = await reportAndNext(f);
  f.rows.nodeAccountBindings[0].status = "revoked";
  for (const action of [() => f.service.report({ binding: f.binding, reports: [inventory()] }), () => f.service.next({ binding: f.binding }),
    () => submit(f, challenge), () => f.service.outputUpload({ binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token, output: {} })])
    await assert.rejects(action, (error) => error.code === "INVALID_ACCOUNT_BINDING");
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: inventory() }), null);
});

test("duplicate completed callback is idempotent and changing payload is rejected", async () => {
  const f = fixture(); const challenge = await reportAndNext(f);
  assert.equal((await submit(f, challenge)).idempotent, false);
  assert.equal((await submit(f, challenge)).idempotent, true);
  assert.equal(f.rows.capabilityVerificationAudits.length, 1);
  const changed = chatResult(challenge); changed.response.id = "changed";
  await assert.rejects(() => submit(f, challenge, { inlineResult: changed }), (error) => error.code === "VERIFICATION_REPLAY_CONFLICT");
});

test("one binding receives at most one concurrent challenge", async () => {
  const f = fixture();
  await f.service.report({ binding: f.binding, reports: [inventory("agent_chat", { models: [
    { id: "a", tools: false, multimodal: false }, { id: "b", tools: false, multimodal: false },
  ] })] });
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.next({ binding: f.binding })));
  assert.equal(results.filter((result) => result.challenge).length, 1);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 1);
});

test("four global leases bound concurrent probes across distinct nodes", async () => {
  const f = fixture();
  const bindings = Array.from({ length: 5 }, (_, index) => ({ ...copy(f.binding), _id: new ObjectId(), nodeId: `node-${index}` }));
  f.rows.nodeAccountBindings.push(...bindings);
  for (const binding of bindings) await f.service.report({ binding, reports: [inventory()] });
  const results = await Promise.all(bindings.map((binding) => f.service.next({ binding })));
  assert.equal(results.filter((result) => result.challenge).length, 4);
});

test("failed probes back off, retry with a new lease and never exceed three per model per day", async () => {
  const f = fixture(); let challenge = await reportAndNext(f);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await submit(f, challenge, { status: "failed", inlineResult: undefined })).verification.status, "failed");
    assert.equal((await f.service.next({ binding: f.binding })).challenge, null);
    f.advance(60_000 * 2 ** attempt);
    const next = await f.service.next({ binding: f.binding });
    if (attempt < 2) { assert.ok(next.challenge); assert.notEqual(next.challenge.lease_token, challenge.lease_token); challenge = next.challenge; }
    else assert.equal(next.challenge, null);
  }
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 3);
});

test("expired lease cannot activate a model and is recovered without extra inference", async () => {
  const f = fixture(); const challenge = await reportAndNext(f);
  f.advance(15 * 60_000);
  await assert.rejects(() => submit(f, challenge), (error) => error.code === "VERIFICATION_LEASE_EXPIRED");
  assert.equal((await f.service.next({ binding: f.binding })).challenge, null);
  f.advance(60_000);
  assert.ok((await f.service.next({ binding: f.binding })).challenge);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 2);
});

test("artifact or model matrix update invalidates leased and approved records immediately", async () => {
  for (const complete of [false, true]) {
    const f = fixture(); const old = inventory(); const challenge = await reportAndNext(f, old);
    if (complete) await submit(f, challenge);
    const changed = inventory("agent_chat", { validation: { artifact_sha256: "b".repeat(64) } });
    await f.service.report({ binding: f.binding, reports: [changed] });
    assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: changed }), null);
    assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: old }), null);
    if (!complete) await assert.rejects(() => submit(f, challenge), (error) => error.code === "VERIFICATION_LEASE_EXPIRED");
  }
});

test("disabled inventory immediately loses admission and cannot be probed", async () => {
  const f = fixture(); const challenge = await reportAndNext(f); await submit(f, challenge);
  await f.service.report({ binding: f.binding, reports: [inventory("agent_chat", { enabled: false })] });
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: inventory() }), null);
  assert.equal((await f.service.next({ binding: f.binding })).challenge, null);
});

test("expiry schedules automatic refresh and no stale verification opens admission", async () => {
  const f = fixture(); const challenge = await reportAndNext(f); await submit(f, challenge);
  f.advance(7 * 86400_000);
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: inventory() }), null);
  assert.equal((await f.service.list({ bindingId: BINDING }))[0].status, "expired");
  assert.ok((await f.service.next({ binding: f.binding })).challenge);
});

test("audit failures fail closed and never create active admission", async () => {
  const f = fixture(); const challenge = await reportAndNext(f); f.hooks.auditFails = true;
  assert.equal((await submit(f, challenge)).verification.status, "failed");
  assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: inventory() }), null);
});

test("embedding probe preserves exact dimension, two original inputs and complete nonzero results", async () => {
  const f = fixture(); const input = inventory("embedding"); const challenge = await reportAndNext(f, input);
  assert.equal(challenge.parameters.dimension, 3); assert.equal(challenge.parameters.request.input.length, 2);
  const result = await submit(f, challenge, { inlineResult: vectorResult(challenge) });
  assert.equal(result.verification.status, "active");
  const trusted = await f.service.findTrusted({ bindingId: BINDING, report: input });
  assert.deepEqual(trusted.models, [{ id: "exact-vector", dimension: 3 }]);
  assert.equal(trusted.contractTests.exact_model_dimension, true);
});

test("truncated, zero, duplicated or wrong-index embeddings never open admission", async () => {
  for (const mutate of [(result) => { result.response.data[0].embedding = [1, 0]; }, (result) => { result.response.data[1].embedding = [1, 0, 0]; },
    (result) => { result.response.data[0].embedding = [0, 0, 0]; }, (result) => { result.response.data[1].index = 0; }]) {
    const f = fixture(); const challenge = await reportAndNext(f, inventory("embedding")); const response = vectorResult(challenge); mutate(response);
    assert.equal((await submit(f, challenge, { inlineResult: response })).verification.status, "failed");
  }
});

function musicEvidence(f, challenge, extra = {}) {
  const audioSha = "b".repeat(64);
  f.hooks.media = [{ role: "primary_audio", contentType: "audio/flac", bytes: 1234, sha256: audioSha, durationSeconds: 12 }];
  return { lyric_verification: { algorithm: "ordered-whole-lyrics-v1", audio_sha256: audioSha,
    lyrics_sha256: digest(challenge.parameters.lyrics), full_audio: true, language: "en", transcript: challenge.parameters.lyrics, ...extra } };
}

test("music probe requires actual FLAC plus full original ASR and only certifies tested 12 seconds", async () => {
  const f = fixture(); const input = inventory("music"); const challenge = await reportAndNext(f, input);
  assert.equal(challenge.parameters.seconds, 12); assert.equal(challenge.output_upload_required, true);
  const result = await submit(f, challenge, { inlineResult: musicEvidence(f, challenge), outputs: [{ output_id: "one-output" }] });
  assert.equal(result.verification.status, "active"); assert.equal(f.hooks.mediaCalls, 1);
  assert.equal(result.verification.model.max_duration_seconds, 300, "inventory stays distinct from approved range");
  assert.equal(result.verification.verified_model.max_duration_seconds, 12);
  assert.equal(result.verification.contract_tests.whole_audio_asr, true);
  const trusted = await f.service.findTrusted({ bindingId: BINDING, report: input });
  assert.equal(trusted.models[0].max_duration_seconds, 12);
  assert.equal(trusted.contractTests.whole_audio_asr, true); assert.deepEqual(trusted.asrLanguages, ["en"]);
});

test("client output URLs, fake verified flag, truncated ASR and false hashes are rejected", async () => {
  for (const mode of ["url", "boolean", "truncated", "hash", "partial", "short", "badflac"]) {
    const f = fixture(); const challenge = await reportAndNext(f, inventory("music"));
    let inlineResult = musicEvidence(f, challenge); let outputs = [{ output_id: "one-output" }];
    if (mode === "url") outputs = [{ output_id: "one-output", url: "https://example.invalid/file.flac" }];
    if (mode === "boolean") inlineResult = { verified: true };
    if (mode === "truncated") inlineResult.lyric_verification.transcript = "Blue sky";
    if (mode === "hash") inlineResult.lyric_verification.audio_sha256 = "c".repeat(64);
    if (mode === "partial") inlineResult.lyric_verification.full_audio = false;
    if (mode === "short") f.hooks.media[0].durationSeconds = 2;
    if (mode === "badflac") f.hooks.media = new Error("digest mismatch");
    assert.equal((await submit(f, challenge, { inlineResult, outputs })).verification.status, "failed", mode);
    assert.equal(await f.service.findTrusted({ bindingId: BINDING, report: inventory("music") }), null);
  }
});

test("media upload tickets are lease-bound, size bounded and cannot be used by text probes", async () => {
  const f = fixture(); const challenge = await reportAndNext(f, inventory("music"));
  const output = { role: "primary_audio", filename: "probe.flac", content_type: "audio/flac", bytes: 1234, sha256: "b".repeat(64) };
  const grant = await f.service.outputUpload({ binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token, output });
  assert.match(grant.object_key, new RegExp(challenge.id));
  await assert.rejects(() => f.service.outputUpload({ binding: f.binding, challengeId: challenge.id, leaseToken: "x".repeat(43), output }), (error) => error.status === 403);
  await assert.rejects(() => f.service.outputUpload({ binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token, output: { ...output, bytes: 65 * 1024 * 1024 } }), (error) => error.status === 400);
  const other = fixture(); const text = await reportAndNext(other);
  await assert.rejects(() => other.service.outputUpload({ binding: other.binding, challengeId: text.id, leaseToken: text.lease_token, output }), (error) => error.status === 400);
});

test("server custom validators enable exact additional capability only after actual validation", async () => {
  let validations = 0;
  const f = fixture({ adapters: { "example.test": {
    createProbe: ({ nonce }) => ({ probeKind: "server-example", budget: { max_inferences: 1 }, parameters: { nonce } }),
    validateResult: ({ challenge, inlineResult }) => { validations += 1; assert.equal(inlineResult.echo, challenge.parameters.nonce); return { verifiedModel: challenge.model, contractTests: { actual_roundtrip: true } }; },
  } } });
  const input = { ...inventory(), capability_id: "example.test", models: [{ id: "exact-feature", mode: "small" }] };
  const challenge = await reportAndNext(f, input);
  assert.equal((await submit(f, challenge, { inlineResult: { echo: challenge.parameters.nonce } })).verification.status, "active");
  assert.equal(validations, 1);
  assert.deepEqual((await f.service.findTrusted({ bindingId: BINDING, report: input })).models, [{ id: "exact-feature", mode: "small" }]);
});

test("custom adapter supports guard rejects unavailable model variants", async () => {
  const f = fixture({ adapters: { "example.test": { supports: () => false,
    createProbe: () => { throw new Error("must not run"); }, validateResult: () => { throw new Error("must not run"); } } } });
  const result = await f.service.report({ binding: f.binding, reports: [{ ...inventory(), capability_id: "example.test" }] });
  assert.equal(result.verifications[0].status, "adapter_required");
  assert.equal((await f.service.next({ binding: f.binding })).challenge, null);
});

test("custom media manifests flow only through the server upload dependency", async () => {
  let calls = 0;
  const f = fixture({ adapters: { "example.image": {
    createProbe: () => ({ probeKind: "image", parameters: { width: 512, height: 512 }, budget: { max_inferences: 1 }, outputUploadRequired: true }),
    validateResult: () => { throw new Error("not invoked"); },
  } }, issueProbeOutputUpload: async ({ challenge, output }) => { calls += 1; assert.equal(output.role, "primary_image"); return { output_id: challenge._id }; } });
  const challenge = await reportAndNext(f, { ...inventory(), capability_id: "example.image", models: [{ id: "image" }] });
  assert.equal(challenge.output_upload_required, true); assert.equal(challenge.compute_group_id, "group-one");
  assert.equal(challenge.node_id, "test-node");
  await f.service.outputUpload({ binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token,
    output: { role: "primary_image", filename: "probe.png", content_type: "image/png", bytes: 1024, sha256: "b".repeat(64) } });
  assert.equal(calls, 1);
});

test("trusted aggregation contains only successful models, not untested siblings", async () => {
  const f = fixture(); const input = inventory("agent_chat", { models: [{ id: "a", tools: false, multimodal: false }, { id: "b", tools: false, multimodal: false }], default_model: "b" });
  const challenge = await reportAndNext(f, input); await submit(f, challenge);
  const trusted = await f.service.findTrusted({ bindingId: BINDING, report: input });
  assert.equal(trusted.models.length, 1); assert.equal(trusted.defaultModel, challenge.model.id);
  const states = await f.service.list({ bindingId: BINDING });
  assert.deepEqual(states.map((state) => state.status).sort(), ["active", "pending"]);
  const json = JSON.stringify(states);
  for (const forbidden of ["leaseToken", "nonce", "parameters", "userId", "tokenHash", "email"]) assert.equal(json.includes(forbidden), false);
});

test("rate limiting fails closed before probes, audit, or user accounting", async () => {
  const f = fixture(); f.hooks.allow = false;
  await assert.rejects(() => f.service.report({ binding: f.binding, reports: [inventory()] }), (error) => error.status === 429);
  await assert.rejects(() => f.service.next({ binding: f.binding, dryRun: true }), (error) => error.status === 429);
  assert.equal(f.rows[AUTO_VERIFICATION_COLLECTION], undefined);
});

test("API endpoints require binding or administrator, remain no-store and reject malformed bodies", async () => {
  const f = fixture(); const app = new OpenAPIHono();
  registerCapabilityAutoVerificationRoutes(app, { service: f.service,
    requireBinding: async (c) => f.hooks.auth ? { binding: f.binding } : { error: c.json({ message: "请先绑定" }, 401) },
    requireAdmin: async (c) => f.hooks.admin ? { user: { id: String(USER) } } : { error: c.json({ message: "需要管理员" }, 403) },
  });
  const request = (path, body) => app.request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }) });
  f.hooks.auth = false;
  const denied = await request("/api/v1/capability-verifications/report", { capabilities: [inventory()] });
  assert.equal(denied.status, 401); assert.equal(denied.headers.get("Cache-Control"), "private, no-store");
  f.hooks.auth = true;
  assert.equal((await request("/api/v1/capability-verifications/report", "bad-json")).status, 400);
  assert.equal((await request("/api/v1/capability-verifications/report", { padding: "a".repeat(65537) })).status, 413);
  assert.equal((await request("/api/v1/capability-verifications/report", { capabilities: [inventory()] })).status, 200);
  const dry = await request("/api/v1/capability-verifications/next", { dry_run: true });
  assert.equal((await dry.json()).challenge, null);
  f.hooks.admin = false;
  assert.equal((await request("/api/admin/capability-verifications")).status, 403);
  f.hooks.admin = true;
  const statuses = await request("/api/admin/capability-verifications");
  assert.equal(statuses.status, 200); assert.equal((await statuses.json()).verifications.length, 1);
  assert.equal((await request("/api/admin/capability-verifications?limit=257")).status, 400);
  const document = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  assert.ok(document.paths["/api/v1/capability-verifications/{id}/outputs"].post);
  assert.ok(document.paths["/api/v1/capability-verifications/{id}/result"].post);
});

test("HTTP recovery exposes stable route/header schemas and never echoes the original client secret", async () => {
  const f = fixture(); const app = new OpenAPIHono();
  registerCapabilityAutoVerificationRoutes(app, { service: f.service, requireBinding: async (c) => f.hooks.auth ? { binding: f.binding } : { error: c.json({ message: "请先绑定" }, 401) },
    requireAdmin: async () => ({ user: { id: String(USER) } }) });
  await f.service.report({ binding: f.binding, reports: [inventory()] });
  const requestId = "http-stable-journal"; const leaseToken = clientSecret();
  const issued = await app.request("http://localhost/api/v1/capability-verifications/next", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, lease_token: leaseToken }) });
  assert.equal(issued.status, 200); const original = await issued.json();
  for (const route of [`by-request/${requestId}`, `challenges/${original.challenge.id}`]) {
    const response = await app.request(`http://localhost/api/v1/capability-verifications/${route}`, { headers: { "X-Gulong-Verification-Lease": leaseToken } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const result = await response.json(); assert.equal(result.challenge.id, original.challenge.id); assert.equal(result.challenge.lease_token, undefined);
    assert.equal(JSON.stringify(result).includes(leaseToken), false);
  }
  assert.equal((await app.request(`http://localhost/api/v1/capability-verifications/by-request/${requestId}`)).status, 400);
  assert.equal((await app.request("http://localhost/api/v1/capability-verifications/by-request/never-created", { headers: { "X-Gulong-Verification-Lease": leaseToken } })).status, 404);
  f.hooks.auth = false;
  assert.equal((await app.request(`http://localhost/api/v1/capability-verifications/by-request/${requestId}`, { headers: { "X-Gulong-Verification-Lease": leaseToken } })).status, 401);
  const document = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  assert.ok(document.paths["/api/v1/capability-verifications/by-request/{key}"].get);
  assert.ok(document.paths["/api/v1/capability-verifications/challenges/{id}"].get);
  const next = document.paths["/api/v1/capability-verifications/next"].post.requestBody.content["application/json"].schema.properties;
  assert.ok(next.request_id); assert.ok(next.lease_token);
});
