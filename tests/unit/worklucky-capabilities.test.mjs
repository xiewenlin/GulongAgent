import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  WORKLUCKY_CAPABILITY_DEFINITIONS, isWorkLuckyCapability, normalizeSpecialNodeModels,
  validateSpecialParameters, validateSpecialInlineResult, specialNodeMatches, specialAvailability, wholeLyricsInTranscript,
} from "../../server/worklucky-capabilities.js";

const chatId = "gulong_engine.agent_chat";
const embedId = "gulong_engine.embedding";
const musicId = "gulong_engine.music";
const model = "local/accepted-model-v1"; // Test-only ID, never an advertised production model.
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const chat = () => ({ model, request: {
  model, messages: [{ role: "system", content: "Keep the original system message." }, { role: "user", content: "hello" }],
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } } }],
  tool_choice: { type: "function", function: { name: "read_file" } }, temperature: 0.17, vendor_extension: { exact: [1, 2, 3] },
} });
const chatResponse = () => ({ response: {
  id: "chatcmpl-test-only", object: "chat.completion", model, created: 123,
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"filename":"hello.txt"}' } }] } }],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 8 } }, vendor_response: { retained: true },
} });
const embedding = () => ({ model, dimension: 3, request: { model, input: ["first", "second"], dimensions: 3, encoding_format: "float", user: "keep-user" } });
const embeddingResponse = () => ({ response: { object: "list", model, data: [
  { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
  { object: "embedding", index: 1, embedding: [-0.1, -0.2, -0.3] },
], usage: { prompt_tokens: 9, total_tokens: 9 } } });
const music = () => ({ model, caption: "Original caption", lyrics: "[Verse]\n最初的歌声\n[Chorus]\n最后一句不能丢失", seconds: 30, seed: 42 });
const audio = () => ({ output_id: "out-test", role: "primary_audio", content_type: "audio/flac", bytes: 12345, sha256: "a".repeat(64), duration_seconds: 30 });
const musicResponse = (parameters = music()) => ({ lyric_verification: {
  algorithm: "ordered-whole-lyrics-v1", audio_sha256: audio().sha256, lyrics_sha256: hash(parameters.lyrics),
  full_audio: true, language: "zh", transcript: "最初的歌声，最后一句不能丢失。",
} });
function report(capabilityId, overrides = {}) {
  return {
    capability_version: "1.0.0", default_model: model,
    models: capabilityId === embedId ? [{ id: model, dimension: 3 }] : capabilityId === chatId ? [{ id: model, tools: true, multimodal: true }] : [{ id: model, max_duration_seconds: 300 }],
    asr_languages: ["zh", "en"], validation: { contract_tests: {
      exact_request: true, complete_response: true, tools: true, multimodal: true, exact_model_dimension: true,
      music_generation: true, whole_audio_asr: true, exact_lyrics: true, exact_duration: true,
    } }, ...overrides,
  };
}
const coded = (code) => (error) => error.code === code && error.status >= 400;

test("WorkLucky capabilities are versioned, monthly zero-price and acceptance gated; video remains separate", () => {
  assert.deepEqual(WORKLUCKY_CAPABILITY_DEFINITIONS.map((item) => item.capabilityId), [chatId, embedId, musicId]);
  for (const item of WORKLUCKY_CAPABILITY_DEFINITIONS) {
    assert.equal(item.priceFen, 0);
    assert.equal(item.entitlement, "gulong_engine_monthly");
    assert.equal(item.requiredCapabilityVersion, "1.0.0");
    assert.equal(item.trustedConsumerAcceptanceRequired, true);
    assert.equal(item.adapterStatus, "automatic_verification_required");
  }
  assert.equal(isWorkLuckyCapability("gulong_engine.video"), false);
  assert.equal(WORKLUCKY_CAPABILITY_DEFINITIONS.find((item) => item.capabilityId === chatId).parametersSchema.properties.request.additionalProperties, true);
});

test("agent chat keeps complete request/response, tool calls, usage and vendor fields byte-for-byte", () => {
  const parameters = chat(), result = chatResponse();
  const before = JSON.stringify({ parameters, result });
  assert.equal(validateSpecialParameters(chatId, parameters), true);
  assert.equal(validateSpecialInlineResult({ capabilityId: chatId, parameters }, result), true);
  assert.equal(JSON.stringify({ parameters, result }), before);
  assert.equal(parameters.request.tools[0].function.name, "read_file");
});

test("agent chat rejects model substitution, auto models and non-objects without rewriting", () => {
  assert.throws(() => validateSpecialParameters(chatId, { ...chat(), model: "another/model" }), coded("CAPABILITY_MODEL_MISMATCH"));
  assert.throws(() => validateSpecialParameters(chatId, { model: "auto", request: { model: "auto", messages: [{ role: "user", content: "hello" }] } }));
  assert.throws(() => validateSpecialParameters(chatId, { model, request: [] }));
  const result = chatResponse(); result.response.model = "silently/substituted-model";
  assert.throws(() => validateSpecialInlineResult({ capabilityId: chatId, parameters: chat() }, result), coded("CAPABILITY_RESULT_MODEL_MISMATCH"));
});

test("agent chat requires complete original usage and structured choices, not a text projection", () => {
  assert.throws(() => validateSpecialInlineResult({ capabilityId: chatId, parameters: chat() }, { text: "reduced response" }), coded("CAPABILITY_RESULT_MODEL_MISMATCH"));
  const result = chatResponse(); delete result.response.usage;
  assert.throws(() => validateSpecialInlineResult({ capabilityId: chatId, parameters: chat() }, result), coded("CAPABILITY_COMPLETE_RESPONSE_REQUIRED"));
});

test("node report preserves actual slash-containing model IDs and attested feature matrix", () => {
  const normalized = normalizeSpecialNodeModels(chatId, report(chatId));
  assert.deepEqual(normalized.models, [{ id: model, tools: true, multimodal: true }]);
  assert.equal(normalized.defaultModel, model);
  assert.equal(normalized.tools, true);
  assert.equal(normalized.multimodal, true);
});

test("node report rejects missing actual models, undeclared tools/media, fake defaults and wrong versions", () => {
  assert.throws(() => normalizeSpecialNodeModels(chatId, report(chatId, { models: [] })), coded("CAPABILITY_MODEL_REPORT_REQUIRED"));
  assert.throws(() => normalizeSpecialNodeModels(chatId, report(chatId, { models: [model] })), coded("CAPABILITY_MODEL_REPORT_REQUIRED"));
  assert.throws(() => normalizeSpecialNodeModels(chatId, report(chatId, { models: [{ id: model }] })), coded("CAPABILITY_FEATURE_PROOF_REQUIRED"));
  assert.throws(() => normalizeSpecialNodeModels(chatId, report(chatId, { default_model: "unaccepted/model" })), coded("CAPABILITY_DEFAULT_MODEL_INVALID"));
  assert.throws(() => normalizeSpecialNodeModels(chatId, report(chatId, { capability_version: "0.9" })), coded("CAPABILITY_VERSION_UNSUPPORTED"));
});

test("ready booleans cannot substitute for feature-specific consumer proofs", () => {
  assert.throws(() => normalizeSpecialNodeModels(chatId, report(chatId, { installed: true, validated: true, enabled: true, validation: {} })), coded("CAPABILITY_CONSUMER_PROOF_REQUIRED"));
  assert.throws(() => normalizeSpecialNodeModels(chatId, report(chatId, { validation: { contract_tests: { exact_request: true, complete_response: true } } })), coded("CAPABILITY_FEATURE_PROOF_REQUIRED"));
});

test("agent matching admits only the exact model and actual tools/multimodal feature combination", () => {
  const parameters = chat();
  const order = { capabilityId: chatId, parameters };
  const full = normalizeSpecialNodeModels(chatId, report(chatId));
  assert.equal(specialNodeMatches(order, full), true);
  assert.equal(specialNodeMatches(order, { ...full, models: [{ id: model, tools: false, multimodal: true }] }), false);
  parameters.request.messages[1].content = [{ type: "image_url", image_url: { url: "https://example.invalid/test-only.png" } }];
  assert.equal(specialNodeMatches(order, { ...full, models: [{ id: model, tools: true, multimodal: false }] }), false);
  assert.equal(specialNodeMatches(order, { ...full, models: [{ id: "not/the/model", tools: true, multimodal: true }] }), false);
  assert.equal(specialNodeMatches(order, {}), false);
});

test("embedding exact dimension, request and response data/usage/indexes are preserved", () => {
  const parameters = embedding(), result = embeddingResponse();
  const before = JSON.stringify({ parameters, result });
  assert.equal(validateSpecialParameters(embedId, parameters), true);
  assert.equal(validateSpecialInlineResult({ capabilityId: embedId, parameters }, result), true);
  assert.equal(JSON.stringify({ parameters, result }), before);
  const normalized = normalizeSpecialNodeModels(embedId, report(embedId));
  assert.equal(specialNodeMatches({ capabilityId: embedId, parameters }, normalized), true);
  assert.equal(specialNodeMatches({ capabilityId: embedId, parameters: { ...parameters, dimension: 4, request: { ...parameters.request, dimensions: 4 } } }, normalized), false);
});

test("embedding rejects unaccepted dimensions, reordered or partial vectors and malformed usages", () => {
  assert.throws(() => validateSpecialParameters(embedId, { ...embedding(), dimension: 4 }), coded("EMBEDDING_DIMENSION_MISMATCH"));
  assert.throws(() => normalizeSpecialNodeModels(embedId, report(embedId, { models: [{ id: model }] })), coded("EMBEDDING_DIMENSION_REPORT_REQUIRED"));
  for (const alter of [
    (result) => result.response.data.reverse(),
    (result) => result.response.data[0].embedding.pop(),
    (result) => { result.response.data[0].embedding[0] = Infinity; },
    (result) => result.response.data.pop(),
  ]) {
    const result = embeddingResponse(); alter(result);
    assert.throws(() => validateSpecialInlineResult({ capabilityId: embedId, parameters: embedding() }, result), coded("EMBEDDING_RESULT_INVALID"));
  }
});

test("embedding supports exact token-array input counts and complete base64 float32 vectors", () => {
  const parameters = embedding(); parameters.request.input = [1, 2, 3]; parameters.request.encoding_format = "base64";
  const result = embeddingResponse(); result.response.data = result.response.data.slice(0, 1);
  const bytes = Buffer.alloc(12); [1, 2, 3].forEach((part, index) => bytes.writeFloatLE(part, index * 4));
  result.response.data[0].embedding = bytes.toString("base64");
  assert.equal(validateSpecialInlineResult({ capabilityId: embedId, parameters }, result), true);
  result.response.data[0].embedding = Buffer.alloc(8).toString("base64");
  assert.throws(() => validateSpecialInlineResult({ capabilityId: embedId, parameters }, result), coded("EMBEDDING_RESULT_INVALID"));
});

test("catalog models and default are derived only from supplied accepted node matrices", () => {
  assert.deepEqual(specialAvailability(chatId, []), { models: [], default_model: null, tools: false, multimodal: false });
  const ready = normalizeSpecialNodeModels(chatId, report(chatId));
  assert.deepEqual(specialAvailability(chatId, [ready]).models, ready.models);
  assert.equal(specialAvailability(chatId, [ready]).default_model, model);
  assert.deepEqual(specialAvailability(chatId, [{ models: [{ id: "fake" }] }]).models, []);
});

test("music approved whole caption/lyrics/duration/seed are kept unchanged", () => {
  const parameters = music();
  const before = JSON.stringify(parameters);
  assert.equal(validateSpecialParameters(musicId, parameters), true);
  assert.equal(validateSpecialInlineResult({ capabilityId: musicId, parameters }, musicResponse(parameters), { outputs: [audio()] }), true);
  assert.equal(JSON.stringify(parameters), before);
});

test("music preserves precise unsigned uint64 decimal seeds and rejects truncation/unsafe numeric seeds", () => {
  for (const seed of [0, 42, Number.MAX_SAFE_INTEGER, "0", "9007199254740992", "18446744073709551615"]) {
    const parameters = { ...music(), seed };
    assert.equal(validateSpecialParameters(musicId, parameters), true);
    assert.equal(parameters.seed, seed);
  }
  for (const seed of [-1, Number.MAX_SAFE_INTEGER + 1, 1.5, "-1", "01", "18446744073709551616", "1e10"]) assert.throws(() => validateSpecialParameters(musicId, { ...music(), seed }));
});

test("music requires same-consumer generation and whole-audio ASR proofs with actual supported language", () => {
  const ready = normalizeSpecialNodeModels(musicId, report(musicId));
  assert.equal(specialNodeMatches({ capabilityId: musicId, parameters: music() }, ready), true);
  assert.deepEqual(specialAvailability(musicId, [{ ...ready, trustedAcceptance: true }]).asr_languages, ["en", "zh"]);
  assert.throws(() => normalizeSpecialNodeModels(musicId, report(musicId, { asr_languages: ["auto"] })), coded("MUSIC_ASR_LANGUAGE_REQUIRED"));
  assert.throws(() => normalizeSpecialNodeModels(musicId, report(musicId, { validation: { contract_tests: { music_generation: true, whole_audio_asr: false, exact_lyrics: true, exact_duration: true } } })), coded("CAPABILITY_CONSUMER_PROOF_REQUIRED"));
});

test("music node duration admission preserves exact 300/600 second limits without truncation", () => {
  const maximum300 = normalizeSpecialNodeModels(musicId, report(musicId));
  const maximum600 = normalizeSpecialNodeModels(musicId, report(musicId, { models: [{ id: model, max_duration_seconds: 600 }] }));
  const makeOrder = (seconds) => ({ capabilityId: musicId, parameters: { ...music(), seconds, seed: "18446744073709551615" } });
  assert.deepEqual(maximum300.models, [{ id: model, max_duration_seconds: 300 }]);
  assert.deepEqual(maximum600.models, [{ id: model, max_duration_seconds: 600 }]);
  assert.equal(specialNodeMatches(makeOrder(300), maximum300), true);
  assert.equal(specialNodeMatches(makeOrder(301), maximum300), false);
  assert.equal(specialNodeMatches(makeOrder(600), maximum300), false);
  assert.equal(specialNodeMatches(makeOrder(600), maximum600), true);
  assert.equal(specialNodeMatches(makeOrder(601), maximum600), false);
  const order = makeOrder(301), original = JSON.stringify(order.parameters);
  assert.equal(validateSpecialParameters(musicId, order.parameters), true, "global future-consumer schema remains 600 seconds");
  assert.equal(specialNodeMatches(order, maximum300), false);
  assert.equal(JSON.stringify(order.parameters), original, "rejection cannot truncate seconds, lyrics or uint64 seed");
  const differentModel = { ...maximum600, models: [{ id: "different/accepted-model", max_duration_seconds: 600 }] };
  assert.equal(specialNodeMatches(makeOrder(600), differentModel), false, "another model cannot donate its duration budget");
});

test("music reports require finite numeric verified max_duration_seconds", () => {
  for (const maximum of [undefined, null, NaN, Infinity, -1, 0, 600.01, "300", "600"]) {
    assert.throws(() => normalizeSpecialNodeModels(musicId, report(musicId, { models: [{ id: model, max_duration_seconds: maximum }] })), coded("MUSIC_DURATION_REPORT_REQUIRED"));
  }
  const fractional = normalizeSpecialNodeModels(musicId, report(musicId, { models: [{ id: model, max_duration_seconds: 300.25 }] }));
  assert.equal(fractional.models[0].max_duration_seconds, 300.25);
  assert.equal(specialNodeMatches({ capabilityId: musicId, parameters: { ...music(), seconds: 300.26 } }, fractional), false);
});

test("music catalog aggregates the greatest duration only from trusted accepted models", () => {
  const maximum300 = { ...normalizeSpecialNodeModels(musicId, report(musicId)), trustedAcceptance: true };
  const maximum600 = { ...normalizeSpecialNodeModels(musicId, report(musicId, { models: [{ id: model, max_duration_seconds: 600 }] })), trustedAcceptance: true };
  assert.deepEqual(specialAvailability(musicId, [maximum300, { ...maximum600, trustedAcceptance: false }]).models, [{ id: model, max_duration_seconds: 300 }]);
  assert.deepEqual(specialAvailability(musicId, [maximum300, maximum600]).models, [{ id: model, max_duration_seconds: 600 }]);
  assert.deepEqual(specialAvailability(musicId, [maximum600, maximum300]).models, [{ id: model, max_duration_seconds: 600 }]);
  assert.deepEqual(specialAvailability(musicId, [{ ...maximum600, trustedAcceptance: undefined }]).models, []);
});

test("music rejects verified-only, partial ASR, missing or unknown actual language", () => {
  const order = { capabilityId: musicId, parameters: music() };
  assert.throws(() => validateSpecialInlineResult(order, { verified: true }, { outputs: [audio()] }), coded("MUSIC_LYRIC_VERIFICATION_REQUIRED"));
  for (const value of [undefined, "auto", "unknown", "zh-CN"]) {
    const result = musicResponse(); result.lyric_verification.language = value;
    assert.throws(() => validateSpecialInlineResult(order, result, { outputs: [audio()] }), coded("MUSIC_ASR_LANGUAGE_REQUIRED"));
  }
  const partial = musicResponse(); partial.lyric_verification.full_audio = false;
  assert.throws(() => validateSpecialInlineResult(order, partial, { outputs: [audio()] }), coded("MUSIC_LYRIC_VERIFICATION_REQUIRED"));
});

test("music binds exact original UTF8 lyrics including whitespace and actual audio SHA-256", () => {
  const parameters = music(); parameters.lyrics = `  ${parameters.lyrics}\n`;
  const result = musicResponse(parameters);
  assert.equal(validateSpecialInlineResult({ capabilityId: musicId, parameters }, result, { outputs: [audio()] }), true);
  result.lyric_verification.lyrics_sha256 = hash(parameters.lyrics.trim());
  assert.throws(() => validateSpecialInlineResult({ capabilityId: musicId, parameters }, result, { outputs: [audio()] }), coded("MUSIC_LYRIC_HASH_MISMATCH"));
  result.lyric_verification.lyrics_sha256 = hash(parameters.lyrics);
  result.lyric_verification.audio_sha256 = "b".repeat(64);
  assert.throws(() => validateSpecialInlineResult({ capabilityId: musicId, parameters }, result, { outputs: [audio()] }), coded("MUSIC_LYRIC_HASH_MISMATCH"));
});

test("music whole transcript cannot drop or reorder the lyric tail", () => {
  const order = { capabilityId: musicId, parameters: music() };
  const result = musicResponse(); result.lyric_verification.transcript = "最初的歌声";
  assert.throws(() => validateSpecialInlineResult(order, result, { outputs: [audio()] }), coded("MUSIC_WHOLE_LYRICS_MISMATCH"));
  result.lyric_verification.transcript = "最后一句不能丢失，最初的歌声";
  assert.throws(() => validateSpecialInlineResult(order, result, { outputs: [audio()] }), coded("MUSIC_WHOLE_LYRICS_MISMATCH"));
  assert.equal(wholeLyricsInTranscript("[Verse]\nHello world\n[Outro]\nThis is the final line", "Hello, world. This is the final line!"), true);
  assert.equal(wholeLyricsInTranscript("Hello world\nThis is the final line", "Hello world this is"), false);
  assert.equal(wholeLyricsInTranscript("[Chorus]\nStay with me\n[Outro]\nStay with me", "Stay with me"), false);
});

test("music requires real FLAC output and authoritative complete duration, not inline audio URLs", () => {
  const order = { capabilityId: musicId, parameters: music() }, result = musicResponse();
  assert.throws(() => validateSpecialInlineResult(order, result), coded("MUSIC_OUTPUT_REQUIRED"));
  assert.throws(() => validateSpecialInlineResult(order, result, { outputs: [{ ...audio(), content_type: "audio/mpeg" }] }), coded("MUSIC_OUTPUT_RECEIPT_MISMATCH"));
  assert.equal(validateSpecialInlineResult(order, result, { outputs: [{ ...audio(), duration_seconds: 5 }] }), true);
  assert.throws(() => validateSpecialInlineResult(order, result, { outputs: [{ ...audio(), duration_seconds: 31 }] }), coded("MUSIC_OUTPUT_RECEIPT_MISMATCH"));
  assert.throws(() => validateSpecialInlineResult(order, result, { outputs: [{ ...audio(), bytes: 0 }] }), coded("MUSIC_OUTPUT_RECEIPT_MISMATCH"));
});

test("instrumental music still requires complete FLAC ASR receipt, with valid empty lyric hash", () => {
  const parameters = { ...music(), lyrics: "" };
  const result = musicResponse(parameters); result.lyric_verification.transcript = "";
  assert.equal(validateSpecialInlineResult({ capabilityId: musicId, parameters }, result, { outputs: [audio()] }), true);
});

test("unrelated legacy capabilities are not transformed or falsely declared as WorkLucky support", () => {
  assert.equal(validateSpecialParameters("gulong_engine.text", {}), true);
  assert.equal(validateSpecialInlineResult({ capabilityId: "gulong_engine.text" }, null), true);
  assert.equal(specialNodeMatches({ capabilityId: "gulong_engine.video" }, {}), true);
  assert.deepEqual(specialAvailability("gulong_engine.video", []), {});
});

test("native image and TTS availability expose only server-verified exact matrices, never Cartesian model/voice combinations", () => {
  const raw = { supportedModels: ["guessed-model"], supportedVoices: ["guessed-voice"] };
  assert.deepEqual(specialAvailability("gulong_engine.image_2k", [raw]), { models: [] });
  assert.deepEqual(specialAvailability("gulong_engine.tts", [raw]), { models: [] });
  const reports = [{ trustedAcceptance: true, models: [
    { id: "tts-a", voice_id: "voice-a", private_runtime_path: "must-not-leak" },
    { id: "tts-b", voice_id: "voice-b" }, { id: "tts-a", voice_id: "voice-a" },
    { id: "tts-b" }, { id: "auto", voice_id: "default" }, { id: "tts-c", voice_id: "not a voice" },
  ] }, { trustedAcceptance: false, models: [{ id: "unverified", voice_id: "voice-c" }] }];
  assert.deepEqual(specialAvailability("gulong_engine.tts", reports), { models: [
    { id: "tts-a", voice_id: "voice-a" }, { id: "tts-b", voice_id: "voice-b" },
  ] });
  const imageScope = { id: "qwen_image_2_1", task: "text_to_image", input_asset_count: 0, width: 2048, height: 2048,
    generation_mode: "fast_lora_6", steps: 6, prompt_enhancement: "none" };
  assert.deepEqual(specialAvailability("gulong_engine.image_2k", [{ trustedAcceptance: true, automaticVerification: true,
    contractTests: { exact_image_scope: true }, models: [{ ...imageScope, private_path: "ignored" }, { id: "other" }, { id: "qwen_image_2_1" }] }]),
  { models: [imageScope] });
});
