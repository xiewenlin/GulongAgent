import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { fingerprintIp, hashOpaqueToken, normalizeEmail } from "./security.js";
import { createPresignedDownloadUrl, createPresignedPutUrl, deleteObject, ensureBrowserUploadCors, headObject, sanitizeFilename } from "./cos.js";
import { calculateH3ClaimPlan, createH3QueueCoordinator, H3_CLAIM_LEASE_MS, H3_LAN_REPORT_MAX_NODES, rankH3LanNodes } from "./h3-queue.js";
import { localizeErrorMessage } from "../shared/error-messages.js";
import { acceptH3OptimizedPrompt, buildH3AuthoringPrompt, compileH3Prompt, containsCjkText, h3PromptOptimizerMessages, hardenH3CompiledPrompt, parseH3AuthoringPrompt } from "./h3-prompt.js";
import {
  SHORT_VIDEO_PLAN_ID,
  refundShortVideoPackageAllowance,
  reserveShortVideoPackageAllowance,
} from "./short-video-subscription.js";

export const H3_ACCOUNT_BINDING_HEADER = "X-Gulong-Account-Binding";
export const H3_SHARED_MODEL = "minimax_h3_shared";
export const H3_OUTPUT_RETENTION_MS = 24 * 60 * 60_000;
export const H3_TASK_TIMEOUT_MULTIPLIER = 10;
const H3_MAX_DURATION_SECONDS = 600;
const H3_VIDEO_MODES = new Set(["all_reference", "first_last", "smart_multiframe", "extended"]);
const H3_LONGFORM_MODES = new Set(["continuous", "independent"]);
const H3_VIDEO_ASPECTS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const H3_VIDEO_PROFILES = new Set(["official_max", "ultra1080", "fast2k", "fast", "balanced", "turbo544", "quality", "preview"]);
const H3_SAMPLING_STEPS = new Set([4, 8, 20]);
const H3_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_PLATFORM_ADMIN_EMAIL = "1186664388@qq.com";
const H3_NODE_ONLINE_WINDOW_MS = 3 * 60_000;
const CHINA_UTC_OFFSET_MS = 8 * 60 * 60_000;
const NATURAL_DAY_MS = 24 * 60 * 60_000;
const h3CleanupThrottle = new Map();
const H3_TIMEOUT_ERROR = Object.freeze({
  code: "H3_ESTIMATED_TIMEOUT",
  message: "MiniMax H3 共享节点在预计总耗时的 10 倍内仍未完成，任务已自动取消并退款。请更换其他视频模型后重试。",
});

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function calculateH3SharedPrice({ durationSeconds, imageCount, videoCount }) {
  const duration = integer(durationSeconds, -1);
  const images = integer(imageCount, -1);
  const videos = integer(videoCount, -1);
  if (duration < 1 || duration > H3_MAX_DURATION_SECONDS || images < 0 || images > 9 || videos < 0 || videos > 3) {
    throw Object.assign(new Error("MiniMax H3 时长或素材数量超出允许范围"), { code: "VALIDATION_ERROR", status: 400 });
  }
  return duration * 20 + images * 5 + videos * 20;
}

export function calculateH3RevenueSplit(priceFen) {
  const grossFen = integer(priceFen, -1);
  if (grossFen < 0) throw Object.assign(new Error("MiniMax H3 分账金额无效"), { code: "VALIDATION_ERROR", status: 400 });
  const nodeShareFen = Math.floor(grossFen / 2);
  return { grossFen, nodeShareFen, platformShareFen: grossFen - nodeShareFen };
}

export function estimateH3TaskTotalSeconds(task = {}) {
  const durationSeconds = Math.max(1, integer(task.durationSeconds ?? task.duration_seconds, 5));
  const profile = String(task.profile || "official_max").trim().toLowerCase();
  const profileSecondsPerOutputSecond = {
    official_max: 180,
    ultra1080: 210,
    fast2k: 135,
    fast: 100,
    balanced: 120,
    turbo544: 65,
    quality: 180,
    preview: 45,
  }[profile] || 180;
  const samplingSteps = integer(task.samplingSteps ?? task.sampling_steps, 4);
  const samplingFactor = samplingSteps >= 20 ? 3.5 : samplingSteps >= 8 ? 1.6 : 1;
  const assetOverhead = Math.max(0, integer(task.imageCount ?? task.image_count)) * 8
    + Math.max(0, integer(task.videoCount ?? task.video_count)) * 25
    + Math.max(0, integer(task.audioCount ?? task.audio_count)) * 10;
  return Math.min(6 * 60 * 60, Math.max(120, Math.ceil(durationSeconds * profileSecondsPerOutputSecond * samplingFactor + assetOverhead)));
}

export function h3TaskAutoCancelAt(createdAt, estimatedTotalSeconds) {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) throw Object.assign(new Error("H3 任务创建时间无效"), { code: "VALIDATION_ERROR", status: 400 });
  const estimate = Math.max(1, integer(estimatedTotalSeconds, 1));
  return new Date(created.getTime() + estimate * H3_TASK_TIMEOUT_MULTIPLIER * 1_000);
}

export function h3CallbackEventKey(taskId, metadata = {}) {
  const status = String(metadata.status || "").trim().toLowerCase();
  const event = String(metadata.event || status).trim().toLowerCase();
  const localJobId = String(metadata.local_job_id || "").trim();
  return createHash("sha256").update(`${taskId}:${event}:${status}:${localJobId}`).digest("hex");
}

function escapedRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assetManifest(value, kind, maximum) {
  const items = Array.isArray(value) ? value : [];
  if (items.length > maximum) throw Object.assign(new Error(`${kind}素材数量不能超过 ${maximum}`), { code: "VALIDATION_ERROR", status: 400 });
  return items.map((item, index) => {
    const source = typeof item === "string" ? { url: item } : item && typeof item === "object" ? item : {};
    const url = String(source.url || "").trim().slice(0, 2_000);
    const objectKey = String(source.object_key || source.objectKey || "").trim().slice(0, 1_000);
    if (!url && !objectKey) throw Object.assign(new Error(`${kind}素材 ${index + 1} 缺少 URL 或对象键`), { code: "VALIDATION_ERROR", status: 400 });
    return {
      kind,
      assetId: String(source.asset_id || source.assetId || "").trim().slice(0, 80) || null,
      filename: String(source.filename || `${kind}-${index + 1}`).trim().slice(0, 240),
      ...(url ? { url } : {}),
      ...(objectKey ? { objectKey } : {}),
      bytes: Math.max(0, integer(source.bytes)),
      sha256: /^[A-Fa-f0-9]{64}$/.test(String(source.sha256 || "")) ? String(source.sha256).toUpperCase() : null,
    };
  });
}

export function normalizeH3TaskInput(body = {}) {
  const originalPrompt = String(body.original_prompt || body.originalPrompt || body.prompt || "").trim();
  if (!originalPrompt || originalPrompt.length > 20_000) throw Object.assign(new Error("提示词需为 1–20000 个字符"), { code: "VALIDATION_ERROR", status: 400 });
  const model = String(body.model || H3_SHARED_MODEL).trim();
  if (model !== H3_SHARED_MODEL) throw Object.assign(new Error("仅支持 MiniMax H3 共享节点模型"), { code: "MODEL_NOT_ALLOWED", status: 400 });
  const sourceChannel = body.source_channel === "desktop_agent" || body.sourceChannel === "desktop_agent" ? "desktop_agent" : "website";
  const assets = body.assets && typeof body.assets === "object" ? body.assets : {};
  const images = assetManifest(assets.images || body.image_assets, "image", 9);
  const videos = assetManifest(assets.videos || body.video_assets, "video", 3);
  const audio = assetManifest(assets.audio || body.audio_assets, "audio", 3);
  const videoMode = String(body.video_mode || body.videoMode || "all_reference").trim().toLowerCase();
  const longformMode = String(body.longform_mode || body.longformMode || "continuous").trim().toLowerCase();
  const segmentDurationSeconds = integer(body.segment_duration_seconds ?? body.segmentDurationSeconds, 5);
  const promptSegments = originalPrompt.split(/\r?\n\s*\r?\n/u).map((item) => item.trim()).filter(Boolean);
  const durationSeconds = videoMode === "extended" ? promptSegments.length * segmentDurationSeconds : integer(body.duration_seconds ?? body.durationSeconds, -1);
  const priceFen = calculateH3SharedPrice({ durationSeconds, imageCount: images.length, videoCount: videos.length });
  const promptOptimizationEnabled = body.prompt_optimization_enabled === false || body.promptOptimizationEnabled === false ? false : true;
  const aspectRatio = String(body.aspect_ratio || body.aspectRatio || "16:9").trim();
  const profile = String(body.profile || "official_max").trim().toLowerCase();
  const samplingSteps = integer(body.sampling_steps ?? body.samplingSteps, 4);
  const seed = integer(body.seed, -1);
  if (!H3_VIDEO_MODES.has(videoMode)) throw Object.assign(new Error("视频生成方式无效"), { code: "VALIDATION_ERROR", status: 400 });
  if (videoMode === "extended" && !H3_LONGFORM_MODES.has(longformMode)) throw Object.assign(new Error("超长视频生产方式无效"), { code: "VALIDATION_ERROR", status: 400 });
  if (videoMode === "extended" && (segmentDurationSeconds < 5 || segmentDurationSeconds > 15)) throw Object.assign(new Error("超长视频单段时长必须为 5–15 秒"), { code: "VALIDATION_ERROR", status: 400 });
  if (!H3_VIDEO_ASPECTS.has(aspectRatio)) throw Object.assign(new Error("视频画面比例无效"), { code: "VALIDATION_ERROR", status: 400 });
  if (!H3_VIDEO_PROFILES.has(profile)) throw Object.assign(new Error("视频分辨率配置无效"), { code: "VALIDATION_ERROR", status: 400 });
  if (!H3_SAMPLING_STEPS.has(samplingSteps)) throw Object.assign(new Error("主采样步数仅支持 4、8 或 20"), { code: "VALIDATION_ERROR", status: 400 });
  if (seed < -1 || seed > 2_147_483_647) throw Object.assign(new Error("随机种子必须为 -1 至 2147483647 的整数"), { code: "VALIDATION_ERROR", status: 400 });
  return {
    sourceChannel,
    model,
    prompt: originalPrompt,
    sourcePrompt: originalPrompt,
    originalPrompt,
    promptOptimizationEnabled,
    localPromptOptimizationRequired: promptOptimizationEnabled,
    promptMode: promptOptimizationEnabled ? "desktop_local_magic_v1" : "raw_prompt_v1",
    promptCompilation: promptOptimizationEnabled
      ? { mode: "desktop_local_magic_v1", source: "execution_node", validated: false, status: "pending" }
      : { mode: "raw_prompt_v1", source: "requester", validated: false, status: "skipped" },
    videoMode,
    longformMode: videoMode === "extended" ? longformMode : null,
    segmentDurationSeconds: videoMode === "extended" ? segmentDurationSeconds : null,
    promptSegmentCount: videoMode === "extended" ? promptSegments.length : 1,
    aspectRatio,
    durationSeconds,
    profile,
    samplingSteps,
    seed,
    imageCount: images.length,
    videoCount: videos.length,
    audioCount: audio.length,
    assets: { images, videos, audio },
    priceFen,
  };
}

export async function resolveH3TaskPrompt(input, { loadCredential, callModel, preferModel = false } = {}) {
  const promptInput = {
    prompt: input.originalPrompt,
    durationSeconds: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    assets: input.assets,
  };
  const parsedCandidate = parseH3AuthoringPrompt(input.authoringPrompt || input.prompt);
  const candidateBody = parsedCandidate.sourcePrompt;
  const looksCompiled = /^(?:integrated_multimodal_description|subject_definitions):/m.test(candidateBody);
  let compiled = null;
  if (looksCompiled) {
    try {
      compiled = hardenH3CompiledPrompt(input.authoringPrompt || input.prompt, promptInput);
      compiled = { ...compiled, source: "client_optimized" };
    } catch {
      compiled = null;
    }
  }
  const requiresTranslation = containsCjkText(candidateBody) || containsCjkText(input.originalPrompt);
  if (!compiled && !preferModel && !requiresTranslation) compiled = compileH3Prompt(promptInput);
  if (!compiled) {
    const credential = await loadCredential?.();
    if (!credential?.token) {
      if (requiresTranslation) throw Object.assign(new Error("英文提示词优化服务尚未配置，已阻止把中文场景描述发送给 MiniMax H3，请稍后重试"), { code: "H3_PROMPT_TRANSLATION_UNAVAILABLE", status: 503 });
      compiled = compileH3Prompt(promptInput);
    } else {
      const { messages } = h3PromptOptimizerMessages(promptInput);
      let response;
      try {
        response = await callModel({ token: credential.token, tokenChannel: credential.tokenChannel || "免费", model: "glm-4-flash-250414", messages, timeoutMs: 35_000, allowFallback: true });
      } catch (error) {
        if (requiresTranslation) throw Object.assign(new Error("英文提示词优化服务暂时不可用，已阻止把中文场景描述发送给 MiniMax H3，请稍后重试"), { code: "H3_PROMPT_TRANSLATION_FAILED", status: 503, cause: error });
        compiled = compileH3Prompt(promptInput);
      }
      if (!compiled) compiled = acceptH3OptimizedPrompt(String(response?.text || "").slice(0, 20_000), promptInput);
    }
  }
  const authoringPrompt = buildH3AuthoringPrompt(compiled.prompt, parsedCandidate.controlTemplate);
  return {
    ...input,
    prompt: compiled.prompt,
    compiledPrompt: compiled.prompt,
    authoringPrompt,
    promptCompilation: { mode: compiled.mode, source: compiled.source, validated: true, ambientOnly: true, englishOnly: true, controlPolicy: { voiceover: false, dialogue: false, visibleText: false, music: false, backgroundSound: parsedCandidate.controls.backgroundSound } },
  };
}

function bindingToken() {
  return `gab_${randomBytes(36).toString("base64url")}`;
}

function orderNumber() {
  return `H3${Date.now()}${randomBytes(5).toString("hex").toUpperCase()}`;
}

function publicNode(node) {
  if (!node) return null;
  return { nodeId: node.nodeId, nodeName: node.nodeName || null, bindingId: node.bindingId?.toString?.() || node.bindingId || null, at: node.at || null };
}

function objectHeader(head, name) {
  const wanted = String(name).toLowerCase();
  const sources = [head?.headers, head?.Headers, head];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === wanted);
    if (key) return String(source[key]);
  }
  return "";
}

function objectBytes(head) {
  return integer(objectHeader(head, "content-length") || head?.ContentLength || head?.contentLength, 0);
}

export function h3OutputExpiresAt(completedAt) {
  const completed = new Date(completedAt);
  if (Number.isNaN(completed.getTime())) return null;
  return new Date(completed.getTime() + H3_OUTPUT_RETENTION_MS);
}

export function normalizeH3ProgressCallback(task, metadata = {}) {
  const progress = Math.min(99, Math.max(0, integer(metadata.progress)));
  const reportedEstimate = Math.max(0, integer(metadata.estimated_total_seconds ?? metadata.estimatedTotalSeconds));
  const estimatedTotalSeconds = reportedEstimate || Math.max(0, integer(task?.estimatedTotalSeconds));
  if (estimatedTotalSeconds < 1) {
    return {
      error: {
        code: "ESTIMATED_DURATION_REQUIRED",
        message: "节点首次进度回调必须提供预计总耗时 estimated_total_seconds",
      },
    };
  }
  const reportedRemainingSeconds = integer(metadata.remaining_seconds ?? metadata.remainingSeconds, -1);
  const remainingSeconds = reportedRemainingSeconds >= 0
    ? reportedRemainingSeconds
    : Math.ceil(estimatedTotalSeconds * (100 - progress) / 100);
  return { progress, estimatedTotalSeconds, remainingSeconds };
}

function h3OutputState(task, now = new Date()) {
  if (!task?.output?.objectKey) return null;
  const expiresAt = task.output.expiresAt ? new Date(task.output.expiresAt) : h3OutputExpiresAt(task.completedAt);
  const expired = Boolean(task.output.deletedAt) || !expiresAt || expiresAt <= now;
  return { expiresAt, expired, status: expired ? "expired" : "available" };
}

function publicH3Output(task, now = new Date()) {
  const state = h3OutputState(task, now);
  if (!state) return null;
  const base = `/api/h3/tasks/${task._id}/output`;
  return {
    sha256: task.output.sha256 || null,
    bytes: integer(task.output.bytes),
    filename: task.output.filename || "MiniMaxH3-视频.mp4",
    status: state.status,
    expiresAt: state.expiresAt,
    deletedAt: task.output.deletedAt || null,
    cleanupStatus: task.output.cleanupStatus || (state.expired ? "pending" : "scheduled"),
    cleanupAttempts: integer(task.output.cleanupAttempts),
    ...(state.expired ? {} : { previewPath: `${base}?disposition=inline`, downloadPath: `${base}?disposition=attachment` }),
  };
}

function publicTask(task, { includePrompt = true } = {}) {
  const promptOptimizationEnabled = task.promptOptimizationEnabled !== false && task.localPromptOptimizationRequired !== false;
  return {
    id: task._id.toString(),
    orderNo: task.orderNo,
    sourceChannel: task.sourceChannel,
    model: task.model,
    ...(includePrompt ? { prompt: task.originalPrompt || task.prompt, compiledPrompt: task.compiledPrompt || null, originalPrompt: task.originalPrompt || task.prompt } : { promptSummary: String(task.originalPrompt || task.prompt || "").slice(0, 120) }),
    promptCompilation: task.promptCompilation || null,
    promptOptimizationEnabled,
    promptMode: task.promptMode || (promptOptimizationEnabled ? "desktop_local_magic_v1" : "raw_prompt_v1"),
    videoMode: task.videoMode || "all_reference",
    longformMode: task.longformMode || null,
    segmentDurationSeconds: task.segmentDurationSeconds || null,
    promptSegmentCount: integer(task.promptSegmentCount, 1),
    aspectRatio: task.aspectRatio,
    durationSeconds: task.durationSeconds,
    profile: task.profile,
    samplingSteps: integer(task.samplingSteps, 4),
    seed: integer(task.seed, -1),
    imageCount: task.imageCount,
    videoCount: task.videoCount,
    audioCount: task.audioCount,
    assets: task.assets,
    priceFen: task.priceFen,
    chargedFen: integer(task.chargedFen, task.chargeStatus === "exempt" || task.chargeStatus === "package_no_charge" ? 0 : task.priceFen),
    billingMode: task.billingMode || (task.chargeStatus === "exempt" ? "administrator_exempt" : "wallet"),
    status: task.status,
    progress: Math.min(100, Math.max(0, integer(task.progress, task.status === "completed" ? 100 : 0))),
    progressStage: task.progressStage || null,
    chargeStatus: task.chargeStatus,
    revenueStatus: task.revenueStatus || null,
    refundStatus: task.refundStatus || null,
    requester: { userId: task.requesterUserId.toString(), email: task.requesterEmailSnapshot || null },
    assignee: task.assigneeUserId ? { userId: task.assigneeUserId.toString(), email: task.assigneeEmailSnapshot || null, displayName: task.assigneeDisplayNameSnapshot || null } : null,
    claimedByNode: publicNode(task.claimedByNode),
    claimRequestedByNode: publicNode(task.claimRequestedByNode),
    executedByNode: publicNode(task.executedByNode),
    conversationId: task.conversationId?.toString?.() || task.conversationId || null,
    requestMessageId: task.requestMessageId?.toString?.() || task.requestMessageId || null,
    resultMessageId: task.resultMessageId?.toString?.() || task.resultMessageId || null,
    output: publicH3Output(task),
    error: task.error ? { ...task.error, message: localizeErrorMessage(task.error.message, "共享节点任务处理失败") } : null,
    dispatchEstimatedTotalSeconds: Math.max(0, integer(task.dispatchEstimatedTotalSeconds)),
    autoCancelAt: task.autoCancelAt || null,
    createdAt: task.createdAt,
    claimedAt: task.claimedAt || null,
    completedAt: task.completedAt || null,
    failedAt: task.failedAt || null,
    cancelledAt: task.cancelledAt || null,
    refundedAt: task.refundedAt || null,
    retryCount: integer(task.retryCount),
  };
}

function publicH3ConversationMessage(message, now = new Date()) {
  const expiresAt = message.video?.expiresAt ? new Date(message.video.expiresAt) : null;
  const expired = Boolean(message.video?.deletedAt) || !expiresAt || expiresAt <= now;
  const taskId = message.h3TaskId?.toString?.() || message.h3TaskId;
  return {
    id: message._id.toString(),
    role: "assistant",
    content: message.content || "MiniMaxH3共享节点视频已生成。",
    model: H3_SHARED_MODEL,
    createdAt: message.createdAt,
    video: {
      taskId,
      filename: message.video?.filename || "MiniMaxH3-视频.mp4",
      bytes: integer(message.video?.bytes),
      expiresAt,
      status: expired ? "expired" : "available",
      deletedAt: message.video?.deletedAt || null,
      ...(expired ? {} : {
        previewPath: `/api/h3/tasks/${taskId}/output?disposition=inline`,
        downloadPath: `/api/h3/tasks/${taskId}/output?disposition=attachment`,
      }),
    },
  };
}

function publicH3ConversationTask(task) {
  return {
    id: task._id.toString(),
    orderNo: task.orderNo,
    status: task.status,
    progress: Math.min(100, Math.max(0, integer(task.progress, task.status === "completed" ? 100 : 0))),
    estimatedTotalSeconds: Math.max(0, integer(task.estimatedTotalSeconds || task.dispatchEstimatedTotalSeconds)),
    dispatchEstimatedTotalSeconds: Math.max(0, integer(task.dispatchEstimatedTotalSeconds)),
    remainingSeconds: Math.max(0, integer(task.remainingSeconds)),
    expectedCompletedAt: task.expectedCompletedAt || null,
    autoCancelAt: task.autoCancelAt || null,
    error: task.error ? { ...task.error, message: localizeErrorMessage(task.error.message, "共享节点任务处理失败") } : null,
    progressUpdatedAt: task.progressUpdatedAt || task.updatedAt || null,
    progressStage: task.progressStage || null,
    createdAt: task.createdAt,
  };
}

export async function ensureH3ConversationMessages({ getCollection, task, now = new Date() }) {
  if (!task || task.sourceChannel !== "website" || !task.conversationId || !task.requestMessageId || !task.resultMessageId) return { written: false };
  const messages = await getCollection("agentMessages");
  const upsertMessageOnce = async (filter, update) => {
    try { return await messages.updateOne(filter, update, { upsert: true }); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      return messages.updateOne(filter, { $set: { updatedAt: now } });
    }
  };
  await upsertMessageOnce({ _id: task.requestMessageId }, { $setOnInsert: { _id: task.requestMessageId, ownerId: task.requesterUserId, conversationId: task.conversationId, requestId: task.orderNo, h3TaskId: task._id, role: "user", content: task.originalPrompt || task.prompt, modality: "video", model: H3_SHARED_MODEL, createdAt: task.createdAt || now } });
  if (task.status !== "completed" || !task.output?.objectKey) return { written: false };
  const expiresAt = task.output.expiresAt ? new Date(task.output.expiresAt) : h3OutputExpiresAt(task.completedAt || now);
  if (!task.output.expiresAt) {
    await (await getCollection("h3SharedTasks")).updateOne({ _id: task._id, "output.expiresAt": { $exists: false } }, { $set: { "output.expiresAt": expiresAt, "output.status": expiresAt <= now ? "expired" : "available", "output.cleanupStatus": "pending", updatedAt: now } });
  }
  const result = await upsertMessageOnce(
    { _id: task.resultMessageId },
    { $setOnInsert: { _id: task.resultMessageId, ownerId: task.requesterUserId, conversationId: task.conversationId, requestId: task.orderNo, h3TaskId: task._id, role: "assistant", content: "MiniMaxH3共享节点视频已生成。", modality: "video", model: H3_SHARED_MODEL, video: { objectKey: task.output.objectKey, filename: task.output.filename, bytes: task.output.bytes, sha256: task.output.sha256, expiresAt, status: expiresAt <= now ? "expired" : "available" }, createdAt: task.completedAt || now }, $set: { updatedAt: now } },
  );
  await (await getCollection("h3SharedTasks")).updateOne({ _id: task._id }, { $set: { resultMessageWrittenAt: now, updatedAt: now } });
  return { written: Boolean(result?.upsertedCount), expiresAt };
}

export async function backfillCompletedH3ConversationMessages({ getCollection, ownerId = null, limit = 50, now = new Date() }) {
  const tasksCollection = await getCollection("h3SharedTasks");
  const filter = { sourceChannel: "website", status: "completed", "output.objectKey": { $exists: true }, ...(ownerId ? { requesterUserId: ownerId instanceof ObjectId ? ownerId : new ObjectId(ownerId) } : {}) };
  const tasks = await tasksCollection.find(filter).sort({ completedAt: -1, _id: -1 }).limit(Math.max(1, Math.min(200, integer(limit, 50)))).toArray();
  const messages = await getCollection("agentMessages");
  let repaired = 0;
  for (const original of tasks) {
    let task = original;
    const changes = {};
    if (!task.conversationId) {
      const from = new Date(new Date(task.createdAt || task.completedAt).getTime() - 15 * 60_000);
      const to = new Date(new Date(task.createdAt || task.completedAt).getTime() + 15 * 60_000);
      const candidates = await messages.find({ ownerId: task.requesterUserId, role: "user", content: task.prompt, createdAt: { $gte: from, $lte: to }, conversationId: { $exists: true } }).sort({ createdAt: 1 }).limit(3).toArray();
      const conversationIds = [...new Map(candidates.map((item) => [item.conversationId?.toString?.(), item.conversationId]).filter(([key]) => key)).values()];
      changes.conversationId = conversationIds.length === 1 ? conversationIds[0] : new ObjectId();
      changes.conversationAssociation = conversationIds.length === 1 ? "exact_owner_prompt_window" : "owner_isolated_recovery";
    }
    if (!task.requestMessageId) changes.requestMessageId = new ObjectId();
    if (!task.resultMessageId) changes.resultMessageId = new ObjectId();
    if (!task.output?.expiresAt) {
      changes["output.expiresAt"] = h3OutputExpiresAt(task.completedAt || now);
      changes["output.status"] = changes["output.expiresAt"] <= now ? "expired" : "available";
      changes["output.cleanupStatus"] = "pending";
    }
    if (Object.keys(changes).length) {
      const guards = {};
      if (!task.conversationId) guards.conversationId = { $exists: false };
      if (!task.requestMessageId) guards.requestMessageId = { $exists: false };
      if (!task.resultMessageId) guards.resultMessageId = { $exists: false };
      if (!task.output?.expiresAt) guards["output.expiresAt"] = { $exists: false };
      const updated = await tasksCollection.findOneAndUpdate({ _id: task._id, ...guards }, { $set: { ...changes, backfilledAt: now, updatedAt: now } }, { returnDocument: "after" });
      task = updated || (tasksCollection.findOne ? await tasksCollection.findOne({ _id: task._id }) : null) || { ...task, ...Object.fromEntries(Object.entries(changes).filter(([key]) => !key.includes("."))), output: { ...task.output, expiresAt: changes["output.expiresAt"] || task.output?.expiresAt, status: changes["output.status"] || task.output?.status, cleanupStatus: changes["output.cleanupStatus"] || task.output?.cleanupStatus } };
    }
    const ensured = await ensureH3ConversationMessages({ getCollection, task, now });
    if (ensured.written || Object.keys(changes).length) repaired += 1;
  }
  return { scanned: tasks.length, repaired };
}

export async function cleanupExpiredH3Output({ getCollection, task, removeObject, now = new Date() }) {
  const state = h3OutputState(task, now);
  if (!state?.expired || task.output?.deletedAt || !task.output?.objectKey) return { cleaned: false, skipped: true };
  const tasks = await getCollection("h3SharedTasks");
  const leaseUntil = new Date(now.getTime() + 5 * 60_000);
  const locked = await tasks.findOneAndUpdate(
    { _id: task._id, "output.objectKey": task.output.objectKey, "output.deletedAt": { $exists: false }, $or: [{ "output.cleanupLeaseUntil": { $exists: false } }, { "output.cleanupLeaseUntil": { $lte: now } }] },
    { $set: { "output.cleanupStatus": "deleting", "output.cleanupLeaseUntil": leaseUntil, updatedAt: now }, $inc: { "output.cleanupAttempts": 1 } },
    { returnDocument: "after" },
  );
  if (!locked) return { cleaned: false, skipped: true };
  try {
    await removeObject(task.output.objectKey);
    const deletedAt = new Date();
    await tasks.updateOne({ _id: task._id, "output.objectKey": task.output.objectKey }, { $set: { "output.status": "expired", "output.cleanupStatus": "deleted", "output.deletedAt": deletedAt, updatedAt: deletedAt }, $unset: { "output.cleanupLeaseUntil": "", "output.cleanupError": "", "output.cleanupRetryAt": "" } });
    await (await getCollection("agentMessages")).updateMany({ h3TaskId: task._id, role: "assistant" }, { $set: { "video.status": "expired", "video.deletedAt": deletedAt, updatedAt: deletedAt }, $unset: { "video.objectKey": "" } });
    return { cleaned: true, deletedAt };
  } catch (error) {
    const attempts = integer(locked.output?.cleanupAttempts, integer(task.output?.cleanupAttempts) + 1);
    const retryAt = new Date(now.getTime() + Math.min(6 * 60 * 60_000, 5 * 60_000 * (2 ** Math.min(6, attempts - 1))));
    await tasks.updateOne({ _id: task._id, "output.objectKey": task.output.objectKey }, { $set: { "output.status": "expired", "output.cleanupStatus": "retry", "output.cleanupError": localizeErrorMessage(error, "COS 视频删除失败").slice(0, 300), "output.cleanupRetryAt": retryAt, updatedAt: new Date() }, $unset: { "output.cleanupLeaseUntil": "" } });
    return { cleaned: false, retry: true, retryAt };
  }
}

export async function cleanupExpiredH3Outputs({ getCollection, removeObject, ownerId = null, now = new Date(), limit = 100 }) {
  const tasks = await (await getCollection("h3SharedTasks")).find({ status: "completed", ...(ownerId ? { requesterUserId: ownerId instanceof ObjectId ? ownerId : new ObjectId(ownerId) } : {}), "output.objectKey": { $exists: true }, "output.deletedAt": { $exists: false }, "output.expiresAt": { $lte: now }, $or: [{ "output.cleanupRetryAt": { $exists: false } }, { "output.cleanupRetryAt": { $lte: now } }] }).sort({ "output.expiresAt": 1 }).limit(Math.max(1, Math.min(200, integer(limit, 100)))).toArray();
  const summary = { scanned: tasks.length, cleaned: 0, retry: 0 };
  for (const task of tasks) {
    const result = await cleanupExpiredH3Output({ getCollection, task, removeObject, now });
    if (result.cleaned) summary.cleaned += 1;
    if (result.retry) summary.retry += 1;
  }
  return summary;
}

function taskBilling(task, wallet) {
  const charged = ["reserved", "settled"].includes(task?.chargeStatus);
  return {
    chargedFen: charged ? integer(task?.chargedFen, integer(task?.priceFen)) : 0,
    remainingBalanceFen: integer(wallet?.balanceFen),
    packageBalanceFen: integer(wallet?.shortVideoPackageBalanceFen),
    billingMode: task?.billingMode || (task?.chargeStatus === "exempt" ? "administrator_exempt" : "wallet"),
    exempt: task?.chargeStatus === "exempt",
  };
}

export function toH3WorkerTask(task, { assets = [], outputUpload = null } = {}) {
  const sourcePrompt = String(task.originalPrompt || task.sourcePrompt || task.prompt || "");
  const promptOptimizationEnabled = task.promptOptimizationEnabled !== false && task.localPromptOptimizationRequired !== false;
  return {
    id: task._id.toString(),
    orderNo: task.orderNo,
    model: task.model,
    prompt: sourcePrompt,
    source_prompt: sourcePrompt,
    original_prompt: sourcePrompt,
    prompt_mode: promptOptimizationEnabled ? "desktop_local_magic_v1" : "raw_prompt_v1",
    prompt_optimization_enabled: promptOptimizationEnabled,
    local_prompt_optimization_required: promptOptimizationEnabled,
    video_mode: task.videoMode || "all_reference",
    longform_mode: task.longformMode || null,
    segment_duration_seconds: task.segmentDurationSeconds || null,
    prompt_list: task.videoMode === "extended" ? sourcePrompt : null,
    aspectRatio: task.aspectRatio,
    durationSeconds: task.durationSeconds,
    profile: task.profile,
    sampling_steps: integer(task.samplingSteps, 4),
    seed: integer(task.seed, -1),
    imageCount: task.imageCount,
    videoCount: task.videoCount,
    audioCount: task.audioCount,
    assets,
    assigned_node: task.claimedByNode ? { node_id: task.claimedByNode.nodeId, node_name: task.claimedByNode.nodeName || null } : null,
    dispatch_estimated_total_seconds: Math.max(0, integer(task.dispatchEstimatedTotalSeconds)),
    auto_cancel_at: task.autoCancelAt || null,
    output_upload: outputUpload,
    progress_callback: {
      method: "POST",
      url: "/api/h3/tasks/callback",
      content_type: "multipart/form-data",
      ...(promptOptimizationEnabled ? { optimization_status: "optimizing" } : {}),
      first_status: "started",
      first_required_fields: promptOptimizationEnabled ? ["estimated_total_seconds", "compiled_prompt"] : ["estimated_total_seconds"],
      progress_fields: ["progress", "remaining_seconds"],
    },
  };
}

function workerCallbackTask(task) {
  return {
    id: task._id.toString(),
    orderNo: task.orderNo,
    status: task.status,
    progress: integer(task.progress),
    progress_stage: task.progressStage || null,
    estimated_total_seconds: Math.max(0, integer(task.estimatedTotalSeconds)),
    remaining_seconds: Math.max(0, integer(task.remainingSeconds)),
    expected_completed_at: task.expectedCompletedAt || null,
    completedAt: task.completedAt || null,
    failedAt: task.failedAt || null,
    cancelledAt: task.cancelledAt || null,
  };
}

function idText(value) {
  return value?.toString?.() || String(value || "");
}

function chinaNaturalDay(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.floor((timestamp + CHINA_UTC_OFFSET_MS) / NATURAL_DAY_MS) : null;
}

function averageDailyFen(amountFen, firstSettledAt, now) {
  const firstDay = chinaNaturalDay(firstSettledAt);
  const currentDay = chinaNaturalDay(now);
  if (firstDay == null || currentDay == null) return { amountFen: 0, activeDays: 0 };
  const activeDays = Math.max(1, currentDay - firstDay + 1);
  return { amountFen: Math.floor(Math.max(0, integer(amountFen)) / activeDays), activeDays };
}

export function maskH3NodeId(value) {
  const nodeId = String(value || "");
  if (nodeId.length <= 12) return nodeId ? `${nodeId.slice(0, 3)}…${nodeId.slice(-3)}` : "";
  return `${nodeId.slice(0, 6)}…${nodeId.slice(-4)}`;
}

export async function buildH3EarningsSummary({ getCollection, userId, currentNodeId = null, maskNodeIds = false, now = new Date() }) {
  const ownerId = userId instanceof ObjectId ? userId : ObjectId.isValid(userId) ? new ObjectId(userId) : null;
  if (!ownerId) throw Object.assign(new Error("收益账户不正确"), { code: "INVALID_ACCOUNT", status: 400 });
  const [bindingsCollection, ledgersCollection, tasksCollection] = await Promise.all([
    getCollection("nodeAccountBindings"),
    getCollection("h3WalletLedger"),
    getCollection("h3SharedTasks"),
  ]);
  const [bindings, ledgers] = await Promise.all([
    bindingsCollection.find({ userId: ownerId, status: { $in: ["active", "revoked"] } }).sort({ createdAt: 1 }).toArray(),
    ledgersCollection.find({ ownerId, kind: "h3_node_commission", status: { $in: ["pending", "settled"] } }).sort({ createdAt: 1 }).toArray(),
  ]);
  const taskObjectIds = [...new Map(ledgers.filter((item) => item.taskId).map((item) => [idText(item.taskId), item.taskId])).values()];
  const taskFilter = {
    $or: [
      { assigneeUserId: ownerId },
      { "claimedByNode.userId": ownerId },
      ...(taskObjectIds.length ? [{ _id: { $in: taskObjectIds } }] : []),
    ],
  };
  const tasks = await tasksCollection.find(taskFilter).sort({ createdAt: -1 }).toArray();
  const tasksById = new Map(tasks.map((task) => [idText(task._id), task]));
  const deviceMap = new Map();
  const ensureDevice = (nodeId, fallback = {}) => {
    const key = String(nodeId || "").trim();
    if (!key) return null;
    if (!deviceMap.has(key)) deviceMap.set(key, {
      nodeId: key,
      nodeName: fallback.nodeName || "未命名节点",
      bindingStatus: fallback.status || null,
      appVersion: fallback.appVersion || null,
      capabilities: fallback.capabilities || {},
      queueStatus: fallback.queueStatus || null,
      lastSeenAt: fallback.lastSeenAt || null,
      lastClaimedAt: fallback.lastClaimedAt || null,
      lastCallbackAt: fallback.lastCallbackAt || null,
      lastCompletedAt: fallback.lastCompletedAt || null,
      completedTaskCount: 0,
      settledFen: 0,
      pendingFen: 0,
      firstSettledAt: null,
      processing: false,
    });
    return deviceMap.get(key);
  };
  for (const binding of bindings) {
    const device = ensureDevice(binding.nodeId, binding);
    if (!device) continue;
    const latestSeen = [device.lastSeenAt, binding.lastSeenAt].filter(Boolean).sort((left, right) => new Date(right) - new Date(left))[0];
    device.nodeName = binding.nodeName || device.nodeName;
    device.bindingStatus = binding.status;
    device.appVersion = binding.appVersion || device.appVersion;
    device.capabilities = binding.capabilities || device.capabilities;
    device.queueStatus = binding.queueStatus || device.queueStatus;
    device.lastSeenAt = latestSeen || null;
    device.lastCallbackAt = binding.lastCallbackAt || device.lastCallbackAt;
    device.lastCompletedAt = binding.lastCompletedAt || device.lastCompletedAt;
  }
  for (const task of tasks) {
    const claimedNodeId = task.claimedByNode?.nodeId;
    if (claimedNodeId && idText(task.claimedByNode?.userId) === idText(ownerId)) {
      const device = ensureDevice(claimedNodeId, task.claimedByNode);
      if (device) {
        if (!device.lastClaimedAt || new Date(task.claimedAt || task.claimedByNode.at || 0) > new Date(device.lastClaimedAt)) device.lastClaimedAt = task.claimedAt || task.claimedByNode.at || null;
        if (["claimed", "processing"].includes(task.status)) device.processing = true;
      }
    }
    if (task.executedByNode?.nodeId && idText(task.assigneeUserId) === idText(ownerId)) {
      const device = ensureDevice(task.executedByNode.nodeId, task.executedByNode);
      if (device && (!device.lastCallbackAt || new Date(task.executedByNode.at || task.updatedAt || 0) > new Date(device.lastCallbackAt))) device.lastCallbackAt = task.executedByNode.at || task.updatedAt || null;
    }
  }
  let settledFen = 0;
  let pendingFen = 0;
  let firstSettledAt = null;
  const countedLedgerKeys = new Set();
  for (const ledger of ledgers) {
    const ledgerKey = String(ledger.ledgerKey || "");
    if (!ledgerKey || countedLedgerKeys.has(ledgerKey)) continue;
    const task = tasksById.get(idText(ledger.taskId));
    if (!task || task.status !== "completed" || idText(task.assigneeUserId) !== idText(ownerId)) continue;
    if (task.settlement?.nodeLedgerKey && task.settlement.nodeLedgerKey !== ledgerKey) continue;
    const amountFen = Math.max(0, integer(ledger.settlementFen ?? ledger.amountFen));
    const device = ensureDevice(task.executedByNode?.nodeId, task.executedByNode || {});
    if (!device) continue;
    countedLedgerKeys.add(ledgerKey);
    if (ledger.status === "settled") {
      settledFen += amountFen;
      device.settledFen += amountFen;
      device.completedTaskCount += 1;
      const settledAt = ledger.settledAt || task.settlement?.settledAt || task.completedAt;
      if (settledAt && (!firstSettledAt || new Date(settledAt) < new Date(firstSettledAt))) firstSettledAt = settledAt;
      if (settledAt && (!device.firstSettledAt || new Date(settledAt) < new Date(device.firstSettledAt))) device.firstSettledAt = settledAt;
      if (!device.lastCompletedAt || new Date(task.completedAt || settledAt || 0) > new Date(device.lastCompletedAt)) device.lastCompletedAt = task.completedAt || settledAt || null;
    } else {
      pendingFen += amountFen;
      device.pendingFen += amountFen;
    }
  }
  const accountAverage = averageDailyFen(settledFen, firstSettledAt, now);
  const devices = [...deviceMap.values()].map((device) => {
    const average = averageDailyFen(device.settledFen, device.firstSettledAt, now);
    const lastSeenTime = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    const online = device.bindingStatus === "active" && Number.isFinite(lastSeenTime) && now.getTime() - lastSeenTime <= H3_NODE_ONLINE_WINDOW_MS;
    return {
      node_id: maskNodeIds ? maskH3NodeId(device.nodeId) : device.nodeId,
      node_name: device.nodeName,
      gpu_name: String(device.capabilities?.gpuName || device.capabilities?.gpu_name || "").trim() || null,
      vram_mb: Math.max(0, integer(device.capabilities?.vramMb ?? device.capabilities?.vram_mb)),
      online,
      status: online ? "online" : "offline",
      queue_status: device.processing ? "processing" : online ? (device.queueStatus || "idle") : "offline",
      total_earnings_fen: device.settledFen + device.pendingFen,
      settled_earnings_fen: device.settledFen,
      pending_earnings_fen: device.pendingFen,
      average_daily_earnings_fen: average.amountFen,
      active_days: average.activeDays,
      completed_task_count: device.completedTaskCount,
      last_claimed_at: device.lastClaimedAt ? new Date(device.lastClaimedAt).toISOString() : null,
      last_callback_at: device.lastCallbackAt ? new Date(device.lastCallbackAt).toISOString() : null,
      last_completed_at: device.lastCompletedAt ? new Date(device.lastCompletedAt).toISOString() : null,
      app_version: device.appVersion,
    };
  }).sort((left, right) => Number(right.online) - Number(left.online) || new Date(right.last_callback_at || 0) - new Date(left.last_callback_at || 0));
  const selected = currentNodeId ? devices.find((device) => device.node_id === currentNodeId || (!maskNodeIds && device.node_id === String(currentNodeId))) : null;
  return {
    ok: true,
    currency: "CNY",
    account: {
      total_earnings_fen: settledFen + pendingFen,
      settled_earnings_fen: settledFen,
      pending_earnings_fen: pendingFen,
      average_daily_earnings_fen: accountAverage.amountFen,
      active_days: accountAverage.activeDays,
      device_count: devices.length,
    },
    current_device: selected ? {
      node_id: selected.node_id,
      node_name: selected.node_name,
      total_earnings_fen: selected.total_earnings_fen,
      average_daily_earnings_fen: selected.average_daily_earnings_fen,
      completed_task_count: selected.completed_task_count,
      last_completed_at: selected.last_completed_at,
    } : null,
    devices,
  };
}

async function audit(collection, event, details = {}) {
  await collection.insertOne({ event, ...details, createdAt: new Date() });
}

export async function reserveH3Wallet({ getCollection, ownerId, amountFen, ledgerKey, orderNo, taskId, kind = "h3_reservation" }) {
  const wallets = await getCollection("wallets");
  const now = new Date();
  const entry = { key: ledgerKey, kind, amountFen: -amountFen, orderNo, taskId, createdAt: now };
  const wallet = await wallets.findOneAndUpdate(
    { ownerId, balanceFen: { $gte: amountFen }, ledgerKeys: { $ne: ledgerKey } },
    { $inc: { balanceFen: -amountFen }, $push: { ledgerKeys: { $each: [ledgerKey], $slice: -600 }, ledgerEntries: { $each: [entry], $slice: -600 } }, $set: { updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!wallet) {
    const existing = await wallets.findOne({ ownerId, ledgerKeys: ledgerKey });
    if (!existing) return null;
  }
  await (await getCollection("h3WalletLedger")).updateOne(
    { ledgerKey },
    { $setOnInsert: { ledgerKey, ownerId, taskId, orderNo, kind, amountFen: -amountFen, status: "reserved", createdAt: now }, $set: { updatedAt: now } },
    { upsert: true },
  );
  return wallet || { idempotent: true };
}

export async function creditH3Wallet({ getCollection, ownerId, amountFen, ledgerKey, orderNo, taskId, kind }) {
  const creditFen = integer(amountFen, -1);
  if (!ownerId || creditFen < 0 || !ledgerKey || !kind) throw Object.assign(new Error("MiniMax H3 入账参数无效"), { code: "VALIDATION_ERROR", status: 400 });
  const wallets = await getCollection("wallets");
  const ledgers = await getCollection("h3WalletLedger");
  const now = new Date();
  try {
    await ledgers.updateOne(
      { ledgerKey },
      { $setOnInsert: { ledgerKey, ownerId, taskId, orderNo, kind, amountFen: creditFen, settlementFen: creditFen, status: "pending", createdAt: now }, $set: { updatedAt: now } },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  const ledger = await ledgers.findOne({ ledgerKey });
  if (ledger && (ledger.ownerId?.toString?.() || String(ledger.ownerId)) !== (ownerId?.toString?.() || String(ownerId))) {
    throw Object.assign(new Error("MiniMax H3 流水归属冲突"), { code: "H3_LEDGER_CONFLICT", status: 409 });
  }
  if (ledger && (integer(ledger.amountFen, -1) !== creditFen || ledger.kind !== kind || ledger.orderNo !== orderNo)) {
    throw Object.assign(new Error("MiniMax H3 流水内容冲突"), { code: "H3_LEDGER_CONFLICT", status: 409 });
  }
  if (ledger?.status === "settled") return { wallet: await wallets.findOne({ ownerId }), idempotent: true };

  const entry = { key: ledgerKey, kind, amountFen: creditFen, orderNo, taskId, createdAt: now };
  const applyCredit = () => wallets.findOneAndUpdate(
    { ownerId, ledgerKeys: { $ne: ledgerKey } },
    { $inc: { balanceFen: creditFen }, $push: { ledgerKeys: { $each: [ledgerKey], $slice: -600 }, ledgerEntries: { $each: [entry], $slice: -600 } }, $set: { updatedAt: now } },
    { returnDocument: "after" },
  );
  let wallet = await applyCredit();
  let idempotent = false;
  if (!wallet) {
    const existing = await wallets.findOne({ ownerId });
    if (existing?.ledgerKeys?.includes?.(ledgerKey)) {
      wallet = existing;
      idempotent = true;
    } else if (!existing) {
      const created = { _id: new ObjectId(), ownerId, balanceFen: creditFen, ledgerKeys: [ledgerKey], ledgerEntries: [entry], createdAt: now, updatedAt: now };
      try {
        await wallets.insertOne(created);
        wallet = created;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        wallet = await applyCredit();
        if (!wallet) {
          wallet = await wallets.findOne({ ownerId });
          if (!wallet?.ledgerKeys?.includes?.(ledgerKey)) throw Object.assign(new Error("MiniMax H3 入账并发冲突"), { code: "H3_WALLET_CONFLICT", status: 409 });
          idempotent = true;
        }
      }
    } else {
      wallet = await applyCredit();
      if (!wallet) throw Object.assign(new Error("MiniMax H3 入账状态冲突"), { code: "H3_WALLET_CONFLICT", status: 409 });
    }
  }
  await ledgers.updateOne({ ledgerKey }, { $set: { status: "settled", settledAt: new Date(), updatedAt: new Date() } });
  return { wallet, idempotent };
}

async function resolvePlatformAdministrator(getCollection) {
  const users = await getCollection("users");
  const configuredId = String(process.env.GULONG_PLATFORM_ADMIN_USER_ID || "").trim();
  if (ObjectId.isValid(configuredId)) {
    const configured = await users.findOne({ _id: new ObjectId(configuredId), role: "admin", status: { $nin: ["disabled", "deleted"] } });
    if (configured) return configured;
  }
  const configuredEmail = normalizeEmail(process.env.GULONG_PLATFORM_ADMIN_EMAIL || DEFAULT_PLATFORM_ADMIN_EMAIL);
  const bootstrap = await users.findOne({ emailNormalized: configuredEmail, role: "admin", status: { $nin: ["disabled", "deleted"] } });
  if (bootstrap) return bootstrap;
  return users.findOne({ role: "admin", status: { $nin: ["disabled", "deleted"] } }, { sort: { createdAt: 1, _id: 1 } });
}

async function h3RequesterIsAdministrator(getCollection, task) {
  if (task?.requesterRoleSnapshot) return task.requesterRoleSnapshot === "admin";
  if (!task?.requesterUserId) return false;
  const requester = await (await getCollection("users")).findOne({ _id: task.requesterUserId }, { projection: { role: 1 } });
  return requester?.role === "admin";
}

export async function settleH3Revenue({ getCollection, task, executorUserId, platformAdminUserId = null }) {
  if (!task?._id) return task;
  const tasks = await getCollection("h3SharedTasks");
  let current = await tasks.findOne({ _id: task._id }) || task;
  if (current.status !== "completed") return current;
  if (current.chargeStatus !== "exempt" && await h3RequesterIsAdministrator(getCollection, current)) {
    current = await refundTask({ getCollection, task: current, reason: "管理员任务免扣费迁移", actor: "administrator_exemption" });
    current = await tasks.findOneAndUpdate(
      { _id: current._id },
      { $set: { chargeStatus: "exempt", revenueStatus: "exempt", administratorExemptedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: "after" },
    ) || current;
  }
  if (current.chargeStatus === "exempt") {
    await tasks.updateOne(
      { _id: current._id, revenueStatus: { $ne: "exempt" } },
      { $set: { revenueStatus: "exempt", settlement: { grossFen: 0, nodeShareFen: 0, platformShareFen: 0, reason: "administrator_exempt" }, updatedAt: new Date() } },
    );
    return await tasks.findOne({ _id: current._id }) || current;
  }
  if (current.chargeStatus === "package_no_charge") {
    await tasks.updateOne(
      { _id: current._id, revenueStatus: { $ne: "not_earned" } },
      { $set: { revenueStatus: "not_earned", settlement: { grossFen: 0, nodeShareFen: 0, platformShareFen: 0, reason: "short_video_package_allowance_exhausted" }, updatedAt: new Date() } },
    );
    return await tasks.findOne({ _id: current._id }) || current;
  }
  if (current.revenueStatus === "settled") return current;
  if (current.chargeStatus !== "settled") throw Object.assign(new Error("MiniMax H3 扣款尚未结算，不能分账"), { code: "H3_CHARGE_NOT_SETTLED", status: 409 });
  const executorId = executorUserId instanceof ObjectId ? executorUserId : ObjectId.isValid(executorUserId) ? new ObjectId(executorUserId) : null;
  if (!executorId) throw Object.assign(new Error("MiniMax H3 执行节点未绑定有效用户"), { code: "H3_EXECUTOR_REQUIRED", status: 409 });
  const platformAdministrator = platformAdminUserId
    ? { _id: platformAdminUserId instanceof ObjectId ? platformAdminUserId : new ObjectId(platformAdminUserId) }
    : await resolvePlatformAdministrator(getCollection);
  if (!platformAdministrator?._id) throw Object.assign(new Error("尚未配置可接收平台分成的管理员账号"), { code: "PLATFORM_ADMIN_NOT_CONFIGURED", status: 503 });
  const split = calculateH3RevenueSplit(integer(current.chargedFen, current.priceFen));
  const nodeLedgerKey = `h3:revenue:${current.orderNo}:${integer(current.retryCount)}:node`;
  const platformLedgerKey = `h3:revenue:${current.orderNo}:${integer(current.retryCount)}:platform`;
  const settlingAt = new Date();
  await tasks.updateOne(
    { _id: current._id, revenueStatus: { $ne: "settled" } },
    { $set: { revenueStatus: "settling", settlement: { ...split, nodeUserId: executorId, platformAdminUserId: platformAdministrator._id, nodeLedgerKey, platformLedgerKey, settlingAt }, updatedAt: settlingAt } },
  );
  await Promise.all([
    creditH3Wallet({ getCollection, ownerId: executorId, amountFen: split.nodeShareFen, ledgerKey: nodeLedgerKey, orderNo: current.orderNo, taskId: current._id, kind: "h3_node_commission" }),
    creditH3Wallet({ getCollection, ownerId: platformAdministrator._id, amountFen: split.platformShareFen, ledgerKey: platformLedgerKey, orderNo: current.orderNo, taskId: current._id, kind: "h3_platform_commission" }),
  ]);
  const settledAt = new Date();
  await tasks.updateOne(
    { _id: current._id, revenueStatus: { $ne: "settled" } },
    { $set: { revenueStatus: "settled", "settlement.settledAt": settledAt, updatedAt: settledAt } },
  );
  return await tasks.findOne({ _id: current._id }) || { ...current, revenueStatus: "settled", settlement: { ...split, nodeUserId: executorId, platformAdminUserId: platformAdministrator._id, nodeLedgerKey, platformLedgerKey, settledAt } };
}

async function refundTask({ getCollection, task, reason, actor = "system" }) {
  if (!task || task.chargeStatus === "exempt" || task.chargeStatus === "package_no_charge" || task.refundStatus === "refunded") return task;
  const tasks = await getCollection("h3SharedTasks");
  const now = new Date();
  const claimed = await tasks.findOneAndUpdate(
    { _id: task._id, refundStatus: { $nin: ["refunded"] } },
    { $set: { refundStatus: "refunding", refundReason: String(reason || "任务终止").slice(0, 500), updatedAt: now } },
    { returnDocument: "after" },
  );
  const current = claimed || await tasks.findOne({ _id: task._id });
  if (!current || current.refundStatus === "refunded") return current;
  const refundKey = `h3:refund:${current.activeChargeKey || current.orderNo}`;
  const chargedFen = Math.max(0, integer(current.chargedFen, current.priceFen));
  const wallets = await getCollection("wallets");
  if (current.billingMode === "short_video_package") {
    await refundShortVideoPackageAllowance({ getCollection, task: current, amountFen: chargedFen, ledgerKey: refundKey, now });
  } else {
    const entry = { key: refundKey, kind: "h3_refund", amountFen: chargedFen, orderNo: current.orderNo, taskId: current._id, createdAt: now };
    await wallets.findOneAndUpdate(
      { ownerId: current.requesterUserId, ledgerKeys: { $ne: refundKey } },
      { $inc: { balanceFen: chargedFen }, $push: { ledgerKeys: { $each: [refundKey], $slice: -600 }, ledgerEntries: { $each: [entry], $slice: -600 } }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
  }
  await (await getCollection("h3WalletLedger")).updateOne(
    { ledgerKey: refundKey },
    { $setOnInsert: { ledgerKey: refundKey, ownerId: current.requesterUserId, taskId: current._id, orderNo: current.orderNo, kind: current.billingMode === "short_video_package" ? "h3_short_video_package_refund" : "h3_refund", amountFen: chargedFen, createdAt: now }, $set: { status: "refunded", actor, updatedAt: now } },
    { upsert: true },
  );
  await (await getCollection("h3WalletLedger")).updateOne({ ledgerKey: current.activeChargeKey }, { $set: { status: "refunded", refundedAt: now, updatedAt: now } });
  return await tasks.findOneAndUpdate({ _id: current._id, refundStatus: "refunding" }, { $set: { refundStatus: "refunded", chargeStatus: "refunded", revenueStatus: "not_earned", refundedAt: now, updatedAt: now } }, { returnDocument: "after" })
    || tasks.findOne({ _id: current._id });
}

export async function cancelTimedOutH3Tasks({ getCollection, notifyUserOnce = null, now = new Date(), limit = 100 } = {}) {
  const tasks = await getCollection("h3SharedTasks");
  const candidates = await tasks.find({
    status: { $in: ["queued", "claimed", "processing"] },
    autoCancelAt: { $lte: now },
  }).sort({ autoCancelAt: 1, createdAt: 1 }).limit(Math.max(1, Math.min(500, integer(limit, 100)))).toArray();
  const summary = { scanned: candidates.length, cancelled: 0, refunded: 0, notified: 0 };
  for (const candidate of candidates) {
    const cancelled = await tasks.findOneAndUpdate(
      { _id: candidate._id, status: { $in: ["queued", "claimed", "processing"] }, autoCancelAt: { $lte: now } },
      {
        $set: {
          status: "cancelled",
          progressStage: "cancelled",
          revenueStatus: "not_earned",
          error: H3_TIMEOUT_ERROR,
          cancelReason: "estimated_timeout",
          cancelledAt: now,
          timedOutAt: now,
          updatedAt: now,
        },
        $unset: { claimLeaseUntil: "" },
      },
      { returnDocument: "after" },
    );
    if (!cancelled) continue;
    summary.cancelled += 1;
    const refunded = await refundTask({ getCollection, task: cancelled, reason: H3_TIMEOUT_ERROR.message, actor: "h3_estimated_timeout" });
    if (refunded?.refundStatus === "refunded") summary.refunded += 1;
    await Promise.allSettled([
      (await getCollection("h3OutputUploads")).updateMany(
        { taskId: candidate._id, status: "issued" },
        { $set: { status: "expired", expiredAt: now, updatedAt: now }, $unset: { expiresAt: "" } },
      ),
      audit(await getCollection("h3TaskAudits"), "estimated_timeout_cancelled", {
        taskId: candidate._id,
        orderNo: candidate.orderNo,
        requesterUserId: candidate.requesterUserId,
        estimatedTotalSeconds: integer(candidate.estimatedTotalSeconds || candidate.dispatchEstimatedTotalSeconds),
        autoCancelAt: candidate.autoCancelAt,
      }),
    ]);
    if (notifyUserOnce) {
      await notifyUserOnce(
        candidate.requesterUserId,
        "h3_task_estimated_timeout",
        "共享节点视频任务已自动取消",
        "任务在预计总耗时的 10 倍内仍未完成，系统已自动取消；如有预扣费用已原路退回。请更换其他视频模型后重试。",
        { taskId: candidate._id, orderNo: candidate.orderNo, reason: "estimated_timeout" },
      ).then(() => { summary.notified += 1; }).catch(() => {});
    }
  }
  return summary;
}

function normalizeH3NodeCapabilities(capabilities = {}) {
  const maxDurationSeconds = integer(capabilities.max_duration_seconds ?? capabilities.maxDurationSeconds, -1);
  const profiles = Array.isArray(capabilities.profiles) ? [...new Set(capabilities.profiles.map((value) => String(value).trim().toLowerCase()).filter(Boolean))].slice(0, 30) : [];
  const maxImageCount = integer(capabilities.max_image_count ?? capabilities.max_images ?? capabilities.maxImageCount, -1);
  const maxVideoCount = integer(capabilities.max_video_count ?? capabilities.max_videos ?? capabilities.maxVideoCount, -1);
  const maxAudioCount = integer(capabilities.max_audio_count ?? capabilities.max_audio ?? capabilities.maxAudioCount, -1);
  const maxConcurrentTasks = integer(capabilities.max_concurrent_tasks ?? capabilities.maxConcurrentTasks, 1);
  const samplingSteps = Array.isArray(capabilities.sampling_steps ?? capabilities.samplingSteps)
    ? [...new Set((capabilities.sampling_steps ?? capabilities.samplingSteps).map((value) => integer(value, -1)).filter((value) => H3_SAMPLING_STEPS.has(value)))]
    : [4];
  if (maxDurationSeconds < 1 || maxDurationSeconds > H3_MAX_DURATION_SECONDS || !profiles.length || !samplingSteps.length || maxImageCount < 0 || maxImageCount > 9 || maxVideoCount < 0 || maxVideoCount > 3 || maxAudioCount < 0 || maxAudioCount > 3 || maxConcurrentTasks < 1 || maxConcurrentTasks > 8) {
    throw Object.assign(new Error("节点必须上报有效的最大时长、profiles、采样步数、素材上限与并发上限"), { code: "INVALID_NODE_CAPABILITIES", status: 400 });
  }
  return {
    gpuName: String(capabilities.gpu_name || capabilities.gpuName || capabilities.gpu || "").trim().slice(0, 160) || null,
    vramMb: Math.max(0, integer(capabilities.vram_mb ?? capabilities.vramMb)),
    maxDurationSeconds,
    profiles,
    samplingSteps,
    maxImageCount,
    maxVideoCount,
    maxAudioCount,
    maxConcurrentTasks,
    batchCapable: capabilities.batch_claim === true || capabilities.batch_claim_v1 === true || capabilities.batchCapable === true,
    longformV1: capabilities.longform_v1 === true || capabilities.longformV1 === true,
    localPromptOptimizationV1: capabilities.local_prompt_optimization_v1 === true || capabilities.localPromptOptimizationV1 === true,
  };
}

export function h3NodeCanRunTask(node, task) {
  const capabilities = node?.capabilities || {};
  if (!node || node.availableSlots < 1 || !capabilities.profiles?.includes?.(String(task.profile || "").toLowerCase())) return false;
  if (!capabilities.samplingSteps?.includes?.(integer(task.samplingSteps, 4))) return false;
  if (integer(task.imageCount) > capabilities.maxImageCount || integer(task.videoCount) > capabilities.maxVideoCount || integer(task.audioCount) > capabilities.maxAudioCount) return false;
  if (task.videoMode === "extended") {
    if (!capabilities.longformV1 || integer(task.segmentDurationSeconds) > capabilities.maxDurationSeconds) return false;
  } else if (integer(task.durationSeconds) > capabilities.maxDurationSeconds) return false;
  const optimizationRequired = task.promptOptimizationEnabled !== false && task.localPromptOptimizationRequired !== false;
  return !optimizationRequired || capabilities.localPromptOptimizationV1;
}

function routeError(c, error) {
  return c.json({ code: error.code || "H3_SHARED_ERROR", message: localizeErrorMessage(error, "共享节点服务暂时不可用") }, error.status || 500);
}

export function registerH3SharedRoutes(app, dependencies) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const enforceRateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  const issueDownloadUrl = dependencies.createPresignedDownloadUrl || createPresignedDownloadUrl;
  const issueUploadUrl = dependencies.createPresignedPutUrl || createPresignedPutUrl;
  const inspectCosObject = dependencies.headObject || headObject;
  const removeCosObject = dependencies.deleteObject || deleteObject;
  const ensureUploadCors = dependencies.ensureBrowserUploadCors || ensureBrowserUploadCors;
  const queueCoordinator = dependencies.queueCoordinator || createH3QueueCoordinator({ getCollection, model: H3_SHARED_MODEL });
  const notifyOnce = dependencies.notifyUserOnce || null;
  const { authenticate, requireAdmin, requireTrustedMutation, verifyActivationReceipt } = dependencies;

  async function authenticateBinding(c, { requireNodeId, touch = true } = {}) {
    const raw = String(c.req.header(H3_ACCOUNT_BINDING_HEADER) || "").trim();
    if (!/^gab_[A-Za-z0-9_-]{40,}$/.test(raw)) return { error: c.json({ code: "ACCOUNT_BINDING_REQUIRED", message: "请先在已激活的古龙桌面端绑定官网账号" }, 401) };
    const binding = await (await getCollection("nodeAccountBindings")).findOne({ tokenHash: hashOpaqueToken(raw, "h3-account-binding"), status: "active", revokedAt: null });
    if (!binding) return { error: c.json({ code: "INVALID_ACCOUNT_BINDING", message: "账号绑定已失效，请在桌面端重新绑定" }, 401) };
    const user = await (await getCollection("users")).findOne({ _id: binding.userId, status: "active" });
    if (!user) return { error: c.json({ code: "INVALID_ACCOUNT_BINDING", message: "账号绑定已失效，请在桌面端重新绑定" }, 401) };
    if (requireNodeId && requireNodeId !== binding.nodeId) {
      await audit(await getCollection("nodeAccountBindingAudits"), "node_mismatch", { bindingId: binding._id, userId: binding.userId, claimedNodeId: requireNodeId, boundNodeId: binding.nodeId, ipFingerprint: fingerprintIp(c.req.header("x-forwarded-for") || "local") });
      return { error: c.json({ code: "NODE_BINDING_MISMATCH", message: "当前节点与账号绑定不一致" }, 403) };
    }
    if (touch) void (await getCollection("nodeAccountBindings")).updateOne({ _id: binding._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    return { binding, user };
  }

  async function trustedAssets(ownerId, assets) {
    const flattened = [...assets.images, ...assets.videos, ...assets.audio];
    if (!flattened.length) return assets;
    const ids = flattened.map((asset) => asset.assetId).filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    const objectKeys = flattened.map((asset) => asset.objectKey).filter(Boolean);
    const identityFilters = [...(ids.length ? [{ _id: { $in: ids } }] : []), ...(objectKeys.length ? [{ objectKey: { $in: objectKeys } }] : [])];
    const records = identityFilters.length ? await (await getCollection("h3AssetUploads")).find({ ownerId, status: "ready", $or: identityFilters }).toArray() : [];
    const byId = new Map(records.map((record) => [record._id.toString(), record]));
    const resolve = (asset) => {
      const record = asset.assetId ? byId.get(asset.assetId) : records.find((candidate) => candidate.objectKey === asset.objectKey);
      if (!record || record.kind !== asset.kind || (asset.objectKey && record.objectKey !== asset.objectKey)) throw Object.assign(new Error("素材尚未完成受信任上传，或不属于当前账号"), { code: "ASSET_NOT_READY", status: 409 });
      return { assetId: record._id.toString(), kind: record.kind, filename: record.filename, objectKey: record.objectKey, bytes: record.bytes, sha256: record.sha256 };
    };
    return { images: assets.images.map(resolve), videos: assets.videos.map(resolve), audio: assets.audio.map(resolve) };
  }

  function claimAssets(assets) {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const issue = (asset) => ({ ...asset, download_url: issueDownloadUrl(asset.objectKey, { expires: 15 * 60, filename: asset.filename }), download_expires_at: expiresAt });
    return { images: (assets?.images || []).map(issue), videos: (assets?.videos || []).map(issue), audio: (assets?.audio || []).map(issue) };
  }

  async function issueOutputUpload(task, auth, now) {
    const grantId = randomBytes(18).toString("base64url");
    const objectKey = `h3/tasks/${task._id}/outputs/${grantId}.mp4`;
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const requiredHeaders = {
      "Content-Type": "video/mp4",
      "x-cos-meta-h3-task-id": task._id.toString(),
      "x-cos-meta-h3-upload-grant": grantId,
    };
    const url = issueUploadUrl(objectKey, { expires: 60 * 60, headers: requiredHeaders });
    await (await getCollection("h3OutputUploads")).insertOne({ grantId, taskId: task._id, orderNo: task.orderNo, objectKey, status: "issued", issuedToBindingId: auth.binding._id, issuedToNodeId: auth.binding.nodeId, createdAt: now, expiresAt, updatedAt: now });
    return {
      url,
      method: "PUT",
      headers: requiredHeaders,
      required_metadata_headers: ["x-cos-meta-sha256", "x-cos-meta-bytes", "x-cos-meta-filename-b64"],
      object_key: objectKey,
      grant_id: grantId,
      expires_at: expiresAt.toISOString(),
    };
  }

  app.post("/api/desktop/account-bindings/verify", async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const ip = fingerprintIp(c.req.header("x-forwarded-for") || "local");
    const ipRate = await enforceRateLimit(`h3-binding-ip:${ip}`, { limit: 12, windowMs: 15 * 60_000 });
    if (!ipRate.allowed) return c.json({ code: "RATE_LIMITED", message: "绑定尝试过多，请 15 分钟后重试" }, 429);
    const body = await c.req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const nodeId = String(body.node_id || "").trim();
    const nodeName = String(body.node_name || "").trim().slice(0, 120);
    const appVersion = String(body.app_version || "").trim().slice(0, 40);
    if (!email || !/^[A-Za-z0-9._:-]{12,160}$/.test(nodeId) || !nodeName || !appVersion || !body.activation_receipt) return c.json({ code: "VALIDATION_ERROR", message: "邮箱、节点信息或激活回执不正确" }, 400);
    let activation;
    try { activation = await verifyActivationReceipt(body.activation_receipt); }
    catch (error) {
      await audit(await getCollection("nodeAccountBindingAudits"), "activation_rejected", { nodeId, ipFingerprint: ip, reason: error.code || "INVALID_ACTIVATION_PROOF" });
      return c.json({ code: "INVALID_ACTIVATION_PROOF", message: "桌面端激活证明无效或已停用" }, 403);
    }
    const activationRate = await enforceRateLimit(`h3-binding-license:${activation.record._id}:${nodeId}`, { limit: 8, windowMs: 15 * 60_000 });
    if (!activationRate.allowed) return c.json({ code: "RATE_LIMITED", message: "当前激活设备绑定过于频繁，请稍后重试" }, 429);
    const user = await (await getCollection("users")).findOne({ status: "active", $or: [{ emailNormalized: email }, { email }] });
    if (!user) {
      await audit(await getCollection("nodeAccountBindingAudits"), "user_not_found", { activationLicenseId: activation.record._id, nodeId, emailHash: createHash("sha256").update(email).digest("hex"), ipFingerprint: ip });
      return c.json({ code: "USER_NOT_FOUND", message: "该邮箱尚未注册古龙账户", register_url: "https://www.sologle.com/" }, 404);
    }
    const rawToken = bindingToken();
    const tokenHash = hashOpaqueToken(rawToken, "h3-account-binding");
    const now = new Date();
    const bindings = await getCollection("nodeAccountBindings");
    const previous = await bindings.findOne({ activationLicenseId: activation.record._id, nodeId });
    const binding = await bindings.findOneAndUpdate(
      { activationLicenseId: activation.record._id, nodeId },
      { $set: { userId: user._id, emailSnapshot: email, nodeName, appVersion, activationDeviceId: activation.payload.deviceId, tokenHash, status: "active", revokedAt: null, updatedAt: now, lastVerifiedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    await audit(await getCollection("nodeAccountBindingAudits"), previous && previous.userId?.toString() !== user._id.toString() ? "rebound" : "bound", { bindingId: binding._id, userId: user._id, previousUserId: previous?.userId || null, activationLicenseId: activation.record._id, nodeId, nodeName, appVersion, ipFingerprint: ip });
    return c.json({ ok: true, binding_token: rawToken, binding: { id: binding._id.toString(), email, user_id: user._id.toString(), display_name: user.displayName || user.username || email.split("@")[0], node_id: nodeId, node_name: nodeName, app_version: appVersion, verified_at: now.toISOString() } });
  });

  app.post("/api/desktop/account-bindings/unbind", async (c) => {
    const auth = await authenticateBinding(c); if (auth.error) return auth.error;
    const now = new Date();
    await (await getCollection("nodeAccountBindings")).updateOne({ _id: auth.binding._id, status: "active" }, { $set: { status: "revoked", revokedAt: now, updatedAt: now }, $unset: { tokenHash: "" } });
    await audit(await getCollection("nodeAccountBindingAudits"), "unbound", { bindingId: auth.binding._id, userId: auth.user._id, nodeId: auth.binding.nodeId, ipFingerprint: fingerprintIp(c.req.header("x-forwarded-for") || "local") });
    return c.json({ ok: true, revoked_at: now.toISOString() });
  });

  app.get("/api/desktop/earnings/summary", async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const auth = await authenticateBinding(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`h3-earnings:${auth.binding._id}`, { limit: 120, windowMs: 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "收益查询过于频繁，请稍后重试" }, 429);
    const requestedNodeId = String(c.req.query("node_id") || auth.binding.nodeId || "").trim();
    const summary = await buildH3EarningsSummary({ getCollection, userId: auth.user._id, currentNodeId: requestedNodeId });
    if (requestedNodeId && !summary.devices.some((device) => device.node_id === requestedNodeId)) {
      return c.json({ code: "NODE_NOT_OWNED", message: "该节点不属于当前绑定账户" }, 403);
    }
    return c.json(summary);
  });

  app.get("/api/account/earnings/summary", async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const summary = await buildH3EarningsSummary({ getCollection, userId: auth.user.id, maskNodeIds: true });
    return c.json(summary);
  });

  app.post("/api/h3/prompts/optimize", async (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json({ code: "PROMPT_OPTIMIZATION_MOVED_TO_DESKTOP", message: "服务端提示词优化接口已停用；请在创建任务时通过 prompt_optimization_enabled 选择是否由 MiniMax H3 极速视频桌面端执行本地魔法优化" }, 410);
  });

  app.post("/api/h3/assets/presign", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c, { scopes: ["tasks:write"] }); if (auth.error) return auth.error;
    const body = await c.req.json().catch(() => ({}));
    const kind = ["image", "video", "audio"].includes(body.kind) ? body.kind : null;
    const filename = sanitizeFilename(body.filename, `${kind || "asset"}.bin`);
    const bytes = integer(body.bytes, -1);
    const sha256 = String(body.sha256 || "").trim().toUpperCase();
    const contentType = String(body.content_type || body.contentType || "application/octet-stream").trim().toLowerCase();
    const allowed = kind === "image" ? /^image\/(jpeg|png|webp|gif)$/ : kind === "video" ? /^video\/(mp4|webm|quicktime)$/ : kind === "audio" ? /^audio\/(mpeg|mp4|wav|x-wav|ogg|webm)$/ : null;
    if (!kind || !allowed.test(contentType) || bytes < 1 || bytes > 2 * 1024 * 1024 * 1024 || !/^[A-F0-9]{64}$/.test(sha256)) return c.json({ code: "VALIDATION_ERROR", message: "H3 素材类型、大小或 SHA-256 不正确" }, 400);
    try {
      await ensureUploadCors();
    } catch (error) {
      console.error("[h3-assets:presign] COS browser-upload CORS self-check failed", {
        origin: process.env.APP_ORIGIN || null,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ code: "COS_CORS_CONFIGURATION_FAILED", message: "腾讯云 COS 暂未允许当前官网上传素材，请稍后重试或联系管理员" }, 503);
    }
    const ownerId = new ObjectId(auth.user.id);
    const uploadId = new ObjectId();
    const objectKey = `h3/requesters/${ownerId}/assets/${uploadId}-${filename}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const requiredHeaders = { "Content-Type": contentType, "x-cos-meta-sha256": sha256, "x-cos-meta-bytes": String(bytes), "x-cos-meta-owner-id": ownerId.toString(), "x-cos-meta-h3-asset-id": uploadId.toString() };
    await (await getCollection("h3AssetUploads")).insertOne({ _id: uploadId, ownerId, kind, filename, contentType, bytes, sha256, objectKey, status: "uploading", createdAt: now, updatedAt: now, expiresAt });
    return c.json({ asset_id: uploadId.toString(), upload_url: issueUploadUrl(objectKey, { expires: 60 * 60, headers: requiredHeaders }), method: "PUT", object_key: objectKey, headers: requiredHeaders, expires_at: expiresAt.toISOString() }, 201);
  });

  app.post("/api/h3/assets/:id/complete", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c, { scopes: ["tasks:write"] }); if (auth.error) return auth.error;
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ASSET_NOT_FOUND", message: "H3 素材不存在" }, 404);
    const uploads = await getCollection("h3AssetUploads");
    const asset = await uploads.findOne({ _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id), status: "uploading", expiresAt: { $gt: new Date() } });
    if (!asset) return c.json({ code: "ASSET_NOT_FOUND", message: "H3 素材上传不存在、已完成或已过期" }, 404);
    let head;
    try { head = await inspectCosObject(asset.objectKey); }
    catch { return c.json({ code: "ASSET_OBJECT_NOT_FOUND", message: "腾讯云 COS 中尚未找到素材" }, 409); }
    const matches = objectBytes(head) === asset.bytes
      && objectHeader(head, "x-cos-meta-sha256").trim().toUpperCase() === asset.sha256
      && objectHeader(head, "x-cos-meta-bytes").trim() === String(asset.bytes)
      && objectHeader(head, "x-cos-meta-owner-id").trim() === asset.ownerId.toString()
      && objectHeader(head, "x-cos-meta-h3-asset-id").trim() === asset._id.toString();
    if (!matches) {
      await Promise.allSettled([removeCosObject(asset.objectKey), uploads.updateOne({ _id: asset._id }, { $set: { status: "rejected", error: "ASSET_RECEIPT_MISMATCH", updatedAt: new Date() } })]);
      return c.json({ code: "ASSET_RECEIPT_MISMATCH", message: "素材对象的大小、摘要或归属校验失败" }, 409);
    }
    const now = new Date();
    await uploads.updateOne({ _id: asset._id, status: "uploading" }, { $set: { status: "ready", completedAt: now, updatedAt: now }, $unset: { expiresAt: "" } });
    return c.json({ asset: { asset_id: asset._id.toString(), kind: asset.kind, filename: asset.filename, object_key: asset.objectKey, bytes: asset.bytes, sha256: asset.sha256 } });
  });

  app.post("/api/h3/tasks", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c, { scopes: ["tasks:write"] }); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`h3-create:${auth.user.id}`, { limit: 20, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "共享节点任务创建过于频繁，请稍后重试" }, 429);
    try {
      const body = await c.req.json();
      let input = normalizeH3TaskInput(body);
      const rawIdempotency = String(c.req.header("Idempotency-Key") || body.idempotency_key || "").trim();
      if (rawIdempotency.length < 8 || rawIdempotency.length > 160) return c.json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "请提供 8–160 字符的 Idempotency-Key" }, 400);
      const ownerId = new ObjectId(auth.user.id);
      const idempotencyKey = createHash("sha256").update(`${ownerId}:${rawIdempotency}`).digest("hex");
      const tasks = await getCollection("h3SharedTasks");
      const existing = await tasks.findOne({ idempotencyKey });
      if (existing) {
        await ensureH3ConversationMessages({ getCollection, task: existing });
        const wallet = await (await getCollection("wallets")).findOne({ ownerId: existing.requesterUserId });
        return c.json({ task: publicTask(existing), billing: taskBilling(existing, wallet), idempotent: true });
      }
      input.assets = await trustedAssets(ownerId, input.assets);
      const now = new Date();
      const orderNo = orderNumber();
      const taskId = new ObjectId();
      const requestedConversationId = String(body.conversation_id || body.conversationId || "").trim();
      const conversation = input.sourceChannel === "website" ? {
        conversationId: ObjectId.isValid(requestedConversationId) ? new ObjectId(requestedConversationId) : new ObjectId(),
        requestMessageId: new ObjectId(),
        resultMessageId: new ObjectId(),
        conversationAssociation: ObjectId.isValid(requestedConversationId) ? "client_supplied" : "created_with_task",
      } : {};
      const chargeKey = `h3:charge:${orderNo}:0`;
      const exempt = auth.user.role === "admin";
      const dispatchEstimatedTotalSeconds = estimateH3TaskTotalSeconds(input);
      const autoCancelAt = h3TaskAutoCancelAt(now, dispatchEstimatedTotalSeconds);
      const task = {
        _id: taskId, orderNo, idempotencyKey, requesterUserId: ownerId, requesterEmailSnapshot: auth.user.email || null, requesterRoleSnapshot: auth.user.role || "user", ...input, ...conversation,
        ...(exempt ? {} : { walletLedgerId: chargeKey, activeChargeKey: chargeKey }),
        chargedFen: exempt ? 0 : input.priceFen,
        billingMode: exempt ? "administrator_exempt" : "wallet",
        dispatchEstimatedTotalSeconds, autoCancelAt,
        status: exempt ? "queued" : "reserving", chargeStatus: exempt ? "exempt" : "reserving", revenueStatus: exempt ? "exempt" : "pending",
        ...(exempt ? { queuedAt: now } : {}), retryCount: 0, createdAt: now, updatedAt: now,
      };
      try { await tasks.insertOne(task); }
      catch (error) {
        if (error?.code !== 11000) throw error;
        const duplicate = await tasks.findOne({ idempotencyKey });
        await ensureH3ConversationMessages({ getCollection, task: duplicate });
        const wallet = await (await getCollection("wallets")).findOne({ ownerId: duplicate.requesterUserId });
        return c.json({ task: publicTask(duplicate), billing: taskBilling(duplicate, wallet), idempotent: true });
      }
      await ensureH3ConversationMessages({ getCollection, task });
      if (exempt) {
        const wallet = await (await getCollection("wallets")).findOne({ ownerId });
        await audit(await getCollection("h3TaskAudits"), "created", { taskId, orderNo, actorUserId: ownerId, sourceChannel: input.sourceChannel, priceFen: input.priceFen, billingExempt: true });
        await queueCoordinator.invalidate().catch(() => {});
        return c.json({ task: publicTask(task), billing: taskBilling(task, wallet), idempotent: false }, 201);
      }
      const packageReservation = await reserveShortVideoPackageAllowance({ getCollection, ownerId, amountFen: input.priceFen, ledgerKey: chargeKey, orderNo, taskId, now });
      if (packageReservation.matched) {
        const chargedFen = integer(packageReservation.chargedFen);
        const chargeStatus = chargedFen > 0 ? "reserved" : "package_no_charge";
        const queued = await tasks.findOneAndUpdate(
          { _id: taskId, status: "reserving" },
          { $set: { status: "queued", chargeStatus, chargedFen, billingMode: "short_video_package", subscriptionPlanSnapshot: SHORT_VIDEO_PLAN_ID, revenueStatus: chargedFen > 0 ? "pending" : "not_earned", queuedAt: new Date(), updatedAt: new Date() } },
          { returnDocument: "after" },
        );
        await audit(await getCollection("h3TaskAudits"), "created", { taskId, orderNo, actorUserId: ownerId, sourceChannel: input.sourceChannel, priceFen: input.priceFen, chargedFen, billingMode: "short_video_package" });
        await queueCoordinator.invalidate().catch(() => {});
        const wallet = packageReservation.wallet || await (await getCollection("wallets")).findOne({ ownerId });
        return c.json({ task: publicTask(queued), billing: taskBilling(queued, wallet), idempotent: false }, 201);
      }
      const reserved = await reserveH3Wallet({ getCollection, ownerId, amountFen: input.priceFen, ledgerKey: chargeKey, orderNo, taskId });
      if (!reserved) {
        await tasks.updateOne({ _id: taskId, status: "reserving" }, { $set: { status: "rejected", chargeStatus: "not_charged", error: { code: "INSUFFICIENT_BALANCE", message: "可用余额不足" }, updatedAt: new Date() } });
        return c.json({ code: "INSUFFICIENT_BALANCE", message: `可用余额不足，本次任务需要 ${(input.priceFen / 100).toFixed(2)} 元`, requiredFen: input.priceFen }, 402);
      }
      const queued = await tasks.findOneAndUpdate({ _id: taskId, status: "reserving" }, { $set: { status: "queued", chargeStatus: "reserved", chargedFen: input.priceFen, billingMode: "wallet", queuedAt: new Date(), updatedAt: new Date() } }, { returnDocument: "after" });
      await audit(await getCollection("h3TaskAudits"), "created", { taskId, orderNo, actorUserId: ownerId, sourceChannel: input.sourceChannel, priceFen: input.priceFen, chargedFen: input.priceFen, billingMode: "wallet" });
      await queueCoordinator.invalidate().catch(() => {});
      const remainingBalanceFen = reserved.balanceFen == null ? integer((await (await getCollection("wallets")).findOne({ ownerId }))?.balanceFen) : integer(reserved.balanceFen);
      return c.json({ task: publicTask(queued), billing: { chargedFen: input.priceFen, remainingBalanceFen, packageBalanceFen: integer(reserved.shortVideoPackageBalanceFen), billingMode: "wallet", exempt: false }, idempotent: false }, 201);
    } catch (error) { return routeError(c, error); }
  });

  app.get("/api/h3/tasks", async (c) => {
    const auth = await authenticate(c, { scopes: ["tasks:read"] }); if (auth.error) return auth.error;
    await cancelTimedOutH3Tasks({ getCollection, notifyUserOnce: notifyOnce, limit: 100 }).catch(() => {});
    const tasks = await (await getCollection("h3SharedTasks")).find({ requesterUserId: new ObjectId(auth.user.id) }).sort({ createdAt: -1 }).limit(50).toArray();
    return c.json({ tasks: tasks.map((task) => publicTask(task)) });
  });

  app.get("/api/h3/conversations/recent", async (c) => {
    const auth = await authenticate(c, { scopes: ["tasks:read"] }); if (auth.error) return auth.error;
    c.header("Cache-Control", "private, no-store, max-age=0");
    const ownerId = new ObjectId(auth.user.id);
    await cancelTimedOutH3Tasks({ getCollection, notifyUserOnce: notifyOnce, limit: 100 }).catch(() => {});
    await backfillCompletedH3ConversationMessages({ getCollection, ownerId, limit: 50 });
    const cleanupKey = ownerId.toString();
    if (!h3CleanupThrottle.has(cleanupKey) || Date.now() - h3CleanupThrottle.get(cleanupKey) >= 60_000) {
      h3CleanupThrottle.set(cleanupKey, Date.now());
      if (h3CleanupThrottle.size > 2_000) h3CleanupThrottle.delete(h3CleanupThrottle.keys().next().value);
      await cleanupExpiredH3Outputs({ getCollection, removeObject: removeCosObject, ownerId, limit: 20 });
    }
    const messages = await getCollection("agentMessages");
    const requested = String(c.req.query("conversation_id") || "").trim();
    let conversationId = ObjectId.isValid(requested) ? new ObjectId(requested) : null;
    if (!conversationId) {
      const latest = await messages.find({ ownerId, role: "assistant", model: H3_SHARED_MODEL, h3TaskId: { $exists: true } }).sort({ createdAt: -1 }).limit(1).toArray();
      conversationId = latest[0]?.conversationId || null;
    }
    if (!conversationId) return c.json({ conversationId: null, messages: [] });
    const taskCollection = await getCollection("h3SharedTasks");
    const readConversation = (selectedConversationId) => Promise.all([
      messages.find({ ownerId, conversationId: selectedConversationId, role: "assistant", model: H3_SHARED_MODEL, h3TaskId: { $exists: true } }).sort({ createdAt: 1 }).limit(100).toArray(),
      taskCollection.find({ requesterUserId: ownerId, conversationId: selectedConversationId, sourceChannel: "website" }).sort({ createdAt: 1 }).limit(100).toArray(),
    ]);
    let [records, conversationTasks] = await readConversation(conversationId);
    if (!records.length && !conversationTasks.length && ObjectId.isValid(requested)) {
      const latest = await messages.find({ ownerId, role: "assistant", model: H3_SHARED_MODEL, h3TaskId: { $exists: true } }).sort({ createdAt: -1 }).limit(1).toArray();
      if (latest[0]?.conversationId) {
        conversationId = latest[0].conversationId;
        [records, conversationTasks] = await readConversation(conversationId);
      }
    }
    return c.json({ conversationId: conversationId.toString(), messages: records.map((message) => publicH3ConversationMessage(message)), tasks: conversationTasks.map(publicH3ConversationTask) });
  });

  app.get("/api/h3/tasks/:id", async (c) => {
    const auth = await authenticate(c, { scopes: ["tasks:read"] }); if (auth.error) return auth.error;
    const id = c.req.param("id");
    const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { orderNo: id };
    const task = await (await getCollection("h3SharedTasks")).findOne({ ...filter, ...(auth.user.role === "admin" ? {} : { requesterUserId: new ObjectId(auth.user.id) }) });
    if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "共享节点任务不存在" }, 404);
    return c.json({ task: publicTask(task) });
  });

  app.get("/api/h3/tasks/:id/output", async (c) => {
    const auth = await authenticate(c, { scopes: ["tasks:read"] }); if (auth.error) return auth.error;
    c.header("Cache-Control", "private, no-store, max-age=0");
    const id = c.req.param("id");
    const task = await (await getCollection("h3SharedTasks")).findOne({ ...(ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { orderNo: id }), ...(auth.user.role === "admin" ? {} : { requesterUserId: new ObjectId(auth.user.id) }) });
    if (!task?.output?.objectKey) return c.json({ code: "OUTPUT_NOT_FOUND", message: "视频不存在或无权访问" }, 404);
    const state = h3OutputState(task);
    if (state.expired) {
      await cleanupExpiredH3Output({ getCollection, task, removeObject: removeCosObject }).catch(() => {});
      return c.json({ code: "OUTPUT_EXPIRED", message: "视频已过期并删除", expiresAt: state.expiresAt }, 410);
    }
    const remainingSeconds = Math.max(1, Math.floor((state.expiresAt.getTime() - Date.now()) / 1_000));
    const disposition = c.req.query("disposition") === "attachment" ? "attachment" : "inline";
    const url = issueDownloadUrl(task.output.objectKey, { expires: Math.min(5 * 60, remainingSeconds), ...(disposition === "attachment" ? { filename: task.output.filename } : {}) });
    return c.redirect(url, 302);
  });

  app.get("/api/v1/desktop/agent/tools/minimax-h3-shared", async (c) => {
    const auth = await authenticate(c, { scopes: ["tasks:read"] }); if (auth.error) return auth.error;
    const wallet = await (await getCollection("wallets")).findOne({ ownerId: new ObjectId(auth.user.id) });
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      tool: {
        id: H3_SHARED_MODEL,
        name: "MiniMax H3 共享节点",
        sourceChannel: "desktop_agent",
        createTask: { method: "POST", url: "/api/h3/tasks", scope: "tasks:write" },
        assetUpload: { presign: "/api/h3/assets/presign", complete: "/api/h3/assets/{asset_id}/complete", scope: "tasks:write" },
        promptProcessing: { mode: "requester_choice", enableField: "prompt_optimization_enabled", defaultEnabledForLegacyClients: true, inputField: "prompt", preserveOriginal: true, optimizationWorkerCapability: "local_prompt_optimization_v1" },
        generationParameters: { videoModes: [...H3_VIDEO_MODES], longformModes: [...H3_LONGFORM_MODES], segmentDurationSeconds: { min: 5, max: 15 }, aspectRatios: [...H3_VIDEO_ASPECTS], resolutions: [{ label: "720P", profile: "official_max" }, { label: "1080P", profile: "ultra1080" }, { label: "2K极速", profile: "fast2k" }], samplingSteps: [...H3_SAMPLING_STEPS], seed: { min: -1, max: 2_147_483_647, randomValue: -1 } },
        limits: { durationSeconds: { min: 1, max: H3_MAX_DURATION_SECONDS }, websiteDurationSeconds: { min: 1, max: 15 }, imageCount: 9, videoCount: 3, audioCount: 3 },
        pricingFen: { perSecond: 20, perImage: 5, perVideo: 20, perAudio: 0 },
      },
      wallet: { balanceFen: integer(wallet?.balanceFen), unlimited: auth.user.role === "admin" },
    });
  });

  app.post("/api/h3/tasks/claim", async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const body = await c.req.json().catch(() => ({}));
    const nodeId = String(body.node_id || "").trim();
    const auth = await authenticateBinding(c, { requireNodeId: nodeId, touch: false }); if (auth.error) return auth.error;
    let reportedCapabilities;
    try { reportedCapabilities = normalizeH3NodeCapabilities(body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {}); }
    catch (error) { return routeError(c, error); }
    const now = new Date();
    const nodeName = String(body.node_name || auth.binding.nodeName || "").slice(0, 120);
    const heartbeat = { nodeName, lastSeenAt: now, lastUsedAt: now, queueStatus: body.dry_run === true ? "reachable" : "polling", capabilities: reportedCapabilities, updatedAt: now };
    if (body.dry_run !== true && auth.binding.nextClaimAt && new Date(auth.binding.nextClaimAt) > now) {
      const retryAfterMs = Math.max(250, new Date(auth.binding.nextClaimAt).getTime() - now.getTime());
      if (!auth.binding.lastSeenAt || now.getTime() - new Date(auth.binding.lastSeenAt).getTime() >= 30_000) {
        await (await getCollection("nodeAccountBindings")).updateOne({ _id: auth.binding._id, userId: auth.user._id, status: "active" }, { $set: heartbeat });
      }
      c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
      return c.json({
        task: null,
        additional_tasks: [],
        claim_plan: {
          ...(auth.binding.lastClaimPlan || {}),
          scheduling: auth.binding.lastClaimPlan?.scheduling || "fifo_least_estimated_lan_load",
          throttled: true,
          assigned_count: 0,
          poll_after_ms: retryAfterMs,
        },
      });
    }
    const rate = await enforceRateLimit(`h3-claim:${auth.binding._id}`, { limit: 60, windowMs: 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "任务领取请求过于频繁，请遵循响应中的 poll_after_ms" }, 429);
    await (await getCollection("nodeAccountBindings")).updateOne(
      { _id: auth.binding._id, userId: auth.user._id, status: "active" },
      { $set: heartbeat },
    );
    if (body.dry_run === true) return c.json({ ok: true, service: "gulong-h3-shared", queue: "reachable" });
    await cancelTimedOutH3Tasks({ getCollection, notifyUserOnce: notifyOnce, now, limit: 100 }).catch(() => {});
    const tasks = await getCollection("h3SharedTasks");
    let queueSnapshot;
    try {
      queueSnapshot = await queueCoordinator.snapshot(now);
    } catch {
      queueSnapshot = { cached: false, queuedCount: 1, activeNodeCount: 1, oldestQueuedAt: null, cacheAgeMs: null, stale: true };
    }
    const clusterPayload = body.lan_cluster && typeof body.lan_cluster === "object" ? body.lan_cluster : null;
    const rawClusterNodes = Array.isArray(clusterPayload?.nodes) ? clusterPayload.nodes : Array.isArray(body.lan_nodes) ? body.lan_nodes : null;
    const clusterId = String(clusterPayload?.cluster_id || body.lan_cluster_id || "").trim();
    const explicitLanReport = Boolean(rawClusterNodes);
    let clusterNodes;
    if (explicitLanReport) {
      if (!/^[A-Za-z0-9._:-]{12,160}$/.test(clusterId) || rawClusterNodes.length < 1 || rawClusterNodes.length > H3_LAN_REPORT_MAX_NODES) {
        return c.json({ code: "INVALID_LAN_CLUSTER_REPORT", message: `局域网负载报告必须提供稳定匿名 cluster_id，并包含 1–${H3_LAN_REPORT_MAX_NODES} 个节点` }, 400);
      }
      const observedAt = new Date(clusterPayload?.observed_at || body.lan_observed_at || now);
      if (Number.isNaN(observedAt.getTime()) || Math.abs(now.getTime() - observedAt.getTime()) > 2 * 60_000) {
        return c.json({ code: "STALE_LAN_CLUSTER_REPORT", message: "局域网负载报告已过期，请刷新全部节点状态后重试" }, 400);
      }
      const normalizedReports = [];
      const seenNodeIds = new Set();
      try {
        for (const report of rawClusterNodes) {
          const reportedNodeId = String(report?.node_id || "").trim();
          if (!/^[A-Za-z0-9._:-]{12,160}$/.test(reportedNodeId) || seenNodeIds.has(reportedNodeId)) throw Object.assign(new Error("局域网节点 ID 无效或重复"), { code: "INVALID_LAN_CLUSTER_REPORT", status: 400 });
          seenNodeIds.add(reportedNodeId);
          const nodeCapabilities = normalizeH3NodeCapabilities(report.capabilities || (reportedNodeId === auth.binding.nodeId ? body.capabilities : {}));
          normalizedReports.push({
            nodeId: reportedNodeId,
            nodeName: String(report.node_name || "").trim().slice(0, 120),
            runningTaskCount: Math.max(0, integer(report.running_task_count)),
            estimatedTotalSeconds: Math.max(0, integer(report.estimated_total_seconds ?? report.estimated_remaining_seconds)),
            capabilities: nodeCapabilities,
            available: report.available !== false,
          });
        }
      } catch (error) { return routeError(c, error); }
      if (!seenNodeIds.has(auth.binding.nodeId)) return c.json({ code: "CALLER_MISSING_FROM_LAN_REPORT", message: "局域网负载报告必须包含当前轮询节点" }, 400);
      const bindingRecords = await (await getCollection("nodeAccountBindings")).find({ userId: auth.user._id, nodeId: { $in: [...seenNodeIds] }, status: "active", revokedAt: null }).toArray();
      const bindingByNodeId = new Map(bindingRecords.map((binding) => [binding.nodeId, binding]));
      if (bindingByNodeId.size !== seenNodeIds.size) return c.json({ code: "LAN_NODE_NOT_BOUND", message: "局域网负载报告包含未绑定到当前账号的节点" }, 403);
      clusterNodes = normalizedReports.map((report) => ({
        ...report,
        binding: bindingByNodeId.get(report.nodeId),
        runningTaskCount: report.available ? report.runningTaskCount : report.capabilities.maxConcurrentTasks,
      }));
    } else {
      clusterNodes = [{
        nodeId: auth.binding.nodeId,
        nodeName,
        binding: auth.binding,
        runningTaskCount: 0,
        estimatedTotalSeconds: 0,
        capabilities: reportedCapabilities,
        available: true,
      }];
    }
    let clusterLease = null;
    if (explicitLanReport) {
      const states = await getCollection("h3LanClusterStates");
      const stateId = createHash("sha256").update(`${auth.user._id}:${clusterId}`).digest("hex");
      await states.updateOne(
        { _id: stateId },
        { $setOnInsert: { _id: stateId, userId: auth.user._id, clusterIdHash: createHash("sha256").update(clusterId).digest("hex"), nextClaimAt: new Date(0), createdAt: now } },
        { upsert: true },
      );
      const leaseOwner = randomBytes(12).toString("hex");
      const acquired = await states.findOneAndUpdate(
        {
          _id: stateId,
          nextClaimAt: { $lte: now },
          $or: [{ claimLeaseUntil: { $exists: false } }, { claimLeaseUntil: null }, { claimLeaseUntil: { $lte: now } }],
        },
        { $set: { claimLeaseOwner: leaseOwner, claimLeaseUntil: new Date(now.getTime() + 5_000), lastPollingBindingId: auth.binding._id, observedAt: now, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!acquired || acquired.claimLeaseOwner !== leaseOwner) {
        const current = await states.findOne({ _id: stateId });
        const retryAfterMs = Math.max(500, Math.min(30_000, new Date(current?.nextClaimAt || now.getTime() + 1_000).getTime() - now.getTime() || 1_000));
        c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
        return c.json({
          task: null,
          additional_tasks: [],
          claim_plan: {
            ...(current?.lastClaimPlan || {}),
            scheduling: "fifo_least_estimated_lan_load",
            lan_protocol: "lan-load-v1",
            cluster_throttled: true,
            assigned_count: 0,
            poll_after_ms: retryAfterMs,
          },
        });
      }
      clusterLease = { states, stateId, leaseOwner };
    }
    const bindingIds = clusterNodes.map((node) => node.binding._id);
    const activeAssignments = await tasks.find({
      status: { $in: ["claimed", "processing"] },
      "claimedByNode.bindingId": { $in: bindingIds },
      claimLeaseUntil: { $gt: now },
    }).limit(512).toArray();
    const authoritativeLoad = new Map();
    for (const activeTask of activeAssignments) {
      const bindingId = idText(activeTask.claimedByNode?.bindingId);
      if (!bindingId) continue;
      const current = authoritativeLoad.get(bindingId) || { runningTaskCount: 0, estimatedTotalSeconds: 0 };
      current.runningTaskCount += 1;
      current.estimatedTotalSeconds += Math.max(0, integer(activeTask.remainingSeconds || activeTask.estimatedTotalSeconds || activeTask.dispatchEstimatedTotalSeconds));
      authoritativeLoad.set(bindingId, current);
    }
    clusterNodes = clusterNodes.map((node) => {
      const serverLoad = authoritativeLoad.get(idText(node.binding._id));
      if (!serverLoad) return node;
      return {
        ...node,
        runningTaskCount: Math.max(node.runningTaskCount, serverLoad.runningTaskCount),
        estimatedTotalSeconds: Math.max(node.estimatedTotalSeconds, serverLoad.estimatedTotalSeconds),
      };
    });
    clusterNodes = rankH3LanNodes(clusterNodes);
    const clusterRunningTaskCount = clusterNodes.reduce((sum, node) => sum + node.runningTaskCount, 0);
    const clusterCapacity = clusterNodes.reduce((sum, node) => sum + node.capabilities.maxConcurrentTasks, 0);
    const claimPlan = calculateH3ClaimPlan({
      queuedCount: queueSnapshot.queuedCount,
      activeNodeCount: Math.max(queueSnapshot.activeNodeCount, clusterNodes.length),
      activeTaskCount: clusterRunningTaskCount,
      maxConcurrentTasks: clusterCapacity,
      batchCapable: explicitLanReport || reportedCapabilities.batchCapable,
      jitterSeed: clusterId || auth.binding.nodeId,
    });
    const dispatcherNode = { nodeId: auth.binding.nodeId, nodeName, bindingId: auth.binding._id, userId: auth.user._id, at: now };
    const claimed = [];
    try {
      for (let index = 0; index < claimPlan.recommendedBatchSize; index += 1) {
        const oldestCandidates = await tasks.find({ status: "queued", model: H3_SHARED_MODEL }).sort({ createdAt: 1, _id: 1 }).limit(100).toArray();
        let selectedTask = null;
        let selectedNode = null;
        for (const candidate of oldestCandidates) {
          const eligibleNodes = rankH3LanNodes(clusterNodes).filter((node) => h3NodeCanRunTask(node, candidate));
          if (!eligibleNodes.length) continue;
          for (const candidateNode of eligibleNodes) {
            const assignedNode = { nodeId: candidateNode.nodeId, nodeName: candidateNode.nodeName || candidateNode.binding.nodeName || null, bindingId: candidateNode.binding._id, userId: candidateNode.binding.userId, at: now, capabilities: candidateNode.capabilities };
            const claimedTask = await tasks.findOneAndUpdate(
              { _id: candidate._id, status: "queued", model: H3_SHARED_MODEL },
              { $set: { status: "claimed", claimedByNode: assignedNode, claimRequestedByNode: dispatcherNode, claimedAt: now, claimLeaseUntil: new Date(now.getTime() + H3_CLAIM_LEASE_MS), updatedAt: now } },
              { returnDocument: "after" },
            );
            if (!claimedTask) continue;
            selectedTask = claimedTask;
            selectedNode = clusterNodes.find((node) => node.nodeId === candidateNode.nodeId) || candidateNode;
            break;
          }
          if (selectedTask) break;
        }
        if (!selectedTask || !selectedNode) break;
        selectedNode.runningTaskCount += 1;
        selectedNode.estimatedTotalSeconds += Math.max(1, integer(selectedTask.dispatchEstimatedTotalSeconds || selectedTask.estimatedTotalSeconds, estimateH3TaskTotalSeconds(selectedTask)));
        const targetAuth = { binding: selectedNode.binding, user: auth.user };
        const entry = { task: selectedTask, outputUpload: null, selectedNode };
        claimed.push(entry);
        entry.outputUpload = await issueOutputUpload(selectedTask, targetAuth, now);
      }
    } catch (error) {
      const taskIds = claimed.map((entry) => entry.task._id);
      if (taskIds.length) {
        await Promise.allSettled([
          tasks.updateMany(
            { _id: { $in: taskIds }, status: "claimed", "claimRequestedByNode.bindingId": auth.binding._id, claimedAt: now },
            { $set: { status: "queued", queuedAt: now, updatedAt: new Date(), error: { code: "OUTPUT_UPLOAD_TICKET_FAILED", message: "输出直传票据签发失败" } }, $unset: { claimedByNode: "", claimRequestedByNode: "", claimedAt: "", claimLeaseUntil: "" } },
          ),
          (await getCollection("h3OutputUploads")).updateMany(
            { taskId: { $in: taskIds }, status: "issued", createdAt: now },
            { $set: { status: "expired", expiredAt: new Date(), updatedAt: new Date() }, $unset: { expiresAt: "" } },
          ),
          queueCoordinator.invalidate(),
        ]);
      }
      throw error;
    }
    const assignedCount = claimed.length;
    const pollAfterMs = assignedCount === 0 && claimPlan.recommendedBatchSize > 0 ? Math.max(5_000, claimPlan.pollAfterMs) : claimPlan.pollAfterMs;
    const nextClaimAt = new Date(now.getTime() + pollAfterMs);
    const publicPlan = {
      scheduling: "fifo_least_estimated_lan_load",
      lan_protocol: explicitLanReport ? "lan-load-v1" : "legacy-single-node",
      lan_cluster_id_hash: explicitLanReport ? createHash("sha256").update(clusterId).digest("hex") : null,
      reported_node_count: clusterNodes.length,
      queue_snapshot_cached: queueSnapshot.cached !== false,
      queue_snapshot_stale: Boolean(queueSnapshot.stale),
      queued_count: Math.max(0, queueSnapshot.queuedCount - assignedCount),
      active_node_count: queueSnapshot.activeNodeCount,
      active_task_count: clusterRunningTaskCount + assignedCount,
      available_slots: Math.max(0, claimPlan.availableSlots - assignedCount),
      recommended_batch_size: claimPlan.recommendedBatchSize,
      assigned_count: assignedCount,
      max_concurrent_tasks: clusterCapacity,
      poll_after_ms: pollAfterMs,
      oldest_queued_at: queueSnapshot.oldestQueuedAt?.toISOString?.() || null,
      cache_age_ms: queueSnapshot.cacheAgeMs,
    };
    await (await getCollection("nodeAccountBindings")).updateOne(
      { _id: auth.binding._id },
      { $set: { queueStatus: claimed.some((entry) => idText(entry.selectedNode.binding._id) === idText(auth.binding._id)) ? "processing" : assignedCount ? "dispatching" : "idle", nextClaimAt, lastClaimPlan: publicPlan, ...(assignedCount ? { lastClaimedAt: now } : {}), updatedAt: new Date() } },
    );
    await Promise.all(claimed
      .filter((entry) => idText(entry.selectedNode.binding._id) !== idText(auth.binding._id))
      .map((entry) => (getCollection("nodeAccountBindings")).then((bindings) => bindings.updateOne(
        { _id: entry.selectedNode.binding._id, userId: auth.user._id, status: "active" },
        { $set: { queueStatus: "processing", lastClaimedAt: now, lastSeenAt: now, updatedAt: new Date() } },
      ))));
    if (clusterLease) {
      await clusterLease.states.updateOne(
        { _id: clusterLease.stateId, claimLeaseOwner: clusterLease.leaseOwner },
        { $set: { nextClaimAt, lastClaimPlan: publicPlan, updatedAt: new Date() }, $unset: { claimLeaseOwner: "", claimLeaseUntil: "" } },
      );
    }
    c.header("Retry-After", String(Math.max(1, Math.ceil(pollAfterMs / 1_000))));
    await audit(await getCollection("h3TaskAudits"), assignedCount ? "claimed" : "claim_empty", { taskId: claimed[0]?.task?._id || null, taskIds: claimed.map((entry) => entry.task._id), assignedNodeIds: claimed.map((entry) => entry.selectedNode.nodeId), lanLoad: clusterNodes.map((entry) => ({ nodeId: entry.nodeId, runningTaskCount: entry.runningTaskCount, estimatedTotalSeconds: entry.estimatedTotalSeconds })), actorUserId: auth.user._id, bindingId: auth.binding._id, nodeId: auth.binding.nodeId, capabilities: reportedCapabilities, claimPlan: publicPlan, reportedEmail: String(body.bound_account_email || "").slice(0, 254), reportedUserId: String(body.bound_account_id || "").slice(0, 80) });
    const workerTasks = claimed.map(({ task, outputUpload }) => toH3WorkerTask(task, { assets: claimAssets(task.assets), outputUpload }));
    return c.json({ task: workerTasks[0] || null, additional_tasks: workerTasks.slice(1), claim_plan: publicPlan });
  });

  app.post("/api/h3/tasks/callback", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ code: "VALIDATION_ERROR", message: "回调必须使用 multipart/form-data" }, 400);
    let metadata;
    try { metadata = JSON.parse(String(form.get("metadata") || "{}")); }
    catch { return c.json({ code: "VALIDATION_ERROR", message: "metadata 必须是有效 JSON" }, 400); }
    const directVideo = form.get("video");
    if (directVideo && typeof directVideo === "object" && Number(directVideo.size || 0) > 0) return c.json({ code: "DIRECT_VIDEO_UPLOAD_DISABLED", message: "大视频不能经过 Vercel 回调请求体；请使用 claim 返回的 output_upload 票据直传腾讯云 COS" }, 413);
    const nodeId = String(metadata.node_id || "").trim();
    const auth = await authenticateBinding(c, { requireNodeId: nodeId }); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`h3-callback:${auth.binding._id}`, { limit: 180, windowMs: 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "任务回调过于频繁" }, 429);
    const taskId = String(metadata.task_id || "").trim();
    const filter = ObjectId.isValid(taskId) ? { _id: new ObjectId(taskId) } : { orderNo: taskId };
    const tasks = await getCollection("h3SharedTasks");
    let task = await tasks.findOne(filter);
    if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "共享节点任务不存在" }, 404);
    if (["queued", "claimed", "processing"].includes(task.status) && task.autoCancelAt && new Date(task.autoCancelAt) <= new Date()) {
      await cancelTimedOutH3Tasks({ getCollection, notifyUserOnce: notifyOnce, limit: 100 }).catch(() => {});
      task = await tasks.findOne(filter);
      if (task?.status === "cancelled" && task?.error?.code === H3_TIMEOUT_ERROR.code) {
        return c.json({ code: H3_TIMEOUT_ERROR.code, message: H3_TIMEOUT_ERROR.message }, 409);
      }
    }
    if (task.claimedByNode?.bindingId && idText(task.claimedByNode.bindingId) !== idText(auth.binding._id)) {
      return c.json({ code: "TASK_ASSIGNED_TO_ANOTHER_NODE", message: "该任务已由调度器分配给其他局域网节点，请由响应 assigned_node 指定的节点执行和回调" }, 409);
    }
    const status = String(metadata.status || "").trim().toLowerCase();
    if (!["optimizing", "started", "processing", "progress", "completed", "succeeded", "failed", "cancelled"].includes(status)) return c.json({ code: "VALIDATION_ERROR", message: "回调状态不正确" }, 400);
    const eventKey = h3CallbackEventKey(task._id, metadata);
    const now = new Date();
    await (await getCollection("h3TaskCallbacks")).updateOne(
      { eventKey },
      { $setOnInsert: { eventKey, taskId: task._id, orderNo: task.orderNo, status, event: String(metadata.event || status), localJobId: String(metadata.local_job_id || "").slice(0, 160), bindingId: auth.binding._id, executorUserId: auth.user._id, metadata, createdAt: now }, $set: { lastReceivedAt: now } },
      { upsert: true },
    );
    const executionNode = { nodeId: auth.binding.nodeId, nodeName: String(metadata.node_name || auth.binding.nodeName || "").slice(0, 120), bindingId: auth.binding._id, at: now };
    const heartbeat = { nodeName: executionNode.nodeName, lastSeenAt: now, lastCallbackAt: now, queueStatus: ["optimizing", "started", "processing", "progress"].includes(status) ? "processing" : "idle", updatedAt: now };
    if (["completed", "succeeded"].includes(status)) heartbeat.lastCompletedAt = now;
    await (await getCollection("nodeAccountBindings")).updateOne({ _id: auth.binding._id, userId: auth.user._id, status: "active" }, { $set: heartbeat });
    if (["completed", "succeeded"].includes(status) && task.status === "completed") {
      await ensureH3ConversationMessages({ getCollection, task, now });
      return c.json({ ok: true, idempotent: true, task: workerCallbackTask(task) });
    }
    const promptOptimizationEnabled = task.promptOptimizationEnabled !== false && task.localPromptOptimizationRequired !== false;
    const suppliedCompiledPrompt = String(metadata.compiled_prompt || metadata.compiledPrompt || "").trim();
    if (!promptOptimizationEnabled && suppliedCompiledPrompt) {
      return c.json({ code: "PROMPT_OPTIMIZATION_DISABLED", message: "用户未开启魔法提示词优化，不能提交 compiled_prompt" }, 400);
    }
    if (status === "optimizing") {
      if (!promptOptimizationEnabled) {
        return c.json({ code: "PROMPT_OPTIMIZATION_DISABLED", message: "用户未开启魔法提示词优化，请直接使用原始提示词生成视频" }, 409);
      }
      task = await tasks.findOneAndUpdate(
        { _id: task._id, status: { $in: ["claimed", "processing"] }, promptOptimizationEnabled: { $ne: false }, localPromptOptimizationRequired: { $ne: false } },
        { $set: { promptOptimizationEnabled: true, localPromptOptimizationRequired: true, promptMode: "desktop_local_magic_v1", status: "processing", executedByNode: executionNode, progress: Math.max(1, integer(metadata.progress, 1)), progressStage: "prompt_optimization", progressUpdatedAt: now, claimLeaseUntil: new Date(now.getTime() + H3_CLAIM_LEASE_MS), updatedAt: now } },
        { returnDocument: "after" },
      ) || task;
      return c.json({ ok: true, idempotent: H3_TERMINAL_STATUSES.has(task.status), task: workerCallbackTask(task) });
    }
    if (["started", "processing", "progress"].includes(status)) {
      if (promptOptimizationEnabled && status === "started" && (!suppliedCompiledPrompt || suppliedCompiledPrompt.length > 20_000)) {
        return c.json({ code: "LOCAL_PROMPT_OPTIMIZATION_REQUIRED", message: "本任务必须先由桌面端完成本地魔法优化，并在 started 回调中提供 compiled_prompt" }, 400);
      }
      if (promptOptimizationEnabled && status !== "started" && !task.compiledPrompt) {
        return c.json({ code: "LOCAL_PROMPT_OPTIMIZATION_REQUIRED", message: "尚未收到桌面端本地魔法优化结果，不能上报视频生成进度" }, 409);
      }
      const normalizedProgress = normalizeH3ProgressCallback(task, metadata);
      if (normalizedProgress.error) return c.json(normalizedProgress.error, 400);
      const { progress, estimatedTotalSeconds, remainingSeconds } = normalizedProgress;
      const timeoutEstimate = Math.max(integer(task.dispatchEstimatedTotalSeconds), estimatedTotalSeconds);
      const autoCancelAt = h3TaskAutoCancelAt(task.createdAt, timeoutEstimate);
      const promptOptimization = metadata.prompt_optimization && typeof metadata.prompt_optimization === "object" ? metadata.prompt_optimization : {};
      const promptCompilation = suppliedCompiledPrompt ? {
        mode: "desktop_local_magic_v1",
        source: "execution_node",
        validated: true,
        status: "completed",
        engine: String(promptOptimization.engine || metadata.prompt_engine || "local-prompt-engine").slice(0, 120),
        engineVersion: String(promptOptimization.version || metadata.prompt_engine_version || "").slice(0, 80) || null,
        elapsedSeconds: Math.max(0, Number(promptOptimization.elapsed_seconds || metadata.prompt_optimization_elapsed_seconds || 0)),
        completedAt: now,
      } : task.promptCompilation;
      task = await tasks.findOneAndUpdate(
        { _id: task._id, status: { $in: ["claimed", "processing"] } },
        { $set: { status: "processing", executedByNode: executionNode, progress, progressStage: "video_generation", ...(suppliedCompiledPrompt ? { compiledPrompt: suppliedCompiledPrompt, promptCompilation } : {}), ...(estimatedTotalSeconds > 0 ? { estimatedTotalSeconds, autoCancelAt } : {}), ...(remainingSeconds > 0 ? { remainingSeconds, expectedCompletedAt: new Date(now.getTime() + remainingSeconds * 1_000) } : {}), progressUpdatedAt: now, claimLeaseUntil: new Date(now.getTime() + H3_CLAIM_LEASE_MS), updatedAt: now } },
        { returnDocument: "after" },
      ) || task;
      return c.json({ ok: true, idempotent: H3_TERMINAL_STATUSES.has(task.status), task: workerCallbackTask(task) });
    }
    if (["completed", "succeeded"].includes(status)) {
      if (promptOptimizationEnabled && !task.compiledPrompt) return c.json({ code: "LOCAL_PROMPT_OPTIMIZATION_REQUIRED", message: "缺少桌面端本地魔法优化结果，不能完成任务" }, 409);
      const video = metadata.video && typeof metadata.video === "object" ? metadata.video : {};
      const sha256 = String(video.sha256 || metadata["video.sha256"] || "").trim().toUpperCase();
      const bytes = integer(video.bytes ?? metadata["video.bytes"], -1);
      const filename = String(video.filename || metadata["video.filename"] || "").trim().slice(0, 240);
      const objectKey = String(video.object_key || video.objectKey || metadata.output_object_key || "").trim().slice(0, 1_000);
      if (!/^[A-F0-9]{64}$/.test(sha256) || bytes < 1 || !filename || !objectKey) return c.json({ code: "INVALID_OUTPUT_RECEIPT", message: "成功回调必须提供视频 sha256、bytes、filename 与任务专属 COS 对象键" }, 400);
      const taskPrefix = `h3/tasks/${task._id}/outputs/`;
      if (!objectKey.startsWith(taskPrefix) || objectKey.includes("..")) return c.json({ code: "OUTPUT_OBJECT_FORBIDDEN", message: "输出对象不属于当前任务" }, 403);
      const uploads = await getCollection("h3OutputUploads");
      const grant = await uploads.findOne({ taskId: task._id, objectKey, issuedToBindingId: auth.binding._id, status: { $in: ["issued", "completed"] } });
      if (!grant) return c.json({ code: "OUTPUT_UPLOAD_GRANT_NOT_FOUND", message: "输出直传票据不存在或不属于当前任务" }, 409);
      if (grant.status !== "completed" && grant.expiresAt <= now) return c.json({ code: "OUTPUT_UPLOAD_GRANT_EXPIRED", message: "输出直传票据已过期，请重新领取任务" }, 409);
      let head;
      try { head = await inspectCosObject(objectKey); }
      catch { return c.json({ code: "OUTPUT_OBJECT_NOT_FOUND", message: "腾讯云 COS 中尚未找到输出视频" }, 409); }
      const actualBytes = objectBytes(head);
      const storedSha256 = objectHeader(head, "x-cos-meta-sha256").trim().toUpperCase();
      const storedBytes = integer(objectHeader(head, "x-cos-meta-bytes"), -1);
      const storedTaskId = objectHeader(head, "x-cos-meta-h3-task-id").trim();
      const storedGrantId = objectHeader(head, "x-cos-meta-h3-upload-grant").trim();
      if (actualBytes !== bytes || storedBytes !== bytes || storedSha256 !== sha256 || storedTaskId !== task._id.toString() || storedGrantId !== grant.grantId) {
        await Promise.allSettled([removeCosObject(objectKey), uploads.updateOne({ _id: grant._id }, { $set: { status: "rejected", error: "OUTPUT_RECEIPT_MISMATCH", rejectedAt: now, updatedAt: now } })]);
        return c.json({ code: "OUTPUT_RECEIPT_MISMATCH", message: "COS 输出对象的大小、SHA-256 或任务归属校验失败" }, 409);
      }
      await uploads.updateOne({ _id: grant._id, status: "issued" }, { $set: { status: "completed", sha256, bytes, filename, completedByBindingId: auth.binding._id, completedByNodeId: auth.binding.nodeId, completedAt: now, updatedAt: now }, $unset: { expiresAt: "" } });
      const completed = await tasks.findOneAndUpdate(
        { _id: task._id, status: { $in: ["claimed", "processing"] } },
        { $set: { status: "completed", progress: 100, progressStage: "completed", remainingSeconds: 0, progressUpdatedAt: now, chargeStatus: ["exempt", "package_no_charge"].includes(task.chargeStatus) ? task.chargeStatus : "settled", executedByNode: executionNode, assigneeUserId: auth.user._id, assigneeEmailSnapshot: auth.user.email || auth.binding.emailSnapshot, assigneeDisplayNameSnapshot: auth.user.displayName || auth.user.username || null, output: { sha256, bytes, filename, objectKey, uploadGrantId: grant.grantId, expiresAt: h3OutputExpiresAt(now), status: "available", cleanupStatus: "pending", cleanupAttempts: 0 }, elapsedSeconds: Math.max(0, Number(metadata.elapsed_seconds || 0)), completedAt: now, updatedAt: now } },
        { returnDocument: "after" },
      );
      task = completed || await tasks.findOne({ _id: task._id });
      if (task.status === "completed" && !["exempt", "package_no_charge"].includes(task.chargeStatus)) await (await getCollection("h3WalletLedger")).updateOne({ ledgerKey: task.activeChargeKey }, { $set: { status: "settled", settledAt: task.completedAt || now, updatedAt: now } });
      if (task.status === "completed") task = await settleH3Revenue({ getCollection, task, executorUserId: task.assigneeUserId || auth.user._id });
      if (task.status === "completed") await ensureH3ConversationMessages({ getCollection, task, now });
      await (await getCollection("nodeAccountBindings")).updateOne({ _id: auth.binding._id }, { $unset: { nextClaimAt: "" }, $set: { queueStatus: "idle", updatedAt: new Date() } });
      await audit(await getCollection("h3TaskAudits"), completed ? "completed" : "callback_replayed", { taskId: task._id, orderNo: task.orderNo, actorUserId: auth.user._id, bindingId: auth.binding._id, nodeId: auth.binding.nodeId, eventKey });
      return c.json({ ok: true, idempotent: !completed, task: workerCallbackTask(task) });
    }
    const failed = await tasks.findOneAndUpdate(
      { _id: task._id, status: { $in: ["claimed", "processing", "queued"] } },
      { $set: { status: status === "cancelled" ? "cancelled" : "failed", progressStage: status === "cancelled" ? "cancelled" : "failed", revenueStatus: "not_earned", executedByNode: executionNode, error: { code: String(metadata.error_code || "NODE_EXECUTION_FAILED").slice(0, 80), message: localizeErrorMessage(metadata.error_message, "共享节点执行失败").slice(0, 500) }, ...(status === "cancelled" ? { cancelledAt: now } : { failedAt: now }), updatedAt: now } },
      { returnDocument: "after" },
    );
    task = failed || await tasks.findOne({ _id: task._id });
    if (failed) task = await refundTask({ getCollection, task, reason: task.error?.message, actor: `binding:${auth.binding._id}` });
    await (await getCollection("nodeAccountBindings")).updateOne({ _id: auth.binding._id }, { $unset: { nextClaimAt: "" }, $set: { queueStatus: "idle", updatedAt: new Date() } });
    await audit(await getCollection("h3TaskAudits"), failed ? task.status : "callback_replayed", { taskId: task._id, orderNo: task.orderNo, actorUserId: auth.user._id, bindingId: auth.binding._id, nodeId: auth.binding.nodeId, eventKey });
    return c.json({ ok: true, idempotent: !failed, task: workerCallbackTask(task) });
  });

  app.get("/api/admin/h3/tasks", async (c) => {
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    await cancelTimedOutH3Tasks({ getCollection, notifyUserOnce: notifyOnce, limit: 200 }).catch(() => {});
    const filter = {};
    const status = String(c.req.query("status") || "").trim();
    const source = String(c.req.query("source") || "").trim();
    const assignee = String(c.req.query("assignee") || "").trim();
    const q = String(c.req.query("q") || "").trim().slice(0, 160);
    if (status) filter.status = status;
    if (["website", "desktop_agent"].includes(source)) filter.sourceChannel = source;
    if (assignee) filter.assigneeEmailSnapshot = { $regex: escapedRegex(assignee), $options: "i" };
    if (q) filter.$or = [{ orderNo: { $regex: escapedRegex(q), $options: "i" } }, { requesterEmailSnapshot: { $regex: escapedRegex(q), $options: "i" } }, { assigneeEmailSnapshot: { $regex: escapedRegex(q), $options: "i" } }, { prompt: { $regex: escapedRegex(q), $options: "i" } }, { originalPrompt: { $regex: escapedRegex(q), $options: "i" } }];
    const from = c.req.query("from") ? new Date(c.req.query("from")) : null;
    const to = c.req.query("to") ? new Date(`${c.req.query("to")}T23:59:59.999Z`) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) filter.createdAt = { ...(from && !Number.isNaN(from.getTime()) ? { $gte: from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { $lte: to } : {}) };
    const collection = await getCollection("h3SharedTasks");
    const [tasks, total] = await Promise.all([collection.find(filter).sort({ createdAt: -1 }).limit(200).toArray(), collection.countDocuments(filter)]);
    return c.json({ tasks: tasks.map((task) => publicTask(task)), total });
  });

  app.get("/api/admin/h3/tasks/:id", async (c) => {
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const id = c.req.param("id");
    const task = await (await getCollection("h3SharedTasks")).findOne(ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { orderNo: id });
    if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "共享节点任务不存在" }, 404);
    const [callbacks, audits] = await Promise.all([(await getCollection("h3TaskCallbacks")).find({ taskId: task._id }).sort({ createdAt: 1 }).toArray(), (await getCollection("h3TaskAudits")).find({ taskId: task._id }).sort({ createdAt: 1 }).toArray()]);
    return c.json({ task: publicTask(task), callbacks: callbacks.map((item) => ({ id: item._id.toString(), status: item.status, event: item.event, localJobId: item.localJobId, createdAt: item.createdAt })), audits: audits.map((item) => ({ id: item._id.toString(), event: item.event, createdAt: item.createdAt })) });
  });

  app.post("/api/admin/h3/tasks/:id/cancel", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const id = c.req.param("id");
    const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { orderNo: id };
    const tasks = await getCollection("h3SharedTasks");
    let task = await tasks.findOneAndUpdate({ ...filter, status: { $in: ["queued", "claimed", "processing", "failed"] } }, { $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: new ObjectId(auth.user.id), updatedAt: new Date() } }, { returnDocument: "after" });
    if (!task) {
      task = await tasks.findOne(filter);
      if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "共享节点任务不存在" }, 404);
      if (task.status === "completed") return c.json({ code: "TASK_ALREADY_COMPLETED", message: "已完成任务不能取消" }, 409);
    }
    task = await refundTask({ getCollection, task, reason: "管理员取消任务", actor: `admin:${auth.user.id}` });
    await audit(await getCollection("h3TaskAudits"), "admin_cancelled", { taskId: task._id, orderNo: task.orderNo, actorUserId: new ObjectId(auth.user.id) });
    return c.json({ task: publicTask(task) });
  });

  app.post("/api/admin/h3/tasks/:id/retry", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const id = c.req.param("id");
    const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { orderNo: id };
    const tasks = await getCollection("h3SharedTasks");
    const task = await tasks.findOne(filter);
    if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "共享节点任务不存在" }, 404);
    const exempt = task.chargeStatus === "exempt" || await h3RequesterIsAdministrator(getCollection, task);
    const packageNoCharge = task.billingMode === "short_video_package" && task.chargeStatus === "package_no_charge";
    if (!["failed", "cancelled"].includes(task.status) || (!exempt && !packageNoCharge && task.refundStatus !== "refunded")) return c.json({ code: "TASK_NOT_RETRYABLE", message: "只有免扣费任务、套餐零扣费任务或已经退款的失败、取消任务可以重试" }, 409);
    const retryCount = integer(task.retryCount) + 1;
    const chargeKey = `h3:charge:${task.orderNo}:${retryCount}`;
    let retryBilling = { chargeStatus: "exempt", revenueStatus: "exempt", chargedFen: 0, billingMode: "administrator_exempt" };
    if (!exempt) {
      const packageReservation = await reserveShortVideoPackageAllowance({ getCollection, ownerId: task.requesterUserId, amountFen: task.priceFen, ledgerKey: chargeKey, orderNo: task.orderNo, taskId: task._id });
      if (packageReservation.matched) {
        const chargedFen = integer(packageReservation.chargedFen);
        retryBilling = { chargeStatus: chargedFen > 0 ? "reserved" : "package_no_charge", revenueStatus: chargedFen > 0 ? "pending" : "not_earned", chargedFen, billingMode: "short_video_package" };
      } else {
        const reserved = await reserveH3Wallet({ getCollection, ownerId: task.requesterUserId, amountFen: task.priceFen, ledgerKey: chargeKey, orderNo: task.orderNo, taskId: task._id, kind: "h3_retry_reservation" });
        if (!reserved) return c.json({ code: "INSUFFICIENT_BALANCE", message: "需求用户余额不足，无法重新派单", requiredFen: task.priceFen }, 402);
        retryBilling = { chargeStatus: "reserved", revenueStatus: "pending", chargedFen: task.priceFen, billingMode: "wallet" };
      }
    }
    const queued = await tasks.findOneAndUpdate(
      { _id: task._id, status: task.status, ...(exempt || packageNoCharge ? {} : { refundStatus: "refunded" }) },
      { $set: { status: "queued", ...retryBilling, refundStatus: null, ...(exempt ? { administratorExemptedAt: new Date() } : { activeChargeKey: chargeKey, walletLedgerId: chargeKey }), retryCount, autoCancelAt: h3TaskAutoCancelAt(new Date(), integer(task.dispatchEstimatedTotalSeconds || task.estimatedTotalSeconds, estimateH3TaskTotalSeconds(task))), queuedAt: new Date(), updatedAt: new Date() }, $unset: { claimedByNode: "", claimRequestedByNode: "", executedByNode: "", assigneeUserId: "", assigneeEmailSnapshot: "", assigneeDisplayNameSnapshot: "", output: "", error: "", settlement: "", claimedAt: "", claimLeaseUntil: "", completedAt: "", failedAt: "", cancelledAt: "", timedOutAt: "", refundedAt: "", refundReason: "" } },
      { returnDocument: "after" },
    );
    await queueCoordinator.invalidate().catch(() => {});
    await audit(await getCollection("h3TaskAudits"), "admin_retried", { taskId: task._id, orderNo: task.orderNo, actorUserId: new ObjectId(auth.user.id), retryCount });
    return c.json({ task: publicTask(queued || await tasks.findOne({ _id: task._id })) });
  });

  app.get("/api/cron/h3-output-cleanup", async (c) => {
    const cronSecret = String(process.env.CRON_SECRET || "").trim();
    if (!cronSecret) return c.json({ code: "CRON_NOT_CONFIGURED", message: "H3 视频清理任务尚未配置" }, 503);
    if (c.req.header("authorization") !== `Bearer ${cronSecret}`) return c.json({ code: "UNAUTHORIZED", message: "无权执行 H3 视频清理任务" }, 401);
    c.header("Cache-Control", "private, no-store, max-age=0");
    const timeouts = await cancelTimedOutH3Tasks({ getCollection, notifyUserOnce: notifyOnce, limit: 500 });
    const backfill = await backfillCompletedH3ConversationMessages({ getCollection, limit: 200 });
    const cleanup = await cleanupExpiredH3Outputs({ getCollection, removeObject: removeCosObject, limit: 200 });
    return c.json({ ok: true, backfill, timeouts, cleanup, completedAt: new Date().toISOString() });
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "accountBinding", { type: "apiKey", in: "header", name: H3_ACCOUNT_BINDING_HEADER, description: "桌面端账号绑定时签发的可撤销高熵令牌；服务端仅保存哈希。" });
  const errorSchema = z.object({ code: z.string(), message: z.string() });
  const bindingSuccessSchema = z.object({ ok: z.literal(true), binding_token: z.string(), binding: z.object({ id: z.string(), email: z.email(), user_id: z.string(), display_name: z.string(), node_id: z.string(), node_name: z.string(), app_version: z.string(), verified_at: z.string() }) });
  const unknownUserSchema = errorSchema.extend({ register_url: z.url() });
  const earningsDeviceSchema = z.object({ node_id: z.string(), node_name: z.string(), gpu_name: z.string().nullable(), vram_mb: z.number().int(), online: z.boolean(), status: z.enum(["online", "offline"]), queue_status: z.string(), total_earnings_fen: z.number().int(), settled_earnings_fen: z.number().int(), pending_earnings_fen: z.number().int(), average_daily_earnings_fen: z.number().int(), active_days: z.number().int(), completed_task_count: z.number().int(), last_claimed_at: z.string().nullable(), last_callback_at: z.string().nullable(), last_completed_at: z.string().nullable(), app_version: z.string().nullable() });
  const earningsSummarySchema = z.object({ ok: z.literal(true), currency: z.literal("CNY"), account: z.object({ total_earnings_fen: z.number().int(), settled_earnings_fen: z.number().int(), pending_earnings_fen: z.number().int(), average_daily_earnings_fen: z.number().int(), active_days: z.number().int(), device_count: z.number().int() }), current_device: z.object({ node_id: z.string(), node_name: z.string(), total_earnings_fen: z.number().int(), average_daily_earnings_fen: z.number().int(), completed_task_count: z.number().int(), last_completed_at: z.string().nullable() }).nullable(), devices: z.array(earningsDeviceSchema) });
  const h3NodeCapabilitiesSchema = z.object({ max_duration_seconds: z.number().int().min(1).max(H3_MAX_DURATION_SECONDS), profiles: z.array(z.string()).min(1), sampling_steps: z.array(z.union([z.literal(4), z.literal(8), z.literal(20)])).min(1).optional(), longform_v1: z.boolean().optional(), gpu_name: z.string().max(160).optional(), vram_mb: z.number().int().min(0).optional(), max_image_count: z.number().int().min(0).max(9), max_video_count: z.number().int().min(0).max(3), max_audio_count: z.number().int().min(0).max(3), local_prompt_optimization_v1: z.boolean().optional(), batch_claim: z.boolean().optional(), max_concurrent_tasks: z.number().int().min(1).max(8).optional() });
  const h3LanNodeSchema = z.object({ node_id: z.string().min(12).max(160), node_name: z.string().max(120), running_task_count: z.number().int().min(0).max(64), estimated_total_seconds: z.number().int().min(0).max(7 * 24 * 60 * 60), available: z.boolean().optional(), capabilities: h3NodeCapabilitiesSchema });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/desktop/account-bindings/verify", tags: ["Desktop Account Binding"], summary: "在已激活桌面端绑定古龙官网账号", description: "先验证 RS256 激活回执，再查询邮箱。未激活或伪造客户端无法利用本接口枚举账号。服务端不会接收或保存原始 MAC。", security: [], request: { body: { required: true, content: { "application/json": { schema: z.object({ email: z.email(), node_id: z.string().min(12).max(160), node_name: z.string().min(1).max(120), app_version: z.string().min(1).max(40), activation_receipt: z.union([z.string(), z.record(z.string(), z.unknown())]) }) } } } }, responses: { 200: { description: "绑定成功；binding_token 只在本次响应返回", content: { "application/json": { schema: bindingSuccessSchema } } }, 403: { description: "激活证明无效", content: { "application/json": { schema: errorSchema } } }, 404: { description: "激活验证通过但邮箱未注册", content: { "application/json": { schema: unknownUserSchema } } }, 429: { description: "请求过于频繁", content: { "application/json": { schema: errorSchema } } } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/desktop/account-bindings/unbind", tags: ["Desktop Account Binding"], summary: "撤销当前节点账号绑定", security: [{ accountBinding: [] }], responses: { 200: { description: "已撤销" }, 401: { description: "绑定令牌无效" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/desktop/earnings/summary", tags: ["Desktop Earnings"], summary: "读取当前绑定账户的 MiniMax H3 节点收益", description: "仅接受 X-Gulong-Account-Binding。可选 node_id 必须属于令牌对应账户，否则返回 403。金额均为人民币整数分。收益只聚合服务端 h3_node_commission 结算流水；平均每天收益=已结算累计收益÷max(1, 从首个成功结算的中国自然日到当前中国自然日的天数)。", security: [{ accountBinding: [] }], request: { query: z.object({ node_id: z.string().optional() }) }, responses: { 200: { description: "账户与设备收益汇总", content: { "application/json": { schema: earningsSummarySchema } } }, 401: { description: "未绑定或绑定令牌失效", content: { "application/json": { schema: errorSchema } } }, 403: { description: "node_id 不属于当前账户", content: { "application/json": { schema: errorSchema } } } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/account/earnings/summary", tags: ["Account"], summary: "用户后台读取自己的共享节点收益", description: "使用官网登录会话或账户 API Key，仅返回当前账户；网页端 node_id 已脱敏。", responses: { 200: { description: "账户收益和脱敏设备列表", content: { "application/json": { schema: earningsSummarySchema } } }, 401: { description: "未登录" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/h3/prompts/optimize", tags: ["MiniMax H3 Shared Nodes"], summary: "已停用：服务端提示词优化", description: "官网服务端不执行提示词优化。网页版通过 prompt_optimization_enabled 让用户选择是否由 MiniMax H3 极速视频桌面端执行本地魔法优化。", deprecated: true, responses: { 410: { description: "PROMPT_OPTIMIZATION_MOVED_TO_DESKTOP" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/h3/assets/presign", tags: ["MiniMax H3 Shared Nodes"], summary: "为输入素材签发账号专属 COS 直传票据", description: "签发前会幂等校验并补齐官网当前 HTTPS 来源的腾讯云 COS 浏览器跨域规则；大文件直接上传 COS，不经过官网请求体。", request: { body: { required: true, content: { "application/json": { schema: z.object({ kind: z.enum(["image", "video", "audio"]), filename: z.string(), content_type: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/) }) } } } }, responses: { 201: { description: "返回 PUT URL、固定 headers、asset_id 与 object_key" }, 409: { description: "COS 回执不匹配" }, 503: { description: "COS 浏览器跨域规则暂时无法校验或配置" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/h3/assets/{id}/complete", tags: ["MiniMax H3 Shared Nodes"], summary: "校验并完成 H3 输入素材上传", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "返回可用于任务 assets manifest 的素材记录" }, 409: { description: "对象大小、摘要或归属不匹配" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/h3/tasks", tags: ["MiniMax H3 Shared Nodes"], summary: "使用原始中文提示词创建共享节点任务并原子预扣余额", description: "实际价格（分）= 时长秒数×20 + 图片数×5 + 视频数×20；音频免费。普通用户与会员用户原子预扣钱包余额；有效期内的短视频包月用户优先扣套餐额度并按实际扣款 50/50 分账，套餐额度归零后仍可无限创建 H3 任务且本次扣款、节点分佣和平台分佣均为 0。管理员始终免扣费且不参与分佣。服务端始终原样保存 prompt，不翻译；prompt_optimization_enabled=true 时由桌面节点执行本地魔法优化并回调 compiled_prompt，false 时必须直接使用原始提示词且禁止回传 compiled_prompt。video_mode、longform_mode、segment_duration_seconds、profile、sampling_steps 与 seed 会进入受信任节点任务合同；超长模式的 duration_seconds 由服务端按空行分段数乘单段时长重新计算。旧客户端省略字段时按全能参考、720P、4 步和随机种子兼容。必须提供 Idempotency-Key。", request: { body: { required: true, content: { "application/json": { schema: z.object({ source_channel: z.enum(["website", "desktop_agent"]), model: z.literal(H3_SHARED_MODEL), prompt: z.string().min(1).max(20_000), prompt_optimization_enabled: z.boolean().optional(), conversation_id: z.string().optional(), video_mode: z.enum(["all_reference", "first_last", "smart_multiframe", "extended"]).optional(), longform_mode: z.enum(["continuous", "independent"]).optional(), segment_duration_seconds: z.number().int().min(5).max(15).optional(), aspect_ratio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]), duration_seconds: z.number().int().min(1).max(H3_MAX_DURATION_SECONDS), profile: z.enum(["official_max", "ultra1080", "fast2k", "fast", "balanced", "turbo544", "quality", "preview"]), sampling_steps: z.union([z.literal(4), z.literal(8), z.literal(20)]).optional(), seed: z.number().int().min(-1).max(2_147_483_647).optional(), assets: z.object({ images: z.array(z.object({ asset_id: z.string(), object_key: z.string().optional() })).max(9), videos: z.array(z.object({ asset_id: z.string(), object_key: z.string().optional() })).max(3), audio: z.array(z.object({ asset_id: z.string(), object_key: z.string().optional() })).max(3) }), idempotency_key: z.string().min(8).max(160).optional() }) } } } }, responses: { 201: { description: "原始提示词、完整视频参数与用户优化选择已保存，并按账号类型完成扣费或零扣费排队" }, 402: { description: "非套餐用户余额不足" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/h3/tasks", tags: ["MiniMax H3 Shared Nodes"], summary: "查看当前账号的共享节点订单", responses: { 200: { description: "最多返回最近 50 个订单" }, 401: { description: "未认证" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/h3/conversations/recent", tags: ["MiniMax H3 Shared Nodes"], summary: "读取当前用户会话中的 H3 视频结果", description: "仅返回当前登录用户的 H3 assistant 结果消息；历史已完成任务会先进行同用户安全幂等回填。消息不包含 COS 永久地址。", request: { query: z.object({ conversation_id: z.string().optional() }) }, responses: { 200: { description: "当前会话及其 H3 视频结果" }, 401: { description: "未认证" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/h3/tasks/{id}", tags: ["MiniMax H3 Shared Nodes"], summary: "查看共享节点订单详情", description: "输出只包含受控 previewPath/downloadPath 和 24 小时到期状态，不返回 COS objectKey 或永久 URL。", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "订单详情" }, 404: { description: "订单不存在或无权查看" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/h3/tasks/{id}/output", tags: ["MiniMax H3 Shared Nodes"], summary: "鉴权预览或下载 H3 输出视频", description: "仅任务请求用户或管理员可访问。服务端按次签发不超过 5 分钟且不越过 24 小时保留截止时间的 COS GET 地址；disposition=attachment 用于下载。过期返回 410 并触发幂等删除。", request: { params: z.object({ id: z.string() }), query: z.object({ disposition: z.enum(["inline", "attachment"]).optional() }) }, responses: { 302: { description: "跳转到短时 COS 签名地址" }, 404: { description: "视频不存在或无权访问" }, 410: { description: "视频已过期并删除" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/desktop/agent/tools/minimax-h3-shared", tags: ["Desktop Agent Tools"], summary: "读取桌面古龙智能体的 H3 共享节点工具合同", description: "使用现有古龙会话或具有 tasks:read 的 API Key。返回 createTask、素材上传 URL、本地提示词处理合同、9图3视频3音频限制、整数分价格与当前余额；不再返回网页 optimizePrompt。管理员响应 wallet.unlimited=true，桌面端不得按余额拦截。桌面创建任务时 source_channel 必须为 desktop_agent。", responses: { 200: { description: "工具合同、本地提示词处理要求、钱包余额与管理员不限额标记" }, 401: { description: "未认证" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/h3/tasks/claim", tags: ["MiniMax H3 Shared Nodes"], summary: "按局域网集群负载原子调度最早等待任务", description: "轮询节点通过 lan_cluster.nodes 上报同一局域网内全部已绑定节点的 running_task_count、estimated_total_seconds 与能力。服务端先验证所有节点均属于当前 binding token 对应账号，再按预计剩余总耗时、运行任务数、node_id 排序，把按 createdAt、_id 最早且能力匹配的任务分配给耗时最少的节点；响应 workerTask.assigned_node 是唯一允许回调的执行节点。老客户端缺少 lan_cluster 时暂按单节点兼容。capabilities 必须上报 max_duration_seconds、profiles、sampling_steps 与素材上限；只有 longform_v1=true 的节点可领取 video_mode=extended。local_prompt_optimization_v1=true 表示节点能够处理用户开启魔法优化的任务。DTO 包含 assigned_node、dispatch_estimated_total_seconds、auto_cancel_at、素材短期下载票据与 output_upload，但不含 requester、价格、钱包流水或内部绑定信息。任务自创建起超过服务端预计总耗时 10 倍仍未完成会自动取消、幂等退款并提醒用户更换视频模型。dry_run=true 绝不领取任务。", security: [{ accountBinding: [] }], request: { body: { required: true, content: { "application/json": { schema: z.object({ bound_account_email: z.string().optional(), bound_account_id: z.string().optional(), node_id: z.string(), node_name: z.string(), dry_run: z.boolean().optional(), capabilities: h3NodeCapabilitiesSchema, lan_cluster: z.object({ cluster_id: z.string().min(12).max(160), observed_at: z.iso.datetime(), nodes: z.array(h3LanNodeSchema).min(1).max(H3_LAN_REPORT_MAX_NODES) }).optional() }) } } } }, responses: { 200: { description: "dry_run 返回可达状态；正式领取返回指定执行节点、素材票据、输出票据和动态 claim_plan" }, 400: { description: "节点能力或局域网报告无效/过期" }, 401: { description: "绑定无效" }, 403: { description: "局域网报告包含其他账号或未绑定节点" }, 409: { description: "回调节点不是 assigned_node" }, 429: { description: "未遵循轮询退避或请求频率过高" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/h3/tasks/callback", tags: ["MiniMax H3 Shared Nodes"], summary: "执行节点回调可选本地优化、生成进度或结果", description: "multipart/form-data 仅发送 metadata 字段，不得上传 video 文件。prompt_optimization_enabled=true 的任务先发送 status=optimizing，成功后以 status=started、compiled_prompt、estimated_total_seconds 上报；false 的任务不得发送 optimizing 或 compiled_prompt，直接以原始 prompt 执行并在 started 中提交 estimated_total_seconds。后续 progress 回调发送 progress（0–99）与可选 remaining_seconds。成功状态还需 video.sha256/bytes/filename/object_key，服务端 HEAD 校验对象归属。失败任务按既有幂等规则退款。", security: [{ accountBinding: [] }], request: { body: { required: true, content: { "multipart/form-data": { schema: z.object({ metadata: z.string() }) } } } }, responses: { 200: { description: "可选本地优化阶段、生成进度或最终结果已幂等处理" }, 400: { description: "回执不完整、缺少必需 compiled_prompt 或在关闭优化时非法提交 compiled_prompt" }, 401: { description: "绑定无效" }, 409: { description: "用户优化选择、本地优化、COS 回执、上传票据或结算状态不匹配" }, 413: { description: "禁止把视频文件经 Vercel 中转" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/admin/h3/tasks", tags: ["Administration"], summary: "管理员筛选共享节点任务派单", responses: { 200: { description: "任务列表" }, 403: { description: "需要管理员角色" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/admin/h3/tasks/{id}", tags: ["Administration"], summary: "管理员查看共享节点任务、回调和审计详情", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "任务详情、回调和审计时间线" }, 404: { description: "任务不存在" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/admin/h3/tasks/{id}/cancel", tags: ["Administration"], summary: "管理员幂等取消任务并退款", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "取消状态和退款结果" }, 409: { description: "已完成任务不能取消" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/admin/h3/tasks/{id}/retry", tags: ["Administration"], summary: "管理员重新派发失败任务", description: "普通用户与订阅用户的已退款任务会重新原子预扣；管理员发起的免扣费任务直接重新排队，不产生扣款或分佣。", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "重新排队后的任务" }, 402: { description: "需求用户余额不足" }, 409: { description: "当前状态不可重试" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/cron/h3-output-cleanup", tags: ["Operations"], summary: "取消超时任务、回填会话结果并清理过期 H3 视频", description: "使用 CRON_SECRET Bearer 鉴权。先幂等取消超过预计总耗时 10 倍的活动任务并退款、提醒用户，再安全回填历史 website 结果，最后删除 completedAt 后已满 24 小时的 COS 对象；删除失败记录指数退避并重试。", responses: { 200: { description: "timeouts、backfill 与 cleanup 汇总" }, 401: { description: "Cron 鉴权失败" }, 503: { description: "Cron 未配置" } } });
}
