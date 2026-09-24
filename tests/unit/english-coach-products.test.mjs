import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  ENGLISH_COACH_MONTHLY_PRICE_FEN,
  ENGLISH_COACH_PLAN_ID,
  buildProductPeriodPatch,
  englishEntitlement,
  legacyAccessSubscription,
  subscriptionProducts,
} from "../../server/english-coach-products.js";
import { ENGLISH_CAPABILITY_DEFINITIONS, validateEnglishInlineResult } from "../../server/english-coach-capabilities.js";
import { CAPABILITY_ORDER_PROTOCOL, normalizeCapabilityReport, registerCapabilityOrderRoutes } from "../../server/capability-orders.js";
import { registerPearApiRoutes } from "../../server/pearapi.js";

const now = new Date("2026-09-24T08:00:00.000Z");
const period = { currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), enabled: true, status: "active" };

test("英语教练包月独立定价与有效期，不授予普通会员权益", () => {
  assert.equal(ENGLISH_COACH_MONTHLY_PRICE_FEN, 19800);
  const subscription = { plan: ENGLISH_COACH_PLAN_ID, products: { [ENGLISH_COACH_PLAN_ID]: period } };
  assert.equal(englishEntitlement(subscription, now).active, true);
  assert.equal(legacyAccessSubscription(subscription, now).status, "inactive");
  assert.equal(subscriptionProducts(subscription, now).find((p) => p.id === ENGLISH_COACH_PLAN_ID).status, "active");
});

test("一次修改多个产品仅生成所选产品的 Mongo 点路径", () => {
  const previous = { plan: "member", products: { member: period, short_video_monthly: period } };
  const patch = buildProductPeriodPatch(previous, [
    { id: ENGLISH_COACH_PLAN_ID, enabled: true, currentPeriodStart: "2026-09-24T08:00:00Z", currentPeriodEnd: "2026-10-24T08:00:00Z" },
    { id: "short_video_monthly", enabled: false },
  ], {}, now);
  assert.deepEqual(Object.keys(patch).sort(), ["products.english_coach_monthly", "products.short_video_monthly"]);
  assert.equal(patch["products.short_video_monthly"].enabled, false);
  assert.equal(patch["products.english_coach_monthly"].status, "active");
  assert.equal(englishEntitlement({ products: { [ENGLISH_COACH_PLAN_ID]: patch["products.english_coach_monthly"] } }, now).active, true);
});

test("英语能力必须零单次价格且真实发音评估有逐词声学证据", () => {
  assert.deepEqual(ENGLISH_CAPABILITY_DEFINITIONS.map((c) => c.capabilityId), ["english_coach.text", "english_coach.transcribe", "english_coach.speech", "english_coach.assess"]);
  assert.ok(ENGLISH_CAPABILITY_DEFINITIONS.every((c) => c.priceFen === 0));
  assert.deepEqual(ENGLISH_CAPABILITY_DEFINITIONS.filter((c) => c.dispatchable).map((c) => c.capabilityId), []);
  assert.ok(ENGLISH_CAPABILITY_DEFINITIONS.every((c) => c.adapterStatus === "local_only"));
  assert.equal(validateEnglishInlineResult("english_coach.assess", { provider: "whisper", referenceText: "hello", transcript: "hello", pronunciationScore: 88, words: [] }, { reference_text: "hello" }), false);
  assert.equal(validateEnglishInlineResult("english_coach.assess", { provider: "local-phoneme", referenceText: "hello", transcript: "hello", pronunciationScore: 88, words: [{ word: "hello", accuracyScore: 88, phonemes: [{ phoneme: "h", accuracyScore: 87 }] }] }, { reference_text: "hello" }), true);
});

test("英语新派单与录音上传均拒绝，其他产品能力不受影响", async () => {
  const app = new OpenAPIHono();
  registerCapabilityOrderRoutes(app, {
    authenticate: async () => ({ user: { id: "507f1f77bcf86cd799439011" }, kind: "desktop-english" }),
    requireTrustedMutation: () => null,
    enforceRateLimit: async () => ({ allowed: true }),
    readEnglishEntitlement: async () => ({ active: true }),
  });
  const catalog = await app.request("http://localhost/api/v1/capability-orders/catalog");
  assert.equal(catalog.status, 200);
  const capabilities = (await catalog.json()).capabilities;
  assert.equal(capabilities.length, 4);
  assert.ok(capabilities.every((item) => item.dispatchable === false && item.adapter_status === "local_only"));
  for (const capability_id of ["english_coach.text", "english_coach.transcribe", "english_coach.speech", "english_coach.assess"]) {
    const response = await app.request("http://localhost/api/v1/capability-orders", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `new-${capability_id}-0001` },
      body: JSON.stringify({ capability_id, parameters: {} }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "CAPABILITY_LOCAL_ONLY");
  }
  const upload = await app.request("http://localhost/api/v1/capability-assets/presign", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "recording.wav", content_type: "audio/wav", bytes: 100, sha256: "A".repeat(64) }),
  });
  assert.equal(upload.status, 409);
  assert.equal((await upload.json()).code, "CAPABILITY_LOCAL_ONLY");
  const nonEnglishReport = {
    capability_id: "qwen_image_2_1.text_to_image", protocol_version: CAPABILITY_ORDER_PROTOCOL,
    installed: true, validated: true, enabled: true,
    validation: { tested_at: new Date().toISOString(), artifact_sha256: "A".repeat(64) },
  };
  assert.equal(normalizeCapabilityReport(nonEnglishReport).capabilityId, nonEnglishReport.capability_id);
});

test("已建英语订单的原节点能力仅在历史生命周期中可继续上报", () => {
  for (const capability_id of ["english_coach.transcribe", "english_coach.speech"]) {
    const report = {
      capability_id, protocol_version: CAPABILITY_ORDER_PROTOCOL, installed: true, validated: true, enabled: true,
      validation: { tested_at: new Date().toISOString(), artifact_sha256: "B".repeat(64) },
    };
    assert.throws(() => normalizeCapabilityReport(report), (error) => error.code === "CAPABILITY_LOCAL_ONLY");
    assert.equal(normalizeCapabilityReport(report, new Date(), { allowLegacyEnglishOrders: true }).capabilityId, capability_id);
  }
});

test("英语教练免费模型接口只公布 GLM-4-Flash 且未登录不能调用", async () => {
  const app = new OpenAPIHono();
  registerPearApiRoutes(app, { authenticate: async () => null, requireAdmin: async () => null, requireTrustedMutation: () => null });
  const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  const base = "/api/v1/desktop/english-coach/llm";
  assert.ok(document.paths[`${base}/config`]?.get);
  assert.ok(document.paths[`${base}/chat`]?.post);
  assert.match(document.paths[`${base}/chat`].post.description, /不下发共享凭据/);
  assert.equal((await app.request(`http://localhost${base}/config`)).status, 401);
  const headers = { "content-type": "application/json", authorization: "Bearer wrong_token" };
  const blockedModel = await app.request(`http://localhost${base}/chat`, { method: "POST", headers, body: JSON.stringify({ model: "minimax-m3", messages: [{ role: "user", content: "hello" }] }) });
  assert.equal(blockedModel.status, 400);
  const unauthenticated = await app.request(`http://localhost${base}/chat`, { method: "POST", headers, body: JSON.stringify({ model: "glm-4-flash-250414", messages: [{ role: "user", content: "hello" }] }) });
  assert.equal(unauthenticated.status, 401);
});
