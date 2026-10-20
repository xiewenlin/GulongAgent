import { createHash } from "node:crypto";

// LOCAL REVIEW DRAFT ONLY. No runtime import, route, grant, model invocation,
// database access or configurable activation switch. A predicted artifact is
// deliberately NOT an authorization scope. Wiring awaits actual installation.
const parameters = Object.freeze({
  prompt: "A clear solo singing voice, simple gentle accompaniment, sing the complete lyrics exactly once.",
  lyrics: "Blue sky, silver river.\ntwo, zero, three, three.",
  duration_seconds: 12,
  sample_rate: 44100,
  output_format: "flac",
  language: "auto",
  seed: 716491643,
});
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const parametersSha256 = createHash("sha256").update(canonical(parameters)).digest("hex");
const origin = Object.freeze({
  kind: "human-approved-fixed-regression-case",
  source_request_id: "254ab592-da1a-4738-afcd-05a2312c530d",
  source_challenge_id: "gcv_626fd91d-e00e-4c36-93ea-18a0bd98b8bd",
  source_artifact_sha256: "554a6c84d242aadb9e5df18b0dff5f24298ccc3a0ed35fb7f25c97ac0801c281",
  parameters_sha256: parametersSha256,
});

/** Pure server-owned vector construction, NOT permission to issue a challenge. */
export function buildFixedNativeMusicRegressionCase() {
  return {
    probe: {
      probeKind: "native-music", outputUploadRequired: true,
      parameters: { ...parameters },
      budget: { max_inferences: 1, max_output_tokens: 0, max_audio_seconds: 12, max_asr_passes: 1 },
      outputRules: [{ role: "primary_audio", content_types: ["audio/flac"], max_bytes: 64 * 1024 * 1024, min_count: 1, max_count: 1 }],
    },
    audit_origin: { ...origin },
  };
}

/** No coercion, lyric normalisation, tags, hints, or caller-supplied overrides. */
export function matchesFixedNativeMusicParameters(candidate) {
  try { return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    && canonical(candidate) === canonical(parameters); }
  catch { return false; }
}

export function fixedNativeMusicActivationPlan() {
  return {
    state: "draft_not_active", authorization_id: null, artifact_sha256: null, matrix_sha256: null,
    valid_from: null, expires_at: null, routable: false, grants_admission: false,
    hard_limit: 1, ordinary_fallback: false, resets_original_budgets: false,
    audit_origin: { ...origin },
    required_before_activation: [
      "exact-frozen-package-and-installed-artifact", "complete-raw-per-capability-inventory",
      "verified-current-binding-node-group", "direct-human-fixed-case-authorization",
      "bounded-exact-UTC-window", "new-independent-CAS-ledger-and-original-request-recovery",
      "new-artifact-ordinary-fallback-denied", "unchanged-v1-media-and-whole-ASR-validation",
      "no-cross-artifact-evidence-inheritance",
    ],
  };
}
