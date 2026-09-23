import assert from "node:assert/strict";
import test from "node:test";
import {
  GULONG_ENGINE_MONTHLY_PRICE_FEN,
  GULONG_ENGINE_PLAN_ID,
  GULONG_ENGINE_PRODUCT,
  buildProductPeriodPatch,
  gulongEngineEntitlement,
  legacyAccessSubscription,
  subscriptionProducts,
} from "../../server/english-coach-products.js";
import {
  GULONG_ENGINE_CAPABILITY_DEFINITIONS,
  gulongEngineNodeSharesCapability,
  validateGulongEngineInlineResult,
} from "../../server/gulong-engine-capabilities.js";
import { normalizeCapabilityParameters, normalizeCapabilityReport } from "../../server/capability-orders.js";

const now = new Date("2026-09-24T08:00:00.000Z");
const period = { currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), enabled: true, status: "active" };

test("古龙引擎包月有独立 198 元权益，不伪装普通会员或为钱包充值", () => {
  assert.equal(GULONG_ENGINE_PLAN_ID, "gulong_engine_monthly");
  assert.equal(GULONG_ENGINE_MONTHLY_PRICE_FEN, 19_800);
  assert.equal(GULONG_ENGINE_PRODUCT.name, "古龙引擎包月");
  assert.equal(GULONG_ENGINE_PRODUCT.yearlyFen, null);
  const subscription = { plan: GULONG_ENGINE_PLAN_ID, products: { [GULONG_ENGINE_PLAN_ID]: period } };
  const entitlement = gulongEngineEntitlement(subscription, now);
  assert.equal(entitlement.active, true);
  assert.deepEqual(entitlement.capabilities, ["pearapi.free_text", "gulong_engine.text", "gulong_engine.image", "gulong_engine.video"]);
  assert.equal(legacyAccessSubscription(subscription, now).status, "inactive");
  assert.equal(subscriptionProducts(subscription, now).find((item) => item.id === GULONG_ENGINE_PLAN_ID).status, "active");
  const expired = gulongEngineEntitlement(subscription, new Date("2026-10-02T00:00:00.000Z"));
  assert.equal(expired.active, false);
  assert.deepEqual(expired.capabilities, []);
});

test("管理员单独调整古龙引擎有效期不会覆盖英语教练或普通会员", () => {
  const previous = { plan: "member", products: { member: period, english_coach_monthly: period } };
  const patch = buildProductPeriodPatch(previous, [
    { id: GULONG_ENGINE_PLAN_ID, enabled: true, currentPeriodStart: "2026-09-24T08:00:00Z", currentPeriodEnd: "2026-10-24T08:00:00Z" },
  ], {}, now);
  assert.deepEqual(Object.keys(patch), ["products.gulong_engine_monthly"]);
  assert.equal(gulongEngineEntitlement({ products: { [GULONG_ENGINE_PLAN_ID]: patch["products.gulong_engine_monthly"] } }, now).active, true);
});

test("绿色版能力价格固定 0 分，视频在真实适配器上线前不可派单", () => {
  assert.deepEqual(GULONG_ENGINE_CAPABILITY_DEFINITIONS.map((item) => item.capabilityId), ["gulong_engine.text", "gulong_engine.image", "gulong_engine.video"]);
  assert.ok(GULONG_ENGINE_CAPABILITY_DEFINITIONS.every((item) => item.priceFen === 0 && item.sharingScope === "gulong_shared"));
  const video = GULONG_ENGINE_CAPABILITY_DEFINITIONS.find((item) => item.capabilityId === "gulong_engine.video");
  assert.equal(video.dispatchable, false);
  assert.equal(video.adapterStatus, "adapter_required");
  const image = GULONG_ENGINE_CAPABILITY_DEFINITIONS.find((item) => item.capabilityId === "gulong_engine.image");
  assert.deepEqual(image.parametersSchema.properties.model.enum, ["zimage", "qwen_image_2_1"]);
  const parameters = normalizeCapabilityParameters({ model: "zimage", prompt: "真实测试" }, image);
  assert.equal(parameters.width, 1024);
  assert.throws(() => normalizeCapabilityParameters({ model: "unknown", prompt: "test" }, image), (error) => error.code === "INVALID_CAPABILITY_PARAMETERS");
});

test("跨账户共享需要显式同意和真实验证；文本结果拒绝空值与超限内容", () => {
  const capabilityId = "gulong_engine.text";
  const report = {
    capability_id: capabilityId, protocol_version: "gulong-capability-orders-v1", installed: true,
    validated: true, enabled: true, sharing_opt_in: true, max_concurrent: 1,
    validation: { tested_at: new Date().toISOString(), artifact_sha256: "A".repeat(64) },
  };
  const shared = normalizeCapabilityReport(report);
  assert.equal(shared.sharingOptIn, true);
  assert.equal(gulongEngineNodeSharesCapability({ capabilities: [shared] }, capabilityId), true);
  assert.equal(normalizeCapabilityReport({ ...report, sharing_opt_in: false }).sharingOptIn, false);
  assert.equal(gulongEngineNodeSharesCapability({ capabilities: [{ ...shared, sharingOptIn: false }] }, capabilityId), false);
  assert.equal(validateGulongEngineInlineResult(capabilityId, { text: "有效结果" }), true);
  assert.equal(validateGulongEngineInlineResult(capabilityId, { text: "" }), false);
  assert.equal(validateGulongEngineInlineResult(capabilityId, { text: "x".repeat(65_000) }), false);
});
