import { createHash } from "node:crypto";

// Deny-only preinstallation quarantine for one reviewed binding + node. It
// grants no quota or proof and does not depend on a predicted new artifact.
const SCOPE = "7716c1461d6cbf546be7786fa0818d0cf1b6e3bf0d0b5c454706cfc7ad8ef0d9";
const EXISTING_ARTIFACTS = new Set([
  "554a6c84d242aadb9e5df18b0dff5f24298ccc3a0ed35fb7f25c97ac0801c281",
  "983ea1b00180824ef7cf310594efa2a1e755b0293a853225ea286055149c9aa7",
  "f8bb182e7059eefe075567f37617324e4105dbfd81426c1cc82a44ef9355c27d",
]);
const applies = binding => createHash("sha256").update(JSON.stringify([String(binding?._id), binding?.nodeId])).digest("hex") === SCOPE;
export function nodeReportArtifactSha256(report) {
  const values = [report?.artifactSha256, report?.artifact_sha256, report?.validation?.artifactSha256,
    report?.validation?.artifact_sha256, report?.verificationInventory?.artifact_sha256,
    report?.verificationInventory?.validation?.artifact_sha256].filter(value => value !== undefined && value !== null);
  if (!values.length || values.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value))) return null;
  const normalized = [...new Set(values.map(value => value.toLowerCase()))];
  return normalized.length === 1 ? normalized[0] : null;
}
export function isNodeArtifactQuarantined(binding, artifactSha256) {
  return applies(binding) && !EXISTING_ARTIFACTS.has(String(artifactSha256 || "").toLowerCase());
}
export function nodeArtifactInstallationGuardStatus(binding) {
  return { policy: "bound-node-unknown-artifact-deny-v1", applicable: applies(binding),
    unknown_artifacts: "blocked", denies_ordinary_fallback: true,
    fixed_case_authorization_active: false, grants_admission: false };
}
