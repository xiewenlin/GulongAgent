import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { fingerprintIp, hashOpaqueToken } from "./security.js";
import { copyObject, createPresignedDownloadUrl, createPresignedPutUrl, deleteObject, ensureBrowserUploadCors, headObject, sanitizeFilename, assertSingleWriteUploads } from "./cos.js";
import { localizeErrorMessage } from "../shared/error-messages.js";
import { readEnglishEntitlement, readGulongEngineEntitlement, GULONG_ENGINE_MONTHLY_PRICE_FEN } from "./english-coach-products.js";
import { DIGITAL_LIVE_PRODUCT_ID, DIGITAL_LIVE_CAPABILITY_IDS, digitalLiveConfig, digitalLiveParameterError, digitalLiveNodeMatchesOrder, digitalLiveReport, digitalLiveAvailability } from "./digital-live-product.js";
import { ENGLISH_CAPABILITY_DEFINITIONS, englishNodeSharesCapability, englishWorkerOwnsClaim, isEnglishCapability, validateEnglishInlineResult } from "./english-coach-capabilities.js";
import { GULONG_ENGINE_CAPABILITY_DEFINITIONS, gulongEngineNodeSharesCapability, gulongEngineUploadAllowed, isGulongEngineCapability, validateGulongEngineInlineResult } from "./gulong-engine-capabilities.js";
import { computeGroupFilter, computeGroupsMatch, getUserComputeGroupId, normalizeComputeGroupId } from "./compute-groups.js";

import { capabilityProducts, withClientProductFingerprint, clientProductConflicts } from "./worklucky-product.js";
import { isWorkLuckyCapability, validateSpecialParameters, validateSpecialInlineResult, normalizeSpecialNodeModels, specialNodeMatches, specialAvailability } from "./worklucky-capabilities.js";
import { createCapabilitySlotCoordinator, normalizeCapabilityResources } from "./capability-slots.js";
import { SHARED_NODE_SCHEDULING, NODE_REPORT_MAX_AGE_MS, normalizeGpuLoadReport, projectSharedNodeLoad, compareSharedNodeLoad, boundedGlobalDispatchWait } from "./shared-node-scheduler.js";
import { findTrustedConsumerAcceptance } from "./capability-consumer-acceptance.js";
import { createCapabilityAutoVerificationService, registerCapabilityAutoVerificationRoutes } from "./capability-auto-verification.js";
import { requiresAutomaticCapabilityVerification } from "./capability-verification-policy.js";
import { createCapabilityVerificationMedia } from "./capability-verification-media.js";
import { createCapabilityVerificationAdapters, automaticImageNodeMatchesOrder } from "./capability-verification-adapters.js";
import { createNativeCapabilityVerificationAdapters, automaticNativeNodeMatchesOrder, nativeVerificationAvailability } from "./capability-native-verification.js";
import { createProbeFixtureIssuer } from "./capability-probe-inputs.js";
import { CAPABILITY_PROBE_FIXTURES } from "./capability-probe-fixtures.js";
import { isNativeSharedCapability, NATIVE_SHARED_CAPABILITY_IDS } from "./native-shared-capability-ids.js";
import { inspectFlacStream } from "./capability-flac.js";

export const CAPABILITY_ORDER_PROTOCOL = "gulong-capability-orders-v1";
export const CAPABILITY_BINDING_HEADER = "X-Gulong-Account-Binding";
const CAPABILITY_REPORT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CAPABILITY_CLAIM_LEASE_MS = 5 * 60_000;
const CAPABILITY_MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const CAPABILITY_TERMINAL = new Set(["completed", "failed", "cancelled"]);

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"];
const AUDIO_MIME = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac"];
const VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime"];

async function boundedRequestJson(c, maxBytes = 128 * 1024) {
  const oversized = () => Object.assign(new Error("请求内容超过接口允许的大小，请减少单次数据量"), { code: "REQUEST_TOO_LARGE", status: 413 });
  if (Number(c.req.header("content-length")) > maxBytes) throw oversized();
  const reader = c.req.raw.body?.getReader();
  if (!reader) return {};
  const buffer = Buffer.allocUnsafe(maxBytes);
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw oversized(); }
      buffer.set(value, bytes - value.byteLength);
    }
    const parsed = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    if (error?.code === "REQUEST_TOO_LARGE") throw error;
    return {};
  }
}

export async function verifyCapabilityAudioDigest(objectKey, expectedBytes, expectedSha256, { issueDownloadUrl = createPresignedDownloadUrl, fetchObject = fetch } = {}) {
  const response = await fetchObject(issueDownloadUrl(objectKey, { expires: 120 }), { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error("音频对象暂时无法读取");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > expectedBytes) return false;
    hash.update(chunk);
  }
  return bytes === expectedBytes && hash.digest("hex").toUpperCase() === expectedSha256;
}

function objectSchema(properties, required = []) {
  return { type: "object", additionalProperties: false, properties, required };
}

const stringField = (options = {}) => ({ type: "string", ...options });
const integerField = (options = {}) => ({ type: "integer", ...options });
const numberField = (options = {}) => ({ type: "number", ...options });
const booleanField = (defaultValue) => ({ type: "boolean", ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const enumField = (values, defaultValue) => ({ type: "string", enum: values, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const seedField = () => integerField({ minimum: -1, maximum: 2147483647, default: -1 });

const CAPABILITY_PARAMETER_SCHEMAS = Object.freeze({
  "qwen_image_2_1.text_to_image": objectSchema({
    prompt: stringField({ minLength: 1, maxLength: 8000 }),
    negative_prompt: stringField({ maxLength: 4000, default: "" }),
    width: integerField({ enum: [512, 768, 1024, 1280, 1536], default: 1024 }),
    height: integerField({ enum: [512, 768, 1024, 1280, 1536], default: 1024 }),
    steps: integerField({ minimum: 1, maximum: 100, default: 30 }),
    guidance_scale: numberField({ minimum: 0, maximum: 20, default: 4 }),
    seed: seedField(),
    batch_size: integerField({ minimum: 1, maximum: 4, default: 1 }),
  }, ["prompt"]),
  "qwen_image_2_1.multi_image_edit": objectSchema({
    prompt: stringField({ minLength: 1, maxLength: 8000 }),
    negative_prompt: stringField({ maxLength: 4000, default: "" }),
    width: integerField({ enum: [512, 768, 1024, 1280, 1536], default: 1024 }),
    height: integerField({ enum: [512, 768, 1024, 1280, 1536], default: 1024 }),
    steps: integerField({ minimum: 1, maximum: 100, default: 30 }),
    guidance_scale: numberField({ minimum: 0, maximum: 20, default: 4 }),
    edit_strength: numberField({ minimum: 0, maximum: 1, default: 0.75 }),
    seed: seedField(),
    batch_size: integerField({ minimum: 1, maximum: 4, default: 1 }),
  }, ["prompt"]),
  "minimax_music_3.generate": objectSchema({
    prompt: stringField({ minLength: 1, maxLength: 4000 }),
    lyrics: stringField({ maxLength: 12000, default: "" }),
    duration_seconds: integerField({ minimum: 10, maximum: 300, default: 60 }),
    language: enumField(["auto", "zh", "en", "ja", "ko", "instrumental"], "auto"),
    sample_rate: integerField({ enum: [44100, 48000], default: 44100 }),
    output_format: enumField(["mp3", "wav", "flac"], "wav"),
    seed: seedField(),
  }, ["prompt"]),
  "yue_2.generate": objectSchema({
    prompt: stringField({ minLength: 1, maxLength: 4000 }),
    lyrics: stringField({ minLength: 1, maxLength: 16000 }),
    duration_seconds: integerField({ minimum: 10, maximum: 600, default: 120 }),
    language: enumField(["zh", "en", "ja", "ko", "multilingual"], "zh"),
    sample_rate: integerField({ enum: [44100, 48000], default: 44100 }),
    output_format: enumField(["mp3", "wav", "flac"], "wav"),
    seed: seedField(),
  }, ["prompt", "lyrics"]),
  "breeze_tts_2.synthesize": objectSchema({
    text: stringField({ minLength: 1, maxLength: 12000 }),
    language: enumField(["zh-CN", "en-US", "ja-JP", "ko-KR"], "zh-CN"),
    voice_id: stringField({ minLength: 1, maxLength: 120, default: "default" }),
    speed: numberField({ minimum: 0.5, maximum: 2, default: 1 }),
    pitch_semitones: numberField({ minimum: -12, maximum: 12, default: 0 }),
    sample_rate: integerField({ enum: [16000, 22050, 24000, 44100, 48000], default: 24000 }),
    output_format: enumField(["mp3", "wav", "flac"], "wav"),
    seed: seedField(),
  }, ["text"]),
  "whisper.transcribe": objectSchema({
    task: enumField(["transcribe", "translate"], "transcribe"),
    language: stringField({ minLength: 2, maxLength: 16, pattern: "^(auto|[a-z]{2,3}(?:-[A-Z]{2})?)$", default: "auto" }),
    initial_prompt: stringField({ maxLength: 4000, default: "" }),
    word_timestamps: { type: "boolean" },
    output_format: enumField(["json", "txt", "vtt", "srt"], "json"),
  }),
  "sam.segment": objectSchema({
    mode: enumField(["everything", "points", "box"], "everything"),
    points: { type: "array", maxItems: 64, default: [], items: objectSchema({ x: numberField({ minimum: 0, maximum: 1 }), y: numberField({ minimum: 0, maximum: 1 }), label: integerField({ enum: [0, 1] }) }, ["x", "y", "label"]) },
    box: { type: ["array", "null"], minItems: 4, maxItems: 4, default: null, items: numberField({ minimum: 0, maximum: 1 }) },
    multimask: booleanField(false),
    output_format: enumField(["mask_png", "json", "both"], "both"),
  }),
  "sam.video_track": objectSchema({
    prompt_mode: enumField(["everything", "text", "points", "box"], "everything"),
    text_prompts: { type: "array", maxItems: 8, default: [], items: stringField({ minLength: 1, maxLength: 200 }) },
    points: { type: "array", maxItems: 64, default: [], items: objectSchema({ x: numberField({ minimum: 0, maximum: 1 }), y: numberField({ minimum: 0, maximum: 1 }), label: integerField({ enum: [0, 1] }) }, ["x", "y", "label"]) },
    box: { type: ["array", "null"], minItems: 4, maxItems: 4, default: null, items: numberField({ minimum: 0, maximum: 1 }) },
    start_frame: integerField({ minimum: 0, maximum: 1000000, default: 0 }),
    end_frame: integerField({ minimum: -1, maximum: 1000000, default: -1 }),
    sample_fps: integerField({ minimum: 1, maximum: 60 }),
    output_format: enumField(["mask_video", "tracks_json", "both", "native_layers"], "both"),
  }),
  "mediapipe.pose_track": objectSchema({
    model_complexity: integerField({ minimum: 0, maximum: 2, default: 1 }),
    min_detection_confidence: numberField({ minimum: 0, maximum: 1, default: 0.5 }),
    min_tracking_confidence: numberField({ minimum: 0, maximum: 1, default: 0.5 }),
    output_fps: integerField({ minimum: 1, maximum: 120, default: 30 }),
    include_world_landmarks: booleanField(true),
    output_format: enumField(["json", "csv", "both"], "json"),
  }),
  "mediapipe.video_analysis": objectSchema({
    pipelines: { type: "array", minItems: 1, maxItems: 4, default: ["pose"], items: { type: "string", enum: ["pose", "hands", "face", "holistic"] } },
    model_complexity: integerField({ minimum: 0, maximum: 2, default: 1 }),
    min_detection_confidence: numberField({ minimum: 0, maximum: 1, default: 0.5 }),
    min_tracking_confidence: numberField({ minimum: 0, maximum: 1, default: 0.5 }),
    output_fps: integerField({ minimum: 1, maximum: 120 }),
    include_world_landmarks: { type: "boolean" },
    include_annotated_video: booleanField(false),
    output_format: enumField(["json", "csv", "both", "native_layers"], "json"),
  }),
  "dwpose.estimate": objectSchema({
    detect_resolution: integerField({ minimum: 128, maximum: 2048, default: 512 }),
    include_body: booleanField(true),
    include_hands: booleanField(true),
    include_face: booleanField(true),
    output_fps: integerField({ minimum: 1, maximum: 60, default: 24 }),
    output_format: enumField(["json", "pose_png", "both"], "both"),
  }),
  "prompt.optimize_translate": objectSchema({
    text: stringField({ minLength: 1, maxLength: 32000 }),
    mode: enumField(["optimize", "translate", "optimize_translate"], "optimize_translate"),
    source_language: stringField({ minLength: 2, maxLength: 32, default: "auto" }),
    target_language: stringField({ minLength: 2, maxLength: 32, default: "en" }),
    tone: enumField(["neutral", "cinematic", "commercial", "technical", "natural"], "natural"),
    preserve_placeholders: booleanField(true),
  }, ["text"]),
});

const CAPABILITY_ASSET_RULES = Object.freeze({
  "qwen_image_2_1.text_to_image": [],
  "qwen_image_2_1.multi_image_edit": [{ role: "reference_image", min: 1, max: 9, mimeTypes: IMAGE_MIME, maxBytes: 512 * 1024 * 1024 }],
  "minimax_music_3.generate": [{ role: "reference_audio", min: 0, max: 1, mimeTypes: AUDIO_MIME, maxBytes: 512 * 1024 * 1024 }],
  "yue_2.generate": [
    { role: "melody_reference", min: 0, max: 1, mimeTypes: AUDIO_MIME, maxBytes: 512 * 1024 * 1024 },
    { role: "vocal_reference", min: 0, max: 1, mimeTypes: AUDIO_MIME, maxBytes: 512 * 1024 * 1024 },
  ],
  "breeze_tts_2.synthesize": [{ role: "voice_reference", min: 0, max: 1, mimeTypes: AUDIO_MIME, maxBytes: 256 * 1024 * 1024 }],
  "whisper.transcribe": [{ role: "media", min: 1, max: 1, mimeTypes: [...AUDIO_MIME, ...VIDEO_MIME], maxBytes: CAPABILITY_MAX_ASSET_BYTES }],
  "sam.segment": [{ role: "source_image", min: 1, max: 1, mimeTypes: IMAGE_MIME, maxBytes: 512 * 1024 * 1024 }],
  "sam.video_track": [{ role: "source_video", min: 1, max: 1, mimeTypes: VIDEO_MIME, maxBytes: CAPABILITY_MAX_ASSET_BYTES }],
  "mediapipe.pose_track": [{ role: "source_video", min: 1, max: 1, mimeTypes: VIDEO_MIME, maxBytes: CAPABILITY_MAX_ASSET_BYTES }],
  "mediapipe.video_analysis": [{ role: "source_video", min: 1, max: 1, mimeTypes: VIDEO_MIME, maxBytes: CAPABILITY_MAX_ASSET_BYTES }],
  "dwpose.estimate": [{ role: "source_media", min: 1, max: 1, mimeTypes: [...IMAGE_MIME, "video/mp4", "video/webm"], maxBytes: CAPABILITY_MAX_ASSET_BYTES }],
  "prompt.optimize_translate": [],
});

const CAPABILITY_OUTPUT_RULES = Object.freeze({
  "qwen_image_2_1.text_to_image": [{ role: "primary_image", min: 1, max: 4, mimeTypes: IMAGE_MIME, maxBytes: 256 * 1024 * 1024 }],
  "qwen_image_2_1.multi_image_edit": [{ role: "primary_image", min: 1, max: 4, mimeTypes: IMAGE_MIME, maxBytes: 256 * 1024 * 1024 }],
  "minimax_music_3.generate": [{ role: "primary_audio", min: 1, max: 1, mimeTypes: ["audio/mpeg", "audio/wav", "audio/flac"], maxBytes: 1024 * 1024 * 1024 }],
  "yue_2.generate": [{ role: "primary_audio", min: 1, max: 1, mimeTypes: ["audio/mpeg", "audio/wav", "audio/flac"], maxBytes: 1024 * 1024 * 1024 }],
  "breeze_tts_2.synthesize": [{ role: "primary_audio", min: 1, max: 1, mimeTypes: ["audio/mpeg", "audio/wav", "audio/flac"], maxBytes: 512 * 1024 * 1024 }],
  "whisper.transcribe": [
    { role: "transcript_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 64 * 1024 * 1024 },
    { role: "transcript_text", min: 0, max: 1, mimeTypes: ["text/plain", "text/vtt", "application/x-subrip"], maxBytes: 64 * 1024 * 1024 },
  ],
  "sam.segment": [
    { role: "mask_image", min: 0, max: 1, mimeTypes: ["image/png"], maxBytes: 256 * 1024 * 1024 },
    { role: "segments_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 64 * 1024 * 1024 },
  ],
  "sam.video_track": [
    { role: "mask_video", min: 0, max: 1, mimeTypes: ["video/mp4", "video/webm"], maxBytes: CAPABILITY_MAX_ASSET_BYTES },
    { role: "tracks_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 256 * 1024 * 1024 },
    { role: "manifest_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 1024 * 1024 },
    { role: "tracks_jsonl", min: 0, max: 1, mimeTypes: ["application/x-ndjson"], maxBytes: 256 * 1024 * 1024 },
    { role: "mask_archive", min: 0, max: 1, mimeTypes: ["application/zip"], maxBytes: CAPABILITY_MAX_ASSET_BYTES },
  ],
  "mediapipe.pose_track": [
    { role: "pose_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 256 * 1024 * 1024 },
    { role: "pose_csv", min: 0, max: 1, mimeTypes: ["text/csv"], maxBytes: 256 * 1024 * 1024 },
  ],
  "mediapipe.video_analysis": [
    { role: "analysis_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 512 * 1024 * 1024 },
    { role: "analysis_csv", min: 0, max: 1, mimeTypes: ["text/csv"], maxBytes: 512 * 1024 * 1024 },
    { role: "annotated_video", min: 0, max: 1, mimeTypes: ["video/mp4", "video/webm"], maxBytes: CAPABILITY_MAX_ASSET_BYTES },
    { role: "pose_tracks_jsonl", min: 0, max: 1, mimeTypes: ["application/x-ndjson"], maxBytes: 256 * 1024 * 1024 },
    { role: "person_layers_archive", min: 0, max: 1, mimeTypes: ["application/zip"], maxBytes: CAPABILITY_MAX_ASSET_BYTES },
  ],
  "dwpose.estimate": [
    { role: "pose_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 256 * 1024 * 1024 },
    { role: "pose_image", min: 0, max: 1, mimeTypes: ["image/png"], maxBytes: 256 * 1024 * 1024 },
  ],
  "prompt.optimize_translate": [
    { role: "result_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 64 * 1024 },
    { role: "result_text", min: 0, max: 1, mimeTypes: ["text/plain"], maxBytes: 64 * 1024 },
  ],
});

function definition(id, inputMime, outputMime, options = {}) {
  return Object.freeze({
    capabilityId: id,
    protocolVersion: CAPABILITY_ORDER_PROTOCOL,
    inputMime,
    outputMime,
    maxAssets: options.maxAssets ?? 0,
    maxTotalInputBytes: options.maxTotalInputBytes ?? 0,
    defaultEtaSeconds: options.defaultEtaSeconds ?? 300,
    maxRuntimeSeconds: options.maxRuntimeSeconds ?? 3600,
    priceFen: 0,
    inlineResult: Boolean(options.inlineResult),
    parametersSchemaVersion: "1.0.0",
    parametersSchema: CAPABILITY_PARAMETER_SCHEMAS[id] || objectSchema({}),
    assetRules: CAPABILITY_ASSET_RULES[id] || [],
    outputRules: CAPABILITY_OUTPUT_RULES[id] || [],
    commercialUse: options.commercialUse || "allowed",
    dispatchable: options.dispatchable !== false,
    adapterStatus: options.adapterStatus || (options.dispatchable === false ? "adapter_required" : "ready"),
    legacyRoute: options.legacyRoute || null,
  });
}

export const CAPABILITY_ORDER_DEFINITIONS = Object.freeze([
  ...ENGLISH_CAPABILITY_DEFINITIONS,
  ...GULONG_ENGINE_CAPABILITY_DEFINITIONS,
  definition("qwen_image_2_1.text_to_image", [], ["image/png", "image/jpeg", "image/webp"], { defaultEtaSeconds: 180, maxRuntimeSeconds: 1800 }),
  definition("qwen_image_2_1.multi_image_edit", ["image/png", "image/jpeg", "image/webp"], ["image/png", "image/jpeg", "image/webp"], { maxAssets: 9, maxTotalInputBytes: 512 * 1024 * 1024, defaultEtaSeconds: 240, maxRuntimeSeconds: 2400 }),
  definition("minimax_music_3.generate", AUDIO_MIME, ["audio/mpeg", "audio/wav", "audio/flac"], { maxAssets: 1, maxTotalInputBytes: 512 * 1024 * 1024, defaultEtaSeconds: 300, maxRuntimeSeconds: 3600 }),
  definition("yue_2.generate", AUDIO_MIME, ["audio/mpeg", "audio/wav", "audio/flac"], { maxAssets: 2, maxTotalInputBytes: 1024 * 1024 * 1024, defaultEtaSeconds: 600, maxRuntimeSeconds: 5400, commercialUse: "license_review_required" }),
  definition("breeze_tts_2.synthesize", AUDIO_MIME, ["audio/mpeg", "audio/wav", "audio/flac"], { maxAssets: 1, maxTotalInputBytes: 256 * 1024 * 1024, defaultEtaSeconds: 90, maxRuntimeSeconds: 1200, commercialUse: "license_review_required", dispatchable: false }),
  definition("whisper.transcribe", ["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/flac", "video/mp4", "video/webm", "video/quicktime"], ["application/json", "text/plain", "text/vtt", "application/x-subrip"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 180, maxRuntimeSeconds: 3600, inlineResult: true }),
  definition("sam.segment", ["image/png", "image/jpeg", "image/webp"], ["image/png", "application/json"], { maxAssets: 1, maxTotalInputBytes: 512 * 1024 * 1024, defaultEtaSeconds: 60, maxRuntimeSeconds: 900, inlineResult: true, dispatchable: false }),
  definition("sam.video_track", VIDEO_MIME, ["video/mp4", "video/webm", "application/json", "application/x-ndjson", "application/zip"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 300, maxRuntimeSeconds: 3600, inlineResult: true }),
  definition("mediapipe.pose_track", VIDEO_MIME, ["application/json", "text/csv"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 240, maxRuntimeSeconds: 3600, inlineResult: true, dispatchable: false }),
  definition("mediapipe.video_analysis", VIDEO_MIME, ["application/json", "text/csv", "video/mp4", "video/webm", "application/x-ndjson", "application/zip"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 240, maxRuntimeSeconds: 3600, inlineResult: true }),
  definition("dwpose.estimate", ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"], ["application/json", "image/png"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 120, maxRuntimeSeconds: 1800, inlineResult: true, dispatchable: false }),
  definition("prompt.optimize_translate", [], ["application/json", "text/plain"], { defaultEtaSeconds: 45, maxRuntimeSeconds: 300, inlineResult: true }),
  definition("minimax_h3.video_generation", ["image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg", "audio/wav"], ["video/mp4"], { maxAssets: 15, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 1200, maxRuntimeSeconds: 6 * 60 * 60, legacyRoute: "/api/h3/tasks" }),
]);

const CAPABILITY_MAP = new Map(CAPABILITY_ORDER_DEFINITIONS.map((item) => [item.capabilityId, item]));
const NATIVE_LAYER_ROLES = Object.freeze({
  "sam.video_track": Object.freeze(["manifest_json", "tracks_jsonl", "mask_archive"]),
  "mediapipe.video_analysis": Object.freeze(["analysis_json", "pose_tracks_jsonl", "person_layers_archive"]),
});
export function requiredNativeOutputRoles(order) {
  return order.parameters?.output_format === "native_layers" ? NATIVE_LAYER_ROLES[order.capabilityId] || [] : [];
}
export function validateNativeOutputSet(order, outputs) {
  const required = requiredNativeOutputRoles(order);
  if (!required.length) return true;
  if (!Array.isArray(outputs) || outputs.length !== required.length
    || required.some((role) => outputs.filter((output) => output.role === role).length !== 1)) {
    throw Object.assign(new Error("原生图层结果必须完整包含清单、逐帧记录和真实蒙版归档，不能用内联声明或伪造视频代替"), { code: "NATIVE_OUTPUT_SET_INCOMPLETE", status: 400 });
  }
  return true;
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requestFingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function objectHeader(head, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(head?.headers || head || {})) {
    if (String(key).toLowerCase() === wanted) return String(value || "");
  }
  return "";
}

function objectBytes(head) {
  return integer(head?.headers?.["content-length"] ?? head?.headers?.["Content-Length"] ?? head?.ContentLength ?? head?.contentLength, -1);
}

function mimeAllowed(value, allowed) {
  const mime = String(value || "").toLowerCase();
  return allowed.includes(mime);
}

function validationError(message, path = "parameters") {
  return Object.assign(new Error(`${path}：${message}`), { code: "INVALID_CAPABILITY_PARAMETERS", status: 400 });
}

function applySchemaDefaults(schema, value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value };
  for (const [key, property] of Object.entries(schema.properties || {})) {
    if (result[key] === undefined && Object.hasOwn(property, "default")) result[key] = structuredClone(property.default);
    else if (result[key] !== undefined && property.type === "object") result[key] = applySchemaDefaults(property, result[key]);
  }
  return result;
}

function validateJsonValue(schema, value, path = "parameters") {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value === "number" ? "number" : typeof value;
  const typeMatches = allowedTypes.includes(actualType) || (actualType === "integer" && allowedTypes.includes("number"));
  if (!typeMatches) throw validationError(`必须是 ${allowedTypes.join(" 或 ")}`, path);
  if ((actualType === "number" || actualType === "integer") && !Number.isFinite(value)) throw validationError("必须是有限数字", path);
  if (schema.enum && !schema.enum.includes(value)) throw validationError(`仅允许 ${schema.enum.join("、")}`, path);
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) throw validationError(`长度不能少于 ${schema.minLength}`, path);
    if (schema.maxLength != null && value.length > schema.maxLength) throw validationError(`长度不能超过 ${schema.maxLength}`, path);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw validationError("格式不正确", path);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) throw validationError(`不能小于 ${schema.minimum}`, path);
    if (schema.maximum != null && value > schema.maximum) throw validationError(`不能大于 ${schema.maximum}`, path);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) throw validationError(`至少需要 ${schema.minItems} 项`, path);
    if (schema.maxItems != null && value.length > schema.maxItems) throw validationError(`最多允许 ${schema.maxItems} 项`, path);
    if (schema.items) value.forEach((item, index) => validateJsonValue(schema.items, item, `${path}[${index}]`));
  }
  if (actualType === "object") {
    const properties = schema.properties || {};
    for (const required of schema.required || []) if (value[required] === undefined) throw validationError("为必填字段", `${path}.${required}`);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw validationError("是不支持的未知字段", `${path}.${unknown}`);
    }
    for (const [key, item] of Object.entries(value)) if (properties[key]) validateJsonValue(properties[key], item, `${path}.${key}`);
  }
}

export function normalizeCapabilityParameters(value, capability) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("parameters 必须是 JSON 对象"), { code: "VALIDATION_ERROR", status: 400 });
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > (capability.maxParameterBytes || 64_000)) throw Object.assign(new Error("能力参数超过该能力允许的大小"), { code: "VALIDATION_ERROR", status: 400 });
  if (/"(?:__proto__|prototype|constructor)"\s*:/u.test(serialized)) throw Object.assign(new Error("能力参数包含不安全字段"), { code: "VALIDATION_ERROR", status: 400 });
  const normalized = applySchemaDefaults(capability.parametersSchema, JSON.parse(serialized));
  validateJsonValue(capability.parametersSchema, normalized);
  validateSpecialParameters(capability.capabilityId, normalized);
  return normalized;
}

export function validateCapabilityInput(capability, parameters, assets) {
  const assetCount = assets.length;
  const totalBytes = assets.reduce((sum, item) => sum + integer(item.bytes), 0);
  if (assetCount > capability.maxAssets || totalBytes > capability.maxTotalInputBytes) throw Object.assign(new Error("输入素材数量或总大小超过该能力上限"), { code: "CAPABILITY_INPUT_LIMIT_EXCEEDED", status: 400 });
  if (new Set(assets.map((item) => item.assetId)).size !== assetCount) throw Object.assign(new Error("同一个素材不能在一个订单中重复引用"), { code: "DUPLICATE_INPUT_ASSET", status: 400 });
  const rules = new Map(capability.assetRules.map((rule) => [rule.role, rule]));
  const counts = new Map();
  for (const asset of assets) {
    const rule = rules.get(asset.role);
    if (!rule) throw Object.assign(new Error(`该能力不接受素材角色 ${asset.role}`), { code: "UNSUPPORTED_INPUT_ROLE", status: 400 });
    if (!mimeAllowed(asset.contentType, rule.mimeTypes)) throw Object.assign(new Error(`素材角色 ${asset.role} 不支持 ${asset.contentType}`), { code: "UNSUPPORTED_INPUT_MIME", status: 400 });
    if (integer(asset.bytes) > rule.maxBytes) throw Object.assign(new Error(`素材角色 ${asset.role} 的单文件大小超过上限`), { code: "CAPABILITY_INPUT_LIMIT_EXCEEDED", status: 400 });
    counts.set(asset.role, (counts.get(asset.role) || 0) + 1);
  }
  for (const rule of capability.assetRules) {
    const count = counts.get(rule.role) || 0;
    if (count < rule.min || count > rule.max) throw Object.assign(new Error(`素材角色 ${rule.role} 需要 ${rule.min}–${rule.max} 个，当前为 ${count} 个`), { code: "INVALID_INPUT_ROLE_COUNT", status: 400 });
  }
  if (capability.capabilityId === "sam.segment") {
    if (parameters.mode === "points" && !parameters.points.length) throw validationError("points 模式至少需要一个点", "parameters.points");
    if (parameters.mode === "box" && !Array.isArray(parameters.box)) throw validationError("box 模式必须提供归一化边框 [x1,y1,x2,y2]", "parameters.box");
  }
  if (capability.capabilityId === "gulong_engine.image_2k") {
    const size = `${parameters.width}x${parameters.height}`;
    if (!["2048x2048", "2400x1792", "1792x2400", "2528x1696", "1696x2528", "2752x1536", "1536x2752"].includes(size)) throw validationError("仅支持 Qwen 官方七种原生 2K 画布比例", "parameters.width/height");
    const references = counts.get("reference_image") || 0;
    if (parameters.task === "text_to_image" && references !== 0) throw validationError("文生图不能附带参考图", "assets");
    if (parameters.task === "multi_image_edit" && (references < 1 || references > 10)) throw validationError("多图编辑需要 1–10 张按 assets 数组顺序排列的参考图", "assets");
    if (parameters.generation_mode === "fast_lora_6" && parameters.steps !== 6) throw validationError("6 步 LoRA 模式必须使用 6 步", "parameters.steps");
  }
  if (capability.capabilityId === "gulong_engine.tts") {
    if (!parameters.text.trim()) throw validationError("配音文本不能只包含空白字符", "parameters.text");
    if (!parameters.voice_id.trim()) throw validationError("voice_id 不能为空", "parameters.voice_id");
  }
  if (capability.capabilityId === "sam.video_track") {
    const prompts = parameters.text_prompts || [];
    if (parameters.prompt_mode === "text") {
      if (!prompts.length || prompts.some((prompt) => !prompt.trim())) throw validationError("文字对象提示模式需要 1–8 个非空 text_prompts", "parameters.text_prompts");
      if (parameters.points.length || parameters.box !== null) throw validationError("文字对象提示不能混入点或边框参数", "parameters.points/box");
    } else if (prompts.length) throw validationError("text_prompts 必须与 prompt_mode=text 一起提交，不能静默忽略对象提示", "parameters.prompt_mode");
    if (parameters.prompt_mode === "points" && !parameters.points.length) throw validationError("points 模式至少需要一个点", "parameters.points");
    if (parameters.prompt_mode === "box" && !Array.isArray(parameters.box)) throw validationError("box 模式必须提供归一化边框 [x1,y1,x2,y2]", "parameters.box");
    if (parameters.end_frame !== -1 && parameters.end_frame < parameters.start_frame) throw validationError("必须为 -1 或不小于 start_frame", "parameters.end_frame");
  }
}

export function normalizeCapabilityReport(value = {}, now = new Date(), { allowLegacyEnglishOrders = false } = {}) {
  const capabilityId = String(value.capability_id || value.capabilityId || "").trim().toLowerCase();
  const definition = CAPABILITY_MAP.get(capabilityId);
  if (!definition || definition.legacyRoute) throw Object.assign(new Error("节点上报了未注册或需走旧版接口的能力"), { code: "UNKNOWN_CAPABILITY", status: 400 });
  // Existing English orders can finish their original lifecycle after the desktop
  // product moves to local inference. New orders remain blocked by the catalog.
  if (!definition.dispatchable && !(allowLegacyEnglishOrders && isEnglishCapability(capabilityId))) {
    throw Object.assign(new Error(isEnglishCapability(capabilityId)
      ? "该能力已改为本地处理，不能接收新的派单"
      : "该能力尚未完成独立订单适配与真实推理验收，暂不可上报接单"),
    { code: isEnglishCapability(capabilityId) ? "CAPABILITY_LOCAL_ONLY" : "CAPABILITY_ADAPTER_REQUIRED", status: 409 });
  }
  const protocolVersion = String(value.protocol_version || value.protocolVersion || "").trim();
  if (protocolVersion !== CAPABILITY_ORDER_PROTOCOL) throw Object.assign(new Error(`能力上报必须使用 ${CAPABILITY_ORDER_PROTOCOL}`), { code: "PROTOCOL_VERSION_UNSUPPORTED", status: 400 });
  const testedAt = new Date(value.validation?.tested_at || value.validation?.testedAt || value.validated_at || 0);
  const artifactSha256 = String(value.validation?.artifact_sha256 || value.validation?.artifactSha256 || "").trim().toUpperCase();
  const installed = value.installed === true;
  const validated = value.validated === true;
  const enabled = value.enabled === true;
  if (!installed || !validated || !enabled) throw Object.assign(new Error("能力必须同时处于已安装、已验证、已启用状态"), { code: "CAPABILITY_NOT_READY", status: 400 });
  if (Number.isNaN(testedAt.getTime()) || testedAt > new Date(now.getTime() + 5 * 60_000) || testedAt < new Date(now.getTime() - CAPABILITY_REPORT_MAX_AGE_MS)) throw Object.assign(new Error("能力真实推理验证时间无效或已过期"), { code: "CAPABILITY_VALIDATION_EXPIRED", status: 400 });
  if (!/^[A-F0-9]{64}$/.test(artifactSha256)) throw Object.assign(new Error("能力验证必须包含模型或运行产物 SHA-256"), { code: "CAPABILITY_VALIDATION_INVALID", status: 400 });
  const maxConcurrent = integer(value.max_concurrent ?? value.maxConcurrent, 1);
  if (maxConcurrent < 1 || maxConcurrent > 16) throw Object.assign(new Error("能力并发上限必须为 1–16"), { code: "VALIDATION_ERROR", status: 400 });
  const capabilityVersion = String(value.capability_version || value.capabilityVersion || "1").trim().slice(0, 80);
  const supportedModels = isGulongEngineCapability(capabilityId) && Array.isArray(value.supported_models)
    ? value.supported_models.filter((model) => typeof model === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(model)).slice(0, 32) : [];
  const supportedVoices = capabilityId === "gulong_engine.tts" && Array.isArray(value.supported_voices)
    ? [...new Set(value.supported_voices.filter((voice) => typeof voice === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(voice)))].slice(0, 64) : [];
  if (definition.requiredCapabilityVersion && (capabilityVersion !== definition.requiredCapabilityVersion
    || (capabilityId === "gulong_engine.image_2k" && !supportedModels.includes("qwen_image_2_1")))) {
    throw Object.assign(new Error(capabilityId === "gulong_engine.image_2k"
      ? "原生 2K 共享生图节点必须上报 1.0.0 合同与已验证的 Qwen-Image-2.1 模型"
      : `该能力节点必须上报 ${definition.requiredCapabilityVersion} 合同版本`), { code: "CAPABILITY_VERSION_UNSUPPORTED", status: 409 });
  }
  if (capabilityId === "gulong_engine.tts" && !supportedVoices.length) throw Object.assign(new Error("共享配音节点必须上报已实测可用的 supported_voices"), { code: "TTS_VOICE_REPORT_REQUIRED", status: 400 });
  return {
    capabilityId,
    capabilityVersion,
    protocolVersion,
    installed,
    validated,
    enabled,
    maxConcurrent,
    sharingOptIn: (isEnglishCapability(capabilityId) || isGulongEngineCapability(capabilityId) || isNativeSharedCapability(capabilityId)) && value.sharing_opt_in === true,
    supportedModels,
    supportedVoices,
    ...(isWorkLuckyCapability(capabilityId) ? normalizeSpecialNodeModels(capabilityId, value) : {}),
    validation: {
      acceptanceId: String(value.validation?.acceptance_id || value.validation?.acceptanceId || "").trim() || null,
      testedAt,
      artifactSha256,
      runtimeVersion: String(value.validation?.runtime_version || value.validation?.runtimeVersion || "").trim().slice(0, 120) || null,
      testId: String(value.validation?.test_id || value.validation?.testId || "").trim().slice(0, 120) || null,
    },
  };
}

export function capabilityNodeCanRunOrder(node, order) {
  if (!node || node.availableSlots < 1) return false;
  if (!computeGroupsMatch(order.computeGroupId, node.binding?.computeGroupId)) return false;
  if (order.preferredNodeId && order.preferredNodeId !== node.nodeId) return false;
  if (node.binding?.userId && String(node.binding.userId) !== String(order.requesterUserId)
    && !(order.sharingScope === "english_shared" && englishNodeSharesCapability(node, order.capabilityId))
    && !(order.sharingScope === "gulong_shared" && (gulongEngineNodeSharesCapability(node, order.capabilityId) || nativeNodeSharesCapability(node, order.capabilityId)))) return false;
  if (order.sharingScope === "gulong_shared" && isNativeSharedCapability(order.capabilityId) && !nativeNodeSharesCapability(node, order.capabilityId)) return false;
  return Boolean(node.capabilities?.some((item) => item.capabilityId === order.capabilityId
    && (!order.capabilityVersion || item.capabilityVersion === order.capabilityVersion)
    && item.installed && item.validated && item.enabled
    && automaticImageNodeMatchesOrder(item, order)
    && automaticNativeNodeMatchesOrder(item, order)
    && digitalLiveNodeMatchesOrder(item, order)
    && (!isWorkLuckyCapability(order.capabilityId) || (item.trustedAcceptance === true && (order.catalogProbe === true || specialNodeMatches(order, item))))
    && (order.capabilityId !== "gulong_engine.tts" || !order.parameters?.voice_id || item.supportedVoices?.includes(order.parameters.voice_id))
    && (order.capabilityId !== "gulong_engine.tts" || !order.parameters?.model || (item.trustedAcceptance === true
      && item.models?.some((model) => model.id === order.parameters.model && model.voice_id === order.parameters.voice_id)))
    && (!isGulongEngineCapability(order.capabilityId) || !order.parameters?.model || order.parameters.model === "auto"
      || isWorkLuckyCapability(order.capabilityId) || (item.supportedModels || []).includes(order.parameters.model))));
}
export function nativeNodeSharesCapability(node, id) {
  return isNativeSharedCapability(id) && node.capabilities?.some((item) => item.capabilityId === id && item.installed && item.validated && item.enabled
    && item.sharingOptIn === true && item.trustedAcceptance === true && item.automaticVerification === true
    && (item.contractTests?.exact_native_scope === true || id === "qwen_image_2_1.text_to_image" && item.contractTests?.exact_image_scope === true)) === true;
}
const isGulongCallable = (id) => isGulongEngineCapability(id) || isNativeSharedCapability(id);

function publicDefinition(item) {
  const rule = (entry) => ({
    role: entry.role,
    min_count: entry.min,
    max_count: entry.max,
    mime_types: entry.mimeTypes,
    max_bytes_per_file: entry.maxBytes,
  });
  return {
    capability_id: item.capabilityId,
    products: capabilityProducts(item.capabilityId),
    protocol_version: item.protocolVersion,
    parameters_schema_version: item.parametersSchemaVersion,
    parameters_schema: item.parametersSchema,
    input_assets: item.assetRules.map(rule),
    outputs: item.outputRules.map(rule),
    input_mime_types: item.inputMime,
    output_mime_types: item.outputMime,
    max_assets: item.maxAssets,
    max_total_input_bytes: item.maxTotalInputBytes,
    execution: {
      claim_lease_seconds: Math.floor(CAPABILITY_CLAIM_LEASE_MS / 1000),
      lease_renewal_statuses: ["started", "progress"],
      worker_state_poll_path: "/api/v1/capability-orders/{id}/worker-state?claim_id={claim_id}",
      default_eta_seconds: item.defaultEtaSeconds,
      max_runtime_seconds: item.maxRuntimeSeconds,
      max_attempts: 3,
    },
    price_fen: item.priceFen,
    commercial_use: item.commercialUse,
    dispatchable: item.dispatchable && !item.legacyRoute,
    ...(item.requiredCapabilityVersion ? { required_capability_version: item.requiredCapabilityVersion } : {}),
    adapter_status: item.legacyRoute ? "legacy_route" : item.adapterStatus,
    legacy_route: item.legacyRoute,
    ...(item.entitlement ? { entitlement: item.entitlement, sharing_scope: item.sharingScope, sharing_opt_in_required: true } : {}),
  };
}

function publicOrder(order, issueDownloadUrl, queue = null) {
  const results = (order.outputs || []).map((item) => ({
    output_id: item.outputId,
    role: item.role,
    filename: item.filename,
    content_type: item.contentType,
    bytes: item.bytes,
    sha256: item.sha256,
    ...(item.durationSeconds != null ? { duration_seconds: item.durationSeconds } : {}),
    download_url: issueDownloadUrl(item.objectKey, { expires: 15 * 60, filename: item.filename }),
    download_expires_in_seconds: 900,
  }));
  return {
    id: order._id.toString(),
    order_no: order.orderNo,
    protocol_version: order.protocolVersion,
    client_product: order.clientProduct || null,
    ...(order.clientProduct === DIGITAL_LIVE_PRODUCT_ID ? { client_request_id: order.clientRequestId || null } : {}),
    capability_id: order.capabilityId,
    capability_version: order.capabilityVersion || null,
    status: order.status,
    progress: integer(order.progress),
    stage: order.stage || null,
    elapsed_seconds: integer(order.elapsedSeconds),
    eta_seconds: order.etaSeconds == null ? null : integer(order.etaSeconds),
    queue_position: order.status === "queued" ? queue?.position ?? null : null,
    estimated_wait_seconds: order.status === "queued" ? queue?.estimatedWaitSeconds ?? null : null,
    queue_reason_code: order.status === "queued" ? queue?.reasonCode ?? null : null,
    queue_message: order.status === "queued" ? queue?.message ?? null : null,
    auto_cancel_at: order.autoCancelAt || null,
    attempt: integer(order.attempt),
    max_attempts: integer(order.maxAttempts),
    preferred_node_id: order.preferredNodeId || null,
    assigned_node: order.assignedNode ? { node_id: order.assignedNode.nodeId, node_name: order.assignedNode.nodeName || null } : null,
    billing: { currency: "CNY", price_fen: integer(order.priceFen), charge_status: order.chargeStatus, refund_status: order.refundStatus },
    inline_result: order.inlineResult || null,
    results,
    error: order.cancelReason === "queue_timeout"
      ? { code: "CAPABILITY_QUEUE_TIMEOUT", message: "排队截止前没有兼容节点完成任务，订单已自动结束。请稍后重试。" } : order.error || null,
    cancellation_tombstone: Boolean(order.cancellationTombstone),
    created_at: order.createdAt,
    claimed_at: order.claimedAt || null,
    completed_at: order.completedAt || null,
    cancelled_at: order.cancelledAt || null,
  };
}

function workerOrder(order, assets) {
  const capability = CAPABILITY_MAP.get(order.capabilityId);
  return {
    id: order._id.toString(),
    client_product: order.clientProduct || null,
    order_no: order.orderNo,
    protocol_version: order.protocolVersion,
    capability_id: order.capabilityId,
    capability_version: order.capabilityVersion,
    parameters: order.parameters,
    parameters_schema_version: capability.parametersSchemaVersion,
    ...(requiredNativeOutputRoles(order).length ? { required_output_roles: requiredNativeOutputRoles(order) } : {}),
    assets,
    assigned_node: { node_id: order.assignedNode.nodeId, node_name: order.assignedNode.nodeName || null },
    claim_id: order.claimId,
    attempt: order.attempt,
    max_attempts: order.maxAttempts,
    progress_callback: { url: "/api/v1/capability-orders/callback", statuses: ["started", "progress", "completed", "failed", "cancelled"], first_required_fields: ["estimated_total_seconds"], renews_lease_on: ["started", "progress"], lease_seconds: Math.floor(CAPABILITY_CLAIM_LEASE_MS / 1000) },
    output_upload: { presign_url: `/api/v1/capability-orders/${order._id}/outputs/presign`, method: "POST", direct_to_cos: true, callback_accepts_files: false },
    worker_state: { method: "GET", url: `/api/v1/capability-orders/${order._id}/worker-state?claim_id=${encodeURIComponent(order.claimId)}`, poll_interval_seconds: 15 },
    lease_expires_at: order.claimLeaseUntil,
  };
}

export function registerCapabilityOrderRoutes(app, dependencies) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const enforceRateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  const issueDownloadUrl = dependencies.createPresignedDownloadUrl || createPresignedDownloadUrl;
  const issueUploadUrl = dependencies.createPresignedPutUrl || createPresignedPutUrl;
  const inspectCosObject = dependencies.headObject || headObject;
  const verifyAudioObject = dependencies.verifyAudioObject || ((grant) => verifyCapabilityAudioDigest(grant.objectKey, grant.bytes, grant.sha256, { issueDownloadUrl }));
  const removeCosObject = dependencies.deleteObject || deleteObject;
  const publishCosObject = dependencies.copyObject || copyObject;
  const ensureUploadCors = dependencies.ensureBrowserUploadCors || ensureBrowserUploadCors;
  const requireSingleWriteUploads = dependencies.assertSingleWriteUploads || assertSingleWriteUploads;
  const { authenticate, requireTrustedMutation } = dependencies;
  const englishEntitlement = dependencies.readEnglishEntitlement || ((ownerId, now) => readEnglishEntitlement(ownerId, now, getCollection));
  const gulongEntitlement = dependencies.readGulongEngineEntitlement || ((ownerId, now) => readGulongEngineEntitlement(ownerId, now, getCollection));
  const requestKey = (ownerId, key) => createHash("sha256").update(`${ownerId}:${key}`).digest("hex");
  const readUserGroup = dependencies.getUserComputeGroupId || ((userId) => getUserComputeGroupId(userId, getCollection));
  const slots = dependencies.slotCoordinator || createCapabilitySlotCoordinator({ getCollection });
  const verificationMedia = dependencies.verificationMedia || createCapabilityVerificationMedia({ getCollection });
  const automaticVerification = dependencies.automaticVerification || createCapabilityAutoVerificationService({
    getCollection, enforceRateLimit, ...verificationMedia,
    issueProbeInputDownloads: dependencies.issueProbeInputDownloads || createProbeFixtureIssuer({ fixtures: CAPABILITY_PROBE_FIXTURES }),
    adapters: { ...createCapabilityVerificationAdapters({ verifyMediaOutputs: verificationMedia.verifyMediaOutputs }),
      ...createNativeCapabilityVerificationAdapters({ verifyMediaOutputs: verificationMedia.verifyMediaOutputs }) },
    canProbe: async ({ binding, resources, now }) => {
      const load = normalizeGpuLoadReport(resources, now);
      if (load.gpu_state !== "idle" || load.current_task_remaining_seconds !== 0 || resources.running_task_count !== 0) return false;
      const snapshot = await slots.snapshot({ bindingId: binding._id, now });
      if (!snapshot.available || snapshot.activeCount) return false;
      const h3Task = await (await getCollection("h3SharedTasks")).findOne({ "claimedByNode.bindingId": binding._id,
        status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $gt: now } });
      return !h3Task;
    },
    acquireExecution: async ({ binding, challengeId, expiresAt }) => Boolean(await slots.reserve({
      bindingId: binding._id, nodeId: binding.nodeId, userId: binding.userId, capabilityId: "system.verification",
      claimId: challengeId, taskId: challengeId, maxConcurrentTasks: 1, capabilityMaxConcurrent: 1,
      exclusive: true, estimatedSeconds: 900, now: new Date(), expiresAt,
    })),
    releaseExecution: ({ bindingId, challengeId }) => slots.release({ bindingId, claimId: challengeId, taskId: challengeId, now: new Date() }),
  });
  const trustedAcceptance = dependencies.findTrustedConsumerAcceptance || (async (bindingId, report, now) =>
    (await automaticVerification.findTrusted({ bindingId, report: report.verificationInventory || report, now }))
      || findTrustedConsumerAcceptance({ getCollection, bindingId, report, now }));
  const verifyFlacObject = dependencies.verifyFlacObject || (async (grant) => {
    const response = await fetch(issueDownloadUrl(grant.objectKey, { expires: 120 }), { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error("完整音乐文件暂时无法读取");
    return inspectFlacStream(response.body, { expectedBytes: grant.bytes, expectedSha256: grant.sha256, maxBytes: 64 * 1024 * 1024 });
  });
  const slotFence = (order) => ({ bindingId: order.assignedNode?.bindingId, nodeId: order.assignedNode?.nodeId,
    userId: order.assignedNode?.userId, capabilityId: order.capabilityId, claimId: order.claimId, taskId: order._id });
  const releaseOrderSlot = (order) => order.slotLeaseRequired ? slots.release(slotFence(order)) : Promise.resolve(false);
  async function hasOrderSlot(order, now = new Date()) {
    if (!order.slotLeaseRequired) return true;
    const snapshot = await slots.snapshot({ bindingId: order.assignedNode?.bindingId, now });
    return snapshot.available && snapshot.leases.some((lease) => lease.claimId === order.claimId && lease.taskId === String(order._id)
      && lease.nodeId === order.assignedNode.nodeId && lease.userId === String(order.assignedNode.userId));
  }
  async function trustReports(binding, reports, now, lookup = trustedAcceptance) {
    return Promise.all(reports.map(async (report) => {
      const accepted = await lookup(binding._id, report, now);
      if (accepted?.source === "automatic") return { ...report, models: accepted.models, defaultModel: accepted.defaultModel,
        supportedModels: accepted.models.map((model) => model.id), supportedVoices: accepted.models.map((model) => model.voice_id).filter(Boolean),
        contractTests: accepted.contractTests, asrLanguages: accepted.asrLanguages, trustedAcceptance: true, automaticVerification: true };
      if (requiresAutomaticCapabilityVerification(binding, report.capabilityId)) return { ...report, validated: false, trustedAcceptance: false };
      return isWorkLuckyCapability(report.capabilityId) ? { ...report, trustedAcceptance: Boolean(accepted) } : report;
    }));
  }

  async function readyReports(binding, reports, now, lookupAutomatic = (bindingId, report, instant) => automaticVerification.findTrusted({ bindingId, report, now: instant })) {
    const ready = [];
    for (const report of reports) {
      const acceptance = await lookupAutomatic(binding._id, report.verificationInventory || report, now);
      if (!acceptance) {
        // Candidate inventory is allowed on the separate verification route,
        // never promoted by its own validated flag or a pending challenge.
        if (report.validated !== true || requiresAutomaticCapabilityVerification(binding, report.capability_id ?? report.capabilityId) || report.verificationInventory) continue;
        ready.push(normalizeCapabilityReport(report, now, { allowLegacyEnglishOrders: true })); continue;
      }
      const normalized = normalizeCapabilityReport({ ...report, validated: true, models: acceptance.models,
        default_model: acceptance.defaultModel, asr_languages: acceptance.asrLanguages,
        supported_models: acceptance.models.map((model) => model.id), supported_voices: acceptance.models.map((model) => model.voice_id).filter(Boolean),
        validation: { ...(report.validation || {}), tested_at: acceptance.testedAt, artifact_sha256: acceptance.artifactSha256,
          contract_tests: acceptance.contractTests } }, now, { allowLegacyEnglishOrders: true });
      ready.push({ ...normalized, models: acceptance.models, trustedAcceptance: true, automaticVerification: true, verificationInventory: report.verificationInventory || report });
    }
    return ready;
  }

  async function workerGroupError(c, order, auth) {
    const [groupId, currentBinding] = await Promise.all([
      readUserGroup(order.requesterUserId),
      (await getCollection("nodeAccountBindings")).findOne({ _id: auth.binding._id, userId: auth.user._id, nodeId: auth.binding.nodeId,
        tokenHash: auth.binding.tokenHash, status: "active", revokedAt: null }),
    ]);
    if (!currentBinding) return c.json({ code: "INVALID_ACCOUNT_BINDING", message: "执行节点账号绑定已失效，请停止当前任务并重新绑定" }, 401);
    if (!computeGroupsMatch(order.computeGroupId, groupId) || !computeGroupsMatch(order.computeGroupId, currentBinding.computeGroupId)) return c.json({ code: "COMPUTE_GROUP_MISMATCH", message: "执行节点与订单所属算力分组不一致，禁止跨分组调用" }, 403);
    return null;
  }

  async function gulongAvailability(capabilityId, ownerId, { order = null, nativeShared = false, clientProduct = null, now = new Date() } = {}) {
    const capability = CAPABILITY_MAP.get(capabilityId);
    if (!capability?.dispatchable) return { verified_node_count: 0, free_slot_count: 0, status: "adapter_required" };
    const reports = await (await getCollection("capabilityNodeReports"))
      .find({ "capabilities.capabilityId": capabilityId, reportedAt: { $gte: new Date(now.getTime() - 3 * 60_000) } })
      .limit(200).toArray();
    if (!reports.length) return { verified_node_count: 0, free_slot_count: 0, status: "offline", ...specialAvailability(capabilityId, []),
      ...nativeVerificationAvailability(capabilityId, []), ...(capabilityId === "gulong_engine.tts" ? { voice_ids: [] } : {}) };
    const computeGroupId = await readUserGroup(ownerId);
    const bindings = await (await getCollection("nodeAccountBindings"))
      .find({ _id: { $in: reports.map((report) => report.bindingId) }, status: "active", revokedAt: null }).toArray();
    const activeBindings = new Map(bindings.map((binding) => [String(binding._id), binding]));
    let nodeCount = 0;
    let freeSlots = 0;
    const voiceIds = new Set();
    const acceptedReports = [];
    for (const report of reports) {
      const binding = activeBindings.get(String(report.bindingId));
      if (!binding || binding.nodeId !== report.nodeId || String(binding.userId) !== String(report.userId)
        || report.protocolVersion !== CAPABILITY_ORDER_PROTOCOL) continue;
      let reportedCapability = report.capabilities?.find((item) => item.capabilityId === capabilityId
        && item.installed && item.validated && item.enabled
        && (!capability.requiredCapabilityVersion || (item.capabilityVersion === capability.requiredCapabilityVersion
          && (capabilityId !== "gulong_engine.image_2k" || item.supportedModels?.includes("qwen_image_2_1"))))
        && new Date(item.validation?.testedAt || 0) >= new Date(now.getTime() - CAPABILITY_REPORT_MAX_AGE_MS));
      if (!reportedCapability) continue;
      const nodeUser = await (await getCollection("users")).findOne({ _id: binding.userId, status: "active" });
      if (!nodeUser) continue;
      if (isWorkLuckyCapability(capabilityId) || requiresAutomaticCapabilityVerification(binding, capabilityId) || reportedCapability.verificationInventory) {
        const accepted = await trustedAcceptance(binding._id, reportedCapability, now);
        if (!accepted || requiresAutomaticCapabilityVerification(binding, capabilityId) && accepted.source !== "automatic") continue;
        reportedCapability = { ...reportedCapability, trustedAcceptance: true, ...(accepted.source === "automatic" ? {
          models: accepted.models, defaultModel: accepted.defaultModel, contractTests: accepted.contractTests, asrLanguages: accepted.asrLanguages, automaticVerification: true,
          supportedModels: accepted.models.map((model) => model.id), supportedVoices: accepted.models.map((model) => model.voice_id).filter(Boolean),
        } : {}) };
      }
      if ((order?.clientProduct || clientProduct) === DIGITAL_LIVE_PRODUCT_ID) {
        reportedCapability = digitalLiveReport(reportedCapability);
        if (!reportedCapability) continue;
      }
      const resource = normalizeCapabilityResources(report.resources, reportedCapability.maxConcurrent);
      const snapshot = await slots.snapshot({ bindingId: binding._id, now });
      if (!snapshot.available) continue;
      const availableSlots = snapshot.leases.some((lease) => lease.exclusive === true) ? 0 : Math.max(0, Math.min(reportedCapability.maxConcurrent - (snapshot.byCapability[capabilityId] || 0),
        resource.max_concurrent_tasks - resource.running_task_count - snapshot.activeCount));
      if (!capabilityNodeCanRunOrder({ nodeId: report.nodeId, binding, availableSlots: Math.max(1, availableSlots), capabilities: [reportedCapability] },
        { ...(order || { capabilityId, requesterUserId: ownerId, catalogProbe: true, clientProduct,
          sharingScope: isEnglishCapability(capabilityId) ? "english_shared" : isGulongEngineCapability(capabilityId) || nativeShared && isNativeSharedCapability(capabilityId) ? "gulong_shared" : null,
          capabilityVersion: capability.requiredCapabilityVersion || null,
          parameters: capabilityId === "gulong_engine.image_2k" ? { model: "qwen_image_2_1" } : {} }), computeGroupId })) continue;
      nodeCount += 1;
      freeSlots += availableSlots;
      acceptedReports.push(reportedCapability);
      if (capabilityId === "gulong_engine.tts") for (const voice of reportedCapability.supportedVoices || []) voiceIds.add(voice);
    }
    return { verified_node_count: nodeCount, free_slot_count: freeSlots, status: freeSlots ? "ready" : nodeCount ? "busy" : "offline",
      ...specialAvailability(capabilityId, acceptedReports),
      ...nativeVerificationAvailability(capabilityId, acceptedReports),
      ...((order?.clientProduct || clientProduct) === DIGITAL_LIVE_PRODUCT_ID ? digitalLiveAvailability(capabilityId, acceptedReports) : {}),
      ...(capabilityId === "gulong_engine.tts" ? { voice_ids: [...voiceIds].sort() } : {}) };
  }

  async function queueSnapshot(order) {
    if (order.status !== "queued" || !order.capabilityId) return null;
    const position = await (await getCollection("capabilityOrders")).countDocuments({
      capabilityId: order.capabilityId, status: "queued",
      ...computeGroupFilter(await readUserGroup(order.requesterUserId)),
      $or: [{ createdAt: { $lt: order.createdAt } }, { createdAt: order.createdAt, _id: { $lte: order._id } }],
    });
    const availability = isGulongEngineCapability(order.capabilityId)
      ? await gulongAvailability(order.capabilityId, order.requesterUserId, { order }) : null;
    return {
      position,
      estimatedWaitSeconds: availability?.free_slot_count
        ? Math.ceil(Math.max(0, position - 1) * CAPABILITY_MAP.get(order.capabilityId).defaultEtaSeconds / availability.free_slot_count) : null,
      reasonCode: availability?.status === "offline" ? "NO_COMPATIBLE_NODE" : availability?.status === "busy" ? "NODES_BUSY" : null,
      message: availability?.status === "offline" ? "当前没有在线且已验证的兼容共享节点，任务仍在排队；截止前仍无人接单将自动结束。"
        : availability?.status === "busy" ? "兼容节点正在处理其他任务，当前继续排队。" : null,
    };
  }

  async function requireEnglish(c, ownerId) {
    const entitlement = await englishEntitlement(ownerId, new Date());
    return entitlement.active ? null : c.json({ code: "ENGLISH_SUBSCRIPTION_REQUIRED", message: "请开通生效中的英语教练月套餐后使用共享英语能力", entitlement }, 403);
  }
  async function requireGulong(c, ownerId) {
    const entitlement = await gulongEntitlement(ownerId, new Date());
    return entitlement.active ? null : c.json({ code: "GULONG_ENGINE_SUBSCRIPTION_REQUIRED", message: "请开通生效中的古龙绿色版月套餐后使用共享能力", entitlement }, 403);
  }
  const clientMayReadOrder = (auth, order) => auth.kind !== "desktop-english" || isEnglishCapability(order.capabilityId) || order.cancellationTombstone;
  const scopedMayReadOrder = (auth, order) => clientMayReadOrder(auth, order)
    && (auth.kind !== "desktop-gulong-engine" || isGulongCallable(order.capabilityId) || order.cancellationTombstone);
  const workerOwnsClaim = (order, auth) => englishWorkerOwnsClaim(order, auth)
    || (isGulongEngineCapability(order.capabilityId) && order.sharingScope === "gulong_shared"
      && String(order.assignedNode?.userId) === String(auth.user._id)
      && String(order.assignedNode?.bindingId) === String(auth.binding._id));

  async function cancelOwnedOrder(order, now = new Date()) {
    const orders = await getCollection("capabilityOrders");
    if (!CAPABILITY_TERMINAL.has(order.status)) {
      await orders.updateOne({ _id: order._id, requesterUserId: order.requesterUserId, status: { $nin: [...CAPABILITY_TERMINAL] } },
        { $set: { status: "cancelled", stage: "cancelled", cancelReason: "requester_cancelled", cancelledAt: now, updatedAt: now }, $unset: { claimLeaseUntil: "" } });
      await (await getCollection("capabilityOutputUploads")).updateMany({ orderId: order._id, status: "issued" }, { $set: { status: "expired", expiredAt: now, updatedAt: now } });
    }
    return orders.findOne({ _id: order._id, requesterUserId: order.requesterUserId });
  }

  async function authenticateBinding(c, requiredNodeId = null) {
    const raw = String(c.req.header(CAPABILITY_BINDING_HEADER) || "").trim();
    if (!/^gab_[A-Za-z0-9_-]{40,}$/.test(raw)) return { error: c.json({ code: "ACCOUNT_BINDING_REQUIRED", message: "请先在已激活桌面端绑定官网账号" }, 401) };
    const binding = await (await getCollection("nodeAccountBindings")).findOne({ tokenHash: hashOpaqueToken(raw, "h3-account-binding"), status: "active", revokedAt: null });
    if (!binding) return { error: c.json({ code: "INVALID_ACCOUNT_BINDING", message: "账号绑定已失效，请重新绑定" }, 401) };
    if (requiredNodeId && binding.nodeId !== requiredNodeId) return { error: c.json({ code: "NODE_BINDING_MISMATCH", message: "回调节点不是订单指定的执行节点" }, 403) };
    const user = await (await getCollection("users")).findOne({ _id: binding.userId, status: "active" });
    if (!user) return { error: c.json({ code: "INVALID_ACCOUNT_BINDING", message: "绑定账户已失效" }, 401) };
    return { binding, user };
  }

  registerCapabilityAutoVerificationRoutes(app, { service: automaticVerification, requireBinding: authenticateBinding,
    requireAdmin: dependencies.requireAdmin || (async (c) => ({ error: c.json({ code: "FORBIDDEN", message: "仅管理员可查询共享模型状态" }, 403) })) });

  async function recoverExpired(now = new Date()) {
    const orders = await getCollection("capabilityOrders");
    const expired = await orders.find({ status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $lte: now } }).limit(100).toArray();
    for (const order of expired) {
      let recovered;
      const expiredFence = { _id: order._id, status: order.status, claimId: order.claimId, claimLeaseUntil: order.claimLeaseUntil };
      if (integer(order.attempt) < integer(order.maxAttempts, 2)) {
        recovered = await orders.findOneAndUpdate(expiredFence, { $set: { status: "queued", stage: "retry_wait", nextEligibleAt: now, updatedAt: now }, $unset: { assignedNode: "", claimId: "", claimLeaseUntil: "", claimedAt: "" } }, { returnDocument: "after" });
      } else {
        recovered = await orders.findOneAndUpdate(expiredFence, { $set: { status: "failed", stage: "failed", error: { code: "CAPABILITY_EXECUTION_TIMEOUT", message: "节点执行超时，已达到最大重试次数" }, failedAt: now, updatedAt: now } }, { returnDocument: "after" });
      }
      if (recovered) await releaseOrderSlot(order);
    }
    await orders.updateMany({ status: "queued", autoCancelAt: { $lte: now } }, { $set: { status: "cancelled", stage: "cancelled", cancelReason: "queue_timeout", error: { code: "CAPABILITY_QUEUE_TIMEOUT", message: "排队截止前没有兼容节点完成任务，订单已自动结束。请稍后重试。" }, cancelledAt: now, updatedAt: now } });
  }

  async function ownedAssets(ownerId, refs, capability, clientProduct) {
    if (!refs.length) return [];
    if (refs.some((item) => !ObjectId.isValid(item.asset_id))) throw Object.assign(new Error("输入素材引用无效"), { code: "ASSET_NOT_READY", status: 409 });
    const ids = refs.map((item) => new ObjectId(item.asset_id));
    const records = await (await getCollection("capabilityAssetUploads")).find({ _id: { $in: ids }, ownerId, status: "ready" }).toArray();
    const byId = new Map(records.map((item) => [item._id.toString(), item]));
    const assets = refs.map((ref) => {
      const record = byId.get(ref.asset_id);
      if (!record) throw Object.assign(new Error("输入素材尚未完成校验或不属于当前账户"), { code: "ASSET_NOT_READY", status: 409 });
      if (record.clientProduct && (clientProductConflicts(record, clientProduct) || record.capabilityId !== capability.capabilityId || record.assetRole !== ref.role)) {
        throw Object.assign(new Error("素材属于其他产品、能力或输入角色，不能跨用途复用"), { code: "ASSET_SCOPE_MISMATCH", status: 409 });
      }
      return { assetId: record._id.toString(), role: String(ref.role || "input").slice(0, 80), filename: record.filename, contentType: record.contentType, bytes: record.bytes, sha256: record.sha256, objectKey: record.objectKey };
    });
    return assets;
  }

  function claimAssets(assets) {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return assets.map((asset) => ({ asset_id: asset.assetId, role: asset.role, filename: asset.filename, content_type: asset.contentType, bytes: asset.bytes, sha256: asset.sha256, download_url: issueDownloadUrl(asset.objectKey, { expires: 15 * 60, filename: asset.filename }), download_expires_at: expiresAt }));
  }

  function requestedClientProduct(c, auth, body) {
    const query = c.req.queries("product");
    const bodyProduct = body?.client_product;
    if ((query && (query.length !== 1 || !["worklucky", "gulong_engine", DIGITAL_LIVE_PRODUCT_ID].includes(query[0])))
      || (bodyProduct !== undefined && !["worklucky", "gulong_engine", DIGITAL_LIVE_PRODUCT_ID].includes(bodyProduct))
      || (bodyProduct !== undefined && query?.[0] && bodyProduct !== query[0])) {
      return { error: c.json({ code: "PRODUCT_CAPABILITY_MISMATCH", message: "产品参数不正确，请使用 WorkLucky、古龙引擎或数字直播的独立标记" }, 400) };
    }
    const clientProduct = bodyProduct ?? query?.[0];
    if (clientProduct && auth.kind === "desktop-english") {
      return { error: c.json({ code: "PRODUCT_CAPABILITY_MISMATCH", message: "英语教练凭据不能访问或取消 WorkLucky 产品请求" }, 403) };
    }
    return { clientProduct };
  }
  const productScopeConflict = (c) => c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "该请求属于其他客户端产品，不能跨产品读取、取消或复用" }, 409);

  const assetRequestPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/;
  const assetRequestKey = (ownerId, key) => createHash("sha256").update(`capability-asset:${ownerId}:${key}`).digest("hex");
  const assetReceipt = (asset) => ({ asset_id: String(asset._id), filename: asset.filename, content_type: asset.contentType, bytes: asset.bytes, sha256: asset.sha256 });
  const assetHeadMatches = (asset, head) => objectBytes(head) === asset.bytes
    && objectHeader(head, "x-cos-meta-sha256").toUpperCase() === asset.sha256
    && objectHeader(head, "x-cos-meta-bytes") === String(asset.bytes)
    && objectHeader(head, "x-cos-meta-owner-id") === String(asset.ownerId)
    && objectHeader(head, "x-cos-meta-capability-asset-id") === String(asset._id)
    && (!asset.assetRequestKey || objectHeader(head, "content-type").split(";")[0].trim().toLowerCase() === asset.contentType);
  function assetPutTicket(asset) {
    const remaining = Math.floor((+new Date(asset.expiresAt) - Date.now()) / 1000);
    if (remaining < 1) return null;
    const headers = { "Content-Type": asset.contentType, "x-cos-meta-sha256": asset.sha256, "x-cos-meta-bytes": String(asset.bytes),
      "x-cos-meta-owner-id": String(asset.ownerId), "x-cos-meta-capability-asset-id": String(asset._id), "x-cos-forbid-overwrite": "true" };
    return { asset_id: String(asset._id), upload_url: issueUploadUrl(asset.objectKey, { expires: Math.min(3600, remaining), headers }),
      method: "PUT", headers, object_key: asset.objectKey, expires_at: new Date(asset.expiresAt).toISOString() };
  }
  async function recoverAsset(c, asset, { created = false } = {}) {
    const common = { asset_id: String(asset._id), asset: assetReceipt(asset), client_product: asset.clientProduct,
      capability_id: asset.capabilityId, role: asset.assetRole, idempotent: !created, can_upload: false, can_complete: false };
    c.header("Cache-Control", "private, no-store, max-age=0");
    if (asset.status === "ready") return c.json({ ...common, stage: "ready" }, created ? 201 : 200);
    if (asset.status !== "uploading") return c.json({ ...common, stage: "rejected", code: "ASSET_RECEIPT_MISMATCH", message: "该素材已被拒绝，不能重新签发上传凭据" }, 409);
    if (!Number.isFinite(+new Date(asset.expiresAt)) || +new Date(asset.expiresAt) <= Date.now()) {
      return c.json({ ...common, stage: "expired", code: "ASSET_UPLOAD_EXPIRED", message: "原素材上传授权已过期，请勿自动换编号重传" }, 410);
    }
    if (!created) {
      let head, missing = false;
      try { head = await inspectCosObject(asset.objectKey); }
      catch (error) {
        if (error?.statusCode !== 404 && error?.status !== 404 && error?.code !== "NoSuchKey") {
          return c.json({ ...common, stage: "unknown", code: "ASSET_RECOVERY_UNAVAILABLE", message: "暂时无法确认原素材状态，请只重试查询，不要重复上传" }, 503);
        }
        missing = true;
      }
      if (head) {
        if (!assetHeadMatches(asset, head)) return c.json({ ...common, stage: "mismatch", code: "ASSET_RECEIPT_MISMATCH", message: "原素材对象与清单不一致，禁止重传覆盖" }, 409);
        return c.json({ ...common, stage: "uploaded", can_complete: true });
      }
      if (!missing) return c.json({ ...common, stage: "unknown", code: "ASSET_RECOVERY_UNAVAILABLE", message: "原素材状态未确认，请只重试查询" }, 503);
    }
    try { await requireSingleWriteUploads(); await ensureUploadCors(); }
    catch (error) { return c.json({ ...common, stage: "unknown", code: error.code || "ASSET_RECOVERY_UNAVAILABLE",
      message: error.status === 409 ? "当前存储桶不支持防覆盖续传，请联系管理员，勿重复上传" : "暂时无法核对防覆盖策略，请只重试查询" }, error.status === 409 ? 409 : 503); }
    const ticket = assetPutTicket(asset);
    if (!ticket) return c.json({ ...common, stage: "expired", code: "ASSET_UPLOAD_EXPIRED", message: "原素材上传授权已过期" }, 410);
    return c.json({ ...common, ...ticket, stage: "awaiting_upload", can_upload: true }, created ? 201 : 200);
  }

  app.get("/api/v1/capability-assets/by-request/:key", async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const auth = await authenticate(c); if (auth.error) return auth.error;
    if (auth.kind === "desktop-english") return c.json({ code: "GULONG_ENGINE_CAPABILITY_ONLY", message: "英语教练凭据不能查询其他产品的可恢复素材" }, 403);
    const product = requestedClientProduct(c, auth); if (product.error) return product.error;
    const key = c.req.param("key");
    if (!assetRequestPattern.test(key)) return c.json({ code: "VALIDATION_ERROR", message: "素材请求编号格式不正确" }, 400);
    const rate = await enforceRateLimit(`capability-asset-recovery:${auth.user.id}`, { limit: 120, windowMs: 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "素材状态查询过于频繁，请稍后重试" }, 429);
    c.header("Cache-Control", "private, no-store, max-age=0");
    const asset = await (await getCollection("capabilityAssetUploads")).findOne({ ownerId: new ObjectId(auth.user.id), assetRequestKey: assetRequestKey(auth.user.id, key) });
    if (!asset) return c.json({ code: "ASSET_NOT_FOUND", message: "尚无该素材请求" }, 404);
    if (clientProductConflicts(asset, product.clientProduct)) return productScopeConflict(c);
    return recoverAsset(c, asset);
  });

  app.get("/api/v1/desktop/digital-live/config", (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const products = c.req.queries("product");
    if (products && (products.length !== 1 || products[0] !== DIGITAL_LIVE_PRODUCT_ID)) return c.json({ code: "PRODUCT_CAPABILITY_MISMATCH", message: "请使用数字直播产品入口" }, 400);
    return c.json(digitalLiveConfig(GULONG_ENGINE_MONTHLY_PRICE_FEN));
  });
  app.get("/api/v1/capability-orders/catalog", async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const product = requestedClientProduct(c, auth); if (product.error) return product.error;
    const definitions = auth.kind === "desktop-english" ? CAPABILITY_ORDER_DEFINITIONS.filter((item) => isEnglishCapability(item.capabilityId))
      : auth.kind === "desktop-gulong-engine" ? CAPABILITY_ORDER_DEFINITIONS.filter((item) => isGulongCallable(item.capabilityId)) : CAPABILITY_ORDER_DEFINITIONS;
    c.header("Cache-Control", "private, no-store, max-age=0");
    const requestedProduct = product.clientProduct;
    const capabilities = definitions.map(publicDefinition).filter((item) => !requestedProduct || item.products.includes(requestedProduct));
    for (const item of capabilities.filter((entry) => !entry.legacy_route)) {
      item.availability = await gulongAvailability(item.capability_id, auth.user.id, { nativeShared: Boolean(requestedProduct) || auth.kind === "desktop-gulong-engine", clientProduct: requestedProduct });
      item.dispatchable = item.dispatchable && item.availability.verified_node_count > 0;
    }
    return c.json({ protocol_version: CAPABILITY_ORDER_PROTOCOL, ...(requestedProduct ? { product: requestedProduct } : {}), capabilities });
  });

  app.post("/api/v1/capability-assets/presign", async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`capability-asset:${auth.user.id}`, { limit: 60, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "素材上传请求过于频繁" }, 429);
    const body = await boundedRequestJson(c);
    const product = requestedClientProduct(c, auth, body); if (product.error) return product.error;
    const clientProduct = product.clientProduct;
    const filename = sanitizeFilename(body.filename, "asset.bin");
    const contentType = String(body.content_type || "application/octet-stream").trim().toLowerCase();
    const bytes = integer(body.bytes, -1);
    const sha256 = String(body.sha256 || "").trim().toUpperCase();
    const hasRequestKey = body.request_key !== undefined;
    const purpose = CAPABILITY_MAP.get(body.capability_id);
    const inputRule = purpose?.assetRules.find((rule) => rule.role === body.role && rule.mimeTypes.includes(contentType) && bytes > 0 && bytes <= rule.maxBytes);
    if (hasRequestKey && (!clientProduct || typeof body.request_key !== "string" || !assetRequestPattern.test(body.request_key)
      || typeof body.filename !== "string" || !body.filename.trim() || body.filename.length > 400 || typeof body.content_type !== "string"
      || !Number.isSafeInteger(body.bytes) || typeof body.sha256 !== "string"
      || !purpose?.dispatchable || !capabilityProducts(body.capability_id).includes(clientProduct) || !inputRule)) {
      return c.json({ code: "CAPABILITY_ASSET_REQUEST_INVALID", message: "可恢复素材必须包含正确的原请求编号、产品、能力、角色及素材清单" }, 400);
    }
    if (auth.kind === "desktop-english") {
      const rejected = await requireEnglish(c, auth.user.id); if (rejected) return rejected;
      return c.json({ code: "CAPABILITY_LOCAL_ONLY", message: "英语教练录音已在桌面端本地处理，不再上传新素材" }, 409);
    }
    if (auth.kind === "desktop-gulong-engine") {
      const rejected = await requireGulong(c, auth.user.id); if (rejected) return rejected;
      const nativePurpose = isNativeSharedCapability(body.capability_id) ? CAPABILITY_MAP.get(body.capability_id) : null;
      const nativeAllowed = nativePurpose?.assetRules.some((rule) => rule.mimeTypes.includes(contentType) && bytes > 0 && bytes <= rule.maxBytes);
      if (!nativeAllowed && !gulongEngineUploadAllowed(contentType, bytes)) return c.json({ code: "CAPABILITY_INPUT_LIMIT_EXCEEDED", message: "古龙共享素材仅支持目录内的图片、视频或音频格式及相应大小上限" }, 400);
      if (!nativeAllowed && !IMAGE_MIME.includes(contentType) && !CAPABILITY_MAP.get("gulong_engine.video")?.dispatchable) {
        return c.json({ code: "CAPABILITY_ADAPTER_REQUIRED", message: "视频能力尚未完成真实节点适配，暂不开放视频或音频参考素材上传" }, 409);
      }
    }
    if (bytes < 1 || bytes > CAPABILITY_MAX_ASSET_BYTES || !/^[A-F0-9]{64}$/.test(sha256) || !/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(contentType)) return c.json({ code: "VALIDATION_ERROR", message: "素材类型、大小或 SHA-256 不正确" }, 400);
    const ownerId = new ObjectId(auth.user.id);
    const uploads = await getCollection("capabilityAssetUploads");
    const requestIdentity = hasRequestKey ? assetRequestKey(ownerId, body.request_key) : null;
    const manifestFingerprint = hasRequestKey ? requestFingerprint({ filename, contentType, bytes, sha256, capabilityId: purpose.capabilityId, role: body.role, clientProduct }) : null;
    if (requestIdentity) {
      const existing = await uploads.findOne({ ownerId, assetRequestKey: requestIdentity });
      if (existing) {
        if (clientProductConflicts(existing, clientProduct) || existing.assetManifestFingerprint !== manifestFingerprint) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "同一素材请求编号不能跨产品或更改清单" }, 409);
        return recoverAsset(c, existing);
      }
      if (auth.kind !== "desktop-gulong-engine" && auth.user.role !== "admin") { const rejected = await requireGulong(c, ownerId); if (rejected) return rejected; }
    }
    await ensureUploadCors();
    const uploadId = new ObjectId();
    const objectKey = `capability-orders/${ownerId}/inputs/${uploadId}-${filename}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const headers = { "Content-Type": contentType, "x-cos-meta-sha256": sha256, "x-cos-meta-bytes": String(bytes), "x-cos-meta-owner-id": ownerId.toString(), "x-cos-meta-capability-asset-id": uploadId.toString() };
    const record = { _id: uploadId, ownerId, filename, contentType, bytes, sha256, objectKey, status: "uploading", createdAt: now, updatedAt: now, expiresAt,
      ...(requestIdentity ? { assetRequestKey: requestIdentity, assetManifestFingerprint: manifestFingerprint, clientProduct, capabilityId: purpose.capabilityId, assetRole: body.role } : {}) };
    try { await uploads.insertOne(record); }
    catch (error) {
      if (!requestIdentity || error?.code !== 11000) throw error;
      const winner = await uploads.findOne({ ownerId, assetRequestKey: requestIdentity });
      if (!winner || clientProductConflicts(winner, clientProduct) || winner.assetManifestFingerprint !== manifestFingerprint) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "并发素材请求清单冲突" }, 409);
      return recoverAsset(c, winner);
    }
    if (requestIdentity) return recoverAsset(c, record, { created: true });
    return c.json({ asset_id: uploadId.toString(), upload_url: issueUploadUrl(objectKey, { expires: 3600, headers }), method: "PUT", headers, object_key: objectKey, expires_at: expiresAt.toISOString() }, 201);
  });

  app.post("/api/v1/capability-assets/:id/complete", async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const product = requestedClientProduct(c, auth); if (product.error) return product.error;
    const rate = await enforceRateLimit(`capability-asset-complete:${auth.user.id}`, { limit: 120, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "素材校验请求过于频繁，请稍后重试" }, 429);
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ASSET_NOT_FOUND", message: "素材不存在" }, 404);
    const uploads = await getCollection("capabilityAssetUploads");
    const ready = await uploads.findOne({ _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id), status: "ready" });
    if (ready) {
      if (ready.clientProduct && clientProductConflicts(ready, product.clientProduct)) return productScopeConflict(c);
      return c.json({ asset: assetReceipt(ready), idempotent: true });
    }
    const asset = await uploads.findOne({ _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id), status: "uploading", expiresAt: { $gt: new Date() } });
    if (!asset) return c.json({ code: "ASSET_NOT_FOUND", message: "素材不存在、已完成或已过期" }, 404);
    if (asset.clientProduct && clientProductConflicts(asset, product.clientProduct)) return productScopeConflict(c);
    let head;
    try { head = await inspectCosObject(asset.objectKey); }
    catch (error) {
      if (asset.assetRequestKey && error?.statusCode !== 404 && error?.status !== 404 && error?.code !== "NoSuchKey") {
        return c.json({ code: "ASSET_RECOVERY_UNAVAILABLE", message: "原素材状态暂时无法确认，请按原请求编号查询，勿重复上传" }, 503);
      }
      return c.json({ code: "ASSET_OBJECT_NOT_FOUND", message: "COS 中尚未找到素材" }, 409);
    }
    const valid = assetHeadMatches(asset, head);
    if (!valid) {
      await Promise.allSettled([removeCosObject(asset.objectKey), uploads.updateOne({ _id: asset._id }, { $set: { status: "rejected", updatedAt: new Date() } })]);
      return c.json({ code: "ASSET_RECEIPT_MISMATCH", message: "素材大小、摘要或归属校验失败" }, 409);
    }
    const now = new Date();
    const completed = await uploads.updateOne({ _id: asset._id, status: "uploading", expiresAt: { $gt: now } }, { $set: { status: "ready", completedAt: now, updatedAt: now }, $unset: { expiresAt: "" } });
    if (completed.modifiedCount !== 1) {
      const current = await uploads.findOne({ _id: asset._id, ownerId: asset.ownerId, status: "ready" });
      if (current) return c.json({ asset: assetReceipt(current), idempotent: true });
      return c.json({ code: "ASSET_STATE_CONFLICT", message: "原素材状态已变化，请重新查询原素材请求" }, 409);
    }
    return c.json({ asset: assetReceipt(asset), idempotent: false });
  });

  app.post("/api/v1/capability-orders", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`capability-create:${auth.user.id}`, { limit: 30, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "能力订单创建过于频繁" }, 429);
    const body = await boundedRequestJson(c, 1024 * 1024 + 128 * 1024);
    const headerKey = c.req.header("Idempotency-Key"), selectedProduct = body.client_product || c.req.query("product");
    if (selectedProduct === DIGITAL_LIVE_PRODUCT_ID) {
      const keys = [headerKey, body.idempotency_key, body.client_request_id].filter((value) => value !== undefined);
      if (keys.some((key) => typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(key)) || new Set(keys).size > 1) {
        return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "数字直播原请求编号格式不正确或与幂等请求头不一致" }, 400);
      }
    }
    const rawKey = String(headerKey || body.idempotency_key || (selectedProduct === DIGITAL_LIVE_PRODUCT_ID ? body.client_request_id : "") || "").trim();
    if (rawKey.length < 8 || rawKey.length > 160) return c.json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "请提供 8–160 字符的 Idempotency-Key" }, 400);
    const capabilityId = String(body.capability_id || "").trim().toLowerCase();
    if (auth.kind === "desktop-english" && !isEnglishCapability(capabilityId)) return c.json({ code: "ENGLISH_CAPABILITY_ONLY", message: "英语教练凭据仅可用于英语学习能力" }, 403);
    if (auth.kind === "desktop-gulong-engine" && !isGulongCallable(capabilityId)) return c.json({ code: "GULONG_ENGINE_CAPABILITY_ONLY", message: "古龙绿色版凭据仅可用于本产品共享能力" }, 403);
    const capability = CAPABILITY_MAP.get(capabilityId);
    const product = requestedClientProduct(c, auth, body); if (product.error) return product.error;
    const clientProduct = product.clientProduct;
    if (clientProduct === DIGITAL_LIVE_PRODUCT_ID && !/^[A-Za-z0-9._:-]{8,160}$/.test(rawKey)) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "数字直播需要可恢复的8至160位原请求编号" }, 400);
    if (clientProduct && !capabilityProducts(capabilityId).includes(clientProduct)) return c.json({ code: "PRODUCT_CAPABILITY_MISMATCH", message: "产品与共享能力不匹配" }, 400);
    if (!capability) return c.json({ code: "UNKNOWN_CAPABILITY", message: "该能力未注册到官网统一订单目录" }, 400);
    if (capability.legacyRoute) return c.json({ code: "USE_LEGACY_H3_API", message: "MiniMax H3 视频任务继续使用现有 /api/h3/tasks 合同", legacy_route: capability.legacyRoute }, 409);
    if (!capability.dispatchable) return c.json(isEnglishCapability(capabilityId)
      ? { code: "CAPABILITY_LOCAL_ONLY", message: "英语教练新学习任务已改为桌面端本地处理，不再创建派单订单" }
      : { code: "CAPABILITY_ADAPTER_REQUIRED", message: "该能力尚未完成独立订单适配与真实推理验收，暂不可创建订单" }, 409);
    let parameters;
    try { parameters = normalizeCapabilityParameters(body.parameters || {}, capability); }
    catch (error) { return c.json({ code: error.code || "INVALID_CAPABILITY_PARAMETERS", message: error.message }, error.status || 400); }
    const digitalError = clientProduct === DIGITAL_LIVE_PRODUCT_ID ? digitalLiveParameterError(capabilityId, parameters, body.parameters) : null;
    if (digitalError) return c.json({ code: "DIGITAL_LIVE_MODEL_UNAVAILABLE", message: digitalError }, 409);
    const ownerId = new ObjectId(auth.user.id);
    let assets;
    try {
      assets = await ownedAssets(ownerId, Array.isArray(body.assets) ? body.assets.slice(0, 32) : [], capability, clientProduct);
      validateCapabilityInput(capability, parameters, assets);
    } catch (error) { return c.json({ code: error.code || "VALIDATION_ERROR", message: error.message }, error.status || 400); }
    const preferredNodeId = String(body.preferred_node_id || "").trim() || null;
    const requestedCapabilityVersion = String(body.capability_version || "").trim().slice(0, 80) || capability.requiredCapabilityVersion || null;
    if (capability.requiredCapabilityVersion && requestedCapabilityVersion !== capability.requiredCapabilityVersion) return c.json({ code: "CAPABILITY_VERSION_UNSUPPORTED", message: `该能力必须使用 ${capability.requiredCapabilityVersion} 合同版本` }, 409);
    const computeGroupId = await readUserGroup(ownerId);
    if (preferredNodeId) {
      const binding = await (await getCollection("nodeAccountBindings")).findOne({ userId: ownerId, nodeId: preferredNodeId, status: "active", revokedAt: null });
      if (!binding) return c.json({ code: "PREFERRED_NODE_NOT_OWNED", message: "指定执行节点不属于当前账户" }, 403);
      if (!computeGroupsMatch(computeGroupId, binding.computeGroupId)) return c.json({ code: "COMPUTE_GROUP_MISMATCH", message: "指定执行节点与当前用户不在同一算力分组" }, 403);
    }
    const fingerprint = requestFingerprint(withClientProductFingerprint({ capabilityId, capabilityVersion: requestedCapabilityVersion, parameters, assets: assets.map((item) => ({ assetId: item.assetId, role: item.role, sha256: item.sha256 })), preferredNodeId }, clientProduct));
    const idempotencyKey = requestKey(ownerId, rawKey);
    const orders = await getCollection("capabilityOrders");
    const existing = await orders.findOne({ idempotencyKey });
    if (existing) {
      if (clientProductConflicts(existing, clientProduct)) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "同一幂等键不能跨桌面产品复用" }, 409);
      if (existing.cancellationTombstone) return c.json({ order: publicOrder(existing, issueDownloadUrl), idempotent: true }, 201);
      if (existing.requestFingerprint !== fingerprint) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "同一幂等键不能用于不同能力订单" }, 409);
      return c.json({ order: publicOrder(existing, issueDownloadUrl, await queueSnapshot(existing)), idempotent: true }, 201);
    }
    if (isEnglishCapability(capabilityId)) { const rejected = await requireEnglish(c, ownerId); if (rejected) return rejected; }
    const sharedGulongRequest = isGulongEngineCapability(capabilityId) || isNativeSharedCapability(capabilityId) && (Boolean(clientProduct) || auth.kind === "desktop-gulong-engine");
    if ((sharedGulongRequest || computeGroupId !== null) && auth.user.role !== "admin") { const rejected = await requireGulong(c, ownerId); if (rejected) return rejected; }
    if (sharedGulongRequest) {
      const availability = await gulongAvailability(capabilityId, ownerId, {
        order: { capabilityId, requesterUserId: ownerId, computeGroupId, sharingScope: "gulong_shared", clientProduct, preferredNodeId, capabilityVersion: requestedCapabilityVersion, parameters, assets },
      });
      if (!availability.verified_node_count) return c.json({ code: "CAPABILITY_NO_COMPATIBLE_NODE", message: capabilityId === "gulong_engine.music"
        ? "当前没有已验收节点支持所选音乐模型及时长，请根据目录中的模型时长上限调整后重试；系统不会自动截短。"
        : "当前没有在线且已验证的兼容共享节点，暂不能创建任务，请稍后重试。", availability }, 409);
    }
    const now = new Date();
    const orderId = new ObjectId();
    const estimate = capability.defaultEtaSeconds;
    const record = {
      _id: orderId,
      orderNo: `CAP${Date.now()}${randomBytes(3).toString("hex").toUpperCase()}`,
      protocolVersion: CAPABILITY_ORDER_PROTOCOL,
      requesterUserId: ownerId,
      computeGroupId,
      sourceChannel: body.source_channel === "desktop_agent" ? "desktop_agent" : "website",
      ...(clientProduct ? { clientProduct } : {}),
      ...(clientProduct === DIGITAL_LIVE_PRODUCT_ID ? { clientRequestId: rawKey } : {}),
      capabilityId,
      ...(isEnglishCapability(capabilityId) ? { sharingScope: "english_shared", entitlementPlan: "english_coach_monthly" } : {}),
      ...(sharedGulongRequest ? { sharingScope: "gulong_shared", entitlementPlan: "gulong_engine_monthly" } : {}),
      capabilityVersion: requestedCapabilityVersion,
      parameters,
      assets,
      preferredNodeId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      status: "queued",
      stage: "queued",
      progress: 0,
      elapsedSeconds: 0,
      etaSeconds: estimate,
      attempt: 0,
      maxAttempts: Math.min(3, Math.max(1, integer(body.max_attempts, 2))),
      priceFen: capability.priceFen,
      chargeStatus: "exempt",
      refundStatus: "not_applicable",
      nextEligibleAt: now,
      autoCancelAt: new Date(now.getTime() + capability.maxRuntimeSeconds * 10 * 1000),
      createdAt: now,
      updatedAt: now,
    };
    try { await orders.insertOne(record); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      const replay = await orders.findOne({ idempotencyKey });
      if (replay && clientProductConflicts(replay, clientProduct)) return productScopeConflict(c);
      if (replay?.cancellationTombstone) return c.json({ order: publicOrder(replay, issueDownloadUrl), idempotent: true }, 201);
      if (!replay || replay.requestFingerprint !== fingerprint) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "同一幂等键不能用于不同能力订单" }, 409);
      return c.json({ order: publicOrder(replay, issueDownloadUrl, await queueSnapshot(replay)), idempotent: true }, 201);
    }
    return c.json({ order: publicOrder(record, issueDownloadUrl, await queueSnapshot(record)), idempotent: false }, 201);
  });

  app.get("/api/v1/capability-orders/by-request/:key", async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const product = requestedClientProduct(c, auth); if (product.error) return product.error;
    const key = String(c.req.param("key") || "");
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) return c.json({ code: "VALIDATION_ERROR", message: "请求编号格式无效" }, 400);
    const ownerId = new ObjectId(auth.user.id);
    await recoverExpired();
    const order = await (await getCollection("capabilityOrders")).findOne({ idempotencyKey: requestKey(ownerId, key), requesterUserId: ownerId });
    if (!order || !scopedMayReadOrder(auth, order)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    if (clientProductConflicts(order, product.clientProduct)) return productScopeConflict(c);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ order: publicOrder(order, issueDownloadUrl, await queueSnapshot(order)) });
  });

  app.post("/api/v1/capability-orders/by-request/:key/cancel", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const key = String(c.req.param("key") || "");
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) return c.json({ code: "VALIDATION_ERROR", message: "请求编号格式无效" }, 400);
    const body = await boundedRequestJson(c);
    const product = requestedClientProduct(c, auth, body); if (product.error) return product.error;
    const clientProduct = product.clientProduct;
    if (clientProduct === DIGITAL_LIVE_PRODUCT_ID && body.client_request_id !== undefined && body.client_request_id !== key) {
      return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "取消时必须使用同一个原请求编号" }, 400);
    }
    const rate = await enforceRateLimit(`capability-cancel-request:${auth.user.id}`, { limit: 60, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "取消请求过于频繁" }, 429);
    const ownerId = new ObjectId(auth.user.id);
    const idempotencyKey = requestKey(ownerId, key);
    const orders = await getCollection("capabilityOrders");
    const now = new Date();
    const tombstone = { _id: new ObjectId(), orderNo: `CAPC${Date.now()}${randomBytes(5).toString("hex").toUpperCase()}`, protocolVersion: CAPABILITY_ORDER_PROTOCOL,
      requesterUserId: ownerId, idempotencyKey, ...(clientProduct ? { clientProduct } : {}), cancellationTombstone: true, capabilityId: null, status: "cancelled", stage: "cancelled",
      ...(clientProduct === DIGITAL_LIVE_PRODUCT_ID ? { clientRequestId: key } : {}),
      cancelReason: "requester_cancelled_before_create", priceFen: 0, chargeStatus: "exempt", refundStatus: "not_applicable", assets: [],
      createdAt: now, updatedAt: now, cancelledAt: now };
    try { await orders.updateOne({ idempotencyKey }, { $setOnInsert: tombstone }, { upsert: true }); }
    catch (error) { if (error?.code !== 11000) throw error; }
    const before = await orders.findOne({ idempotencyKey, requesterUserId: ownerId });
    if (!before || !scopedMayReadOrder(auth, before)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    if (clientProductConflicts(before, clientProduct)) return productScopeConflict(c);
    const order = await cancelOwnedOrder(before, now);
    return c.json({ order: publicOrder(order, issueDownloadUrl), idempotent: CAPABILITY_TERMINAL.has(before.status) });
  });

  app.get("/api/v1/capability-orders/:id", async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const product = requestedClientProduct(c, auth); if (product.error) return product.error;
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    await recoverExpired();
    const order = await (await getCollection("capabilityOrders")).findOne({ _id: new ObjectId(c.req.param("id")), requesterUserId: new ObjectId(auth.user.id) });
    if (!order || !scopedMayReadOrder(auth, order)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    if (clientProductConflicts(order, product.clientProduct)) return productScopeConflict(c);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ order: publicOrder(order, issueDownloadUrl, await queueSnapshot(order)) });
  });

  app.post("/api/v1/capability-orders/:id/cancel", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const body = await boundedRequestJson(c);
    const product = requestedClientProduct(c, auth, body); if (product.error) return product.error;
    const orders = await getCollection("capabilityOrders");
    const filter = { _id: new ObjectId(c.req.param("id")), requesterUserId: new ObjectId(auth.user.id) };
    const before = await orders.findOne(filter);
    if (!before || !scopedMayReadOrder(auth, before)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    if (clientProductConflicts(before, product.clientProduct)) return productScopeConflict(c);
    return c.json({ order: publicOrder(await cancelOwnedOrder(before), issueDownloadUrl), idempotent: CAPABILITY_TERMINAL.has(before.status) });
  });

  app.get("/api/v1/capability-orders/:id/worker-state", async (c) => {
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const order = await (await getCollection("capabilityOrders")).findOne({ _id: new ObjectId(c.req.param("id")) });
    if (!order?.assignedNode?.nodeId) return c.json({ code: "ORDER_NOT_ASSIGNED", message: "能力订单尚未分配执行节点" }, 409);
    const auth = await authenticateBinding(c, order.assignedNode.nodeId); if (auth.error) return auth.error;
    if (!workerOwnsClaim(order, auth) || String(c.req.query("claim_id") || "") !== order.claimId) return c.json({ code: "CLAIM_MISMATCH", message: "订单领取身份不匹配" }, 409);
    const groupRejected = await workerGroupError(c, order, auth); if (groupRejected) return groupRejected;
    const terminal = CAPABILITY_TERMINAL.has(order.status);
    const cancellationRequested = order.status === "cancelled";
    const leaseExpired = !terminal && ((order.claimLeaseUntil && new Date(order.claimLeaseUntil) <= new Date()) || !await hasOrderSlot(order));
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      order_id: order._id.toString(),
      claim_id: order.claimId,
      status: order.status,
      stage: order.stage || null,
      terminal,
      lease_expired: Boolean(leaseExpired),
      cancellation_requested: cancellationRequested,
      should_stop: terminal || Boolean(leaseExpired),
      lease_expires_at: order.claimLeaseUntil || null,
      server_time: new Date(),
      next_poll_after_seconds: terminal ? null : 15,
    });
  });

  app.post("/api/v1/capability-orders/claim", async (c) => {
    const preliminaryAuth = await authenticateBinding(c); if (preliminaryAuth.error) return preliminaryAuth.error;
    const body = await boundedRequestJson(c, 256 * 1024);
    const nodeId = String(body.node_id || "").trim();
    const auth = await authenticateBinding(c, nodeId); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`capability-claim:${auth.binding._id}`, { limit: 120, windowMs: 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "节点拉单过于频繁" }, 429);
    if (body.protocol_version !== CAPABILITY_ORDER_PROTOCOL) return c.json({ code: "PROTOCOL_VERSION_UNSUPPORTED", message: `必须使用 ${CAPABILITY_ORDER_PROTOCOL}` }, 400);
    const now = new Date();
    // Promise caches live for this HTTP request only. Raw and normalized views
    // of one report share a key; a later request always rechecks revocation.
    const automaticLookups = new Map(), trustedLookups = new Map();
    const lookupKey = (bindingId, report) => {
      const raw = report.verificationInventory || report;
      const models = raw.models ?? raw.supported_models ?? raw.supportedModels ?? [];
      const languages = raw.asr_languages ?? raw.asrLanguages ?? [];
      return JSON.stringify({ binding: String(bindingId), capability: raw.capability_id ?? raw.capabilityId,
        version: raw.capability_version ?? raw.capabilityVersion ?? raw.specialContractVersion,
        artifact: String(raw.validation?.artifact_sha256 ?? raw.validation?.artifactSha256 ?? raw.artifact_sha256 ?? raw.artifactSha256 ?? "").toUpperCase(),
        installed: raw.installed, enabled: raw.enabled, sharing: raw.sharing_opt_in ?? raw.sharingOptIn,
        models, defaultModel: raw.default_model ?? raw.defaultModel ?? null,
        languages: Array.isArray(languages) ? [...languages].sort() : languages,
        acceptanceId: raw.validation?.acceptance_id ?? raw.validation?.acceptanceId ?? null,
        tests: raw.validation?.contract_tests ?? raw.validation?.contractTests ?? raw.contractTests ?? {},
      }, (_, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
    };
    const lookupAutomatic = (bindingId, report, instant) => {
      const raw = report.verificationInventory || report, key = lookupKey(bindingId, raw);
      if (!automaticLookups.has(key)) automaticLookups.set(key, automaticVerification.findTrusted({ bindingId, report: raw, now: instant }));
      return automaticLookups.get(key);
    };
    const lookupTrusted = (bindingId, report, instant) => {
      const key = lookupKey(bindingId, report);
      if (!trustedLookups.has(key)) trustedLookups.set(key, dependencies.findTrustedConsumerAcceptance
        ? Promise.resolve(dependencies.findTrustedConsumerAcceptance(bindingId, report, instant))
        : lookupAutomatic(bindingId, report, instant).then((accepted) => accepted || findTrustedConsumerAcceptance({ getCollection, bindingId, report, now: instant })));
      return trustedLookups.get(key);
    };
    let ownCapabilities;
    try { ownCapabilities = await readyReports(auth.binding, Array.isArray(body.capabilities) ? body.capabilities : [], now, lookupAutomatic); }
    catch (error) { return c.json({ code: error.code || "INVALID_CAPABILITY_REPORT", message: error.message }, error.status || 400); }
    if (!ownCapabilities.length) return Array.isArray(body.capabilities) && body.capabilities.length
      ? c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING,
        code: "CAPABILITY_VERIFICATION_PENDING", verification_required: true, next_poll_after_seconds: 30 } })
      : c.json({ code: "CAPABILITY_REPORT_REQUIRED", message: "节点必须上报至少一个已安装能力，并完成自动验收" }, 400);
    ownCapabilities = await trustReports(auth.binding, ownCapabilities, now, lookupTrusted);
    let resources;
    try { resources = { ...normalizeCapabilityResources(body.resources, Math.max(...ownCapabilities.map((item) => item.maxConcurrent))), ...normalizeGpuLoadReport(body.resources, now) }; }
    catch (error) { return c.json({ code: error.code, message: error.message }, error.status || 400); }
    const ownNode = { nodeId, nodeName: String(body.node_name || auth.binding.nodeName || "").slice(0, 120), binding: auth.binding, capabilities: ownCapabilities, resources, runningTaskCount: resources.running_task_count, maxConcurrent: resources.max_concurrent_tasks };
    ownNode.availableSlots = Math.max(0, ownNode.maxConcurrent - ownNode.runningTaskCount);
    const nodes = [ownNode];
    const lanReports = Array.isArray(body.lan_cluster?.nodes) ? body.lan_cluster.nodes.slice(0, 64) : [];
    const lanNodeIds = [...new Set(lanReports.map((report) => String(report.node_id || "").trim()).filter((id) => id && id !== nodeId))];
    const lanBindings = lanNodeIds.length ? await (await getCollection("nodeAccountBindings")).find({ userId: auth.user._id,
      nodeId: { $in: lanNodeIds }, status: "active", revokedAt: null }).limit(64).toArray() : [];
    const lanBindingsByNode = new Map(lanBindings.map((binding) => [binding.nodeId, binding]));
    for (const report of lanReports) {
      const reportNodeId = String(report.node_id || "").trim();
      if (!reportNodeId || nodes.some((node) => node.nodeId === reportNodeId)) continue;
      const binding = lanBindingsByNode.get(reportNodeId);
      if (!binding) return c.json({ code: "LAN_NODE_NOT_OWNED", message: "局域网报告包含未绑定到当前账户的节点" }, 403);
      let capabilities;
      try { capabilities = await readyReports(binding, Array.isArray(report.capabilities) ? report.capabilities : [], now, lookupAutomatic); }
      catch (error) { return c.json({ code: error.code || "INVALID_CAPABILITY_REPORT", message: error.message }, error.status || 400); }
      capabilities = await trustReports(binding, capabilities, now, lookupTrusted);
      let reportResources;
      try { reportResources = { ...normalizeCapabilityResources(report.resources, Math.max(1, ...capabilities.map((item) => item.maxConcurrent))), ...normalizeGpuLoadReport(report.resources, now) }; }
      catch (error) { return c.json({ code: error.code, message: error.message }, error.status || 400); }
      const maxConcurrent = Math.min(16, Math.max(1, integer(reportResources.max_concurrent_tasks, Math.max(1, ...capabilities.map((item) => item.maxConcurrent)))));
      nodes.push({ nodeId: reportNodeId, nodeName: String(report.node_name || binding.nodeName || "").slice(0, 120), binding, capabilities, resources: reportResources, runningTaskCount: reportResources.running_task_count, maxConcurrent, availableSlots: Math.max(0, maxConcurrent - reportResources.running_task_count) });
    }
    // Dry-run is a connectivity probe, never an advertisement or queue mutation.
    if (body.dry_run === true) return c.json({ ok: true, service: "gulong-capability-orders", protocol_version: CAPABILITY_ORDER_PROTOCOL, queue: "reachable", eligible_capability_ids: ownCapabilities.filter((item) => !isWorkLuckyCapability(item.capabilityId) || item.trustedAcceptance).map((item) => item.capabilityId) });
    const localSnapshots = await slots.snapshots({ bindingIds: nodes.map((node) => node.binding._id), now });
    for (const node of nodes) {
      const snapshot = localSnapshots.get(String(node.binding._id));
      node.availableSlots = snapshot.available ? Math.max(0, node.maxConcurrent - node.runningTaskCount - snapshot.activeCount) : 0;
      node.activeByCapability = snapshot.byCapability;
      Object.assign(node, projectSharedNodeLoad(node, snapshot, now));
    }
    await (await getCollection("capabilityNodeReports")).updateOne({ bindingId: auth.binding._id }, { $set: { userId: auth.user._id, nodeId, protocolVersion: CAPABILITY_ORDER_PROTOCOL, capabilities: ownCapabilities, resources, reportedAt: now, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
    await recoverExpired(now);
    nodes.sort(compareSharedNodeLoad);
    const capabilityIds = [...new Set(nodes.flatMap((item) => item.capabilities.map((capability) => capability.capabilityId)))];
    const sharedEnglishIds = ownCapabilities.filter((item) => isEnglishCapability(item.capabilityId) && item.sharingOptIn).map((item) => item.capabilityId);
    const sharedGulongIds = ownCapabilities.filter((item) => item.sharingOptIn && (isGulongEngineCapability(item.capabilityId)
      || nativeNodeSharesCapability({ capabilities: [item] }, item.capabilityId))).map((item) => item.capabilityId);
    const ownerScope = { $or: [{ requesterUserId: auth.user._id },
      ...(sharedEnglishIds.length ? [{ capabilityId: { $in: sharedEnglishIds }, sharingScope: "english_shared" }] : []),
      ...(sharedGulongIds.length ? [{ capabilityId: { $in: sharedGulongIds }, sharingScope: "gulong_shared" }] : [])] };
    const groupIds = [...new Set(nodes.map((item) => normalizeComputeGroupId(item.binding.computeGroupId)))];
    const candidates = await (await getCollection("capabilityOrders")).find({ ...ownerScope, computeGroupId: { $in: groupIds }, status: "queued", capabilityId: { $in: capabilityIds }, nextEligibleAt: { $lte: now }, autoCancelAt: { $gt: now } }).sort({ createdAt: 1, _id: 1 }).limit(100).toArray();
    if (!candidates.length || !nodes.some((node) => node.availableSlots > 0)) return c.json({ task: null,
      claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING, eligible_capability_ids: capabilityIds } });
    // Global reports influence preference, not execution authority. A foreign
    // winner must poll with its own token; it is never inserted into this LAN.
    const globalNodes = [...nodes];
    const reportsCollection = await getCollection("capabilityNodeReports");
    if (typeof reportsCollection.find === "function" && nodes.length < 200) {
      const freshReports = await reportsCollection.find({ protocolVersion: CAPABILITY_ORDER_PROTOCOL,
        "capabilities.capabilityId": { $in: capabilityIds }, reportedAt: { $gte: new Date(+now - NODE_REPORT_MAX_AGE_MS), $lte: now } })
        .sort({ reportedAt: -1 }).limit(200 - nodes.length).toArray();
      const localNodeIds = new Set(nodes.map((node) => node.nodeId));
      const remoteReports = freshReports.filter((report) => !localNodeIds.has(report.nodeId));
      const bindings = remoteReports.length ? await (await getCollection("nodeAccountBindings")).find({
        _id: { $in: remoteReports.map((report) => report.bindingId) }, status: "active", revokedAt: null }).limit(200).toArray() : [];
      const bindingsById = new Map(bindings.map((binding) => [String(binding._id), binding]));
      const compatible = remoteReports.flatMap((report) => {
        const binding = bindingsById.get(String(report.bindingId));
        return binding && binding.nodeId === report.nodeId && String(binding.userId) === String(report.userId)
          && groupIds.includes(normalizeComputeGroupId(binding.computeGroupId)) ? [{ report, binding }] : [];
      });
      const activeUsers = compatible.length ? await (await getCollection("users")).find({
        _id: { $in: [...new Map(compatible.map(({ binding }) => [String(binding.userId), binding.userId])).values()] },
        status: "active" }).limit(200).toArray() : [];
      const activeUserIds = new Set(activeUsers.map((user) => String(user._id)));
      const readyCandidates = compatible.filter(({ binding }) => activeUserIds.has(String(binding.userId)));
      const snapshots = readyCandidates.length ? await slots.snapshots({ bindingIds: readyCandidates.map(({ binding }) => binding._id), now }) : new Map();
      for (const { report, binding } of readyCandidates) {
        let capabilities, reportResources;
        try {
          capabilities = await readyReports(binding, report.capabilities.map((item) => ({ ...item,
            capability_id: item.capabilityId, capability_version: item.capabilityVersion,
            sharing_opt_in: item.sharingOptIn, supported_models: item.supportedModels,
            supported_voices: item.supportedVoices })), now, lookupAutomatic);
          capabilities = await trustReports(binding, capabilities, now, lookupTrusted);
          reportResources = { ...normalizeCapabilityResources(report.resources, Math.max(1, ...capabilities.map((item) => item.maxConcurrent))),
            ...normalizeGpuLoadReport(report.resources, now) };
        } catch { continue; } // A stored stale/malformed report never wins admission.
        const snapshot = snapshots.get(String(binding._id));
        if (!snapshot.available) continue;
        const globalNode = { nodeId: binding.nodeId, binding, capabilities, resources: reportResources,
          runningTaskCount: reportResources.running_task_count, maxConcurrent: reportResources.max_concurrent_tasks,
          availableSlots: Math.max(0, reportResources.max_concurrent_tasks - reportResources.running_task_count - snapshot.activeCount),
          activeByCapability: snapshot.byCapability };
        globalNodes.push(projectSharedNodeLoad(globalNode, snapshot, now));
      }
    }
    globalNodes.sort(compareSharedNodeLoad);
    let selected = null;
    for (const order of candidates) {
      const computeGroupId = await readUserGroup(order.requesterUserId);
      // Current membership assignment is authoritative even for old/stale orders.
      if (!computeGroupsMatch(computeGroupId, order.computeGroupId)) continue;
      if (isEnglishCapability(order.capabilityId) && !(await englishEntitlement(order.requesterUserId, now)).active) {
        await (await getCollection("capabilityOrders")).updateOne({ _id: order._id, status: "queued" }, { $set: { status: "cancelled", stage: "cancelled", cancelReason: "english_subscription_inactive", error: { code: "ENGLISH_SUBSCRIPTION_REQUIRED", message: "英语教练套餐尚未生效、已到期或已撤销" }, cancelledAt: now, updatedAt: now } });
        continue;
      }
      const requester = computeGroupId !== null || isGulongEngineCapability(order.capabilityId)
        ? await (await getCollection("users")).findOne({ _id: order.requesterUserId }) : null;
      if ((isGulongEngineCapability(order.capabilityId) || computeGroupId !== null) && requester?.role !== "admin" && !(await gulongEntitlement(order.requesterUserId, now)).active) {
        await (await getCollection("capabilityOrders")).updateOne({ _id: order._id, status: "queued" }, { $set: { status: "cancelled", stage: "cancelled", cancelReason: "gulong_engine_subscription_inactive", error: { code: "GULONG_ENGINE_SUBSCRIPTION_REQUIRED", message: "古龙绿色版套餐尚未生效、已到期或已撤销" }, cancelledAt: now, updatedAt: now } });
        continue;
      }
      // A LAN proxy cannot opt another node into serving unrelated accounts.
      const foreign = String(order.requesterUserId) !== String(auth.user._id);
      const eligible = (item) => (item.activeByCapability?.[order.capabilityId] || 0) < (item.capabilities.find((cap) => cap.capabilityId === order.capabilityId)?.maxConcurrent || 0)
        && capabilityNodeCanRunOrder(item, { ...order, computeGroupId });
      const node = nodes.find((item) => (!foreign || item === ownNode)
        && eligible(item));
      if (!node) continue;
      const globalBest = globalNodes.find(eligible);
      if (globalBest && globalBest !== node && compareSharedNodeLoad(globalBest, node) < 0) {
        const wait = boundedGlobalDispatchWait(order, now);
        if (wait.shouldWait) {
          // Only the first contender starts the bounded grace period. Repeated
          // polling/advertisements cannot continually extend it and starve FIFO.
          await (await getCollection("capabilityOrders")).updateOne({ _id: order._id, status: "queued",
            schedulerWaitStartedAt: order.schedulerWaitStartedAt ?? null }, { $set: { schedulerWaitStartedAt: wait.startedAt } });
          return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL,
            scheduling: SHARED_NODE_SCHEDULING, waiting_for_preferred_node: true, next_poll_after_seconds: 2 } });
        }
      }
      selected = { order, node }; break;
    }
    if (!selected) return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING, eligible_capability_ids: capabilityIds } });
    const currentBinding = await (await getCollection("nodeAccountBindings")).findOne({ _id: selected.node.binding._id, status: "active", revokedAt: null });
    if (!currentBinding || currentBinding.nodeId !== selected.node.nodeId || String(currentBinding.userId) !== String(selected.node.binding.userId)
      || !computeGroupsMatch(await readUserGroup(selected.order.requesterUserId), currentBinding.computeGroupId)) return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING, group_changed: true } });
    const claimId = randomBytes(18).toString("base64url");
    const claimLeaseUntil = new Date(now.getTime() + CAPABILITY_CLAIM_LEASE_MS);
    const selectedCapability = selected.node.capabilities.find((item) => item.capabilityId === selected.order.capabilityId && (!selected.order.capabilityVersion || item.capabilityVersion === selected.order.capabilityVersion));
    // /report may enroll a legacy binding after this request's initial auth and
    // proof snapshot. The final binding fence must not dispatch one last GCA
    // task after the server has switched that consumer to automatic admission.
    if (requiresAutomaticCapabilityVerification(currentBinding, selected.order.capabilityId)
      && (!selectedCapability?.verificationInventory || selectedCapability.trustedAcceptance !== true || selectedCapability.automaticVerification !== true)) {
      return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING,
        code: "CAPABILITY_VERIFICATION_PENDING", verification_required: true, next_poll_after_seconds: 30 } });
    }
    const assignedNode = { nodeId: selected.node.nodeId, nodeName: selected.node.nodeName, bindingId: selected.node.binding._id, userId: selected.node.binding.userId };
    const reservation = await slots.reserve({ ...slotFence({ ...selected.order, assignedNode, claimId }), now, expiresAt: claimLeaseUntil,
      estimatedSeconds: Math.max(1, integer(selected.order.etaSeconds || selected.order.estimatedTotalSeconds || CAPABILITY_MAP.get(selected.order.capabilityId)?.defaultEtaSeconds, 300)),
      maxConcurrentTasks: Math.max(0, selected.node.maxConcurrent - selected.node.resources.running_task_count), capabilityMaxConcurrent: selectedCapability.maxConcurrent });
    if (!reservation) return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING, slots_busy: true } });
    let claimed;
    try {
      claimed = await (await getCollection("capabilityOrders")).findOneAndUpdate({ _id: selected.order._id, ...computeGroupFilter(currentBinding.computeGroupId), status: "queued", nextEligibleAt: { $lte: now } }, { $set: { status: "claimed", stage: "claimed", claimId, slotLeaseRequired: true, claimRequestedByNodeId: auth.binding.nodeId, assignedNode, capabilityVersion: selectedCapability.capabilityVersion, claimedAt: now, claimLeaseUntil, updatedAt: now }, $inc: { attempt: 1 } }, { returnDocument: "after" });
    } finally {
      if (!claimed) await slots.release({ ...slotFence({ ...selected.order, assignedNode, claimId }), now });
    }
    if (!claimed) return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING, race_lost: true } });
    return c.json({ task: workerOrder(claimed, claimAssets(claimed.assets)), claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: SHARED_NODE_SCHEDULING, selected_node_id: selected.node.nodeId } });
  });

  app.post("/api/v1/capability-orders/:id/outputs/presign", async (c) => {
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const body = await boundedRequestJson(c);
    const now = new Date();
    const order = await (await getCollection("capabilityOrders")).findOne({ _id: new ObjectId(c.req.param("id")), status: { $in: ["claimed", "processing"] } });
    if (!order) return c.json({ code: "ORDER_NOT_ACTIVE", message: "能力订单不存在或不再执行" }, 409);
    if (!order.claimLeaseUntil || new Date(order.claimLeaseUntil) <= now) return c.json({ code: "CLAIM_LEASE_EXPIRED", message: "订单领取租约已过期，不能再签发输出票据" }, 409);
    if (!await hasOrderSlot(order, now)) return c.json({ code: "CLAIM_SLOT_EXPIRED", message: "节点执行槽已失效，请停止当前任务" }, 409);
    const auth = await authenticateBinding(c, order.assignedNode?.nodeId); if (auth.error) return auth.error;
    if (!workerOwnsClaim(order, auth)) return c.json({ code: "CLAIM_MISMATCH", message: "订单执行账户不匹配" }, 409);
    const groupRejected = await workerGroupError(c, order, auth); if (groupRejected) return groupRejected;
    if (String(body.claim_id || "") !== order.claimId) return c.json({ code: "CLAIM_MISMATCH", message: "订单领取凭据不匹配" }, 409);
    const capability = CAPABILITY_MAP.get(order.capabilityId);
    const contentType = String(body.content_type || "").trim().toLowerCase();
    const filename = sanitizeFilename(body.filename, "result.bin");
    const bytes = integer(body.bytes, -1);
    const sha256 = String(body.sha256 || "").trim().toUpperCase();
    const role = String(body.role || "result").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "result";
    const outputRule = capability.outputRules.find((item) => item.role === role);
    if (!outputRule || !mimeAllowed(contentType, outputRule.mimeTypes) || bytes < 1 || bytes > Math.min(CAPABILITY_MAX_ASSET_BYTES, outputRule.maxBytes) || !/^[A-F0-9]{64}$/.test(sha256)) return c.json({ code: "INVALID_OUTPUT_MANIFEST", message: "输出角色、类型、大小或 SHA-256 不符合能力合同" }, 400);
    if (requiredNativeOutputRoles(order).length && !requiredNativeOutputRoles(order).includes(role)) return c.json({ code: "INVALID_OUTPUT_MANIFEST", message: "原生图层模式只能上传本次合同要求的真实文件角色" }, 400);
    if (order.capabilityId === "gulong_engine.tts" && contentType !== (order.parameters?.output_format === "wav" ? "audio/wav" : "audio/mpeg")) return c.json({ code: "INVALID_OUTPUT_MANIFEST", message: "配音文件类型与订单选择的输出格式不一致" }, 400);
    const outputUploads = await getCollection("capabilityOutputUploads");
    // One stable grant per logical output. Lost responses are retried, not uploaded
    // under a fresh identity; a changed manifest can never overwrite its receipt.
    const outputKey = isWorkLuckyCapability(order.capabilityId) ? role : String(body.output_key || "").trim();
    if (outputKey && !/^[A-Za-z0-9._:-]{1,160}$/.test(outputKey)) return c.json({ code: "INVALID_OUTPUT_KEY", message: "输出请求编号格式不正确" }, 400);
    const stableOutputId = outputKey ? createHash("sha256").update(`${order._id}:${order.claimId}:${outputKey}`).digest("base64url") : null;
    const ticket = (grant, replay = false) => {
      const expires = Math.max(1, Math.min(3600, Math.floor((new Date(grant.expiresAt).getTime() - now.getTime()) / 1000)));
      const headers = { "Content-Type": grant.contentType, "x-cos-meta-sha256": grant.sha256, "x-cos-meta-bytes": String(grant.bytes), "x-cos-meta-capability-order-id": order._id.toString(), "x-cos-meta-capability-output-id": grant.outputId, "x-cos-meta-node-id-hash": createHash("sha256").update(auth.binding.nodeId).digest("hex") };
      return c.json({ output_id: grant.outputId, upload_url: issueUploadUrl(grant.objectKey, { expires, headers }), method: "PUT", headers, required_headers: headers,
        object_key: grant.objectKey, expires_at: new Date(grant.expiresAt).toISOString(), expires_in_seconds: expires, idempotent: replay,
        complete_via: { method: "POST", url: "/api/v1/capability-orders/callback", status: "completed", output_reference: { output_id: grant.outputId } } }, replay ? 200 : 201);
    };
    const reuseTicket = (grant) => {
      if (grant.role !== role || grant.filename !== filename || grant.contentType !== contentType || grant.bytes !== bytes || grant.sha256 !== sha256)
        return c.json({ code: "OUTPUT_IDEMPOTENCY_CONFLICT", message: "相同输出请求编号不能更改文件清单" }, 409);
      if (grant.status !== "issued" || new Date(grant.expiresAt) <= now) return c.json({ code: "OUTPUT_GRANT_EXPIRED", message: "原输出票据已完成或过期，不能重新上传" }, 409);
      return ticket(grant, true);
    };
    if (stableOutputId) {
      const original = await outputUploads.findOne({ outputId: stableOutputId, orderId: order._id, claimId: order.claimId });
      if (original) return reuseTicket(original);
    }
    const roleCount = await outputUploads.countDocuments({ orderId: order._id, claimId: order.claimId, role, status: { $in: ["issued", "completed"] } });
    if (roleCount >= outputRule.max) return c.json({ code: "OUTPUT_ROLE_LIMIT_EXCEEDED", message: `输出角色 ${role} 最多允许 ${outputRule.max} 个文件` }, 409);
    const outputId = stableOutputId || randomBytes(18).toString("base64url");
    const objectKey = `capability-orders/${order._id}/outputs/${outputId}-${filename}`;
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const headers = { "Content-Type": contentType, "x-cos-meta-sha256": sha256, "x-cos-meta-bytes": String(bytes), "x-cos-meta-capability-order-id": order._id.toString(), "x-cos-meta-capability-output-id": outputId, "x-cos-meta-node-id-hash": createHash("sha256").update(auth.binding.nodeId).digest("hex") };
    const finalGroupRejected = await workerGroupError(c, order, auth); if (finalGroupRejected) return finalGroupRejected;
    try {
      await outputUploads.insertOne({ outputId, ...(outputKey ? { outputKey } : {}), orderId: order._id, claimId: order.claimId, ownerId: order.requesterUserId, issuedToBindingId: auth.binding._id, issuedToNodeId: auth.binding.nodeId, role, filename, contentType, bytes, sha256, objectKey, status: "issued", createdAt: now, updatedAt: now, expiresAt });
    } catch (error) {
      if (error?.code !== 11000 || !stableOutputId) throw error;
      const original = await outputUploads.findOne({ outputId: stableOutputId, orderId: order._id, claimId: order.claimId });
      if (!original) throw error;
      return reuseTicket(original);
    }
    return c.json({
      output_id: outputId,
      upload_url: issueUploadUrl(objectKey, { expires: 3600, headers }),
      method: "PUT",
      headers,
      required_headers: headers,
      object_key: objectKey,
      expires_at: expiresAt.toISOString(),
      expires_in_seconds: 3600,
      complete_via: { method: "POST", url: "/api/v1/capability-orders/callback", status: "completed", output_reference: { output_id: outputId } },
    }, 201);
  });

  app.post("/api/v1/capability-orders/callback", async (c) => {
    const auth = await authenticateBinding(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`capability-callback:${auth.binding._id}`, { limit: 60, windowMs: 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "节点回调过于频繁，请稍后重试原回调" }, 429);
    const body = await boundedRequestJson(c, 4 * 1024 * 1024 + 128 * 1024);
    if (!ObjectId.isValid(body.order_id)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const orders = await getCollection("capabilityOrders");
    let order = await orders.findOne({ _id: new ObjectId(body.order_id) });
    if (!order) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const groupRejected = await workerGroupError(c, order, auth); if (groupRejected) return groupRejected;
    const eventId = String(body.event_id || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(eventId)) return c.json({ code: "CALLBACK_EVENT_REQUIRED", message: "回调必须提供稳定 event_id" }, 400);
    const callbacks = await getCollection("capabilityOrderCallbacks");
    const existing = await callbacks.findOne({ orderId: order._id, eventId });
    const payloadFingerprint = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (existing) {
      if (existing.claimId !== String(body.claim_id || "") || existing.nodeId !== auth.binding.nodeId
        || (existing.bindingId && String(existing.bindingId) !== String(auth.binding._id))) return c.json({ code: "CLAIM_MISMATCH", message: "回调回执不属于当前执行节点" }, 409);
      if (existing.payloadFingerprint && existing.payloadFingerprint !== payloadFingerprint) return c.json({ code: "CALLBACK_IDEMPOTENCY_CONFLICT", message: "相同回调编号不能更改结果内容" }, 409);
      if (existing.resultStatus !== "processing" || !existing.payloadFingerprint) return c.json({ ok: true, idempotent: true, order_status: existing.resultStatus });
      if (order.lastCallbackEventId === eventId && order.lastCallbackFingerprint === payloadFingerprint) {
        if (order.status === "completed") await (await getCollection("capabilityOutputUploads")).updateMany({ orderId: order._id, claimId: existing.claimId, status: "issued" }, { $set: { status: "completed", completedAt: order.completedAt, updatedAt: new Date() }, $unset: { expiresAt: "" } });
        if (CAPABILITY_TERMINAL.has(order.status) || order.status === "queued") await releaseOrderSlot({ ...order, claimId: existing.claimId, assignedNode: existing.assignedNode || order.assignedNode });
        await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: order.status } });
        return c.json({ ok: true, idempotent: true, order_status: order.status });
      }
    }
    if (!workerOwnsClaim(order, auth) || String(body.claim_id || "") !== order.claimId || order.assignedNode?.nodeId !== auth.binding.nodeId) return c.json({ code: "CLAIM_MISMATCH", message: "订单领取身份不匹配" }, 409);
    if (order.status === "cancelled" && body.status === "cancelled") {
      // A requester cancellation keeps the slot fenced until the worker confirms
      // it stopped (or the lease expires). Do not assign new work while it stops.
      try { await callbacks.insertOne({ orderId: order._id, eventId, claimId: order.claimId, nodeId: auth.binding.nodeId, bindingId: auth.binding._id, payloadFingerprint, resultStatus: "cancelled", status: "cancelled", createdAt: new Date() }); }
      catch (error) { if (error?.code !== 11000) throw error; }
      await releaseOrderSlot(order);
      return c.json({ ok: true, idempotent: false, order_status: "cancelled" });
    }
    if (CAPABILITY_TERMINAL.has(order.status)) return c.json({ code: "ORDER_ALREADY_TERMINAL", message: "订单已结束，不能再提交新的回调" }, 409);
    const now = new Date();
    if (!order.claimLeaseUntil || new Date(order.claimLeaseUntil) <= now) return c.json({ code: "CLAIM_LEASE_EXPIRED", message: "订单领取租约已过期，请停止本地任务并等待重新派单" }, 409);
    if (!await hasOrderSlot(order, now)) return c.json({ code: "CLAIM_SLOT_EXPIRED", message: "节点执行槽已过期，请停止任务并等待重新派单" }, 409);
    const status = String(body.status || "").trim().toLowerCase();
    if (!["started", "progress", "completed", "failed", "cancelled"].includes(status)) return c.json({ code: "INVALID_CALLBACK_STATUS", message: "回调状态不正确" }, 400);
    const elapsedSeconds = Math.max(0, integer(body.elapsed_seconds));
    const estimatedTotalSeconds = Math.max(0, integer(body.estimated_total_seconds));
    const progress = status === "completed" ? 100 : Math.min(99, Math.max(0, integer(body.progress)));
    const etaSeconds = body.eta_seconds == null ? (estimatedTotalSeconds ? Math.max(0, estimatedTotalSeconds - elapsedSeconds) : order.etaSeconds) : Math.max(0, integer(body.eta_seconds));
    if (status === "started" && estimatedTotalSeconds < 1) return c.json({ code: "ESTIMATE_REQUIRED", message: "首次 started 回调必须提供 estimated_total_seconds" }, 400);
    let finalGroupRejection = null;
    const claimEvent = async () => {
      finalGroupRejection = await workerGroupError(c, order, auth);
      if (finalGroupRejection) return false;
      if (existing?.resultStatus === "processing") return true;
      try {
        await callbacks.insertOne({ orderId: order._id, eventId, claimId: order.claimId, status, nodeId: auth.binding.nodeId, bindingId: auth.binding._id, assignedNode: order.assignedNode, payloadFingerprint, createdAt: now, resultStatus: "processing" });
        return true;
      } catch (error) {
        if (error?.code === 11000) {
          const winner = await callbacks.findOne({ orderId: order._id, eventId });
          if (winner?.payloadFingerprint && winner.payloadFingerprint !== payloadFingerprint) finalGroupRejection = c.json({ code: "CALLBACK_IDEMPOTENCY_CONFLICT", message: "相同回调编号不能更改结果内容" }, 409);
          return winner?.payloadFingerprint === payloadFingerprint && winner?.resultStatus === "processing";
        }
        throw error;
      }
    };
    if (["started", "progress"].includes(status)) {
      if (order.slotLeaseRequired && !await slots.renew({ ...slotFence(order), now, estimatedSeconds: etaSeconds, expiresAt: new Date(now.getTime() + CAPABILITY_CLAIM_LEASE_MS) })) return c.json({ code: "CLAIM_SLOT_EXPIRED", message: "节点执行槽续期失败，请停止任务" }, 409);
      if (!await claimEvent()) return finalGroupRejection || c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
      const updated = await orders.findOneAndUpdate({ _id: order._id, status: { $in: ["claimed", "processing"] }, claimId: order.claimId }, { $set: { status: "processing", lastCallbackEventId: eventId, lastCallbackFingerprint: payloadFingerprint, stage: String(body.stage || "processing").slice(0, 120), progress, elapsedSeconds, etaSeconds, estimatedTotalSeconds: estimatedTotalSeconds || order.estimatedTotalSeconds || null, claimLeaseUntil: new Date(now.getTime() + CAPABILITY_CLAIM_LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
      await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: updated?.status || order.status } });
      return c.json({ ok: true, idempotent: false, order_status: updated?.status || order.status, progress, eta_seconds: etaSeconds });
    }
    if (status === "completed") {
      const capability = CAPABILITY_MAP.get(order.capabilityId);
      if (order.capabilityId === "gulong_engine.music") {
        const musicRate = await enforceRateLimit(`capability-music-verify:${order._id}:${order.claimId}`, { limit: 2, windowMs: 60_000 });
        if (!musicRate.allowed) return c.json({ code: "RATE_LIMITED", message: "完整音频正在校验，请稍后重试同一完成回调" }, 429);
      }
      const inlineResult = body.inline_result == null ? null : body.inline_result;
      if (!validateEnglishInlineResult(order.capabilityId, inlineResult, order.parameters)) return c.json({ code: "ENGLISH_RESULT_INVALID", message: "英语结果必须符合文本或声学发音评估合同" }, 400);
      if (!validateGulongEngineInlineResult(order.capabilityId, inlineResult)) return c.json({ code: "GULONG_ENGINE_RESULT_INVALID", message: "绿色版文本结果必须包含不超过 64 KB 的文字" }, 400);
      const outputRefs = Array.isArray(body.outputs) ? body.outputs : [];
      if (inlineResult != null && (!capability.inlineResult || Buffer.byteLength(JSON.stringify(inlineResult)) > (capability.maxInlineResultBytes || 64_000))) return c.json({ code: "INLINE_RESULT_NOT_ALLOWED", message: "该能力不允许此内联结果或结果超过本能力大小上限" }, 400);
      if (!outputRefs.length && inlineResult == null) return c.json({ code: "OUTPUT_REQUIRED", message: "完成回调必须包含输出清单或允许的内联结果" }, 400);
      const outputIds = outputRefs.map((item) => String(item.output_id || ""));
      if (new Set(outputIds).size !== outputIds.length) return c.json({ code: "DUPLICATE_OUTPUT_REFERENCE", message: "完成回调不能重复引用同一个 output_id" }, 400);
      const grants = outputIds.length ? await (await getCollection("capabilityOutputUploads")).find({ outputId: { $in: outputIds }, orderId: order._id, claimId: order.claimId, issuedToBindingId: auth.binding._id, status: "issued", expiresAt: { $gt: now } }).toArray() : [];
      if (grants.length !== outputIds.length) return c.json({ code: "OUTPUT_GRANT_MISMATCH", message: "输出上传票据无效、过期或不属于当前执行节点" }, 409);
      const roleCounts = new Map();
      for (const grant of grants) roleCounts.set(grant.role, (roleCounts.get(grant.role) || 0) + 1);
      try { validateNativeOutputSet(order, grants); }
      catch (error) { return c.json({ code: error.code, message: error.message }, error.status); }
      for (const rule of capability.outputRules) {
        const count = roleCounts.get(rule.role) || 0;
        const requiredMinimum = inlineResult != null && capability.inlineResult && !isWorkLuckyCapability(order.capabilityId) ? 0 : rule.min;
        if (count < requiredMinimum || count > rule.max) return c.json({ code: "INVALID_OUTPUT_ROLE_COUNT", message: `输出角色 ${rule.role} 需要 ${requiredMinimum}–${rule.max} 个，当前为 ${count} 个` }, 400);
      }
      const outputs = [];
      const publishedCopyIds = [];
      for (const grant of grants) {
        let head;
        try { head = await inspectCosObject(grant.objectKey); } catch { return c.json({ code: "OUTPUT_NOT_FOUND", message: `COS 中尚未找到输出 ${grant.filename}` }, 409); }
        const valid = objectBytes(head) === grant.bytes
          && objectHeader(head, "x-cos-meta-sha256").toUpperCase() === grant.sha256
          && objectHeader(head, "x-cos-meta-bytes") === String(grant.bytes)
          && objectHeader(head, "x-cos-meta-capability-order-id") === order._id.toString()
          && objectHeader(head, "x-cos-meta-capability-output-id") === grant.outputId
          && objectHeader(head, "x-cos-meta-node-id-hash") === createHash("sha256").update(auth.binding.nodeId).digest("hex");
        if (!valid) return c.json({ code: "OUTPUT_RECEIPT_MISMATCH", message: `输出 ${grant.filename} 的大小、摘要或归属校验失败` }, 409);
        if (order.capabilityId === "gulong_engine.tts") {
          let digestMatches;
          try { digestMatches = await verifyAudioObject(grant); }
          catch { return c.json({ code: "OUTPUT_VERIFICATION_UNAVAILABLE", message: "配音文件暂时无法完成内容校验，请稍后重试完成回调" }, 503); }
          if (!digestMatches) return c.json({ code: "OUTPUT_CONTENT_HASH_MISMATCH", message: "配音文件实际内容与 SHA-256 回执不一致" }, 409);
        }
        let actualAudio = null;
        let publishedKey = grant.objectKey;
        if (order.capabilityId === "gulong_engine.music") {
          publishedKey = `capability-orders/${order._id}/published/${grant.outputId}-${randomBytes(12).toString("hex")}-${grant.filename}`;
          const sourceETag = objectHeader(head, "etag");
          if (!sourceETag) return c.json({ code: "OUTPUT_ETAG_REQUIRED", message: "音乐文件缺少对象版本校验凭据，请重试上传" }, 409);
          try {
            const copyId = new ObjectId();
            await (await getCollection("capabilityOutputCopies")).insertOne({ _id: copyId, orderId: order._id, claimId: order.claimId, outputId: grant.outputId, objectKey: publishedKey, status: "staging", expiresAt: new Date(now.getTime() + 60 * 60_000), createdAt: now });
            publishedCopyIds.push(copyId);
            await publishCosObject(grant.objectKey, publishedKey, { sourceETag });
            actualAudio = await verifyFlacObject({ ...grant, objectKey: publishedKey });
          } catch (error) { return c.json({ code: typeof error.code === "string" ? error.code : "OUTPUT_VERIFICATION_UNAVAILABLE", message: typeof error.code === "string" && error.code.startsWith("FLAC_") ? error.message : "完整音乐文件暂时无法安全发布或校验，请稍后重试原完成回调", }, error.status >= 400 && error.status < 500 ? error.status : 503); }
          if (actualAudio.bytes !== grant.bytes || actualAudio.sha256.toUpperCase() !== grant.sha256) return c.json({ code: "OUTPUT_CONTENT_HASH_MISMATCH", message: "音乐文件实际内容与摘要回执不一致" }, 409);
        }
        outputs.push({ outputId: grant.outputId, role: grant.role, filename: grant.filename, contentType: grant.contentType, bytes: grant.bytes, sha256: grant.sha256, objectKey: publishedKey, ...(actualAudio ? { durationSeconds: actualAudio.durationSeconds } : {}) });
      }
      try { validateSpecialInlineResult(order, inlineResult, { outputs }); }
      catch (error) { return c.json({ code: error.code || "CAPABILITY_RESULT_INVALID", message: error.message }, error.status || 400); }
      if (!await claimEvent()) return finalGroupRejection || c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
      const completed = await orders.findOneAndUpdate({ _id: order._id, status: { $in: ["claimed", "processing"] }, claimId: order.claimId }, { $set: { status: "completed", lastCallbackEventId: eventId, lastCallbackFingerprint: payloadFingerprint, stage: "completed", progress: 100, elapsedSeconds, etaSeconds: 0, inlineResult, outputs, completedAt: now, updatedAt: now }, $unset: { claimLeaseUntil: "" } }, { returnDocument: "after" });
      if (!completed) return c.json({ code: "ORDER_STATE_CONFLICT", message: "订单状态已变化，完成结果未重复写入" }, 409);
      if (publishedCopyIds.length) await (await getCollection("capabilityOutputCopies")).updateMany({ _id: { $in: publishedCopyIds }, status: "staging" }, { $set: { status: "retained", retainedAt: now }, $unset: { expiresAt: "" } });
      if (grants.length) await (await getCollection("capabilityOutputUploads")).updateMany({ outputId: { $in: outputIds }, status: "issued" }, { $set: { status: "completed", completedAt: now, updatedAt: now }, $unset: { expiresAt: "" } });
      await releaseOrderSlot(order);
      await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "completed" } });
      return c.json({ ok: true, idempotent: false, order_status: "completed" });
    }
    if (status === "failed") {
      const retryable = body.retryable === true;
      const canRetry = retryable && integer(order.attempt) < integer(order.maxAttempts, 2);
      const error = { code: String(body.error_code || "CAPABILITY_EXECUTION_FAILED").slice(0, 100), message: localizeErrorMessage(body.error_message, "本地能力执行失败").slice(0, 500), retryable };
      if (!await claimEvent()) return finalGroupRejection || c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
      if (canRetry) {
        await orders.updateOne({ _id: order._id, claimId: order.claimId, status: { $in: ["claimed", "processing"] } }, { $set: { status: "queued", lastCallbackEventId: eventId, lastCallbackFingerprint: payloadFingerprint, stage: "retry_wait", error, nextEligibleAt: new Date(now.getTime() + Math.min(300, Math.max(5, integer(body.retry_after_seconds, 15))) * 1000), updatedAt: now }, $unset: { assignedNode: "", claimId: "", claimLeaseUntil: "", claimedAt: "" } });
        await releaseOrderSlot(order);
        await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "queued" } });
        return c.json({ ok: true, idempotent: false, order_status: "queued", retry_scheduled: true });
      }
      await orders.updateOne({ _id: order._id, claimId: order.claimId, status: { $in: ["claimed", "processing"] } }, { $set: { status: "failed", lastCallbackEventId: eventId, lastCallbackFingerprint: payloadFingerprint, stage: "failed", error, failedAt: now, updatedAt: now }, $unset: { claimLeaseUntil: "" } });
      await releaseOrderSlot(order);
      await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "failed" } });
      return c.json({ ok: true, idempotent: false, order_status: "failed", retry_scheduled: false });
    }
    if (!await claimEvent()) return finalGroupRejection || c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
    await orders.updateOne({ _id: order._id, claimId: order.claimId, status: { $in: ["claimed", "processing"] } }, { $set: { status: "cancelled", lastCallbackEventId: eventId, lastCallbackFingerprint: payloadFingerprint, stage: "cancelled", cancelledAt: now, cancelReason: "worker_cancelled", updatedAt: now }, $unset: { claimLeaseUntil: "" } });
    await releaseOrderSlot(order);
    await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "cancelled" } });
    return c.json({ ok: true, idempotent: false, order_status: "cancelled" });
  });

  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/by-request/{key}", tags: ["Unified Capability Orders"], summary: "按同账户稳定请求编号恢复订单", responses: { 200: { description: "自己的原订单；套餐到期仍可查询" }, 404: { description: "尚无该请求" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/by-request/{key}/cancel", tags: ["Unified Capability Orders"], summary: "按请求编号幂等取消并阻止迟到创建", responses: { 200: { description: "原订单或原子cancelled tombstone；不会产生新执行任务" } } });
  const reportSchema = z.object({
    capability_id: z.string(), capability_version: z.string(), protocol_version: z.literal(CAPABILITY_ORDER_PROTOCOL),
    installed: z.literal(true), validated: z.literal(true), enabled: z.literal(true), max_concurrent: z.number().int().min(1).max(16),
    sharing_opt_in: z.boolean().optional(), supported_models: z.array(z.string()).optional(), supported_voices: z.array(z.string()).optional(),
    models: z.array(z.object({ id: z.string().min(1).max(240), dimension: z.number().int().positive().optional(), max_duration_seconds: z.number().min(1).max(600).optional(), tools: z.boolean().optional(), multimodal: z.boolean().optional() })).optional(),
    default_model: z.string().nullable().optional(), asr_languages: z.array(z.enum(["zh", "en"])).optional(),
    validation: z.object({ tested_at: z.iso.datetime(), artifact_sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/), runtime_version: z.string().optional(), test_id: z.string().optional(), acceptance_id: z.string().optional(), contract_tests: z.record(z.string(), z.boolean()).optional() }),
  });
  app.openAPIRegistry.registerComponent("schemas", "WorkLuckySharedCapabilityContract", {
    type: "object", description: "WorkLucky 共享能力 1.0.0：使用 Bearer gge_at_ 会话；新建 JSON 必须 client_product=worklucky、capability_version=1.0.0，查询/恢复必须 ?product=worklucky，取消 JSON 带 client_product。新增能力由自动探测按节点 binding、算力分组、artifact_sha256 与精确模型参数验收；不再要求人工 acceptance_id。已有有效历史记录仅作未升级消费者兼容。目录 availability.models 为真实模型矩阵，default_model 必须是已验收模型；节点物理容量以 Mongo CAS 原子槽为准。不存在真实模型/维度或未验收不能派单，无远程收费回退。",
    properties: {
      agent_chat: { type: "object", description: "capability_id=gulong_engine.agent_chat；parameters={model,request}，request 为完整 OpenAI Chat Completions JSON，model 必须精确相等。inline_result.response 为完整原始响应含 choices/tools/usage，不由官网执行工具。每模型 tools/multimodal 必须单独验收。" },
      embedding: { type: "object", description: "capability_id=gulong_engine.embedding；parameters={model,dimension,request}，request 为完整 OpenAI Embeddings JSON；完整 response.data 索引、顺序、向量维度和 usage 必须保留，不能换模型/裁切/补齐。" },
      music: { type: "object", description: "capability_id=gulong_engine.music；parameters={caption,lyrics,seconds,seed,model?}，seed 非负安全整数或 uint64 十进制字符串原值；seconds 为最长秒数。primary_audio 必须 FLAC，经私有 COS 条件复制至无 PUT 授权随机 published key 后完整流式校验 SHA/大小及 STREAMINFO 实际 duration_seconds。inline_result.lyric_verification 必须 {algorithm:ordered-whole-lyrics-v1,audio_sha256,lyrics_sha256,full_audio:true,language:zh|en,transcript:整段原文含尾部}。不能仅给 verified 布尔值。" },
      music_node_limits: { type: "object", description: "music节点 models 每项必须为 {id,max_duration_seconds}，时长上限为1–600秒的有限数值，精确绑定管理员真实验收。availability.models 汇总同模型已验收节点的最长支持时长。创建/领取只匹配原始 seconds 不超过该节点模型上限的任务；300秒节点不会领取301/600秒，不会裁切参数。全局600秒schema不代表当前节点已支持600秒。" },
      limits: { type: "object", description: "parameters 最大1MiB，inline_result 最大4MiB；claim请求256KiB，callback包络4MiB+128KiB；FLAC最大64MiB。超限413，不截断。callback按绑定限流60次/分钟，单音乐完成校验最多2次/分钟，429后按同event_id恢复。" },
      lifecycle: { type: "object", description: "claim租约300秒，started/progress同时续租订单和槽位；每15秒worker-state，should_stop或租约失效必须停止。用户取消先保留运行槽，执行节点cancelled确认停机后释放。event_id+payload指纹幂等，改变payload409，写入中断可重放原事件补偿。音乐单primary_audio签发幂等同output_id；其他输出可用output_key。" },
    },
  });
  app.openAPIRegistry.registerComponent("schemas", "NativeSharedCapabilityContract", {
    type: "object", description: "原生六能力按真实自动验收范围加入古龙引擎/WorkLucky共享，不代表节点消费者已发布。client_product=gulong_engine|worklucky；查询与恢复使用同值?product=；取消JSON沿用client_product。产品标记参与幂等身份，不能跨产品复用请求。有效古龙引擎包月或管理员、明确共享、服务端自动证明、同算力分组及物理槽位缺一不可。零价，不扣余额、不分佣，无付费回退。旧未标记同账户原生订单保留原合同。",
    properties: {
      capability_ids: { type: "array", items: { type: "string", enum: [...NATIVE_SHARED_CAPABILITY_IDS] } },
      availability: { type: "object", description: "鉴权目录availability.native_profiles返回实际通过的精确模型参数交集；文生图沿用availability.models。模型/版本/制品变化、证明到期或不匹配时禁止派单。固定schema并非全部参数已支持。" },
      native_layers: { type: "object", description: "sam.video_track输出native_layers时必须manifest_json(application/json)+tracks_jsonl(application/x-ndjson)+mask_archive(application/zip)各1份；mediapipe.video_analysis必须analysis_json+pose_tracks_jsonl+person_layers_archive各1份。claim.required_output_roles指定全部必需角色，不得冒充mask_video或用内联布尔代替实物。" },
      upload_purpose: { type: "object", description: "古龙引擎桌面会话上传原生输入时可向capability-assets/presign提交精确capability_id，按对应目录MIME/字节上限允许Whisper音频和SAM/姿态源视频；账号私有归属、SHA和COS校验不变。" },
      verification: { type: "object", description: "专属report-v2完整库存+逐能力迁移。Qwen原生合同2.1/Music3合同3/SAM3.1-object-multiplex/Whisperlarge-v3-turbo-whisper.cpp/MediaPipe0.10.14-pose-full，只认精确适配版本与真实模型编号。固定input_assets短期GET、完整摘要；output_requirements指定全部实物输出。探测最多一次推理，音乐一次整段ASR，不创建业务或钱包记录。" },
    },
  });
  app.openAPIRegistry.registerComponent("schemas", "DigitalLiveSharedCapabilityContract", {
    type: "object", description: "数字直播为独立digital_live产品，包含在有效gulong_engine_monthly中，不增加SKU/费用。GGE auth/login和account在active时返回digital_live.use；相同GGE身份不是WorkLucky产品别名。订单client_product=digital_live，查询/恢复?product=digital_live，取消JSON沿用产品。价格0分、charge_status=exempt、不扣钱包、不分佣，无付费回退。仅真实自动验收/已授权共享/同组/原子物理槽的节点可以派单；纯软件权益不证明模型已在线。",
    properties: {
      capability_ids: { type: "array", items: { type: "string", enum: [...DIGITAL_LIVE_CAPABILITY_IDS] } },
      model_policy: { type: "object", description: "文本限定qwen38-27b-uncensored组件，当前实际runtime编号qwen38-27b-uncensored-q4-k-m，必须原样选择真实目录模型ID。无后缀ID只有自身独立报告/探测通过才可用，不是量化ID的别名证明；不重写请求，不降至Qwen3-1.7B。图像固定Qwen-Image精确范围；ASR/TTS只按真实模型及同一音色组合。未验收或无指定模型时目录节点数0且不下单。" },
      request_identity: { type: "object", description: "首次发送前持久化8–160位ASCII原请求键。Idempotency-Key或JSON client_request_id均可；同时存在必须完全一致。订单回显client_request_id，按原键GET by-request及取消墓碑，不换键重复执行。账号+产品隔离，不能与WorkLucky/无产品订单跨读、取消或复用。" },
      realtime: { type: "object", description: "integration_required：没有会话型连续音视频、流式媒体、打断/背压、远程avatar或高光专用消费者；不能将异步claim/callback/轮询冒充实时。" },
    },
  });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/desktop/digital-live/config", tags: ["Digital Live Desktop"], summary: "读取数字直播包含权益、独立订单与实时缺口合同", security: [],
    description: "返回digital-live-product-v1及现有包月权威价格，不单独收费；认证复用/api/v1/desktop/gulong-engine。候选能力不等于已验收节点，必须再读鉴权目录。realtime/avatar/highlights明确integration_required，未提供虚假流式URL。", responses: { 200: { description: "不缓存的独立产品配置" }, 400: { description: "产品参数不匹配" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/catalog", tags: ["Unified Capability Orders"], summary: "读取官网统一能力目录", description: "english_coach.* 已全部转为 local_only。gulong_engine.* 的 dispatchable 根据近 3 分钟真实上报、有效绑定、30 天内推理验证与共享授权动态计算；availability 返回 verified_node_count、free_slot_count、status=ready|busy|offline|adapter_required。busy 表示有兼容节点但暂无线程空位，仍可排队；offline 不接受新任务。gulong_engine.tts 还要求 1.0.0 合同；新消费者必须读取 availability.models=[{id,voice_id}] 并选择同一条已自动验收的精确模型/音色，不能把不同条目的模型和音色交叉组合。availability.voice_ids 仅为旧版扁平兼容字段，不证明模型/音色交集。大展宏图原生 2K 使用独立 gulong_engine.image_2k、required_capability_version=1.0.0；新消费者的 availability.models 仅在对应自动验收有效时包含 {id:qwen_image_2_1}。tts/image_2k 未验收矩阵均为 []，不能从固定 schema 或客户端自报猜测可用模型。旧 qwen_image_2_1.* 报告不视为兼容。gulong_engine.video 在消费适配完成前始终 adapter_required；收费 /api/h3/tasks 独立。目录不缓存，不保证随后创建时可用性不变。", responses: { 200: { description: "能力合同与实时节点可用性" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-assets/presign", tags: ["Unified Capability Orders"], summary: "幂等签发能力订单输入素材 COS 直传票据", description: "JSON基础字段filename/content_type/bytes/sha256。新客户端同时提供request_key（每素材稳定8–160位ASCII编号）、client_product=gulong_engine|worklucky、capability_id及role，完整清单绑定唯一asset_id。同键改清单/跨产品409；重放只恢复原素材，不创建第二对象。新票据签名包含x-cos-forbid-overwrite=true，版本桶或存储状态未知时不签PUT。失去响应先GET原请求；只有明确awaiting_upload才能向同一object_key续传，原1小时期限不延期。古龙引擎桌面会话可以指定原生六能力的精确capability_id，以目录MIME/大小边界上传其参考图、源视频或ASR音频；并非开放未实现的统一视频能力。旧无请求键素材保留旧合同。英语教练新录音仍local_only。", responses: { 201: { description: "新建原素材意图及账号专属防覆盖PUT票据" }, 200: { description: "同一原请求的当前阶段与凭据；已有对象不重签PUT" }, 409: { description: "清单冲突、不可恢复状态或存储不支持防覆盖" }, 503: { description: "存储状态未知，只能查询，不得重传" } } });
  const recoverableAssetSchema = z.object({
    asset_id: z.string(), asset: z.object({ asset_id: z.string(), filename: z.string(), content_type: z.string(), bytes: z.number().int(), sha256: z.string() }),
    client_product: z.enum(["gulong_engine", "worklucky", "digital_live"]), capability_id: z.string(), role: z.string(), idempotent: z.boolean(),
    stage: z.enum(["awaiting_upload", "uploaded", "ready", "expired", "unknown", "mismatch", "rejected"]), can_upload: z.boolean(), can_complete: z.boolean(),
    upload_url: z.string().optional(), method: z.literal("PUT").optional(), headers: z.record(z.string(), z.string()).optional(),
    object_key: z.string().optional(), expires_at: z.iso.datetime().optional(), code: z.string().optional(), message: z.string().optional(),
  });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-assets/by-request/{key}", tags: ["Unified Capability Orders"],
    summary: "按账号、产品和原素材编号只读恢复上传阶段", description: "不创建新素材、不变更阶段、不自动complete。ready只返原receipt；uploaded表示COS HEAD清单全匹配，只能POST原id/complete；awaiting_upload仅在COS明确404、防覆盖策略与CORS核对通过时签同对象PUT（不延长原1小时）；未知503、错清单409、过期410都不发PUT。恢复接口本身不上传或触发推理。账号及product必须精确匹配，不向其他账户泄露记录。", request: { params: z.object({ key: z.string().regex(assetRequestPattern) }), query: z.object({ product: z.enum(["gulong_engine", "worklucky", "digital_live"]) }) },
    responses: { 200: { description: "原素材及精确阶段，private/no-store", content: { "application/json": { schema: recoverableAssetSchema } } }, 401: { description: "未登录" }, 404: { description: "本账户尚无该素材请求" }, 409: { description: "产品/清单/存储策略冲突，无PUT" }, 410: { description: "原上传期限已过，不重发PUT" }, 503: { description: "状态未知，只查询，不上传" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-assets/{id}/complete", tags: ["Unified Capability Orders"], summary: "幂等校验原素材大小、摘要与归属", description: "新产品标记素材必须?product=worklucky或gulong_engine；同账号同产品重复完成返回同asset receipt和idempotent=true，ready状态不重签PUT。HEAD未知时新素材返回503，先GET原request_key查询，不能重复上传。旧未标记素材无需product，保持兼容。", responses: { 200: { description: "原asset receipt，无新上传/订单/记账" }, 409: { description: "产品/清单或状态CAS冲突" }, 503: { description: "存储状态暂不可确认" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders", tags: ["Unified Capability Orders"], summary: "幂等创建同账户本地能力订单", description: "english_coach.* 新任务已改为本地处理，返回 409 CAPABILITY_LOCAL_ONLY；旧订单仍可读取或取消。BIN、模型配件和 runtime 不是独立能力。收费 minimax_h3.video_generation 继续使用 /api/h3/tasks；零价 gulong_engine.video 在消费者完成真实验收前返回 409 CAPABILITY_ADAPTER_REQUIRED。gulong_engine.text/image/image_2k/tts 若无实时兼容节点返回 409 CAPABILITY_NO_COMPATIBLE_NODE，不创建订单；已创建的旧订单不受此创建门禁影响。tts 需要有效古龙引擎包月和 capability_version=1.0.0；parameters 提交 text(1–12000 字符)、voice_id(目录 availability.voice_ids 中的 ID)、language、speed、output_format=mp3|wav；不上传输入素材，primary_audio 直传 COS，完成回调验证对象内容 SHA-256。image_2k 需要有效古龙引擎包月、capability_version=1.0.0；parameters 提交 model=qwen_image_2_1、task=text_to_image|multi_image_edit、prompt、width/height(官方七种 2K 尺寸)、generation_mode=standard|fast_lora_6、steps(快速模式必须6)、prompt_enhancement=none|official|local；assets 按输入数组顺序传 0 或 1–10 张 reference_image。v1 本地能力订单价格为 0 分，不扣钱包且无分佣。", responses: { 201: { description: "订单已入队，含 queue_position、auto_cancel_at、queue_reason_code、queue_message" }, 403: { description: "古龙引擎包月权益未生效" }, 409: { description: "本地处理、无兼容节点、版本不符、幂等冲突、适配未验收或旧 H3 接口" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/{id}", tags: ["Unified Capability Orders"], summary: "查询订单进度、排队位置、ETA 与短时结果下载票据", responses: { 200: { description: "仅返回本人订单；排队含 queue_position、estimated_wait_seconds、queue_reason_code、queue_message、auto_cancel_at；排队超时返回 cancelled、CAPABILITY_QUEUE_TIMEOUT；执行含 progress、eta_seconds" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/{id}/cancel", tags: ["Unified Capability Orders"], summary: "幂等取消能力订单", responses: { 200: { description: "取消状态与零费用退款边界" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/{id}/worker-state", tags: ["Unified Capability Orders"], summary: "执行节点轮询取消与租约状态", description: "执行节点每 15 秒轮询；claim_id 必须匹配且只能由 assigned_node 自己的绑定令牌读取。started/progress 回调会把 5 分钟租约重新续满。", security: [{ accountBinding: [] }], request: { query: z.object({ claim_id: z.string().min(8) }) }, responses: { 200: { description: "cancellation_requested、should_stop 与 lease_expires_at" }, 409: { description: "订单未分配或 claim 不匹配" } } });
  const resourceSchema = z.object({ running_task_count: z.number().int().min(0).max(1_000_000),
    estimated_total_seconds: z.number().int().min(0).max(2678400), max_concurrent_tasks: z.number().int().min(1).max(16),
    gpu_state: z.enum(["idle", "busy", "unknown"]).optional(), gpu_observed_at: z.iso.datetime().nullable().optional(),
    current_task_remaining_seconds: z.number().int().min(0).max(2678400).nullable().optional() });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/claim", tags: ["Unified Capability Orders"], summary: "按 FIFO、空闲显卡优先与最短剩余负载领取能力订单", description: "节点能力必须 installed=true、validated=true、enabled=true。每次拉单上报 resources.gpu_state=idle|busy|unknown、gpu_observed_at 与 current_task_remaining_seconds（任务列表总剩余秒数）；兼容旧 estimated_total_seconds。显卡状态仅30秒有效，未来偏移最多5秒，缺省/过期为unknown，服务端活跃租约保守视为busy。每单优先兼容的idle节点，否则按总剩余秒数（包含服务端新预留负载）最短分配。全局比较近3分钟已认证节点报告，跨账号优胜节点必须自行拉单，绝不由其他账户LAN代理；当前节点返回task=null及next_poll_after_seconds=2，FIFO订单全局偏好等待最多5秒以防饿死。绑定、分组、模型、自动验收与原子槽位门禁均保留。dry_run=true 不读取/修改队列或发布节点报告。", security: [{ accountBinding: [] }], request: { body: { content: { "application/json": { schema: z.object({ protocol_version: z.literal(CAPABILITY_ORDER_PROTOCOL), node_id: z.string(), node_name: z.string(), dry_run: z.boolean().optional(), capabilities: z.array(reportSchema).min(1), resources: resourceSchema, lan_cluster: z.object({ cluster_id: z.string(), nodes: z.array(z.object({ node_id: z.string(), node_name: z.string(), capabilities: z.array(reportSchema), resources: resourceSchema })) }).optional() }) } } } }, responses: { 200: { description: "最小权限 worker task、素材短时下载票据与输出上传入口，或空任务和有界重试建议" }, 400: { description: "资源状态、时间或剩余耗时格式不正确" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/{id}/outputs/presign", tags: ["Unified Capability Orders"], summary: "执行节点为一个结果签发 COS 直传票据", description: "返回 output_id、upload_url、method=PUT、headers/required_headers、object_key、expires_at、expires_in_seconds=3600 与 complete_via。role/MIME/单文件大小/数量按目录能力合同强校验。", security: [{ accountBinding: [] }], responses: { 201: { description: "与订单、claim、节点、输出 role、MIME、大小和摘要绑定的完整 PUT 票据" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/callback", tags: ["Unified Capability Orders"], summary: "幂等回调进度、ETA、失败重试或完成结果", description: "JSON 回调不接收二进制文件。started/progress 每次都把 claim 续租 300 秒；completed 只接受已通过 COS HEAD 校验且符合输出 role 合同的 output_id。gulong_engine.tts 额外从私有 COS 读取最多 32 MiB 的音频内容并校验实际 SHA-256；网络暂不可读返回 503，可用同一 event_id 重试，摘要不符返回 409。文本类能力可使用不超过 64 KB 的 inline_result。event_id 在订单内唯一。", security: [{ accountBinding: [] }], responses: { 200: { description: "事件已幂等处理" }, 409: { description: "claim、执行节点、订单状态或输出回执不匹配" }, 503: { description: "音频内容暂无法校验，可稍后重试" } } });
}
