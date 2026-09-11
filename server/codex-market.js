import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { hashOpaqueToken } from "./security.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { codexMarketStorage } from "./codex-market-store.js";
import {
  CODEX_MARKET_MODELS, CODEX_MARKET_PRICING_REVISION, CODEX_MARKET_MAX_JSON_BYTES,
  CODEX_MARKET_WALLET_REMAINDER_FIELD,
  assertUsageWithinLimit, calculateLongyanAmount, marketError, marketFingerprint,
  marketQuotePrice, milliYuanToFen, normalizeLongyanUsage, normalizeMarketImages,
  normalizeMarketRequest, readMarketPricing, readMarketWalletAmount, splitMarketAmount,
} from "./codex-market-pricing.js";

export const CODEX_NODE_HEADER = "X-Gulong-Codex-Node";
export const CODEX_LEASE_MS = 120_000;
export const CODEX_CAPACITY_SCOPE = "cooperative-host-slots-v2";
export const CODEX_CAPACITY_TOTAL = 10;
const TERMINAL = new Set(["completed", "failed", "cancelled", "rejected"]);
const PREFIX = "/api/codex-market";

function id(value, field = "ID") {
  if (!ObjectId.isValid(value)) throw marketError("INVALID_ID", `${field} 无效`);
  return new ObjectId(value);
}
function requestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw marketError("REQUEST_ID_REQUIRED", "requestId 必须为 8–160 个字母、数字或 ._:- 字符");
  return value;
}
function nodeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw marketError("INVALID_NODE_ID", "节点 ID 无效");
  return value;
}
function capabilities(value = {}) {
  const models = Array.isArray(value.models) ? [...new Set(value.models)].filter((model) => ["longyan", "longtu"].includes(model)).sort() : [];
  const usageReportingVersion = value.usageReportingVersion === "codex-app-server-v1" ? value.usageReportingVersion : null;
  const cooperative = value.capacityScope === CODEX_CAPACITY_SCOPE
    && Number(value.capacityTotal) === CODEX_CAPACITY_TOTAL
    && Number(value.maxConcurrentTasks) === CODEX_CAPACITY_TOTAL;
  return {
    codexAvailable: value.codexAvailable === true,
    models,
    usageReportingVersion,
    capacityScope: cooperative ? CODEX_CAPACITY_SCOPE : "legacy-single-slot",
    capacityTotal: cooperative ? CODEX_CAPACITY_TOTAL : 1,
    maxConcurrentTasks: cooperative ? CODEX_CAPACITY_TOTAL : 1,
  };
}
function exactAmount(record, name, fallbackName = null) {
  const exact = record?.[`${name}MilliYuan`];
  if (Number.isSafeInteger(exact)) return exact;
  const legacy = record?.[`${name}Fen`] ?? (fallbackName ? record?.[`${fallbackName}Fen`] : 0);
  return Number.isSafeInteger(legacy) ? legacy * 10 : 0;
}
function preciseTask(task) {
  return task?.pricingSnapshot?.accountingUnit === "CNY_MILLIYUAN" || Number.isSafeInteger(task?.reservedMilliYuan);
}
function exactFields(name, amountMilliYuan) {
  return { [`${name}MilliYuan`]: amountMilliYuan, [`${name}Fen`]: milliYuanToFen(amountMilliYuan) };
}
function publicTask(task) {
  return {
    id: String(task._id), orderNo: task.orderNo, model: task.model, status: task.status,
    accountingUnit: "CNY_MILLIYUAN", milliYuanPerYuan: 1_000,
    requiredMilliYuan: exactAmount(task, "required", "reserved"),
    reservedMilliYuan: exactAmount(task, "reserved", "charged"), chargedMilliYuan: exactAmount(task, "charged"),
    nodeShareMilliYuan: exactAmount(task, "nodeShare"), platformShareMilliYuan: exactAmount(task, "platformShare"),
    reservedFen: task.reservedFen ?? task.chargedFen, chargedFen: task.chargedFen,
    nodeShareFen: task.nodeShareFen, platformShareFen: task.platformShareFen,
    pricingRevision: task.pricingRevision, progress: task.progress || 0,
    result: task.status === "completed" ? task.result : null, error: task.error || null,
    createdAt: task.createdAt, completedAt: task.completedAt || null,
    deadlineAt: task.deadlineAt, refundedMilliYuan: exactAmount(task, "refunded"), refundedFen: task.refundedFen || 0,
    settlementStatus: task.settlementStatus,
    ...(task.model === "longyan" ? { usageLimit: task.usageLimit, usage: task.status === "completed" ? task.usage : null, usagePricing: task.status === "completed" ? task.usagePricing : null } : {}),
  };
}
function publicQuote(quote, wallet = null) {
  const { executionModel, reasoningEffort, officialAmountFen, officialAmountMilliYuan, chargedFen, chargedMilliYuan, nodeShareFen, nodeShareMilliYuan, platformShareFen, platformShareMilliYuan, pricingRevision, currency, officialSourceUrl, expiresAt, usageLimit, usagePricing } = quote;
  const available = readMarketWalletAmount(wallet);
  const requiredMilliYuan = Number.isSafeInteger(chargedMilliYuan) ? chargedMilliYuan : chargedFen * 10;
  return {
    quoteId: String(quote._id), executionModel, reasoningEffort,
    accountingUnit: "CNY_MILLIYUAN", milliYuanPerYuan: 1_000,
    officialAmountMilliYuan: Number.isSafeInteger(officialAmountMilliYuan) ? officialAmountMilliYuan : officialAmountFen * 10,
    officialAmountFen, requiredMilliYuan, requiredFen: milliYuanToFen(requiredMilliYuan),
    chargedMilliYuan: requiredMilliYuan, chargedFen, reservedMilliYuan: requiredMilliYuan, reservedFen: chargedFen,
    nodeShareMilliYuan: Number.isSafeInteger(nodeShareMilliYuan) ? nodeShareMilliYuan : nodeShareFen * 10,
    platformShareMilliYuan: Number.isSafeInteger(platformShareMilliYuan) ? platformShareMilliYuan : platformShareFen * 10,
    nodeShareFen, platformShareFen,
    availableBalanceMilliYuan: available.balanceMilliYuan, availableBalanceFen: available.balanceFen,
    affordable: requiredMilliYuan === 0 || available.balanceMilliYuan >= requiredMilliYuan,
    billingExempt: requiredMilliYuan === 0, pricingRevision, currency, officialSourceUrl, expiresAt,
    ...(usageLimit ? { usageLimit, usagePricing } : {}),
  };
}
function validateResult(model, value = {}) {
  const images = normalizeMarketImages(value.images);
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (text.length > 128_000 || (model === "longyan" && !text) || (model === "longtu" && images.length !== 1)) throw marketError("INVALID_RESULT", model === "longtu" ? "龙图每次订单必须返回一张有效图片" : "生成结果为空或超出限制");
  return { text, images };
}

export function registerCodexMarketRoutes(app, dependencies) {
  const { authenticate, requireTrustedMutation } = dependencies;
  const { getCollection, transaction, ensureStore } = { ...codexMarketStorage, ...dependencies };
  const getPricing = dependencies.getPricing || readMarketPricing;
  const rateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  const clock = dependencies.now || (() => new Date());
  const hash = dependencies.hashToken || hashOpaqueToken;
  const collection = (name) => getCollection(`codexMarket${name}`);

  async function atomic(operation) {
    await ensureStore();
    // Unique-index races abort their whole transaction, then replay in a new
    // snapshot. MongoDB handles transient write-conflict/commit retries itself.
    for (let attempt = 0; ; attempt += 1) {
      try { return await transaction(operation); }
      catch (error) { if (error?.code !== 11000 || attempt >= 2) throw error; }
    }
  }
  function route(method, path, handler) {
    app[method](`${PREFIX}${path}`, async (c) => {
      c.header("Cache-Control", "private, no-store");
      try { return await handler(c); }
      catch (error) {
        const unavailable = error?.code === 20 || error?.codeName === "IllegalOperation" || error?.name === "MongoServerSelectionError" || error?.code === "CONFIG_REQUIRED";
        if (unavailable) return c.json({ code: "TRANSACTIONAL_STORE_REQUIRED", message: "Codex 共享订单数据库暂不可用，未执行收费或结算" }, 503);
        const status = Number(error?.status) || 500;
        return c.json({ code: typeof error?.code === "string" ? error.code : "CODEX_MARKET_ERROR", message: status < 500 || error?.status ? error.message : "Codex 共享订单服务暂不可用，请使用相同 requestId 重试" }, status);
      }
    });
  }
  app.use(`${PREFIX}/*`, bodyLimit({ maxSize: CODEX_MARKET_MAX_JSON_BYTES, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "当前共享节点接口的 JSON 内容不能超过 3 MB" }, 413) }));
  async function body(c) {
    try { return await c.req.json(); } catch { throw marketError("INVALID_JSON", "请求体必须是有效 JSON"); }
  }
  async function account(c, mutation = false) {
    if (mutation) { const rejected = requireTrustedMutation(c); if (rejected) return { error: rejected }; }
    return authenticate(c, { scopes: [mutation ? "tasks:write" : "tasks:read"] });
  }
  async function limit(key, amount = 60) {
    const result = await rateLimit(`codex-market:${key}`, { limit: amount, windowMs: 60_000 });
    if (!result.allowed) throw marketError("RATE_LIMITED", "请求过于频繁，请稍后重试", 429);
  }
  async function node(c, requestedNodeId) {
    const rawToken = String(c.req.header(CODEX_NODE_HEADER) || "");
    if (!/^cmn_[A-Za-z0-9_-]{43}$/.test(rawToken)) throw marketError("NODE_TOKEN_REQUIRED", "请先注册 Codex 共享节点", 401);
    const value = await (await collection("Nodes")).findOne({ tokenHash: hash(rawToken, "codex-market-node"), status: "active", nodeId: nodeId(requestedNodeId) });
    if (!value) throw marketError("INVALID_NODE_TOKEN", "节点登录已失效，请重新注册", 401);
    const user = await (await getCollection("users")).findOne({ _id: value.ownerId, status: "active" });
    if (!user) throw marketError("INVALID_NODE_ACCOUNT", "节点所属账号不可用", 403);
    await limit(`node:${value._id}`, 120);
    return { ...value, rawToken };
  }
  async function verifyNodeInTransaction(auth, session) {
    const current = await (await collection("Nodes")).findOne({ _id: auth._id, status: "active", tokenHash: auth.tokenHash }, { session });
    if (!current) throw marketError("INVALID_NODE_TOKEN", "节点认证已更新，请重新注册", 401);
    return current;
  }
  function verifyClient(auth, input) {
    const supplied = typeof input.clientId === "string" && input.clientId ? nodeId(input.clientId) : null;
    if (auth.capabilities?.capacityScope === CODEX_CAPACITY_SCOPE && !supplied) {
      throw marketError("CLIENT_ID_REQUIRED", "十槽协同节点请求必须携带 clientId", 400);
    }
    if (supplied && supplied !== auth.nodeId) throw marketError("CLIENT_ID_MISMATCH", "clientId 与节点令牌不匹配", 409);
    return supplied || auth.nodeId;
  }
  function checkLease(task, auth, input, now) {
    if (!task || String(task.assignedNodeId) !== String(auth._id) || task.claimId !== input.claimId || typeof input.leaseToken !== "string" || task.leaseTokenHash !== hash(input.leaseToken, "codex-market-task-lease")) throw marketError("LEASE_CONFLICT", "任务已由其他节点或新租约接管", 409);
    if (!TERMINAL.has(task.status) && (!task.leaseExpiresAt || new Date(task.leaseExpiresAt) <= now)) throw marketError("LEASE_EXPIRED", "领取租约已过期，不能回调或结算", 409);
  }
  async function writeLedger(session, { key, ownerId, task, kind, amountMilliYuan }) {
    const ledgers = await collection("Ledger");
    const existing = await ledgers.findOne({ key }, { session });
    if (existing) {
      const existingExact = Number.isSafeInteger(existing.amountMilliYuan) ? existing.amountMilliYuan : Number(existing.amountFen || 0) * 10;
      if (String(existing.ownerId) !== String(ownerId) || existingExact !== amountMilliYuan || existing.kind !== kind) throw marketError("LEDGER_CONFLICT", "订单账本内容冲突", 409);
      return false;
    }
    await ledgers.insertOne({ key, ownerId, taskId: task._id, orderNo: task.orderNo, kind, amountMilliYuan, amountFen: milliYuanToFen(amountMilliYuan), accountingUnit: "CNY_MILLIYUAN", createdAt: clock() }, { session });
    return true;
  }
  async function mutateWallet(session, ownerId, deltaMilliYuan, { requireFunds = false } = {}) {
    const wallets = await getCollection("wallets");
    const current = await wallets.findOne({ ownerId }, { session });
    const available = readMarketWalletAmount(current).balanceMilliYuan;
    if (requireFunds && available < -deltaMilliYuan) return null;
    const next = available + deltaMilliYuan;
    if (!Number.isSafeInteger(next) || next < 0) throw marketError("WALLET_AMOUNT_INVALID", "钱包精确余额无效", 409);
    const balanceFen = Math.floor(next / 10);
    const remainder = next % 10;
    const updatedAt = clock();
    if (current) {
      await wallets.updateOne({ _id: current._id }, { $set: { balanceFen, [CODEX_MARKET_WALLET_REMAINDER_FIELD]: remainder, updatedAt } }, { session });
      return { ...current, balanceFen, [CODEX_MARKET_WALLET_REMAINDER_FIELD]: remainder, updatedAt };
    }
    if (deltaMilliYuan < 0) return null;
    const created = { _id: new ObjectId(), ownerId, balanceFen, [CODEX_MARKET_WALLET_REMAINDER_FIELD]: remainder, createdAt: updatedAt, updatedAt };
    await wallets.insertOne(created, { session });
    return created;
  }
  async function credit(session, task, ownerId, amountMilliYuan, kind) {
    if (!amountMilliYuan) return;
    if (await writeLedger(session, { key: `${task._id}:${kind}`, ownerId, task, kind, amountMilliYuan })) {
      await mutateWallet(session, ownerId, amountMilliYuan);
    }
  }
  async function failTask(session, task, code, message, terminalStatus = "failed") {
    if (TERMINAL.has(task.status)) return task;
    const reservedMilliYuan = exactAmount(task, "reserved", "charged");
    await credit(session, task, task.ownerId, reservedMilliYuan, "refund");
    const terminalAt = clock();
    const changes = { status: terminalStatus, error: { code, message }, ...exactFields("charged", 0), ...exactFields("nodeShare", 0), ...exactFields("platformShare", 0), ...exactFields("refunded", reservedMilliYuan), settlementStatus: "refunded", ...(terminalStatus === "cancelled" ? { cancelledAt: terminalAt } : { failedAt: terminalAt }), updatedAt: terminalAt };
    await (await collection("Tasks")).updateOne({ _id: task._id }, { $set: changes }, { session });
    return { ...task, ...changes };
  }
  async function expireTasks(session, ownerId = null) {
    const filter = { status: { $in: ["queued", "claimed", "processing"] }, deadlineAt: { $lte: clock() }, ...(ownerId ? { ownerId } : {}) };
    const stale = await (await collection("Tasks")).find(filter, { session }).sort({ deadlineAt: 1 }).limit(20).toArray();
    for (const task of stale) await failTask(session, task, "TASK_TIMEOUT", "共享节点任务超时，已退回本次扣款");
  }

  route("get", "/models", async (c) => {
    const pricing = getPricing();
    let storeReady = false;
    if (pricing) { try { await ensureStore(); storeReady = true; } catch {} }
    return c.json({ models: CODEX_MARKET_MODELS.map((model) => {
      const rate = pricing?.models.find((candidate) => candidate.id === model.id);
      const configured = Boolean(rate);
      return {
        ...model,
        ...(Number.isSafeInteger(rate?.officialAmountMilliYuan) ? { officialAmountMilliYuan: rate.officialAmountMilliYuan, officialAmountFen: milliYuanToFen(rate.officialAmountMilliYuan) } : {}),
        available: storeReady && configured, pricingRevision: pricing?.revision || CODEX_MARKET_PRICING_REVISION,
        unavailableCode: !pricing || !configured ? "OFFICIAL_PRICING_UNAVAILABLE" : !storeReady ? "TRANSACTIONAL_STORE_REQUIRED" : null,
      };
    }), nodeShareBps: 5000, currency: "CNY", accountingUnit: "CNY_MILLIYUAN", milliYuanPerYuan: 1_000, maxJsonBytes: CODEX_MARKET_MAX_JSON_BYTES });
  });
  route("post", "/quotes", async (c) => {
    const auth = await account(c, true); if (auth.error) return auth.error;
    const input = await body(c);
    const request = normalizeMarketRequest(input.model, input.request);
    const usageLimit = input.model === "longyan" ? normalizeLongyanUsage(input.usageLimit) : null;
    const price = marketQuotePrice(getPricing(), input.model, { administrator: auth.user.role === "admin", usageLimit });
    const key = requestId(input.requestId);
    const ownerId = id(auth.user.id);
    await limit(`quotes:${ownerId}`, 30);
    const fingerprint = marketFingerprint({ model: input.model, request, usageLimit });
    const result = await atomic(async (session) => {
      const quotes = await collection("Quotes");
      const previous = await quotes.findOne({ ownerId, requestId: key }, { session });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw marketError("IDEMPOTENCY_KEY_CONFLICT", "同一 requestId 不能用于不同的报价请求", 409);
        return { quote: previous, wallet: await (await getCollection("wallets")).findOne({ ownerId }, { session }) };
      }
      const now = clock();
      const quote = { _id: new ObjectId(), ownerId, requestId: key, model: input.model, request, usageLimit, fingerprint, ...price, expiresAt: new Date(+now + 5 * 60_000), createdAt: now };
      await quotes.insertOne(quote, { session });
      return { quote, wallet: await (await getCollection("wallets")).findOne({ ownerId }, { session }) };
    });
    return c.json(publicQuote(result.quote, result.wallet), 201);
  });
  route("post", "/tasks", async (c) => {
    const auth = await account(c, true); if (auth.error) return auth.error;
    const input = await body(c);
    const key = requestId(input.requestId);
    const quoteId = id(input.quoteId, "quoteId");
    const ownerId = id(auth.user.id);
    await limit(`tasks:${ownerId}`, 30);
    const result = await atomic(async (session) => {
      const tasks = await collection("Tasks");
      const walletCollection = await getCollection("wallets");
      const previous = await tasks.findOne({ ownerId, requestId: key }, { session });
      if (previous) {
        if (String(previous.quoteId) !== String(quoteId)) throw marketError("IDEMPOTENCY_KEY_CONFLICT", "同一 requestId 不能创建不同的订单", 409);
        return { task: previous, wallet: await walletCollection.findOne({ ownerId }, { session }), idempotent: true };
      }
      const quote = await (await collection("Quotes")).findOne({ _id: quoteId, ownerId }, { session });
      if (!quote) throw marketError("QUOTE_NOT_FOUND", "报价不存在或不属于当前账号", 404);
      if (quote.taskId) throw marketError("QUOTE_ALREADY_USED", "该报价已创建订单，请使用原 requestId 查询", 409);
      if (quote.expiresAt <= clock()) throw marketError("QUOTE_EXPIRED", "报价已过期，请重新获取报价", 409);
      marketQuotePrice(getPricing(), quote.model, { usageLimit: quote.usageLimit });
      const quotedChargeMilliYuan = exactAmount(quote, "charged");
      if ((quotedChargeMilliYuan === 0) !== (auth.user.role === "admin")) throw marketError("QUOTE_AUTHORIZATION_CHANGED", "账号计费权限已变化，请重新获取报价", 409);
      const now = clock();
      const task = {
        _id: new ObjectId(), ownerId, requestId: key, quoteId, model: quote.model, request: quote.request,
        executionModel: quote.executionModel, reasoningEffort: quote.reasoningEffort || null,
        accountingUnit: "CNY_MILLIYUAN", milliYuanPerYuan: 1_000,
        ...exactFields("officialAmount", exactAmount(quote, "officialAmount")),
        ...exactFields("required", quotedChargeMilliYuan), ...exactFields("reserved", quotedChargeMilliYuan),
        ...exactFields("charged", quotedChargeMilliYuan),
        nodeShareMilliYuan: exactAmount(quote, "nodeShare"), platformShareMilliYuan: exactAmount(quote, "platformShare"),
        nodeShareFen: quote.nodeShareFen, platformShareFen: quote.platformShareFen,
        usageLimit: quote.usageLimit || null, pricingSnapshot: quote.pricingSnapshot || null, pricingRevision: quote.pricingRevision,
        status: "queued", settlementStatus: "reserved", createdAt: now, updatedAt: now, deadlineAt: new Date(+now + 60 * 60_000), attempt: 0,
      };
      task.orderNo = `CM-${task._id}`;
      let wallet = await walletCollection.findOne({ ownerId }, { session });
      if (task.chargedMilliYuan > 0) {
        // Bind the platform recipient before charging, so completion never
        // depends on whichever administrator happens to exist later.
        const platform = await (await getCollection("users")).findOne({ role: "admin", status: "active" }, { session, sort: { createdAt: 1, _id: 1 } });
        if (!platform) throw marketError("PLATFORM_ACCOUNT_REQUIRED", "尚未配置平台结算账号，订单未收费", 503);
        task.platformOwnerId = platform._id;
        wallet = await mutateWallet(session, ownerId, -task.chargedMilliYuan, { requireFunds: true });
        if (!wallet) {
          wallet = await walletCollection.findOne({ ownerId }, { session });
          task.status = "rejected"; task.settlementStatus = "not_charged";
          task.error = { code: "INSUFFICIENT_BALANCE", message: "账号余额不足，本次订单未扣款" };
          Object.assign(task, exactFields("reserved", 0), exactFields("charged", 0), exactFields("nodeShare", 0), exactFields("platformShare", 0));
        } else await writeLedger(session, { key: `${task._id}:reserve`, ownerId, task, kind: "reserve", amountMilliYuan: -task.chargedMilliYuan });
      }
      await tasks.insertOne(task, { session });
      await (await collection("Quotes")).updateOne({ _id: quoteId }, { $set: { taskId: task._id } }, { session });
      return { task, wallet, idempotent: false };
    });
    const remaining = readMarketWalletAmount(result.wallet);
    return c.json({
      task: publicTask(result.task),
      billing: {
        accountingUnit: "CNY_MILLIYUAN", milliYuanPerYuan: 1_000,
        requiredMilliYuan: exactAmount(result.task, "required", "reserved"), requiredFen: result.task.requiredFen ?? result.task.reservedFen,
        chargedMilliYuan: exactAmount(result.task, "charged"), chargedFen: result.task.chargedFen,
        remainingBalanceMilliYuan: remaining.balanceMilliYuan, remainingBalanceFen: remaining.balanceFen,
        affordable: result.task.status !== "rejected",
      },
      idempotent: result.idempotent,
      ...(result.task.status === "rejected" ? result.task.error : {}),
    }, result.task.status === "rejected" ? 402 : result.idempotent ? 200 : 201);
  });
  route("get", "/tasks/:id", async (c) => {
    const auth = await account(c); if (auth.error) return auth.error;
    const ownerId = id(auth.user.id);
    const task = await atomic(async (session) => {
      const current = await (await collection("Tasks")).findOne({ _id: id(c.req.param("id")), ...(auth.user.role === "admin" ? {} : { ownerId }) }, { session });
      if (!current) throw marketError("TASK_NOT_FOUND", "订单不存在或无权访问", 404);
      if (!TERMINAL.has(current.status) && current.deadlineAt <= clock()) return failTask(session, current, "TASK_TIMEOUT", "共享节点任务超时，已退回本次扣款");
      return current;
    });
    return c.json({ task: publicTask(task) });
  });
  route("post", "/tasks/:id/cancel", async (c) => {
    const auth = await account(c, true); if (auth.error) return auth.error;
    const ownerId = id(auth.user.id);
    const result = await atomic(async (session) => {
      const tasks = await collection("Tasks");
      const task = await tasks.findOne({ _id: id(c.req.param("id")), ...(auth.user.role === "admin" ? {} : { ownerId }) }, { session });
      if (!task) throw marketError("TASK_NOT_FOUND", "订单不存在或无权访问", 404);
      if (task.status === "cancelled") return { task, idempotent: true };
      if (TERMINAL.has(task.status)) throw marketError("TASK_TERMINAL", "订单已经结束，不能取消", 409);
      return { task: await failTask(session, task, "TASK_CANCELLED", "任务已取消，本次预留金额已退回", "cancelled"), idempotent: false };
    });
    return c.json({ ok: true, idempotent: result.idempotent, task: publicTask(result.task) });
  });
  route("post", "/nodes/register", async (c) => {
    const auth = await account(c, true); if (auth.error) return auth.error;
    const input = await body(c);
    const ownerId = id(auth.user.id);
    const clientNodeId = nodeId(input.clientId || input.nodeId);
    if (input.nodeId && nodeId(input.nodeId) !== clientNodeId) throw marketError("CLIENT_ID_MISMATCH", "clientId 与 nodeId 必须指向同一节点", 409);
    const nodeName = String(input.nodeName || "").trim().slice(0, 120);
    if (!nodeName) throw marketError("NODE_NAME_REQUIRED", "请填写节点名称");
    await limit(`register:${ownerId}`, 10);
    const nodeToken = `cmn_${randomBytes(32).toString("base64url")}`;
    await atomic(async (session) => {
      const nodes = await collection("Nodes");
      const previous = await nodes.findOne({ ownerId, nodeId: clientNodeId }, { session });
      if (previous) await (await collection("Tasks")).updateMany({ assignedNodeId: previous._id, status: { $in: ["claimed", "processing"] } }, { $set: { status: "queued", updatedAt: clock() }, $unset: { assignedNodeId: "", claimId: "", leaseTokenHash: "", leaseExpiresAt: "" } }, { session });
      await nodes.updateOne({ ownerId, nodeId: clientNodeId }, { $set: { clientId: clientNodeId, nodeName, appVersion: String(input.appVersion || "").slice(0, 40), capabilities: capabilities(input.capabilities), tokenHash: hash(nodeToken, "codex-market-node"), status: "active", lastSeenAt: clock() }, $unset: { activeTaskId: "" }, $setOnInsert: { createdAt: clock() } }, { upsert: true, session });
    });
    const normalizedCapabilities = capabilities(input.capabilities);
    return c.json({ nodeId: clientNodeId, clientId: clientNodeId, nodeToken, heartbeatIntervalSeconds: 30, leaseSeconds: CODEX_LEASE_MS / 1000, ...normalizedCapabilities }, 201);
  });
  route("post", "/nodes/heartbeat", async (c) => {
    const input = await body(c);
    const auth = await node(c, input.nodeId || input.clientId);
    verifyClient(auth, input);
    const result = await atomic(async (session) => {
      await verifyNodeInTransaction(auth, session);
      const updates = { lastSeenAt: clock(), ...(input.capabilities ? { capabilities: capabilities(input.capabilities) } : {}) };
      const leases = Array.isArray(input.activeTasks) ? input.activeTasks : input.activeTask ? [input.activeTask] : [];
      const maximum = auth.capabilities?.capacityScope === CODEX_CAPACITY_SCOPE ? CODEX_CAPACITY_TOTAL : 1;
      if (leases.length > maximum) throw marketError("CAPACITY_EXCEEDED", `当前节点最多只能续租 ${maximum} 个活动任务`, 409);
      const renewed = [];
      for (const lease of leases) {
        const task = await (await collection("Tasks")).findOne({ _id: id(lease.taskId) }, { session });
        checkLease(task, auth, lease, clock());
        if (!TERMINAL.has(task.status)) {
          if (task.deadlineAt <= clock()) { await failTask(session, task, "TASK_TIMEOUT", "共享节点任务超时，已退款"); return { taskExpired: true }; }
          const leaseExpiresAt = new Date(Math.min(+clock() + CODEX_LEASE_MS, +task.deadlineAt));
          await (await collection("Tasks")).updateOne({ _id: task._id }, { $set: { leaseExpiresAt, updatedAt: clock() } }, { session });
          renewed.push({ taskId: String(task._id), claimId: task.claimId, leaseExpiresAt });
        }
      }
      await (await collection("Nodes")).updateOne({ _id: auth._id }, { $set: updates }, { session });
      return { leases: renewed, ...(renewed.length === 1 ? { leaseExpiresAt: renewed[0].leaseExpiresAt } : {}) };
    });
    return c.json({ ok: true, ...result });
  });
  route("post", "/tasks/claim", async (c) => {
    const input = await body(c);
    const auth = await node(c, input.nodeId || input.clientId);
    verifyClient(auth, input);
    const task = await atomic(async (session) => {
      const currentNode = await verifyNodeInTransaction(auth, session);
      if (!currentNode.capabilities.codexAvailable || !currentNode.capabilities.models.length) throw marketError("CODEX_UNAVAILABLE", "节点尚未就绪，不能领取订单", 409);
      await expireTasks(session);
      const tasks = await collection("Tasks");
      const now = clock();
      const cooperative = currentNode.capabilities.capacityScope === CODEX_CAPACITY_SCOPE;
      const maximum = cooperative ? CODEX_CAPACITY_TOTAL : 1;
      const hasResumeIdentity = Boolean(input.taskId || input.claimId || input.leaseToken);
      if (hasResumeIdentity && !(input.taskId && input.claimId && input.leaseToken)) throw marketError("LEASE_IDENTITY_INCOMPLETE", "继续领取任务时必须同时提供 taskId、claimId 和 leaseToken", 400);
      let task = null;
      if (hasResumeIdentity) {
        task = await tasks.findOne({ _id: id(input.taskId) }, { session });
        checkLease(task, auth, input, now);
      } else if (!cooperative) {
        task = await tasks.findOne({ assignedNodeId: auth._id, status: { $in: ["claimed", "processing"] }, leaseExpiresAt: { $gt: now } }, { session });
      }
      if (!task) {
        const activeTasks = await tasks.find({ assignedNodeId: auth._id, status: { $in: ["claimed", "processing"] }, leaseExpiresAt: { $gt: now } }, { session }).limit(maximum + 1).toArray();
        if (activeTasks.length >= maximum) return null;
        const claimId = randomBytes(16).toString("hex");
        const leaseToken = `cml_${hash(`${auth.rawToken}:${claimId}`, "codex-market-claim")}`;
        const claimableModels = currentNode.capabilities.models.filter((model) => model !== "longyan" || currentNode.capabilities.usageReportingVersion === "codex-app-server-v1");
        task = claimableModels.length ? await tasks.findOneAndUpdate({ model: { $in: claimableModels }, deadlineAt: { $gt: now }, $or: [{ status: "queued" }, { status: { $in: ["claimed", "processing"] }, leaseExpiresAt: { $lte: now } }] }, { $set: { assignedNodeId: auth._id, executorOwnerId: auth.ownerId, status: "claimed", claimId, leaseTokenHash: hash(leaseToken, "codex-market-task-lease"), leaseExpiresAt: new Date(+now + CODEX_LEASE_MS), updatedAt: now }, $inc: { attempt: 1 } }, { session, returnDocument: "after", sort: { createdAt: 1, _id: 1 } }) : null;
      }
      // Updating the node row serializes concurrent claims for one client. A
      // retried transaction observes the newly-created active lease count.
      await (await collection("Nodes")).updateOne({ _id: auth._id }, { $set: { lastSeenAt: now } }, { session });
      return task;
    });
    return c.json({ clientId: auth.nodeId, task: task ? { id: String(task._id), orderNo: task.orderNo, model: task.model, request: task.request, executionModel: task.executionModel, reasoningEffort: task.reasoningEffort || null, ...(task.model === "longyan" ? { usageLimit: task.usageLimit, usageReportingVersion: "codex-app-server-v1" } : {}), claimId: task.claimId, leaseToken: `cml_${hash(`${auth.rawToken}:${task.claimId}`, "codex-market-claim")}`, leaseExpiresAt: task.leaseExpiresAt } : null, capacity: { scope: auth.capabilities.capacityScope, total: auth.capabilities.capacityTotal }, retryAfterSeconds: 15 });
  });
  route("post", "/tasks/callback", async (c) => {
    const input = await body(c);
    const auth = await node(c, input.nodeId || input.clientId);
    verifyClient(auth, input);
    const eventId = requestId(input.eventId);
    if (!["started", "progress", "completed", "failed", "cancelled"].includes(input.status)) throw marketError("INVALID_STATUS", "回调状态无效");
    const result = await atomic(async (session) => {
      await verifyNodeInTransaction(auth, session);
      const tasks = await collection("Tasks");
      let task = await tasks.findOne({ _id: id(input.taskId) }, { session });
      checkLease(task, auth, input, clock());
      const output = input.status === "completed" ? validateResult(task.model, input.result) : null;
      const usage = input.status === "completed" && task.model === "longyan" ? assertUsageWithinLimit(input.usage, task.usageLimit) : null;
      const progress = Number.isInteger(input.progress) ? Math.max(0, Math.min(99, input.progress)) : 0;
      const error = ["failed", "cancelled"].includes(input.status) ? { code: String(input.error?.code || (input.status === "cancelled" ? "TASK_CANCELLED" : "NODE_EXECUTION_FAILED")).slice(0, 80), message: String(input.error?.message || (input.status === "cancelled" ? "共享节点任务已取消" : "共享节点执行失败")).slice(0, 500) } : null;
      const fingerprint = marketFingerprint({ status: input.status, result: output, error, progress, usage });
      const events = await collection("Callbacks");
      const previous = await events.findOne({ taskId: task._id, claimId: input.claimId, eventId }, { session });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw marketError("CALLBACK_CONFLICT", "同一 eventId 不能回传不同结果", 409);
        return { task, idempotent: true };
      }
      if (TERMINAL.has(task.status)) throw marketError("TASK_TERMINAL", "订单已结束，不能变更结果或重复结算", 409);
      if (task.deadlineAt <= clock()) { task = await failTask(session, task, "TASK_TIMEOUT", "共享节点任务超时，已退款"); return { task, idempotent: false }; }
      if (input.status === "failed" || input.status === "cancelled") task = await failTask(session, task, error.code, error.message, input.status);
      else if (input.status === "completed") {
        const reservedMilliYuan = exactAmount(task, "reserved", "charged");
        const usagePricing = task.model === "longyan" ? calculateLongyanAmount(usage, task.pricingSnapshot) : null;
        const actualOfficialAmountMilliYuan = usagePricing
          ? (preciseTask(task) ? usagePricing.amountMilliYuan : usagePricing.amountFen * 10)
          : exactAmount(task, "officialAmount");
        const actualChargedMilliYuan = reservedMilliYuan === 0 ? 0 : actualOfficialAmountMilliYuan;
        if (actualChargedMilliYuan > reservedMilliYuan) throw marketError("USAGE_EXCEEDS_RESERVATION", "真实用量费用超过已授权的预留金额，未结算本次结果", 409);
        const refundMilliYuan = reservedMilliYuan - actualChargedMilliYuan;
        const split = preciseTask(task)
          ? splitMarketAmount(actualChargedMilliYuan)
          : (() => {
              const chargedFen = milliYuanToFen(actualChargedMilliYuan);
              const nodeShareFen = Math.floor(chargedFen / 2);
              return { nodeShareMilliYuan: nodeShareFen * 10, platformShareMilliYuan: (chargedFen - nodeShareFen) * 10, nodeShareFen, platformShareFen: chargedFen - nodeShareFen };
            })();
        if (refundMilliYuan) await credit(session, task, task.ownerId, refundMilliYuan, "reservation_adjustment_refund");
        await credit(session, task, task.executorOwnerId, split.nodeShareMilliYuan, "node_commission");
        await credit(session, task, task.platformOwnerId, split.platformShareMilliYuan, "platform_commission");
        const changes = {
          status: "completed", result: output, progress: 100,
          ...exactFields("officialAmount", actualOfficialAmountMilliYuan),
          ...exactFields("charged", actualChargedMilliYuan),
          nodeShareMilliYuan: split.nodeShareMilliYuan, platformShareMilliYuan: split.platformShareMilliYuan,
          nodeShareFen: split.nodeShareFen, platformShareFen: split.platformShareFen,
          ...exactFields("refunded", refundMilliYuan),
          ...(usage ? { usage, usagePricing } : {}), settlementStatus: "settled", completedAt: clock(), updatedAt: clock(),
        };
        await tasks.updateOne({ _id: task._id }, { $set: changes }, { session });
        task = { ...task, ...changes };
      } else {
        const changes = { status: "processing", progress: Math.max(task.progress || 0, progress), leaseExpiresAt: new Date(Math.min(+clock() + CODEX_LEASE_MS, +task.deadlineAt)), updatedAt: clock() };
        await tasks.updateOne({ _id: task._id }, { $set: changes }, { session });
        task = { ...task, ...changes };
      }
      await events.insertOne({ taskId: task._id, claimId: input.claimId, eventId, fingerprint, status: input.status, nodeId: auth._id, createdAt: clock() }, { session });
      await (await collection("Nodes")).updateOne({ _id: auth._id }, { $set: { lastSeenAt: clock() } }, { session });
      return { task, idempotent: false };
    });
    return c.json({ ok: true, idempotent: result.idempotent, task: { id: String(result.task._id), status: result.task.status } });
  });

  if (app.openAPIRegistry) {
    app.openAPIRegistry.registerComponent("securitySchemes", "codexNode", { type: "apiKey", in: "header", name: CODEX_NODE_HEADER });
    const usageLimit = z.object({ inputTokens: z.number().int().min(0).max(2_000_000), outputTokens: z.number().int().min(0).max(2_000_000), cacheWriteTokens: z.number().int().min(0).max(2_000_000), cacheReadTokens: z.number().int().min(0).max(2_000_000) });
    const actualUsage = usageLimit.omit({ cacheWriteTokens: true }).extend({ cacheWriteTokens: z.number().int().min(0).max(2_000_000).nullable(), source: z.literal("codex_app_server"), providerRequestId: z.string().min(8).max(200), cacheWriteTokensMeasured: z.boolean() });
    const nodeCapabilities = z.object({ codexAvailable: z.boolean(), models: z.array(z.enum(["longyan", "longtu"])), usageReportingVersion: z.literal("codex-app-server-v1").nullable().optional(), capacityScope: z.literal(CODEX_CAPACITY_SCOPE).optional(), capacityTotal: z.literal(CODEX_CAPACITY_TOTAL).optional(), maxConcurrentTasks: z.literal(CODEX_CAPACITY_TOTAL).optional() });
    const nodeRequest = z.object({ nodeId: z.string().min(8).max(160), clientId: z.string().min(8).max(160).optional() });
    const lease = z.object({ taskId: z.string(), claimId: z.string(), leaseToken: z.string() });
    const preciseBilling = z.object({
      accountingUnit: z.literal("CNY_MILLIYUAN"), milliYuanPerYuan: z.literal(1_000),
      requiredMilliYuan: z.number().int().min(0), requiredFen: z.number().int().min(0),
      chargedMilliYuan: z.number().int().min(0), chargedFen: z.number().int().min(0),
      remainingBalanceMilliYuan: z.number().int().min(0), remainingBalanceFen: z.number().int().min(0), affordable: z.boolean(),
    });
    const preciseQuote = z.object({
      quoteId: z.string(), executionModel: z.string(), reasoningEffort: z.string().nullable(),
      accountingUnit: z.literal("CNY_MILLIYUAN"), milliYuanPerYuan: z.literal(1_000),
      officialAmountMilliYuan: z.number().int().min(0), officialAmountFen: z.number().int().min(0),
      requiredMilliYuan: z.number().int().min(0), requiredFen: z.number().int().min(0),
      chargedMilliYuan: z.number().int().min(0), chargedFen: z.number().int().min(0),
      reservedMilliYuan: z.number().int().min(0), reservedFen: z.number().int().min(0),
      nodeShareMilliYuan: z.number().int().min(0), platformShareMilliYuan: z.number().int().min(0),
      nodeShareFen: z.number().int().min(0), platformShareFen: z.number().int().min(0),
      availableBalanceMilliYuan: z.number().int().min(0), availableBalanceFen: z.number().int().min(0),
      affordable: z.boolean(), billingExempt: z.boolean(), pricingRevision: z.string(), currency: z.literal("CNY"), expiresAt: z.string(),
      usageLimit: usageLimit.optional(), usagePricing: z.record(z.string(), z.unknown()).optional(),
    });
    const taskCreateResponse = z.object({
      task: z.object({ id: z.string(), status: z.string(), requiredMilliYuan: z.number().int().min(0), reservedMilliYuan: z.number().int().min(0), chargedMilliYuan: z.number().int().min(0) }).passthrough(),
      billing: preciseBilling, idempotent: z.boolean(), code: z.string().optional(), message: z.string().optional(),
    });
    app.openAPIRegistry.registerComponent("schemas", "CodexMarketPreciseBilling", preciseBilling);
    app.openAPIRegistry.registerComponent("schemas", "CodexMarketQuoteResponse", preciseQuote);
    app.openAPIRegistry.registerComponent("schemas", "CodexMarketTaskCreateResponse", taskCreateResponse);
    const schemas = [
      ["get", "/models", "查看龙言分档 Token 费率和龙图每次 182 毫元精确报价", null, false, null],
      ["post", "/quotes", "获取五分钟有效报价；返回 requiredMilliYuan、availableBalanceMilliYuan 与 affordable；龙言按 usageLimit 预留，龙图固定 182 毫元", z.object({ model: z.enum(["longyan", "longtu"]), requestId: z.string().min(8).max(160), usageLimit: usageLimit.optional(), request: z.object({ prompt: z.string().min(1).max(32_000), images: z.array(z.union([z.string(), z.object({ dataUrl: z.string() })])).optional(), size: z.string().optional(), messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional() }) }), false, preciseQuote],
      ["post", "/tasks", "按 quoteId 和持久 requestId 幂等下单，事务预扣精确毫元报价；余额不足不入队，管理员免扣费", z.object({ quoteId: z.string(), requestId: z.string().min(8).max(160) }), false, taskCreateResponse],
      ["get", "/tasks/{id}", "请求者或管理员查询任务；超时原子退款", null, false],
      ["post", "/tasks/{id}/cancel", "请求者或管理员按单个任务幂等取消并退款，不影响同节点其他活动租约", null, false],
      ["post", "/nodes/register", "使用登录账号绑定 Codex 节点；cooperative-host-slots-v2 必须声明 10 个协同执行槽，旧客户端保持单槽", nodeRequest.extend({ nodeName: z.string(), appVersion: z.string().optional(), capabilities: nodeCapabilities }), false],
      ["post", "/nodes/heartbeat", "按 clientId 和 activeTasks 独立续租最多 10 个活动任务；旧 activeTask 合同继续兼容", nodeRequest.extend({ capabilities: nodeCapabilities.optional(), activeTask: lease.optional(), activeTasks: z.array(lease).max(CODEX_CAPACITY_TOTAL).optional() }), true],
      ["post", "/tasks/claim", "FIFO 原子领取兼容任务；十槽协同节点最多持有 10 个独立活动租约，第 11 个保持排队", nodeRequest.merge(lease.partial()), true],
      ["post", "/tasks/callback", "使用 clientId 与独立领取租约幂等回调；一个任务的终态不影响其他租约；完成后按毫元五五分账", nodeRequest.merge(lease).extend({ eventId: z.string().min(8).max(160), status: z.enum(["started", "progress", "completed", "failed", "cancelled"]), progress: z.number().int().min(0).max(99).optional(), usage: actualUsage.optional(), result: z.object({ text: z.string().optional(), images: z.array(z.object({ dataUrl: z.string() })).optional() }).optional(), error: z.object({ code: z.string().optional(), message: z.string() }).optional() }), true],
    ];
    for (const [method, path, summary, schema, nodeAuth] of schemas) {
      app.openAPIRegistry.registerPath({ method, path: `${PREFIX}${path}`, tags: ["Codex Marketplace"], summary, ...(nodeAuth ? { security: [{ codexNode: [] }] } : {}), ...(schema ? { request: { body: { required: true, content: { "application/json": { schema } } } } } : {}), responses: { 200: { description: "请求成功或幂等重放" }, ...(method === "post" ? { 201: { description: "报价、订单或节点已创建" } } : {}), 400: { description: "请求合同无效" }, 401: { description: "登录或节点认证无效" }, 402: { description: "可用余额不足，订单未扣费" }, 409: { description: "报价、幂等键、租约、用量上限或任务状态冲突" }, 413: { description: "JSON 总量超过 3 MB" }, 422: { description: "龙言完成回调缺少可接受的真实用量" }, 503: { description: "报价已停用或数据库不支持事务，拒绝收费" } } });
    }
  }
}
