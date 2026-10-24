// Public schema plus anonymous denial only: no credentials, real reports,
// model calls, challenges, orders, uploads, cancellation or admission changes.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
export async function verifyLocalResultDeployment(origin, read = fetch) {
  const base = new URL(origin);
  assert.equal(base.protocol, "https:");
  assert.equal(base.username + base.password + base.search + base.hash, "");
  const path = "/api/v1/capability-verifications/local-results";
  const request = (route, options = {}) => read(new URL(route, base.origin), { redirect: "error", signal: AbortSignal.timeout(30000), ...options });
  const specReply = await request("/api/openapi.json"); assert.equal(specReply.status, 200);
  const spec = await specReply.json();
  for (const routePath of [path, `${path}/chunks`]) {
    const route = spec.paths[routePath]; assert.ok(route?.post);
    assert.deepEqual(route.post.security, [{ accountBinding: [] }]);
    assert.equal(route.get, undefined); assert.equal(route.delete, undefined);
    assert.ok(route.post.responses["401"]);
  }
  const schema = spec.paths[path].post.requestBody.content["application/json"].schema;
  for (const key of ["request_body_base64", "response_body_base64", "local_direct_source", "outputs"]) assert.ok(schema.required.includes(key));
  assert.ok(schema.properties.capability_id.enum.includes("ace_step_1_5.generate"));
  assert.match(spec.paths[path].post.description, /pending-native-review/);
  // Empty anonymous bodies stop at authentication, before any storage work.
  for (const routePath of [path, `${path}/chunks`]) {
    const reply = await request(routePath, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(reply.status, 401); assert.match(reply.headers.get("cache-control"), /private.*no-store/);
    const body = await reply.json(); assert.ok(typeof body.code === "string");
  }
  return { origin: base.origin, status: "local_result_intake_contract_verified", openapi_version: spec.info.version,
    anonymous_status: 401, real_report_uploaded: false, model_requests: 0, tasks_created: 0, admission_changes: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origins = process.argv.slice(2); assert.ok(origins.length, "请提供正式 HTTPS 地址");
  for (const origin of origins) console.log(JSON.stringify(await verifyLocalResultDeployment(origin)));
}
