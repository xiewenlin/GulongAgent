// GET-only production contract check. Never creates a session, order or inference.
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";

// This job deliberately has no npm install. Verify the independently pinned
// release with Node builtins, not the API module's Hono/Zod dependency graph.
const updateKey = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([
  Buffer.from("302a300506032b6570032100", "hex"),
  Buffer.from("+Gye3bWarR49hJdvllBGmD+Dslwnw24WpRltf401Vxs=", "base64"),
]) });

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
  assert.equal(updates.status, "update_available");
  assert.equal(updates.release.version, "0.1.19");
  const asset = updates.release.assets["windows-x64"].portable_zip;
  assert.equal(asset.filename, "WorkLucky-0.1.19-windows-x64-portable.zip");
  assert.equal(asset.url, "https://www.sologle.com/api/v1/desktop/worklucky/releases/0.1.19/WorkLucky-0.1.19-windows-x64-portable.zip");
  assert.equal(asset.bytes, 124997007);
  assert.equal(asset.sha256, "dc1140c755f871c601bc14415a9bd1c46da3571bb89a6a7708db8eb26fd2fafd");
  assert.equal(asset.signature_algorithm, "worklucky-ed25519-sha256-v1");
  assert.equal(asset.signature_key_id, "worklucky-desktop-2026-01");
  const signature = Buffer.from(asset.signature, "base64");
  assert.equal(signature.length, 64); assert.equal(signature.toString("base64"), asset.signature);
  assert.ok(verify(null, Buffer.from(asset.sha256, "hex"), updateKey, signature));
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
