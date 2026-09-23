import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { fingerprintIp, hashOpaqueToken } from "./security.js";
import { createPresignedDownloadUrl, createPresignedPutUrl, deleteObject, ensureBrowserUploadCors, headObject, sanitizeFilename } from "./cos.js";
import { localizeErrorMessage } from "../shared/error-messages.js";
import { readEnglishEntitlement, readGulongEngineEntitlement } from "./english-coach-products.js";
import { ENGLISH_AUDIO_MAX_BYTES, ENGLISH_AUDIO_MIME, ENGLISH_CAPABILITY_DEFINITIONS, englishNodeSharesCapability, englishWorkerOwnsClaim, isEnglishCapability, validateEnglishInlineResult } from "./english-coach-capabilities.js";
import { GULONG_ENGINE_CAPABILITY_DEFINITIONS, gulongEngineNodeSharesCapability, isGulongEngineCapability, validateGulongEngineInlineResult } from "./gulong-engine-capabilities.js";

export const CAPABILITY_ORDER_PROTOCOL = "gulong-capability-orders-v1";
export const CAPABILITY_BINDING_HEADER = "X-Gulong-Account-Binding";
const CAPABILITY_REPORT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CAPABILITY_CLAIM_LEASE_MS = 5 * 60_000;
const CAPABILITY_MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const CAPABILITY_TERMINAL = new Set(["completed", "failed", "cancelled"]);

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"];
const AUDIO_MIME = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac"];
const VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime"];

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
    word_timestamps: booleanField(true),
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
    prompt_mode: enumField(["everything", "points", "box"], "everything"),
    points: { type: "array", maxItems: 64, default: [], items: objectSchema({ x: numberField({ minimum: 0, maximum: 1 }), y: numberField({ minimum: 0, maximum: 1 }), label: integerField({ enum: [0, 1] }) }, ["x", "y", "label"]) },
    box: { type: ["array", "null"], minItems: 4, maxItems: 4, default: null, items: numberField({ minimum: 0, maximum: 1 }) },
    start_frame: integerField({ minimum: 0, maximum: 1000000, default: 0 }),
    end_frame: integerField({ minimum: -1, maximum: 1000000, default: -1 }),
    sample_fps: integerField({ minimum: 1, maximum: 60, default: 24 }),
    output_format: enumField(["mask_video", "tracks_json", "both"], "both"),
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
    output_fps: integerField({ minimum: 1, maximum: 120, default: 30 }),
    include_world_landmarks: booleanField(true),
    include_annotated_video: booleanField(false),
    output_format: enumField(["json", "csv", "both"], "json"),
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
  ],
  "mediapipe.pose_track": [
    { role: "pose_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 256 * 1024 * 1024 },
    { role: "pose_csv", min: 0, max: 1, mimeTypes: ["text/csv"], maxBytes: 256 * 1024 * 1024 },
  ],
  "mediapipe.video_analysis": [
    { role: "analysis_json", min: 0, max: 1, mimeTypes: ["application/json"], maxBytes: 512 * 1024 * 1024 },
    { role: "analysis_csv", min: 0, max: 1, mimeTypes: ["text/csv"], maxBytes: 512 * 1024 * 1024 },
    { role: "annotated_video", min: 0, max: 1, mimeTypes: ["video/mp4", "video/webm"], maxBytes: CAPABILITY_MAX_ASSET_BYTES },
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
  definition("sam.video_track", VIDEO_MIME, ["video/mp4", "video/webm", "application/json"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 300, maxRuntimeSeconds: 3600, inlineResult: true }),
  definition("mediapipe.pose_track", VIDEO_MIME, ["application/json", "text/csv"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 240, maxRuntimeSeconds: 3600, inlineResult: true, dispatchable: false }),
  definition("mediapipe.video_analysis", VIDEO_MIME, ["application/json", "text/csv", "video/mp4", "video/webm"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 240, maxRuntimeSeconds: 3600, inlineResult: true }),
  definition("dwpose.estimate", ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"], ["application/json", "image/png"], { maxAssets: 1, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 120, maxRuntimeSeconds: 1800, inlineResult: true, dispatchable: false }),
  definition("prompt.optimize_translate", [], ["application/json", "text/plain"], { defaultEtaSeconds: 45, maxRuntimeSeconds: 300, inlineResult: true }),
  definition("minimax_h3.video_generation", ["image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg", "audio/wav"], ["video/mp4"], { maxAssets: 15, maxTotalInputBytes: CAPABILITY_MAX_ASSET_BYTES, defaultEtaSeconds: 1200, maxRuntimeSeconds: 6 * 60 * 60, legacyRoute: "/api/h3/tasks" }),
]);

const CAPABILITY_MAP = new Map(CAPABILITY_ORDER_DEFINITIONS.map((item) => [item.capabilityId, item]));

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
  if (serialized.length > 64_000) throw Object.assign(new Error("能力参数不能超过 64 KB"), { code: "VALIDATION_ERROR", status: 400 });
  if (/"(?:__proto__|prototype|constructor)"\s*:/u.test(serialized)) throw Object.assign(new Error("能力参数包含不安全字段"), { code: "VALIDATION_ERROR", status: 400 });
  const normalized = applySchemaDefaults(capability.parametersSchema, JSON.parse(serialized));
  validateJsonValue(capability.parametersSchema, normalized);
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
  if (capability.capabilityId === "sam.video_track") {
    if (parameters.prompt_mode === "points" && !parameters.points.length) throw validationError("points 模式至少需要一个点", "parameters.points");
    if (parameters.prompt_mode === "box" && !Array.isArray(parameters.box)) throw validationError("box 模式必须提供归一化边框 [x1,y1,x2,y2]", "parameters.box");
    if (parameters.end_frame !== -1 && parameters.end_frame < parameters.start_frame) throw validationError("必须为 -1 或不小于 start_frame", "parameters.end_frame");
  }
}

export function normalizeCapabilityReport(value = {}, now = new Date()) {
  const capabilityId = String(value.capability_id || value.capabilityId || "").trim().toLowerCase();
  const definition = CAPABILITY_MAP.get(capabilityId);
  if (!definition || definition.legacyRoute) throw Object.assign(new Error("节点上报了未注册或需走旧版接口的能力"), { code: "UNKNOWN_CAPABILITY", status: 400 });
  if (!definition.dispatchable) throw Object.assign(new Error("该能力尚未完成独立订单适配与真实推理验收，暂不可上报接单"), { code: "CAPABILITY_ADAPTER_REQUIRED", status: 409 });
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
  return {
    capabilityId,
    capabilityVersion: String(value.capability_version || value.capabilityVersion || "1").trim().slice(0, 80),
    protocolVersion,
    installed,
    validated,
    enabled,
    maxConcurrent,
    sharingOptIn: (isEnglishCapability(capabilityId) || isGulongEngineCapability(capabilityId)) && value.sharing_opt_in === true,
    supportedModels: isGulongEngineCapability(capabilityId) && Array.isArray(value.supported_models)
      ? value.supported_models.filter((model) => typeof model === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(model)).slice(0, 32) : [],
    validation: {
      testedAt,
      artifactSha256,
      runtimeVersion: String(value.validation?.runtime_version || value.validation?.runtimeVersion || "").trim().slice(0, 120) || null,
      testId: String(value.validation?.test_id || value.validation?.testId || "").trim().slice(0, 120) || null,
    },
  };
}

export function capabilityNodeCanRunOrder(node, order) {
  if (!node || node.availableSlots < 1) return false;
  if (order.preferredNodeId && order.preferredNodeId !== node.nodeId) return false;
  if (node.binding?.userId && String(node.binding.userId) !== String(order.requesterUserId)
    && !(order.sharingScope === "english_shared" && englishNodeSharesCapability(node, order.capabilityId))
    && !(order.sharingScope === "gulong_shared" && gulongEngineNodeSharesCapability(node, order.capabilityId))) return false;
  return Boolean(node.capabilities?.some((item) => item.capabilityId === order.capabilityId
    && (!order.capabilityVersion || item.capabilityVersion === order.capabilityVersion)
    && item.installed && item.validated && item.enabled
    && (!isGulongEngineCapability(order.capabilityId) || !order.parameters?.model || order.parameters.model === "auto"
      || (item.supportedModels || []).includes(order.parameters.model))));
}

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
    adapter_status: item.legacyRoute ? "legacy_route" : item.adapterStatus,
    legacy_route: item.legacyRoute,
    ...(item.entitlement ? { entitlement: item.entitlement, sharing_scope: item.sharingScope, sharing_opt_in_required: true } : {}),
  };
}

function publicOrder(order, issueDownloadUrl) {
  const results = (order.outputs || []).map((item) => ({
    output_id: item.outputId,
    role: item.role,
    filename: item.filename,
    content_type: item.contentType,
    bytes: item.bytes,
    sha256: item.sha256,
    download_url: issueDownloadUrl(item.objectKey, { expires: 15 * 60, filename: item.filename }),
    download_expires_in_seconds: 900,
  }));
  return {
    id: order._id.toString(),
    order_no: order.orderNo,
    protocol_version: order.protocolVersion,
    capability_id: order.capabilityId,
    capability_version: order.capabilityVersion || null,
    status: order.status,
    progress: integer(order.progress),
    stage: order.stage || null,
    elapsed_seconds: integer(order.elapsedSeconds),
    eta_seconds: order.etaSeconds == null ? null : integer(order.etaSeconds),
    attempt: integer(order.attempt),
    max_attempts: integer(order.maxAttempts),
    preferred_node_id: order.preferredNodeId || null,
    assigned_node: order.assignedNode ? { node_id: order.assignedNode.nodeId, node_name: order.assignedNode.nodeName || null } : null,
    billing: { currency: "CNY", price_fen: integer(order.priceFen), charge_status: order.chargeStatus, refund_status: order.refundStatus },
    inline_result: order.inlineResult || null,
    results,
    error: order.error || null,
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
    order_no: order.orderNo,
    protocol_version: order.protocolVersion,
    capability_id: order.capabilityId,
    capability_version: order.capabilityVersion,
    parameters: order.parameters,
    parameters_schema_version: capability.parametersSchemaVersion,
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
  const removeCosObject = dependencies.deleteObject || deleteObject;
  const ensureUploadCors = dependencies.ensureBrowserUploadCors || ensureBrowserUploadCors;
  const { authenticate, requireTrustedMutation } = dependencies;
  const englishEntitlement = dependencies.readEnglishEntitlement || ((ownerId, now) => readEnglishEntitlement(ownerId, now, getCollection));
  const gulongEntitlement = dependencies.readGulongEngineEntitlement || ((ownerId, now) => readGulongEngineEntitlement(ownerId, now, getCollection));
  const requestKey = (ownerId, key) => createHash("sha256").update(`${ownerId}:${key}`).digest("hex");

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
    && (auth.kind !== "desktop-gulong-engine" || isGulongEngineCapability(order.capabilityId) || order.cancellationTombstone);
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

  async function recoverExpired(now = new Date()) {
    const orders = await getCollection("capabilityOrders");
    const expired = await orders.find({ status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $lte: now } }).limit(100).toArray();
    for (const order of expired) {
      if (integer(order.attempt) < integer(order.maxAttempts, 2)) {
        await orders.updateOne({ _id: order._id, status: order.status, claimLeaseUntil: { $lte: now } }, { $set: { status: "queued", stage: "retry_wait", nextEligibleAt: now, updatedAt: now }, $unset: { assignedNode: "", claimId: "", claimLeaseUntil: "", claimedAt: "" } });
      } else {
        await orders.updateOne({ _id: order._id, status: order.status, claimLeaseUntil: { $lte: now } }, { $set: { status: "failed", stage: "failed", error: { code: "CAPABILITY_EXECUTION_TIMEOUT", message: "节点执行超时，已达到最大重试次数" }, failedAt: now, updatedAt: now } });
      }
    }
    await orders.updateMany({ status: "queued", autoCancelAt: { $lte: now } }, { $set: { status: "cancelled", stage: "cancelled", cancelReason: "queue_timeout", cancelledAt: now, updatedAt: now } });
  }

  async function ownedAssets(ownerId, refs, capability) {
    if (!refs.length) return [];
    if (refs.some((item) => !ObjectId.isValid(item.asset_id))) throw Object.assign(new Error("输入素材引用无效"), { code: "ASSET_NOT_READY", status: 409 });
    const ids = refs.map((item) => new ObjectId(item.asset_id));
    const records = await (await getCollection("capabilityAssetUploads")).find({ _id: { $in: ids }, ownerId, status: "ready" }).toArray();
    const byId = new Map(records.map((item) => [item._id.toString(), item]));
    const assets = refs.map((ref) => {
      const record = byId.get(ref.asset_id);
      if (!record) throw Object.assign(new Error("输入素材尚未完成校验或不属于当前账户"), { code: "ASSET_NOT_READY", status: 409 });
      return { assetId: record._id.toString(), role: String(ref.role || "input").slice(0, 80), filename: record.filename, contentType: record.contentType, bytes: record.bytes, sha256: record.sha256, objectKey: record.objectKey };
    });
    return assets;
  }

  function claimAssets(assets) {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return assets.map((asset) => ({ asset_id: asset.assetId, role: asset.role, filename: asset.filename, content_type: asset.contentType, bytes: asset.bytes, sha256: asset.sha256, download_url: issueDownloadUrl(asset.objectKey, { expires: 15 * 60, filename: asset.filename }), download_expires_at: expiresAt }));
  }

  app.get("/api/v1/capability-orders/catalog", async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const definitions = auth.kind === "desktop-english" ? CAPABILITY_ORDER_DEFINITIONS.filter((item) => isEnglishCapability(item.capabilityId))
      : auth.kind === "desktop-gulong-engine" ? CAPABILITY_ORDER_DEFINITIONS.filter((item) => isGulongEngineCapability(item.capabilityId)) : CAPABILITY_ORDER_DEFINITIONS;
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ protocol_version: CAPABILITY_ORDER_PROTOCOL, capabilities: definitions.map(publicDefinition) });
  });

  app.post("/api/v1/capability-assets/presign", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`capability-asset:${auth.user.id}`, { limit: 60, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "素材上传请求过于频繁" }, 429);
    const body = await c.req.json().catch(() => ({}));
    const filename = sanitizeFilename(body.filename, "asset.bin");
    const contentType = String(body.content_type || "application/octet-stream").trim().toLowerCase();
    const bytes = integer(body.bytes, -1);
    const sha256 = String(body.sha256 || "").trim().toUpperCase();
    if (auth.kind === "desktop-english") {
      const rejected = await requireEnglish(c, auth.user.id); if (rejected) return rejected;
      if (bytes > ENGLISH_AUDIO_MAX_BYTES || !ENGLISH_AUDIO_MIME.includes(contentType)) return c.json({ code: "CAPABILITY_INPUT_LIMIT_EXCEEDED", message: "英语录音仅支持不超过 20 MiB 的 WAV、MP3、FLAC 或 WebM 音频" }, 400);
    }
    if (auth.kind === "desktop-gulong-engine") {
      const rejected = await requireGulong(c, auth.user.id); if (rejected) return rejected;
      if (bytes > 40 * 1024 * 1024 || !IMAGE_MIME.includes(contentType)) return c.json({ code: "CAPABILITY_INPUT_LIMIT_EXCEEDED", message: "古龙绿色版共享素材仅支持不超过 40 MiB 的 PNG、JPEG 或 WebP 图片" }, 400);
    }
    if (bytes < 1 || bytes > CAPABILITY_MAX_ASSET_BYTES || !/^[A-F0-9]{64}$/.test(sha256) || !/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(contentType)) return c.json({ code: "VALIDATION_ERROR", message: "素材类型、大小或 SHA-256 不正确" }, 400);
    await ensureUploadCors();
    const ownerId = new ObjectId(auth.user.id);
    const uploadId = new ObjectId();
    const objectKey = `capability-orders/${ownerId}/inputs/${uploadId}-${filename}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const headers = { "Content-Type": contentType, "x-cos-meta-sha256": sha256, "x-cos-meta-bytes": String(bytes), "x-cos-meta-owner-id": ownerId.toString(), "x-cos-meta-capability-asset-id": uploadId.toString() };
    await (await getCollection("capabilityAssetUploads")).insertOne({ _id: uploadId, ownerId, filename, contentType, bytes, sha256, objectKey, status: "uploading", createdAt: now, updatedAt: now, expiresAt });
    return c.json({ asset_id: uploadId.toString(), upload_url: issueUploadUrl(objectKey, { expires: 3600, headers }), method: "PUT", headers, object_key: objectKey, expires_at: expiresAt.toISOString() }, 201);
  });

  app.post("/api/v1/capability-assets/:id/complete", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ASSET_NOT_FOUND", message: "素材不存在" }, 404);
    const uploads = await getCollection("capabilityAssetUploads");
    const ready = await uploads.findOne({ _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id), status: "ready" });
    if (ready) return c.json({ asset: { asset_id: ready._id.toString(), filename: ready.filename, content_type: ready.contentType, bytes: ready.bytes, sha256: ready.sha256 }, idempotent: true });
    const asset = await uploads.findOne({ _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id), status: "uploading", expiresAt: { $gt: new Date() } });
    if (!asset) return c.json({ code: "ASSET_NOT_FOUND", message: "素材不存在、已完成或已过期" }, 404);
    let head;
    try { head = await inspectCosObject(asset.objectKey); } catch { return c.json({ code: "ASSET_OBJECT_NOT_FOUND", message: "COS 中尚未找到素材" }, 409); }
    const valid = objectBytes(head) === asset.bytes
      && objectHeader(head, "x-cos-meta-sha256").toUpperCase() === asset.sha256
      && objectHeader(head, "x-cos-meta-bytes") === String(asset.bytes)
      && objectHeader(head, "x-cos-meta-owner-id") === asset.ownerId.toString()
      && objectHeader(head, "x-cos-meta-capability-asset-id") === asset._id.toString();
    if (!valid) {
      await Promise.allSettled([removeCosObject(asset.objectKey), uploads.updateOne({ _id: asset._id }, { $set: { status: "rejected", updatedAt: new Date() } })]);
      return c.json({ code: "ASSET_RECEIPT_MISMATCH", message: "素材大小、摘要或归属校验失败" }, 409);
    }
    const now = new Date();
    await uploads.updateOne({ _id: asset._id, status: "uploading" }, { $set: { status: "ready", completedAt: now, updatedAt: now }, $unset: { expiresAt: "" } });
    return c.json({ asset: { asset_id: asset._id.toString(), filename: asset.filename, content_type: asset.contentType, bytes: asset.bytes, sha256: asset.sha256 } });
  });

  app.post("/api/v1/capability-orders", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`capability-create:${auth.user.id}`, { limit: 30, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "能力订单创建过于频繁" }, 429);
    const body = await c.req.json().catch(() => ({}));
    const rawKey = String(c.req.header("Idempotency-Key") || body.idempotency_key || "").trim();
    if (rawKey.length < 8 || rawKey.length > 160) return c.json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "请提供 8–160 字符的 Idempotency-Key" }, 400);
    const capabilityId = String(body.capability_id || "").trim().toLowerCase();
    if (auth.kind === "desktop-english" && !isEnglishCapability(capabilityId)) return c.json({ code: "ENGLISH_CAPABILITY_ONLY", message: "英语教练凭据仅可用于英语学习能力" }, 403);
    if (auth.kind === "desktop-gulong-engine" && !isGulongEngineCapability(capabilityId)) return c.json({ code: "GULONG_ENGINE_CAPABILITY_ONLY", message: "古龙绿色版凭据仅可用于本产品共享能力" }, 403);
    const capability = CAPABILITY_MAP.get(capabilityId);
    if (!capability) return c.json({ code: "UNKNOWN_CAPABILITY", message: "该能力未注册到官网统一订单目录" }, 400);
    if (capability.legacyRoute) return c.json({ code: "USE_LEGACY_H3_API", message: "MiniMax H3 视频任务继续使用现有 /api/h3/tasks 合同", legacy_route: capability.legacyRoute }, 409);
    if (!capability.dispatchable) return c.json({ code: "CAPABILITY_ADAPTER_REQUIRED", message: "该能力尚未完成独立订单适配与真实推理验收，暂不可创建订单" }, 409);
    let parameters;
    try { parameters = normalizeCapabilityParameters(body.parameters || {}, capability); }
    catch (error) { return c.json({ code: error.code || "INVALID_CAPABILITY_PARAMETERS", message: error.message }, error.status || 400); }
    const ownerId = new ObjectId(auth.user.id);
    let assets;
    try {
      assets = await ownedAssets(ownerId, Array.isArray(body.assets) ? body.assets.slice(0, 32) : [], capability);
      validateCapabilityInput(capability, parameters, assets);
    } catch (error) { return c.json({ code: error.code || "VALIDATION_ERROR", message: error.message }, error.status || 400); }
    const preferredNodeId = String(body.preferred_node_id || "").trim() || null;
    const requestedCapabilityVersion = String(body.capability_version || "").trim().slice(0, 80) || null;
    if (preferredNodeId) {
      const binding = await (await getCollection("nodeAccountBindings")).findOne({ userId: ownerId, nodeId: preferredNodeId, status: "active", revokedAt: null });
      if (!binding) return c.json({ code: "PREFERRED_NODE_NOT_OWNED", message: "指定执行节点不属于当前账户" }, 403);
    }
    const fingerprint = requestFingerprint({ capabilityId, capabilityVersion: requestedCapabilityVersion, parameters, assets: assets.map((item) => ({ assetId: item.assetId, role: item.role, sha256: item.sha256 })), preferredNodeId });
    const idempotencyKey = requestKey(ownerId, rawKey);
    const orders = await getCollection("capabilityOrders");
    const existing = await orders.findOne({ idempotencyKey });
    if (existing) {
      if (existing.cancellationTombstone) return c.json({ order: publicOrder(existing, issueDownloadUrl), idempotent: true }, 201);
      if (existing.requestFingerprint !== fingerprint) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "同一幂等键不能用于不同能力订单" }, 409);
      return c.json({ order: publicOrder(existing, issueDownloadUrl), idempotent: true }, 201);
    }
    if (isEnglishCapability(capabilityId)) { const rejected = await requireEnglish(c, ownerId); if (rejected) return rejected; }
    if (isGulongEngineCapability(capabilityId)) { const rejected = await requireGulong(c, ownerId); if (rejected) return rejected; }
    const now = new Date();
    const orderId = new ObjectId();
    const estimate = capability.defaultEtaSeconds;
    const record = {
      _id: orderId,
      orderNo: `CAP${Date.now()}${randomBytes(3).toString("hex").toUpperCase()}`,
      protocolVersion: CAPABILITY_ORDER_PROTOCOL,
      requesterUserId: ownerId,
      sourceChannel: body.source_channel === "desktop_agent" ? "desktop_agent" : "website",
      capabilityId,
      ...(isEnglishCapability(capabilityId) ? { sharingScope: "english_shared", entitlementPlan: "english_coach_monthly" } : {}),
      ...(isGulongEngineCapability(capabilityId) ? { sharingScope: "gulong_shared", entitlementPlan: "gulong_engine_monthly" } : {}),
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
      if (replay?.cancellationTombstone) return c.json({ order: publicOrder(replay, issueDownloadUrl), idempotent: true }, 201);
      if (!replay || replay.requestFingerprint !== fingerprint) return c.json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "同一幂等键不能用于不同能力订单" }, 409);
      return c.json({ order: publicOrder(replay, issueDownloadUrl), idempotent: true }, 201);
    }
    return c.json({ order: publicOrder(record, issueDownloadUrl), idempotent: false }, 201);
  });

  app.get("/api/v1/capability-orders/by-request/:key", async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const key = String(c.req.param("key") || "");
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) return c.json({ code: "VALIDATION_ERROR", message: "请求编号格式无效" }, 400);
    const ownerId = new ObjectId(auth.user.id);
    await recoverExpired();
    const order = await (await getCollection("capabilityOrders")).findOne({ idempotencyKey: requestKey(ownerId, key), requesterUserId: ownerId });
    if (!order || !scopedMayReadOrder(auth, order)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ order: publicOrder(order, issueDownloadUrl) });
  });

  app.post("/api/v1/capability-orders/by-request/:key/cancel", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    const key = String(c.req.param("key") || "");
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) return c.json({ code: "VALIDATION_ERROR", message: "请求编号格式无效" }, 400);
    const rate = await enforceRateLimit(`capability-cancel-request:${auth.user.id}`, { limit: 60, windowMs: 10 * 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "取消请求过于频繁" }, 429);
    const ownerId = new ObjectId(auth.user.id);
    const idempotencyKey = requestKey(ownerId, key);
    const orders = await getCollection("capabilityOrders");
    const now = new Date();
    const tombstone = { _id: new ObjectId(), orderNo: `CAPC${Date.now()}${randomBytes(5).toString("hex").toUpperCase()}`, protocolVersion: CAPABILITY_ORDER_PROTOCOL,
      requesterUserId: ownerId, idempotencyKey, cancellationTombstone: true, capabilityId: null, status: "cancelled", stage: "cancelled",
      cancelReason: "requester_cancelled_before_create", priceFen: 0, chargeStatus: "exempt", refundStatus: "not_applicable", assets: [],
      createdAt: now, updatedAt: now, cancelledAt: now };
    try { await orders.updateOne({ idempotencyKey }, { $setOnInsert: tombstone }, { upsert: true }); }
    catch (error) { if (error?.code !== 11000) throw error; }
    const before = await orders.findOne({ idempotencyKey, requesterUserId: ownerId });
    if (!before || !scopedMayReadOrder(auth, before)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const order = await cancelOwnedOrder(before, now);
    return c.json({ order: publicOrder(order, issueDownloadUrl), idempotent: CAPABILITY_TERMINAL.has(before.status) });
  });

  app.get("/api/v1/capability-orders/:id", async (c) => {
    const auth = await authenticate(c); if (auth.error) return auth.error;
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    await recoverExpired();
    const order = await (await getCollection("capabilityOrders")).findOne({ _id: new ObjectId(c.req.param("id")), requesterUserId: new ObjectId(auth.user.id) });
    if (!order || !scopedMayReadOrder(auth, order)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({ order: publicOrder(order, issueDownloadUrl) });
  });

  app.post("/api/v1/capability-orders/:id/cancel", async (c) => {
    const rejected = requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await authenticate(c); if (auth.error) return auth.error;
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const orders = await getCollection("capabilityOrders");
    const filter = { _id: new ObjectId(c.req.param("id")), requesterUserId: new ObjectId(auth.user.id) };
    const before = await orders.findOne(filter);
    if (!before || !scopedMayReadOrder(auth, before)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    return c.json({ order: publicOrder(await cancelOwnedOrder(before), issueDownloadUrl), idempotent: CAPABILITY_TERMINAL.has(before.status) });
  });

  app.get("/api/v1/capability-orders/:id/worker-state", async (c) => {
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const order = await (await getCollection("capabilityOrders")).findOne({ _id: new ObjectId(c.req.param("id")) });
    if (!order?.assignedNode?.nodeId) return c.json({ code: "ORDER_NOT_ASSIGNED", message: "能力订单尚未分配执行节点" }, 409);
    const auth = await authenticateBinding(c, order.assignedNode.nodeId); if (auth.error) return auth.error;
    if (!workerOwnsClaim(order, auth) || String(c.req.query("claim_id") || "") !== order.claimId) return c.json({ code: "CLAIM_MISMATCH", message: "订单领取身份不匹配" }, 409);
    const terminal = CAPABILITY_TERMINAL.has(order.status);
    const cancellationRequested = order.status === "cancelled";
    const leaseExpired = !terminal && order.claimLeaseUntil && new Date(order.claimLeaseUntil) <= new Date();
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
    const body = await c.req.json().catch(() => ({}));
    const nodeId = String(body.node_id || "").trim();
    const auth = await authenticateBinding(c, nodeId); if (auth.error) return auth.error;
    const rate = await enforceRateLimit(`capability-claim:${auth.binding._id}`, { limit: 120, windowMs: 60_000 });
    if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "节点拉单过于频繁" }, 429);
    if (body.protocol_version !== CAPABILITY_ORDER_PROTOCOL) return c.json({ code: "PROTOCOL_VERSION_UNSUPPORTED", message: `必须使用 ${CAPABILITY_ORDER_PROTOCOL}` }, 400);
    const now = new Date();
    let ownCapabilities;
    try { ownCapabilities = (Array.isArray(body.capabilities) ? body.capabilities : []).map((item) => normalizeCapabilityReport(item, now)); }
    catch (error) { return c.json({ code: error.code || "INVALID_CAPABILITY_REPORT", message: error.message }, error.status || 400); }
    if (!ownCapabilities.length) return c.json({ code: "CAPABILITY_REPORT_REQUIRED", message: "节点必须上报至少一个已安装、已验证、已启用能力" }, 400);
    const resources = body.resources && typeof body.resources === "object" ? body.resources : {};
    const ownNode = { nodeId, nodeName: String(body.node_name || auth.binding.nodeName || "").slice(0, 120), binding: auth.binding, capabilities: ownCapabilities, runningTaskCount: Math.max(0, integer(resources.running_task_count)), estimatedTotalSeconds: Math.max(0, integer(resources.estimated_total_seconds)), maxConcurrent: Math.min(16, Math.max(1, integer(resources.max_concurrent_tasks, Math.max(...ownCapabilities.map((item) => item.maxConcurrent)))) ) };
    ownNode.availableSlots = Math.max(0, ownNode.maxConcurrent - ownNode.runningTaskCount);
    const nodes = [ownNode];
    const lanReports = Array.isArray(body.lan_cluster?.nodes) ? body.lan_cluster.nodes.slice(0, 64) : [];
    for (const report of lanReports) {
      const reportNodeId = String(report.node_id || "").trim();
      if (!reportNodeId || reportNodeId === nodeId) continue;
      const binding = await (await getCollection("nodeAccountBindings")).findOne({ userId: auth.user._id, nodeId: reportNodeId, status: "active", revokedAt: null });
      if (!binding) return c.json({ code: "LAN_NODE_NOT_OWNED", message: "局域网报告包含未绑定到当前账户的节点" }, 403);
      let capabilities;
      try { capabilities = (Array.isArray(report.capabilities) ? report.capabilities : []).map((item) => normalizeCapabilityReport(item, now)); }
      catch (error) { return c.json({ code: error.code || "INVALID_CAPABILITY_REPORT", message: error.message }, error.status || 400); }
      const reportResources = report.resources && typeof report.resources === "object" ? report.resources : {};
      const maxConcurrent = Math.min(16, Math.max(1, integer(reportResources.max_concurrent_tasks, Math.max(1, ...capabilities.map((item) => item.maxConcurrent)))));
      nodes.push({ nodeId: reportNodeId, nodeName: String(report.node_name || binding.nodeName || "").slice(0, 120), binding, capabilities, runningTaskCount: Math.max(0, integer(reportResources.running_task_count)), estimatedTotalSeconds: Math.max(0, integer(reportResources.estimated_total_seconds)), maxConcurrent, availableSlots: Math.max(0, maxConcurrent - Math.max(0, integer(reportResources.running_task_count))) });
    }
    await (await getCollection("capabilityNodeReports")).updateOne({ bindingId: auth.binding._id }, { $set: { userId: auth.user._id, nodeId, protocolVersion: CAPABILITY_ORDER_PROTOCOL, capabilities: ownCapabilities, resources, reportedAt: now, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
    if (body.dry_run === true) return c.json({ ok: true, service: "gulong-capability-orders", protocol_version: CAPABILITY_ORDER_PROTOCOL, queue: "reachable", eligible_capability_ids: ownCapabilities.map((item) => item.capabilityId) });
    await recoverExpired(now);
    nodes.sort((a, b) => a.estimatedTotalSeconds - b.estimatedTotalSeconds || a.runningTaskCount - b.runningTaskCount || a.nodeId.localeCompare(b.nodeId));
    const capabilityIds = [...new Set(nodes.flatMap((item) => item.capabilities.map((capability) => capability.capabilityId)))];
    const sharedEnglishIds = ownCapabilities.filter((item) => isEnglishCapability(item.capabilityId) && item.sharingOptIn).map((item) => item.capabilityId);
    const sharedGulongIds = ownCapabilities.filter((item) => isGulongEngineCapability(item.capabilityId) && item.sharingOptIn).map((item) => item.capabilityId);
    const ownerScope = { $or: [{ requesterUserId: auth.user._id },
      ...(sharedEnglishIds.length ? [{ capabilityId: { $in: sharedEnglishIds }, sharingScope: "english_shared" }] : []),
      ...(sharedGulongIds.length ? [{ capabilityId: { $in: sharedGulongIds }, sharingScope: "gulong_shared" }] : [])] };
    const candidates = await (await getCollection("capabilityOrders")).find({ ...ownerScope, status: "queued", capabilityId: { $in: capabilityIds }, nextEligibleAt: { $lte: now }, autoCancelAt: { $gt: now } }).sort({ createdAt: 1, _id: 1 }).limit(100).toArray();
    let selected = null;
    for (const order of candidates) {
      if (isEnglishCapability(order.capabilityId) && !(await englishEntitlement(order.requesterUserId, now)).active) {
        await (await getCollection("capabilityOrders")).updateOne({ _id: order._id, status: "queued" }, { $set: { status: "cancelled", stage: "cancelled", cancelReason: "english_subscription_inactive", error: { code: "ENGLISH_SUBSCRIPTION_REQUIRED", message: "英语教练套餐尚未生效、已到期或已撤销" }, cancelledAt: now, updatedAt: now } });
        continue;
      }
      if (isGulongEngineCapability(order.capabilityId) && !(await gulongEntitlement(order.requesterUserId, now)).active) {
        await (await getCollection("capabilityOrders")).updateOne({ _id: order._id, status: "queued" }, { $set: { status: "cancelled", stage: "cancelled", cancelReason: "gulong_engine_subscription_inactive", error: { code: "GULONG_ENGINE_SUBSCRIPTION_REQUIRED", message: "古龙绿色版套餐尚未生效、已到期或已撤销" }, cancelledAt: now, updatedAt: now } });
        continue;
      }
      // A LAN proxy cannot opt another node into serving unrelated accounts.
      const foreign = String(order.requesterUserId) !== String(auth.user._id);
      const node = nodes.find((item) => (!foreign || item === ownNode) && capabilityNodeCanRunOrder(item, order));
      if (node) { selected = { order, node }; break; }
    }
    if (!selected) return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: "same_account_fifo_least_estimated_load", eligible_capability_ids: capabilityIds } });
    const claimId = randomBytes(18).toString("base64url");
    const claimLeaseUntil = new Date(now.getTime() + CAPABILITY_CLAIM_LEASE_MS);
    const selectedCapability = selected.node.capabilities.find((item) => item.capabilityId === selected.order.capabilityId && (!selected.order.capabilityVersion || item.capabilityVersion === selected.order.capabilityVersion));
    const assignedNode = { nodeId: selected.node.nodeId, nodeName: selected.node.nodeName, bindingId: selected.node.binding._id, userId: selected.node.binding.userId };
    const claimed = await (await getCollection("capabilityOrders")).findOneAndUpdate({ _id: selected.order._id, status: "queued", nextEligibleAt: { $lte: now } }, { $set: { status: "claimed", stage: "claimed", claimId, claimRequestedByNodeId: auth.binding.nodeId, assignedNode, capabilityVersion: selectedCapability.capabilityVersion, claimedAt: now, claimLeaseUntil, updatedAt: now }, $inc: { attempt: 1 } }, { returnDocument: "after" });
    if (!claimed) return c.json({ task: null, claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: "same_account_fifo_least_estimated_load", race_lost: true } });
    return c.json({ task: workerOrder(claimed, claimAssets(claimed.assets)), claim_plan: { protocol_version: CAPABILITY_ORDER_PROTOCOL, scheduling: "same_account_fifo_least_estimated_load", selected_node_id: selected.node.nodeId } });
  });

  app.post("/api/v1/capability-orders/:id/outputs/presign", async (c) => {
    if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const now = new Date();
    const order = await (await getCollection("capabilityOrders")).findOne({ _id: new ObjectId(c.req.param("id")), status: { $in: ["claimed", "processing"] } });
    if (!order) return c.json({ code: "ORDER_NOT_ACTIVE", message: "能力订单不存在或不再执行" }, 409);
    if (!order.claimLeaseUntil || new Date(order.claimLeaseUntil) <= now) return c.json({ code: "CLAIM_LEASE_EXPIRED", message: "订单领取租约已过期，不能再签发输出票据" }, 409);
    const auth = await authenticateBinding(c, order.assignedNode?.nodeId); if (auth.error) return auth.error;
    if (!workerOwnsClaim(order, auth)) return c.json({ code: "CLAIM_MISMATCH", message: "订单执行账户不匹配" }, 409);
    if (String(body.claim_id || "") !== order.claimId) return c.json({ code: "CLAIM_MISMATCH", message: "订单领取凭据不匹配" }, 409);
    const capability = CAPABILITY_MAP.get(order.capabilityId);
    const contentType = String(body.content_type || "").trim().toLowerCase();
    const filename = sanitizeFilename(body.filename, "result.bin");
    const bytes = integer(body.bytes, -1);
    const sha256 = String(body.sha256 || "").trim().toUpperCase();
    const role = String(body.role || "result").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "result";
    const outputRule = capability.outputRules.find((item) => item.role === role);
    if (!outputRule || !mimeAllowed(contentType, outputRule.mimeTypes) || bytes < 1 || bytes > Math.min(CAPABILITY_MAX_ASSET_BYTES, outputRule.maxBytes) || !/^[A-F0-9]{64}$/.test(sha256)) return c.json({ code: "INVALID_OUTPUT_MANIFEST", message: "输出角色、类型、大小或 SHA-256 不符合能力合同" }, 400);
    const outputUploads = await getCollection("capabilityOutputUploads");
    const roleCount = await outputUploads.countDocuments({ orderId: order._id, claimId: order.claimId, role, status: { $in: ["issued", "completed"] } });
    if (roleCount >= outputRule.max) return c.json({ code: "OUTPUT_ROLE_LIMIT_EXCEEDED", message: `输出角色 ${role} 最多允许 ${outputRule.max} 个文件` }, 409);
    const outputId = randomBytes(18).toString("base64url");
    const objectKey = `capability-orders/${order._id}/outputs/${outputId}-${filename}`;
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const headers = { "Content-Type": contentType, "x-cos-meta-sha256": sha256, "x-cos-meta-bytes": String(bytes), "x-cos-meta-capability-order-id": order._id.toString(), "x-cos-meta-capability-output-id": outputId, "x-cos-meta-node-id-hash": createHash("sha256").update(auth.binding.nodeId).digest("hex") };
    await outputUploads.insertOne({ outputId, orderId: order._id, claimId: order.claimId, ownerId: order.requesterUserId, issuedToBindingId: auth.binding._id, issuedToNodeId: auth.binding.nodeId, role, filename, contentType, bytes, sha256, objectKey, status: "issued", createdAt: now, updatedAt: now, expiresAt });
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
    const body = await c.req.json().catch(() => ({}));
    if (!ObjectId.isValid(body.order_id)) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const orders = await getCollection("capabilityOrders");
    let order = await orders.findOne({ _id: new ObjectId(body.order_id) });
    if (!order) return c.json({ code: "ORDER_NOT_FOUND", message: "能力订单不存在" }, 404);
    const auth = await authenticateBinding(c, order.assignedNode?.nodeId); if (auth.error) return auth.error;
    if (!workerOwnsClaim(order, auth) || String(body.claim_id || "") !== order.claimId) return c.json({ code: "CLAIM_MISMATCH", message: "订单领取身份不匹配" }, 409);
    const eventId = String(body.event_id || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(eventId)) return c.json({ code: "CALLBACK_EVENT_REQUIRED", message: "回调必须提供稳定 event_id" }, 400);
    const callbacks = await getCollection("capabilityOrderCallbacks");
    const existing = await callbacks.findOne({ orderId: order._id, eventId });
    if (existing) return c.json({ ok: true, idempotent: true, order_status: existing.resultStatus });
    if (CAPABILITY_TERMINAL.has(order.status)) return c.json({ code: "ORDER_ALREADY_TERMINAL", message: "订单已结束，不能再提交新的回调" }, 409);
    const now = new Date();
    if (!order.claimLeaseUntil || new Date(order.claimLeaseUntil) <= now) return c.json({ code: "CLAIM_LEASE_EXPIRED", message: "订单领取租约已过期，请停止本地任务并等待重新派单" }, 409);
    const status = String(body.status || "").trim().toLowerCase();
    if (!["started", "progress", "completed", "failed", "cancelled"].includes(status)) return c.json({ code: "INVALID_CALLBACK_STATUS", message: "回调状态不正确" }, 400);
    const elapsedSeconds = Math.max(0, integer(body.elapsed_seconds));
    const estimatedTotalSeconds = Math.max(0, integer(body.estimated_total_seconds));
    const progress = status === "completed" ? 100 : Math.min(99, Math.max(0, integer(body.progress)));
    const etaSeconds = body.eta_seconds == null ? (estimatedTotalSeconds ? Math.max(0, estimatedTotalSeconds - elapsedSeconds) : order.etaSeconds) : Math.max(0, integer(body.eta_seconds));
    if (status === "started" && estimatedTotalSeconds < 1) return c.json({ code: "ESTIMATE_REQUIRED", message: "首次 started 回调必须提供 estimated_total_seconds" }, 400);
    const claimEvent = async () => {
      try {
        await callbacks.insertOne({ orderId: order._id, eventId, claimId: order.claimId, status, nodeId: auth.binding.nodeId, createdAt: now, resultStatus: "processing" });
        return true;
      } catch (error) {
        if (error?.code === 11000) return false;
        throw error;
      }
    };
    if (["started", "progress"].includes(status)) {
      if (!await claimEvent()) return c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
      const updated = await orders.findOneAndUpdate({ _id: order._id, status: { $in: ["claimed", "processing"] }, claimId: order.claimId }, { $set: { status: "processing", stage: String(body.stage || "processing").slice(0, 120), progress, elapsedSeconds, etaSeconds, estimatedTotalSeconds: estimatedTotalSeconds || order.estimatedTotalSeconds || null, claimLeaseUntil: new Date(now.getTime() + CAPABILITY_CLAIM_LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
      await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: updated?.status || order.status } });
      return c.json({ ok: true, idempotent: false, order_status: updated?.status || order.status, progress, eta_seconds: etaSeconds });
    }
    if (status === "completed") {
      const capability = CAPABILITY_MAP.get(order.capabilityId);
      const inlineResult = body.inline_result == null ? null : body.inline_result;
      if (!validateEnglishInlineResult(order.capabilityId, inlineResult, order.parameters)) return c.json({ code: "ENGLISH_RESULT_INVALID", message: "英语结果必须符合文本或声学发音评估合同" }, 400);
      if (!validateGulongEngineInlineResult(order.capabilityId, inlineResult)) return c.json({ code: "GULONG_ENGINE_RESULT_INVALID", message: "绿色版文本结果必须包含不超过 64 KB 的文字" }, 400);
      const outputRefs = Array.isArray(body.outputs) ? body.outputs : [];
      if (inlineResult != null && (!capability.inlineResult || JSON.stringify(inlineResult).length > 64_000)) return c.json({ code: "INLINE_RESULT_NOT_ALLOWED", message: "该能力不允许此内联结果或结果超过 64 KB" }, 400);
      if (!outputRefs.length && inlineResult == null) return c.json({ code: "OUTPUT_REQUIRED", message: "完成回调必须包含输出清单或允许的内联结果" }, 400);
      const outputIds = outputRefs.map((item) => String(item.output_id || ""));
      if (new Set(outputIds).size !== outputIds.length) return c.json({ code: "DUPLICATE_OUTPUT_REFERENCE", message: "完成回调不能重复引用同一个 output_id" }, 400);
      const grants = outputIds.length ? await (await getCollection("capabilityOutputUploads")).find({ outputId: { $in: outputIds }, orderId: order._id, claimId: order.claimId, issuedToBindingId: auth.binding._id, status: "issued", expiresAt: { $gt: now } }).toArray() : [];
      if (grants.length !== outputIds.length) return c.json({ code: "OUTPUT_GRANT_MISMATCH", message: "输出上传票据无效、过期或不属于当前执行节点" }, 409);
      const roleCounts = new Map();
      for (const grant of grants) roleCounts.set(grant.role, (roleCounts.get(grant.role) || 0) + 1);
      for (const rule of capability.outputRules) {
        const count = roleCounts.get(rule.role) || 0;
        const requiredMinimum = inlineResult != null && capability.inlineResult ? 0 : rule.min;
        if (count < requiredMinimum || count > rule.max) return c.json({ code: "INVALID_OUTPUT_ROLE_COUNT", message: `输出角色 ${rule.role} 需要 ${requiredMinimum}–${rule.max} 个，当前为 ${count} 个` }, 400);
      }
      const outputs = [];
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
        outputs.push({ outputId: grant.outputId, role: grant.role, filename: grant.filename, contentType: grant.contentType, bytes: grant.bytes, sha256: grant.sha256, objectKey: grant.objectKey });
      }
      if (!await claimEvent()) return c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
      const completed = await orders.findOneAndUpdate({ _id: order._id, status: { $in: ["claimed", "processing"] }, claimId: order.claimId }, { $set: { status: "completed", stage: "completed", progress: 100, elapsedSeconds, etaSeconds: 0, inlineResult, outputs, completedAt: now, updatedAt: now }, $unset: { claimLeaseUntil: "" } }, { returnDocument: "after" });
      if (!completed) return c.json({ code: "ORDER_STATE_CONFLICT", message: "订单状态已变化，完成结果未重复写入" }, 409);
      if (grants.length) await (await getCollection("capabilityOutputUploads")).updateMany({ outputId: { $in: outputIds }, status: "issued" }, { $set: { status: "completed", completedAt: now, updatedAt: now }, $unset: { expiresAt: "" } });
      await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "completed" } });
      return c.json({ ok: true, idempotent: false, order_status: "completed" });
    }
    if (status === "failed") {
      const retryable = body.retryable === true;
      const canRetry = retryable && integer(order.attempt) < integer(order.maxAttempts, 2);
      const error = { code: String(body.error_code || "CAPABILITY_EXECUTION_FAILED").slice(0, 100), message: localizeErrorMessage(body.error_message, "本地能力执行失败").slice(0, 500), retryable };
      if (!await claimEvent()) return c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
      if (canRetry) {
        await orders.updateOne({ _id: order._id, claimId: order.claimId, status: { $in: ["claimed", "processing"] } }, { $set: { status: "queued", stage: "retry_wait", error, nextEligibleAt: new Date(now.getTime() + Math.min(300, Math.max(5, integer(body.retry_after_seconds, 15))) * 1000), updatedAt: now }, $unset: { assignedNode: "", claimId: "", claimLeaseUntil: "", claimedAt: "" } });
        await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "queued" } });
        return c.json({ ok: true, idempotent: false, order_status: "queued", retry_scheduled: true });
      }
      await orders.updateOne({ _id: order._id, claimId: order.claimId, status: { $in: ["claimed", "processing"] } }, { $set: { status: "failed", stage: "failed", error, failedAt: now, updatedAt: now }, $unset: { claimLeaseUntil: "" } });
      await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "failed" } });
      return c.json({ ok: true, idempotent: false, order_status: "failed", retry_scheduled: false });
    }
    if (!await claimEvent()) return c.json({ ok: true, idempotent: true, order_status: (await callbacks.findOne({ orderId: order._id, eventId }))?.resultStatus });
    await orders.updateOne({ _id: order._id, claimId: order.claimId, status: { $in: ["claimed", "processing"] } }, { $set: { status: "cancelled", stage: "cancelled", cancelledAt: now, cancelReason: "worker_cancelled", updatedAt: now }, $unset: { claimLeaseUntil: "" } });
    await callbacks.updateOne({ orderId: order._id, eventId }, { $set: { resultStatus: "cancelled" } });
    return c.json({ ok: true, idempotent: false, order_status: "cancelled" });
  });

  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/by-request/{key}", tags: ["Unified Capability Orders"], summary: "按同账户稳定请求编号恢复订单", responses: { 200: { description: "自己的原订单；套餐到期仍可查询" }, 404: { description: "尚无该请求" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/by-request/{key}/cancel", tags: ["Unified Capability Orders"], summary: "按请求编号幂等取消并阻止迟到创建", responses: { 200: { description: "原订单或原子cancelled tombstone；不会产生新执行任务" } } });
  const reportSchema = z.object({ capability_id: z.string(), capability_version: z.string(), protocol_version: z.literal(CAPABILITY_ORDER_PROTOCOL), installed: z.literal(true), validated: z.literal(true), enabled: z.literal(true), max_concurrent: z.number().int().min(1).max(16), sharing_opt_in: z.boolean().optional(), validation: z.object({ tested_at: z.iso.datetime(), artifact_sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/), runtime_version: z.string().optional(), test_id: z.string().optional() }) });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/catalog", tags: ["Unified Capability Orders"], summary: "读取官网统一能力目录", responses: { 200: { description: "能力 ID、版本化 parameters JSON Schema、素材/输出 role 与 MIME/数量/大小、租约和旧接口路由" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-assets/presign", tags: ["Unified Capability Orders"], summary: "签发能力订单输入素材 COS 直传票据", responses: { 201: { description: "账号专属短时 PUT 票据" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-assets/{id}/complete", tags: ["Unified Capability Orders"], summary: "校验能力订单输入素材大小、摘要与归属", responses: { 200: { description: "返回安全 asset_id" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders", tags: ["Unified Capability Orders"], summary: "幂等创建同账户本地能力订单", description: "BIN、模型配件和 runtime 不是独立能力。MiniMax H3 视频继续使用 /api/h3/tasks；本接口只接受目录中可独立推理的能力。v1 本地能力订单价格为 0 分，不扣钱包且无分佣。", responses: { 201: { description: "订单已进入同账户节点队列" }, 409: { description: "幂等冲突或应使用旧 H3 接口" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/{id}", tags: ["Unified Capability Orders"], summary: "查询订单进度、ETA 与短时结果下载票据", responses: { 200: { description: "只返回当前用户自己的订单" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/{id}/cancel", tags: ["Unified Capability Orders"], summary: "幂等取消能力订单", responses: { 200: { description: "取消状态与零费用退款边界" } } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/api/v1/capability-orders/{id}/worker-state", tags: ["Unified Capability Orders"], summary: "执行节点轮询取消与租约状态", description: "执行节点每 15 秒轮询；claim_id 必须匹配且只能由 assigned_node 自己的绑定令牌读取。started/progress 回调会把 5 分钟租约重新续满。", security: [{ accountBinding: [] }], request: { query: z.object({ claim_id: z.string().min(8) }) }, responses: { 200: { description: "cancellation_requested、should_stop 与 lease_expires_at" }, 409: { description: "订单未分配或 claim 不匹配" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/claim", tags: ["Unified Capability Orders"], summary: "按同账户、FIFO 与最短预计负载领取能力订单", description: "节点只能上报 installed=true、validated=true、enabled=true 且 30 天内完成真实推理验证的能力。局域网中所有候选节点都必须绑定同一账户；可指定执行节点，只有指定节点自己的 X-Gulong-Account-Binding 可回调。dry_run=true 不领取。", security: [{ accountBinding: [] }], request: { body: { content: { "application/json": { schema: z.object({ protocol_version: z.literal(CAPABILITY_ORDER_PROTOCOL), node_id: z.string(), node_name: z.string(), dry_run: z.boolean().optional(), capabilities: z.array(reportSchema).min(1), resources: z.object({ running_task_count: z.number().int().min(0), estimated_total_seconds: z.number().int().min(0), max_concurrent_tasks: z.number().int().min(1).max(16) }), lan_cluster: z.object({ cluster_id: z.string(), nodes: z.array(z.object({ node_id: z.string(), node_name: z.string(), capabilities: z.array(reportSchema), resources: z.object({ running_task_count: z.number().int().min(0), estimated_total_seconds: z.number().int().min(0), max_concurrent_tasks: z.number().int().min(1).max(16) }) })) }).optional() }) } } } }, responses: { 200: { description: "最小权限 worker task、素材短时下载票据与输出上传入口" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/{id}/outputs/presign", tags: ["Unified Capability Orders"], summary: "执行节点为一个结果签发 COS 直传票据", description: "返回 output_id、upload_url、method=PUT、headers/required_headers、object_key、expires_at、expires_in_seconds=3600 与 complete_via。role/MIME/单文件大小/数量按目录能力合同强校验。", security: [{ accountBinding: [] }], responses: { 201: { description: "与订单、claim、节点、输出 role、MIME、大小和摘要绑定的完整 PUT 票据" } } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/api/v1/capability-orders/callback", tags: ["Unified Capability Orders"], summary: "幂等回调进度、ETA、失败重试或完成结果", description: "JSON 回调不接收二进制文件。started/progress 每次都把 claim 续租 300 秒；completed 只接受已通过 COS HEAD 校验且符合输出 role 合同的 output_id，文本类能力可使用不超过 64 KB 的 inline_result。event_id 在订单内唯一。", security: [{ accountBinding: [] }], responses: { 200: { description: "事件已幂等处理" }, 409: { description: "claim、执行节点、订单状态或输出回执不匹配" } } });
}
