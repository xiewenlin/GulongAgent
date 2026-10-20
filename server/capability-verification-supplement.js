import { createHash } from "node:crypto";

export const SUPPLEMENT_COLLECTION = "capabilityVerificationSupplementBudgets";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CAPABILITIES = Object.freeze({ "gulong_engine.music": "generic_music", "minimax_music_3.generate": "native_music3" });
// One release-reviewed human authorization, not an environment/admin quota knob.
// The public source contains a scope digest, not the account/node identifiers.
const SPEC = Object.freeze({
  id: "gvs_20261020_music_f8_once", policy: "release-scoped-music-retest-v1",
  scopeSha256: "56bd4c403cd051fb91ff50681525c2971edeba5329f818861a2b9495987da7cf",
  artifactSha256: "f8bb182e7059eefe075567f37617324e4105dbfd81426c1cc82a44ef9355c27d",
  validFrom: "2026-10-20T00:00:00.000Z", expiresAt: "2026-10-21T00:00:00.000Z",
  totalLimit: 6, perCapabilityLimit: 3, capabilities: Object.keys(CAPABILITIES),
  authorization: { source: "human-request-in-thread", threadId: "01a07627-9f49-7760-a1b0-ae21244c5c0a",
    turnId: "01a1570f-de1a-7650-b777-e408605878ad",
    requestSha256: "64c439ca25027631654cd5f0a885950f61119958ab96f5b5e0605a10a140f9f4" },
});
const specSha256 = hash(SPEC);
function scopeHash(binding, artifact = SPEC.artifactSha256) {
  return hash([String(binding?._id), binding?.nodeId, artifact, binding?.computeGroupId || null]);
}
function validDocument(document) {
  if (!document) return true;
  try {
  if (document.specSha256 !== specSha256 || hash(document.spec) !== specSha256
    || hash(document.authorization) !== hash(SPEC.authorization) || document.state !== "active"
    || hash([document.scope?.bindingId, document.scope?.nodeId, document.scope?.artifactSha256, document.scope?.computeGroupId || null]) !== SPEC.scopeSha256
    || +new Date(document.validFrom) !== +new Date(SPEC.validFrom) || +new Date(document.expiresAt) !== +new Date(SPEC.expiresAt)
    || !Number.isSafeInteger(document.usedTotal) || document.usedTotal < 0 || document.usedTotal > SPEC.totalLimit
    || !document.consumptions || typeof document.consumptions !== "object" || Array.isArray(document.consumptions)) return false;
  const entries = Object.entries(document.consumptions);
  if (entries.length !== document.usedTotal || Object.keys(document.usedByCapability || {}).length !== 2) return false;
  return Object.entries(CAPABILITIES).every(([capability, key]) => {
    const count = document.usedByCapability?.[key];
    return Number.isSafeInteger(count) && count >= 0 && count <= SPEC.perCapabilityLimit
      && entries.filter(([, entry]) => entry.capabilityId === capability).length === count;
  }) && entries.every(([key, entry]) => key === hash(entry.challengeId) && CAPABILITIES[entry.capabilityId]
    && entry.artifactSha256 === SPEC.artifactSha256 && entry.unit === 1 && /^[a-f0-9]{64}$/.test(entry.verificationId || ""));
  } catch { return false; }
}

export function createCapabilityVerificationSupplement({ getCollection, now = () => new Date() }) {
  const inWindow = () => +new Date(now()) >= +new Date(SPEC.validFrom) && +new Date(now()) < +new Date(SPEC.expiresAt);
  function matches(binding, candidate, controlled) {
    return controlled === true && inWindow() && scopeHash(binding, candidate?.artifactSha256) === SPEC.scopeSha256
      && candidate?.artifactSha256 === SPEC.artifactSha256 && candidate?.model?.id === "MiniMax-Music3"
      && Object.hasOwn(CAPABILITIES, candidate.capabilityId) && binding.autoVerificationPolicy === "capability-v2"
      && binding.autoVerificationCapabilityIds?.includes(candidate.capabilityId);
  }
  async function available({ binding, candidate, controlled }) {
    if (!matches(binding, candidate, controlled)) return false;
    const doc = await (await getCollection(SUPPLEMENT_COLLECTION)).findOne({ _id: SPEC.id });
    return validDocument(doc) && (!doc || doc.usedTotal < SPEC.totalLimit
      && doc.usedByCapability[CAPABILITIES[candidate.capabilityId]] < SPEC.perCapabilityLimit);
  }
  async function reserve({ binding, candidate, controlled, challengeId, requestId, requestRecordId }) {
    if (!matches(binding, candidate, controlled)) return null;
    const collection = await getCollection(SUPPLEMENT_COLLECTION), instant = new Date(now());
    try { await collection.updateOne({ _id: SPEC.id }, { $setOnInsert: { spec: SPEC, specSha256, state: "active",
      scope: { bindingId: String(binding._id), nodeId: binding.nodeId, artifactSha256: SPEC.artifactSha256, computeGroupId: binding.computeGroupId || null },
      authorization: SPEC.authorization, validFrom: new Date(SPEC.validFrom), expiresAt: new Date(SPEC.expiresAt),
      usedTotal: 0, usedByCapability: { generic_music: 0, native_music3: 0 }, consumptions: {}, createdAt: instant, updatedAt: instant } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const document = await collection.findOne({ _id: SPEC.id });
    if (!validDocument(document) || !matches(binding, candidate, controlled)) return null;
    const key = hash(challengeId), capabilityKey = CAPABILITIES[candidate.capabilityId], reservedAt = new Date(now());
    const receipt = { challengeId, requestId, requestRecordId, verificationId: candidate._id,
      capabilityId: candidate.capabilityId, artifactSha256: candidate.artifactSha256, unit: 1, reservedAt };
    // One Mongo CAS bounds both caps and appends the immutable consumption ledger.
    // Preparation failures stay spent and are explained by the original journal;
    // no refund/reset can make an uncertain attempt execute twice.
    const result = await collection.findOneAndUpdate({ _id: SPEC.id, specSha256, state: "active",
      validFrom: { $lte: reservedAt }, expiresAt: { $gt: reservedAt }, usedTotal: { $lt: SPEC.totalLimit },
      [`usedByCapability.${capabilityKey}`]: { $lt: SPEC.perCapabilityLimit }, [`consumptions.${key}`]: { $exists: false } },
    { $inc: { usedTotal: 1, [`usedByCapability.${capabilityKey}`]: 1 },
      $set: { [`consumptions.${key}`]: receipt, updatedAt: reservedAt } }, { returnDocument: "after" });
    const saved = result && Object.hasOwn(result, "value") ? result.value : result;
    return saved ? { authorizationId: SPEC.id, consumptionId: key, reservedAt } : null;
  }
  async function status({ binding }) {
    const applicable = scopeHash(binding) === SPEC.scopeSha256 && binding.autoVerificationPolicy === "capability-v2";
    if (!applicable) return { policy: SPEC.policy, applicable: false, state: "not_applicable" };
    const document = await (await getCollection(SUPPLEMENT_COLLECTION)).findOne({ _id: SPEC.id });
    const valid = validDocument(document), open = inWindow() && valid;
    const used = document?.usedTotal || 0;
    return { policy: SPEC.policy, applicable: true, authorization_id: SPEC.id, artifact_sha256: SPEC.artifactSha256,
      valid_from: SPEC.validFrom, expires_at: SPEC.expiresAt,
      state: !inWindow() ? "expired" : !valid ? "unavailable" : used >= SPEC.totalLimit ? "exhausted" : "available",
      total: { limit: SPEC.totalLimit, used, remaining: open ? Math.max(0, SPEC.totalLimit - used) : 0 },
      capabilities: Object.entries(CAPABILITIES).map(([capability, key]) => ({ capability_id: capability,
        limit: SPEC.perCapabilityLimit, used: document?.usedByCapability?.[key] || 0,
        remaining: open ? Math.max(0, SPEC.perCapabilityLimit - (document?.usedByCapability?.[key] || 0)) : 0 })),
      consumptions: valid ? Object.values(document?.consumptions || {}).map((entry) => ({
        challenge_id: entry.challengeId, request_id: entry.requestId, capability_id: entry.capabilityId, reserved_at: entry.reservedAt })) : [],
      resets_ordinary_budget: false, grants_admission: false };
  }
  return { available, reserve, status };
}
