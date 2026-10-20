// Public schema and anonymous rejection only; never create probes or objects.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
export async function verifyProbeOutputRecoveryDeployment(origin, read = fetch) {
  const base = new URL(origin);
  assert.equal(base.protocol, "https:"); assert.equal(base.username + base.password + base.search + base.hash, "");
  const get = (path) => read(new URL(path, base.origin), { redirect: "error", signal: AbortSignal.timeout(30000) });
  const specReply = await get("/api/openapi.json"); assert.equal(specReply.status, 200);
  const spec = await specReply.json();
  const route = spec.paths["/api/v1/capability-verifications/{id}/outputs/{output_id}"].get;
  assert.ok(route); assert.deepEqual(route.security, [{ accountBinding: [] }]);
  assert.ok(route.parameters.some((parameter) => parameter.name === "X-Gulong-Verification-Lease"));
  const fields = route.responses["200"].content["application/json"].schema.properties;
  assert.deepEqual(fields.state.enum, ["confirmed_present", "confirmed_absent", "uncertain"]);
  assert.equal(fields.content_verified.const ?? fields.content_verified.enum?.[0], false);
  assert.ok(fields.retry_put_allowed); assert.ok(fields.descriptor); assert.equal(fields.url, undefined); assert.equal(fields.method, undefined);
  const reply = await get(`/api/v1/capability-verifications/gcv_00000000-0000-4000-8000-000000000000/outputs/${"A".repeat(43)}`);
  assert.equal(reply.status, 401); assert.match(reply.headers.get("cache-control"), /private.*no-store/);
  const supplement = spec.paths["/api/v1/capability-verifications/supplemental-budget"]?.get;
  assert.ok(supplement); assert.deepEqual(supplement.security, [{ accountBinding: [] }]);
  assert.ok(spec.paths["/api/v1/capability-verifications/next"].post.responses["200"].content["application/json"].schema.properties.retry_at);
  const supplementReply = await get("/api/v1/capability-verifications/supplemental-budget");
  assert.equal(supplementReply.status, 401); assert.match(supplementReply.headers.get("cache-control"), /private.*no-store/);
  return { origin: base.origin, status: "probe_output_recovery_contract_verified", anonymous_status: 401,
    supplemental_budget_route_verified: true,
    real_transfer_verified: false, model_requests: 0, object_writes: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origins = process.argv.slice(2); assert.ok(origins.length, "请提供正式HTTPS核验地址");
  for (const origin of origins) console.log(JSON.stringify(await verifyProbeOutputRecoveryDeployment(origin)));
}
