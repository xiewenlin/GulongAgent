// GET-only production contract check. Never creates a session, order or inference.
import assert from "node:assert/strict";

const origins = process.argv.slice(2);
if (!origins.length) throw new Error("请显式提供待核验的官网 HTTPS 地址");
for (const raw of origins) {
  const base = new URL(raw);
  assert.equal(base.protocol, "https:");
  assert.equal(base.username + base.password + base.search + base.hash, "");
  const checks = [];
  const read = async (path, expected) => {
    const response = await fetch(new URL(path, base.origin), { redirect: "error", signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, expected, `${base.origin}${path}`);
    checks.push({ path, status: response.status });
    return response.json();
  };
  const config = await read("/api/v1/desktop/worklucky/config", 200);
  assert.equal(config.product_id, "worklucky");
  assert.equal(config.capability_orders.paid_fallback, false);
  assert.equal(config.capability_orders.execution_requires, "verified_consumer_contract");
  for (const id of ["agent_chat", "embedding", "music"]) assert.ok(config.capability_orders.capability_ids.includes(`gulong_engine.${id}`));
  const updates = await read("/api/v1/desktop/worklucky/updates", 200);
  assert.equal(updates.product_id, "worklucky");
  const document = await read("/api/openapi.json", 200);
  for (const [path, method] of [
    ["/api/v1/desktop/worklucky/config", "get"], ["/api/v1/desktop/worklucky/account", "get"],
    ["/api/v1/desktop/worklucky/auth/login", "post"], ["/api/v1/desktop/worklucky/auth/refresh", "post"],
    ["/api/v1/desktop/worklucky/auth/logout", "post"], ["/api/v1/desktop/worklucky/updates", "get"],
    ["/api/admin/capability-consumers/acceptances", "post"], ["/api/cron/capability-output-cleanup", "get"],
    ["/api/admin/capability-consumers/bindings", "get"],
  ]) assert.ok(document.paths[path]?.[method], `${method} ${path}`);
  assert.ok(document.components.schemas.WorkLuckySharedCapabilityContract);
  assert.ok(document.paths["/api/admin/capability-consumers/acceptances"].post.responses["410"]);
  for (const suffix of ["report", "next", "{id}/outputs", "{id}/result"]) assert.ok(document.paths[`/api/v1/capability-verifications/${suffix}`].post.requestBody);
  for (const suffix of ["by-request/{key}", "challenges/{id}"]) assert.ok(document.paths[`/api/v1/capability-verifications/${suffix}`].get);
  await read("/api/admin/capability-verifications", 401);
  await read("/api/v1/desktop/worklucky/account", 401);
  await read("/api/v1/capability-orders/catalog?product=worklucky", 401);
  await read("/api/admin/capability-consumers/acceptances", 401);
  await read("/api/admin/capability-consumers/bindings", 401);
  await read("/api/cron/capability-output-cleanup", 401);
  console.log(JSON.stringify({ origin: base.origin, status: "contract_verified", real_inference_tested: false, checks }));
}
