import { createHash } from "node:crypto";

// One installed, independently observed release. Never configurable by a client,
// an administrator HTTP request or an environment variable. This issues probes,
// not business admission. Prior windows/proofs are intentionally left intact.
export const INSTALLED_NINE_COLLECTION = "capabilityVerificationInstalledNineWindows";
const canonical = (v) => JSON.stringify(v, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const hash = (v) => createHash("sha256").update(canonical(v)).digest("hex");
const ARTIFACT = "f41db323b1c6ac3879d5b59a05c21b71866c8b8dfb6470446c2f427e37424418";
const QWEN = "983ea1b00180824ef7cf310594efa2a1e755b0293a853225ea286055149c9aa7";
const NODE_SCOPE = "7716c1461d6cbf546be7786fa0818d0cf1b6e3bf0d0b5c454706cfc7ad8ef0d9";
const CAPS = Object.freeze({
  "qwen_image_2_1.text_to_image": { key: "image", artifact: QWEN, limit: 1, matrix: "7192670bb9aaa25f8e9c396721ce34a404b7836ef181e9d64a9c7818f9a30c73" },
  "qwen_image_2_1.multi_image_edit": { key: "image_edit", artifact: QWEN, limit: 1, matrix: "37b41b5f115ddb697c3936e062ab6b74af60b5b1939b85cfdbe80c5d5d8e867e" },
  "gulong_engine.agent_chat": { key: "chat", artifact: ARTIFACT, limit: 1, matrix: "7b037807b8877497a000ad8a25cd1faad834e3dd74f60915c5a569689a9602e1" },
  "gulong_engine.embedding": { key: "embedding", artifact: ARTIFACT, limit: 1, matrix: "02787ce60cdc53f78caf41c76ac47d06dcc84da60c444d06ab574c90c0dafef0" },
  "sam.video_track": { key: "sam", artifact: ARTIFACT, limit: 1, matrix: "8be6daa6c102d27a8541ae70955f6bb39123d20adcbddd5b6397013629b40a11" },
  "mediapipe.video_analysis": { key: "mediapipe", artifact: ARTIFACT, limit: 1, matrix: "f07369040ea6385e97b8f4dc89c6325eab81bed922c0949dce2f5ed724f19ef2" },
  "whisper.transcribe": { key: "whisper", artifact: ARTIFACT, limit: 1, matrix: "42797832d38e400e1eed6f2ba84b3f5fc70e8a7d57de4acac9532ceb15cefb6e" },
  "gulong_engine.music": { key: "music", artifact: ARTIFACT, limit: 126, matrix: "6d9e02a33598321674cedf5abdb7402f24d3ec43273ff1b46a63c9d3008d8d3c" },
  "minimax_music_3.generate": { key: "native_music", artifact: ARTIFACT, limit: 126, matrix: "e29332e56e8e0919f3b678fb2095eb254314bb9ad4419a1dc9c632612ed372ac" },
});
const SPEC = Object.freeze({ id: "gvn_20261023_f41_nine", policy: "installed-nine-verification-only-v1",
  consumerArtifact: ARTIFACT, identityScope: "0734d985149ee3dfde5b5f197977722233c25f676f6d1cd1125a99414e376be1",
  validFrom: "2026-10-23T00:00:00.000Z", expiresAt: "2026-10-23T02:00:00.000Z",
  capabilities: CAPS, musicBatchSize: 3,
  evidence: { deltaSha256: "b97b68bf5f0d8817a474c43cbe799a3dc9103ae083dacc13ea32e754013f0cdf",
    inventorySha256: "5f09011eb46f82f86832edb7bf42a2b5df87754c97439067e439419a813ab691" },
  authorization: { source: "human-nine-verification-and-music-continuation",
    threadId: "01a07627-9f49-7760-a1b0-ae21244c5c0a", turnId: "01a16319-3091-7e62-83d2-fa771df4194e",
    messageId: "01a1631e-03c8-7e22-b027-520a9bcfcd0b", musicTurnId: "01a159aa-4e6e-7a30-b764-942e0491b314",
    musicMessageId: "01a159bc-19d5-7643-9a8f-3648714f5635" },
});
const SPEC_HASH = hash(SPEC);
const nodeMatches = (b) => hash([String(b?._id), b?.nodeId]) === NODE_SCOPE;
const identityMatches = (b) => b?.status === "active" && !b.revokedAt && b.autoVerificationPolicy === "capability-v2"
  && hash([String(b._id), b.nodeId, String(b.userId), createHash("sha256").update(`sologle-h3-account-scope-v1|${b.userId}`).digest("hex"), b.computeGroupId || null]) === SPEC.identityScope;
const capOf = (row) => CAPS[row?.capabilityId];

export function installedNineApplies(binding, row) {
  return nodeMatches(binding) && Boolean(capOf(row)) && [ARTIFACT, QWEN].includes(row?.artifactSha256);
}
export function installedNineRound(binding, inventory) {
  const cap = CAPS[inventory?.capabilityId];
  return identityMatches(binding) && cap && cap.artifact === inventory.artifactSha256 && cap.matrix === inventory.matrixSha256 ? SPEC.id : null;
}
function exact(binding, row) {
  const inv = row?.inventory, cap = capOf(row);
  if (!inv || !cap || !identityMatches(binding) || !binding.autoVerificationCapabilityIds?.includes(row.capabilityId)
    || row.verificationWindowId !== SPEC.id || row.bindingId !== String(binding._id) || row.nodeId !== binding.nodeId
    || row.userId !== String(binding.userId) || (row.computeGroupId || null) !== (binding.computeGroupId || null)
    || row.inventoryEnabled !== true || inv.enabled !== true || row.artifactSha256 !== cap.artifact
    || inv.artifactSha256 !== cap.artifact || row.matrixSha256 !== cap.matrix || inv.matrixSha256 !== cap.matrix) return false;
  const { capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages } = inv;
  return hash({ capabilityId, capabilityVersion, artifactSha256, models, defaultModel, asrLanguages }) === cap.matrix
    && models.length === 1 && canonical(row.model) === canonical(models[0]);
}
function valid(doc) {
  if (!doc) return true;
  try {
    const entries = Object.entries(doc.consumptions || {});
    return doc.specSha256 === SPEC_HASH && hash(doc.spec) === SPEC_HASH && hash(doc.authorization) === hash(SPEC.authorization)
      && doc.state === "active" && doc.identityScope === SPEC.identityScope
      && identityMatches({ ...doc.scope, _id: doc.scope.bindingId, status: "active", autoVerificationPolicy: "capability-v2" })
      && +new Date(doc.validFrom) === +new Date(SPEC.validFrom) && +new Date(doc.expiresAt) === +new Date(SPEC.expiresAt)
      && Number.isSafeInteger(doc.usedTotal) && entries.length === doc.usedTotal
      && Object.keys(doc.usedByCapability || {}).length === 9
      && Object.entries(CAPS).every(([id, cap]) => Number.isSafeInteger(doc.usedByCapability[cap.key])
        && doc.usedByCapability[cap.key] >= 0 && doc.usedByCapability[cap.key] <= cap.limit
        && entries.filter(([, item]) => item.capabilityId === id).length === doc.usedByCapability[cap.key])
      && entries.every(([key, item]) => key === hash(item.challengeId) && capOf(item) && item.unit === 1
        && item.artifactSha256 === capOf(item).artifact && item.matrixSha256 === capOf(item).matrix
        && /^[a-f0-9]{64}$/.test(item.verificationId || "") && typeof item.requestId === "string"
        && +new Date(item.reservedAt) >= +new Date(SPEC.validFrom) && +new Date(item.reservedAt) < +new Date(SPEC.expiresAt));
  } catch { return false; }
}
export function createInstalledNineWindow({ getCollection, now = () => new Date() }) {
  const inWindow = () => +new Date(now()) >= +new Date(SPEC.validFrom) && +new Date(now()) < +new Date(SPEC.expiresAt);
  async function available({ binding, candidate, controlled, allowBackoff = false }) {
    if (controlled !== true || !inWindow() || !exact(binding, candidate)) return false;
    const live = await (await getCollection("capabilityAutoVerifications")).findOne({ _id: candidate._id });
    if (!exact(binding, live) || !["pending", "failed"].includes(live.status)
      || !allowBackoff && live.status === "failed" && +new Date(live.nextRetryAt) > +new Date(now())) return false;
    const doc = await (await getCollection(INSTALLED_NINE_COLLECTION)).findOne({ _id: SPEC.id });
    return valid(doc) && (doc?.usedByCapability?.[capOf(candidate).key] || 0) < capOf(candidate).limit;
  }
  async function reserve(args) {
    if (!await available(args)) return null;
    const { binding, candidate, challengeId, requestId, requestRecordId } = args;
    const collection = await getCollection(INSTALLED_NINE_COLLECTION), instant = new Date(now());
    try {
      await collection.updateOne({ _id: SPEC.id }, { $setOnInsert: { spec: SPEC, specSha256: SPEC_HASH,
        authorization: SPEC.authorization, identityScope: SPEC.identityScope, state: "active",
        scope: { bindingId: String(binding._id), nodeId: binding.nodeId, userId: String(binding.userId), computeGroupId: binding.computeGroupId || null },
        validFrom: new Date(SPEC.validFrom), expiresAt: new Date(SPEC.expiresAt), usedTotal: 0,
        usedByCapability: Object.fromEntries(Object.values(CAPS).map((cap) => [cap.key, 0])), consumptions: {}, createdAt: instant } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
    const doc = await collection.findOne({ _id: SPEC.id });
    if (!valid(doc) || !await available(args)) return null;
    const cap = capOf(candidate), key = hash(challengeId), used = doc.usedByCapability[cap.key];
    const reservedAt = new Date(now()), receipt = { challengeId, requestId, requestRecordId, verificationId: candidate._id,
      capabilityId: candidate.capabilityId, artifactSha256: candidate.artifactSha256, matrixSha256: candidate.matrixSha256,
      unit: 1, reservedAt, batch: Math.floor(used / (cap.limit === 1 ? 1 : SPEC.musicBatchSize)) + 1 };
    const result = await collection.findOneAndUpdate({ _id: SPEC.id, specSha256: SPEC_HASH, state: "active", usedTotal: doc.usedTotal,
      validFrom: { $lte: reservedAt }, expiresAt: { $gt: reservedAt }, [`usedByCapability.${cap.key}`]: used,
      [`consumptions.${key}`]: { $exists: false } }, { $inc: { usedTotal: 1, [`usedByCapability.${cap.key}`]: 1 },
      $set: { [`consumptions.${key}`]: receipt, updatedAt: reservedAt } }, { returnDocument: "after" });
    const saved = result && Object.hasOwn(result, "value") ? result.value : result;
    return saved ? { authorizationId: SPEC.id, consumptionId: key, reservedAt, batch: receipt.batch } : null;
  }
  async function status({ binding }) {
    if (!nodeMatches(binding)) return { policy: SPEC.policy, applicable: false, state: "not_applicable" };
    const doc = await (await getCollection(INSTALLED_NINE_COLLECTION)).findOne({ _id: SPEC.id });
    const rows = await (await getCollection("capabilityAutoVerifications")).find({ bindingId: String(binding._id), verificationWindowId: SPEC.id }).limit(32).toArray();
    const caps = Object.entries(CAPS).map(([id, cap]) => {
      const row = rows.find((item) => item.capabilityId === id && exact(binding, item));
      const used = doc?.usedByCapability?.[cap.key] || 0;
      return { capability_id: id, artifact_sha256: cap.artifact, matrix_sha256: cap.matrix, inventory_ready: Boolean(row),
        status: row?.status || "awaiting_inventory", used, limit: cap.limit,
        remaining: inWindow() && valid(doc) && identityMatches(binding) && row?.status !== "active" ? cap.limit - used : 0 };
    });
    const ready = caps.every((item) => item.inventory_ready), passed = caps.filter((item) => item.status === "active").length;
    return { policy: SPEC.policy, applicable: true, authorization_id: SPEC.id, artifact_sha256: ARTIFACT,
      valid_from: SPEC.validFrom, expires_at: SPEC.expiresAt, inventory_ready: ready, passed_count: passed,
      state: !identityMatches(binding) ? "scope_changed" : !inWindow() ? "expired" : !valid(doc) ? "unavailable" : passed === 9 ? "passed" : !ready ? "awaiting_inventory" : "available",
      total: { used: doc?.usedTotal || 0, remaining: caps.reduce((sum, cap) => sum + cap.remaining, 0) }, capabilities: caps,
      ordinary_fallback: false, grants_admission: false, resets_original_budgets: false, external_media_included: false };
  }
  return { applies: installedNineApplies, available, reserve, status };
}
