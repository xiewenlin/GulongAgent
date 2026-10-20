import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCapabilityAutoVerificationService, registerCapabilityAutoVerificationRoutes,
  normalizeAutoVerificationInventory, AUTO_VERIFICATION_COLLECTION } from "../../server/capability-auto-verification.js";
import { createNativeCapabilityVerificationAdapters } from "../../server/capability-native-verification.js";
import { createCapabilityVerificationSupplement, SUPPLEMENT_COLLECTION } from "../../server/capability-verification-supplement.js";
import { createCapabilityReleaseVerificationBudget, RELEASE_VERIFICATION_COLLECTION } from "../../server/capability-release-verification-budget.js";
import { createCapabilityCaptionRetestBudget, CAPTION_RETEST_COLLECTION } from "../../server/capability-caption-retest-budget.js";
import { createFixedMusicRetestBudget, activateFixedMusicRetestForDeployment, FIXED_MUSIC_RETEST_COLLECTION } from "../../server/capability-fixed-music-retest.js";
import { buildFixedNativeMusicRegressionCase } from "../../server/capability-fixed-music-case.js";
import { createConditionalSixBudget, CONDITIONAL_SIX_COLLECTION } from "../../server/capability-conditional-six-budget.js";

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
        if (operator === "$exists") return (actual !== undefined) === value;
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
// MongoDB rejects overlapping update paths before matching/upserting, including
// $setOnInsert on an existing row. Do not silently accept a production code-40
// ConflictingUpdateOperators error in this in-memory fixture.
function validateMongoUpdatePaths(update) {
  const paths = [];
  for (const fields of Object.values(update)) for (const path of Object.keys(fields)) {
    const conflict = paths.find((other) => path === other || path.startsWith(`${other}.`) || other.startsWith(`${path}.`));
    if (conflict) throw Object.assign(new Error(`Updating the path '${path}' would create a conflict at '${conflict}'`),
      { code: 40, codeName: "ConflictingUpdateOperators" });
    paths.push(path);
  }
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
        validateMongoUpdatePaths(update);
        if (name === "capabilityVerificationChallenges" && hooks.snapshotFails && update.$set?.parameters) throw new Error("snapshot database unavailable");
        let record = rows[name].find((item) => matches(item, query)); let inserted = false;
        if (!record && config.upsert) { record = { _id: query._id }; rows[name].push(record); inserted = true; }
        if (record) apply(record, update, inserted);
        return { modifiedCount: record ? 1 : 0 };
      },
      async updateMany(query, update) { validateMongoUpdatePaths(update); const found = rows[name].filter((item) => matches(item, query)); found.forEach((item) => apply(item, update)); return { modifiedCount: found.length }; },
      async findOneAndUpdate(query, update) { validateMongoUpdatePaths(update); const record = rows[name].find((item) => matches(item, query)); if (!record) return null; apply(record, update); return copy(record); },
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
  return { service, getCollection, rows, hooks, binding, dependencies, advance(milliseconds) { instant = new Date(+instant + milliseconds); }, now: () => instant };
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

test("legacy inventory version fingerprints preserve the exact bounded native string without weakening default contracts", () => {
  const input = inventory("image", { capability_version: "gpt-6-astra", models: [{ id: "native-image" }] });
  const first = normalizeAutoVerificationInventory(input, { allowLegacyVersion: true });
  assert.equal(first.capabilityVersion, "gpt-6-astra");
  assert.notEqual(first.matrixSha256, normalizeAutoVerificationInventory({ ...input, capability_version: "GPT-6-astra" }, { allowLegacyVersion: true }).matrixSha256);
  assert.throws(() => normalizeAutoVerificationInventory(input), (error) => error.code === "VERIFICATION_REPORT_INVALID");
  for (const version of ["", " x", "x ", "x\n", "x\0y", "a/b", "a\\b", "a:b", ".", "a".repeat(121), "版本1"]) {
    assert.throws(() => normalizeAutoVerificationInventory({ ...input, capability_version: version }, { allowLegacyVersion: true }),
      (error) => error.code === "VERIFICATION_REPORT_INVALID", JSON.stringify(version));
  }
  assert.equal(normalizeAutoVerificationInventory({ ...input, capability_version: "a".repeat(120) }, { allowLegacyVersion: true }).capabilityVersion.length, 120);
});

const probeInput = { fixture_id: "memory-only-audio-v1", role: "media", filename: "audio-v1.flac", content_type: "audio/flac", bytes: 100,
  sha256: "b".repeat(64) };
function fixtureAdapter(extra = {}) {
  return { versions: ["1.0.0"], requiresProbeInputs: true,
    createProbe: () => ({ probeKind: "test-input", parameters: { task: "fixture-test" }, inputAssets: [probeInput],
      budget: { max_inferences: 1, max_input_assets: 1, max_input_bytes: 100, max_audio_seconds: 12 } }),
    validateResult: ({ challenge }) => ({ verifiedModel: challenge.model, contractTests: { exact_input: true } }), ...extra };
}
const inputInventory = () => inventory("input_test", { models: [{ id: "memory-fixture-model" }] });

test("input challenges persist only fixed hashes and recovery refreshes the same tickets without another model budget", async () => {
  let grants = 0;
  const f = fixture({ adapters: { "gulong_engine.input_test": fixtureAdapter() },
    issueProbeInputDownloads: async ({ challenge }) => { grants += 1; return challenge.probeInputs.map((input) => ({ ...input,
      download_url: `https://fixture.example.invalid/download?signature=${grants}`, expires_at: new Date(+f.now() + 300_000) })); } });
  await f.service.report({ binding: f.binding, reports: [inputInventory()] });
  const requestId = "fixed-input-probe", leaseToken = clientSecret();
  const first = await f.service.next({ binding: f.binding, requestId, leaseToken });
  assert.equal(first.challenge.input_assets[0].sha256, probeInput.sha256);
  assert.equal(grants, 1);
  assert.equal(JSON.stringify(f.rows).includes("fixture.example.invalid"), false, "signed URLs must never enter a persisted snapshot");
  const originalId = first.challenge.id;
  f.advance(60_000);
  const recovered = await f.service.byRequest({ binding: f.binding, requestId, leaseToken });
  assert.equal(recovered.challenge.id, originalId);
  assert.equal(grants, 2);
  assert.equal(recovered.challenge.input_assets[0].sha256, probeInput.sha256);
  assert.notEqual(recovered.challenge.input_assets[0].download_url, first.challenge.input_assets[0].download_url);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 1);
  await submit(f, first.challenge, { status: "failed", inlineResult: undefined });
  const terminal = await f.service.byRequest({ binding: f.binding, requestId, leaseToken });
  assert.equal(terminal.lease_valid, false);
  assert.deepEqual(terminal.challenge.input_assets, [probeInput]);
  assert.equal(grants, 2, "terminal requests cannot get executable input tickets");
  assert.equal(f.rows.wallets, undefined); assert.equal(f.rows.capabilityOrders, undefined);
});

test("missing input issuer keeps fixture adapters closed and failed preparation never leaves an executable challenge", async () => {
  const noIssuer = fixture({ adapters: { "gulong_engine.input_test": fixtureAdapter() } });
  const response = await noIssuer.service.report({ binding: noIssuer.binding, reports: [inputInventory()] });
  assert.equal(response.verifications[0].status, "adapter_required");
  assert.equal((await noIssuer.service.next({ binding: noIssuer.binding })).challenge, null);
  const f = fixture({ adapters: { "gulong_engine.input_test": fixtureAdapter() },
    issueProbeInputDownloads: async () => { throw Object.assign(new Error("夹具未配置"), { code: "VERIFICATION_FIXTURE_REQUIRED", status: 503 }); } });
  await f.service.report({ binding: f.binding, reports: [inputInventory()] });
  const requestId = "unavailable-fixture", leaseToken = clientSecret();
  await assert.rejects(() => f.service.next({ binding: f.binding, requestId, leaseToken }), (error) => error.code === "VERIFICATION_FIXTURE_REQUIRED");
  assert.equal(f.rows[AUTO_VERIFICATION_COLLECTION].some((row) => row.status === "leased"), false);
  const state = await f.service.byRequest({ binding: f.binding, requestId, leaseToken });
  assert.equal(state.state, "failed"); assert.equal(state.lease_valid, false); assert.equal(state.challenge, null);
  assert.ok(f.hooks.released.length > 0);
});

test("changed input tickets or unbounded fixture budgets fail before issuance and recovery failures never release a live slot", async () => {
  let broken = false;
  const f = fixture({ adapters: { "gulong_engine.input_test": fixtureAdapter() },
    issueProbeInputDownloads: async ({ challenge }) => challenge.probeInputs.map((input) => ({ ...input,
      sha256: broken ? "e".repeat(64) : input.sha256, download_url: "https://fixture.example.invalid/download", expires_at: new Date(+f.now() + 300_000) })) });
  await f.service.report({ binding: f.binding, reports: [inputInventory()] });
  const requestId = "ticket-recovery", leaseToken = clientSecret();
  const first = await f.service.next({ binding: f.binding, requestId, leaseToken });
  const releases = f.hooks.released.length;
  broken = true;
  await assert.rejects(() => f.service.byRequest({ binding: f.binding, requestId, leaseToken }), (error) => error.code === "VERIFICATION_INPUT_INVALID");
  assert.equal(f.hooks.released.length, releases);
  assert.equal(f.rows[AUTO_VERIFICATION_COLLECTION].find((row) => row.challengeId === first.challenge.id).status, "leased");
  const oversized = fixture({ adapters: { "gulong_engine.input_test": fixtureAdapter({ createProbe: () => ({
    probeKind: "test-input", parameters: {}, inputAssets: [probeInput], budget: { max_inferences: 1, max_input_assets: 1, max_input_bytes: 99 } }) }) },
    issueProbeInputDownloads: async () => { throw new Error("must not sign"); } });
  await oversized.service.report({ binding: oversized.binding, reports: [inputInventory()] });
  await assert.rejects(() => oversized.service.next({ binding: oversized.binding }), (error) => error.code === "VERIFICATION_BUDGET_INVALID");
  assert.equal(oversized.rows[AUTO_VERIFICATION_COLLECTION].some((row) => row.status === "leased"), false);
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

const RETEST_ARTIFACT = "f8bb182e7059eefe075567f37617324e4105dbfd81426c1cc82a44ef9355c27d";
const RELEASE_ARTIFACT = "554a6c84d242aadb9e5df18b0dff5f24298ccc3a0ed35fb7f25c97ac0801c281";
const releaseReports = (artifact = RELEASE_ARTIFACT) => [
  ["gulong_engine.agent_chat", "1.0.0", { id: "qwen38-27b-uncensored-q4-k-m", tools: false, multimodal: false }],
  ["gulong_engine.embedding", "1.0.0", { id: "qwen3-embedding-0.6b-q8-0", dimension: 1024 }],
  ["sam.video_track", "3.1-object-multiplex", { id: "sam-video-3.1" }],
  ["mediapipe.video_analysis", "0.10.14-pose-full", { id: "mediapipe-pose-full-0.10.14" }],
  ["whisper.transcribe", "large-v3-turbo-whisper.cpp", { id: "whisper-large-v3-turbo" }],
  ["gulong_engine.music", "1.0.0", { id: "MiniMax-Music3", max_duration_seconds: 300 }],
  ["minimax_music_3.generate", "3", { id: "MiniMax-Music3", max_duration_seconds: 300 }],
].map(([capability_id, capability_version, model]) => ({ capability_id, capability_version, installed: true, enabled: true,
  sharing_opt_in: true, artifact_sha256: artifact, models: [model], default_model: model.id,
  asr_languages: capability_id.includes("music") ? ["en", "zh"] : [] }));
async function releaseFixture({ bindingPatch = {}, reports = releaseReports(), report = true } = {}) {
  const f = fixture({ adapters: createNativeCapabilityVerificationAdapters({ verifyMediaOutputs: async () => [] }),
    issueProbeInputDownloads: async ({ challenge }) => challenge.probeInputs.map(input => ({ ...input,
      download_url: "https://fixture.example.invalid/release-input", expires_at: new Date(+f.now() + 300_000) })) });
  Object.assign(f.binding, { nodeId: "85254b9d69e4e3307049020c58bab89f2edae70a50817c37ca561194105512d1", computeGroupId: null,
    autoVerificationPolicy: "capability-v2", autoVerificationEnrolledAt: new Date(NOW), autoVerificationCapabilityIds: reports.map(r => r.capability_id) }, bindingPatch);
  f.rows.nodeAccountBindings[0] = copy(f.binding); f.advance(44 * 3600_000);
  if (report) await f.service.report({ binding: f.binding, reports, migrationPolicy: "capability-v2", automaticCapabilityIds: reports.map(r => r.capability_id) });
  f.rows.capabilityVerificationBudgets = [{ _id: `${f.binding._id}:${f.now().toISOString().slice(0,10)}`, count: 0, models: {} }];
  return f;
}

test("new release has exactly eleven independent attempts, no ordinary fallback even across UTC day, and no old ledger mutation", async () => {
  const f = await releaseFixture(); const ordinary = copy(f.rows.capabilityVerificationBudgets);
  // Exercise the original eleven-attempt policy independently of the later,
  // separately authorized one-shot caption grant; this is memory-only state.
  f.rows[CAPTION_RETEST_COLLECTION]=[{_id:"gvc_20261020_554a_native_caption_once",state:"revoked"}];
  const historical = { _id: "old-f8-preserved", status: "failed", artifactSha256: RETEST_ARTIFACT, error: { code: "VERIFICATION_EXECUTION_FAILED" } };
  f.rows.capabilityVerificationChallenges = [copy(historical)];
  f.rows[SUPPLEMENT_COLLECTION] = [{ _id: "old-f8-ledger", usedTotal: 4, consumptions: { retained: true } }];
  const oldLedger = copy(f.rows[SUPPLEMENT_COLLECTION]);
  const counts = {};
  for (let i=0;i<11;i++) {
    const requestId=`new-release-${i}`, leaseToken=clientSecret(i+1);
    const result=await f.service.next({ binding:f.binding,requestId,leaseToken }); assert.ok(result.challenge);
    const cap=result.challenge.capability_id; counts[cap]=(counts[cap]||0)+1;
    const journal=f.rows.capabilityVerificationChallenges.find(r=>r.requestId===requestId);
    assert.equal(journal.budgetSource,"release_reverification");
    assert.ok(Object.values(result.challenge.budget).every(Number.isSafeInteger));
    const before=copy(f.rows[RELEASE_VERIFICATION_COLLECTION]);
    assert.equal((await f.service.next({binding:f.binding,requestId,leaseToken})).challenge.id,result.challenge.id);
    assert.deepEqual(f.rows[RELEASE_VERIFICATION_COLLECTION],before);
    await submit(f,result.challenge,{status:"failed",inlineResult:undefined}); f.advance(3600_000);
  }
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),11);
  assert.equal(counts["gulong_engine.music"],3); assert.equal(counts["minimax_music_3.generate"],3);
  for(const [cap,count] of Object.entries(counts)) if(!cap.includes("music")) assert.equal(count,1);
  assert.equal(f.rows[RELEASE_VERIFICATION_COLLECTION][0].usedTotal,11);
  assert.equal((await f.service.next({binding:f.binding,requestId:"twelfth-denied",leaseToken:clientSecret()})).code,"VERIFICATION_RELEASE_BUDGET_UNAVAILABLE");
  f.advance(7*3600_000); // UTC day changes; ordinary daily budget remains untouched.
  assert.equal((await f.service.next({binding:f.binding,requestId:"next-day-denied",leaseToken:clientSecret()})).challenge,null);
  assert.deepEqual(f.rows.capabilityVerificationBudgets,ordinary); assert.deepEqual(f.rows[SUPPLEMENT_COLLECTION],oldLedger);
  assert.deepEqual(f.rows.capabilityVerificationChallenges[0],historical);
});

test("release status is read-only and awaiting real new inventory; synthetic candidate cannot initialize the grant",async()=>{
  const f=await releaseFixture({report:false}); const service=createCapabilityReleaseVerificationBudget({getCollection:f.getCollection,now:f.now});
  const status=await service.status({binding:f.binding}); assert.equal(status.state,"awaiting_inventory");assert.equal(status.total.remaining,11);
  assert.equal(status.ordinary_fallback,false); assert.equal(status.grants_admission,false);
  assert.equal((await f.service.next({binding:f.binding,requestId:"no-new-inventory",leaseToken:clientSecret()})).challenge,null);
  assert.deepEqual(f.rows[RELEASE_VERIFICATION_COLLECTION],[]);
});

test("release exact matrices, binding, node, group, raw duration, language and lease identity all fail closed without ordinary fallback",async()=>{
  for(const config of [{bindingPatch:{_id:new ObjectId()}},{bindingPatch:{nodeId:"different-node"}},{bindingPatch:{computeGroupId:"different-group"}},
    {reports:releaseReports().map(r=>({...r,models:r.models.map(m=>({...m,id:"other-model"})),default_model:"other-model"}))},
    {reports:releaseReports().map(r=>r.capability_id.includes("music")?{...r,models:[{id:"MiniMax-Music3",max_duration_seconds:11.633}]}:r)}]){
    const f=await releaseFixture(config);
    // Isolate the changed music candidates when only those matrices differ.
    if(config.reports?.some(r=>r.models[0].max_duration_seconds===11.633)) f.rows[AUTO_VERIFICATION_COLLECTION]=f.rows[AUTO_VERIFICATION_COLLECTION].filter(r=>r.capabilityId.includes("music"));
    const result=await f.service.next({binding:f.binding,requestId:"wrong-release-scope",leaseToken:clientSecret()});
    assert.equal(result.challenge,null); assert.equal(f.rows.capabilityVerificationBudgets[0].count,0);
    assert.equal((f.rows[RELEASE_VERIFICATION_COLLECTION]||[]).length,0);
  }
  const f=await releaseFixture(); assert.equal((await f.service.next({binding:f.binding})).challenge,null);
  const service=createCapabilityReleaseVerificationBudget({getCollection:f.getCollection,now:f.now});
  const candidate=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="gulong_engine.music");
  for(const changed of [{...candidate,artifactSha256:RETEST_ARTIFACT},{...candidate,inventory:{...candidate.inventory,asrLanguages:["zh"]}},
    {...candidate,model:{...candidate.model,max_duration_seconds:301}}]) assert.equal(await service.available({binding:f.binding,candidate:changed,controlled:true}),false);
});

test("release preserves physical guards, immutable expiry and per-cap ledger CAS races",async()=>{
  const f=await releaseFixture();await f.service.next({binding:f.binding,dryRun:true});f.hooks.idle=false;
  assert.equal((await f.service.next({binding:f.binding,requestId:"release-busy",leaseToken:clientSecret()})).code,"VERIFICATION_NODE_BUSY");
  assert.equal((f.rows[RELEASE_VERIFICATION_COLLECTION]||[]).length,0);
  const service=createCapabilityReleaseVerificationBudget({getCollection:f.getCollection,now:f.now});
  const candidate=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="gulong_engine.agent_chat");
  const args=i=>({binding:f.binding,candidate,controlled:true,challengeId:`gcv-release-race-${i}`,requestId:`release-race-${i}`,requestRecordId:digest(`release-race-${i}`)});
  const results=await Promise.all(Array.from({length:20},(_,i)=>service.reserve(args(i))));assert.equal(results.filter(Boolean).length,1);
  assert.equal(await service.reserve(args(0)),null);assert.equal(f.rows[RELEASE_VERIFICATION_COLLECTION][0].usedTotal,1);
  f.rows[RELEASE_VERIFICATION_COLLECTION][0].spec.totalLimit=999;
  const music=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="gulong_engine.music");
  assert.equal(await service.available({binding:f.binding,candidate:music,controlled:true}),false);
  const g=await releaseFixture();g.advance(24*3600_000);
  assert.equal((await g.service.supplementStatus({binding:g.binding})).release_reverification.state,"expired");
  assert.equal((await g.service.next({binding:g.binding,requestId:"expired-new-release",leaseToken:clientSecret()})).challenge,null);
  assert.equal((g.rows[RELEASE_VERIFICATION_COLLECTION]||[]).length,0);
});

test("new release preparation failure remains spent and status recovery cannot replay inference",async()=>{
  const f=await releaseFixture(); f.hooks.snapshotFails=true;
  await assert.rejects(()=>f.service.next({binding:f.binding,requestId:"new-release-prepare-failed",leaseToken:clientSecret()}),/snapshot database unavailable/);
  assert.equal(f.rows[RELEASE_VERIFICATION_COLLECTION][0].usedTotal,1);
  const recovered=await f.service.byRequest({binding:f.binding,requestId:"new-release-prepare-failed",leaseToken:clientSecret()});
  assert.equal(recovered.state,"failed");assert.equal(recovered.lease_valid,false); assert.equal(f.rows.capabilityVerificationBudgets[0].count,0);
});

test("cross-instance release reservations cannot exceed total eleven or borrow another capability quota",async()=>{
  const f=await releaseFixture();
  const services=Array.from({length:3},()=>createCapabilityReleaseVerificationBudget({getCollection:f.getCollection,now:f.now}));
  const candidates=f.rows[AUTO_VERIFICATION_COLLECTION];
  const results=await Promise.all(Array.from({length:70},(_,i)=>services[i%3].reserve({binding:f.binding,candidate:candidates[i%7],controlled:true,
    challengeId:`gcv-total-race-${i}`,requestId:`total-race-${i}`,requestRecordId:digest(`total-race-${i}`)})));
  assert.equal(results.filter(Boolean).length,11);const ledger=f.rows[RELEASE_VERIFICATION_COLLECTION][0];assert.equal(ledger.usedTotal,11);
  assert.deepEqual(ledger.usedByCapability,{chat:1,embedding:1,sam:1,mediapipe:1,whisper:1,generic_music:3,native_music3:3});
  assert.equal(f.rows.capabilityVerificationBudgets[0].count,0);
});

test("release consumed per-cap refuses ordinary fallback while other capabilities still have allowance",async()=>{
  const f=await releaseFixture();const service=createCapabilityReleaseVerificationBudget({getCollection:f.getCollection,now:f.now});
  const chat=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="gulong_engine.agent_chat");
  assert.ok(await service.reserve({binding:f.binding,candidate:chat,controlled:true,challengeId:"gcv-only-chat",requestId:"only-chat",requestRecordId:digest("only-chat")}));
  for(const r of f.rows[AUTO_VERIFICATION_COLLECTION])if(r!==chat){r.status="active";r.expiresAt=new Date(+f.now()+86400_000);}
  const response=await f.service.next({binding:f.binding,requestId:"used-chat-cannot-borrow",leaseToken:clientSecret()});
  assert.equal(response.code,"VERIFICATION_RELEASE_BUDGET_UNAVAILABLE");assert.equal(response.challenge,null);
  assert.equal((await service.status({binding:f.binding})).total.remaining,10);assert.equal(f.rows.capabilityVerificationBudgets[0].count,0);
});

test("new release backoff retains original retry time while exhausted per-cap never borrows unused caps",async()=>{
  const f=await releaseFixture();
  for(const r of f.rows[AUTO_VERIFICATION_COLLECTION]){r.status="active";r.expiresAt=new Date(+f.now()+86400_000);}
  const native=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="minimax_music_3.generate");
  native.status="failed";native.nextRetryAt=new Date(+f.now()+960_000);native.attempts=2;
  const waiting=await f.service.next({binding:f.binding,requestId:"release-original-backoff",leaseToken:clientSecret()});
  assert.equal(waiting.code,"VERIFICATION_BACKOFF");assert.equal(waiting.retry_after_seconds,960);assert.equal(waiting.retry_at,native.nextRetryAt.toISOString());
  assert.equal((f.rows[RELEASE_VERIFICATION_COLLECTION]||[]).length,0);
});

test("old native challenge recovery returns its stored caption and audit nonce without reconstructing or spending another release attempt",async()=>{
  const f=await releaseFixture();f.rows[AUTO_VERIFICATION_COLLECTION]=f.rows[AUTO_VERIFICATION_COLLECTION].filter(r=>r.capabilityId==="minimax_music_3.generate");
  const requestId="issued-before-caption-fix",leaseToken=clientSecret();
  const issued=await f.service.next({binding:f.binding,requestId,leaseToken});
  const feature=f.rows[AUTO_VERIFICATION_COLLECTION][0];const journal=f.rows.capabilityVerificationChallenges.find(r=>r.requestId===requestId);
  const oldPrompt=`Clear English solo singing, a gentle simple melody. Verification ${journal.nonce}.`;
  feature.parameters.prompt=oldPrompt;journal.parameters.prompt=oldPrompt;
  const before=copy(f.rows);
  const recovered=await f.service.byRequest({binding:f.binding,requestId,leaseToken});
  assert.equal(recovered.challenge.id,issued.challenge.id);assert.equal(recovered.challenge.parameters.prompt,oldPrompt);
  assert.deepEqual(recovered.challenge.parameters,journal.parameters);assert.ok(journal.nonce.startsWith("gcv-"));
  assert.deepEqual(f.rows,before);assert.equal(f.rows[RELEASE_VERIFICATION_COLLECTION][0].usedTotal,1);
});

async function captionFixture() {
  const f=await releaseFixture();f.advance(3600_000);
  const native=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="minimax_music_3.generate");
  const original=createCapabilityReleaseVerificationBudget({getCollection:f.getCollection,now:f.now});
  for(let i=0;i<3;i++)assert.ok(await original.reserve({binding:f.binding,candidate:native,controlled:true,
    challengeId:`gcv-previous-native-${i}`,requestId:`previous-native-${i}`,requestRecordId:digest(`previous-native-${i}`)}));
  for(const row of f.rows[AUTO_VERIFICATION_COLLECTION]){row.status="active";row.expiresAt=new Date(+f.now()+86400_000);}
  native.status="failed";native.attempts=3;native.nextRetryAt=new Date(+f.now()-1000);
  f.rows[SUPPLEMENT_COLLECTION]=[{_id:"historical-f8-ledger",usedTotal:4,retained:true}];
  return {...f,native,caption:createCapabilityCaptionRetestBudget({getCollection:f.getCollection,now:f.now})};
}

const FIXED_ARTIFACT="1829a188caee1e3bca564edaa0b836dd173785e7ffda7363cd7a27a7d9cf1ccb";
async function fixedFixture({activate=true,futureBackoff=false}={}){
  const f=await releaseFixture({reports:releaseReports(FIXED_ARTIFACT)});f.advance(7*3600_000);
  const fixed=buildFixedNativeMusicRegressionCase();
  const source={_id:"original-fixed-failure",bindingId:String(f.binding._id),nodeId:f.binding.nodeId,
    requestId:fixed.audit_origin.source_request_id,challengeId:fixed.audit_origin.source_challenge_id,status:"failed",attempts:4,
    capabilityId:"minimax_music_3.generate",capabilityVersion:"3",artifactSha256:RELEASE_ARTIFACT,parameters:copy(fixed.probe.parameters),
    nextRetryAt:new Date(+f.now()+(futureBackoff?900_000:-60_000)),error:{code:"VERIFICATION_EXECUTION_FAILED"}};
  f.rows.capabilityVerificationChallenges=[copy(source)];
  f.rows[RELEASE_VERIFICATION_COLLECTION]=[{_id:"historical-eleven",usedTotal:11,retained:true}];
  f.rows[CAPTION_RETEST_COLLECTION]=[{_id:"historical-caption",usedTotal:1,retained:true}];
  f.rows[SUPPLEMENT_COLLECTION]=[{_id:"historical-f8",usedTotal:4,retained:true}];
  const deps={getCollection:f.getCollection,now:f.now};
  if(activate)await activateFixedMusicRetestForDeployment({...deps,expectedCommit:"d".repeat(40),installedCommit:"d".repeat(40)});
  Object.assign(f.dependencies.adapters,createNativeCapabilityVerificationAdapters({verifyMediaOutputs:async()=>copy(f.hooks.media||[])}));
  return {...f,source,controller:createFixedMusicRetestBudget(deps),activation:args=>activateFixedMusicRetestForDeployment({...deps,...args})};
}

test("fixed regression has no allowance before deployment activation and CI replay never extends its exact 120 minute window",async()=>{
  const f=await fixedFixture({activate:false});
  assert.equal((await f.controller.status({binding:f.binding})).state,"awaiting_deployment_activation");
  assert.equal((await f.service.next({binding:f.binding,requestId:"fixed-not-activated",leaseToken:clientSecret()})).challenge,null);
  assert.deepEqual(f.rows[FIXED_MUSIC_RETEST_COLLECTION]||[],[]);
  await assert.rejects(()=>f.activation({expectedCommit:"d".repeat(40),installedCommit:"e".repeat(40)}),e=>e.code==="FIXED_RETEST_DEPLOYMENT_MISMATCH");
  const activated=await f.activation({expectedCommit:"d".repeat(40),installedCommit:"d".repeat(40)});
  assert.equal(+new Date(activated.expires_at)- +new Date(activated.ready_at),7_200_000);assert.equal(activated.used,0);
  const before=copy(f.rows[FIXED_MUSIC_RETEST_COLLECTION]);f.advance(1_800_000);
  const repeated=await f.activation({expectedCommit:"e".repeat(40),installedCommit:"e".repeat(40)});
  assert.equal(+new Date(repeated.ready_at),+new Date(activated.ready_at));assert.deepEqual(f.rows[FIXED_MUSIC_RETEST_COLLECTION],before);
  f.advance(7_200_000);const expired=await f.activation({expectedCommit:"e".repeat(40),installedCommit:"e".repeat(40)});
  assert.equal(expired.state,"expired");assert.equal(expired.remaining,0);assert.deepEqual(f.rows[FIXED_MUSIC_RETEST_COLLECTION],before);
});

test("fixed activation pins the original numeric vector and real binding; old source corruption or group changes cannot create a grant",async()=>{
  for(const change of [f=>{f.rows.capabilityVerificationChallenges[0].parameters.seed="716491643";},
    f=>{f.rows.capabilityVerificationChallenges[0].status="active";},f=>{f.rows.nodeAccountBindings[0].computeGroupId="other";}]){
    const f=await fixedFixture({activate:false});change(f);
    await assert.rejects(()=>f.activation({expectedCommit:"d".repeat(40),installedCommit:"d".repeat(40)}));
    assert.deepEqual(f.rows[FIXED_MUSIC_RETEST_COLLECTION]||[],[]);
  }
  const late=await fixedFixture({activate:false});late.advance(3600_000);
  await assert.rejects(()=>late.activation({expectedCommit:"d".repeat(40),installedCommit:"d".repeat(40)}),e=>e.code==="FIXED_RETEST_ACTIVATION_CLOSED");
  assert.deepEqual(late.rows[FIXED_MUSIC_RETEST_COLLECTION]||[],[]);
});

test("fixed regression issues only its approved native vector once, preserves original budgets/failures and never falls back",async()=>{
  const f=await fixedFixture();const before=copy({old:f.rows[RELEASE_VERIFICATION_COLLECTION],caption:f.rows[CAPTION_RETEST_COLLECTION],
    f8:f.rows[SUPPLEMENT_COLLECTION],daily:f.rows.capabilityVerificationBudgets,source:f.rows.capabilityVerificationChallenges[0]});
  const requestId="new-fixed-vector",leaseToken=clientSecret();const result=await f.service.next({binding:f.binding,requestId,leaseToken});
  assert.equal(result.challenge.capability_id,"minimax_music_3.generate");assert.equal(result.challenge.artifact_sha256,FIXED_ARTIFACT);
  assert.deepEqual(result.challenge.parameters,buildFixedNativeMusicRegressionCase().probe.parameters);
  assert.deepEqual(result.challenge.budget,{max_inferences:1,max_output_tokens:0,max_audio_seconds:12,max_asr_passes:1});
  const journal=f.rows.capabilityVerificationChallenges.find(r=>r.requestId===requestId);
  assert.equal(journal.budgetSource,"fixed_music_regression");assert.equal(journal.fixedCaseOnly,true);assert.equal(journal.priorAttempts,4);
  assert.equal(journal.fixedCaseOrigin.source_request_id,f.source.requestId);assert.notEqual(journal.challengeId,f.source.challengeId);
  const ledger=copy(f.rows[FIXED_MUSIC_RETEST_COLLECTION]);assert.equal((await f.service.next({binding:f.binding,requestId,leaseToken})).challenge.id,result.challenge.id);
  assert.deepEqual(f.rows[FIXED_MUSIC_RETEST_COLLECTION],ledger);
  await submit(f,result.challenge,{status:"failed",inlineResult:undefined});f.advance(600_000);
  const denied=await f.service.next({binding:f.binding,requestId:"second-fixed-denied",leaseToken:clientSecret(2)});
  assert.equal(denied.challenge,null);assert.equal(denied.code,"VERIFICATION_ARTIFACT_REVIEW_REQUIRED");
  assert.deepEqual({old:f.rows[RELEASE_VERIFICATION_COLLECTION],caption:f.rows[CAPTION_RETEST_COLLECTION],f8:f.rows[SUPPLEMENT_COLLECTION],
    daily:f.rows.capabilityVerificationBudgets,source:f.rows.capabilityVerificationChallenges[0]},before);
  assert.equal((await f.controller.status({binding:f.binding})).total.remaining,0);
});

test("busy GPU or physical slot never consumes fixed allowance; original backoff stays exact and original leases remain bounded",async()=>{
  const f=await fixedFixture({futureBackoff:true});const before=copy(f.rows[FIXED_MUSIC_RETEST_COLLECTION]);
  const wait=await f.service.next({binding:f.binding,requestId:"fixed-wait-original",leaseToken:clientSecret()});
  assert.equal(wait.code,"VERIFICATION_BACKOFF");assert.equal(wait.retry_after_seconds,900);
  assert.equal(wait.retry_at,f.source.nextRetryAt.toISOString());assert.deepEqual(f.rows[FIXED_MUSIC_RETEST_COLLECTION],before);
  f.advance(900_000);f.hooks.idle=false;
  assert.equal((await f.service.next({binding:f.binding,requestId:"fixed-gpu-busy",leaseToken:clientSecret()})).code,"VERIFICATION_NODE_BUSY");
  f.hooks.idle=true;f.hooks.acquire=false;
  assert.equal((await f.service.next({binding:f.binding,requestId:"fixed-physical-busy",leaseToken:clientSecret()})).code,"VERIFICATION_NODE_BUSY");
  assert.deepEqual(f.rows[FIXED_MUSIC_RETEST_COLLECTION],before);
});

test("fixed one-shot CAS is atomic across instances; every other cap, group, artifact, model or uncontrolled lease is denied",async()=>{
  const f=await fixedFixture();const native=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="minimax_music_3.generate");
  for(const patch of [{binding:{...f.binding,computeGroupId:"another"}},{binding:{...f.binding,nodeId:"another"}},
    {candidate:{...native,artifactSha256:RELEASE_ARTIFACT}},{candidate:{...native,model:{id:"other",max_duration_seconds:300}}},{controlled:false}])
    assert.equal(await f.controller.available({binding:f.binding,candidate:native,controlled:true,...patch}),false);
  for(const row of f.rows[AUTO_VERIFICATION_COLLECTION].filter(r=>r!==native))assert.equal(await f.controller.available({binding:f.binding,candidate:row,controlled:true}),false);
  const services=Array.from({length:3},()=>createFixedMusicRetestBudget({getCollection:f.getCollection,now:f.now}));
  const results=await Promise.all(Array.from({length:30},(_,i)=>services[i%3].reserve({binding:f.binding,candidate:native,controlled:true,
    requestId:`fixed-race-${i}`,requestRecordId:digest(`fixed-race-${i}`),challengeId:`gcv-fixed-race-${i}`})));
  assert.equal(results.filter(Boolean).length,1);assert.equal(f.rows[FIXED_MUSIC_RETEST_COLLECTION][0].usedTotal,1);
});

test("fixed preparation failure stays consumed while repeated source requests cannot issue or run another model",async()=>{
  const f=await fixedFixture();f.hooks.snapshotFails=true;const requestId="fixed-preparation-failure",leaseToken=clientSecret();
  await assert.rejects(()=>f.service.next({binding:f.binding,requestId,leaseToken}));
  assert.equal(f.rows[FIXED_MUSIC_RETEST_COLLECTION][0].usedTotal,1);
  const recovered=await f.service.byRequest({binding:f.binding,requestId,leaseToken});assert.equal(recovered.state,"failed");assert.equal(recovered.lease_valid,false);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count,0);
});

test("fixed result keeps v1 whole-lyrics and audio checks, records only its regression and never grants general business admission",async()=>{
  const f=await fixedFixture();const issued=await f.service.next({binding:f.binding,requestId:"fixed-success-memory",leaseToken:clientSecret()});
  const params=issued.challenge.parameters,audioSha="a".repeat(64);
  f.hooks.media=[{role:"primary_audio",contentType:"audio/flac",bytes:1000,sha256:audioSha,durationSeconds:11.993106575963719,sampleRate:44100}];
  const result=await submit(f,issued.challenge,{outputs:[{output_id:"memory-fixed-output"}],inlineResult:{model:"MiniMax-Music3",
    lyric_verification:{algorithm:"ordered-whole-lyrics-v1",full_audio:true,language:"en",audio_sha256:audioSha,
      lyrics_sha256:digest(params.lyrics),transcript:params.lyrics}}});
  assert.equal(result.verification.status,"active");assert.equal(result.verification.contract_tests.fixed_regression_case,true);
  assert.equal(result.verification.fixed_case_only,true);assert.equal(result.verification.business_admission,false);
  assert.equal(await f.service.findTrusted({bindingId:f.binding._id,report:releaseReports(FIXED_ARTIFACT).find(r=>r.capability_id==="minimax_music_3.generate")}),null);
});

test("fixed activated header is truthful and revoked/tampered grants never renew or consume",async()=>{
  const f=await fixedFixture();assert.equal((await f.service.supplementStatus({binding:f.binding})).installation_guard.fixed_case_authorization_active,true);
  const ledger=f.rows[FIXED_MUSIC_RETEST_COLLECTION][0];ledger.state="revoked";
  assert.equal((await f.controller.status({binding:f.binding})).state,"unavailable");
  await assert.rejects(()=>f.activation({expectedCommit:"d".repeat(40),installedCommit:"d".repeat(40)}));
  assert.equal((await f.service.next({binding:f.binding,requestId:"revoked-fixed",leaseToken:clientSecret()})).challenge,null);
  assert.equal(ledger.usedTotal,0);
});

async function completeFixedMemory(f){
  const issued=await f.service.next({binding:f.binding,requestId:"condition-source-native",leaseToken:clientSecret()});
  const audioSha="a".repeat(64);f.hooks.media=[{role:"primary_audio",contentType:"audio/flac",bytes:1000,sha256:audioSha,durationSeconds:11.993106575963719,sampleRate:44100}];
  await submit(f,issued.challenge,{outputs:[{output_id:"memory-conditional-source"}],inlineResult:{model:"MiniMax-Music3",lyric_verification:{
    algorithm:"ordered-whole-lyrics-v1",full_audio:true,language:"en",audio_sha256:audioSha,
    lyrics_sha256:digest(issued.challenge.parameters.lyrics),transcript:issued.challenge.parameters.lyrics}}});
  return f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="minimax_music_3.generate");
}

test("conditional six has zero effective allowance and no ledger before exact fixed native passes",async()=>{
  const f=await fixedFixture(),service=createConditionalSixBudget({getCollection:f.getCollection,now:f.now});
  const candidate=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="gulong_engine.music");
  const status=await service.status({binding:f.binding});assert.equal(status.prerequisite_met,false);assert.equal(status.total.limit,0);assert.equal(status.total.remaining,0);
  assert.equal(await service.reserve({binding:f.binding,candidate,controlled:true,challengeId:"not-before-fixed",requestId:"not-before-fixed",requestRecordId:digest("not-before-fixed")}),null);
  assert.deepEqual(f.rows[CONDITIONAL_SIX_COLLECTION]||[],[]);
});

test("conditional six requires database proof, source receipt, all v1 flags and matching pass audit, not reported happiness",async()=>{
  for(const mutate of [(_f,p)=>{p.status="failed";},(_f,p)=>{p.contractTests.exact_lyrics=false;},(_f,p)=>{p.fixedCaseOnly=false;},
    (_f,p)=>{p.artifactSha256=RELEASE_ARTIFACT;},(_f,p)=>{p.testEvidenceSha256="";},(_f,p)=>{p.parameters.seed=1;},
    (f)=>{f.rows.capabilityVerificationAudits=[];},(f)=>{f.rows.capabilityVerificationChallenges.find(r=>r.requestId==="condition-source-native").budgetSource="ordinary";}]){
    const f=await fixedFixture(),proof=await completeFixedMemory(f);mutate(f,proof);
    const service=createConditionalSixBudget({getCollection:f.getCollection,now:f.now});
    assert.equal((await service.status({binding:f.binding})).total.remaining,0);
    assert.deepEqual(f.rows[CONDITIONAL_SIX_COLLECTION]||[],[]);
  }
});

test("after a genuine fixed memory proof, conditional CAS is isolated one per six caps and never includes native or Qwen",async()=>{
  const f=await fixedFixture();await completeFixedMemory(f);
  const services=Array.from({length:3},()=>createConditionalSixBudget({getCollection:f.getCollection,now:f.now}));
  const candidates=f.rows[AUTO_VERIFICATION_COLLECTION].filter(r=>r.capabilityId!=="minimax_music_3.generate");
  const old=copy({fixed:f.rows[FIXED_MUSIC_RETEST_COLLECTION],release:f.rows[RELEASE_VERIFICATION_COLLECTION],daily:f.rows.capabilityVerificationBudgets});
  assert.equal((await services[0].status({binding:f.binding})).total.remaining,6);
  assert.equal(await services[0].available({binding:f.binding,candidate:f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="minimax_music_3.generate"),controlled:true}),false);
  const results=await Promise.all(Array.from({length:60},(_,i)=>services[i%3].reserve({binding:f.binding,candidate:candidates[i%6],controlled:true,
    requestId:`conditional-${i}`,requestRecordId:digest(`conditional-${i}`),challengeId:`gcv-conditional-${i}`})));
  assert.equal(results.filter(Boolean).length,6);const ledger=f.rows[CONDITIONAL_SIX_COLLECTION][0];assert.equal(ledger.usedTotal,6);
  assert.deepEqual(ledger.usedByCapability,{chat:1,embedding:1,music:1,sam:1,mediapipe:1,whisper:1});
  assert.deepEqual({fixed:f.rows[FIXED_MUSIC_RETEST_COLLECTION],release:f.rows[RELEASE_VERIFICATION_COLLECTION],daily:f.rows.capabilityVerificationBudgets},old);
  const window=f.rows[FIXED_MUSIC_RETEST_COLLECTION][0];assert.equal(+ledger.readyAt,+window.readyAt);assert.equal(+ledger.expiresAt,+window.expiresAt);
});

test("conditional six cannot escape scope or inherit a fresh window after fixed expiry",async()=>{
  const f=await fixedFixture();await completeFixedMemory(f);const service=createConditionalSixBudget({getCollection:f.getCollection,now:f.now});
  const candidate=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="gulong_engine.embedding");
  for(const patch of [{binding:{...f.binding,computeGroupId:"other"}},{binding:{...f.binding,nodeId:"other"}},
    {candidate:{...candidate,model:{...candidate.model,dimension:3}}},{controlled:false}])assert.equal(await service.available({binding:f.binding,candidate,controlled:true,...patch}),false);
  f.advance(7_200_000);const status=await service.status({binding:f.binding});assert.equal(status.state,"expired");assert.equal(status.total.remaining,0);
  assert.deepEqual(f.rows[CONDITIONAL_SIX_COLLECTION]||[],[]);
});

test("installation quarantine blocks all new-artifact capabilities before any budget or physical reservation, including UTC rollover/group changes",async()=>{
  for(const groupId of [null,"changed-group"]){
    const f=await releaseFixture({reports:releaseReports("b".repeat(64)),bindingPatch:{computeGroupId:groupId}});
    const before=copy(f.rows.capabilityVerificationBudgets);
    for(let i=0;i<2;i++){
      const response=await f.service.next({binding:f.binding,requestId:`quarantined-${i}`,leaseToken:clientSecret(i+1)});
      assert.equal(response.challenge,null);assert.equal(response.code,"VERIFICATION_ARTIFACT_REVIEW_REQUIRED");
      f.advance(24*3600_000);
    }
    assert.equal(f.hooks.acquired.length,0);
    assert.deepEqual(f.rows.capabilityVerificationBudgets,before);
    for(const name of [SUPPLEMENT_COLLECTION,RELEASE_VERIFICATION_COLLECTION,CAPTION_RETEST_COLLECTION])assert.equal((f.rows[name]||[]).length,0);
    const status=await f.service.supplementStatus({binding:f.binding});assert.equal(status.installation_guard.applicable,true);
    assert.equal(status.installation_guard.fixed_case_authorization_active,false);
  }
});

test("installation guard denies even a purported active new-artifact proof, without touching the old proof",async()=>{
  const f=await releaseFixture({reports:releaseReports("c".repeat(64))});
  const row=f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="gulong_engine.agent_chat");
  row.status="active";row.verifiedModel=copy(row.model);row.contractTests={exact_request:true,complete_response:true};
  row.testEvidenceSha256="a".repeat(64);row.testedAt=f.now();row.expiresAt=new Date(+f.now()+86400_000);
  const before=copy(row);
  assert.equal(await f.service.findTrusted({bindingId:f.binding._id,report:releaseReports("c".repeat(64))[0]}),null);
  assert.deepEqual(row,before);
});

test("separate caption retest is exactly one corrected native challenge and never rewrites prior budgets or failure history",async()=>{
  const f=await captionFixture();const old=copy({release:f.rows[RELEASE_VERIFICATION_COLLECTION],f8:f.rows[SUPPLEMENT_COLLECTION],ordinary:f.rows.capabilityVerificationBudgets});
  const status=await f.service.supplementStatus({binding:f.binding});assert.equal(status.native_caption_retest.total.remaining,1);
  assert.equal(status.native_caption_retest.state,"available");assert.deepEqual(f.rows[CAPTION_RETEST_COLLECTION],[]);
  const requestId="one-caption-only",leaseToken=clientSecret();const result=await f.service.next({binding:f.binding,requestId,leaseToken});
  assert.equal(result.challenge.capability_id,"minimax_music_3.generate");assert.equal(f.caption.matchesProbe(result.challenge),true);
  assert.equal(result.challenge.parameters.duration_seconds,12);assert.equal(result.challenge.parameters.sample_rate,44100);
  assert.equal(result.challenge.parameters.output_format,"flac");assert.equal(result.challenge.budget.max_asr_passes,1);
  const journal=f.rows.capabilityVerificationChallenges.find(r=>r.requestId===requestId);assert.equal(journal.budgetSource,"caption_retest");
  assert.ok(journal.nonce.startsWith("gcv-"));assert.equal(f.native.attempts,4);
  const ledgerBeforeRecovery=copy(f.rows[CAPTION_RETEST_COLLECTION]);
  assert.equal((await f.service.next({binding:f.binding,requestId,leaseToken})).challenge.id,result.challenge.id);
  assert.deepEqual(f.rows[CAPTION_RETEST_COLLECTION],ledgerBeforeRecovery);
  await submit(f,result.challenge,{status:"failed",inlineResult:undefined});
  assert.equal(+f.native.nextRetryAt - +f.now(),480_000);f.advance(3600_000);
  assert.equal((await f.service.next({binding:f.binding,requestId:"second-caption-denied",leaseToken:clientSecret(2)})).challenge,null);
  const statusAfter=await f.caption.status({binding:f.binding});assert.equal(statusAfter.total.used,1);assert.equal(statusAfter.total.remaining,0);
  assert.deepEqual({release:f.rows[RELEASE_VERIFICATION_COLLECTION],f8:f.rows[SUPPLEMENT_COLLECTION],ordinary:f.rows.capabilityVerificationBudgets},old);
});

test("caption grant requires prior native three attempts, exact own inventory/model/group and original controlled lease",async()=>{
  const f=await captionFixture();
  for(const patch of [{binding:{...f.binding,_id:new ObjectId()}},{binding:{...f.binding,nodeId:"other-node"}},
    {binding:{...f.binding,computeGroupId:"other-group"}},{candidate:{...f.native,artifactSha256:RETEST_ARTIFACT}},
    {candidate:{...f.native,capabilityId:"gulong_engine.music"}},{candidate:{...f.native,model:{id:"other-music",max_duration_seconds:300}}},
    {candidate:{...f.native,inventory:{...f.native.inventory,asrLanguages:["zh"]}}},{controlled:false}]){
    assert.equal(await f.caption.available({binding:f.binding,candidate:f.native,controlled:true,...patch}),false);
  }
  assert.deepEqual(f.rows[CAPTION_RETEST_COLLECTION]||[],[]);
  const g=await releaseFixture();g.advance(3600_000);const pending=await g.service.supplementStatus({binding:g.binding});
  assert.equal(pending.native_caption_retest.state,"awaiting_original_budget");
  assert.equal(await createCapabilityCaptionRetestBudget({getCollection:g.getCollection,now:g.now}).available({binding:g.binding,
    candidate:g.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r.capabilityId==="minimax_music_3.generate"),controlled:true}),false);
});

test("caption CAS admits only one cross-instance reservation and expiry/revocation/tampering cannot renew it",async()=>{
  const f=await captionFixture();const args=i=>({binding:f.binding,candidate:f.native,controlled:true,challengeId:`gcv-caption-race-${i}`,requestId:`caption-race-${i}`,requestRecordId:digest(`caption-race-${i}`)});
  const services=Array.from({length:3},()=>createCapabilityCaptionRetestBudget({getCollection:f.getCollection,now:f.now}));
  const results=await Promise.all(Array.from({length:30},(_,i)=>services[i%3].reserve(args(i))));assert.equal(results.filter(Boolean).length,1);
  assert.equal(await f.caption.reserve(args(0)),null);assert.equal(f.rows[CAPTION_RETEST_COLLECTION][0].usedTotal,1);
  const g=await captionFixture();g.advance(8*3600_000);
  assert.equal(await g.caption.reserve({...args(0),binding:g.binding,candidate:g.native}),null);
  assert.equal((await g.caption.status({binding:g.binding})).state,"expired");assert.deepEqual(g.rows[CAPTION_RETEST_COLLECTION]||[],[]);
  for(const field of ["state","spec"]){const h=await captionFixture();assert.ok(await h.caption.reserve({...args(1),binding:h.binding,candidate:h.native}));
    if(field==="state")h.rows[CAPTION_RETEST_COLLECTION][0].state="revoked";else h.rows[CAPTION_RETEST_COLLECTION][0].spec.totalLimit=2;
    assert.equal((await h.caption.status({binding:h.binding})).state,"unavailable");}
});

test("caption one-shot keeps original backoff and busy/physical guards without spending while waiting",async()=>{
  const f=await captionFixture();f.native.nextRetryAt=new Date(+f.now()+960_000);
  const waiting=await f.service.next({binding:f.binding,requestId:"caption-original-backoff",leaseToken:clientSecret()});
  assert.equal(waiting.code,"VERIFICATION_BACKOFF");assert.equal(waiting.retry_after_seconds,960);assert.equal(waiting.retry_at,f.native.nextRetryAt.toISOString());
  assert.deepEqual(f.rows[CAPTION_RETEST_COLLECTION]||[],[]);
  await f.service.next({binding:f.binding,dryRun:true});f.advance(960_000);f.hooks.acquire=false;
  assert.equal((await f.service.next({binding:f.binding,requestId:"caption-no-physical-slot",leaseToken:clientSecret()})).code,"VERIFICATION_NODE_BUSY");
  assert.deepEqual(f.rows[CAPTION_RETEST_COLLECTION]||[],[]);
});

test("old caption or preparation failure spends the authorized one but never issues an executable challenge or repeats inference",async()=>{
  for(const kind of ["old-caption","snapshot"]){const f=await captionFixture();
    if(kind==="snapshot")f.hooks.snapshotFails=true;
    else{const adapter=f.dependencies.adapters["minimax_music_3.generate"],createProbe=adapter.createProbe;
      adapter.createProbe=args=>{const p=createProbe(args);p.parameters.prompt=`Old Verification ${args.nonce}.`;return p;};}
    const requestId=`caption-failed-${kind}`,leaseToken=clientSecret();
    await assert.rejects(()=>f.service.next({binding:f.binding,requestId,leaseToken}));
    assert.equal(f.rows[CAPTION_RETEST_COLLECTION][0].usedTotal,1);
    const recovered=await f.service.byRequest({binding:f.binding,requestId,leaseToken});assert.equal(recovered.state,"failed");assert.equal(recovered.lease_valid,false);
    assert.equal(f.rows[RELEASE_VERIFICATION_COLLECTION][0].usedByCapability.native_music3,3);
    assert.equal(f.rows.capabilityVerificationBudgets[0].count,0);
  }
});

test("new inventory invalidates old global-artifact evidence without copying passes or altering independent Qwen rows",async()=>{
  const f=await releaseFixture({reports:releaseReports(RETEST_ARTIFACT)});
  for(const r of f.rows[AUTO_VERIFICATION_COLLECTION])r.status="active";
  const qwen={_id:"retained-independent-qwen",bindingId:String(f.binding._id),capabilityId:"qwen_image_2_1.text_to_image",artifactSha256:"983ea1b00180824ef7cf310594efa2a1e755b0293a853225ea286055149c9aa7",matrixSha256:"retained-matrix",status:"active",expiresAt:new Date(+f.now()+86400_000)};
  f.rows[AUTO_VERIFICATION_COLLECTION].push(copy(qwen));
  await f.service.report({binding:f.binding,reports:releaseReports(),migrationPolicy:"capability-v2",automaticCapabilityIds:releaseReports().map(r=>r.capability_id)});
  assert.equal(f.rows[AUTO_VERIFICATION_COLLECTION].filter(r=>r.artifactSha256===RETEST_ARTIFACT&&r.status==="invalidated").length,7);
  assert.equal(f.rows[AUTO_VERIFICATION_COLLECTION].filter(r=>r.artifactSha256===RELEASE_ARTIFACT&&r.status==="pending").length,7);
  assert.deepEqual(f.rows[AUTO_VERIFICATION_COLLECTION].find(r=>r._id===qwen._id),qwen);
});
async function retestFixture({ bindingPatch = {}, artifact = RETEST_ARTIFACT, model = "MiniMax-Music3", capability, options = {} } = {}) {
  const f = fixture({ adapters: createNativeCapabilityVerificationAdapters({ verifyMediaOutputs: async () => [] }), ...options });
  Object.assign(f.binding, { nodeId: "85254b9d69e4e3307049020c58bab89f2edae70a50817c37ca561194105512d1", computeGroupId: null }, bindingPatch);
  Object.assign(f.binding, { autoVerificationPolicy: "capability-v2", autoVerificationEnrolledAt: new Date(NOW),
    autoVerificationCapabilityIds: capability ? ["gulong_engine.agent_chat"] : ["gulong_engine.music", "minimax_music_3.generate"] });
  f.rows.nodeAccountBindings[0] = copy(f.binding);
  f.advance(2 * 86400_000);
  const generic = inventory("music", { validation: { artifact_sha256: artifact }, models: [{ id: model, max_duration_seconds: 300 }] });
  const native = { ...generic, capability_id: "minimax_music_3.generate", capability_version: "3" };
  const reports = capability ? [{ ...inventory("agent_chat"), validation: { artifact_sha256: artifact } }] : [generic, native];
  await f.service.report({ binding: f.binding, reports, migrationPolicy: "capability-v2", automaticCapabilityIds: reports.map((r) => r.capability_id) });
  const models = {};
  for (const record of f.rows[AUTO_VERIFICATION_COLLECTION]) {
    record.status = "failed"; record.attempts = 3; record.nextRetryAt = new Date(+f.now() - 1000); models[record._id] = 3;
  }
  f.rows.capabilityVerificationBudgets = [{ _id: `${f.binding._id}:${f.now().toISOString().slice(0, 10)}`, count: 16, models }];
  return f;
}

test("scoped supplemental next issues only three per music capability, six total, without resetting ordinary counters", async () => {
  const f = await retestFixture(); const original = copy(f.rows.capabilityVerificationBudgets);
  const historical = { _id: "original-failed-audit", status: "failed", error: { code: "VERIFICATION_EXECUTION_FAILED" }, createdAt: new Date(NOW) };
  f.rows.capabilityVerificationChallenges = [copy(historical)];
  for (let i = 0; i < 6; i++) {
    const requestId = `scoped-music-retest-${i}`, leaseToken = clientSecret(i + 1);
    const result = await f.service.next({ binding: f.binding, requestId, leaseToken });
    assert.ok(result.challenge); assert.equal(result.challenge.budget.max_inferences, 1);
    assert.ok(Object.values(result.challenge.budget).every((value) => Number.isSafeInteger(value) && value >= 0));
    assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, i + 1);
    const journal = f.rows.capabilityVerificationChallenges.find((r) => r.requestId === requestId);
    assert.equal(journal.budgetSource, "supplement"); assert.ok(journal.supplementalBudget.consumptionId);
    const beforeRecovery = copy(f.rows[SUPPLEMENT_COLLECTION]);
    assert.equal((await f.service.next({ binding: f.binding, requestId, leaseToken })).challenge.id, result.challenge.id);
    await f.service.byRequest({ binding: f.binding, requestId, leaseToken });
    assert.deepEqual(f.rows[SUPPLEMENT_COLLECTION], beforeRecovery);
    await submit(f, result.challenge, { status: "failed", inlineResult: undefined });
    f.advance(3600_000);
  }
  const ledger = f.rows[SUPPLEMENT_COLLECTION][0];
  assert.deepEqual(ledger.usedByCapability, { generic_music: 3, native_music3: 3 });
  assert.equal(Object.keys(ledger.consumptions).length, 6);
  assert.deepEqual(f.rows.capabilityVerificationBudgets, original);
  assert.equal((await f.service.next({ binding: f.binding, requestId: "seventh-music-retest", leaseToken: clientSecret() })).challenge, null);
  assert.equal(ledger.usedTotal, 6);
  assert.deepEqual(f.rows.capabilityVerificationChallenges[0], historical);
  assert.equal(f.rows[AUTO_VERIFICATION_COLLECTION].some((r) => r.status === "active"), false);
  assert.equal(f.rows.wallets, undefined); assert.equal(f.rows.capabilityOrders, undefined);
});

test("ordinary allowance remains first and never initializes the supplemental grant", async () => {
  const f = await retestFixture(); const daily = f.rows.capabilityVerificationBudgets[0];
  daily.count = 0; for (const id of Object.keys(daily.models)) daily.models[id] = 0;
  const result = await f.service.next({ binding: f.binding, requestId: "ordinary-music-first", leaseToken: clientSecret() });
  assert.ok(result.challenge); assert.equal(daily.count, 1);
  assert.equal((f.rows[SUPPLEMENT_COLLECTION] || []).length, 0);
  assert.equal(f.rows.capabilityVerificationChallenges[0].budgetSource, "ordinary");
});

async function supplementBackoffFixture({ seconds = 480, consumed = 1 } = {}) {
  const f = await retestFixture();
  const native = f.rows[AUTO_VERIFICATION_COLLECTION].find((r) => r.capabilityId === "minimax_music_3.generate");
  const generic = f.rows[AUTO_VERIFICATION_COLLECTION].find((r) => r.capabilityId === "gulong_engine.music");
  generic.status = "active"; generic.testedAt = f.now(); generic.expiresAt = new Date(+f.now() + 86400_000);
  native.status = "failed"; native.attempts = 3 + consumed; native.nextRetryAt = new Date(+f.now() + seconds * 1000);
  const service = createCapabilityVerificationSupplement({ getCollection: f.getCollection, now: f.now });
  for (let i = 0; i < consumed; i++) assert.ok(await service.reserve({ binding: f.binding, candidate: native, controlled: true,
    challengeId: `gcv_${String(i).padStart(8, "0")}-2222-4222-8222-222222222222`, requestId: `original-native-failure-${i}`, requestRecordId: digest(`original-native-failure-${i}`) }));
  return { ...f, native };
}

test("generic active plus native supplemental headroom returns exact backoff, not daily exhaustion", async () => {
  for (const seconds of [480, 960, 1920]) {
    const f = await supplementBackoffFixture({ seconds });
    const originalModels = copy(f.rows[AUTO_VERIFICATION_COLLECTION]), originalDaily = copy(f.rows.capabilityVerificationBudgets), originalGrant = copy(f.rows[SUPPLEMENT_COLLECTION]);
    const response = await f.service.next({ binding: f.binding, requestId: `native-backoff-${seconds}`, leaseToken: clientSecret() });
    assert.equal(response.code, "VERIFICATION_BACKOFF"); assert.equal(response.challenge, null);
    assert.equal(response.retry_after_seconds, seconds); assert.equal(response.retry_at, f.native.nextRetryAt.toISOString());
    assert.equal(response.state, "not_issued"); assert.equal(response.lease_valid, false);
    assert.equal(+f.rows.capabilityVerificationChallenges[0].responseRetryAt, +f.native.nextRetryAt);
    assert.deepEqual(f.rows[AUTO_VERIFICATION_COLLECTION], originalModels);
    assert.deepEqual(f.rows.capabilityVerificationBudgets, originalDaily);
    assert.deepEqual(f.rows[SUPPLEMENT_COLLECTION], originalGrant);
    assert.equal(f.hooks.acquired.length, 0);
  }
});

test("backoff ceil stays accurate and becomes normally claimable only at original retry time", async () => {
  const f = await supplementBackoffFixture();
  f.advance(1001);
  const waiting = await f.service.next({ binding: f.binding, requestId: "native-backoff-fraction", leaseToken: clientSecret() });
  assert.equal(waiting.retry_after_seconds, 479);
  assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 1);
  f.advance(478_999);
  const eligible = await f.service.next({ binding: f.binding, requestId: "native-after-real-backoff", leaseToken: clientSecret(2) });
  assert.equal(eligible.challenge.capability_id, "minimax_music_3.generate");
  assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 2);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 16);
});

test("fully consumed native supplement does not become backoff merely because generic has unused headroom", async () => {
  const f = await supplementBackoffFixture({ consumed: 3 });
  const response = await f.service.next({ binding: f.binding, requestId: "native-cap-truly-exhausted", leaseToken: clientSecret() });
  assert.equal(response.code, "VERIFICATION_DAILY_BUDGET_EXHAUSTED");
  assert.equal(response.retry_after_seconds, 3600); assert.equal(response.retry_at, undefined);
  assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 3);
  assert.equal(f.hooks.acquired.length, 0);
});

test("backoff hints fail closed for revoked grants and preserve all counters", async () => {
  const f = await supplementBackoffFixture(); f.rows[SUPPLEMENT_COLLECTION][0].state = "revoked";
  const before = copy(f.rows[SUPPLEMENT_COLLECTION]);
  const response = await f.service.next({ binding: f.binding, requestId: "revoked-grant-backoff", leaseToken: clientSecret() });
  assert.equal(response.code, "VERIFICATION_DAILY_BUDGET_EXHAUSTED");
  assert.equal(response.retry_at, undefined); assert.deepEqual(f.rows[SUPPLEMENT_COLLECTION], before);
});

test("supplement cannot escape binding, node, group, artifact, capability or model scope", async () => {
  for (const config of [{ bindingPatch: { _id: new ObjectId() } }, { bindingPatch: { nodeId: "another-node" } },
    { bindingPatch: { computeGroupId: "another-group" } }, { artifact: "b".repeat(64) }, { capability: "agent_chat" }]) {
    const f = await retestFixture(config);
    const response = await f.service.next({ binding: f.binding, requestId: "out-of-scope-case", leaseToken: clientSecret() });
    assert.equal(response.code, config.artifact === "b".repeat(64) ? "VERIFICATION_ARTIFACT_REVIEW_REQUIRED" : "VERIFICATION_DAILY_BUDGET_EXHAUSTED");
    assert.equal((f.rows[SUPPLEMENT_COLLECTION] || []).length, 0);
    assert.equal(f.rows.capabilityVerificationBudgets[0].count, 16);
  }
  const f = await retestFixture();
  const service = createCapabilityVerificationSupplement({ getCollection: f.getCollection, now: f.now });
  const candidate = { ...f.rows[AUTO_VERIFICATION_COLLECTION][0], model: { id: "another-music-model" } };
  assert.equal(await service.available({ binding: f.binding, candidate, controlled: true }), false);
});

test("supplement does not bypass dry-run, idle/physical-slot guards or require an uncontrolled lease", async () => {
  const f = await retestFixture();
  await f.service.next({ binding: f.binding, dryRun: true });
  assert.equal((f.rows[SUPPLEMENT_COLLECTION] || []).length, 0);
  f.hooks.idle = false;
  assert.equal((await f.service.next({ binding: f.binding, requestId: "busy-music-node", leaseToken: clientSecret() })).code, "VERIFICATION_NODE_BUSY");
  f.hooks.idle = true; f.hooks.acquire = false;
  assert.equal((await f.service.next({ binding: f.binding, requestId: "no-physical-slot", leaseToken: clientSecret() })).code, "VERIFICATION_NODE_BUSY");
  f.hooks.acquire = true;
  assert.equal((await f.service.next({ binding: f.binding })).code, "VERIFICATION_DAILY_BUDGET_EXHAUSTED");
  assert.equal((f.rows[SUPPLEMENT_COLLECTION] || []).length, 0);
});

test("concurrent supplemental next preserves one physical execution and one original consumption", async () => {
  const f = await retestFixture();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.service.next({ binding: f.binding,
    requestId: `concurrent-supplement-${i}`, leaseToken: clientSecret() })));
  assert.equal(results.filter((r) => r.challenge).length, 1);
  assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 1);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 16);
});

test("supplement ledger CAS bounds cross-instance races and refuses duplicate challenge consumption", async () => {
  const f = await retestFixture();
  const service = createCapabilityVerificationSupplement({ getCollection: f.getCollection, now: f.now });
  const candidate = f.rows[AUTO_VERIFICATION_COLLECTION][0];
  const args = (i) => ({ binding: f.binding, candidate, controlled: true,
    challengeId: `gcv_${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, requestId: `race-ledger-${i}`, requestRecordId: digest(`race-ledger-${i}`) });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => service.reserve(args(i))));
  assert.equal(results.filter(Boolean).length, 3); assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 3);
  assert.equal(await service.reserve(args(0)), null);
  assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 3);
});

test("supplement expires before reservation and cannot be revived or edited into a larger allowance", async () => {
  const f = await retestFixture(); const service = createCapabilityVerificationSupplement({ getCollection: f.getCollection, now: f.now });
  const candidate = f.rows[AUTO_VERIFICATION_COLLECTION][0];
  assert.equal(await service.available({ binding: f.binding, candidate, controlled: true }), true);
  f.advance(14 * 3600_000);
  assert.equal(await service.reserve({ binding: f.binding, candidate, controlled: true, challengeId: "expired", requestId: "expired", requestRecordId: digest("expired") }), null);
  assert.equal((await service.status({ binding: f.binding })).state, "expired");
  assert.equal((f.rows[SUPPLEMENT_COLLECTION] || []).length, 0);
  const g = await retestFixture();
  const first = await g.service.next({ binding: g.binding, requestId: "immutable-grant-first", leaseToken: clientSecret() });
  await submit(g, first.challenge, { status: "failed", inlineResult: undefined }); g.advance(3600_000);
  g.rows[SUPPLEMENT_COLLECTION][0].spec.totalLimit = 100;
  assert.equal((await g.service.next({ binding: g.binding, requestId: "tampered-grant-next", leaseToken: clientSecret() })).challenge, null);
  assert.equal(g.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 1);
});

test("failed preparation spends a supplement once, keeps the original failed journal and never grants admission", async () => {
  const f = await retestFixture(); f.hooks.snapshotFails = true;
  await assert.rejects(() => f.service.next({ binding: f.binding, requestId: "failed-supplement-journal", leaseToken: clientSecret() }), /snapshot database unavailable/);
  assert.equal(f.rows[SUPPLEMENT_COLLECTION][0].usedTotal, 1);
  const recovered = await f.service.byRequest({ binding: f.binding, requestId: "failed-supplement-journal", leaseToken: clientSecret() });
  assert.equal(recovered.state, "failed"); assert.equal(recovered.lease_valid, false);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 16);
  assert.ok(f.hooks.released.length); assert.equal(f.rows[AUTO_VERIFICATION_COLLECTION].some((r) => r.status === "active"), false);
});

test("supplement status is own-binding read-only and documents the real protected route", async () => {
  const f = await retestFixture(); const before = copy(f.rows);
  const status = await f.service.supplementStatus({ binding: f.binding });
  assert.equal(status.total.remaining, 6); assert.equal(status.capabilities[0].remaining, 3);
  assert.equal(status.grants_admission, false);
  assert.deepEqual(f.rows[SUPPLEMENT_COLLECTION] || [], []);
  assert.deepEqual(f.rows.capabilityVerificationBudgets, before.capabilityVerificationBudgets);
  const app = new OpenAPIHono(); let authorized = false;
  registerCapabilityAutoVerificationRoutes(app, { service: f.service,
    requireBinding: async (c) => authorized ? { binding: f.binding } : { error: c.json({ code: "UNAUTHORIZED" }, 401) },
    requireAdmin: async (c) => ({ error: c.json({ code: "UNAUTHORIZED" }, 401) }) });
  assert.equal((await app.request("/api/v1/capability-verifications/supplemental-budget")).status, 401);
  authorized = true; const response = await app.request("/api/v1/capability-verifications/supplemental-budget");
  assert.equal(response.status, 200); assert.equal((await response.json()).total.used, 0);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("MongoDB update conflicts are rejected even for existing or unmatched rows before any mutation", async () => {
  const f = fixture(); const records = await f.getCollection("memoryConflictRegression");
  await records.insertOne({ _id: "existing", createdAt: NOW });
  const before = copy(f.rows);
  for (const id of ["existing", "missing"]) for (const update of [
    { $set: { createdAt: f.now() }, $setOnInsert: { createdAt: f.now() } },
    { $set: { nested: {} }, $setOnInsert: { "nested.createdAt": f.now() } },
  ]) {
    await assert.rejects(() => records.updateOne({ _id: id }, update, { upsert: true }),
      (error) => error.code === 40 && error.codeName === "ConflictingUpdateOperators");
    await assert.rejects(() => records.updateMany({ _id: id }, update), (error) => error.code === 40);
    await assert.rejects(() => records.findOneAndUpdate({ _id: id }, update), (error) => error.code === 40);
  }
  assert.deepEqual(f.rows, before);
});

test("controlled snapshot preserves original request creation time with disjoint MongoDB update paths", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  f.advance(60_000);
  const requestTime = new Date(f.now()); const requestId = "created-at-controlled"; const leaseToken = clientSecret();
  const response = await f.service.next({ binding: f.binding, requestId, leaseToken });
  assert.equal(response.state, "leased"); assert.equal(response.lease_valid, true);
  const journal = f.rows.capabilityVerificationChallenges[0];
  assert.equal(+journal.createdAt, +requestTime);
  assert.equal(+f.rows[AUTO_VERIFICATION_COLLECTION][0].createdAt, +NOW, "inventory timestamp remains separate");
  f.advance(10_000);
  const recovered = await f.service.next({ binding: f.binding, requestId, leaseToken });
  assert.equal(recovered.challenge.id, response.challenge.id);
  assert.equal(+journal.createdAt, +requestTime);
  assert.equal(f.rows.capabilityVerificationChallenges.length, 1);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 1);
  assert.equal(f.hooks.acquired.length, 1);
  assert.equal(f.rows.wallets, undefined); assert.equal(f.rows.capabilityOrders, undefined);
});

test("legacy snapshot upsert initializes only its own creation time without copying the inventory timestamp", async () => {
  const f = fixture(); await f.service.report({ binding: f.binding, reports: [inventory()] });
  f.advance(60_000);
  const response = await f.service.next({ binding: f.binding });
  assert.ok(response.challenge);
  assert.equal(+f.rows.capabilityVerificationChallenges[0].createdAt, +f.now());
  assert.equal(+f.rows[AUTO_VERIFICATION_COLLECTION][0].createdAt, +NOW);
  assert.equal(f.rows.capabilityVerificationChallenges.length, 1);
  assert.equal(f.rows.capabilityVerificationBudgets[0].count, 1);
});

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

function statusFixture() {
  const outputId = "O".repeat(43); let f;
  f = fixture({ getProbeOutputStatus: async ({ binding, challenge, outputId: id }) => {
    f.hooks.statusCalls += 1; assert.equal(String(binding._id), String(BINDING));
    if (id !== outputId) throw Object.assign(new Error("未登记此输出"), { code: "VERIFICATION_OUTPUT_NOT_FOUND", status: 404 });
    if (f.hooks.afterStatus) f.hooks.afterStatus();
    return { ok: true, challenge_id: challenge._id, output_id: outputId, state: "confirmed_absent", retry_put_allowed: true,
      content_verified: false, descriptor: { role: "primary_audio", filename: "probe.flac", content_type: "audio/flac", bytes: 128,
        sha256: "c".repeat(64), object_key: `capability-verifications/${challenge._id}/uploads/${outputId}-probe.flac` },
      expires_at: new Date(+NOW + 600000).toISOString(), checked_at: f.now().toISOString(), reason_code: null };
  } });
  f.hooks.statusCalls = 0;
  return { f, outputId };
}

test("probe output GET authenticates binding plus lease, exposes exact OpenAPI and never accepts query descriptors", async () => {
  const { f, outputId } = statusFixture(), challenge = await reportAndNext(f, inventory("music"));
  const app = new OpenAPIHono();
  registerCapabilityAutoVerificationRoutes(app, { service: f.service,
    requireBinding: async (c) => f.hooks.auth ? { binding: f.binding } : { error: c.json({ code: "UNAUTHORIZED" }, 401) },
    requireAdmin: async () => ({ user: { id: String(USER) } }) });
  const path = `/api/v1/capability-verifications/${challenge.id}/outputs/${outputId}`;
  const get = (url = path, token = challenge.lease_token) => app.request(`http://localhost${url}`, { headers: token ? { "X-Gulong-Verification-Lease": token } : {} });
  const before = JSON.stringify(f.rows), reply = await get();
  assert.equal(reply.status, 200); assert.equal(reply.headers.get("Cache-Control"), "private, no-store");
  const value = await reply.json(); assert.equal(value.state, "confirmed_absent"); assert.equal(value.content_verified, false);
  assert.equal(JSON.stringify(f.rows), before); assert.equal(value.url, undefined); assert.equal(value.headers, undefined);
  assert.equal((await get(path, null)).status, 403); assert.equal((await get(path, "invalid-lease")).status, 403);
  assert.equal((await get(`${path}?object_key=another-object`)).status, 400);
  assert.equal((await get(path.replace(outputId, "A".repeat(43)))).status, 404);
  assert.equal((await get(path.replace(outputId, "malformed"))).status, 400);
  f.hooks.auth = false; const denied = await get();
  assert.equal(denied.status, 401); assert.equal(denied.headers.get("Cache-Control"), "private, no-store");
  const document = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  const route = document.paths["/api/v1/capability-verifications/{id}/outputs/{output_id}"].get;
  assert.ok(route); assert.ok(route.parameters.some((parameter) => parameter.name === "X-Gulong-Verification-Lease"));
  const properties = route.responses["200"].content["application/json"].schema.properties;
  assert.deepEqual(properties.state.enum, ["confirmed_present", "confirmed_absent", "uncertain"]);
  assert.equal(properties.content_verified.const ?? properties.content_verified.enum?.[0], false);
  assert.equal(properties.url, undefined); assert.equal(properties.method, undefined);
});

test("output lookup refuses cross-node/group/revoked/expired leases and honors its own rate limit", async () => {
  const { f, outputId } = statusFixture(), challenge = await reportAndNext(f, inventory("music"));
  const args = { binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token, outputId };
  await assert.rejects(f.service.outputStatus({ ...args, binding: { ...f.binding, nodeId: "other-node" } }), { status: 401 });
  f.rows.nodeAccountBindings[0].computeGroupId = "group-two";
  await assert.rejects(f.service.outputStatus({ ...args, binding: { ...f.binding, computeGroupId: "group-two" } }), { code: "COMPUTE_GROUP_MISMATCH" });
  f.rows.nodeAccountBindings[0].computeGroupId = "group-one"; f.hooks.allow = false;
  await assert.rejects(f.service.outputStatus(args), { status: 429 }); assert.equal(f.hooks.statusCalls, 0);
  f.hooks.allow = true; f.rows.nodeAccountBindings[0].status = "revoked";
  await assert.rejects(f.service.outputStatus(args), { status: 401 }); assert.equal(f.hooks.statusCalls, 0);
  f.rows.nodeAccountBindings[0].status = "active"; f.advance(16 * 60000);
  await assert.rejects(f.service.outputStatus(args), { code: "VERIFICATION_LEASE_EXPIRED" }); assert.equal(f.hooks.statusCalls, 0);
});

test("output recovery rechecks current binding/lease after the storage read before returning absence", async () => {
  for (const change of ["revoke", "expire", "verifying"]) {
    const { f, outputId } = statusFixture(), challenge = await reportAndNext(f, inventory("music"));
    f.hooks.afterStatus = () => {
      if (change === "revoke") f.rows.nodeAccountBindings[0].status = "revoked";
      if (change === "expire") f.advance(16 * 60000);
      if (change === "verifying") f.rows[AUTO_VERIFICATION_COLLECTION][0].status = "verifying";
    };
    const call = f.service.outputStatus({ binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token, outputId });
    if (change !== "verifying") await assert.rejects(call, { status: change === "revoke" ? 401 : 409 });
    else { const result = await call; assert.equal(result.state, "uncertain"); assert.equal(result.retry_put_allowed, false); }
  }
});

test("parallel status reads do not issue challenges, spend budgets or mutate verification/output records", async () => {
  const { f, outputId } = statusFixture(), challenge = await reportAndNext(f, inventory("music")), before = JSON.stringify(f.rows);
  const args = { binding: f.binding, challengeId: challenge.id, leaseToken: challenge.lease_token, outputId };
  const reports = await Promise.all(Array.from({ length: 20 }, () => f.service.outputStatus(args)));
  assert.equal(reports.length, 20); assert.equal(f.hooks.statusCalls, 20); assert.equal(JSON.stringify(f.rows), before);
  assert.ok(f.hooks.calls.filter((item) => item.key.endsWith(":output-status")).every((item) => item.config.limit === 60));
});
