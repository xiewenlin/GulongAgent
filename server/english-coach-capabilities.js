const text = (minLength, maxLength, extra = {}) => ({ type: "string", minLength, maxLength, ...extra });
const choice = (values, defaultValue) => ({ type: "string", enum: values, ...(defaultValue ? { default: defaultValue } : {}) });
const schema = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
export const ENGLISH_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const ENGLISH_AUDIO_MIME = Object.freeze(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/flac", "audio/webm"]);
const media = { role: "media", min: 1, max: 1, mimeTypes: ENGLISH_AUDIO_MIME, maxBytes: ENGLISH_AUDIO_MAX_BYTES };
function definition(suffix, parametersSchema, { assets = [], outputs = [], inlineResult = true, eta = 60, dispatchable = true } = {}) {
  return Object.freeze({
    capabilityId: `english_coach.${suffix}`, protocolVersion: "gulong-capability-orders-v1",
    inputMime: assets.length ? ENGLISH_AUDIO_MIME : [], outputMime: outputs.flatMap((rule) => rule.mimeTypes),
    maxAssets: assets.length, maxTotalInputBytes: assets.length ? ENGLISH_AUDIO_MAX_BYTES : 0,
    defaultEtaSeconds: eta, maxRuntimeSeconds: 900, priceFen: 0, inlineResult,
    parametersSchemaVersion: "1.0.0", parametersSchema, assetRules: assets, outputRules: outputs,
    commercialUse: "node_operator_responsibility", dispatchable, adapterStatus: dispatchable ? "ready" : "local_only", legacyRoute: null,
    entitlement: "english_coach_monthly", sharingScope: "english_shared",
  });
}
export const ENGLISH_CAPABILITY_DEFINITIONS = Object.freeze([
  definition("text", schema({ task: choice(["coach", "writing", "explain"]), input: text(1, 24000), context: text(0, 24000, { default: "" }), exam: text(1, 32, { default: "general" }) }, ["task", "input"]), { dispatchable: false }),
  definition("transcribe", schema({ language: choice(["en"], "en") }, []), { assets: [media], dispatchable: false }),
  definition("speech", schema({ text: text(1, 12000), locale: choice(["en-US", "en-GB"], "en-US"), output_format: choice(["wav"], "wav") }, ["text"]), {
    inlineResult: false, outputs: [{ role: "primary_audio", min: 1, max: 1, mimeTypes: ["audio/wav", "audio/x-wav"], maxBytes: ENGLISH_AUDIO_MAX_BYTES }], eta: 30, dispatchable: false,
  }),
  definition("assess", schema({ reference_text: text(1, 24000), language: choice(["en-US"], "en-US") }, ["reference_text"]), { assets: [media], dispatchable: false }),
]);
const IDS = new Set(ENGLISH_CAPABILITY_DEFINITIONS.map((item) => item.capabilityId));
export function isEnglishCapability(id) { return IDS.has(id); }
export function englishWorkerOwnsClaim(order, auth) {
  if (String(order.requesterUserId) === String(auth.user._id)) return true;
  return isEnglishCapability(order.capabilityId) && order.sharingScope === "english_shared"
    && String(order.assignedNode?.userId) === String(auth.user._id)
    && String(order.assignedNode?.bindingId) === String(auth.binding._id);
}
export function englishNodeSharesCapability(node, capabilityId) {
  return isEnglishCapability(capabilityId) && node.capabilities?.some((item) => item.capabilityId === capabilityId
    && item.installed && item.validated && item.enabled && item.sharingOptIn === true);
}
export function validateEnglishInlineResult(capabilityId, result, parameters) {
  if (!isEnglishCapability(capabilityId) || capabilityId === "english_coach.speech") return true;
  if (!result || typeof result !== "object" || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) > 64_000) return false;
  if (capabilityId !== "english_coach.assess") return typeof result.text === "string" && result.text.trim().length > 0 && result.text.length <= 64000;
  if (result.provider !== "local-phoneme" || result.referenceText !== parameters.reference_text
    || typeof result.transcript !== "string" || !Array.isArray(result.words) || result.words.length > 1000) return false;
  const score = (value) => value == null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
  if (!["pronunciationScore", "accuracyScore", "fluencyScore", "completenessScore", "prosodyScore"].every((key) => score(result[key]))) return false;
  // Acoustic assessment must provide a pronunciation score and word-level evidence.
  return result.pronunciationScore != null && result.words.length > 0 && result.words.length <= 200
    && result.words.some((word) => word.phonemes?.some((phoneme) => phoneme.accuracyScore != null))
    && result.words.every((word) =>
    typeof word.word === "string" && word.word.length > 0 && word.word.length <= 200 && score(word.accuracyScore)
    && Array.isArray(word.phonemes) && word.phonemes.length <= 80
    && word.phonemes.every((phoneme) => typeof phoneme.phoneme === "string" && phoneme.phoneme.length > 0 && phoneme.phoneme.length <= 80 && score(phoneme.accuracyScore)));
}
