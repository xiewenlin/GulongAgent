import assert from "node:assert/strict";
import test from "node:test";
import app from "../../server/app.js";
import { verifyProbeOutputRecoveryDeployment } from "../../scripts/verify-probe-output-recovery-deployment.mjs";
test("production recovery verifier checks actual OpenAPI and anonymous route with GET only", async () => {
  const requests = [];
  const read = async (url, options) => { requests.push(String(url)); assert.equal(options.method, undefined); return app.request(url, options); };
  const result = await verifyProbeOutputRecoveryDeployment("https://example.invalid", read);
  assert.equal(result.anonymous_status, 401); assert.equal(result.real_transfer_verified, false);
  assert.equal(result.object_writes + result.model_requests, 0); assert.equal(requests.length, 3);
  assert.equal(result.supplemental_budget_route_verified, true);
  assert.match(requests[1], /\/outputs\//);
  assert.match(requests[2], /\/supplemental-budget$/);
});
test("public recovery verifier rejects insecure origins and any unexpectedly anonymous success", async () => {
  await assert.rejects(verifyProbeOutputRecoveryDeployment("http://example.invalid"));
  await assert.rejects(verifyProbeOutputRecoveryDeployment("https://user:pass@example.invalid"));
  const read = (url, options) => String(url).endsWith("/api/openapi.json") ? app.request(url, options) : Promise.resolve(new Response("{}", { status: 200 }));
  await assert.rejects(verifyProbeOutputRecoveryDeployment("https://example.invalid", read));
});
