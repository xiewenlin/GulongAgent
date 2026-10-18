import { createHash } from "node:crypto";

const IMAGE_TYPES = new Set(["image/png"]);
const IMAGE_MODELS = new Set(["zimage", "qwen_image_2_1"]);
const HASH = /^[a-f0-9]{64}$/i;
const VOICE = /^[A-Za-z0-9_.:-]{1,120}$/;
const VERSIONS = Object.freeze({
  "gulong_engine.image": ["1", "1.0.0"], "gulong_engine.image_2k": ["1.0.0"],
  "qwen_image_2_1.text_to_image": ["2.1"], "gulong_engine.tts": ["1.0.0"],
});
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message, code = "VERIFICATION_RESULT_INVALID") => { throw Object.assign(new Error(message), { code, status: 409 }); };
const require = (condition, message, code) => { if (!condition) fail(message, code); };
const seed = (nonce) => createHash("sha256").update(nonce, "utf8").digest().readUInt32BE(0) & 0x7fffffff;

function supportsImage(inventory, model) {
  return VERSIONS[inventory.capabilityId]?.includes(inventory.capabilityVersion) === true && plain(model) && (inventory.capabilityId === "gulong_engine.image" ? IMAGE_MODELS.has(model.id)
    : ["gulong_engine.image_2k", "qwen_image_2_1.text_to_image"].includes(inventory.capabilityId) && model.id === "qwen_image_2_1");
}
function supportsTts(inventory, model) {
  return inventory.capabilityVersion === "1.0.0" && inventory.capabilityId === "gulong_engine.tts" && plain(model) && typeof model.id === "string"
    && typeof model.voice_id === "string" && VOICE.test(model.voice_id);
}

function imageProbe({ inventory, model, nonce }) {
  require(supportsImage(inventory, model), "当前图像模型没有对应的自动验收适配器", "VERIFICATION_ADAPTER_REQUIRED");
  const prompt = `A single blue circle on a plain white background, no lettering. Verification ${nonce}.`;
  const common = { prompt, width: 512, height: 512, seed: seed(nonce) };
  let parameters;
  if (inventory.capabilityId === "gulong_engine.image_2k") {
    parameters = { ...common, model: model.id, task: "text_to_image", width: 2048, height: 2048,
      negative_prompt: "", generation_mode: "fast_lora_6", steps: 6, prompt_enhancement: "none" };
  } else if (inventory.capabilityId === "qwen_image_2_1.text_to_image") {
    // The legacy capability identifies its fixed model in the capability ID;
    // its parameter schema intentionally does not accept a rewritten model key.
    parameters = { ...common, negative_prompt: "", steps: 4, guidance_scale: 4, batch_size: 1 };
  } else parameters = { ...common, model: model.id };
  return { probeKind: "image", outputUploadRequired: true,
    budget: { max_inferences: 1, max_output_tokens: 0, max_audio_seconds: 0, max_images: 1, max_image_pixels: parameters.width * parameters.height },
    parameters };
}

function ttsProbe({ inventory, model, nonce }) {
  require(supportsTts(inventory, model), "共享配音模型缺少实际音色编号，不能自动选择默认音色", "VERIFICATION_ADAPTER_REQUIRED");
  return { probeKind: "tts", outputUploadRequired: true,
    budget: { max_inferences: 1, max_output_tokens: 0, max_audio_seconds: 12 },
    parameters: { text: `Verification ${nonce}.`, voice_id: model.voice_id, language: "en-US", speed: 1, output_format: "wav" } };
}

/** A media verifier must read an immutable private COS copy, verify the actual
 * bytes/SHA-256 and parse its media headers. Client JSON is never media proof. */
export function createCapabilityVerificationAdapters({ verifyMediaOutputs } = {}) {
  if (typeof verifyMediaOutputs !== "function") return {};

  async function verifiedOutput({ challenge, inlineResult, outputs, binding }, role) {
    require(plain(challenge?.model) && typeof challenge.model.id === "string", "自动验收模型记录不完整");
    require(plain(inlineResult) && Buffer.byteLength(JSON.stringify(inlineResult)) <= 64 * 1024
      && inlineResult.model === challenge.model.id, "必须回传本次实际请求的原始模型编号，不能替换模型", "VERIFICATION_MODEL_MISMATCH");
    require(Array.isArray(outputs) && outputs.length === 1 && plain(outputs[0])
      && Object.keys(outputs[0]).length === 1 && typeof outputs[0].output_id === "string"
      && /^[A-Za-z0-9_-]{8,160}$/.test(outputs[0].output_id), "请仅提交本次自动验收的一份输出票据编号", "VERIFICATION_OUTPUT_INVALID");
    const verified = await verifyMediaOutputs({ binding, challenge, outputs });
    require(Array.isArray(verified) && verified.length === 1 && plain(verified[0]), "输出未通过服务端实物校验", "VERIFICATION_OUTPUT_INVALID");
    const output = verified[0];
    require(output.role === role && Number.isSafeInteger(output.bytes) && output.bytes > 0
      && HASH.test(output.sha256 || ""), "输出角色、实测大小或摘要不正确", "VERIFICATION_OUTPUT_INVALID");
    return output;
  }

  async function imageResult(input) {
    const { challenge } = input;
    require(supportsImage({ capabilityId: challenge.capabilityId, capabilityVersion: challenge.capabilityVersion }, challenge.model), "该模型没有图像验证适配器", "VERIFICATION_ADAPTER_REQUIRED");
    const output = await verifiedOutput(input, "primary_image");
    require(IMAGE_TYPES.has(output.contentType) && (!output.actualContentType || output.actualContentType === output.contentType)
      && output.bytes <= 20 * 1024 * 1024, "图像实物格式或大小不符合验收合同", "VERIFICATION_IMAGE_INVALID");
    require(Number.isSafeInteger(output.width) && Number.isSafeInteger(output.height)
      && output.width === challenge.parameters.width && output.height === challenge.parameters.height,
    "图像实际像素尺寸与本次请求不一致", "VERIFICATION_IMAGE_DIMENSIONS_MISMATCH");
    return { verifiedModel: structuredClone(challenge.model),
      contractTests: { exact_model: true, exact_request: true, native_image_output: true, output_sha256: true, exact_dimensions: true } };
  }

  async function ttsResult(input) {
    const { challenge, inlineResult } = input;
    require(supportsTts({ capabilityId: challenge.capabilityId, capabilityVersion: challenge.capabilityVersion }, challenge.model), "该配音模型缺少已上报音色", "VERIFICATION_ADAPTER_REQUIRED");
    require(plain(inlineResult) && inlineResult.voice_id === challenge.model.voice_id
      && challenge.parameters.voice_id === challenge.model.voice_id, "实际配音音色与验收请求不一致", "VERIFICATION_VOICE_MISMATCH");
    const output = await verifiedOutput(input, "primary_audio");
    require(output.contentType === "audio/wav" && (!output.actualContentType || output.actualContentType === "audio/wav")
      && output.bytes <= 32 * 1024 * 1024 && Number.isFinite(output.durationSeconds)
      && output.durationSeconds >= 0.1 && output.durationSeconds <= 12.05
      && output.nonSilent === true
      && Number.isSafeInteger(output.sampleRate) && output.sampleRate >= 8000 && output.sampleRate <= 192000
      && Number.isSafeInteger(output.channels) && output.channels >= 1 && output.channels <= 8,
    "配音必须是服务端解析通过的有效 WAV，且实际时长不得超过12秒", "VERIFICATION_AUDIO_INVALID");
    return { verifiedModel: structuredClone(challenge.model),
      contractTests: { exact_model: true, exact_request: true, actual_voice: true, native_audio_output: true, output_sha256: true, actual_duration: true } };
  }

  const image = { supports: supportsImage, createProbe: imageProbe, validateResult: imageResult };
  return { "gulong_engine.image": { ...image, versions: VERSIONS["gulong_engine.image"] },
    "gulong_engine.image_2k": { ...image, versions: VERSIONS["gulong_engine.image_2k"] },
    "qwen_image_2_1.text_to_image": { ...image, versions: VERSIONS["qwen_image_2_1.text_to_image"] },
    "gulong_engine.tts": { supports: supportsTts, createProbe: ttsProbe, validateResult: ttsResult, versions: VERSIONS["gulong_engine.tts"] } };
}
