import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import app from "../../server/app.js";
import { verifyDigitalLiveDeployment } from "../../scripts/verify-digital-live-deployment.mjs";

test("production app publishes digital-live config and the extended authoritative login/account schema", async () => {
  const publicConfig = await app.request("https://www.sologle.com/api/v1/desktop/digital-live/config");
  assert.equal(publicConfig.status, 200); assert.match(publicConfig.headers.get("cache-control"), /no-store/);
  const config = await publicConfig.json(); assert.equal(config.product, "digital_live"); assert.equal(config.subscription.monthly_price_fen, 99900);
  const spec = await (await app.request("https://www.sologle.com/api/openapi.json")).json();
  const login = spec.paths["/api/v1/desktop/gulong-engine/auth/login"].post.responses["200"].content["application/json"].schema;
  assert.ok(login.properties.entitlement); assert.ok(login.properties.entitlement.properties.included_products.items.enum.includes("digital_live"));
  assert.ok(spec.components.schemas.DigitalLiveSharedCapabilityContract);
});

test("digital-live deployment verifier is GET-only and cannot stand in for real account or inference acceptance", async () => {
  const calls = [];
  const result = await verifyDigitalLiveDeployment("https://www.sologle.com", async (url, options) => {
    assert.equal(options.method, undefined); assert.equal(options.body, undefined); assert.equal(options.headers, undefined);
    calls.push(String(url));
    if (url.pathname === "/api/openapi.json" || url.pathname === "/api/v1/desktop/digital-live/config") return app.request(String(url));
    return new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "请先登录" }), { status: 401, headers: { "Content-Type": "application/json" } });
  });
  assert.equal(result.real_inference_tested, false); assert.equal(result.real_user_login_tested, false); assert.equal(calls.length, 7);
  await assert.rejects(() => verifyDigitalLiveDeployment("http://www.sologle.com"));
  const source = readFileSync(new URL("../../scripts/verify-digital-live-deployment.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bmethod\s*:/); assert.doesNotMatch(source, /\bbody\s*:/); assert.doesNotMatch(source, /\bauthorization\s*:/i);
});
