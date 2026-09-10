import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { registerCodexMarketRoutes, CODEX_NODE_HEADER } from "../../server/codex-market.js";
import { calculateLongyanAmount, marketQuotePrice, normalizeMarketRequest, readMarketPricing } from "../../server/codex-market-pricing.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6jU8AAAAASUVORK5CYII=";
const valueOf = (value) => value instanceof ObjectId ? value.toString() : value instanceof Date ? +value : value;
const equal = (left, right) => valueOf(left) === valueOf(right);
function matches(document, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((branch) => matches(document, branch));
    const actual = document[key];
    if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]) => {
        if (operator === "$in") return expected.some((item) => equal(actual, item));
        if (operator === "$gt") return valueOf(actual) > valueOf(expected);
        if (operator === "$gte") return valueOf(actual) >= valueOf(expected);
        if (operator === "$lte") return valueOf(actual) <= valueOf(expected);
        throw new Error(`Unsupported test query ${operator}`);
      });
    }
    return equal(actual, value);
  });
}
function clone(value) {
  if (value instanceof ObjectId) return new ObjectId(value);
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
}

// A transaction harness checks that every financial mutation carries a session
// and that injected failures roll back the complete unit of work. It does not
// claim to test MongoDB's replication or distributed transaction implementation.
function fixture({ balance = 100, failStore = false, getPricing = readMarketPricing } = {}) {
  const requester = new ObjectId(); const executor = new ObjectId(); const administrator = new ObjectId();
  const accounts = { requester, executor, administrator };
  const rows = { users: [
    { _id: requester, role: "user", status: "active" },
    { _id: executor, role: "user", status: "active" },
    { _id: administrator, role: "admin", status: "active" },
  ], wallets: [{ _id: new ObjectId(), ownerId: requester, balanceFen: balance }] };
  const session = { testSession: true };
  let now = new Date("2026-09-10T00:00:00Z");
  let tail = Promise.resolve();
  let failPlatformCredit = false;
  let transactionCount = 0;
  function check(options) { assert.equal(options?.session, session, "every mutation must participate in the database transaction"); }
  function update(document, operations, inserted = false) {
    if (inserted) Object.assign(document, clone(operations.$setOnInsert || {}));
    Object.assign(document, clone(operations.$set || {}));
    for (const [key, value] of Object.entries(operations.$inc || {})) document[key] = (document[key] || 0) + value;
    for (const key of Object.keys(operations.$unset || {})) delete document[key];
  }
  const getCollection = async (name) => {
    rows[name] ||= [];
    return {
      findOne: async (filter) => clone(rows[name].find((row) => matches(row, filter)) || null),
      find: (filter) => {
        let result = rows[name].filter((row) => matches(row, filter));
        const cursor = { sort: () => cursor, limit: (count) => { result = result.slice(0, count); return cursor; }, toArray: async () => clone(result) };
        return cursor;
      },
      insertOne: async (document, options) => { check(options); rows[name].push(clone(document)); return { insertedId: document._id }; },
      updateOne: async (filter, operations, options) => {
        check(options);
        if (failPlatformCredit && name === "wallets" && equal(filter.ownerId, administrator) && operations.$inc?.balanceFen > 0) throw new Error("Injected platform wallet failure");
        let row = rows[name].find((item) => matches(item, filter));
        if (!row && options?.upsert) { row = { _id: new ObjectId(), ...clone(filter) }; update(row, operations, true); rows[name].push(row); }
        else if (row) update(row, operations);
        return { matchedCount: row ? 1 : 0 };
      },
      updateMany: async (filter, operations, options) => { check(options); for (const row of rows[name].filter((item) => matches(item, filter))) update(row, operations); },
      findOneAndUpdate: async (filter, operations, options) => {
        check(options);
        const row = rows[name].find((item) => matches(item, filter));
        if (!row) return null;
        update(row, operations);
        return clone(row);
      },
    };
  };
  const app = new OpenAPIHono();
  registerCodexMarketRoutes(app, {
    getCollection, ensureStore: async () => { if (failStore) throw Object.assign(new Error("No replica set"), { code: 20 }); },
    getPricing,
    now: () => now,
    hashToken: (token, purpose) => `${purpose}:${token}`,
    transaction: async (operation) => {
      const previous = tail;
      let release; tail = new Promise((resolve) => { release = resolve; });
      await previous;
      transactionCount += 1;
      const snapshot = clone(rows);
      try { return await operation(session); }
      catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, snapshot); throw error; }
      finally { release(); }
    },
    enforceRateLimit: async () => ({ allowed: true }), requireTrustedMutation: () => null,
    authenticate: async (c) => {
      const user = rows.users.find((item) => equal(item._id, accounts[c.req.header("x-test-account") || "requester"]));
      return user ? { user: { ...user, id: String(user._id) } } : { error: c.json({ code: "UNAUTHORIZED" }, 401) };
    },
  });
  const call = async (path, value, { account = "requester", token } = {}) => {
    const response = await app.request(`http://localhost/api/codex-market${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: { "x-test-account": account, ...(token ? { [CODEX_NODE_HEADER]: token } : {}), "Content-Type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const quote = async (requestKey = "request-0001", account = "requester", model = "longtu", usageLimit) => call("/quotes", { requestId: requestKey, model, request: { prompt: "一片荷叶" }, ...(usageLimit ? { usageLimit } : {}) }, { account });
  const create = async (requestKey = "request-0001", account = "requester", model = "longtu", usageLimit) => {
    const quoted = await quote(requestKey, account, model, usageLimit);
    assert.equal(quoted.status, 201);
    return call("/tasks", { quoteId: quoted.body.quoteId, requestId: requestKey }, { account });
  };
  const register = async (clientNodeId = "test-node-01", usageReportingVersion = "codex-app-server-v1") => {
    const result = await call("/nodes/register", { nodeId: clientNodeId, nodeName: "测试节点", appVersion: "1.0", capabilities: { codexAvailable: true, models: ["longyan", "longtu"], usageReportingVersion } }, { account: "executor" });
    assert.equal(result.status, 201);
    return { nodeId: clientNodeId, token: result.body.nodeToken };
  };
  const claim = async (node) => call("/tasks/claim", { nodeId: node.nodeId }, { token: node.token });
  const callback = async (node, task, overrides = {}) => call("/tasks/callback", { nodeId: node.nodeId, taskId: task.id, claimId: task.claimId, leaseToken: task.leaseToken, eventId: "complete-0001", status: "completed", result: { images: [{ dataUrl: PNG }] }, ...overrides }, { token: node.token });
  return { app, call, quote, create, register, claim, callback, rows, accounts, advance: (ms) => { now = new Date(+now + ms); }, setPlatformFailure: (value) => { failPlatformCredit = value; }, transactionCount: () => transactionCount };
}

test("official Longtu and tiered Longyan prices match the desktop manifest", async () => {
  assert.deepEqual(marketQuotePrice(readMarketPricing(), "longtu").chargedFen, 14);
  assert.equal(marketQuotePrice(readMarketPricing(), "longtu").nodeShareFen, 7);
  const standard = calculateLongyanAmount({ inputTokens: 271_999, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 1 });
  const extended = calculateLongyanAmount({ inputTokens: 271_999, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 2 });
  assert.deepEqual({ tier: standard.tier, amountFen: standard.amountFen, totalInputTokens: standard.totalInputTokens }, { tier: "standard", amountFen: 109, totalInputTokens: 272_000 });
  assert.deepEqual({ tier: extended.tier, amountFen: extended.amountFen, totalInputTokens: extended.totalInputTokens }, { tier: "extended", amountFen: 216, totalInputTokens: 272_001 });
  assert.equal(calculateLongyanAmount({ inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }).amountFen, 39);
  assert.equal(calculateLongyanAmount({ inputTokens: 0, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0 }).amountFen, 195);
  assert.equal(calculateLongyanAmount({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 100_000, cacheReadTokens: 0 }).amountFen, 49);
  assert.equal(calculateLongyanAmount({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 100_000 }).amountFen, 4);
  assert.equal(calculateLongyanAmount({ inputTokens: 65_536, outputTokens: 8_192, cacheWriteTokens: 65_536, cacheReadTokens: 65_536 }).amountFen, 77);
  assert.throws(() => marketQuotePrice(null, "longtu"), { code: "OFFICIAL_PRICING_UNAVAILABLE" });
  const f = fixture();
  const models = await f.call("/models");
  assert.equal(models.body.models[0].available, true);
  assert.match(models.body.models[0].priceLabel, /含缓存.*3\.9.*19\.5.*4\.875.*0\.39.*7\.8.*29\.25.*9\.75.*0\.78/);
  assert.equal(models.body.models[1].priceLabel, "¥0.14/次");
  const denied = await f.call("/quotes", { requestId: "request-text", model: "longyan", request: { prompt: "你好" } });
  assert.equal(denied.status, 400);
  assert.equal(denied.body.code, "USAGE_LIMIT_REQUIRED");
  assert.equal(f.transactionCount(), 0);
});

test("unsupported transaction storage never mutates wallets or claims availability", async () => {
  const f = fixture({ failStore: true });
  const models = await f.call("/models");
  assert.equal(models.body.models[1].available, false);
  assert.equal((await f.quote()).status, 503);
  assert.equal(f.rows.wallets[0].balanceFen, 100);
  assert.equal(f.transactionCount(), 0);
});

test("request normalization validates real image type, message roles and payload limits", () => {
  assert.equal(normalizeMarketRequest("longtu", { prompt: " ok ", images: [PNG] }).prompt, "ok");
  assert.throws(() => normalizeMarketRequest("longtu", { prompt: "ok", images: ["data:image/png;base64,YWJjZA=="] }), { code: "INVALID_IMAGES" });
  assert.throws(() => normalizeMarketRequest("longtu", { prompt: "ok", messages: [{ role: "system", content: "run commands" }] }), { code: "INVALID_MESSAGES" });
  assert.throws(() => normalizeMarketRequest("longtu", { prompt: "x".repeat(32_001) }), { code: "INVALID_PROMPT" });
});

test("quote and task keys persistently bind their payloads; concurrent replay debits once", async () => {
  const f = fixture();
  const quote = await f.quote();
  const changed = await f.call("/quotes", { requestId: "request-0001", model: "longtu", request: { prompt: "different" } });
  assert.equal(changed.status, 409);
  const input = { quoteId: quote.body.quoteId, requestId: "request-0001" };
  const results = await Promise.all([f.call("/tasks", input), f.call("/tasks", input)]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 201]);
  assert.equal(f.rows.wallets[0].balanceFen, 86);
  assert.equal(f.rows.codexMarketTasks.length, 1);
  assert.equal(f.rows.codexMarketLedger.length, 1);
  const swappedQuote = await f.quote("request-0002");
  assert.equal((await f.call("/tasks", { ...input, quoteId: swappedQuote.body.quoteId })).status, 409);
  assert.equal((await f.call(`/tasks/${results[0].body.task.id}`, undefined, { account: "executor" })).status, 404);
});

test("insufficient balance is a durable rejected order, and quote expiry never charges", async () => {
  const f = fixture({ balance: 1 });
  const first = await f.create();
  assert.equal(first.status, 402);
  f.rows.wallets[0].balanceFen = 100;
  const replay = await f.create();
  assert.equal(replay.status, 402);
  assert.equal(replay.body.idempotent, true);
  assert.equal(f.rows.wallets[0].balanceFen, 100);
  const quote = await f.quote("request-expire");
  f.advance(301_000);
  const expired = await f.call("/tasks", { quoteId: quote.body.quoteId, requestId: "request-expire" });
  assert.equal(expired.body.code, "QUOTE_EXPIRED");
  assert.equal(f.rows.wallets[0].balanceFen, 100);
});

test("lease replay is stable; stale claims and another node cannot submit results", async () => {
  const f = fixture();
  await f.create();
  const firstNode = await f.register();
  const first = (await f.claim(firstNode)).body.task;
  assert.equal((await f.claim(firstNode)).body.task.leaseToken, first.leaseToken);
  const nextNode = await f.register("test-node-02");
  assert.equal((await f.callback(nextNode, first)).body.code, "LEASE_CONFLICT");
  assert.equal((await f.claim(nextNode)).body.task, null);
  f.advance(121_000);
  assert.equal((await f.callback(firstNode, first)).body.code, "LEASE_EXPIRED");
  const next = (await f.claim(nextNode)).body.task;
  assert.equal(next.id, first.id);
  assert.notEqual(next.claimId, first.claimId);
  assert.equal((await f.callback(firstNode, first)).body.code, "LEASE_CONFLICT");
  assert.equal((await f.callback(nextNode, next)).status, 200);
});

test("heartbeat extends only its own current lease; completion settles exactly 7/7 once", async () => {
  const f = fixture();
  await f.create();
  const node = await f.register();
  const task = (await f.claim(node)).body.task;
  f.advance(100_000);
  assert.equal((await f.call("/nodes/heartbeat", { nodeId: node.nodeId, activeTask: { taskId: task.id, claimId: task.claimId, leaseToken: task.leaseToken } }, { token: node.token })).status, 200);
  f.advance(100_000);
  assert.equal((await f.callback(node, task)).status, 200);
  const replay = await f.callback(node, task);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(f.rows.wallets.find((row) => equal(row.ownerId, f.accounts.executor)).balanceFen, 7);
  assert.equal(f.rows.wallets.find((row) => equal(row.ownerId, f.accounts.administrator)).balanceFen, 7);
  assert.equal(f.rows.codexMarketLedger.length, 3);
  const changed = await f.callback(node, task, { status: "failed", error: { message: "later error" } });
  assert.equal(changed.body.code, "CALLBACK_CONFLICT");
});

test("platform credit failure rolls back node credit, result and event; retry completes", async () => {
  const f = fixture();
  await f.create();
  const node = await f.register();
  const task = (await f.claim(node)).body.task;
  f.setPlatformFailure(true);
  assert.equal((await f.callback(node, task)).status, 500);
  assert.equal(f.rows.codexMarketTasks[0].status, "claimed");
  assert.equal(f.rows.codexMarketLedger.length, 1);
  assert.equal(f.rows.wallets.length, 1);
  assert.equal(f.rows.codexMarketCallbacks?.length || 0, 0);
  f.setPlatformFailure(false);
  assert.equal((await f.callback(node, task)).status, 200);
  assert.equal(f.rows.codexMarketTasks[0].status, "completed");
  assert.equal(f.rows.codexMarketLedger.length, 3);
});

test("failed tasks refund once, and timed out queued tasks refund when read", async () => {
  const f = fixture();
  await f.create();
  const node = await f.register();
  const task = (await f.claim(node)).body.task;
  const failed = { status: "failed", error: { code: "EXECUTION_ERROR", message: "cannot generate" } };
  assert.equal((await f.callback(node, task, failed)).status, 200);
  assert.equal((await f.callback(node, task, failed)).body.idempotent, true);
  assert.equal(f.rows.wallets[0].balanceFen, 100);
  assert.equal(f.rows.codexMarketLedger.filter((row) => row.kind === "refund").length, 1);
  const queued = await f.create("request-timeout");
  f.advance(3601_000);
  assert.equal((await f.call(`/tasks/${queued.body.task.id}`)).body.task.status, "failed");
  assert.equal(f.rows.wallets[0].balanceFen, 100);
  assert.equal((await f.call(`/tasks/${queued.body.task.id}`)).body.task.refundedFen, 14);
});

test("administrator exemption creates no reservation or commission", async () => {
  const f = fixture();
  const quote = await f.quote("admin-request", "administrator");
  assert.equal(quote.body.officialAmountFen, 14);
  assert.equal(quote.body.chargedFen, 0);
  assert.equal(quote.body.billingExempt, true);
  await f.create("admin-request", "administrator");
  const node = await f.register();
  assert.equal((await f.callback(node, (await f.claim(node)).body.task)).status, 200);
  assert.equal(f.rows.codexMarketLedger?.length || 0, 0);
  assert.equal(f.rows.wallets.length, 1);
});

test("Longyan reserves a billing ceiling and settles authenticated actual usage with one refund and a 50/50 split", async () => {
  const f = fixture({ balance: 200 });
  const usageLimit = { inputTokens: 271_999, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 1 };
  const created = await f.create("longyan-request", "requester", "longyan", usageLimit);
  assert.equal(created.status, 201);
  assert.equal(created.body.billing.chargedFen, 109);
  assert.equal(f.rows.wallets[0].balanceFen, 91);

  const legacyNode = await f.register("legacy-node-01", null);
  assert.equal((await f.claim(legacyNode)).body.task, null, "nodes without actual-usage reporting must not claim paid text work");
  const node = await f.register("usage-node-01");
  const task = (await f.claim(node)).body.task;
  assert.equal(task.model, "longyan");
  assert.deepEqual(task.usageLimit, usageLimit);
  assert.equal(task.usageReportingVersion, "codex-app-server-v1");

  const missing = await f.callback(node, task, { result: { text: "完成" } });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, "CODEX_USAGE_REQUIRED");
  assert.equal(f.rows.codexMarketTasks[0].status, "claimed");

  const incomplete = await f.callback(node, task, { result: { text: "完成" }, usage: { source: "codex_app_server", providerRequestId: "codex-request-01", inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cacheWriteTokensMeasured: false } });
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.body.code, "INVALID_USAGE");

  const usage = { source: "codex_app_server", providerRequestId: "codex-request-01", inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: null, cacheReadTokens: 0, cacheWriteTokensMeasured: false };
  const completed = await f.callback(node, task, { result: { text: "完成" }, usage });
  assert.equal(completed.status, 200);
  assert.equal((await f.callback(node, task, { result: { text: "完成" }, usage })).body.idempotent, true);
  const saved = f.rows.codexMarketTasks[0];
  assert.equal(saved.reservedFen, 109);
  assert.equal(saved.chargedFen, 39);
  assert.equal(saved.refundedFen, 70);
  assert.equal(saved.nodeShareFen, 19);
  assert.equal(saved.platformShareFen, 20);
  assert.equal(saved.pricingRevision, "desktop-20260910-v4");
  assert.equal(saved.usage.cacheWriteTokens, null);
  assert.equal(saved.usage.cacheWriteTokensMeasured, false);
  assert.equal(f.rows.wallets.find((row) => equal(row.ownerId, f.accounts.requester)).balanceFen, 161);
  assert.equal(f.rows.wallets.find((row) => equal(row.ownerId, f.accounts.executor)).balanceFen, 19);
  assert.equal(f.rows.wallets.find((row) => equal(row.ownerId, f.accounts.administrator)).balanceFen, 20);
  assert.deepEqual(f.rows.codexMarketLedger.map((row) => row.kind).sort(), ["node_commission", "platform_commission", "reservation_adjustment_refund", "reserve"]);
});

test("Longyan completion cannot exceed the user-authorized usage reservation", async () => {
  const f = fixture({ balance: 200 });
  const created = await f.create("longyan-ceiling", "requester", "longyan", { inputTokens: 100_000, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0 });
  assert.equal(created.status, 201);
  const node = await f.register();
  const task = (await f.claim(node)).body.task;
  const response = await f.callback(node, task, { result: { text: "不应结算" }, usage: { source: "codex_app_server", providerRequestId: "codex-request-02", inputTokens: 100_001, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0, cacheWriteTokensMeasured: true } });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "USAGE_EXCEEDS_RESERVATION");
  assert.equal(f.rows.codexMarketTasks[0].status, "claimed");
  assert.equal(f.rows.codexMarketLedger.length, 1);
});

test("Longyan settlement uses the order pricing snapshot after the directory revision changes", async () => {
  let currentPricing = readMarketPricing();
  const f = fixture({ balance: 200, getPricing: () => currentPricing });
  const created = await f.create("longyan-snapshot", "requester", "longyan", { inputTokens: 271_999, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 1 });
  assert.equal(created.status, 201);
  currentPricing = structuredClone(currentPricing);
  currentPricing.revision = "future-price";
  currentPricing.models[0].rates.standard.inputTokens = 9_999_999;
  const node = await f.register();
  const task = (await f.claim(node)).body.task;
  const usage = { source: "codex_app_server", providerRequestId: "codex-snapshot-01", inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: null, cacheReadTokens: 0, cacheWriteTokensMeasured: false };
  assert.equal((await f.callback(node, task, { result: { text: "按原价结算" }, usage })).status, 200);
  assert.equal(f.rows.codexMarketTasks[0].chargedFen, 39);
  assert.equal(f.rows.codexMarketTasks[0].pricingRevision, "desktop-20260910-v4");
});

test("re-registering a node revokes its prior token and lease", async () => {
  const f = fixture();
  await f.create();
  const oldNode = await f.register();
  const oldTask = (await f.claim(oldNode)).body.task;
  const currentNode = await f.register();
  assert.equal((await f.callback(oldNode, oldTask)).status, 401);
  const currentTask = (await f.claim(currentNode)).body.task;
  assert.notEqual(currentTask.claimId, oldTask.claimId);
  assert.equal((await f.callback(currentNode, oldTask)).body.code, "LEASE_CONFLICT");
});
