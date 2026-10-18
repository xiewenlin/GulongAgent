import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { hashOpaqueToken } from "../../server/security.js";
import { registerCapabilityOrderRoutes, CAPABILITY_ORDER_PROTOCOL } from "../../server/capability-orders.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";

// Real Hono routes plus the production verification service/slot coordinator.
// Only Mongo storage and external model replies are in-memory fixtures. These
// tests never install, build, write files, call a model, or contact production.
function fixture(suffix = "agent_chat") {
  const requester = { _id: new ObjectId(), status: "active", role: "user", computeGroupId: "group-one" };
  const executor = { _id: new ObjectId(), status: "active", role: "user" };
  const token = `gab_${"A".repeat(48)}`;
  const binding = { _id: new ObjectId(), userId: executor._id, nodeId: "automatic-route-node", nodeName: "自动验收节点",
    computeGroupId: "group-one", status: "active", revokedAt: null, tokenHash: hashOpaqueToken(token, "h3-account-binding") };
  const inventory = { capability_id: `gulong_engine.${suffix}`, capability_version: "1.0.0",
    protocol_version: CAPABILITY_ORDER_PROTOCOL, installed: true, enabled: true, validated: false, sharing_opt_in: true, max_concurrent: 3,
    models: suffix === "embedding" ? [{ id: "vector-one", dimension: 3 }, { id: "vector-two", dimension: 3 }]
      : [{ id: "chat-one", tools: false, multimodal: false }, { id: "chat-two", tools: false, multimodal: false }],
    default_model: suffix === "embedding" ? "vector-one" : "chat-one", validation: { artifact_sha256: "A".repeat(64) } };
  const collections = new Map();
  const mutations = [];
  const hooks = {};
  const collection = (name) => {
    if (!collections.has(name)) {
      const instance = createCapabilityMemoryCollection();
      const findOne = instance.findOne.bind(instance);
      instance.findOne = async (query) => { await hooks.findOne?.(name, query); return findOne(query); };
      for (const method of ["insertOne", "updateOne", "updateMany", "findOneAndUpdate"]) {
        const original = instance[method].bind(instance);
        instance[method] = (...args) => { mutations.push({ name, method }); return original(...args); };
      }
      collections.set(name, instance);
    }
    return collections.get(name);
  };
  collection("users").rows.push(requester, executor);
  collection("nodeAccountBindings").rows.push(binding);
  const app = new OpenAPIHono();
  app.onError((error, c) => c.json({ code: error.code || "TEST_ROUTE_FAILURE", message: error.message }, error.status || 500));
  registerCapabilityOrderRoutes(app, { getCollection: async (name) => collection(name),
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { ...requester, id: String(requester._id) }, kind: "desktop-gulong-engine" }),
    requireTrustedMutation: () => null, readGulongEngineEntitlement: async () => ({ active: true }),
    readEnglishEntitlement: async () => ({ active: true }),
    verificationMedia: {
      issueProbeOutputUpload: async () => { throw new Error("text/vector probes must not upload media"); },
      verifyMediaOutputs: async () => { throw new Error("text/vector probes must not fetch media"); },
    },
  });
  let sequence = 0;
  const call = async (path, body, worker = false) => {
    const response = await app.request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `auto-admission-${++sequence}`,
        ...(worker ? { "X-Gulong-Account-Binding": token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const resources = () => ({ gpu_state: "idle", gpu_observed_at: new Date().toISOString(), current_task_remaining_seconds: 0,
    running_task_count: 0, estimated_total_seconds: 0, max_concurrent_tasks: 3 });
  const report = (options = {}) => call("/api/v1/capability-verifications/report", { capabilities: [inventory], ...options }, true);
  const next = () => call("/api/v1/capability-verifications/next", { resources: resources() }, true);
  const claim = () => call("/api/v1/capability-orders/claim", { node_id: binding.nodeId, node_name: binding.nodeName,
    protocol_version: CAPABILITY_ORDER_PROTOCOL, capabilities: [inventory], resources: resources() }, true);
  const catalog = async () => {
    const result = await call("/api/v1/capability-orders/catalog?product=worklucky");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.capabilities.find((item) => item.capability_id === inventory.capability_id);
  };
  const responseFor = (challenge, content) => suffix === "embedding"
    ? { response: { object: "list", model: challenge.model.id,
      data: [{ object: "embedding", index: 0, embedding: [1, 0.5, 0] }, { object: "embedding", index: 1, embedding: [-0.5, 0, 1] }],
      usage: { prompt_tokens: 10, total_tokens: 10 } } }
    : { response: { id: "chat-automatic-probe", object: "chat.completion", model: challenge.model.id,
      choices: [{ index: 0, message: { role: "assistant", content: content ?? challenge.parameters.request.messages[0].content.split(": ").at(-1) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } } };
  const result = (challenge, extra = {}) => call(`/api/v1/capability-verifications/${challenge.id}/result`, {
    lease_token: challenge.lease_token, status: "completed", inline_result: responseFor(challenge), ...extra,
  }, true);
  const create = (model) => call("/api/v1/capability-orders", { client_product: "worklucky", source_channel: "desktop_agent",
    capability_id: inventory.capability_id, capability_version: "1.0.0", parameters: suffix === "embedding"
      ? { model, dimension: 3, request: { model, input: ["first", "second"], dimensions: 3, encoding_format: "float" } }
      : { model, request: { model, messages: [{ role: "user", content: "真实业务任务" }], max_tokens: 32 } } });
  const assertNoAccounting = () => {
    assert.equal(mutations.some((entry) => /wallet|ledger|payment|subscription|settlement/i.test(entry.name)), false,
      JSON.stringify(mutations));
  };
  const assertNoBusinessOrders = () => assert.equal(collection("capabilityOrders").rows.length, 0);
  return { collection, mutations, hooks, binding, inventory, call, report, next, claim, catalog, responseFor, result, create,
    assertNoAccounting, assertNoBusinessOrders };
}

async function passOneModel(f) {
  const reported = await f.report();
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.ok(reported.body.verifications.every((item) => item.status === "pending"));
  const leased = await f.next();
  assert.equal(leased.status, 200, JSON.stringify(leased.body));
  const challenge = leased.body.challenge;
  assert.ok(challenge, JSON.stringify(leased.body));
  const active = f.collection("capabilityNodeSlots").rows.flatMap((row) => row.leases || []).filter((lease) => new Date(lease.expiresAt) > new Date());
  assert.equal(active.length, 1);
  assert.equal(active[0].exclusive, true);
  assert.equal(active[0].capabilityId, "system.verification");
  assert.equal(active[0].claimId, challenge.id);
  assert.equal(f.mutations.some((entry) => entry.name === "capabilityOrders"), false);
  f.assertNoBusinessOrders(); f.assertNoAccounting();
  const completed = await f.result(challenge);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.verification.status, "active", JSON.stringify(completed.body));
  assert.equal(f.collection("capabilityNodeSlots").rows.flatMap((row) => row.leases || []).length, 0);
  assert.equal(f.mutations.some((entry) => entry.name === "capabilityOrders"), false);
  f.assertNoBusinessOrders(); f.assertNoAccounting();
  return challenge;
}

for (const suffix of ["agent_chat", "embedding"]) {
  test(`automatic ${suffix} route proof admits only the tested model from the original unvalidated full inventory`, async () => {
    const f = fixture(suffix);
    const challenge = await passOneModel(f);
    const approved = challenge.model.id;
    const untested = f.inventory.models.find((model) => model.id !== approved).id;
    assert.equal(f.inventory.validated, false);
    assert.equal(f.inventory.validation.tested_at, undefined);
    assert.equal(f.inventory.validation.contract_tests, undefined);
    const advertisement = await f.claim();
    assert.equal(advertisement.status, 200, JSON.stringify(advertisement.body));
    assert.equal(advertisement.body.task, null);
    const catalog = await f.catalog();
    assert.equal(catalog.dispatchable, true, JSON.stringify(catalog));
    assert.deepEqual(catalog.availability.models.map((model) => model.id), [approved]);
    const denied = await f.create(untested);
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    f.assertNoBusinessOrders(); f.assertNoAccounting();
    const created = await f.create(approved);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(f.collection("capabilityOrders").rows.length, 1);
    const claimed = await f.claim();
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal(claimed.body.task.id, created.body.order.id);
    assert.equal(claimed.body.task.parameters.model, approved);
    const finished = await f.call("/api/v1/capability-orders/callback", {
      order_id: claimed.body.task.id, claim_id: claimed.body.task.claim_id, event_id: "auto-business-completion",
      status: "completed", inline_result: f.responseFor(challenge, "业务回复"),
    }, true);
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(finished.body.order_status, "completed", JSON.stringify(finished.body));
    f.assertNoAccounting();
  });
}

test("pending unvalidated inventories return a non-dispatching claim while an exclusive probe is active", async () => {
  const f = fixture();
  assert.equal((await f.report()).status, 200);
  const first = await f.claim();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.task, null);
  assert.equal(first.body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
  assert.equal(first.body.claim_plan.verification_required, true);
  const next = await f.next();
  assert.ok(next.body.challenge, JSON.stringify(next.body));
  const waiting = await f.claim();
  assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
  assert.equal(waiting.body.task, null);
  assert.equal(f.collection("capabilityNodeSlots").rows.flatMap((row) => row.leases || []).filter((lease) => lease.exclusive).length, 1);
  f.assertNoBusinessOrders(); f.assertNoAccounting();
});

test("a real automatic probe excludes a qualified business claim until its result releases the physical slot", async () => {
  const f = fixture();
  const first = await passOneModel(f);
  await f.claim(); // Advertise the first qualified model from the full raw inventory.
  const created = await f.create(first.model.id);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const second = await f.next(); // The other model has not yet been tested.
  const challenge = second.body.challenge;
  assert.ok(challenge, JSON.stringify(second.body));
  assert.notEqual(challenge.model.id, first.model.id);
  const blocked = await f.claim();
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.task, null);
  assert.equal(f.collection("capabilityOrders").rows[0].status, "queued");
  assert.equal(f.collection("capabilityNodeSlots").rows.flatMap((row) => row.leases || []).length, 1);
  assert.equal((await f.result(challenge)).body.verification.status, "active");
  const claimed = await f.claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.id, created.body.order.id);
  f.assertNoAccounting();
});

test("the real route rejects a wrong random nonce and an imprecise embedding before opening either model", async () => {
  for (const suffix of ["agent_chat", "embedding"]) {
    const f = fixture(suffix);
    await f.report();
    const leased = await f.next();
    const challenge = leased.body.challenge;
    assert.ok(challenge);
    const bad = f.responseFor(challenge, "not-the-server-nonce");
    if (suffix === "embedding") bad.response.data[1].embedding = [1, 2];
    const rejected = await f.result(challenge, { inline_result: bad });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.verification.status, "failed");
    assert.equal((await f.catalog()).dispatchable, false);
    assert.equal((await f.create(challenge.model.id)).status, 409);
    f.assertNoBusinessOrders(); f.assertNoAccounting();
  }
});

test("expired approval, changed node group, and replacement inventory cannot reuse old automatic trust", async () => {
  for (const mode of ["expired", "group", "matrix"]) {
    const f = fixture();
    const challenge = await passOneModel(f);
    assert.equal((await f.claim()).status, 200);
    assert.equal((await f.catalog()).dispatchable, true);
    if (mode === "expired") {
      for (const row of f.collection("capabilityAutoVerifications").rows.filter((row) => row.status === "active")) row.expiresAt = new Date(Date.now() - 1);
    } else if (mode === "group") f.binding.computeGroupId = "group-two";
    else {
      f.inventory.models.push({ id: "chat-new-unverified", tools: false, multimodal: false });
      const reported = await f.report();
      assert.equal(reported.status, 200, JSON.stringify(reported.body));
      assert.ok(f.collection("capabilityAutoVerifications").rows.some((row) => row.status === "invalidated"));
    }
    assert.equal((await f.catalog()).dispatchable, false, mode);
    assert.equal((await f.create(challenge.model.id)).status, 409, mode);
    const empty = await f.claim();
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.task, null, mode);
    f.assertNoBusinessOrders(); f.assertNoAccounting();
  }
});

test("automatic enrollment permanently prevents a valid historical GCA or forged validated flag from bypassing pending or expired proof", async () => {
  for (const suffix of ["agent_chat", "embedding"]) for (const mode of ["pending", "expired"]) {
    const f = fixture(suffix);
    const acceptanceId = `gca_${randomUUID()}`;
    const contractTests = { exact_request: true, complete_response: true,
      ...(suffix === "embedding" ? { exact_model_dimension: true } : {}) };
    f.inventory.validated = true;
    Object.assign(f.inventory.validation, { acceptance_id: acceptanceId, contract_tests: contractTests,
      tested_at: new Date(Date.now() - 1000).toISOString() });
    // Historical registry fixture only; no retired manual administrator API.
    f.collection("capabilityConsumerAcceptances").rows.push({ _id: acceptanceId, bindingId: String(f.binding._id),
      capabilityId: f.inventory.capability_id, capabilityVersion: "1.0.0", artifactSha256: "A".repeat(64),
      testEvidenceSha256: "B".repeat(64), models: structuredClone(f.inventory.models),
      defaultModel: f.inventory.default_model, contractTests, asrLanguages: [], adminConfirmedRealConsumer: true,
      status: "active", testedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 7 * 86400_000) });
    assert.equal((await f.claim()).status, 200);
    assert.equal((await f.catalog()).dispatchable, true, "the historical GCA must genuinely work before automatic enrollment");
    const enrolled = await f.report();
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
    assert.ok(f.binding.autoVerificationEnrolledAt, "enrollment is a server-owned binding marker");
    if (mode === "expired") {
      const challenge = (await f.next()).body.challenge;
      assert.ok(challenge);
      assert.equal((await f.result(challenge)).body.verification.status, "active");
      assert.equal((await f.claim()).status, 200);
      assert.equal((await f.catalog()).dispatchable, true);
      for (const row of f.collection("capabilityAutoVerifications").rows.filter((row) => row.status === "active")) row.expiresAt = new Date(Date.now() - 1);
    }
    assert.equal(f.collection("capabilityConsumerAcceptances").rows[0].status, "active",
      "fallback must be denied by automatic enrollment, not by deleting the old record");
    const rejected = await f.claim(); // The client still sends validated=true, full models and its real old GCA.
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.task, null);
    assert.equal(rejected.body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
    assert.equal((await f.catalog()).dispatchable, false, `${suffix}:${mode}`);
    assert.equal((await f.create(f.inventory.models[0].id)).status, 409);
    f.assertNoBusinessOrders(); f.assertNoAccounting();
  }
});

test("a concurrent real automatic report closes legacy admission before the final claim binding fence", async () => {
  const f = fixture();
  const acceptanceId = `gca_${randomUUID()}`;
  const contractTests = { exact_request: true, complete_response: true };
  f.inventory.validated = true;
  Object.assign(f.inventory.validation, { acceptance_id: acceptanceId, contract_tests: contractTests,
    tested_at: new Date(Date.now() - 1000).toISOString() });
  f.collection("capabilityConsumerAcceptances").rows.push({ _id: acceptanceId, bindingId: String(f.binding._id),
    capabilityId: f.inventory.capability_id, capabilityVersion: "1.0.0", artifactSha256: "A".repeat(64),
    testEvidenceSha256: "B".repeat(64), models: structuredClone(f.inventory.models), defaultModel: f.inventory.default_model,
    contractTests, asrLanguages: [], adminConfirmedRealConsumer: true, status: "active",
    testedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 7 * 86400_000) });
  await f.claim();
  const created = await f.create(f.inventory.models[0].id);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let bindingIdReads = 0, concurrentReport = null;
  f.hooks.findOne = async (name, query) => {
    if (name !== "nodeAccountBindings" || String(query._id) !== String(f.binding._id)) return;
    bindingIdReads += 1;
    if (bindingIdReads !== 2) return; // First lookup is the automatic-proof snapshot, second the final binding fence.
    f.hooks.findOne = null; // Prevent the nested /report authentication from recursively triggering this hook.
    concurrentReport = await f.report();
  };
  const blocked = await f.claim();
  assert.equal(concurrentReport?.status, 200, "a real /report request must run between proof selection and final claim");
  assert.ok(f.binding.autoVerificationEnrolledAt);
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.task, null);
  assert.equal(blocked.body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
  assert.equal(f.collection("capabilityOrders").rows[0].status, "queued");
  assert.equal(f.collection("capabilityNodeSlots").rows.flatMap((row) => row.leases || []).length, 0);
  f.assertNoAccounting();
});

test("malformed ASR language metadata cannot throw an English cache-key TypeError before normal validation", async () => {
  const f = fixture();
  f.inventory.asr_languages = 42;
  const response = await f.claim();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.task, null);
  assert.equal(response.body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
  assert.equal(JSON.stringify(response.body).includes("not iterable"), false);
  f.assertNoBusinessOrders(); f.assertNoAccounting();
});

test("memory fixture precisely models missing-field $not and dotted increments used by real probe budgets", async () => {
  const collection = createCapabilityMemoryCollection([{ _id: "budget", count: 0, models: {} }]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const changed = await collection.findOneAndUpdate({ _id: "budget", "models.abc": { $not: { $gte: 3 } } },
      { $inc: { count: 1, "models.abc": 1 } }, { returnDocument: "after" });
    assert.equal(changed.models.abc, attempt + 1);
  }
  assert.equal(await collection.findOneAndUpdate({ _id: "budget", "models.abc": { $not: { $gte: 3 } } },
    { $inc: { count: 1, "models.abc": 1 } }, { returnDocument: "after" }), null);
  assert.equal((await collection.findOne({ _id: "budget" })).count, 3);
});

function historicalAcceptance(f) {
  const id = `gca_${randomUUID()}`;
  const tests = { exact_request: true, complete_response: true,
    ...(f.inventory.capability_id === "gulong_engine.embedding" ? { exact_model_dimension: true } : {}) };
  f.inventory.validated = true;
  Object.assign(f.inventory.validation, { acceptance_id: id, contract_tests: tests, tested_at: new Date(Date.now() - 1000).toISOString() });
  f.collection("capabilityConsumerAcceptances").rows.push({ _id: id, bindingId: String(f.binding._id),
    capabilityId: f.inventory.capability_id, capabilityVersion: "1.0.0", artifactSha256: "A".repeat(64),
    testEvidenceSha256: "B".repeat(64), models: structuredClone(f.inventory.models), defaultModel: f.inventory.default_model,
    contractTests: tests, asrLanguages: [], adminConfirmedRealConsumer: true, status: "active",
    testedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 7 * 86400_000) });
}

const extraChat = () => ({ capability_id: "gulong_engine.agent_chat", capability_version: "1.0.0", installed: true,
  enabled: true, sharing_opt_in: true, validated: false, models: [{ id: "separate-chat", tools: false, multimodal: false }],
  default_model: "separate-chat", validation: { artifact_sha256: "C".repeat(64) } });
const v2 = (ids, capabilities) => ({ migration_policy: "capability-v2", automatic_capability_ids: ids,
  ...(capabilities ? { capabilities } : {}) });

test("capability-v2 preserves an unlisted valid historical capability, then migrates it one-way without dropping the full inventory", async () => {
  const f = fixture("embedding"); historicalAcceptance(f);
  const chat = extraChat();
  await f.claim();
  assert.equal((await f.catalog()).dispatchable, true);
  const first = await f.report(v2([chat.capability_id], [f.inventory, chat]));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(f.binding.autoVerificationCapabilityIds, [chat.capability_id]);
  assert.equal(first.body.migration.capabilities.find((item) => item.capability_id === f.inventory.capability_id).mode, "legacy_compatibility");
  assert.equal(first.body.verifications.filter((item) => item.capability_id === f.inventory.capability_id).every((item) => item.status === "migration_deferred"), true);
  const probe = (await f.next()).body.challenge;
  assert.equal(probe.capability_id, chat.capability_id, "unmigrated embedding cannot receive an automatic challenge");
  await f.call(`/api/v1/capability-verifications/${probe.id}/result`, { lease_token: probe.lease_token, status: "failed", error: "隔离测试主动结束" }, true);
  await f.claim();
  assert.equal((await f.catalog()).dispatchable, true, "an unrelated migration must not stop a valid old GCA");
  const created = await f.create(f.inventory.models[0].id);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const leased = await f.claim();
  assert.equal(leased.body.task.id, created.body.order.id);
  const migrated = await f.report(v2([f.inventory.capability_id], [f.inventory, chat]));
  assert.equal(migrated.status, 200, JSON.stringify(migrated.body));
  assert.deepEqual(new Set(f.binding.autoVerificationCapabilityIds), new Set([chat.capability_id, f.inventory.capability_id]));
  const omitted = await f.report(v2([], [chat]));
  assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
  assert.equal((await f.catalog()).dispatchable, false, "omitting a migrated ID or capability cannot restore old GCA admission");
  assert.equal((await f.create(f.inventory.models[0].id)).status, 409);
  const stillOld = await f.claim();
  assert.equal(stillOld.body.task, null);
  assert.equal(stillOld.body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
  assert.equal(f.collection("capabilityConsumerAcceptances").rows[0].status, "active", "no historic evidence is deleted or extended");
  const finished = await f.call("/api/v1/capability-orders/callback", { order_id: leased.body.task.id,
    claim_id: leased.body.task.claim_id, event_id: "old-inflight-completed", status: "completed",
    inline_result: { response: { object: "list", model: leased.body.task.parameters.model,
      data: [{ object: "embedding", index: 0, embedding: [1, 0, 0] }, { object: "embedding", index: 1, embedding: [0, 1, 0] }],
      usage: { prompt_tokens: 10, total_tokens: 10 } } } }, true);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.order_status, "completed", "a fenced in-flight task may finish without a new admission");
  f.assertNoAccounting();
});

test("full capability-v2 inventory retains unsupported video and SAM while unlisted legacy image keeps its original admission", async () => {
  const f = fixture();
  const image = { capability_id: "gulong_engine.image", capability_version: "1", protocol_version: CAPABILITY_ORDER_PROTOCOL,
    installed: true, enabled: true, sharing_opt_in: true, validated: true, max_concurrent: 3,
    models: [{ id: "zimage" }], supported_models: ["zimage"], validation: { artifact_sha256: "D".repeat(64), tested_at: new Date().toISOString() } };
  const other = ["gulong_engine.video", "sam.video_track"].map((id) => ({ ...image, capability_id: id,
    capability_version: "1.0.0", validated: false, models: [{ id: "installed-but-not-verified" }] }));
  const reported = await f.report(v2([f.inventory.capability_id], [f.inventory, image, ...other]));
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  for (const capability of [image, ...other]) {
    assert.ok(reported.body.verifications.some((row) => row.capability_id === capability.capability_id && row.status === "migration_deferred"));
  }
  const claim = await f.call("/api/v1/capability-orders/claim", { node_id: f.binding.nodeId, protocol_version: CAPABILITY_ORDER_PROTOCOL,
    capabilities: [f.inventory, image, ...other], resources: { gpu_state: "idle", gpu_observed_at: new Date().toISOString(),
      current_task_remaining_seconds: 0, running_task_count: 0, max_concurrent_tasks: 3 } }, true);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const catalog = (await f.call("/api/v1/capability-orders/catalog?product=worklucky")).body.capabilities;
  assert.equal(catalog.find((row) => row.capability_id === image.capability_id).dispatchable, true);
  assert.equal(catalog.find((row) => row.capability_id === "gulong_engine.video").dispatchable, false);
  assert.equal(f.collection("capabilityAutoVerifications").rows.filter((row) => row.capabilityId !== f.inventory.capability_id).every((row) => row.status === "migration_deferred"), true);
  f.assertNoBusinessOrders(); f.assertNoAccounting();
});

test("capability-v2 policy validation cannot downgrade a v1 binding, select unsupported models or omit its policy on retry", async () => {
  const old = fixture();
  await old.report();
  const rejected = await old.report(v2([old.inventory.capability_id]));
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, "VERIFICATION_MIGRATION_REVIEW_REQUIRED");
  assert.equal(old.binding.autoVerificationPolicy, undefined);
  for (const body of [v2(["sam.video_track"]), v2(["gulong_engine.agent_chat", "gulong_engine.agent_chat"]),
    { automatic_capability_ids: ["gulong_engine.agent_chat"] }, { migration_policy: "capability-v2" }]) {
    const f = fixture();
    const response = await f.report(body);
    assert.ok([400, 409].includes(response.status), JSON.stringify(response.body));
    assert.equal(f.binding.autoVerificationEnrolledAt, undefined);
    assert.equal(f.collection("capabilityAutoVerifications").rows.length, 0);
    assert.equal(f.collection("capabilityVerificationBudgets").rows.length, 0);
    f.assertNoBusinessOrders(); f.assertNoAccounting();
  }
  const f = fixture();
  assert.equal((await f.report(v2([f.inventory.capability_id]))).status, 200);
  const retry = await f.report();
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.body.code, "VERIFICATION_POLICY_REQUIRED");
  assert.deepEqual(f.binding.autoVerificationCapabilityIds, [f.inventory.capability_id]);
  f.assertNoBusinessOrders(); f.assertNoAccounting();
});

test("concurrent capability-v2 reports atomically union scopes and cannot return the node to legacy mode", async () => {
  const f = fixture("embedding"); const chat = extraChat();
  const results = await Promise.all([f.report(v2([f.inventory.capability_id], [f.inventory, chat])),
    f.report(v2([chat.capability_id], [f.inventory, chat]))]);
  assert.equal(results.every((result) => result.status === 200), true, JSON.stringify(results));
  assert.deepEqual(new Set(f.binding.autoVerificationCapabilityIds), new Set([f.inventory.capability_id, chat.capability_id]));
  assert.equal(f.collection("capabilityAutoVerifications").rows.every((row) => row.automaticMigrationEnabled === true && row.status === "pending"), true);
  assert.equal((await f.report(v2([], [f.inventory, chat]))).status, 200);
  assert.equal((await f.claim()).body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
  f.assertNoBusinessOrders(); f.assertNoAccounting();
});

test("the final claim fence applies a concurrent v2 migration only to the selected capability", async () => {
  for (const sameCapability of [false, true]) {
    const f = fixture("embedding"); historicalAcceptance(f); const chat = extraChat();
    await f.claim();
    const created = await f.create(f.inventory.models[0].id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    let reads = 0, concurrent = null;
    f.hooks.findOne = async (name, query) => {
      if (name !== "nodeAccountBindings" || String(query._id) !== String(f.binding._id) || ++reads !== 2) return;
      f.hooks.findOne = null;
      concurrent = await f.report(v2([sameCapability ? f.inventory.capability_id : chat.capability_id], [f.inventory, chat]));
    };
    const claimed = await f.claim();
    assert.equal(concurrent?.status, 200, JSON.stringify(concurrent));
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    if (sameCapability) {
      assert.equal(claimed.body.task, null);
      assert.equal(claimed.body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
      assert.equal(f.collection("capabilityOrders").rows[0].status, "queued");
      assert.equal(f.collection("capabilityNodeSlots").rows.flatMap((row) => row.leases || []).length, 0);
    } else assert.equal(claimed.body.task.id, created.body.order.id, "an unrelated migration cannot block this valid legacy claim");
    f.assertNoAccounting();
  }
});

test("concurrent v1 and v2 enrollment cannot weaken the winning server migration policy", async () => {
  for (const v2First of [true, false]) {
    const f = fixture();
    const actions = [() => f.report(v2([f.inventory.capability_id])), () => f.report()];
    if (!v2First) actions.reverse();
    const results = await Promise.all(actions.map((action) => action()));
    assert.equal(results.filter((result) => result.status === 200).length, 1, JSON.stringify(results));
    const rejected = results.find((result) => result.status !== 200);
    assert.equal(rejected.status, 409, JSON.stringify(results));
    assert.equal(rejected.body.code, f.binding.autoVerificationPolicy === "capability-v2"
      ? "VERIFICATION_POLICY_REQUIRED" : "VERIFICATION_MIGRATION_REVIEW_REQUIRED");
    assert.equal((await f.claim()).body.claim_plan.code, "CAPABILITY_VERIFICATION_PENDING");
    f.assertNoAccounting(); f.assertNoBusinessOrders();
  }
});

test("new unsupported variants of an already migrated capability invalidate old automatic proofs without a legacy fallback", async () => {
  const f = fixture(); historicalAcceptance(f);
  await f.claim();
  assert.equal((await f.report(v2([f.inventory.capability_id]))).status, 200);
  f.inventory.models[0].tools = true;
  const changed = await f.report(v2([f.inventory.capability_id]));
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(changed.body.verifications.some((row) => row.model.tools === true && row.status === "adapter_required"));
  assert.ok(changed.body.verifications.some((row) => row.status === "invalidated"));
  assert.equal((await f.catalog()).dispatchable, false);
  assert.equal((await f.claim()).body.task, null);
  assert.equal(f.collection("capabilityConsumerAcceptances").rows[0].status, "active");
  f.assertNoAccounting(); f.assertNoBusinessOrders();
});

test("dedicated report-v2 refuses missing policy before enrollment and cannot fall back to binding-wide v1", async () => {
  const f = fixture();
  const wrong = await f.call("/api/v1/capability-verifications/report-v2", { capabilities: [f.inventory] }, true);
  assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
  assert.equal(f.binding.autoVerificationEnrolledAt, undefined);
  const good = await f.call("/api/v1/capability-verifications/report-v2", { ...v2([f.inventory.capability_id]), capabilities: [f.inventory] }, true);
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.migration.policy, "capability-v2");
  assert.deepEqual(f.binding.autoVerificationCapabilityIds, [f.inventory.capability_id]);
  assert.equal((await f.report()).status, 409);
  f.assertNoAccounting(); f.assertNoBusinessOrders();
});
