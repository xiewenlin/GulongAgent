import { createHash } from "node:crypto";

export const WORKLUCKY_CONTRACT_VERSION = "1.0.0";
const IDS = new Set(["gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music"]);
const hashPattern = /^[a-fA-F0-9]{64}$/;
const modelPattern = /^[A-Za-z0-9_./:@+-]{1,240}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (minLength, maxLength) => ({ type: "string", minLength, maxLength });
const schema = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
const opaqueRequest = { type: "object", additionalProperties: true };
const parametersLimit = 1024 * 1024;
const resultLimit = 4 * 1024 * 1024;

function definition(suffix, parametersSchema, options = {}) {
  return Object.freeze({
    capabilityId: `gulong_engine.${suffix}`, protocolVersion: "gulong-capability-orders-v1",
    parametersSchemaVersion: WORKLUCKY_CONTRACT_VERSION, requiredCapabilityVersion: WORKLUCKY_CONTRACT_VERSION,
    parametersSchema, inlineResult: true, maxParameterBytes: parametersLimit, maxInlineResultBytes: resultLimit,
    inputMime: [], outputMime: options.outputRules?.flatMap((rule) => rule.mimeTypes) || [],
    maxAssets: 0, maxTotalInputBytes: 0, assetRules: [], outputRules: options.outputRules || [],
    defaultEtaSeconds: options.eta || 60, maxRuntimeSeconds: options.runtime || 1800,
    priceFen: 0, entitlement: "gulong_engine_monthly", sharingScope: "gulong_shared",
    dispatchable: true, adapterStatus: "automatic_verification_required", trustedConsumerAcceptanceRequired: true,
    commercialUse: "node_operator_responsibility", legacyRoute: null,
  });
}

// Opaque OpenAI request objects are validated, never rewritten or reduced to a
// prompt. In particular messages, tools, tool_choice and vendor extensions survive.
export const WORKLUCKY_CAPABILITY_DEFINITIONS = Object.freeze([
  definition("agent_chat", schema({ model: text(1, 240), request: opaqueRequest }, ["model", "request"])),
  definition("embedding", schema({
    model: text(1, 240), dimension: { type: "integer", minimum: 1, maximum: 65536 }, request: opaqueRequest,
  }, ["model", "dimension", "request"])),
  definition("music", schema({
    model: text(1, 240), caption: text(1, 16000), lyrics: text(0, 64000),
    seconds: { type: "number", minimum: 1, maximum: 600 },
    seed: { type: ["integer", "string"] },
  }, ["caption", "lyrics", "seconds", "seed"]), {
    eta: 300, runtime: 3600,
    outputRules: [{ role: "primary_audio", min: 1, max: 1, mimeTypes: ["audio/flac", "audio/x-flac"], maxBytes: 64 * 1024 * 1024 }],
  }),
]);

export function isWorkLuckyCapability(id) { return IDS.has(id); }

function fail(message, code = "INVALID_CAPABILITY_PARAMETERS", status = 400) {
  throw Object.assign(new Error(message), { code, status });
}
function requireModel(value, label = "模型") {
  if (typeof value !== "string" || !modelPattern.test(value) || value.toLowerCase() === "auto") fail(`${label}必须使用目录中实际可用的完整模型 ID，不能使用自动替换`);
}
function requirePlain(value, label) { if (!object(value)) fail(`${label}必须是 JSON 对象`); }
function requireSize(value, maximum, label) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail(`${label}不是有效的 JSON 数据`); }
  if (!serialized || Buffer.byteLength(serialized) > maximum) fail(`${label}超过本能力允许的数据大小，未截断或替换原数据`);
}

function embeddingInputCount(input) {
  if (typeof input === "string" && input.length) return 1;
  if (!Array.isArray(input) || !input.length) fail("向量请求 input 不能为空");
  if (input.every((token) => Number.isSafeInteger(token) && token >= 0)) return 1;
  if (input.every((item) => typeof item === "string" && item.length)) return input.length;
  if (input.every((item) => Array.isArray(item) && item.length && item.every((token) => Number.isSafeInteger(token) && token >= 0))) return input.length;
  fail("向量请求 input 必须是文本、文本列表、令牌列表或令牌列表的列表");
}

export function validateSpecialParameters(capabilityId, parameters) {
  if (!isWorkLuckyCapability(capabilityId)) return true;
  requirePlain(parameters, "能力参数");
  requireSize(parameters, parametersLimit, "能力参数");
  if (capabilityId === "gulong_engine.music") {
    if (parameters.model !== undefined) requireModel(parameters.model);
    if (typeof parameters.caption !== "string" || !parameters.caption.trim() || parameters.caption.length > 16000) fail("音乐描述不能为空或超过 16000 字符");
    if (typeof parameters.lyrics !== "string" || parameters.lyrics.length > 64000) fail("必须完整提供 lyrics 字符串，歌词不能超过 64000 字符");
    if (!Number.isFinite(parameters.seconds) || parameters.seconds < 1 || parameters.seconds > 600) fail("音乐时长必须为 1–600 秒");
    const validSeed = (typeof parameters.seed === "number" && Number.isSafeInteger(parameters.seed) && parameters.seed >= 0)
      || (typeof parameters.seed === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(parameters.seed) && BigInt(parameters.seed) <= 18446744073709551615n);
    if (!validSeed) fail("音乐随机种子必须是非负安全整数，或不超过 18446744073709551615 的完整十进制字符串，不能丢失精度");
    return true;
  }
  requireModel(parameters.model);
  requirePlain(parameters.request, "完整模型请求 request");
  if (parameters.request.model !== parameters.model) fail("parameters.model 必须与 request.model 完全一致，不能替换模型", "CAPABILITY_MODEL_MISMATCH");
  if (capabilityId === "gulong_engine.agent_chat") {
    if (!Array.isArray(parameters.request.messages) || !parameters.request.messages.length) fail("对话请求必须包含完整的非空 messages 列表");
    for (const message of parameters.request.messages) {
      if (!object(message) || typeof message.role !== "string" || !message.role.length) fail("对话消息必须包含有效的 role，并保留原始完整消息");
      if (message.content !== undefined && message.content !== null && typeof message.content !== "string" && !Array.isArray(message.content)) fail("对话消息 content 格式不正确");
    }
    if (parameters.request.tools !== undefined && !Array.isArray(parameters.request.tools)) fail("对话 tools 必须保持为原始工具列表");
  } else {
    if (!Number.isSafeInteger(parameters.dimension) || parameters.dimension < 1 || parameters.dimension > 65536) fail("向量维度必须是目录中已验收的精确正整数");
    if (parameters.request.dimensions !== undefined && parameters.request.dimensions !== parameters.dimension) fail("向量 request.dimensions 与 parameters.dimension 不一致", "EMBEDDING_DIMENSION_MISMATCH");
    if (parameters.request.encoding_format !== undefined && !["float", "base64"].includes(parameters.request.encoding_format)) fail("向量编码仅支持 float 或 base64");
    embeddingInputCount(parameters.request.input);
  }
  return true;
}

const contractKeys = {
  "gulong_engine.agent_chat": ["exact_request", "complete_response"],
  "gulong_engine.embedding": ["exact_request", "complete_response", "exact_model_dimension"],
  "gulong_engine.music": ["music_generation", "whole_audio_asr", "exact_lyrics", "exact_duration"],
};

export function normalizeSpecialNodeModels(capabilityId, report = {}) {
  if (!isWorkLuckyCapability(capabilityId)) return {};
  const version = report.capability_version ?? report.capabilityVersion ?? report.specialContractVersion;
  if (version !== WORKLUCKY_CONTRACT_VERSION) fail(`该共享能力必须完成 ${WORKLUCKY_CONTRACT_VERSION} 消费者合同验收`, "CAPABILITY_VERSION_UNSUPPORTED", 409);
  const tests = report.validation?.contract_tests ?? report.validation?.contractTests ?? report.contractTests ?? {};
  if (!object(tests) || contractKeys[capabilityId].some((key) => tests[key] !== true)) fail("节点缺少该能力的完整真实消费者验收证明", "CAPABILITY_CONSUMER_PROOF_REQUIRED", 409);
  const matrix = report.models ?? report.supported_models ?? report.supportedModels;
  if (!Array.isArray(matrix) || !matrix.length || matrix.length > 64) fail("节点必须上报 1–64 个实际验收模型及其参数矩阵", "CAPABILITY_MODEL_REPORT_REQUIRED");
  const seen = new Set();
  const models = matrix.map((model) => {
    if (!object(model)) fail("节点模型必须使用结构化模型矩阵，不能只上报模型名称", "CAPABILITY_MODEL_REPORT_REQUIRED");
    requireModel(model.id, "节点实际模型");
    const normalized = { id: model.id };
    if (capabilityId === "gulong_engine.embedding") {
      if (!Number.isSafeInteger(model.dimension) || model.dimension < 1 || model.dimension > 65536) fail("每个向量模型必须上报实际验收的精确 dimension", "EMBEDDING_DIMENSION_REPORT_REQUIRED");
      normalized.dimension = model.dimension;
    }
    if (capabilityId === "gulong_engine.music") {
      if (typeof model.max_duration_seconds !== "number" || !Number.isFinite(model.max_duration_seconds)
        || model.max_duration_seconds < 1 || model.max_duration_seconds > 600) fail("每个音乐模型必须上报实际验收的最长时长 max_duration_seconds（1–600 秒），不能省略或使用字符串", "MUSIC_DURATION_REPORT_REQUIRED");
      normalized.max_duration_seconds = model.max_duration_seconds;
    }
    if (capabilityId === "gulong_engine.agent_chat") {
      if (typeof model.tools !== "boolean" || typeof model.multimodal !== "boolean") fail("每个对话模型必须明确声明 tools 和 multimodal 的真实验收状态", "CAPABILITY_FEATURE_PROOF_REQUIRED");
      if ((model.tools && tests.tools !== true) || (model.multimodal && tests.multimodal !== true)) fail("工具或多模态声明缺少对应真实验收证明", "CAPABILITY_FEATURE_PROOF_REQUIRED", 409);
      normalized.tools = model.tools;
      normalized.multimodal = model.multimodal;
    }
    const key = `${model.id}\0${normalized.dimension || ""}`;
    if (seen.has(key)) fail("节点不能重复上报同一模型及维度");
    seen.add(key);
    return normalized;
  });
  const defaultModel = report.default_model ?? report.defaultModel ?? null;
  if ((defaultModel !== null && !models.some((model) => model.id === defaultModel))
    || (capabilityId === "gulong_engine.agent_chat" && defaultModel === null)) fail("default_model 必须是该节点实际验收模型矩阵中的模型 ID", "CAPABILITY_DEFAULT_MODEL_INVALID");
  let asrLanguages = [];
  if (capabilityId === "gulong_engine.music") {
    const languages = report.asr_languages ?? report.asrLanguages;
    if (!Array.isArray(languages) || !languages.length || languages.some((language) => !["zh", "en"].includes(language))) fail("音乐消费者必须明确上报已完成整段音频验证的 ASR 语言 zh 或 en", "MUSIC_ASR_LANGUAGE_REQUIRED");
    asrLanguages = [...new Set(languages)].sort();
  }
  return {
    models, defaultModel, contractTests: structuredClone(tests), specialContractVersion: WORKLUCKY_CONTRACT_VERSION,
    tools: models.some((model) => model.tools === true), multimodal: models.some((model) => model.multimodal === true), asrLanguages,
  };
}

function requiresTools(request = {}) { return (Array.isArray(request.tools) && request.tools.length > 0) || (request.tool_choice !== undefined && request.tool_choice !== "none"); }
function requiresMultimodal(request = {}) {
  return request.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => !object(part) || part.type !== "text")) === true;
}

export function specialNodeMatches(order, reported = {}) {
  if (!isWorkLuckyCapability(order?.capabilityId)) return true;
  try { validateSpecialParameters(order.capabilityId, order.parameters); } catch { return false; }
  if (reported.specialContractVersion !== WORKLUCKY_CONTRACT_VERSION || !Array.isArray(reported.models)) return false;
  const parameters = order.parameters;
  return reported.models.some((model) => (!parameters.model || model.id === parameters.model)
    && (order.capabilityId !== "gulong_engine.embedding" || model.dimension === parameters.dimension)
    && (order.capabilityId !== "gulong_engine.agent_chat" || ((!requiresTools(parameters.request) || model.tools === true)
      && (!requiresMultimodal(parameters.request) || model.multimodal === true)))
    && (order.capabilityId !== "gulong_engine.music" || (reported.contractTests?.whole_audio_asr === true && reported.asrLanguages?.length > 0
      && Number.isFinite(model.max_duration_seconds) && model.max_duration_seconds >= 1 && model.max_duration_seconds <= 600
      && parameters.seconds <= model.max_duration_seconds)));
}

// Call only with fresh, authenticated reports whose acceptance registry entry
// matches binding + version + artifact SHA + this exact model matrix.
export function specialAvailability(capabilityId, reports = []) {
  if (!isWorkLuckyCapability(capabilityId)) return {};
  const accepted = reports.filter((report) => report.specialContractVersion === WORKLUCKY_CONTRACT_VERSION && Array.isArray(report.models)
    && (capabilityId !== "gulong_engine.music" || report.trustedAcceptance === true));
  const models = new Map();
  for (const report of accepted) {
    for (const model of report.models) {
      const key = `${model.id}\0${model.dimension || ""}`;
      const previous = models.get(key);
      models.set(key, previous ? { ...previous,
        ...(capabilityId === "gulong_engine.agent_chat" ? { tools: previous.tools || model.tools, multimodal: previous.multimodal || model.multimodal } : {}),
        ...(capabilityId === "gulong_engine.music" ? { max_duration_seconds: Math.max(previous.max_duration_seconds, model.max_duration_seconds) } : {}),
      } : { ...model });
    }
  }
  const matrix = [...models.values()].sort((a, b) => a.id.localeCompare(b.id) || (a.dimension || 0) - (b.dimension || 0));
  const defaults = accepted.map((report) => report.defaultModel).filter((id) => matrix.some((model) => model.id === id));
  return {
    models: matrix, default_model: defaults[0] || null,
    tools: matrix.some((model) => model.tools === true), multimodal: matrix.some((model) => model.multimodal === true),
    ...(capabilityId === "gulong_engine.music" ? { asr_languages: [...new Set(accepted.flatMap((report) => report.asrLanguages || []))].sort(), full_audio_asr: accepted.length > 0 } : {}),
  };
}

function validUsage(usage) {
  return object(usage) && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0
    && Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= usage.prompt_tokens;
}
function validVector(value, dimension, encoding) {
  if (encoding !== "base64") return Array.isArray(value) && value.length === dimension && value.every((part) => typeof part === "number" && Number.isFinite(part));
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== dimension * 4 || bytes.toString("base64") !== value) return false;
  for (let offset = 0; offset < bytes.length; offset += 4) if (!Number.isFinite(bytes.readFloatLE(offset))) return false;
  return true;
}
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
function lyricTokens(value) {
  return value.normalize("NFKC").toLowerCase().replace(/\[[^\]\r\n]*\]/gu, " ").match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) || [];
}
export function wholeLyricsInTranscript(lyrics, transcript) {
  const expected = lyricTokens(lyrics);
  const actual = lyricTokens(transcript);
  let index = 0;
  for (const token of actual) if (token === expected[index]) index += 1;
  return index === expected.length;
}

export function validateSpecialInlineResult(order, result, { outputs } = {}) {
  if (!isWorkLuckyCapability(order?.capabilityId)) return true;
  validateSpecialParameters(order.capabilityId, order.parameters);
  requirePlain(result, "完整消费者结果");
  requireSize(result, resultLimit, "完整消费者结果");
  if (order.capabilityId === "gulong_engine.music") {
    const audios = Array.isArray(outputs) ? outputs.filter((item) => item.role === "primary_audio") : [];
    if (audios.length !== 1) fail("音乐完成回调必须包含一个已验证的完整 FLAC 主音频输出", "MUSIC_OUTPUT_REQUIRED");
    const audio = audios[0];
    const contentType = audio.content_type ?? audio.contentType;
    const duration = audio.duration_seconds ?? audio.durationSeconds;
    if (!["audio/flac", "audio/x-flac"].includes(contentType) || !Number.isSafeInteger(audio.bytes) || audio.bytes <= 0 || !hashPattern.test(audio.sha256 || "")
      || !Number.isFinite(duration) || duration <= 0 || duration > order.parameters.seconds + 0.05) fail("音乐输出必须具有实际验证的 FLAC 大小、摘要和时长，且不能超过请求的最长时长", "MUSIC_OUTPUT_RECEIPT_MISMATCH", 409);
    const verification = result.lyric_verification;
    if (!object(verification) || verification.algorithm !== "ordered-whole-lyrics-v1" || verification.full_audio !== true) fail("必须提供同一消费者整段音频的完整歌词 ASR 验证，不能仅提供 verified 布尔值", "MUSIC_LYRIC_VERIFICATION_REQUIRED");
    if (!["zh", "en"].includes(verification.language)) fail("整段音频 ASR 必须返回实际语言 zh 或 en", "MUSIC_ASR_LANGUAGE_REQUIRED");
    if (!hashPattern.test(verification.audio_sha256 || "") || verification.audio_sha256.toLowerCase() !== audio.sha256.toLowerCase()
      || !hashPattern.test(verification.lyrics_sha256 || "") || verification.lyrics_sha256.toLowerCase() !== sha256(order.parameters.lyrics)) fail("歌词验证必须绑定原始完整歌词和已验证的完整音频 SHA-256", "MUSIC_LYRIC_HASH_MISMATCH", 409);
    if (typeof verification.transcript !== "string" || (!verification.transcript.trim() && lyricTokens(order.parameters.lyrics).length)) fail("必须提供整段 ASR 转录文本，不能省略歌词末尾", "MUSIC_WHOLE_TRANSCRIPT_REQUIRED");
    if (!wholeLyricsInTranscript(order.parameters.lyrics, verification.transcript)) fail("整段 ASR 未按顺序覆盖完整歌词，请重新生成，不能截断歌词或省略尾段", "MUSIC_WHOLE_LYRICS_MISMATCH", 409);
    if (result.primary_audio !== undefined) {
      if (!object(result.primary_audio) || (result.primary_audio.sha256 !== undefined && result.primary_audio.sha256.toLowerCase() !== audio.sha256.toLowerCase())
        || (result.primary_audio.bytes !== undefined && result.primary_audio.bytes !== audio.bytes)
        || (result.primary_audio.duration_seconds !== undefined && result.primary_audio.duration_seconds !== duration)) fail("可选主音频快照与实际验证输出不一致", "MUSIC_OUTPUT_RECEIPT_MISMATCH", 409);
    }
    return true;
  }
  const response = result.response;
  if (!object(response) || response.model !== order.parameters.model) fail("必须返回实际请求模型的完整 OpenAI 响应，不能替换模型", "CAPABILITY_RESULT_MODEL_MISMATCH", 409);
  if (!validUsage(response.usage)) fail("完整 OpenAI 响应必须包含原始有效 usage 统计", "CAPABILITY_COMPLETE_RESPONSE_REQUIRED");
  if (order.capabilityId === "gulong_engine.agent_chat") {
    if (response.object !== "chat.completion" || typeof response.id !== "string" || !response.id || !Array.isArray(response.choices) || !response.choices.length
      || !Number.isSafeInteger(response.usage.completion_tokens) || response.usage.completion_tokens < 0) fail("必须返回包含 id、choices、message 和 usage 的完整 chat.completion 响应", "CAPABILITY_COMPLETE_RESPONSE_REQUIRED");
    const indices = new Set();
    for (const choice of response.choices) {
      if (!object(choice) || !Number.isSafeInteger(choice.index) || choice.index < 0 || indices.has(choice.index) || !object(choice.message) || choice.message.role !== "assistant"
        || !(typeof choice.finish_reason === "string" || choice.finish_reason === null)) fail("完整对话响应 choices、index 或 assistant message 不符合合同", "CAPABILITY_COMPLETE_RESPONSE_REQUIRED");
      indices.add(choice.index);
      if (choice.message.content !== null && typeof choice.message.content !== "string" && !Array.isArray(choice.message.content)) fail("完整对话响应必须保留 message.content，工具调用时允许 null", "CAPABILITY_COMPLETE_RESPONSE_REQUIRED");
      if (choice.message.tool_calls !== undefined && !Array.isArray(choice.message.tool_calls)) fail("对话响应 tool_calls 必须保持完整列表", "CAPABILITY_COMPLETE_RESPONSE_REQUIRED");
    }
  } else {
    const count = embeddingInputCount(order.parameters.request.input);
    if (response.object !== "list" || !Array.isArray(response.data) || response.data.length !== count) fail("完整向量响应 data 数量必须与原始输入一致", "EMBEDDING_RESULT_INVALID");
    for (let index = 0; index < response.data.length; index += 1) {
      const item = response.data[index];
      if (!object(item) || item.object !== "embedding" || item.index !== index || !validVector(item.embedding, order.parameters.dimension, order.parameters.request.encoding_format)) fail("向量响应必须保持输入索引顺序、精确维度及有效完整向量，不能替换或补齐", "EMBEDDING_RESULT_INVALID", 409);
    }
  }
  return true;
}
