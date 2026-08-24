import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { createRoute, z } from "@hono/zod-openapi";
import { getCollection } from "./db.js";
import { enforceRateLimit } from "./rate-limit.js";
import { readUserSecret, sealUserSecret } from "./security.js";
import { localizeErrorMessage } from "../shared/error-messages.js";
import {
  SHORT_VIDEO_PLAN_ID,
  expireShortVideoPackageAllowance,
  shortVideoPackageView,
} from "./short-video-subscription.js";
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
export const PEAR_API_TOKEN_CHANNELS = Object.freeze(["默认", "优质", "免费", "按次", "特价", "限时免费"]);
export const WALLET_PROMOTION_BONUS_RATE = 0.1;
export const WALLET_RECHARGE_BONUS_THRESHOLD_FEN = 50_000;

export const PEAR_API_FREE_MODELS = Object.freeze([
  { id: "glm-4-flash-250414", name: "GLM-4-Flash-250414", vendor: "GLM", description: "轻量通用模型，适合日常问答、多任务处理与长上下文。" },
  { id: "GPT-OSS-120B", name: "GPT-OSS-120B", vendor: "OpenAI", upstreamIds: ["GPT-OSS-120B", "gpt-oss-120b"], description: "大参数开放模型，适合综合分析、写作与复杂指令。" },
  { id: "hunyuan-mt-7b", name: "Hunyuan-MT-7B", vendor: "Tencent", description: "面向多语言互译的轻量模型，覆盖多种语言。" },
  { id: "hy-mt2-1.8b", name: "HY-MT2-1.8B", vendor: "Tencent", description: "快速多语言翻译模型，适合短文本与高频翻译。" },
  { id: "mistral-7b-instruct-v0.2", name: "Mistral-7B-Instruct-v0.2", vendor: "Mistral", description: "经典指令模型，适合清晰、直接的文本任务。" },
  { id: "spark-lite", name: "Spark-Lite", vendor: "Spark", description: "轻量文本生成与问答模型，适合响应敏感场景。" },
  { id: "step-3.5-flash", name: "Step-3.5-Flash", vendor: "Stepfun", description: "低延迟通用模型，适合快速推理与实时交互。" },
]);

const FREE_MODEL_IDS = new Set(PEAR_API_FREE_MODELS.map((model) => model.id));
const FREE_MODEL_MAP = new Map(PEAR_API_FREE_MODELS.map((model) => [model.id, model]));
const FREE_FALLBACK_MODEL_ID = "glm-4-flash-250414";
const TEXT_WORKFLOW_TITLES = Object.freeze([
  ["understand", "理解任务"],
  ["context", "整理上下文"],
  ["route", "匹配模型"],
  ["inference", "远程推理"],
  ["format", "排版与保存"],
]);
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

export async function buildPearAccountUsageSnapshot({ ownerId, unlimited = false, now = new Date() }) {
  const [subscription, initialWallet, credential] = await Promise.all([
    (await getCollection("subscriptions")).findOne({ ownerId }),
    (await getCollection("wallets")).findOne({ ownerId }),
    credentialRecord(),
  ]);
  let wallet = initialWallet;
  if (subscription?.plan === SHORT_VIDEO_PLAN_ID && !shortVideoPackageView(subscription, wallet, now).active && Number(wallet?.shortVideoPackageBalanceFen || 0) > 0) {
    await expireShortVideoPackageAllowance({ getCollection, ownerId, subscription, now });
    wallet = await (await getCollection("wallets")).findOne({ ownerId });
  }
  const active = unlimited || Boolean(
    subscription?.currentPeriodStart <= now
    && subscription?.currentPeriodEnd > now
    && !["cancelled", "canceled", "expired"].includes(String(subscription?.status || "").toLowerCase()),
  );
  const pricing = normalizedPricing(credential?.pricing || DEFAULT_PRICING);
  const quota = await usageSnapshot(ownerId, Number(wallet?.balanceFen || 0), pricing, now);
  return {
    subscription: {
      active,
      restricted: !active,
      plan: subscription?.plan || null,
      currentPeriodEnd: subscription?.currentPeriodEnd || null,
    },
    shortVideoPackage: shortVideoPackageView(subscription, wallet, now),
    pricing: { ...pricing, markupRate: PEAR_API_MARKUP_RATE },
    quota: { ...quota, unlimited },
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

export async function loadPearApiTextCredential() {
  const record = await credentialRecord();
  return { ...credentialSecrets(record), tokenChannel: record?.tokenChannel || "免费" };
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n").trim();
  if (typeof payload?.choices?.[0]?.text === "string") return payload.choices[0].text.trim();
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  if (Array.isArray(payload?.output)) return payload.output.flatMap((item) => item?.content || []).map((item) => item?.text || "").join("\n").trim();
  if (typeof payload?.choices?.[0]?.message?.reasoning_content === "string") return payload.choices[0].message.reasoning_content.trim();
  return "";
}

function workflowPublicView(record, nowMs = Date.now()) {
  if (!record) return null;
  const startedAtMs = new Date(record.startedAt).getTime();
  const completedAtMs = record.completedAt ? new Date(record.completedAt).getTime() : null;
  return {
    id: record.operationId,
    operationId: record.operationId,
    status: record.status,
    totalMs: Math.max(0, (completedAtMs || nowMs) - startedAtMs),
    nodes: (record.nodes || []).map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      detail: node.detail || null,
      startedAtMs: node.startedAt ? new Date(node.startedAt).getTime() : null,
      elapsedMs: node.startedAt ? Math.max(0, (node.completedAt ? new Date(node.completedAt).getTime() : nowMs) - new Date(node.startedAt).getTime()) : null,
    })),
  };
}

function textWorkflowNodes(now, hasAttachments = false) {
  return TEXT_WORKFLOW_TITLES.map(([id, title], index) => ({
    id,
    title: id === "context" && hasAttachments ? "读取附件" : title,
    status: index === 0 ? "running" : "pending",
    startedAt: index === 0 ? now : null,
    completedAt: null,
    detail: null,
  }));
}

function advanceWorkflowNode(nodes, nodeId, now, { detail = null, failed = false } = {}) {
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return nodes;
  return nodes.map((node, nodeIndex) => {
    if (nodeIndex < index && node.status === "running") return { ...node, status: "completed", completedAt: now };
    if (nodeIndex === index) return { ...node, status: failed ? "failed" : "running", startedAt: node.startedAt || now, completedAt: failed ? now : null, detail };
    return node;
  });
}

function completeWorkflowNode(nodes, nodeId, now, detail = null) {
  return nodes.map((node) => node.id === nodeId ? { ...node, status: "completed", startedAt: node.startedAt || now, completedAt: now, detail: detail || node.detail } : node);
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

export async function reservePearMediaWallet({ wallets, ownerId, amountFen, ledgerKey, requestId, mediaJobId, now = new Date() }) {
  const entry = { key: ledgerKey, kind: "pear_media_reservation", amountFen: -amountFen, requestId, mediaJobId, createdAt: now };
  const wallet = await wallets.findOneAndUpdate(
    { ownerId, balanceFen: { $gte: amountFen }, ledgerKeys: { $ne: ledgerKey } },
    { $inc: { balanceFen: -amountFen }, $push: { ledgerKeys: { $each: [ledgerKey], $slice: -600 }, ledgerEntries: { $each: [entry], $slice: -600 } }, $set: { updatedAt: now } },
    { returnDocument: "after" },
  );
  if (wallet) return { wallet, idempotent: false };
  const existing = await wallets.findOne({ ownerId, ledgerKeys: ledgerKey });
  return existing ? { wallet: existing, idempotent: true } : null;
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
    error: job.error ? localizeErrorMessage(job.error, "媒体生成失败，费用已退回") : null,
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
  };
}

async function refundMediaJob(job, error) {
  const jobs = await getCollection("agentMediaJobs");
  const now = new Date();
  const localizedError = localizeErrorMessage(error, "媒体生成失败，费用已退回").slice(0, 500);
  if (job.chargeStatus === "exempt") {
    const failed = await jobs.findOneAndUpdate(
      { _id: job._id, chargeStatus: "exempt", status: { $nin: ["succeeded", "failed"] } },
      { $set: { status: "failed", error: localizedError, failedAt: now, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (failed) await (await getCollection("agentUsage")).updateOne(
      { requestId: job.requestId },
      { $set: { status: "failed", refundedFen: 0, errorCode: "MEDIA_GENERATION_FAILED", failedAt: now, updatedAt: now } },
    );
    return failed || jobs.findOne({ _id: job._id });
  }
  const claimed = await jobs.findOneAndUpdate(
    { _id: job._id, chargeStatus: "reserved", status: { $nin: ["succeeded", "failed"] } },
    { $set: { status: "failed", chargeStatus: "refunding", error: localizedError, failedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!claimed) return jobs.findOne({ _id: job._id });
  const refundKey = `refund:${job.chargeLedgerKey || job.requestId}`;
  await (await getCollection("wallets")).updateOne(
    { ownerId: job.ownerId, ledgerKeys: { $ne: refundKey } },
    { $inc: { balanceFen: job.chargedFen }, $push: { ledgerKeys: { $each: [refundKey], $slice: -600 }, ledgerEntries: { $each: [{ key: refundKey, kind: "pear_media_refund", amountFen: job.chargedFen, requestId: job.requestId, mediaJobId: job._id, createdAt: now }], $slice: -600 } }, $set: { updatedAt: now } },
  );
  await Promise.all([
    jobs.updateOne({ _id: job._id, chargeStatus: "refunding" }, { $set: { chargeStatus: "refunded", refundedAt: now, updatedAt: now } }),
    (await getCollection("agentUsage")).updateOne({ requestId: job.requestId }, { $set: { status: "failed", refundedFen: job.chargedFen, errorCode: "MEDIA_GENERATION_FAILED", failedAt: now, updatedAt: now } }),
  ]);
  return jobs.findOne({ _id: job._id });
}

async function requestPearApiChat({ token, model, messages, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${PEAR_API_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new PearApiError("PearAPI 模型响应超时", { status: 504, code: "PEAR_API_TIMEOUT", details: { retryable: true } });
    throw new PearApiError("暂时无法连接 PearAPI", { details: { retryable: true, cause: error?.message } });
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = { raw: raw.slice(0, 1000) }; }
  if (!response.ok) {
    const message = (typeof payload?.error === "string" ? payload.error : payload?.error?.message) || payload?.message || `PearAPI 返回 HTTP ${response.status}`;
    const unsupported = response.status === 400 && /不支持的模型|unsupported model|model.+not.+(found|available|support)/i.test(String(message));
    const retryable = unsupported || response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw new PearApiError(String(message).slice(0, 500), {
      status: response.status === 401 || response.status === 403 ? 503 : retryable ? 503 : 502,
      code: response.status === 401 || response.status === 403 ? "PEAR_API_CREDENTIAL_REJECTED" : unsupported ? "PEAR_API_MODEL_UNAVAILABLE" : "PEAR_API_UPSTREAM_ERROR",
      details: { retryable, unsupported, upstreamStatus: response.status },
    });
  }
  const text = responseText(payload);
  if (!text) throw new PearApiError("PearAPI 没有返回可显示的文本", { code: "PEAR_API_EMPTY_RESPONSE", details: { retryable: true } });
  return { text, usage: payload?.usage || null, responseId: payload?.id || null, upstreamModel: payload?.model || model };
}

export async function callPearApiChat({ token, tokenChannel = "免费", model, messages, fetchImpl = fetch, timeoutMs = 75_000, allowFallback = true }) {
  if (!FREE_MODEL_IDS.has(model)) throw new PearApiError("该模型不在古龙网页版免费模型白名单中", { status: 400, code: "MODEL_NOT_ALLOWED" });
  const secret = normalizedSecret(token);
  const definition = FREE_MODEL_MAP.get(model);
  const upstreamIds = definition?.upstreamIds || [model];
  let lastError;
  for (const upstreamId of upstreamIds) {
    try {
      const result = await requestPearApiChat({ token: secret, model: upstreamId, messages, fetchImpl, timeoutMs });
      return { ...result, requestedModel: model, resolvedModel: upstreamId, fallback: false };
    } catch (error) {
      lastError = error;
      if (!error?.details?.unsupported) break;
    }
  }
  if (allowFallback && lastError?.details?.retryable && model !== FREE_FALLBACK_MODEL_ID) {
    try {
      const result = await requestPearApiChat({ token: secret, model: FREE_FALLBACK_MODEL_ID, messages, fetchImpl, timeoutMs });
      return { ...result, requestedModel: model, resolvedModel: FREE_FALLBACK_MODEL_ID, fallback: true, fallbackReason: lastError.code };
    } catch (fallbackError) {
      if (fallbackError?.code === "PEAR_API_CREDENTIAL_REJECTED") throw fallbackError;
    }
  }
  if (lastError?.details?.unsupported) {
    throw new PearApiError(`当前配置的是“${tokenChannel}”渠道令牌，该渠道不支持所选免费模型；请核对令牌渠道，免费文字模型请选择“免费”渠道`, { status: 503, code: "PEAR_API_FREE_TOKEN_REQUIRED" });
  }
  throw lastError;
}

export async function checkPearApiFreeModels({ token, tokenChannel = "免费", fetchImpl = fetch, timeoutMs = 60_000 }) {
  const models = await Promise.all(PEAR_API_FREE_MODELS.map(async (model) => {
    const startedAt = Date.now();
    try {
      const result = await callPearApiChat({
        token,
        tokenChannel,
        model: model.id,
        messages: [{ role: "user", content: "仅回复：正常" }],
        fetchImpl,
        timeoutMs,
        allowFallback: false,
      });
      return { id: model.id, name: model.name, available: true, resolvedModel: result.resolvedModel, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { id: model.id, name: model.name, available: false, code: error.code || "PEAR_API_ERROR", message: localizeErrorMessage(error, "模型检测失败，请稍后重试").slice(0, 180), latencyMs: Date.now() - startedAt };
    }
  }));
  const healthy = models.filter((model) => model.available).length;
  return { healthy, total: models.length, allAvailable: healthy === models.length, models };
}

export async function creditMonthlySubscriptionBalance({ ownerId, amountFen, source, sourceId, kind = "monthly_subscription", collectionProvider = getCollection }) {
  const creditFen = safeFen(amountFen);
  if (!creditFen || !ownerId || !sourceId) return { applied: false, reason: "invalid" };
  const key = `${source}:${sourceId}`;
  const wallets = await collectionProvider("wallets");
  const ledgers = await collectionProvider("walletCreditLedger");
  const now = new Date();
  const credit = { key, kind, amountFen: creditFen, createdAt: now };
  await ledgers.updateOne(
    { creditKey: key },
    { $setOnInsert: { creditKey: key, ownerId, source, sourceId, kind, amountFen: creditFen, status: "pending", createdAt: now }, $set: { updatedAt: now } },
    { upsert: true },
  );
  const ledger = await ledgers.findOne({ creditKey: key });
  if ((ledger?.ownerId?.toString?.() || String(ledger?.ownerId)) !== (ownerId?.toString?.() || String(ownerId)) || ledger?.amountFen !== creditFen || ledger?.kind !== kind) {
    throw Object.assign(new Error("钱包入账流水内容冲突"), { code: "WALLET_CREDIT_CONFLICT", status: 409 });
  }
  const current = await wallets.findOne({ ownerId }, { projection: { credits: 1 } });
  if (current?.credits?.some((item) => item.key === key)) {
    await ledgers.updateOne({ creditKey: key }, { $set: { status: "settled", settledAt: ledger.settledAt || now, updatedAt: now } });
    return { applied: false, reason: "already_applied", amountFen: 0 };
  }
  let updated = current
    ? await wallets.updateOne(
      { _id: current._id, "credits.key": { $ne: key } },
      { $inc: { balanceFen: creditFen }, $push: { credits: credit }, $set: { updatedAt: now } },
    )
    : { matchedCount: 0, modifiedCount: 0 };
  if (!current) {
    try {
      const inserted = await wallets.insertOne({ ownerId, balanceFen: creditFen, credits: [credit], createdAt: now, updatedAt: now });
      if (inserted.insertedId) await ledgers.updateOne({ creditKey: key }, { $set: { status: "settled", settledAt: new Date(), updatedAt: new Date() } });
      return { applied: Boolean(inserted.insertedId), amountFen: inserted.insertedId ? creditFen : 0 };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      updated = await wallets.updateOne(
        { ownerId, "credits.key": { $ne: key } },
        { $inc: { balanceFen: creditFen }, $push: { credits: credit }, $set: { updatedAt: now } },
      );
    }
  }
  const applied = Boolean(updated.modifiedCount);
  const resultingWallet = applied ? true : await wallets.findOne({ ownerId, "credits.key": key }, { projection: { _id: 1 } });
  if (resultingWallet) await ledgers.updateOne({ creditKey: key }, { $set: { status: "settled", settledAt: ledger.settledAt || new Date(), updatedAt: new Date() } });
  return { applied, amountFen: applied ? creditFen : 0 };
}

export function paymentPromotionBonusFen({ amountFen, kind }) {
  const paidFen = safeFen(amountFen);
  const eligible = kind === "subscription_payment" || (kind === "recharge" && paidFen >= WALLET_RECHARGE_BONUS_THRESHOLD_FEN);
  return eligible ? Math.floor(paidFen * WALLET_PROMOTION_BONUS_RATE) : 0;
}

export async function creditPaymentBalanceWithPromotion({ ownerId, amountFen, source, sourceId, kind, collectionProvider = getCollection }) {
  const paidFen = safeFen(amountFen);
  const base = await creditMonthlySubscriptionBalance({ ownerId, amountFen: paidFen, source, sourceId, kind, collectionProvider });
  const bonusFen = paymentPromotionBonusFen({ amountFen: paidFen, kind });
  const bonus = bonusFen > 0
    ? await creditMonthlySubscriptionBalance({ ownerId, amountFen: bonusFen, source: `${source}_bonus`, sourceId, kind: kind === "subscription_payment" ? "subscription_bonus" : "recharge_bonus", collectionProvider })
    : { applied: false, reason: "not_eligible", amountFen: 0 };
  return { base, bonus, paidFen, bonusFen, creditedFen: paidFen + bonusFen };
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
    request: { body: { content: { "application/json": { schema: z.object({ operationId: z.string().min(16).max(96).regex(/^pearop_[a-z0-9_]+$/).optional(), model: z.string(), conversationId: z.string().optional(), messages: z.array(MessageSchema).min(1).max(24) }) } } } },
    responses: { 200: { description: "模型回复与工作流耗时" }, 400: { description: "参数或模型不允许", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } }, 402: { description: "订阅未生效", content: { "application/json": { schema: ErrorSchema } } }, 409: { description: "流程编号重复", content: { "application/json": { schema: ErrorSchema } } }, 503: { description: "管理员尚未配置 PearAPI", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const workflowRoute = createRoute({
    method: "get", path: "/api/agent/workflows/{operationId}", tags: ["Web Agent"], summary: "实时读取一次对话的处理节点与耗时",
    request: { params: z.object({ operationId: z.string().min(16).max(96).regex(/^pearop_[a-z0-9_]+$/) }) },
    responses: { 200: { description: "对话工作流实时状态" }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } }, 404: { description: "流程不存在", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const mediaCreateRoute = createRoute({
    method: "post", path: "/api/agent/media", tags: ["Web Agent"], summary: "提交 PearAPI 图片或视频生成任务",
    request: { body: { content: { "application/json": { schema: z.object({
      modality: z.enum(["image", "video"]), model: z.string(), prompt: z.string().trim().min(1).max(4_096), conversationId: z.string().optional(),
      referenceImages: z.array(ReferenceImageSchema).max(16).default([]), imageSize: z.enum(PEAR_IMAGE_SIZES).default("1:1"),
      aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"), duration: z.number().int().refine((value) => PEAR_VIDEO_DURATIONS.includes(value), "不支持的视频时长").default(5),
    }) } } } },
    responses: { 201: { description: "媒体任务已提交；普通用户与订阅用户返回原子预扣金额和剩余余额，管理员免扣费" }, 400: { description: "模型、参数或 Idempotency-Key 无效", content: { "application/json": { schema: ErrorSchema } } }, 402: { description: "非管理员余额不足", content: { "application/json": { schema: ErrorSchema } } } },
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
    method: "put", path: "/api/admin/pearapi/config", tags: ["Admin"], summary: "加密保存 PearAPI 全局 Key、渠道令牌与媒体成本区间",
    request: { body: { content: { "application/json": { schema: z.object({ key: z.string().max(4096).optional(), token: z.string().max(4096).optional(), tokenChannel: z.enum(PEAR_API_TOKEN_CHANNELS).optional(), clearKey: z.boolean().optional(), clearToken: z.boolean().optional(), imageMinFen: z.number().int().min(0).max(10_000_000).optional(), imageMaxFen: z.number().int().min(0).max(10_000_000).optional(), videoMinFen: z.number().int().min(0).max(10_000_000).optional(), videoMaxFen: z.number().int().min(0).max(10_000_000).optional() }) } } } },
    responses: { 200: { description: "配置已保存" }, 400: { description: "配置无效", content: { "application/json": { schema: ErrorSchema } } }, 403: { description: "仅管理员", content: { "application/json": { schema: ErrorSchema } } } },
  });
  const adminTestRoute = createRoute({
    method: "post", path: "/api/admin/pearapi/test", tags: ["Admin"], summary: "并行检测全部 PearAPI 免费文字模型",
    responses: { 200: { description: "返回全部免费模型的实时可用状态" }, 503: { description: "免费渠道令牌无效或服务不可用", content: { "application/json": { schema: ErrorSchema } } } },
  });

  app.openapi(modelsRoute, (c) => c.json({ models: PEAR_API_FREE_MODELS.map((model) => ({ ...model, free: true })), defaultModel: PEAR_API_FREE_MODELS[0].id }));

  app.openapi(bootstrapRoute, async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const ownerId = new ObjectId(auth.user.id);
    const now = new Date();
    const [accountUsage, credential, assets] = await Promise.all([
      buildPearAccountUsageSnapshot({ ownerId, unlimited: auth.user.role === "admin", now }),
      credentialRecord(),
      (await getCollection("agentMediaJobs")).find({ ownerId, status: "succeeded" }).sort({ completedAt: -1 }).limit(12).toArray(),
    ]);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      configured: Boolean(credentialSecrets(credential).token),
      mediaConfigured: Boolean(credentialSecrets(credential).key),
      subscription: accountUsage.subscription,
      shortVideoPackage: accountUsage.shortVideoPackage,
      models: PEAR_API_FREE_MODELS.map((model) => ({ ...model, free: true })),
      defaultModel: PEAR_API_FREE_MODELS[0].id,
      mediaModels: {
        image: PEAR_API_IMAGE_MODELS.map((model) => publicPearMediaModel(model, PEAR_API_MARKUP_RATE)),
        video: PEAR_API_VIDEO_MODELS.map((model) => publicPearMediaModel(model, PEAR_API_MARKUP_RATE)),
      },
      mediaDefaults: { image: "auto-image", video: "auto-video", imageSize: "1:1", aspectRatio: "16:9", duration: 5 },
      mediaOptions: { imageSizes: PEAR_IMAGE_SIZES, videoDurations: PEAR_VIDEO_DURATIONS, videoAspectRatios: ["16:9", "9:16"] },
      pricing: accountUsage.pricing,
      quota: accountUsage.quota,
      assets: assets.map(mediaPublicView),
    });
  });

  app.openapi(workflowRoute, async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const record = await (await getCollection("agentWorkflows")).findOne({ operationId: c.req.valid("param").operationId, ownerId: new ObjectId(auth.user.id) });
    if (!record) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "没有找到这次对话的处理流程" }, 404);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ workflow: workflowPublicView(record) });
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
    if (!token) return c.json({ code: "PEAR_API_NOT_CONFIGURED", message: "管理员尚未配置 PearAPI 免费渠道令牌" }, 503);
    const workflows = await getCollection("agentWorkflows");
    const operationId = input.operationId || `pearop_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
    const hasAttachments = /\[(?:文本)?附件：/.test(input.messages.at(-1)?.content || "");
    let workflowNodes = textWorkflowNodes(now, hasAttachments);
    const workflowCreated = await workflows.updateOne(
      { operationId, ownerId },
      { $setOnInsert: { operationId, ownerId, conversationId: input.conversationId || null, model: input.model, status: "running", startedAt: now, createdAt: now, updatedAt: now, nodes: workflowNodes } },
      { upsert: true },
    );
    if (!workflowCreated.upsertedCount) return c.json({ code: "WORKFLOW_ID_CONFLICT", message: "本次对话编号已使用，请重新发送" }, 409);
    const understoodAt = new Date();
    workflowNodes = completeWorkflowNode(workflowNodes, "understand", understoodAt, `${input.messages.length} 条消息`);
    workflowNodes = advanceWorkflowNode(workflowNodes, "context", understoodAt);
    await workflows.updateOne({ operationId, ownerId }, { $set: { nodes: workflowNodes, updatedAt: understoodAt } });
    const conversationId = ObjectId.isValid(input.conversationId) ? new ObjectId(input.conversationId) : new ObjectId();
    const requestId = `pear_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const system = "你是古龙网页版智能助手。直接、准确、简洁地回答。使用规范 Markdown 组织标题、列表、强调、表格和代码，让网页可以直接排版预览。网页版不具备第二大脑、本地模型、插件、技能或扩展工作流，不要声称已调用这些能力；界面展示的只是本次请求真实经过的服务处理节点。";
    const usage = { ownerId, conversationId, requestId, modality: "text", model: input.model, baseCostFen: 0, chargedFen: 0, markupRate: PEAR_API_MARKUP_RATE, status: "started", createdAt: now, updatedAt: now };
    await (await getCollection("agentUsage")).insertOne(usage);
    const contextReadyAt = new Date();
    workflowNodes = completeWorkflowNode(workflowNodes, "context", contextReadyAt, hasAttachments ? "附件与对话上下文" : "最近对话上下文");
    workflowNodes = advanceWorkflowNode(workflowNodes, "route", contextReadyAt, { detail: input.model });
    await workflows.updateOne({ operationId, ownerId }, { $set: { nodes: workflowNodes, updatedAt: contextReadyAt } });
    const inferenceStartedAt = new Date();
    workflowNodes = completeWorkflowNode(workflowNodes, "route", inferenceStartedAt, input.model);
    workflowNodes = advanceWorkflowNode(workflowNodes, "inference", inferenceStartedAt, { detail: input.model });
    await workflows.updateOne({ operationId, ownerId }, { $set: { nodes: workflowNodes, updatedAt: inferenceStartedAt } });
    try {
      const result = await callPearApiChat({ token, tokenChannel: record?.tokenChannel || "免费", model: input.model, messages: [{ role: "system", content: system }, ...input.messages] });
      const inferenceCompletedAt = new Date();
      workflowNodes = completeWorkflowNode(workflowNodes, "inference", inferenceCompletedAt, result.resolvedModel);
      workflowNodes = advanceWorkflowNode(workflowNodes, "format", inferenceCompletedAt, { detail: "Markdown 成品排版" });
      await workflows.updateOne({ operationId, ownerId }, { $set: { nodes: workflowNodes, resolvedModel: result.resolvedModel, fallback: result.fallback, updatedAt: inferenceCompletedAt } });
      const completedAt = new Date();
      await Promise.all([
        (await getCollection("agentUsage")).updateOne({ requestId }, { $set: { status: "succeeded", resolvedModel: result.resolvedModel, modelFallback: result.fallback, fallbackReason: result.fallbackReason || null, upstreamUsage: result.usage, upstreamResponseId: result.responseId, completedAt, updatedAt: completedAt } }),
        (await getCollection("agentMessages")).insertMany([
          { ownerId, conversationId, requestId, role: "user", content: input.messages.at(-1)?.content || "", model: input.model, createdAt: now },
          { ownerId, conversationId, requestId, role: "assistant", content: result.text, model: input.model, createdAt: completedAt },
        ]),
      ]);
      const workflowCompletedAt = new Date();
      workflowNodes = completeWorkflowNode(workflowNodes, "format", workflowCompletedAt);
      await workflows.updateOne({ operationId, ownerId }, { $set: { nodes: workflowNodes, status: "completed", completedAt: workflowCompletedAt, updatedAt: workflowCompletedAt } });
      const workflow = workflowPublicView({ operationId, status: "completed", startedAt: now, completedAt: workflowCompletedAt, nodes: workflowNodes });
      c.header("Cache-Control", "private, no-store, max-age=0");
      return c.json({ conversationId: conversationId.toString(), requestId, operationId, message: { role: "assistant", content: result.text, createdAt: completedAt }, model: input.model, resolvedModel: result.resolvedModel, fallback: result.fallback, workflow, chargedFen: 0, free: true, usage: result.usage });
    } catch (error) {
      const failedAt = new Date();
      workflowNodes = advanceWorkflowNode(workflowNodes, workflowNodes.find((node) => node.status === "running")?.id || "inference", failedAt, { detail: error.code || "PEAR_API_ERROR", failed: true });
      await Promise.all([
        (await getCollection("agentUsage")).updateOne({ requestId }, { $set: { status: "failed", errorCode: error.code || "PEAR_API_ERROR", failedAt, updatedAt: failedAt } }),
        workflows.updateOne({ operationId, ownerId }, { $set: { nodes: workflowNodes, status: "failed", errorCode: error.code || "PEAR_API_ERROR", completedAt: failedAt, updatedAt: failedAt } }),
      ]);
      return c.json({ code: error.code || "PEAR_API_ERROR", message: localizeErrorMessage(error, "远程模型调用失败，请稍后重试") }, error.status || 502);
    }
  });

  app.openapi(mediaCreateRoute, async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`pear-media:${auth.user.id}`, { limit: 12, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "媒体生成请求过于频繁，请稍后再试" }, 429);
    const input = c.req.valid("json");
    const idempotencyKey = String(c.req.header("Idempotency-Key") || "").trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 160) return c.json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "请提供 8–160 字符的 Idempotency-Key" }, 400);
    const requested = PEAR_API_MEDIA_MODEL_MAP.get(input.model);
    if (!requested || requested.modality !== input.modality) return c.json({ code: "MODEL_NOT_ALLOWED", message: "请选择当前创作类型对应的 PearAPI 模型" }, 400);
    const ownerId = new ObjectId(auth.user.id);
    const now = new Date();
    const unlimited = auth.user.role === "admin";
    if (!unlimited) {
      const subscription = await (await getCollection("subscriptions")).findOne({ ownerId });
      if (subscription?.plan === SHORT_VIDEO_PLAN_ID && !shortVideoPackageView(subscription, null, now).active) {
        await expireShortVideoPackageAllowance({ getCollection, ownerId, subscription, now });
      }
    }
    const record = await credentialRecord();
    const key = credentialSecrets(record).key;
    if (!key) return c.json({ code: "PEAR_API_KEY_NOT_CONFIGURED", message: "管理员尚未配置 PearAPI Key" }, 503);
    const actual = requested.auto ? resolvePearAutoModel(input.modality, input.prompt) : requested;
    if (input.referenceImages.reduce((total, value) => total + value.length, 0) > 3_200_000) return c.json({ code: "REFERENCE_IMAGES_TOO_LARGE", message: "参考图编码后总大小不能超过 3.2 MB，请压缩后重试" }, 413);
    const referenceImages = input.referenceImages.slice(0, actual.referenceImages);
    if (input.referenceImages.length > actual.referenceImages) return c.json({ code: "TOO_MANY_REFERENCE_IMAGES", message: `${actual.name} 最多支持 ${actual.referenceImages} 张参考图` }, 400);
    const chargedFen = unlimited ? 0 : chargedFenForModel(actual, input.modality, input.duration);
    const conversationId = ObjectId.isValid(input.conversationId) ? new ObjectId(input.conversationId) : new ObjectId();
    const requestId = `pear_media_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const jobs = await getCollection("agentMediaJobs");
    let job = await jobs.findOne({ ownerId, idempotencyKey });
    if (job && (job.modality !== input.modality || job.requestedModel !== requested.id || job.prompt !== input.prompt)) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "这个 Idempotency-Key 已用于另一项媒体任务" }, 409);
    if (job && job.status !== "reserving") {
      const wallet = await (await getCollection("wallets")).findOne({ ownerId });
      if (job.status === "rejected") return c.json({ code: "INSUFFICIENT_BALANCE", message: job.error || `可用额度不足，本次预计需要 ${chargedFen / 100} 元` }, 402);
      return c.json({ job: mediaPublicView(job), billing: { chargedFen: job.chargedFen, remainingBalanceFen: Number(wallet?.balanceFen || 0), exempt: job.chargeStatus === "exempt" }, idempotent: true }, 201);
    }
    if (!job) {
      const jobId = new ObjectId();
      try {
        await jobs.insertOne({
          _id: jobId, ownerId, conversationId, requestId, idempotencyKey, modality: input.modality, requestedModel: requested.id, model: actual.id, modelName: actual.name,
          prompt: input.prompt, referenceCount: referenceImages.length, imageSize: input.imageSize, aspectRatio: input.aspectRatio, duration: input.duration,
          baseCostMilliFen: actual.baseCostMilliFen, chargedFen, markupRate: PEAR_API_MARKUP_RATE, chargeStatus: unlimited ? "exempt" : "pending", status: "reserving", createdAt: now, updatedAt: now,
        });
        job = await jobs.findOne({ _id: jobId });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        job = await jobs.findOne({ ownerId, idempotencyKey });
        if (!job) throw error;
      }
    }
    const wallets = await getCollection("wallets");
    let remainingBalanceFen = Number((await wallets.findOne({ ownerId }))?.balanceFen || 0);
    if (!unlimited) {
      const chargeLedgerKey = job.chargeLedgerKey || `pear-media:${job._id}`;
      const reservation = await reservePearMediaWallet({ wallets, ownerId, amountFen: chargedFen, ledgerKey: chargeLedgerKey, requestId: job.requestId, mediaJobId: job._id, now });
      if (!reservation) {
        const error = `可用额度不足，本次预计需要 ${chargedFen / 100} 元`;
        await jobs.updateOne({ _id: job._id, status: "reserving" }, { $set: { status: "rejected", chargeStatus: "rejected", error, failedAt: now, updatedAt: now } });
        return c.json({ code: "INSUFFICIENT_BALANCE", message: error }, 402);
      }
      remainingBalanceFen = Number(reservation.wallet.balanceFen || 0);
      const claimed = await jobs.findOneAndUpdate(
        { _id: job._id, status: "reserving" },
        { $set: { chargeLedgerKey, chargeStatus: "reserved", status: "submitting", updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!claimed) {
        const current = await jobs.findOne({ _id: job._id });
        return c.json({ job: mediaPublicView(current), billing: { chargedFen: current.chargedFen, remainingBalanceFen, exempt: false }, idempotent: true }, 201);
      }
      job = claimed;
    } else {
      const claimed = await jobs.findOneAndUpdate({ _id: job._id, status: "reserving" }, { $set: { status: "submitting", updatedAt: new Date() } }, { returnDocument: "after" });
      if (!claimed) return c.json({ job: mediaPublicView(await jobs.findOne({ _id: job._id })), billing: { chargedFen: 0, remainingBalanceFen, exempt: true }, idempotent: true }, 201);
      job = claimed;
    }
    try {
      await (await getCollection("agentUsage")).updateOne(
        { requestId: job.requestId },
        { $setOnInsert: { ownerId, conversationId: job.conversationId, requestId: job.requestId, mediaJobId: job._id, modality: input.modality, model: actual.id, requestedModel: requested.id, baseCostMilliFen: actual.baseCostMilliFen, chargedFen, markupRate: PEAR_API_MARKUP_RATE, status: "started", createdAt: now, updatedAt: now } },
        { upsert: true },
      );
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
      if (completedAt) Object.assign(update, { completedAt, chargeStatus: unlimited ? "exempt" : "confirmed" });
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
      return c.json({ job: mediaPublicView(current), billing: { chargedFen, remainingBalanceFen, exempt: unlimited }, idempotent: false }, 201);
    } catch (error) {
      const failed = await refundMediaJob(job, localizeErrorMessage(error, "远程媒体任务提交失败，请稍后重试"));
      return c.json({ code: error.code || "PEAR_API_ERROR", message: localizeErrorMessage(failed.error, "远程媒体任务提交失败，请稍后重试") }, error.status || 502);
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
        job = await jobs.findOneAndUpdate({ _id: job._id, status: "processing" }, { $set: { status: "succeeded", chargeStatus: job.chargeStatus === "exempt" ? "exempt" : "confirmed", urls: parsed.urls, completedAt, updatedAt: completedAt }, $unset: { pollingUntil: "" } }, { returnDocument: "after" });
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
      await jobs.updateOne({ _id: job._id }, { $set: { nextPollAt: new Date(Date.now() + 10_000), lastPollError: localizeErrorMessage(error, "远程媒体任务状态查询失败，请稍后重试").slice(0, 300), updatedAt: new Date() }, $unset: { pollingUntil: "" } });
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
      tokenChannel: record?.tokenChannel || "免费",
      tokenChannels: PEAR_API_TOKEN_CHANNELS,
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
    const previousTokenChannel = existing?.tokenChannel || "免费";
    const nextTokenChannel = input.tokenChannel || previousTokenChannel;
    const hasNewToken = Boolean(String(input.token || "").trim());
    if (existing?.tokenEncrypted && nextTokenChannel !== previousTokenChannel && !hasNewToken) {
      return c.json({ code: "PEAR_API_TOKEN_REQUIRED", message: "切换令牌渠道时，请同时粘贴该渠道的新令牌，避免渠道与令牌不一致" }, 400);
    }
    set.tokenChannel = nextTokenChannel;
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
    const record = await credentialRecord();
    const token = credentialSecrets(record).token;
    if (!token) return c.json({ code: "PEAR_API_NOT_CONFIGURED", message: "请先保存 PearAPI 免费渠道令牌" }, 503);
    const health = await checkPearApiFreeModels({ token, tokenChannel: record?.tokenChannel || "免费" });
    return c.json({ ok: health.allAvailable, ...health });
  });
}
