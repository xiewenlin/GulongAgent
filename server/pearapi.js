import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { createRoute, z } from "@hono/zod-openapi";
import { getCollection } from "./db.js";
import { enforceRateLimit } from "./rate-limit.js";
import { readUserSecret, sealUserSecret } from "./security.js";
import {
  PEAR_API_IMAGE_MODELS,
  PEAR_API_MEDIA_MODEL_MAP,
  PEAR_API_VIDEO_MODELS,
  PEAR_IMAGE_SIZES,
  PEAR_VIDEO_DURATIONS,
  publicPearMediaModel,
  resolvePearAutoModel,
} from "./pearapi-models.js";

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
const DEFAULT_PRICING = Object.freeze({ imageMinFen: 1, imageMaxFen: 32, videoMinFen: 4, videoMaxFen: 193 });

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
    imageMinFen: safeFen(value.imageMinFen) || DEFAULT_PRICING.imageMinFen,
    imageMaxFen: safeFen(value.imageMaxFen) || DEFAULT_PRICING.imageMaxFen,
    videoMinFen: safeFen(value.videoMinFen) || DEFAULT_PRICING.videoMinFen,
    videoMaxFen: safeFen(value.videoMaxFen) || DEFAULT_PRICING.videoMaxFen,
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

const IMAGE_ENDPOINT = `${PEAR_API_BASE_URL}/api/image_generate`;
const VIDEO_ENDPOINT = `${PEAR_API_BASE_URL}/api/video_generate`;
const MEDIA_SUCCEEDED = new Set(["completed", "succeeded", "succeed", "success", "done"]);
const MEDIA_FAILED = new Set(["failed", "failure", "error", "cancelled", "canceled", "rejected"]);

function pointerValue(payload, paths) {
  for (const path of paths) {
    let value = payload;
    for (const part of path.split("/").filter(Boolean)) value = value?.[part];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function upstreamMessage(payload, fallback) {
  const value = pointerValue(payload, ["/data/data/error", "/data/error", "/error/message", "/error", "/message", "/msg"]);
  if (typeof value === "string") return value.slice(0, 500);
  return fallback;
}

async function pearMediaRequest(endpoint, payload, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new PearApiError("PearAPI 媒体服务响应超时，请稍后重试", { status: 504, code: "PEAR_API_TIMEOUT" });
    throw new PearApiError("暂时无法连接 PearAPI 媒体服务", { details: error?.message });
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : {}; }
  catch { result = { raw: raw.slice(0, 1000) }; }
  if (!response.ok) throw new PearApiError(upstreamMessage(result, `PearAPI 返回 HTTP ${response.status}`), { status: response.status === 401 || response.status === 403 ? 503 : 502, code: "PEAR_API_UPSTREAM_ERROR" });
  const code = String(pointerValue(result, ["/data/data/code", "/data/code", "/code"]) ?? "");
  if (code && !["0", "200"].includes(code)) throw new PearApiError(upstreamMessage(result, "PearAPI 媒体任务提交失败"), { code: "PEAR_API_UPSTREAM_ERROR" });
  return result;
}

async function pearImageMultipartRequest({ key, model, prompt, imageSize, referenceImages }) {
  const form = new FormData();
  form.append("key", key);
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", imageSize);
  form.append("task_type", "async");
  form.append("task_id", "");
  for (const [index, dataUrl] of referenceImages.entries()) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new PearApiError("参考图格式无效", { status: 400, code: "INVALID_REFERENCE_IMAGE" });
    const body = Buffer.from(match[2], "base64");
    form.append("images[]", new Blob([body], { type: match[1] }), `reference-${index + 1}.${match[1].split("/")[1].replace("jpeg", "jpg")}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(IMAGE_ENDPOINT, { method: "POST", signal: controller.signal, headers: { Accept: "application/json" }, body: form });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; } catch { result = { raw: raw.slice(0, 1000) }; }
    if (!response.ok) throw new PearApiError(upstreamMessage(result, `PearAPI 返回 HTTP ${response.status}`), { status: 502, code: "PEAR_API_UPSTREAM_ERROR" });
    return result;
  } catch (error) {
    if (error instanceof PearApiError) throw error;
    if (error?.name === "AbortError") throw new PearApiError("PearAPI 图片任务提交超时，请稍后重试", { status: 504, code: "PEAR_API_TIMEOUT" });
    throw new PearApiError("暂时无法连接 PearAPI 图片服务", { details: error?.message });
  } finally {
    clearTimeout(timer);
  }
}

async function submitPearMedia({ key, modality, model, prompt, referenceImages, imageSize, aspectRatio, duration }) {
  if (modality === "image") {
    return referenceImages.length
      ? pearImageMultipartRequest({ key, model, prompt, imageSize, referenceImages })
      : pearMediaRequest(IMAGE_ENDPOINT, { key, model, prompt, images: [], size: imageSize, task_type: "async", task_id: "" });
  }
  return pearMediaRequest(VIDEO_ENDPOINT, { key, model, prompt, aspect_ratio: aspectRatio, duration, images: referenceImages });
}

async function pollPearMedia({ key, modality, upstreamTaskId }) {
  return pearMediaRequest(modality === "image" ? IMAGE_ENDPOINT : VIDEO_ENDPOINT, modality === "image" ? { key, task_id: upstreamTaskId } : { key, taskid: upstreamTaskId });
}

function mediaTaskId(payload) {
  const value = pointerValue(payload, ["/data/data/task_id", "/data/data/taskid", "/data/data/id", "/data/task_id", "/data/taskid", "/data/id", "/task_id", "/taskid", "/id"]);
  return value == null ? "" : String(value);
}

function imageUrls(payload) {
  const value = pointerValue(payload, ["/data/data/image_urls", "/data/image_urls", "/image_urls", "/data/data/images", "/data/images", "/images", "/data/data/image_url", "/data/image_url", "/image_url", "/data/data/url", "/data/url", "/url"]);
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => typeof item === "string" ? item : item?.url || item?.image_url || "").filter((url) => /^https:\/\//i.test(url));
}

function videoUrls(payload) {
  const value = pointerValue(payload, ["/data/data/api_file_url", "/content/video_url", "/content/url", "/enhancement/resultVideoUrl", "/data/content/video_url", "/data/content/url", "/data/enhancement/resultVideoUrl", "/data/api_file_url", "/api_file_url", "/data/data/url", "/data/url", "/url"]);
  return typeof value === "string" && /^https:\/\//i.test(value) ? [value] : [];
}

function mediaStatus(payload, modality) {
  const urls = modality === "image" ? imageUrls(payload) : videoUrls(payload);
  if (urls.length) return { status: "succeeded", urls };
  const raw = String(pointerValue(payload, ["/data/data/status", "/data/status", "/status"]) || "").toLowerCase();
  if (MEDIA_FAILED.has(raw)) return { status: "failed", urls, error: upstreamMessage(payload, "PearAPI 生成任务失败") };
  if (MEDIA_SUCCEEDED.has(raw)) return { status: "failed", urls, error: "PearAPI 已完成任务，但没有返回可用的媒体地址" };
  return { status: "processing", urls };
}

function chargedFenForModel(model, modality, duration = 5) {
  const durationFactor = modality === "video" ? Math.max(1, Number(duration || 5) / 5) : 1;
  return Math.max(1, Math.ceil((Number(model.baseCostMilliFen || 0) * durationFactor * (1 + PEAR_API_MARKUP_RATE)) / 1000));
}

function mediaPublicView(job) {
  return {
    id: job._id.toString(),
    conversationId: job.conversationId.toString(),
    modality: job.modality,
    requestedModel: job.requestedModel,
    model: job.model,
    modelName: job.modelName,
    status: job.status,
    prompt: job.prompt,
    urls: job.urls || [],
    chargedFen: job.chargedFen,
    error: job.error || null,
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
  };
}

async function refundMediaJob(job, error) {
  const jobs = await getCollection("agentMediaJobs");
  const now = new Date();
  const claimed = await jobs.findOneAndUpdate(
    { _id: job._id, chargeStatus: "reserved", status: { $nin: ["succeeded", "failed"] } },
    { $set: { status: "failed", chargeStatus: "refunding", error: String(error || "生成失败").slice(0, 500), failedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!claimed) return jobs.findOne({ _id: job._id });
  await (await getCollection("wallets")).updateOne({ ownerId: job.ownerId }, { $inc: { balanceFen: job.chargedFen }, $set: { updatedAt: now } });
  await Promise.all([
    jobs.updateOne({ _id: job._id, chargeStatus: "refunding" }, { $set: { chargeStatus: "refunded", refundedAt: now, updatedAt: now } }),
    (await getCollection("agentUsage")).updateOne({ requestId: job.requestId }, { $set: { status: "failed", refundedFen: job.chargedFen, errorCode: "MEDIA_GENERATION_FAILED", failedAt: now, updatedAt: now } }),
  ]);
  return jobs.findOne({ _id: job._id });
}

export async function callPearApiChat({ token, model, messages }) {
  if (!FREE_MODEL_IDS.has(model)) throw new PearApiError("该模型不在古龙网页版免费模型白名单中", { status: 400, code: "MODEL_NOT_ALLOWED" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
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
        temperature: 0.65,
        max_tokens: 2048,
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
const ReferenceImageSchema = z.string().max(900_000).refine((value) => /^data:image\/(jpeg|png|webp);base64,/i.test(value), "仅支持 JPEG、PNG 或 WebP 图片");

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
    request: { body: { content: { "application/json": { schema: z.object({ model: z.string(), conversationId: z.string().optional(), messages: z.array(MessageSchema).min(1).max(24) }) } } } },
    responses: { 200: { description: "模型回复" }, 400: { description: "参数或模型不允许", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } }, 402: { description: "订阅未生效", content: { "application/json": { schema: ErrorSchema } } }, 503: { description: "管理员尚未配置 PearAPI", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const mediaCreateRoute = createRoute({
    method: "post", path: "/api/agent/media", tags: ["Web Agent"], summary: "提交 PearAPI 图片或视频生成任务",
    request: { body: { content: { "application/json": { schema: z.object({
      modality: z.enum(["image", "video"]), model: z.string(), prompt: z.string().trim().min(1).max(4_096), conversationId: z.string().optional(),
      referenceImages: z.array(ReferenceImageSchema).max(16).default([]), imageSize: z.enum(PEAR_IMAGE_SIZES).default("1:1"),
      aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"), duration: z.number().int().refine((value) => PEAR_VIDEO_DURATIONS.includes(value), "不支持的视频时长").default(5),
    }) } } } },
    responses: { 201: { description: "媒体任务已提交" }, 400: { description: "模型或参数无效", content: { "application/json": { schema: ErrorSchema } } }, 402: { description: "余额或订阅不足", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const mediaStatusRoute = createRoute({
    method: "get", path: "/api/agent/media/{id}", tags: ["Web Agent"], summary: "查询并推进 PearAPI 媒体任务",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "媒体任务状态" }, 404: { description: "任务不存在", content: { "application/json": { schema: ErrorSchema } } } },
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
    const [subscription, wallet, credential, assets] = await Promise.all([
      (await getCollection("subscriptions")).findOne({ ownerId }),
      (await getCollection("wallets")).findOne({ ownerId }),
      credentialRecord(),
      (await getCollection("agentMediaJobs")).find({ ownerId, status: "succeeded" }).sort({ completedAt: -1 }).limit(12).toArray(),
    ]);
    const active = auth.user.role === "admin" || Boolean(subscription?.currentPeriodStart <= now && subscription?.currentPeriodEnd > now && !["cancelled", "canceled"].includes(subscription?.status));
    const pricing = normalizedPricing(credential?.pricing || DEFAULT_PRICING);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      configured: Boolean(credentialSecrets(credential).token),
      mediaConfigured: Boolean(credentialSecrets(credential).key),
      subscription: { active, restricted: !active, currentPeriodEnd: subscription?.currentPeriodEnd || null },
      models: PEAR_API_FREE_MODELS.map((model) => ({ ...model, free: true })),
      defaultModel: PEAR_API_FREE_MODELS[0].id,
      mediaModels: {
        image: PEAR_API_IMAGE_MODELS.map((model) => publicPearMediaModel(model, PEAR_API_MARKUP_RATE)),
        video: PEAR_API_VIDEO_MODELS.map((model) => publicPearMediaModel(model, PEAR_API_MARKUP_RATE)),
      },
      mediaDefaults: { image: "auto-image", video: "auto-video", imageSize: "1:1", aspectRatio: "16:9", duration: 5 },
      mediaOptions: { imageSizes: PEAR_IMAGE_SIZES, videoDurations: PEAR_VIDEO_DURATIONS, videoAspectRatios: ["16:9", "9:16"] },
      pricing: { ...pricing, markupRate: PEAR_API_MARKUP_RATE },
      quota: await usageSnapshot(ownerId, Number(wallet?.balanceFen || 0), pricing, now),
      assets: assets.map(mediaPublicView),
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
    const system = "你是古龙网页版智能助手。直接、准确、简洁地回答。网页版不具备第二大脑、本地模型、插件、技能或工作流，不要声称已调用这些能力。";
    const usage = { ownerId, conversationId, requestId, modality: "text", model: input.model, baseCostFen: 0, chargedFen: 0, markupRate: PEAR_API_MARKUP_RATE, status: "started", createdAt: now, updatedAt: now };
    await (await getCollection("agentUsage")).insertOne(usage);
    try {
      const result = await callPearApiChat({ token, model: input.model, messages: [{ role: "system", content: system }, ...input.messages] });
      const completedAt = new Date();
      await Promise.all([
        (await getCollection("agentUsage")).updateOne({ requestId }, { $set: { status: "succeeded", upstreamUsage: result.usage, upstreamResponseId: result.responseId, completedAt, updatedAt: completedAt } }),
        (await getCollection("agentMessages")).insertMany([
          { ownerId, conversationId, requestId, role: "user", content: input.messages.at(-1)?.content || "", model: input.model, createdAt: now },
          { ownerId, conversationId, requestId, role: "assistant", content: result.text, model: input.model, createdAt: completedAt },
        ]),
      ]);
      c.header("Cache-Control", "private, no-store, max-age=0");
      return c.json({ conversationId: conversationId.toString(), requestId, message: { role: "assistant", content: result.text, createdAt: completedAt }, model: input.model, chargedFen: 0, free: true, usage: result.usage });
    } catch (error) {
      await (await getCollection("agentUsage")).updateOne({ requestId }, { $set: { status: "failed", errorCode: error.code || "PEAR_API_ERROR", failedAt: new Date(), updatedAt: new Date() } });
      return c.json({ code: error.code || "PEAR_API_ERROR", message: error.message || "PearAPI 调用失败" }, error.status || 502);
    }
  });

  app.openapi(mediaCreateRoute, async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`pear-media:${auth.user.id}`, { limit: 12, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "媒体生成请求过于频繁，请稍后再试" }, 429);
    const input = c.req.valid("json");
    const requested = PEAR_API_MEDIA_MODEL_MAP.get(input.model);
    if (!requested || requested.modality !== input.modality) return c.json({ code: "MODEL_NOT_ALLOWED", message: "请选择当前创作类型对应的 PearAPI 模型" }, 400);
    const ownerId = new ObjectId(auth.user.id);
    const now = new Date();
    if (auth.user.role !== "admin") {
      const subscription = await (await getCollection("subscriptions")).findOne({ ownerId });
      if (!subscription || subscription.currentPeriodStart > now || subscription.currentPeriodEnd <= now || ["cancelled", "canceled", "expired"].includes(subscription.status)) {
        return c.json({ code: "SUBSCRIPTION_REQUIRED", message: "图片和视频创作需要生效中的会员订阅" }, 402);
      }
    }
    const record = await credentialRecord();
    const key = credentialSecrets(record).key;
    if (!key) return c.json({ code: "PEAR_API_KEY_NOT_CONFIGURED", message: "管理员尚未配置 PearAPI Key" }, 503);
    const actual = requested.auto ? resolvePearAutoModel(input.modality, input.prompt) : requested;
    if (input.referenceImages.reduce((total, value) => total + value.length, 0) > 3_200_000) return c.json({ code: "REFERENCE_IMAGES_TOO_LARGE", message: "参考图编码后总大小不能超过 3.2 MB，请压缩后重试" }, 413);
    const referenceImages = input.referenceImages.slice(0, actual.referenceImages);
    if (input.referenceImages.length > actual.referenceImages) return c.json({ code: "TOO_MANY_REFERENCE_IMAGES", message: `${actual.name} 最多支持 ${actual.referenceImages} 张参考图` }, 400);
    const chargedFen = chargedFenForModel(actual, input.modality, input.duration);
    const wallets = await getCollection("wallets");
    const debited = await wallets.findOneAndUpdate(
      { ownerId, balanceFen: { $gte: chargedFen } },
      { $inc: { balanceFen: -chargedFen }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!debited) return c.json({ code: "INSUFFICIENT_BALANCE", message: `余额不足，本次预计扣除 ${chargedFen / 100} 元（已含 30% 服务费）` }, 402);
    const conversationId = ObjectId.isValid(input.conversationId) ? new ObjectId(input.conversationId) : new ObjectId();
    const requestId = `pear_media_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const jobs = await getCollection("agentMediaJobs");
    const inserted = await jobs.insertOne({
      ownerId, conversationId, requestId, modality: input.modality, requestedModel: requested.id, model: actual.id, modelName: actual.name,
      prompt: input.prompt, referenceCount: referenceImages.length, imageSize: input.imageSize, aspectRatio: input.aspectRatio, duration: input.duration,
      baseCostMilliFen: actual.baseCostMilliFen, chargedFen, markupRate: PEAR_API_MARKUP_RATE, chargeStatus: "reserved", status: "submitting", createdAt: now, updatedAt: now,
    });
    const job = await jobs.findOne({ _id: inserted.insertedId });
    await (await getCollection("agentUsage")).insertOne({ ownerId, conversationId, requestId, mediaJobId: job._id, modality: input.modality, model: actual.id, requestedModel: requested.id, baseCostMilliFen: actual.baseCostMilliFen, chargedFen, markupRate: PEAR_API_MARKUP_RATE, status: "started", createdAt: now, updatedAt: now });
    try {
      const payload = await submitPearMedia({ key, modality: input.modality, model: actual.id, prompt: input.prompt, referenceImages, imageSize: input.imageSize, aspectRatio: input.aspectRatio, duration: input.duration });
      const parsed = mediaStatus(payload, input.modality);
      const upstreamTaskId = mediaTaskId(payload);
      if (parsed.status === "failed") {
        const failed = await refundMediaJob(job, parsed.error);
        return c.json({ code: "MEDIA_GENERATION_FAILED", message: failed.error }, 502);
      }
      if (!upstreamTaskId && parsed.status !== "succeeded") {
        const failed = await refundMediaJob(job, "PearAPI 没有返回任务编号");
        return c.json({ code: "PEAR_API_INVALID_RESPONSE", message: failed.error }, 502);
      }
      const completedAt = parsed.status === "succeeded" ? new Date() : null;
      const update = { status: parsed.status, upstreamTaskId, urls: parsed.urls, nextPollAt: new Date(Date.now() + 4_000), updatedAt: new Date() };
      if (completedAt) Object.assign(update, { completedAt, chargeStatus: "confirmed" });
      await jobs.updateOne({ _id: job._id }, { $set: update });
      if (completedAt) await Promise.all([
        (await getCollection("agentUsage")).updateOne({ requestId }, { $set: { status: "succeeded", completedAt, updatedAt: completedAt } }),
        (await getCollection("agentMessages")).insertMany([
          { ownerId, conversationId, requestId, role: "user", content: input.prompt, modality: input.modality, model: actual.id, createdAt: now },
          { ownerId, conversationId, requestId, role: "assistant", content: `${actual.name} 创作完成`, modality: input.modality, model: actual.id, urls: parsed.urls, createdAt: completedAt },
        ]),
      ]);
      const current = await jobs.findOne({ _id: job._id });
      c.header("Cache-Control", "private, no-store, max-age=0");
      return c.json({ job: mediaPublicView(current) }, 201);
    } catch (error) {
      const failed = await refundMediaJob(job, error.message || "PearAPI 媒体任务提交失败");
      return c.json({ code: error.code || "PEAR_API_ERROR", message: failed.error }, error.status || 502);
    }
  });

  app.openapi(mediaStatusRoute, async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ code: "NOT_FOUND", message: "媒体任务不存在" }, 404);
    const ownerId = new ObjectId(auth.user.id);
    const jobs = await getCollection("agentMediaJobs");
    let job = await jobs.findOne({ _id: new ObjectId(id), ...(auth.user.role === "admin" ? {} : { ownerId }) });
    if (!job) return c.json({ code: "NOT_FOUND", message: "媒体任务不存在" }, 404);
    if (["succeeded", "failed"].includes(job.status)) return c.json({ job: mediaPublicView(job) });
    const now = new Date();
    if (!job.upstreamTaskId || (job.nextPollAt && job.nextPollAt > now)) return c.json({ job: mediaPublicView(job) });
    const leased = await jobs.findOneAndUpdate(
      { _id: job._id, status: "processing", nextPollAt: { $lte: now }, $or: [{ pollingUntil: { $exists: false } }, { pollingUntil: { $lte: now } }] },
      { $set: { pollingUntil: new Date(Date.now() + 30_000), nextPollAt: new Date(Date.now() + 5_000), updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!leased) return c.json({ job: mediaPublicView(await jobs.findOne({ _id: job._id })) });
    try {
      const key = credentialSecrets(await credentialRecord()).key;
      if (!key) throw new PearApiError("管理员尚未配置 PearAPI Key", { status: 503, code: "PEAR_API_KEY_NOT_CONFIGURED" });
      const payload = await pollPearMedia({ key, modality: job.modality, upstreamTaskId: job.upstreamTaskId });
      const parsed = mediaStatus(payload, job.modality);
      if (parsed.status === "failed") job = await refundMediaJob(job, parsed.error);
      else if (parsed.status === "succeeded") {
        const completedAt = new Date();
        job = await jobs.findOneAndUpdate({ _id: job._id, status: "processing" }, { $set: { status: "succeeded", chargeStatus: "confirmed", urls: parsed.urls, completedAt, updatedAt: completedAt }, $unset: { pollingUntil: "" } }, { returnDocument: "after" });
        await Promise.all([
          (await getCollection("agentUsage")).updateOne({ requestId: job.requestId }, { $set: { status: "succeeded", completedAt, updatedAt: completedAt } }),
          (await getCollection("agentMessages")).insertMany([
            { ownerId: job.ownerId, conversationId: job.conversationId, requestId: job.requestId, role: "user", content: job.prompt, modality: job.modality, model: job.model, createdAt: job.createdAt },
            { ownerId: job.ownerId, conversationId: job.conversationId, requestId: job.requestId, role: "assistant", content: `${job.modelName} 创作完成`, modality: job.modality, model: job.model, urls: parsed.urls, createdAt: completedAt },
          ]),
        ]);
      } else {
        await jobs.updateOne({ _id: job._id }, { $set: { nextPollAt: new Date(Date.now() + 5_000), updatedAt: new Date() }, $unset: { pollingUntil: "" } });
        job = await jobs.findOne({ _id: job._id });
      }
    } catch (error) {
      await jobs.updateOne({ _id: job._id }, { $set: { nextPollAt: new Date(Date.now() + 10_000), lastPollError: String(error.message || error).slice(0, 300), updatedAt: new Date() }, $unset: { pollingUntil: "" } });
      job = await jobs.findOne({ _id: job._id });
    }
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ job: mediaPublicView(job) });
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
      mediaModels: {
        image: PEAR_API_IMAGE_MODELS.map((model) => publicPearMediaModel(model, PEAR_API_MARKUP_RATE)),
        video: PEAR_API_VIDEO_MODELS.map((model) => publicPearMediaModel(model, PEAR_API_MARKUP_RATE)),
      },
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
