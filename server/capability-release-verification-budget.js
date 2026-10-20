import { createHash } from "node:crypto";

// A single reviewed release, not a caller/admin/environment-configurable grant.
export const RELEASE_VERIFICATION_COLLECTION = "capabilityVerificationReleaseBudgets";
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const scopeHash = (binding, artifact) => hash([String(binding?._id), binding?.nodeId, artifact, binding?.computeGroupId || null]);
const CAPS = Object.freeze({
  "gulong_engine.agent_chat": { key: "chat", limit: 1, matrix: "d0dcc6a8d7c99a9d629b8609c6d93b48f8e0a859d33996eb79fe057bce5b6465" },
  "gulong_engine.embedding": { key: "embedding", limit: 1, matrix: "ea8634c96767a2c43fc016664b5672b3b34249b554c92ccc7af5f9d254ece335" },
  "sam.video_track": { key: "sam", limit: 1, matrix: "caf76c97778d75ddb00202712c027c3f12143bc512968041feb928d767f123ef" },
  "mediapipe.video_analysis": { key: "mediapipe", limit: 1, matrix: "9a19ce8e35ee802637dd71ca9b44509114f67b56e5f80b6189d9c90075da631a" },
  "whisper.transcribe": { key: "whisper", limit: 1, matrix: "4e23bd7550e519d6ff4122cecd6927251ca3bf7a5e6858af9ae89903ea171059" },
  "gulong_engine.music": { key: "generic_music", limit: 3, matrix: "2682282e2bf7ab3479a269357c605b1788eebd7fdfaf71c2c988865f9f2fc31f" },
  "minimax_music_3.generate": { key: "native_music3", limit: 3, matrix: "d51904c977101f0053922293f850a9f4ca731e8f88c3e5e86fa71488693ae3ae" },
});
const SPEC = Object.freeze({
  id: "gvr_20261020_554a_once", policy: "release-scoped-seven-capability-reverification-v1",
  artifactSha256: "554a6c84d242aadb9e5df18b0dff5f24298ccc3a0ed35fb7f25c97ac0801c281",
  scopeSha256: "3c3387e78c5bc74a32c756aba9588c6bb662d5ce98773e057eabb27fcfdffaee",
  validFrom: "2026-10-20T05:45:00.000Z", expiresAt: "2026-10-21T05:45:00.000Z",
  totalLimit: 11, capabilities: CAPS,
  authorization: { source: "human-request-in-thread", threadId: "01a07627-9f49-7760-a1b0-ae21244c5c0a",
    turnId: "01a157af-2599-7251-8f0b-02e9c807f8b9",
    requestSha256: "5b637a74496eba08852078d609e07f05a6c654d10960b846b8d3d000a3220418" },
});
const specSha256 = hash(SPEC);
const applies = (candidate) => candidate?.artifactSha256 === SPEC.artifactSha256;
function scopeMatches(binding) {
  return scopeHash(binding, SPEC.artifactSha256) === SPEC.scopeSha256 && binding?.autoVerificationPolicy === "capability-v2";
}
function exactCandidate(binding, candidate) {
  const cap = CAPS[candidate?.capabilityId], inv = candidate?.inventory;
  if (!scopeMatches(binding) || !applies(candidate) || !cap || !inv || inv.enabled !== true || candidate.inventoryEnabled !== true
    || candidate.bindingId !== String(binding._id) || candidate.nodeId !== binding.nodeId
    || (candidate.computeGroupId || null) !== (binding.computeGroupId || null)
    || !binding.autoVerificationCapabilityIds?.includes(candidate.capabilityId)) return false;
  const { capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages } = inv;
  return capabilityId === candidate.capabilityId && artifactSha256 === SPEC.artifactSha256
    && candidate.matrixSha256 === cap.matrix && inv.matrixSha256 === cap.matrix
    && hash({ capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages }) === cap.matrix
    && models.length === 1 && canonical(candidate.model) === canonical(models[0]);
}
function validDocument(doc) {
  if (!doc) return true;
  try {
    if (doc.specSha256 !== specSha256 || hash(doc.spec) !== specSha256 || hash(doc.authorization) !== hash(SPEC.authorization)
      || doc.state !== "active" || scopeHash({ _id: doc.scope?.bindingId, nodeId: doc.scope?.nodeId, computeGroupId: doc.scope?.computeGroupId }, doc.scope?.artifactSha256) !== SPEC.scopeSha256
      || +new Date(doc.validFrom) !== +new Date(SPEC.validFrom) || +new Date(doc.expiresAt) !== +new Date(SPEC.expiresAt)
      || !Number.isSafeInteger(doc.usedTotal) || doc.usedTotal < 0 || doc.usedTotal > SPEC.totalLimit
      || !doc.consumptions || typeof doc.consumptions !== "object" || Array.isArray(doc.consumptions)) return false;
    const entries = Object.entries(doc.consumptions);
    return entries.length === doc.usedTotal && Object.keys(doc.usedByCapability || {}).length === 7
      && Object.entries(CAPS).every(([id, cap]) => Number.isSafeInteger(doc.usedByCapability[cap.key])
        && doc.usedByCapability[cap.key] >= 0 && doc.usedByCapability[cap.key] <= cap.limit
        && entries.filter(([, entry]) => entry.capabilityId === id).length === doc.usedByCapability[cap.key])
      && entries.every(([key, entry]) => key === hash(entry.challengeId) && CAPS[entry.capabilityId]
        && entry.matrixSha256 === CAPS[entry.capabilityId].matrix && entry.artifactSha256 === SPEC.artifactSha256
        && entry.unit === 1 && /^[a-f0-9]{64}$/.test(entry.verificationId || ""));
  } catch { return false; }
}
export function createCapabilityReleaseVerificationBudget({ getCollection, now = () => new Date() }) {
  const inWindow = () => +new Date(now()) >= +new Date(SPEC.validFrom) && +new Date(now()) < +new Date(SPEC.expiresAt);
  async function available({ binding, candidate, controlled }) {
    if (controlled !== true || !inWindow() || !exactCandidate(binding, candidate)) return false;
    // Only inventory actually reported into this new artifact's own model row may consume.
    const row = await (await getCollection("capabilityAutoVerifications")).findOne({ _id: candidate._id });
    if (!row || !exactCandidate(binding, row)) return false;
    const doc = await (await getCollection(RELEASE_VERIFICATION_COLLECTION)).findOne({ _id: SPEC.id });
    return validDocument(doc) && (!doc || doc.usedTotal < SPEC.totalLimit && doc.usedByCapability[CAPS[candidate.capabilityId].key] < CAPS[candidate.capabilityId].limit);
  }
  async function reserve(args) {
    if (!await available(args)) return null;
    const { binding, candidate, challengeId, requestId, requestRecordId } = args;
    const collection = await getCollection(RELEASE_VERIFICATION_COLLECTION), instant = new Date(now());
    try { await collection.updateOne({ _id: SPEC.id }, { $setOnInsert: { spec: SPEC, specSha256, state: "active",
      scope: { bindingId: String(binding._id), nodeId: binding.nodeId, computeGroupId: binding.computeGroupId || null, artifactSha256: SPEC.artifactSha256 },
      authorization: SPEC.authorization, validFrom: new Date(SPEC.validFrom), expiresAt: new Date(SPEC.expiresAt),
      usedTotal: 0, usedByCapability: Object.fromEntries(Object.values(CAPS).map((cap) => [cap.key, 0])), consumptions: {}, createdAt: instant, updatedAt: instant } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const doc = await collection.findOne({ _id: SPEC.id });
    if (!validDocument(doc) || !inWindow()) return null;
    const key = hash(challengeId), cap = CAPS[candidate.capabilityId], reservedAt = new Date(now());
    const receipt = { challengeId, requestId, requestRecordId, verificationId: candidate._id, capabilityId: candidate.capabilityId,
      matrixSha256: candidate.matrixSha256, artifactSha256: SPEC.artifactSha256, unit: 1, reservedAt };
    const result = await collection.findOneAndUpdate({ _id: SPEC.id, state: "active", specSha256,
      validFrom: { $lte: reservedAt }, expiresAt: { $gt: reservedAt }, usedTotal: { $lt: SPEC.totalLimit },
      [`usedByCapability.${cap.key}`]: { $lt: cap.limit }, [`consumptions.${key}`]: { $exists: false } },
    { $inc: { usedTotal: 1, [`usedByCapability.${cap.key}`]: 1 }, $set: { [`consumptions.${key}`]: receipt, updatedAt: reservedAt } }, { returnDocument: "after" });
    const saved = result && Object.hasOwn(result, "value") ? result.value : result;
    return saved ? { authorizationId: SPEC.id, consumptionId: key, reservedAt } : null;
  }
  async function status({ binding }) {
    if (!scopeMatches(binding)) return { policy: SPEC.policy, applicable: false, state: "not_applicable" };
    const doc = await (await getCollection(RELEASE_VERIFICATION_COLLECTION)).findOne({ _id: SPEC.id });
    const rows = await (await getCollection("capabilityAutoVerifications")).find({ bindingId: String(binding._id), artifactSha256: SPEC.artifactSha256 }).limit(32).toArray();
    const ready = Object.keys(CAPS).every((id) => rows.some((row) => row.capabilityId === id && exactCandidate(binding, row)));
    const valid = validDocument(doc), open = inWindow() && valid, used = doc?.usedTotal || 0;
    return { policy: SPEC.policy, applicable: true, authorization_id: SPEC.id, artifact_sha256: SPEC.artifactSha256,
      valid_from: SPEC.validFrom, expires_at: SPEC.expiresAt, inventory_ready: ready,
      state: !inWindow() ? "expired" : !valid ? "unavailable" : used >= SPEC.totalLimit ? "exhausted" : !ready ? "awaiting_inventory" : "available",
      total: { limit: SPEC.totalLimit, used, remaining: open ? SPEC.totalLimit - used : 0 },
      capabilities: Object.entries(CAPS).map(([id, cap]) => ({ capability_id: id, matrix_sha256: cap.matrix, limit: cap.limit,
        used: doc?.usedByCapability?.[cap.key] || 0, remaining: open ? cap.limit - (doc?.usedByCapability?.[cap.key] || 0) : 0 })),
      ordinary_fallback: false, resets_ordinary_budget: false, grants_admission: false };
  }
  return { applies, available, reserve, status };
}
