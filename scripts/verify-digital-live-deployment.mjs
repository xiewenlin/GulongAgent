// GET-only product contract checks; no sessions, orders, uploads or inference.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function verifyDigitalLiveDeployment(origin, read = fetch) {
  const base = new URL(origin);
  assert.equal(base.protocol, "https:"); assert.equal(base.username + base.password + base.search + base.hash, "");
  const checks = [];
  const get = async (path, status) => {
    const reply = await read(new URL(path, base.origin), { redirect: "error", signal: AbortSignal.timeout(30_000) });
    assert.equal(reply.status, status, `${base.origin}${path}`); checks.push({ path, status: reply.status });
    return reply.json();
  };
  const config = await get("/api/v1/desktop/digital-live/config", 200);
  assert.equal(config.schema_version, "digital-live-product-v1"); assert.equal(config.product, "digital_live");
  assert.equal(config.subscription.required_capability, "digital_live.use"); assert.equal(config.subscription.included_in_plan, true);
  assert.equal(config.subscription.separate_purchase, false); assert.equal(config.capability_orders.product, "digital_live");
  assert.equal(config.capability_orders.text_component, "qwen38-27b-uncensored");
  assert.equal(config.capability_orders.text_model, "qwen38-27b-uncensored-q4-k-m"); assert.equal(config.capability_orders.paid_fallback, false);
  assert.equal(config.realtime.status, "integration_required"); assert.equal(config.realtime.session_url, null);
  assert.equal(config.realtime.control_contract_url, "/api/v1/digital-live/realtime/config");
  const realtime = await get(config.realtime.control_contract_url, 200);
  assert.equal(realtime.schema_version, "digital-live-realtime-v1"); assert.equal(realtime.dispatchable, false);
  assert.equal(realtime.acceptance, "adapter_required"); assert.equal(realtime.transport, "http-fmp4-mse-v1");
  assert.equal(realtime.gateway_origin, "https://111.229.70.235"); assert.equal(realtime.billing.wallet_charge, false);
  assert.equal(realtime.remote_asr.status, "integration_required"); assert.equal(realtime.remote_asr.max_input_bytes, 640000);
  assert.equal(config.avatar.dispatchable, false); assert.equal(config.highlights.dispatchable, false);
  const spec = await get("/api/openapi.json", 200);
  const component = spec.components.schemas.DigitalLiveSharedCapabilityContract;
  assert.ok(component); assert.deepEqual(component.properties.capability_ids.items.enum, config.capability_orders.capability_ids);
  const login = spec.paths["/api/v1/desktop/gulong-engine/auth/login"].post.responses["200"].content["application/json"].schema;
  assert.ok(login.properties.user); assert.ok(login.properties.entitlement.properties.included_products);
  const fee = login.properties.entitlement.properties.monthly_price_fen;
  assert.equal(config.subscription.monthly_price_fen, fee.const ?? fee.enum?.[0]);
  assert.ok(spec.paths["/api/v1/capability-orders/by-request/{key}/cancel"].post);
  assert.ok(spec.paths["/api/v1/capability-assets/by-request/{key}"].get);
  assert.ok(spec.components.schemas.DigitalLiveRealtimeCreate);
  assert.ok(spec.paths["/api/v1/digital-live/realtime/sessions/{id}/turns"].post);
  assert.ok(spec.paths["/api/v1/digital-live/realtime/sessions/{id}/events"].get);
  assert.ok(spec.paths["/api/v1/digital-live/realtime/sessions/{id}/asr/utterances"].post);
  assert.ok(spec.paths["/api/v1/digital-live/realtime/verifications/next"].post);
  await get(realtime.catalog_url, 401);
  await get("/api/v1/desktop/digital-live/config?product=worklucky", 400);
  await get("/api/v1/desktop/gulong-engine/account", 401);
  await get("/api/v1/capability-orders/catalog?product=digital_live", 401);
  await get("/api/v1/capability-orders/by-request/digital-live-deploy-check?product=digital_live", 401);
  await get("/api/v1/capability-assets/by-request/digital-live-asset-check?product=digital_live", 401);
  return { origin: base.origin, status: "digital_live_contract_verified", real_user_login_tested: false, real_inference_tested: false, checks };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origins = process.argv.slice(2);
  if (!origins.length) throw new Error("请显式提供官网HTTPS核验地址");
  for (const origin of origins) console.log(JSON.stringify(await verifyDigitalLiveDeployment(origin)));
}
