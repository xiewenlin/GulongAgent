import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import app from "../../server/app.js";

test("Vercel dispatches desktop, consumer-administration and protected cleanup paths to the API", () => {
  const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  const mapping = new Map(config.rewrites.map((entry) => [entry.source, entry.destination]));
  assert.equal(mapping.get("/api/v1/desktop/:path*"), "/api/platform?_platform_path=v1/desktop/:path*");
  assert.equal(mapping.get("/api/admin/capability-consumers/:path*"), "/api/platform?_platform_path=admin/capability-consumers/:path*");
  assert.equal(mapping.get("/api/cron/:path*"), "/api/platform?_platform_path=cron/:path*");
  assert.deepEqual(config.crons.find((entry) => entry.path === "/api/cron/capability-output-cleanup"), { path: "/api/cron/capability-output-cleanup", schedule: "23 * * * *" });
  const spa = config.rewrites.findIndex((entry) => entry.destination === "/index.html");
  for (const source of ["/api/v1/desktop/:path*", "/api/admin/capability-consumers/:path*", "/api/cron/:path*"]) assert.ok(config.rewrites.findIndex((entry) => entry.source === source) < spa);
});

test("production app GET-only OpenAPI exposes WorkLucky and its administrator/lease/cleanup contracts", async () => {
  const response = await app.request("https://www.sologle.com/api/openapi.json");
  assert.equal(response.status, 200); const spec = await response.json();
  for (const [path, method] of [
    ["/api/v1/desktop/worklucky/config", "get"], ["/api/v1/desktop/worklucky/updates", "get"],
    ["/api/v1/desktop/worklucky/account", "get"], ["/api/v1/desktop/worklucky/auth/login", "post"],
    ["/api/v1/desktop/worklucky/auth/refresh", "post"], ["/api/v1/desktop/worklucky/auth/logout", "post"],
    ["/api/admin/capability-consumers/acceptances", "get"], ["/api/admin/capability-consumers/acceptances", "post"],
    ["/api/v1/capability-orders/claim", "post"], ["/api/v1/capability-orders/callback", "post"],
    ["/api/v1/capability-orders/by-request/{key}", "get"], ["/api/v1/capability-orders/by-request/{key}/cancel", "post"],
    ["/api/cron/capability-output-cleanup", "get"],
  ]) assert.ok(spec.paths[path]?.[method], `${method} ${path}`);
  const contract = spec.components.schemas.WorkLuckySharedCapabilityContract;
  assert.ok(contract); for (const part of ["agent_chat", "embedding", "music", "limits", "lifecycle"]) assert.ok(contract.properties[part]);
  assert.match(contract.properties.music.description, /uint64/); assert.match(contract.properties.music.description, /published/);
  assert.match(contract.properties.limits.description, /60次/); assert.match(contract.properties.lifecycle.description, /300秒/);
  const claim = spec.paths["/api/v1/capability-orders/claim"].post.requestBody.content["application/json"].schema;
  assert.ok(claim.properties.capabilities.items.properties.validation.properties.acceptance_id);
  assert.deepEqual(spec.paths["/api/cron/capability-output-cleanup"].get.security, [{ capabilityCleanupCronBearer: [] }]);
});

test("production app public config and updates use only safe GETs and never promise online consumers", async () => {
  for (const path of ["/api/v1/desktop/worklucky/config", "/api/v1/desktop/worklucky/updates"]) {
    const response = await app.request(`https://www.sologle.com${path}`);
    assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
    const body = await response.json(); assert.equal(body.product_id, "worklucky");
    if (body.capability_orders) {
      assert.equal(body.capability_orders.execution_requires, "verified_consumer_contract");
      assert.equal(body.capability_orders.paid_fallback, false); assert.equal(body.capability_orders.video, "adapter_required");
      for (const id of ["agent_chat", "embedding", "music"]) assert.ok(body.capability_orders.capability_ids.includes(`gulong_engine.${id}`));
      assert.equal("verified_node_count" in body.capability_orders, false);
    } else { assert.equal(body.status, "no_update"); assert.equal(body.release, null); }
  }
});

test("production verification script performs only default GET and never sends credentials, bodies or mutation requests", () => {
  const source = readFileSync(new URL("../../scripts/verify-worklucky-deployment.mjs", import.meta.url), "utf8");
  assert.match(source, /GET-only production contract check/);
  assert.equal((source.match(/\bfetch\s*\(/g) || []).length, 1);
  assert.doesNotMatch(source, /\bmethod\s*:/); assert.doesNotMatch(source, /\bbody\s*:/);
  assert.doesNotMatch(source, /\bauthorization\s*:/i); assert.doesNotMatch(source, /exec(?:File|Sync)?\s*\(/);
  for (const path of ["/api/v1/desktop/worklucky/config", "/api/admin/capability-consumers/acceptances", "/api/cron/capability-output-cleanup"]) assert.ok(source.includes(path));
  assert.match(source, /real_inference_tested:\s*false/);
});
