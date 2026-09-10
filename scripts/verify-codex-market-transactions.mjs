import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { MongoClient, ObjectId } from "mongodb";
import { registerCodexMarketRoutes, CODEX_NODE_HEADER } from "../server/codex-market.js";

const uri = process.env.MONGODB_URI?.trim();
if (!uri) throw new Error("缺少 MONGODB_URI，无法执行真实 MongoDB 事务验收");

const requestedCleanup = String(process.env.CODEX_MARKET_ACCEPTANCE_CLEANUP_DB || "").trim();
const databaseName = requestedCleanup || `gcm_test_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
if (!/^gcm_test_[a-z0-9]+_[a-f0-9]{8}$/.test(databaseName) || databaseName.length > 38) throw new Error("临时数据库名称校验失败");
const temporaryCollections = ["users", "wallets", "codexMarketQuotes", "codexMarketTasks", "codexMarketNodes", "codexMarketCallbacks", "codexMarketLedger"];

const client = new MongoClient(uri, { appName: "gulong-codex-market-acceptance", serverSelectionTimeoutMS: 10_000 });
let injectPlatformCreditFailure = false;

try {
  await client.connect();
  const db = client.db(databaseName);
  if (requestedCleanup) {
    for (const name of temporaryCollections) await db.collection(name).deleteMany({});
    process.stdout.write(JSON.stringify({ ok: true, cleanup: "documents-deleted", database: "isolated-temporary" }) + "\n");
  } else {
  const hello = await db.command({ hello: 1 });
  assert.ok(hello.setName || hello.msg === "isdbgrid", "MongoDB 必须是副本集或 mongos");

  const requester = new ObjectId();
  const executor = new ObjectId();
  const administrator = new ObjectId();
  await db.collection("users").insertMany([
    { _id: requester, role: "user", status: "active", createdAt: new Date("2026-09-10T00:00:00Z") },
    { _id: executor, role: "user", status: "active", createdAt: new Date("2026-09-10T00:00:01Z") },
    { _id: administrator, role: "admin", status: "active", createdAt: new Date("2026-09-10T00:00:02Z") },
  ]);
  await db.collection("wallets").insertOne({ _id: new ObjectId(), ownerId: requester, balanceFen: 1_000, createdAt: new Date() });

  async function ensureStore() {
    await Promise.all([
      db.collection("codexMarketQuotes").createIndex({ ownerId: 1, requestId: 1 }, { unique: true }),
      db.collection("codexMarketTasks").createIndex({ ownerId: 1, requestId: 1 }, { unique: true }),
      db.collection("codexMarketTasks").createIndex({ quoteId: 1 }, { unique: true }),
      db.collection("codexMarketNodes").createIndex({ ownerId: 1, nodeId: 1 }, { unique: true }),
      db.collection("codexMarketNodes").createIndex({ tokenHash: 1 }, { unique: true }),
      db.collection("codexMarketCallbacks").createIndex({ taskId: 1, claimId: 1, eventId: 1 }, { unique: true }),
      db.collection("codexMarketLedger").createIndex({ key: 1 }, { unique: true }),
      db.collection("wallets").createIndex({ ownerId: 1 }, { unique: true }),
    ]);
  }

  async function getCollection(name) {
    const collection = db.collection(name);
    if (name !== "wallets") return collection;
    return new Proxy(collection, {
      get(target, property) {
        if (property === "updateOne") return async (filter, update, options) => {
          if (injectPlatformCreditFailure && String(filter.ownerId) === String(administrator) && Number(update?.$inc?.balanceFen) > 0) {
            throw new Error("注入的平台钱包写入失败");
          }
          return target.updateOne(filter, update, options);
        };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async function transaction(operation) {
    const session = client.startSession();
    try {
      return await session.withTransaction(() => operation(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        maxCommitTimeMS: 10_000,
      });
    } finally {
      await session.endSession();
    }
  }

  const app = new OpenAPIHono();
  registerCodexMarketRoutes(app, {
    getCollection,
    ensureStore,
    transaction,
    enforceRateLimit: async () => ({ allowed: true }),
    requireTrustedMutation: () => null,
    hashToken: (token, purpose) => `${purpose}:${token}`,
    authenticate: async (c) => {
      const account = c.req.header("x-test-account") || "requester";
      const userId = { requester, executor, administrator }[account];
      const user = userId ? await db.collection("users").findOne({ _id: userId }) : null;
      return user ? { user: { ...user, id: String(user._id) } } : { error: c.json({ code: "UNAUTHORIZED" }, 401) };
    },
  });

  async function call(path, value, { account = "requester", token } = {}) {
    const response = await app.request(`http://localhost/api/codex-market${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: { "x-test-account": account, ...(token ? { [CODEX_NODE_HEADER]: token } : {}), "Content-Type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, body: await response.json() };
  }

  const usageLimit = { inputTokens: 271_999, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 1 };
  const quote = await call("/quotes", { model: "longyan", requestId: "mongo-longyan-quote", request: { prompt: "真实事务验收" }, usageLimit });
  assert.equal(quote.status, 201);
  assert.equal(quote.body.chargedFen, 109);
  const created = await call("/tasks", { quoteId: quote.body.quoteId, requestId: "mongo-longyan-task" });
  assert.equal(created.status, 201);
  const replay = await call("/tasks", { quoteId: quote.body.quoteId, requestId: "mongo-longyan-task" });
  assert.equal(replay.status, 200);
  assert.equal((await db.collection("wallets").findOne({ ownerId: requester })).balanceFen, 891);
  assert.equal(await db.collection("codexMarketTasks").countDocuments(), 1);
  assert.equal(await db.collection("codexMarketLedger").countDocuments({ kind: "reserve" }), 1);

  const registration = await call("/nodes/register", { nodeId: "mongo-node-0001", nodeName: "真实事务节点", capabilities: { codexAvailable: true, models: ["longyan"], usageReportingVersion: "codex-app-server-v1" } }, { account: "executor" });
  assert.equal(registration.status, 201);
  const claimed = await call("/tasks/claim", { nodeId: "mongo-node-0001" }, { token: registration.body.nodeToken });
  assert.equal(claimed.status, 200);
  const task = claimed.body.task;
  const callback = {
    nodeId: "mongo-node-0001",
    taskId: task.id,
    claimId: task.claimId,
    leaseToken: task.leaseToken,
    eventId: "mongo-complete-0001",
    status: "completed",
    result: { text: "真实事务完成", images: [] },
    usage: { source: "codex_app_server", providerRequestId: "mongo-provider-0001", inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: null, cacheReadTokens: 0, cacheWriteTokensMeasured: false },
  };

  injectPlatformCreditFailure = true;
  const failedCommit = await call("/tasks/callback", callback, { token: registration.body.nodeToken });
  assert.equal(failedCommit.status, 500);
  assert.equal((await db.collection("codexMarketTasks").findOne({ _id: new ObjectId(task.id) })).status, "claimed");
  assert.equal(await db.collection("codexMarketCallbacks").countDocuments(), 0);
  assert.equal(await db.collection("codexMarketLedger").countDocuments(), 1);
  assert.equal(await db.collection("wallets").countDocuments(), 1);

  injectPlatformCreditFailure = false;
  const settled = await call("/tasks/callback", callback, { token: registration.body.nodeToken });
  assert.equal(settled.status, 200);
  const duplicate = await call("/tasks/callback", callback, { token: registration.body.nodeToken });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.idempotent, true);

  const wallets = await db.collection("wallets").find({}).toArray();
  const balance = (ownerId) => wallets.find((wallet) => String(wallet.ownerId) === String(ownerId))?.balanceFen || 0;
  assert.equal(balance(requester), 961);
  assert.equal(balance(executor), 19);
  assert.equal(balance(administrator), 20);
  assert.equal(balance(requester) + balance(executor) + balance(administrator), 1_000, "请求者扣款必须完整转入节点和平台，三方总账守恒");
  assert.equal(await db.collection("codexMarketCallbacks").countDocuments(), 1);
  assert.equal(await db.collection("codexMarketLedger").countDocuments(), 4);

  process.stdout.write(JSON.stringify({ ok: true, database: "isolated-temporary", transactionStore: hello.msg === "isdbgrid" ? "mongos" : "replica-set", pricingRevision: quote.body.pricingRevision, reservedFen: 109, actualFen: 39, refundFen: 70, nodeShareFen: 19, platformShareFen: 20, duplicateCallbackIdempotent: true, injectedFailureRolledBack: true }) + "\n");
  }
} finally {
  if (client.topology && /^gcm_test_/.test(databaseName)) {
    const db = client.db(databaseName);
    for (const name of temporaryCollections) {
      try { await db.collection(name).deleteMany({}); } catch (error) { if (error?.codeName !== "NamespaceNotFound") throw error; }
    }
    try { await db.dropDatabase(); } catch (error) { if (error?.code !== 8000) throw error; }
  }
  await client.close();
}
