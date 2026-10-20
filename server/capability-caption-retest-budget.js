import { createHash } from "node:crypto";
import { createCapabilityReleaseVerificationBudget } from "./capability-release-verification-budget.js";

export const CAPTION_RETEST_COLLECTION = "capabilityVerificationCaptionRetests";
const canonical = (v) => JSON.stringify(v, (_, i) => i && typeof i === "object" && !Array.isArray(i)
  ? Object.fromEntries(Object.keys(i).sort().map(k => [k, i[k]])) : i);
const hash = v => createHash("sha256").update(canonical(v)).digest("hex");
const SPEC = Object.freeze({ id: "gvc_20261020_554a_native_caption_once", policy: "native-caption-single-retest-v1",
  artifactSha256: "554a6c84d242aadb9e5df18b0dff5f24298ccc3a0ed35fb7f25c97ac0801c281",
  scopeSha256: "3c3387e78c5bc74a32c756aba9588c6bb662d5ce98773e057eabb27fcfdffaee",
  capabilityId: "minimax_music_3.generate", capabilityVersion: "3",
  matrixSha256: "d51904c977101f0053922293f850a9f4ca731e8f88c3e5e86fa71488693ae3ae",
  captionSha256: "ec1937622efdfc66e3eeda1d2274fa83d13b8d22b469f280e610ac42b8ccef1f",
  totalLimit: 1, validFrom: "2026-10-20T06:40:00.000Z", expiresAt: "2026-10-20T14:40:00.000Z",
  authorization: { source: "human-explicit-one-additional-attempt", threadId: "01a07627-9f49-7760-a1b0-ae21244c5c0a",
    turnId: "01a157af-2599-7251-8f0b-02e9c807f8b9", messageId: "01a15809-d60f-7223-a15e-0b4fba0a1d57",
    replySha256: "26e4475b4a11a9dab49256294605503c9ce274520a3bcabe21a89e34f0fa59c5" },
});
const specSha256 = hash(SPEC);
const scopeHash = b => hash([String(b?._id), b?.nodeId, SPEC.artifactSha256, b?.computeGroupId || null]);
const bindingMatches = b => scopeHash(b) === SPEC.scopeSha256 && b.autoVerificationPolicy === "capability-v2"
  && b.autoVerificationCapabilityIds?.includes(SPEC.capabilityId);
function exactCandidate(b, row) {
  const inv = row?.inventory;
  if (!bindingMatches(b) || !inv || row.bindingId !== String(b._id) || row.nodeId !== b.nodeId
    || (row.computeGroupId || null) !== (b.computeGroupId || null) || !row.inventoryEnabled || inv.enabled !== true
    || row.capabilityId !== SPEC.capabilityId || row.capabilityVersion !== SPEC.capabilityVersion
    || row.artifactSha256 !== SPEC.artifactSha256 || row.matrixSha256 !== SPEC.matrixSha256 || inv.matrixSha256 !== SPEC.matrixSha256) return false;
  const { capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages } = inv;
  return hash({ capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages }) === SPEC.matrixSha256
    && models.length === 1 && canonical(row.model) === canonical(models[0]);
}
function validDocument(doc) {
  if (!doc) return true;
  try { return doc.specSha256 === specSha256 && hash(doc.spec) === specSha256 && hash(doc.authorization) === hash(SPEC.authorization)
    && doc.state === "active" && hash([doc.scope.bindingId, doc.scope.nodeId, doc.scope.artifactSha256, doc.scope.computeGroupId || null]) === SPEC.scopeSha256
    && +new Date(doc.validFrom) === +new Date(SPEC.validFrom) && +new Date(doc.expiresAt) === +new Date(SPEC.expiresAt)
    && [0,1].includes(doc.usedTotal) && (doc.usedTotal === 0 ? doc.consumption === null
      : doc.consumption?.capabilityId === SPEC.capabilityId && doc.consumption.artifactSha256 === SPEC.artifactSha256
        && doc.consumption.matrixSha256 === SPEC.matrixSha256 && doc.consumption.captionSha256 === SPEC.captionSha256
        && doc.consumption.unit === 1 && /^[a-f0-9]{64}$/.test(doc.consumption.verificationId || "")); }
  catch { return false; }
}
export function createCapabilityCaptionRetestBudget({ getCollection, now = () => new Date() }) {
  const originalBudget = createCapabilityReleaseVerificationBudget({ getCollection, now });
  const inWindow = () => +new Date(now()) >= +new Date(SPEC.validFrom) && +new Date(now()) < +new Date(SPEC.expiresAt);
  const matchesProbe = probe => typeof probe?.parameters?.prompt === "string" && hash(probe.parameters.prompt) === SPEC.captionSha256;
  async function available({ binding, candidate, controlled }) {
    if (controlled !== true || !inWindow() || !exactCandidate(binding, candidate)) return false;
    const row = await (await getCollection("capabilityAutoVerifications")).findOne({ _id: candidate._id });
    if (!row || !exactCandidate(binding, row)) return false;
    const original = await originalBudget.status({ binding });
    if (!["available","exhausted"].includes(original.state)
      || original.capabilities?.find(c => c.capability_id === SPEC.capabilityId)?.used !== 3) return false;
    const doc = await (await getCollection(CAPTION_RETEST_COLLECTION)).findOne({ _id: SPEC.id });
    return validDocument(doc) && (!doc || doc.usedTotal === 0);
  }
  async function reserve(args) {
    if (!await available(args)) return null;
    const { binding, candidate, challengeId, requestId, requestRecordId } = args, instant = new Date(now());
    const collection = await getCollection(CAPTION_RETEST_COLLECTION);
    try { await collection.updateOne({ _id: SPEC.id }, { $setOnInsert: { spec: SPEC, specSha256, state: "active",
      scope: { bindingId: String(binding._id), nodeId: binding.nodeId, artifactSha256: SPEC.artifactSha256, computeGroupId: binding.computeGroupId || null },
      authorization: SPEC.authorization, validFrom: new Date(SPEC.validFrom), expiresAt: new Date(SPEC.expiresAt),
      usedTotal: 0, consumption: null, createdAt: instant, updatedAt: instant } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    if (!validDocument(await collection.findOne({ _id: SPEC.id }))) return null;
    const reservedAt = new Date(now()), consumption = { challengeId, requestId, requestRecordId, verificationId: candidate._id,
      capabilityId: SPEC.capabilityId, artifactSha256: SPEC.artifactSha256, matrixSha256: SPEC.matrixSha256,
      captionSha256: SPEC.captionSha256, unit: 1, reservedAt };
    const result = await collection.findOneAndUpdate({ _id: SPEC.id, state: "active", specSha256, usedTotal: 0, consumption: null,
      validFrom: { $lte: reservedAt }, expiresAt: { $gt: reservedAt } },
    { $inc: { usedTotal: 1 }, $set: { consumption, updatedAt: reservedAt } }, { returnDocument: "after" });
    const saved = result && Object.hasOwn(result, "value") ? result.value : result;
    return saved ? { authorizationId: SPEC.id, consumptionId: hash(challengeId), reservedAt, captionSha256: SPEC.captionSha256 } : null;
  }
  async function status({ binding }) {
    if (!bindingMatches(binding)) return { policy: SPEC.policy, applicable: false, state: "not_applicable" };
    const doc = await (await getCollection(CAPTION_RETEST_COLLECTION)).findOne({ _id: SPEC.id });
    const rows = await (await getCollection("capabilityAutoVerifications")).find({ bindingId: String(binding._id), artifactSha256: SPEC.artifactSha256,
      capabilityId: SPEC.capabilityId }).limit(8).toArray();
    const ready = rows.some(r => exactCandidate(binding,r)), valid = validDocument(doc), open = inWindow() && valid;
    const original = await originalBudget.status({ binding });
    const originalSpent = ["available","exhausted"].includes(original.state)
      && original.capabilities?.find(c => c.capability_id === SPEC.capabilityId)?.used === 3;
    const used = doc?.usedTotal || 0;
    return { policy: SPEC.policy, applicable: true, authorization_id: SPEC.id, artifact_sha256: SPEC.artifactSha256,
      caption_sha256: SPEC.captionSha256, valid_from: SPEC.validFrom, expires_at: SPEC.expiresAt, inventory_ready: ready,
      state: !inWindow() ? "expired" : !valid ? "unavailable" : used === 1 ? "exhausted" : !ready ? "awaiting_inventory" : !originalSpent ? "awaiting_original_budget" : "available",
      total: { limit: 1, used, remaining: open ? 1-used : 0 },
      capabilities: [{ capability_id: SPEC.capabilityId, limit: 1, used, remaining: open ? 1-used : 0 }],
      consumption: valid && doc?.consumption ? { request_id: doc.consumption.requestId, challenge_id: doc.consumption.challengeId, reserved_at: doc.consumption.reservedAt } : null,
      ordinary_fallback: false, resets_original_budgets: false, grants_admission: false };
  }
  return { available, reserve, status, matchesProbe };
}
