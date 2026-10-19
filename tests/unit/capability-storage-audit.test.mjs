import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { browserUploadCorsReady, browserUploadCorsRule, capabilityUploadPolicySummary, SHARED_UPLOAD_HEADERS } from "../../server/cos.js";
import { inspectProductionUploadStorage, productionUploadOrigins } from "../../scripts/inspect-capability-storage.mjs";
const good = (value) => ({ status: "fulfilled", value });
const failed = { status: "rejected", reason: new Error("SECRET_MUST_NOT_LEAK") };

test("browser CORS requires every signed capability header in one matching rule", () => {
  const rule = { AllowedOrigin: [...productionUploadOrigins], AllowedMethod: ["PUT"], AllowedHeader: ["Content-Type"] };
  assert.equal(browserUploadCorsReady([rule], productionUploadOrigins), false);
  rule.AllowedHeader = [...SHARED_UPLOAD_HEADERS].map((header) => header.toUpperCase());
  assert.equal(browserUploadCorsReady([rule], productionUploadOrigins), true);
  for (const header of SHARED_UPLOAD_HEADERS) {
    rule.AllowedHeader = SHARED_UPLOAD_HEADERS.filter((item) => item !== header);
    assert.equal(browserUploadCorsReady([rule], productionUploadOrigins), false, header);
  }
  assert.equal(browserUploadCorsReady([browserUploadCorsRule(productionUploadOrigins)], productionUploadOrigins), true);
});

test("metadata-only storage audit separates ready policy from real transfer acceptance", () => {
  const report = capabilityUploadPolicySummary(good({ VersioningConfiguration: {} }),
    good({ CORSRules: [browserUploadCorsRule(productionUploadOrigins)] }), productionUploadOrigins);
  assert.equal(report.ready, true); assert.equal(report.versioning, "write_once_compatible");
  assert.equal(report.real_transfer_verified, false); assert.equal(report.object_writes, 0);
  assert.equal(report.bucket_policy_writes, 0); assert.equal(report.model_requests, 0);
  for (const Status of ["Enabled", "Suspended"]) {
    const incompatible = capabilityUploadPolicySummary(good({ VersioningConfiguration: { Status } }),
      good({ CORSRules: [browserUploadCorsRule(productionUploadOrigins)] }), productionUploadOrigins);
    assert.equal(incompatible.ready, false); assert.equal(incompatible.versioning, "incompatible");
  }
});

test("unknown storage policies and missing browser origins stay unavailable without SDK error leaks", () => {
  for (const versioning of [failed, good({}), good({ VersioningConfiguration: [] })]) {
    const report = capabilityUploadPolicySummary(versioning, failed, productionUploadOrigins);
    assert.equal(report.ready, false); assert.equal(report.versioning, "unavailable");
    assert.equal(report.browser_cors, "unavailable"); assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  }
  const missing = capabilityUploadPolicySummary(good({ VersioningConfiguration: {} }), good({ CORSRules: [] }), productionUploadOrigins);
  assert.equal(missing.browser_cors, "missing_required_origins_or_headers"); assert.equal(missing.ready, false);
});

test("production audit catches configuration errors and never returns raw secrets", async () => {
  let calls = 0;
  const report = await inspectProductionUploadStorage(async (origins) => {
    calls += 1; assert.deepEqual(origins, productionUploadOrigins); throw new Error("SECRET_PRIVATE_KEY_URL");
  });
  assert.equal(calls, 1); assert.equal(report.ready, false); assert.equal(report.model_requests, 0);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|PRIVATE_KEY_URL/);
});

test("storage audit deployment reuses pinned SSH and exposes metadata only", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
  const script = await readFile(new URL("../../scripts/inspect-capability-storage.mjs", import.meta.url), "utf8");
  const audit = workflow.split("- name: Read-only shared-upload policy audit")[1]?.split("\n  frontend-parity:")[0];
  assert.ok(audit); assert.match(audit, /StrictHostKeyChecking=yes/); assert.match(audit, /inspect-capability-storage\.mjs/);
  assert.doesNotMatch(audit, /ssh-keyscan|StrictHostKeyChecking=no|putBucket|putObject|createOrder/);
  assert.doesNotMatch(script, /process\.env|console\.error|putBucket|putObject|createOrder/);
});
