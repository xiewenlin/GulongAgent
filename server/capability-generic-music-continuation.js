import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

export const GENERIC_MUSIC_CONTINUATION_COLLECTION = "capabilityVerificationGenericMusicContinuations";
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const SPEC = {
  id: "gvm_20261020_1829_generic_until_pass", epoch: "20261020-human-generic-only-v1", bindingId: "6ab71678e4859d7255789e08",
  policy: "generic-music-three-at-a-time-until-pass-v1", capabilityId: "gulong_engine.music",
  artifactSha256: "1829a188caee1e3bca564edaa0b836dd173785e7ffda7363cd7a27a7d9cf1ccb",
  matrixSha256: "f565786022f87dd38ce6d893e0208650977dc7ce45fd92b5e11679ac2a7461af",
  scopeSha256: "f7fb77ad7bbea3dc0c193345dcde8b1b58bd56faa2f8ccbe2f418b6f348b90bf",
  batchSize: 3, safetyMaxAttempts: 126, expiresAt: "2026-10-21T14:30:00.000Z",
  sourceRequestId: "0bf14094-7f29-4e16-8e65-fe6244b772ca",
  sourceChallengeId: "gcv_544da053-eb9b-43f7-9fef-092c5f955c75",
  authorization: { source: "direct-human-until-generic-pass", threadId: "01a07627-9f49-7760-a1b0-ae21244c5c0a",
    turnId: "01a159aa-4e6e-7a30-b764-942e0491b314", messageId: "01a159bc-19d5-7643-9a8f-3648714f5635" },
};
const specSha256 = hash(SPEC), cap = SPEC.capabilityId;
const matchesBinding = binding => binding?.status === "active" && !binding.revokedAt && binding.autoVerificationPolicy === "capability-v2"
  && hash([String(binding._id), binding.nodeId, SPEC.artifactSha256, binding.computeGroupId || null]) === SPEC.scopeSha256;
function exact(binding, row) {
  const inv = row?.inventory;
  if (!matchesBinding(binding) || !binding.autoVerificationCapabilityIds?.includes(cap) || row?.capabilityId !== cap || !inv
    || row.bindingId !== String(binding._id) || row.userId !== String(binding.userId) || row.nodeId !== binding.nodeId
    || (row.computeGroupId || null) !== (binding.computeGroupId || null) || !row.inventoryEnabled || inv.enabled !== true
    || row.artifactSha256 !== SPEC.artifactSha256 || row.matrixSha256 !== SPEC.matrixSha256 || inv.matrixSha256 !== SPEC.matrixSha256) return false;
  const { capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages } = inv;
  return hash({ capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages }) === SPEC.matrixSha256
    && models.length === 1 && canonical(row.model) === canonical(models[0]);
}
function valid(doc) {
  try {
    const entries = Object.entries(doc.consumptions || {});
    return doc.specSha256 === specSha256 && hash(doc.spec) === specSha256 && ["active", "passed", "revoked"].includes(doc.state)
      && matchesBinding({ ...doc.scope, _id: doc.scope.bindingId, status: "active", autoVerificationPolicy: "capability-v2" })
      && +new Date(doc.expiresAt) === +new Date(SPEC.expiresAt) && Number.isFinite(+new Date(doc.readyAt))
      && +new Date(doc.readyAt) < +new Date(doc.expiresAt)
      && Number.isSafeInteger(doc.usedTotal) && doc.usedTotal >= 0 && doc.usedTotal <= SPEC.safetyMaxAttempts
      && Number.isSafeInteger(doc.issuedTotal) && doc.issuedTotal >= 3 && doc.issuedTotal <= SPEC.safetyMaxAttempts
      && doc.issuedTotal % 3 === 0 && doc.usedTotal <= doc.issuedTotal && entries.length === doc.usedTotal
      && entries.every(([key, value]) => key === hash(value.challengeId) && value.unit === 1 && value.capabilityId === cap
        && value.artifactSha256 === SPEC.artifactSha256 && value.matrixSha256 === SPEC.matrixSha256)
      && (doc.usedTotal === 0 ? doc.lastChallengeId === null : entries.some(([, value]) => value.challengeId === doc.lastChallengeId));
  } catch { return false; }
}
export function createGenericMusicContinuationBudget({ getCollection, now = () => new Date() }) {
  const collection = () => getCollection(GENERIC_MUSIC_CONTINUATION_COLLECTION);
  async function baseline(binding) {
    if (!matchesBinding(binding)) return false;
    const actual = await (await getCollection("nodeAccountBindings")).findOne({ _id: new ObjectId(binding._id), status: "active", revokedAt: null });
    if (!matchesBinding(actual) || String(actual.userId) !== String(binding.userId)) return false;
    const parent = await (await getCollection("capabilityVerificationConditionalSixBudgets")).findOne({ _id: "gvs_20261020_1829_after_fixed_six" });
    const original = Object.values(parent?.consumptions || {}).find(value => value.capabilityId === cap);
    if (parent?.state !== "active" || parent.usedTotal !== 6 || Object.keys(parent.consumptions || {}).length !== 6
      || canonical(parent.usedByCapability) !== canonical({ chat: 1, embedding: 1, music: 1, sam: 1, mediapipe: 1, whisper: 1 })
      || original?.requestId !== SPEC.sourceRequestId || original.challengeId !== SPEC.sourceChallengeId) return false;
    const journal = await (await getCollection("capabilityVerificationChallenges")).findOne({ requestId: SPEC.sourceRequestId,
      challengeId: SPEC.sourceChallengeId, bindingId: String(binding._id), status: "failed", budgetSource: "conditional_six_after_fixed" });
    return journal?.error?.code === "VERIFICATION_AUDIO_TOO_SHORT" && journal.artifactSha256 === SPEC.artifactSha256
      && journal.matrixSha256 === SPEC.matrixSha256 && journal.featureId === original.verificationId;
  }
  async function passed(binding, row) {
    if (!exact(binding, row) || row.status !== "active" || row.fixedCaseOnly || !/^[a-f0-9]{64}$/.test(row.testEvidenceSha256 || "")
      || !/^[a-f0-9]{64}$/.test(row.resultFingerprint || "") || +new Date(row.testedAt) > +new Date(now())
      || +new Date(row.expiresAt) <= +new Date(now()) || +new Date(row.expiresAt) - +new Date(row.testedAt) > 7 * 86400_000
      || !["music_generation", "whole_audio_asr", "exact_lyrics", "exact_duration"].every(key => row.contractTests?.[key] === true)
      || row.verifiedModel?.id !== "MiniMax-Music3" || !Number.isFinite(row.verifiedModel.max_duration_seconds)
      || row.verifiedModel.max_duration_seconds < 11 || row.verifiedModel.max_duration_seconds > 12
      || !Number.isFinite(+new Date(row.testedAt)) || !Number.isFinite(+new Date(row.expiresAt))
      || row.parameters?.seconds !== 12 || canonical(row.asrLanguages) !== '["en"]') return false;
    const audit = await (await getCollection("capabilityVerificationAudits")).findOne({ action: "capability.automatic_verification_passed",
      bindingId: String(binding._id), nodeId: binding.nodeId, verificationId: row._id, challengeId: row.challengeId,
      artifactSha256: SPEC.artifactSha256, matrixSha256: SPEC.matrixSha256 });
    return Boolean(audit && canonical(audit.model) === canonical(row.verifiedModel) && /^[a-f0-9]{64}$/.test(audit.resultSha256 || ""));
  }
  async function lastFinished(binding, doc) {
    if (!doc.lastChallengeId) return true;
    const receipt = doc.consumptions[hash(doc.lastChallengeId)];
    const journal = await (await getCollection("capabilityVerificationChallenges")).findOne({ _id: receipt.requestRecordId,
      requestId: receipt.requestId, bindingId: String(binding._id), challengeId: doc.lastChallengeId });
    if (journal?.budgetSource === "generic_music_continuation" && ["failed", "invalidated", "not_issued"].includes(journal.status)) return true;
    const row = await (await getCollection("capabilityAutoVerifications")).findOne({ _id: receipt.verificationId, challengeId: doc.lastChallengeId });
    return exact(binding, row) && row.status === "failed" && row.error?.code === "VERIFICATION_LEASE_EXPIRED"
      && +new Date(row.leaseExpiresAt) <= +new Date(now());
  }
  async function inspect({ binding, candidate, controlled }) {
    if (controlled !== true || !exact(binding, candidate)) return { available: false, state: "not_applicable" };
    const doc = await (await collection()).findOne({ _id: SPEC.id });
    if (!doc) return { available: false, state: "awaiting_deployment_activation" };
    if (!valid(doc) || doc.state === "revoked") return { available: false, state: "unavailable", doc };
    if (+new Date(doc.readyAt) > +new Date(now())) return { available: false, state: "unavailable", doc };
    const row = await (await getCollection("capabilityAutoVerifications")).findOne({ _id: candidate._id });
    if (doc.state === "passed" || await passed(binding, row)) return { available: false, state: "passed", doc, row };
    if (+new Date(now()) >= +new Date(doc.expiresAt)) return { available: false, state: "expired", doc };
    if (!exact(binding, row) || !await baseline(binding)) return { available: false, state: "scope_changed", doc };
    if (doc.usedTotal >= SPEC.safetyMaxAttempts) return { available: false, state: "safety_limit", doc };
    if (!await lastFinished(binding, doc)) return { available: false, state: "in_flight", doc };
    return { available: true, state: "available", doc, row };
  }
  async function available(args) { return (await inspect(args)).available; }
  async function reserve(args) {
    const gate = await inspect(args); if (!gate.available) return null;
    const { binding, candidate, challengeId, requestId, requestRecordId } = args, { doc } = gate;
    const incrementBatch = doc.usedTotal === doc.issuedTotal, instant = new Date(now()), key = hash(challengeId);
    const receipt = { challengeId, requestId, requestRecordId, verificationId: candidate._id, capabilityId: cap,
      artifactSha256: SPEC.artifactSha256, matrixSha256: SPEC.matrixSha256, unit: 1, reservedAt: instant,
      batchNumber: Math.floor(doc.usedTotal / 3) + 1 };
    const result = await (await collection()).findOneAndUpdate({ _id: SPEC.id, specSha256, state: "active",
      usedTotal: doc.usedTotal, issuedTotal: doc.issuedTotal, lastChallengeId: doc.lastChallengeId,
      expiresAt: { $gt: instant }, [`consumptions.${key}`]: { $exists: false } },
    { $inc: { usedTotal: 1, ...(incrementBatch ? { issuedTotal: 3 } : {}) },
      $set: { [`consumptions.${key}`]: receipt, lastChallengeId: challengeId, updatedAt: instant } }, { returnDocument: "after" });
    const saved = result && Object.hasOwn(result, "value") ? result.value : result;
    if (!saved) return null;
    const live = await (await getCollection("capabilityAutoVerifications")).findOne({ _id: candidate._id });
    if (!exact(binding, live) || await passed(binding, live) || !await baseline(binding)) throw Object.assign(new Error("音乐验收已通过或授权范围已变化，禁止再执行"), { code: "VERIFICATION_PREREQUISITE_CHANGED", status: 409 });
    return { authorizationId: SPEC.id, authorizationEpoch: SPEC.epoch, consumptionId: key, batchNumber: receipt.batchNumber, reservedAt: instant };
  }
  async function closeIfPassed({ binding, record }) {
    if (!await passed(binding, record)) return false;
    await (await collection()).updateOne({ _id: SPEC.id, specSha256, state: "active" }, { $set: { state: "passed",
      passedVerificationId: record._id, passedChallengeId: record.challengeId, stoppedAt: new Date(now()), updatedAt: new Date(now()) } });
    return true;
  }
  async function activate({ expectedCommit, installedCommit }) {
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || "") || expectedCommit !== installedCommit)
      throw Object.assign(new Error(), { code: "GENERIC_RETEST_DEPLOYMENT_MISMATCH" });
    const col = await collection(), existing = await col.findOne({ _id: SPEC.id });
    if (existing) {
      if (!valid(existing)) throw Object.assign(new Error(), { code: "GENERIC_RETEST_LEDGER_INVALID" });
      return { authorization_id: SPEC.id, authorization_epoch: SPEC.epoch, ready_at: existing.readyAt,
        expires_at: existing.expiresAt, used: existing.usedTotal,
        state: existing.state === "active" && +new Date(now()) >= +new Date(existing.expiresAt) ? "expired" : existing.state, initialized: false };
    }
    const instant = new Date(now());
    if (+instant >= +new Date(SPEC.expiresAt)) throw Object.assign(new Error(), { code: "GENERIC_RETEST_ACTIVATION_EXPIRED" });
    const binding = await (await getCollection("nodeAccountBindings")).findOne({ _id: new ObjectId(SPEC.bindingId), status: "active", revokedAt: null });
    if (!binding || !await baseline(binding)) throw Object.assign(new Error(), { code: "GENERIC_RETEST_SOURCE_MISMATCH" });
    const row = await (await getCollection("capabilityAutoVerifications")).findOne({ bindingId: String(binding._id), capabilityId: cap,
      artifactSha256: SPEC.artifactSha256, matrixSha256: SPEC.matrixSha256, inventoryEnabled: true });
    if (!exact(binding, row)) throw Object.assign(new Error(), { code: "GENERIC_RETEST_INVENTORY_MISMATCH" });
    const alreadyPassed = await passed(binding, row);
    try { await col.updateOne({ _id: SPEC.id }, { $setOnInsert: { spec: SPEC, specSha256, state: alreadyPassed ? "passed" : "active",
      scope: { bindingId: String(binding._id), nodeId: binding.nodeId, artifactSha256: SPEC.artifactSha256, computeGroupId: binding.computeGroupId || null },
      readyAt: instant, expiresAt: new Date(SPEC.expiresAt), activationCommit: expectedCommit, usedTotal: 0, issuedTotal: 3,
      consumptions: {}, lastChallengeId: null, createdAt: instant, updatedAt: instant } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    return activate({ expectedCommit, installedCommit });
  }
  async function status({ binding }) {
    if (!matchesBinding(binding)) return { policy: SPEC.policy, applicable: false };
    const row = await (await getCollection("capabilityAutoVerifications")).findOne({ bindingId: String(binding._id), capabilityId: cap,
      artifactSha256: SPEC.artifactSha256, matrixSha256: SPEC.matrixSha256, inventoryEnabled: true });
    const gate = await inspect({ binding, candidate: row, controlled: true }), doc = gate.doc;
    const nextBatch = gate.available && doc.usedTotal === doc.issuedTotal ? 3 : 0;
    const limit = doc ? doc.issuedTotal + nextBatch : 0;
    return { policy: SPEC.policy, applicable: true, authorization_id: SPEC.id, authorization_epoch: SPEC.epoch,
      artifact_sha256: SPEC.artifactSha256, matrix_sha256: SPEC.matrixSha256, state: gate.state, batch_size: 3,
      ready_at: doc?.readyAt || null, expires_at: doc?.expiresAt || SPEC.expiresAt, next_batch_available: nextBatch > 0,
      total: { limit, issued: doc?.issuedTotal || 0, used: doc?.usedTotal || 0, remaining: gate.available ? limit - doc.usedTotal : 0 },
      capabilities: [{ capability_id: cap, remaining: gate.available ? limit - doc.usedTotal : 0 }],
      safety_max_attempts: SPEC.safetyMaxAttempts, stop_on_first_pass: true, ordinary_fallback: false,
      resets_original_budgets: false, grants_admission: false, business_admission: false };
  }
  return { available, reserve, status, closeIfPassed, activate };
}
