import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { hasAcceptedH3NoCharge, h3TaskRequestFingerprint, normalizeH3TaskInput, registerH3SharedRoutes } from "../../server/h3-shared.js";

const body = (overrides = {}) => ({ source_channel: "desktop_agent", model: "minimax_h3_shared", prompt: "雨夜追车", duration_seconds: 5, aspect_ratio: "9:16", profile: "balanced", assets: { images: [], videos: [], audio: [] }, ...overrides });
function equal(a, b) {
  if (b == null) return a == null;
  if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
  if (a instanceof Date || b instanceof Date) return Number(a) === Number(b);
  return a === b;
}
function matches(record, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(item => matches(record, item));
    const actual = key.split(".").reduce((value, part) => value?.[part], record);
    if (!expected || typeof expected !== "object" || expected instanceof Date || expected instanceof ObjectId) return equal(actual, expected);
    return Object.entries(expected).every(([operator, value]) => {
      if (operator === "$in") return value.some(item => equal(actual, item));
      if (operator === "$nin") return value.every(item => !equal(actual, item));
      if (operator === "$ne") return !equal(actual, value);
      if (operator === "$exists") return (actual !== undefined) === value;
      if (operator === "$gt") return actual > value;
      throw new Error(`Unhandled test operator: ${operator}`);
    });
  });
}
function fixture({ role = "user", membership = "inactive", balanceFen = 50_000, grouped = false } = {}) {
  const app = new OpenAPIHono(), ownerId = new ObjectId();
  const state = { membership, failure: "", writes: [], inserts: 0 };
  const rows = new Map([
    ["users", [{ _id: ownerId, status: "active", role, email: "fixture@example.com" }]],
    ["h3SharedTasks", []],
    ["wallets", [{ _id: new ObjectId(), ownerId, balanceFen, shortVideoPackageBalanceFen: 0, ledgerKeys: [], ledgerEntries: [] }]],
  ]);
  function apply(record, update) {
    Object.assign(record, update.$set || {});
    for (const [key, value] of Object.entries(update.$inc || {})) record[key] = Number(record[key] || 0) + value;
    for (const key of Object.keys(update.$unset || {})) delete record[key];
  }
  const collections = new Map();
  function collection(name) {
    if (collections.has(name)) return collections.get(name);
    if (!rows.has(name)) rows.set(name, []);
    const records = rows.get(name);
    const api = {
      async findOne(filter = {}) {
        if (name === "subscriptions") {
          if (state.failure === "membership") throw new Error("membership unavailable");
          if (state.membership === "inactive") return null;
          const result = { ownerId, products: { gulong_engine_monthly: { enabled: state.membership !== "cancelled", status: state.membership === "cancelled" ? "cancelled" : "active", currentPeriodStart: new Date(Date.now() + (state.membership === "scheduled" ? 60_000 : -86_400_000)), currentPeriodEnd: new Date(Date.now() + (state.membership === "expired" ? -1000 : 3_600_000)) } } };
          // Revoke immediately after the authoritative observation. Billing must
          // stay on the observed free branch, not fall through to paid fallback.
          if (state.failure === "concurrent_revoke") state.membership = "expired";
          return result;
        }
        return records.find(item => matches(item, filter)) || null;
      },
      async insertOne(record) {
        state.writes.push({ collection: name, operation: "insert" });
        if (name === "h3SharedTasks") {
          if (state.failure === "insert") throw new Error("task insert unavailable");
          if (records.some(item => item.idempotencyKey === record.idempotencyKey)) throw Object.assign(new Error("duplicate"), { code: 11000 });
          state.inserts++;
        }
        if (name === "h3TaskAudits" && state.failure === "audit") throw new Error("audit unavailable");
        records.push(record);
        return { insertedId: record._id || new ObjectId() };
      },
      async updateOne(filter, update) {
        state.writes.push({ collection: name, operation: "update" });
        const record = records.find(item => matches(item, filter));
        if (!record) return { matchedCount: 0 };
        apply(record, update); return { matchedCount: 1 };
      },
      async findOneAndUpdate(filter, update) {
        state.writes.push({ collection: name, operation: "update" });
        const record = records.find(item => matches(item, filter));
        if (record) apply(record, update);
        return record || null;
      },
    };
    collections.set(name, api); return api;
  }
  registerH3SharedRoutes(app, {
    getUserComputeGroupId: async () => grouped ? "gug_" + "1".repeat(32) : null,
    getCollection: async name => collection(name), enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: String(ownerId), role, email: "fixture@example.com" } }),
    requireAdmin: async () => ({ user: { id: String(ownerId), role: "admin" } }),
    requireTrustedMutation: () => null, queueCoordinator: { invalidate: async () => {} },
  });
  const submit = (overrides = {}, key = "no-charge-request-0001") => app.request("/api/h3/tasks", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body({ require_no_charge: true, ...overrides })) });
  function noFinancialWrites() {
    assert.deepEqual(state.writes.filter(item => /wallet|ledger|subscription/i.test(item.collection)), []);
    assert.equal(rows.get("wallets")[0].balanceFen, balanceFen);
    assert.equal(rows.get("wallets")[0].shortVideoPackageBalanceFen, 0);
    assert.deepEqual(rows.get("wallets")[0].ledgerKeys, []);
  }
  return { app, state, rows, submit, noFinancialWrites };
}

test("explicit no-charge true enters the fingerprint; absent and false retain legacy semantics", () => {
  const absent = normalizeH3TaskInput(body()), falseInput = normalizeH3TaskInput(body({ require_no_charge: false })), trueInput = normalizeH3TaskInput(body({ require_no_charge: true }));
  assert.equal(Object.hasOwn(absent, "requireNoCharge"), false);
  assert.deepEqual(absent, falseInput);
  assert.equal(h3TaskRequestFingerprint(absent), h3TaskRequestFingerprint(falseInput));
  assert.notEqual(h3TaskRequestFingerprint(absent), h3TaskRequestFingerprint(trueInput));
  assert.equal(trueInput.requireNoCharge, true);
});
test("non-boolean no-charge fields fail before task and financial mutations", async () => {
  for (const value of [null, 0, 1, "true", "false", {}, []]) {
    const f = fixture(), response = await f.submit({ require_no_charge: value });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, "VALIDATION_ERROR");
    assert.deepEqual(f.state.writes, []); f.noFinancialWrites();
  }
});
for (const membership of ["inactive", "expired", "scheduled", "cancelled"]) {
  test(`no-charge rejects ${membership} entitlement despite sufficient wallet balance`, async () => {
    for (const grouped of [false, true]) {
      const f = fixture({ membership, balanceFen: 100_000, grouped }), response = await f.submit();
      assert.equal(response.status, 403); assert.equal((await response.json()).code, "H3_NO_CHARGE_ENTITLEMENT_REQUIRED");
      assert.equal(f.rows.get("h3SharedTasks").length, 0); assert.deepEqual(f.state.writes, []); f.noFinancialWrites();
    }
  });
}
for (const [label, options, chargeStatus, billingMode] of [
  ["member", { membership: "active", balanceFen: 0 }, "member_no_charge", "gulong_engine_membership"],
  ["administrator", { role: "admin", balanceFen: 0 }, "exempt", "administrator_exempt"],
]) {
  test(`zero-balance ${label} receives a truthful zero-charge receipt and replay`, async () => {
    const f = fixture(options), response = await f.submit(); assert.equal(response.status, 201);
    const receipt = await response.json(), stored = f.rows.get("h3SharedTasks")[0];
    assert.equal(receipt.task.requireNoCharge, true); assert.equal(receipt.task.chargedFen, 0);
    assert.equal(receipt.task.chargeStatus, chargeStatus); assert.equal(receipt.task.billingMode, billingMode);
    assert.equal(receipt.billing.chargedFen, 0); assert.equal(stored.walletLedgerId, undefined); assert.equal(stored.activeChargeKey, undefined);
    assert.equal((await f.submit()).status, 200); assert.equal(f.state.inserts, 1); f.noFinancialWrites();
  });
}
test("a true promise cannot replay an old charged request, even without its saved fingerprint", async () => {
  for (const missingFingerprint of [false, true]) {
    const f = fixture({ membership: "active" }); assert.equal((await f.submit({ require_no_charge: undefined })).status, 201);
    const old = f.rows.get("h3SharedTasks")[0];
    Object.assign(old, { chargeStatus: "reserved", chargedFen: old.priceFen, billingMode: "wallet", activeChargeKey: "historical", walletLedgerId: "historical" });
    if (missingFingerprint) delete old.requestFingerprint;
    f.state.writes.length = 0;
    const response = await f.submit(); assert.equal(response.status, 409); assert.equal((await response.json()).code, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal(old.chargedFen, 100); assert.deepEqual(f.state.writes, []); f.noFinancialWrites();
  }
});
test("missing-fingerprint recovery preserves a persisted true promise after entitlement expiry", async () => {
  const f = fixture({ membership: "active" }); assert.equal((await f.submit()).status, 201);
  delete f.rows.get("h3SharedTasks")[0].requestFingerprint; f.state.membership = "expired";
  const response = await f.submit(); assert.equal(response.status, 200);
  const receipt = await response.json(); assert.equal(receipt.idempotent, true); assert.equal(receipt.task.requireNoCharge, true);
  assert.equal(receipt.billing.chargedFen, 0); assert.equal(f.state.inserts, 1); f.noFinancialWrites();
});
test("concurrent identical promises produce one order; true/false collisions are rejected", async () => {
  const f = fixture({ membership: "active" });
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.submit()));
  assert.equal(responses.filter(r => r.status === 201).length, 1); assert.equal(responses.filter(r => r.status === 200).length, 5);
  const receipts = await Promise.all(responses.map(r => r.json())); assert.equal(new Set(receipts.map(r => r.task.id)).size, 1);
  const conflict = await f.submit({ require_no_charge: false }); assert.equal(conflict.status, 409);
  const mixed = fixture({ membership: "active" });
  assert.deepEqual((await Promise.all([mixed.submit(), mixed.submit({ require_no_charge: false })])).map(r => r.status).sort(), [201, 409]);
  assert.equal(f.state.inserts, 1); f.noFinancialWrites(); mixed.noFinancialWrites();
});
test("entitlement observation cannot fall back to paid billing after concurrent revocation", async () => {
  const f = fixture({ membership: "active" }); f.state.failure = "concurrent_revoke";
  const response = await f.submit(); assert.equal(response.status, 201); assert.equal(f.state.membership, "expired");
  assert.equal((await response.json()).billing.chargedFen, 0); f.noFinancialWrites();
});
test("membership/task database failures never enter a billing fallback", async () => {
  for (const failure of ["membership", "insert"]) {
    const f = fixture({ membership: "active" }); f.state.failure = failure;
    assert.equal((await f.submit()).status, 500); assert.equal(f.rows.get("h3SharedTasks").length, 0); f.noFinancialWrites();
  }
});
test("failure after free admission recovers the original order without billing", async () => {
  const f = fixture({ membership: "active" }); f.state.failure = "audit";
  assert.equal((await f.submit()).status, 500); assert.equal(f.rows.get("h3SharedTasks").length, 1); f.noFinancialWrites();
  f.state.failure = ""; assert.equal((await f.submit()).status, 200); assert.equal(f.state.inserts, 1); f.noFinancialWrites();
});
test("administrator retry cannot turn an expired member's persisted promise into paid billing", async () => {
  const f = fixture({ membership: "active" }); assert.equal((await f.submit()).status, 201);
  const task = f.rows.get("h3SharedTasks")[0]; task.status = "failed"; f.state.membership = "expired"; f.state.writes.length = 0;
  const retry = () => f.app.request(`/api/admin/h3/tasks/${task._id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ require_no_charge: false }) });
  const denied = await retry(); assert.equal(denied.status, 403); assert.equal((await denied.json()).code, "H3_NO_CHARGE_ENTITLEMENT_REQUIRED");
  assert.equal(task.status, "failed"); assert.equal(task.retryCount, 0); assert.deepEqual(f.state.writes, []); f.noFinancialWrites();
  f.state.membership = "active"; assert.equal((await retry()).status, 200);
  assert.equal(task.retryCount, 1); assert.equal(task.requireNoCharge, true); assert.equal(task.chargedFen, 0); assert.equal(task.chargeStatus, "member_no_charge"); f.noFinancialWrites();
});
test("free admission evidence requires all server-owned billing fields, not just the request flag", () => {
  const valid = { requireNoCharge: true, chargedFen: 0, chargeStatus: "member_no_charge", billingMode: "gulong_engine_membership" };
  assert.equal(hasAcceptedH3NoCharge(valid), true);
  for (const changed of [{ chargedFen: 1 }, { chargeStatus: "reserved" }, { billingMode: "wallet" }, { requireNoCharge: false }]) assert.equal(hasAcceptedH3NoCharge({ ...valid, ...changed }), false);
});
test("H3 tool and OpenAPI publish the exact optional no-charge request contract", async () => {
  const f = fixture(), response = await f.app.request("/api/v1/desktop/agent/tools/minimax-h3-shared");
  const policy = (await response.json()).tool.noChargeCreation;
  assert.deepEqual({ ...policy, enforced: false }, { version: 1, requestField: "require_no_charge", enforced: false, onUnavailable: "reject_without_order_or_charge" });
  assert.equal(typeof policy.enforced, "boolean");
  assert.equal(policy.enforced, true, "activation is permitted only after the dual-target guard baseline");
  const document = f.app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  const post = document.paths["/api/h3/tasks"].post, schema = post.requestBody.content["application/json"].schema;
  assert.equal(schema.properties.require_no_charge.type, "boolean"); assert.ok(!schema.required.includes("require_no_charge"));
  assert.ok(post.responses[403]); assert.ok(document.paths["/api/admin/h3/tasks/{id}/retry"].post.responses[403]);
});
