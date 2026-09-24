const field = (minLength, maxLength) => ({ type: "string", minLength, maxLength });
const schema = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
const imageMime = ["image/png", "image/jpeg", "image/webp"];
const videoMime = ["video/mp4", "video/webm", "video/quicktime"];
const audioMime = ["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm"];
const imageBytes = 40 * 1024 * 1024;
const referenceImages = [{ role: "reference_image", min: 0, max: 9, mimeTypes: imageMime, maxBytes: imageBytes }];
const videoReferences = [
  ...referenceImages,
  { role: "reference_video", min: 0, max: 3, mimeTypes: videoMime, maxBytes: 2 * 1024 * 1024 * 1024 },
  { role: "reference_audio", min: 0, max: 3, mimeTypes: audioMime, maxBytes: 512 * 1024 * 1024 },
];

function definition(suffix, parametersSchema, options = {}) {
  const assets = options.assets || [];
  return Object.freeze({
    capabilityId: `gulong_engine.${suffix}`, protocolVersion: "gulong-capability-orders-v1",
    inputMime: [...new Set(assets.flatMap((rule) => rule.mimeTypes))], outputMime: options.outputs?.flatMap((rule) => rule.mimeTypes) || [],
    maxAssets: assets.reduce((count, rule) => count + rule.max, 0),
    maxTotalInputBytes: options.maxTotalInputBytes ?? assets.reduce((bytes, rule) => bytes + rule.max * rule.maxBytes, 0),
    defaultEtaSeconds: options.eta || 90, maxRuntimeSeconds: options.runtime || 1800, priceFen: 0,
    inlineResult: options.inlineResult || false, parametersSchemaVersion: "1.0.0", parametersSchema,
    assetRules: assets, outputRules: options.outputs || [], commercialUse: "node_operator_responsibility",
    dispatchable: options.dispatchable !== false, adapterStatus: options.dispatchable === false ? "adapter_required" : "ready",
    legacyRoute: null, entitlement: "gulong_engine_monthly", sharingScope: "gulong_shared",
  });
}

export const GULONG_ENGINE_CAPABILITY_DEFINITIONS = Object.freeze([
  definition("text", schema({
    model: { ...field(1, 120), default: "auto" },
    prompt: field(1, 24000),
    system_prompt: field(0, 8000),
  }, ["prompt"]), { inlineResult: true, eta: 45, runtime: 600 }),
  definition("image", schema({
    model: { type: "string", enum: ["zimage", "qwen_image_2_1"] },
    prompt: field(1, 8000),
    width: { type: "integer", enum: [512, 768, 1024, 1280, 1536], default: 1024 },
    height: { type: "integer", enum: [512, 768, 1024, 1280, 1536], default: 1024 },
    seed: { type: "integer", minimum: -1, maximum: 2147483647, default: -1 },
  }, ["model", "prompt"]), { assets: referenceImages, outputs: [{ role: "primary_image", min: 1, max: 1, mimeTypes: imageMime, maxBytes: imageBytes }], eta: 180 }),
  definition("video", schema({
    model: { type: "string", enum: ["minimax_h3"] }, prompt: field(1, 20000),
    duration_seconds: { type: "integer", minimum: 1, maximum: 15 },
    video_mode: { type: "string", enum: ["all_reference", "first_last", "smart_multiframe"], default: "all_reference" },
    aspect_ratio: { type: "string", enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
    profile: { type: "string", enum: ["official_max", "ultra1080", "fast2k"], default: "official_max" },
    sampling_steps: { type: "integer", enum: [4, 8, 20], default: 4 },
    seed: { type: "integer", minimum: -1, maximum: 2147483647, default: -1 },
    prompt_optimization_enabled: { type: "boolean", default: false },
  }, ["model", "prompt", "duration_seconds", "aspect_ratio"]), { assets: videoReferences, maxTotalInputBytes: 2 * 1024 * 1024 * 1024,
    outputs: [{ role: "primary_video", min: 1, max: 1, mimeTypes: ["video/mp4"], maxBytes: 2 * 1024 * 1024 * 1024 }],
    eta: 1200, runtime: 21600, dispatchable: false }),
]);
const ids = new Set(GULONG_ENGINE_CAPABILITY_DEFINITIONS.map((item) => item.capabilityId));
export function isGulongEngineCapability(id) { return ids.has(id); }
export function gulongEngineUploadAllowed(contentType, bytes) {
  return Number.isSafeInteger(bytes) && bytes > 0 && GULONG_ENGINE_CAPABILITY_DEFINITIONS.some((item) => item.assetRules.some((rule) => rule.mimeTypes.includes(contentType) && bytes <= rule.maxBytes));
}
export function gulongEngineNodeSharesCapability(node, capabilityId) {
  return isGulongEngineCapability(capabilityId) && node.capabilities?.some((item) => item.capabilityId === capabilityId
    && item.installed && item.validated && item.enabled && item.sharingOptIn === true);
}
export function validateGulongEngineInlineResult(capabilityId, value) {
  if (capabilityId !== "gulong_engine.text") return true;
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.text === "string" && value.text.trim().length && value.text.length <= 64_000
    && Buffer.byteLength(JSON.stringify(value)) <= 64_000);
}
