import { createHash } from "node:crypto";
import { nodeReportArtifactSha256 } from "./capability-artifact-installation-guard.js";

// Product-scoped business review, not an inventory whitelist or probe budget.
// Direct human message: 01a15b8b-b0cb-7ce1-9094-49574b204e25 (WorkLucky).
const ARTIFACT = "1829a188caee1e3bca564edaa0b836dd173785e7ffda7363cd7a27a7d9cf1ccb";
const SCOPE = "f7fb77ad7bbea3dc0c193345dcde8b1b58bd56faa2f8ccbe2f418b6f348b90bf";
const MATRICES = Object.freeze({
  "gulong_engine.agent_chat": "ff6559891450080c6b0b9299e4f4d0d3ccaa01f113c62ee5d357032ef8e7fbd8",
  "gulong_engine.embedding": "50b6a996594e11511e9136c79ca57c8dc999eaa87585f54672cb394580271f3a",
  "gulong_engine.music": "f565786022f87dd38ce6d893e0208650977dc7ce45fd92b5e11679ac2a7461af",
  "sam.video_track": "d28defd37c921603c6f674b124abbe45eaea461140764a087e62021a8b5f22ab",
  "mediapipe.video_analysis": "93b9bfc38d97323252b8d7e7b50fd12ee9857a8faf4fc9bfeeffd578f5c214fa",
  "whisper.transcribe": "53496ac6369494461ca65920b8e0b83f616dbafbdc562b19a8ddd9043096ecf4",
});
const scope = binding => createHash("sha256").update(JSON.stringify([String(binding?._id), binding?.nodeId, ARTIFACT,
  binding?.computeGroupId || null])).digest("hex");
// Reports can cross Mongo/JSON boundaries. A serialized/client-copied marker is
// NOT authority; every lookup recreates this token from fresh server DB proof.
const issued = new WeakSet();
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function isReviewedWorkLuckyBusinessAllowed(binding, report, product, now = new Date()) {
  const approval = report?.reviewedBusinessAdmission;
  return Boolean(product === "worklucky" && approval && issued.has(approval) && scope(binding) === SCOPE
    && nodeReportArtifactSha256(report) === ARTIFACT && report.capabilityId === approval.capabilityId
    && report.capabilityVersion === approval.capabilityVersion && +new Date(approval.expiresAt) > +new Date(now));
}
export function createWorkLuckyReviewedAdmission({ getCollection }) {
  async function review({ binding, inventory, records, now }) {
    if (scope(binding) !== SCOPE || binding.status !== "active" || binding.revokedAt
      || inventory.artifactSha256 !== ARTIFACT || MATRICES[inventory.capabilityId] !== inventory.matrixSha256
      || !Array.isArray(records) || !records.length) return null;
    // Native Music3 fixed regression is deliberately absent: its ordinary
    // output adapter is not equivalent to the tested verification path yet.
    const audits = await getCollection("capabilityVerificationAudits"), accepted = [];
    for (const record of records) {
      if (record.fixedCaseOnly || record.artifactSha256 !== ARTIFACT || record.matrixSha256 !== inventory.matrixSha256
        || record.capabilityId !== inventory.capabilityId || record.bindingId !== String(binding._id)
        || record.nodeId !== binding.nodeId || record.userId !== String(binding.userId)
        || (record.computeGroupId || null) !== (binding.computeGroupId || null) || record.status !== "active"
        || record.automaticMigrationEnabled === false || !record.contractTests || !Object.keys(record.contractTests).length
        || !Object.values(record.contractTests).every(value => value === true)
        || !Number.isFinite(+new Date(record.testedAt)) || !Number.isFinite(+new Date(record.expiresAt))
        || +new Date(record.expiresAt) - +new Date(record.testedAt) > 7 * 86400_000
        || !record.inventoryEnabled || +new Date(record.testedAt) > +new Date(now) || +new Date(record.expiresAt) <= +new Date(now)
        || !/^[a-f0-9]{64}$/.test(record.testEvidenceSha256 || "") || !/^[a-f0-9]{64}$/.test(record.resultFingerprint || "")) continue;
      const audit = await audits.findOne({ action: "capability.automatic_verification_passed", verificationId: record._id,
        challengeId: record.challengeId, bindingId: String(binding._id), nodeId: binding.nodeId,
        artifactSha256: ARTIFACT, matrixSha256: inventory.matrixSha256 });
      if (!audit || !/^[a-f0-9]{64}$/.test(audit.resultSha256 || "")
        || canonical(audit.model) !== canonical(record.verifiedModel)) continue;
      accepted.push(record);
    }
    if (!accepted.length) return null;
    const approval = Object.freeze({ policy: "worklucky-exact-reviewed-business-v1", product: "worklucky",
      capabilityId: inventory.capabilityId, capabilityVersion: inventory.capabilityVersion, artifactSha256: ARTIFACT,
      matrixSha256: inventory.matrixSha256, verificationIds: accepted.map(record => record._id),
      expiresAt: new Date(Math.min(...accepted.map(record => +new Date(record.expiresAt)))).toISOString() });
    issued.add(approval);
    return { records: accepted, approval };
  }
  return { review };
}
