import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { createRoute, z } from "@hono/zod-openapi";
import { getCollection } from "./db.js";
import { enforceRateLimit } from "./rate-limit.js";
import { readUserSecret, sealUserSecret } from "./security.js";

export const PEAR_API_BASE_URL = "https://api.pearapi.ai";
export const PEAR_API_ACQUISITION_URL = "https://api.pearapi.ai/zh/dashboard";
export const PEAR_API_DOCS_URL = "https://api.pearapi.ai/zh/dashboard/docs";
export const PEAR_API_MARKUP_RATE = 0.3;

export const PEAR_API_FREE_MODELS = Object.freeze([
  { id: "glm-4-flash-250414", name: "GLM-4-Flash-250414", vendor: "GLM", description: "轻量通用模型，适合日常问答、多任务处理与长上下文。" },
  { id: "gpt-oss-120b", name: "GPT-OSS-120B", vendor: "OpenAI", description: "大参数开放模型，适合综合分析、写作与复杂指令。" },
  { id: "hunyuan-mt-7b", name: "Hunyuan-MT-7B", vendor: "Tencent", description: "面向多语言互译的轻量模型，覆盖多种语言。" },
  { id: "hy-mt2-1.8b", name: "HY-MT2-1.8B", vendor: "Tencent", description: "快速多语言翻译模型，适合短文本与高频翻译。" },
  { id: "mistral-7b-instruct-v0.2", name: "Mistral-7B-Instruct-v0.2", vendor: "Mistral", description: "经典指令模型，适合清晰、直接的文本任务。" },
  { id: "spark-lite", name: "Spark-Lite", vendor: "Spark", description: "轻量文本生成与问答模型，适合响应敏感场景。" },
  { id: "step-3.5-flash", name: "Step-3.5-Flash", vendor: "Stepfun", description: "低延迟通用模型，适合快速推理与实时交互。" },
]);

const FREE_MODEL_IDS = new Set(PEAR_API_FREE_MODELS.map((model) => model.id));
const SECRET_PATTERN = /^[^\s\u0000-\u001f\u007f]{8,4096}$/u;
const DEFAULT_PRICING = Object.freeze({ imageMinFen: 0, imageMaxFen: 0, videoMinFen: 0, videoMaxFen: 0 });

export class PearApiError extends Error {
  constructor(message, { status = 502, code = "PEAR_API_ERROR", details = null } = {}) {
    super(message);
    this.name = "PearApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizedSecret(value) {
  const secret = String(value || "").trim();
  if (!SECRET_PATTERN.test(secret)) throw new PearApiError("PearAPI 凭据至少 8 位，且不能包含空格或控制字符", { status: 400, code: "INVALID_PEAR_CREDENTIAL" });
  return secret;
}

function safeFen(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000 ? number : 0;
}

function normalizedPricing(value = {}) {
  const pricing = {
    imageMinFen: safeFen(value.imageMinFen),
    imageMaxFen: safeFen(value.imageMaxFen),
    videoMinFen: safeFen(value.videoMinFen),
    videoMaxFen: safeFen(value.videoMaxFen),
  };
  if (pricing.imageMinFen && pricing.imageMaxFen && pricing.imageMinFen > pricing.imageMaxFen) {
    [pricing.imageMinFen, pricing.imageMaxFen] = [pricing.imageMaxFen, pricing.imageMinFen];
  }
  if (pricing.videoMinFen && pricing.videoMaxFen && pricing.videoMinFen > pricing.videoMaxFen) {
    [pricing.videoMinFen, pricing.videoMaxFen] = [pricing.videoMaxFen, pricing.videoMinFen];
  }
  return pricing;
}

export function pearApiMarkedUpFen(baseFen) {
  return baseFen ? Math.ceil(baseFen * (1 + PEAR_API_MARKUP_RATE)) : 0;
}

export function pearApiOutputRange(balanceFen, minFen, maxFen) {
  const cheapest = pearApiMarkedUpFen(minFen);
  const mostExpensive = pearApiMarkedUpFen(maxFen);
  if (!cheapest || !mostExpensive) return null;
  return {
    minimum: Math.floor(balanceFen / mostExpensive),
    maximum: Math.floor(balanceFen / cheapest),
    cheapestUnitFen: cheapest,
    mostExpensiveUnitFen: mostExpensive,
  };
}

function utcDayKey(date) {
  return date.toISOString().slice(0, 10);
}

function rollingDays(count, now = new Date()) {
  const days = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - offset);
    days.push({ date: utcDayKey(date), usedFen: 0, calls: 0 });
  }
  return days;
}

async function usageSnapshot(ownerId, balanceFen, pricing, now = new Date()) {
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - 29);
  const rows = await (await getCollection("agentUsage")).aggregate([
    { $match: { ownerId, status: "succeeded", createdAt: { $gte: from } } },
    { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: "UTC" } }, usedFen: { $sum: "$chargedFen" }, calls: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  const byDay = new Map(rows.map((row) => [row._id, row]));
  const monthly = rollingDays(30, now).map((day) => ({ ...day, usedFen: Number(byDay.get(day.date)?.usedFen || 0), calls: Number(byDay.get(day.date)?.calls || 0) }));
  const weekly = monthly.slice(-7);
  const sum = (items, field) => items.reduce((total, item) => total + Number(item[field] || 0), 0);
  return {
    balanceFen,
    weekly: { days: weekly, usedFen: sum(weekly, "usedFen"), calls: sum(weekly, "calls"), rollingDays: 7 },
    monthly: { days: monthly, usedFen: sum(monthly, "usedFen"), calls: sum(monthly, "calls"), rollingDays: 30 },
    estimates: {
      images: pearApiOutputRange(balanceFen, pricing.imageMinFen, pricing.imageMaxFen),
      videos: pearApiOutputRange(balanceFen, pricing.videoMinFen, pricing.videoMaxFen),
    },
  };
}

async function credentialRecord() {
  return (await getCollection("platformCredentials")).findOne({ provider: "pearapi" });
}

function credentialSecrets(record) {
  return {
    key: readUserSecret(record?.keyEncrypted, "platform-pearapi-key"),
    token: readUserSecret(record?.tokenEncrypted, "platform-pearapi-token"),
  };
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n").trim();
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  return "";
}

export async function callPearApiChat({ token, model, messages, mode = "fast" }) {
  if (!FREE_MODEL_IDS.has(model)) throw new PearApiError("该模型不在古龙网页版免费模型白名单中", { status: 400, code: "MODEL_NOT_ALLOWED" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), mode === "deep" ? 120_000 : 60_000);
  let response;
  try {
    response = await fetch(`${PEAR_API_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${normalizedSecret(token)}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: mode === "deep" ? 0.35 : 0.65,
        max_tokens: mode === "deep" ? 4096 : 2048,
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new PearApiError("PearAPI 响应超时，请稍后重试", { status: 504, code: "PEAR_API_TIMEOUT" });
    throw new PearApiError("暂时无法连接 PearAPI，请稍后重试", { details: error?.message });
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = { raw: raw.slice(0, 1000) }; }
  if (!response.ok) {
    const upstreamMessage = payload?.error?.message || payload?.message || `PearAPI 返回 HTTP ${response.status}`;
    throw new PearApiError(String(upstreamMessage).slice(0, 500), { status: response.status === 401 || response.status === 403 ? 503 : 502, code: response.status === 401 || response.status === 403 ? "PEAR_API_CREDENTIAL_REJECTED" : "PEAR_API_UPSTREAM_ERROR" });
  }
  const text = responseText(payload);
  if (!text) throw new PearApiError("PearAPI 没有返回可显示的文本", { code: "PEAR_API_EMPTY_RESPONSE" });
  return { text, usage: payload.usage || null, responseId: payload.id || null };
}

export async function creditMonthlySubscriptionBalance({ ownerId, amountFen, source, sourceId }) {
  const creditFen = safeFen(amountFen);
  if (!creditFen || !ownerId || !sourceId) return { applied: false, reason: "invalid" };
  const key = `${source}:${sourceId}`;
  const wallets = await getCollection("wallets");
  const now = new Date();
  const credit = { key, kind: "monthly_subscription", amountFen: creditFen, createdAt: now };
  const current = await wallets.findOne({ ownerId }, { projection: { credits: 1 } });
  if (current?.credits?.some((item) => item.key === key)) return { applied: false, reason: "already_applied" };
  let updated = current
    ? await wallets.updateOne(
      { _id: current._id, "credits.key": { $ne: key } },
      { $inc: { balanceFen: creditFen }, $push: { credits: { $each: [credit], $slice: -120 } }, $set: { updatedAt: now } },
    )
    : { matchedCount: 0, modifiedCount: 0 };
  if (!current) {
    try {
      const inserted = await wallets.insertOne({ ownerId, balanceFen: creditFen, credits: [credit], createdAt: now, updatedAt: now });
      return { applied: Boolean(inserted.insertedId), amountFen: creditFen };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      updated = await wallets.updateOne(
        { ownerId, "credits.key": { $ne: key } },
        { $inc: { balanceFen: creditFen }, $push: { credits: { $each: [credit], $slice: -120 } }, $set: { updatedAt: now } },
      );
    }
  }
  return { applied: Boolean(updated.modifiedCount), amountFen: updated.modifiedCount ? creditFen : 0 };
}

const ErrorSchema = z.object({ code: z.string(), message: z.string() });
const ModelSchema = z.object({ id: z.string(), name: z.string(), vendor: z.string(), description: z.string(), free: z.literal(true) });
const MessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(12_000) });

export function registerPearApiRoutes(app, { authenticate, requireAdmin, requireTrustedMutation }) {
  const modelsRoute = createRoute({
    method: "get", path: "/api/agent/models", tags: ["Web Agent"], summary: "列出网页版允许使用的 PearAPI 免费模型",
    responses: { 200: { description: "免费模型白名单", content: { "application/json": { schema: z.object({ models: z.array(ModelSchema), defaultModel: z.string() }) } } } },
  });
  const bootstrapRoute = createRoute({
    method: "get", path: "/api/agent/bootstrap", tags: ["Web Agent"], summary: "获取网页版 Agent 余额、滚动用量与可用模型",
    responses: { 200: { description: "Agent 启动数据" }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const chatRoute = createRoute({
    method: "post", path: "/api/agent/chat", tags: ["Web Agent"], summary: "通过 PearAPI 免费模型完成文本对话",
    request: { body: { content: { "application/json": { schema: z.object({ model: z.string(), mode: z.enum(["fast", "deep"]).default("fast"), conversationId: z.string().optional(), messages: z.array(MessageSchema).min(1).max(24) }) } } } },
    responses: { 200: { description: "模型回复" }, 400: { description: "参数或模型不允许", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } }, 402: { description: "订阅未生效", content: { "application/json": { schema: ErrorSchema } } }, 503: { description: "管理员尚未配置 PearAPI", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const adminGetRoute = createRoute({
    method: "get", path: "/api/admin/pearapi/config", tags: ["Admin"], summary: "读取 PearAPI 全局配置（仅返回掩码）",
    responses: { 200: { description: "PearAPI 配置状态" }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } }, 403: { description: "仅管理员", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const adminPutRoute = createRoute({
    method: "put", path: "/api/admin/pearapi/config", tags: ["Admin"], summary: "加密保存 PearAPI 全局 Key、令牌与媒体成本区间",
    request: { body: { content: { "application/json": { schema: z.object({ key: z.string().max(4096).optional(), token: z.string().max(4096).optional(), clearKey: z.boolean().optional(), clearToken: z.boolean().optional(), imageMinFen: z.number().int().min(0).max(10_000_000).optional(), imageMaxFen: z.number().int().min(0).max(10_000_000).optional(), videoMinFen: z.number().int().min(0).max(10_000_000).optional(), videoMaxFen: z.number().int().min(0).max(10_000_000).optional() }) } } } },
    responses: { 200: { description: "配置已保存" }, 400: { description: "配置无效", content: { "application/json": { schema: ErrorSchema } } }, 403: { description: "仅管理员", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const adminTestRoute = createRoute({
    method: "post", path: "/api/admin/pearapi/test", tags: ["Admin"], summary: "用免费模型验证 PearAPI 令牌",
    responses: { 200: { description: "连接成功" }, 503: { description: "令牌无效或服务不可用", content: { "application/json": { schema: ErrorSchema } } } },
  });

  app.openapi(modelsRoute, (c) => c.json({ models: PEAR_API_FREE_MODELS.map((model) => ({ ...model, free: true })), defaultModel: PEAR_API_FREE_MODELS[0].id }));

  app.openapi(bootstrapRoute, async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const ownerId = new ObjectId(auth.user.id);
    const now = new Date();
    const [subscription, wallet, credential] = await Promise.all([
      (await getCollection("subscriptions")).findOne({ ownerId }),
      (await getCollection("wallets")).findOne({ ownerId }),
      credentialRecord(),
    ]);
    const active = auth.user.role === "admin" || Boolean(subscription?.currentPeriodStart <= now && subscription?.currentPeriodEnd > now && !["cancelled", "canceled"].includes(subscription?.status));
    const pricing = normalizedPricing(credential?.pricing || DEFAULT_PRICING);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      configured: Boolean(credentialSecrets(credential).token),
      subscription: { active, restricted: !active, currentPeriodEnd: subscription?.currentPeriodEnd || null },
      models: PEAR_API_FREE_MODELS.map((model) => ({ ...model, free: true })),
      defaultModel: PEAR_API_FREE_MODELS[0].id,
      pricing: { ...pricing, markupRate: PEAR_API_MARKUP_RATE },
      quota: await usageSnapshot(ownerId, Number(wallet?.balanceFen || 0), pricing, now),
    });
  });

  app.openapi(chatRoute, async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`pear-chat:${auth.user.id}`, { limit: 30, windowMs: 5 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "对话请求过于频繁，请稍后再试" }, 429);
    const input = c.req.valid("json");
    if (!FREE_MODEL_IDS.has(input.model)) return c.json({ code: "MODEL_NOT_ALLOWED", message: "请选择管理员公布的 PearAPI 免费模型" }, 400);
    const ownerId = new ObjectId(auth.user.id);
    const now = new Date();
    if (auth.user.role !== "admin") {
      const subscription = await (await getCollection("subscriptions")).findOne({ ownerId });
      if (!subscription || subscription.currentPeriodStart > now || subscription.currentPeriodEnd <= now || ["cancelled", "canceled", "expired"].includes(subscription.status)) {
        return c.json({ code: "SUBSCRIPTION_REQUIRED", message: "网页版古龙 Agent 需要生效中的会员订阅，请先续费后使用" }, 402);
      }
    }
    const record = await credentialRecord();
    const token = credentialSecrets(record).token;
    if (!token) return c.json({ code: "PEAR_API_NOT_CONFIGURED", message: "管理员尚未配置 PearAPI 令牌" }, 503);
    const conversationId = ObjectId.isValid(input.conversationId) ? new ObjectId(input.conversationId) : new ObjectId();
    const requestId = `pear_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const system = input.mode === "deep"
      ? "你是古龙网页版智能助手。先充分分析再给出清晰、可执行、通俗易懂的答案。网页版不具备第二大脑、本地模型、插件、技能或工作流，不要声称已调用这些能力。"
      : "你是古龙网页版智能助手。直接、准确、简洁地回答。网页版不具备第二大脑、本地模型、插件、技能或工作流，不要声称已调用这些能力。";
    const usage = { ownerId, conversationId, requestId, modality: "text", model: input.model, baseCostFen: 0, chargedFen: 0, markupRate: PEAR_API_MARKUP_RATE, status: "started", createdAt: now, updatedAt: now };
    await (await getCollection("agentUsage")).insertOne(usage);
    try {
      const result = await callPearApiChat({ token, model: input.model, mode: input.mode, messages: [{ role: "system", content: system }, ...input.messages] });
      const completedAt = new Date();
      await Promise.all([
        (await getCollection("agentUsage")).updateOne({ requestId }, { $set: { status: "succeeded", upstreamUsage: result.usage, upstreamResponseId: result.responseId, completedAt, updatedAt: completedAt } }),
        (await getCollection("agentMessages")).insertMany([
          { ownerId, conversationId, requestId, role: "user", content: input.messages.at(-1)?.content || "", model: input.model, mode: input.mode, createdAt: now },
          { ownerId, conversationId, requestId, role: "assistant", content: result.text, model: input.model, mode: input.mode, createdAt: completedAt },
        ]),
      ]);
      c.header("Cache-Control", "private, no-store, max-age=0");
      return c.json({ conversationId: conversationId.toString(), requestId, message: { role: "assistant", content: result.text, createdAt: completedAt }, model: input.model, chargedFen: 0, free: true, usage: result.usage });
    } catch (error) {
      await (await getCollection("agentUsage")).updateOne({ requestId }, { $set: { status: "failed", errorCode: error.code || "PEAR_API_ERROR", failedAt: new Date(), updatedAt: new Date() } });
      return c.json({ code: error.code || "PEAR_API_ERROR", message: error.message || "PearAPI 调用失败" }, error.status || 502);
    }
  });

  function adminView(record) {
    const pricing = normalizedPricing(record?.pricing || DEFAULT_PRICING);
    return {
      provider: "pearapi",
      baseUrl: PEAR_API_BASE_URL,
      acquisitionUrl: PEAR_API_ACQUISITION_URL,
      docsUrl: PEAR_API_DOCS_URL,
      keyConfigured: Boolean(record?.keyEncrypted),
      keyMasked: record?.keyLast4 ? `••••••••${record.keyLast4}` : null,
      tokenConfigured: Boolean(record?.tokenEncrypted),
      tokenMasked: record?.tokenLast4 ? `••••••••${record.tokenLast4}` : null,
      pricing: { ...pricing, markupRate: PEAR_API_MARKUP_RATE },
      models: PEAR_API_FREE_MODELS.map((model) => ({ ...model, free: true })),
      updatedAt: record?.updatedAt || null,
    };
  }

  app.openapi(adminGetRoute, async (c) => {
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json(adminView(await credentialRecord()));
  });

  app.openapi(adminPutRoute, async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const input = c.req.valid("json");
    const collection = await getCollection("platformCredentials");
    const existing = await credentialRecord();
    const pricing = normalizedPricing({ ...DEFAULT_PRICING, ...(existing?.pricing || {}), ...input });
    const now = new Date();
    const set = { pricing, updatedAt: now, updatedBy: new ObjectId(auth.user.id) };
    const unset = {};
    if (String(input.key || "").trim()) { const key = normalizedSecret(input.key); set.keyEncrypted = sealUserSecret(key, "platform-pearapi-key"); set.keyLast4 = key.slice(-4); }
    if (String(input.token || "").trim()) { const token = normalizedSecret(input.token); set.tokenEncrypted = sealUserSecret(token, "platform-pearapi-token"); set.tokenLast4 = token.slice(-4); }
    if (input.clearKey) { unset.keyEncrypted = ""; unset.keyLast4 = ""; }
    if (input.clearToken) { unset.tokenEncrypted = ""; unset.tokenLast4 = ""; }
    await collection.updateOne(
      { provider: "pearapi" },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $setOnInsert: { provider: "pearapi", createdAt: now } },
      { upsert: true },
    );
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ ok: true, config: adminView(await credentialRecord()) });
  });

  app.openapi(adminTestRoute, async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`pear-admin-test:${auth.user.id}`, { limit: 10, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "连接测试过于频繁，请稍后再试" }, 429);
    const token = credentialSecrets(await credentialRecord()).token;
    if (!token) return c.json({ code: "PEAR_API_NOT_CONFIGURED", message: "请先保存 PearAPI 默认令牌" }, 503);
    try {
      const result = await callPearApiChat({ token, model: PEAR_API_FREE_MODELS[0].id, messages: [{ role: "user", content: "仅回复：连接成功" }] });
      return c.json({ ok: true, model: PEAR_API_FREE_MODELS[0].id, reply: result.text.slice(0, 120) });
    } catch (error) {
      return c.json({ code: error.code || "PEAR_API_ERROR", message: error.message || "PearAPI 连接测试失败" }, error.status || 503);
    }
  });
}
