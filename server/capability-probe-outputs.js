const MiB = 1024 * 1024;
export const PROBE_OUTPUT_TYPES = Object.freeze({
  primary_image: ["image/png"], primary_audio: ["audio/flac", "audio/x-flac", "audio/wav"],
  manifest_json: ["application/json"], tracks_jsonl: ["application/x-ndjson"], mask_archive: ["application/zip"],
  transcript_json: ["application/json"], analysis_json: ["application/json"],
  pose_tracks_jsonl: ["application/x-ndjson"], person_layers_archive: ["application/zip"],
});
const LIMITS = { primary_image: 20 * MiB, primary_audio: 64 * MiB, manifest_json: MiB, tracks_jsonl: 4 * MiB,
  mask_archive: 32 * MiB, transcript_json: MiB, analysis_json: MiB, pose_tracks_jsonl: 4 * MiB, person_layers_archive: 32 * MiB };
function fail() { throw Object.assign(new Error("自动验收输出角色、数量或大小不符合服务端固定合同"), { code: "VERIFICATION_OUTPUT_INVALID", status: 400 }); }
export function normalizeProbeOutputRules(rules, probeKind) {
  if (rules === undefined) {
    const preset = { image: ["primary_image", ["image/png"], 20 * MiB], tts: ["primary_audio", ["audio/wav"], 32 * MiB],
      music: ["primary_audio", ["audio/flac", "audio/x-flac"], 64 * MiB] }[probeKind];
    rules = preset ? [{ role: preset[0], content_types: preset[1], max_bytes: preset[2], min_count: 1, max_count: 1 }] : [];
  }
  if (!Array.isArray(rules) || rules.length > 4) fail();
  const normalized = rules.map((rule) => {
    if (!rule || !Object.hasOwn(PROBE_OUTPUT_TYPES, rule.role) || !Array.isArray(rule.content_types) || !rule.content_types.length
      || new Set(rule.content_types).size !== rule.content_types.length || rule.content_types.some((type) => !PROBE_OUTPUT_TYPES[rule.role].includes(type))
      || !Number.isSafeInteger(rule.max_bytes) || rule.max_bytes < 1 || rule.max_bytes > LIMITS[rule.role]
      || ![0, 1].includes(rule.min_count) || rule.max_count !== 1) fail();
    return { role: rule.role, content_types: [...rule.content_types], max_bytes: rule.max_bytes, min_count: rule.min_count, max_count: 1 };
  });
  if (new Set(normalized.map((rule) => rule.role)).size !== normalized.length
    || normalized.reduce((sum, rule) => sum + rule.max_bytes, 0) > 64 * MiB) fail();
  return normalized;
}
export function validateProbeOutputDescriptor(challenge, output) {
  const rules = normalizeProbeOutputRules(challenge.probeOutputRules, challenge.probeKind);
  const rule = rules.find((item) => item.role === output.role);
  const type = output.content_type ?? output.contentType;
  if (!rule || !rule.content_types.includes(type) || !Number.isSafeInteger(output.bytes) || output.bytes < 1 || output.bytes > rule.max_bytes) fail();
  return rule;
}
export function validateProbeOutputSet(challenge, outputs) {
  const rules = normalizeProbeOutputRules(challenge.probeOutputRules, challenge.probeKind);
  if (!Array.isArray(outputs) || outputs.length > 4) fail();
  for (const output of outputs) validateProbeOutputDescriptor(challenge, output);
  for (const rule of rules) {
    const count = outputs.filter((output) => output.role === rule.role).length;
    if (count < rule.min_count || count > rule.max_count) fail();
  }
  return true;
}
