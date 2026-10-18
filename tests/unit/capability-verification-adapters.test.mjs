import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityVerificationAdapters } from "../../server/capability-verification-adapters.js";

const HASH = "a".repeat(64);
function fixture(capabilityId = "gulong_engine.image", model = { id: "zimage" }) {
  let output = { role: "primary_image", contentType: "image/png", actualContentType: "image/png", bytes: 1000, sha256: HASH, width: 512, height: 512 };
  const calls = [];
  const adapters = createCapabilityVerificationAdapters({ verifyMediaOutputs: async (input) => { calls.push(input); return [output]; } });
  const adapter = adapters[capabilityId];
  const capabilityVersion = capabilityId === "qwen_image_2_1.text_to_image" ? "2.1" : "1.0.0";
  const inventory = { capabilityId, capabilityVersion };
  const probe = adapter.createProbe({ inventory, model, nonce: "gcv-1234567890" });
  const challenge = { _id: "gcv-test-challenge", capabilityId, capabilityVersion, model, parameters: probe.parameters };
  return { adapter, inventory, model, probe, challenge, calls,
    input: { challenge, binding: { _id: "bound-node" }, inlineResult: { model: model.id, ...(model.voice_id ? { voice_id: model.voice_id } : {}) }, outputs: [{ output_id: "owned-output-id" }] },
    set output(value) { output = value; } };
}

test("无真实媒体验证依赖不制造可用适配器，素材依赖和本地能力未被假开放", () => {
  assert.deepEqual(createCapabilityVerificationAdapters(), {});
  const adapters = createCapabilityVerificationAdapters({ verifyMediaOutputs: async () => [] });
  assert.deepEqual(Object.keys(adapters).sort(), ["gulong_engine.image", "gulong_engine.image_2k", "gulong_engine.tts", "qwen_image_2_1.text_to_image"]);
  assert.equal(adapters["sam.segment"], undefined);
  assert.equal(adapters["whisper.transcribe"], undefined);
  assert.equal(adapters["english_coach.conversation"], undefined);
});

test("图像探测保留精确模型编号，无素材且单次单图，2K使用原生2048像素6步", () => {
  const image = fixture();
  assert.equal(image.adapter.supports(image.inventory, image.model), true);
  assert.equal(image.probe.parameters.model, "zimage");
  assert.equal(image.probe.budget.max_inferences, 1);
  assert.equal(image.probe.budget.max_images, 1);
  assert.equal(image.probe.parameters.width, 512);
  assert.match(image.probe.parameters.prompt, /gcv-1234567890/);
  assert.equal(image.adapter.supports(image.inventory, { id: "unknown-image" }), false);
  assert.equal(image.adapter.supports({ ...image.inventory, capabilityVersion: "9.0.0" }, image.model), false);
  assert.equal(image.adapter.supports({ ...image.inventory, capabilityVersion: "1" }, image.model), true);
  const twoK = fixture("gulong_engine.image_2k", { id: "qwen_image_2_1" });
  assert.equal(twoK.probe.parameters.model, "qwen_image_2_1");
  assert.equal(twoK.probe.parameters.width, 2048);
  assert.equal(twoK.probe.parameters.height, 2048);
  assert.equal(twoK.probe.parameters.steps, 6);
  assert.equal(twoK.probe.parameters.generation_mode, "fast_lora_6");
  const legacy = fixture("qwen_image_2_1.text_to_image", { id: "qwen_image_2_1" });
  assert.equal(legacy.probe.parameters.model, undefined);
  assert.equal(legacy.probe.parameters.batch_size, 1);
  assert.equal(legacy.adapter.supports({ ...legacy.inventory, capabilityVersion: "1.0.0" }, legacy.model), false);
  assert.deepEqual(legacy.adapter.versions, ["2.1"]);
});

test("图像验收仅接受当前票据经服务端验证后的真实格式尺寸和摘要", async () => {
  const context = fixture();
  const result = await context.adapter.validateResult(context.input);
  assert.deepEqual(result.verifiedModel, context.model);
  assert.equal(result.contractTests.exact_dimensions, true);
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].binding._id, "bound-node");
  assert.deepEqual(context.calls[0].outputs, [{ output_id: "owned-output-id" }]);
  context.output = { role: "primary_image", contentType: "image/png", bytes: 1000, sha256: HASH, width: 256, height: 512 };
  await assert.rejects(context.adapter.validateResult(context.input), { code: "VERIFICATION_IMAGE_DIMENSIONS_MISMATCH" });
  context.output = { role: "primary_image", contentType: "image/png", actualContentType: "text/html", bytes: 1000, sha256: HASH, width: 512, height: 512 };
  await assert.rejects(context.adapter.validateResult(context.input), { code: "VERIFICATION_IMAGE_INVALID" });
});

test("客户端validated布尔、URL、伪造模型及缺少媒体摘要都不能通过图像验收", async () => {
  const context = fixture();
  await assert.rejects(context.adapter.validateResult({ ...context.input, inlineResult: { validated: true } }), { code: "VERIFICATION_MODEL_MISMATCH" });
  await assert.rejects(context.adapter.validateResult({ ...context.input, outputs: [{ output_id: "owned-output-id", url: "https://arbitrary.example/image.png" }] }), { code: "VERIFICATION_OUTPUT_INVALID" });
  await assert.rejects(context.adapter.validateResult({ ...context.input, inlineResult: { model: "replacement" } }), { code: "VERIFICATION_MODEL_MISMATCH" });
  context.output = { role: "primary_image", contentType: "image/png", bytes: 1000, width: 512, height: 512 };
  await assert.rejects(context.adapter.validateResult(context.input), { code: "VERIFICATION_OUTPUT_INVALID" });
});

test("配音探测必须指定实际voice_id，不隐式选择default，单探测限12秒", () => {
  const context = fixture("gulong_engine.tts", { id: "qwen-tts", voice_id: "real-voice-001" });
  assert.equal(context.adapter.supports(context.inventory, { id: "qwen-tts" }), false);
  assert.equal(context.probe.parameters.model, "qwen-tts");
  assert.equal(context.probe.parameters.voice_id, "real-voice-001");
  assert.equal(context.probe.parameters.output_format, "wav");
  assert.equal(context.probe.budget.max_audio_seconds, 12);
  assert.equal(context.probe.budget.max_inferences, 1);
  assert.equal(context.probe.parameters.text.includes("gcv-1234567890"), true);
});

test("配音验收校验真实WAV时长采样率声道、原模型与音色", async () => {
  const context = fixture("gulong_engine.tts", { id: "qwen-tts", voice_id: "real-voice-001" });
  const output = { role: "primary_audio", contentType: "audio/wav", actualContentType: "audio/wav", bytes: 1000, sha256: HASH, durationSeconds: 2.5, sampleRate: 24000, channels: 1, nonSilent: true };
  context.output = output;
  const result = await context.adapter.validateResult(context.input);
  assert.deepEqual(result.verifiedModel, context.model);
  assert.equal(result.contractTests.actual_duration, true);
  await assert.rejects(context.adapter.validateResult({ ...context.input, inlineResult: { model: "qwen-tts", voice_id: "other-voice" } }), { code: "VERIFICATION_VOICE_MISMATCH" });
  for (const changed of [{ durationSeconds: 0 }, { durationSeconds: 13 }, { sampleRate: 0 }, { channels: 0 }, { contentType: "audio/mpeg" }, { nonSilent: false }]) {
    context.output = { ...output, ...changed };
    await assert.rejects(context.adapter.validateResult(context.input), { code: "VERIFICATION_AUDIO_INVALID" });
  }
});
