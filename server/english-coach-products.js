import { ObjectId } from "mongodb";
import { getCollection as databaseCollection } from "./db.js";
import { SHORT_VIDEO_MONTHLY_PRICE_FEN, SHORT_VIDEO_YEARLY_PRICE_FEN } from "./short-video-subscription.js";

export const ENGLISH_COACH_PLAN_ID = "english_coach_monthly";
export const ENGLISH_COACH_PLAN_NAME = "英语教练包月";
export const ENGLISH_COACH_MONTHLY_PRICE_FEN = 19_800;
export const GULONG_ENGINE_PLAN_ID = "gulong_engine_monthly";
export const GULONG_ENGINE_MONTHLY_PRICE_FEN = 19_800;
export const GULONG_ENGINE_PRODUCT = Object.freeze({ id: GULONG_ENGINE_PLAN_ID, name: "古龙引擎包月", monthlyFen: GULONG_ENGINE_MONTHLY_PRICE_FEN, yearlyFen: null, paymentProviders: ["offline"], autoRenew: false, renewalMode: "manual" });
export const SUBSCRIPTION_PRODUCT_IDS = Object.freeze(["member", "short_video_monthly", ENGLISH_COACH_PLAN_ID, GULONG_ENGINE_PLAN_ID]);
export const ENGLISH_COACH_PRODUCT = Object.freeze({ id: ENGLISH_COACH_PLAN_ID, name: ENGLISH_COACH_PLAN_NAME, monthlyFen: ENGLISH_COACH_MONTHLY_PRICE_FEN, yearlyFen: null, paymentProviders: ["offline"], autoRenew: false, renewalMode: "manual" });
const NAMES = { member: "普通会员", short_video_monthly: "短视频包月", [ENGLISH_COACH_PLAN_ID]: ENGLISH_COACH_PLAN_NAME, [GULONG_ENGINE_PLAN_ID]: "古龙引擎包月" };
const CAPABILITIES = Object.freeze(["text", "speech", "transcribe", "assess"]);

export function productSubscription(subscription, id) {
  if (!SUBSCRIPTION_PRODUCT_IDS.includes(id)) return null;
  const independent = subscription?.products?.[id];
  if (independent && typeof independent === "object" && !Array.isArray(independent)) {
    return { ...independent, plan: id, ownerId: subscription.ownerId, _id: subscription._id };
  }
  return subscription && (subscription.plan || "member") === id ? subscription : null;
}

export function productPeriodStatus(product, now = new Date()) {
  if (!product || product.enabled === false || ["cancelled", "canceled", "revoked"].includes(product.status)) return "inactive";
  const start = new Date(product.currentPeriodStart || 0);
  const end = new Date(product.currentPeriodEnd || 0);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return "inactive";
  if (end <= now) return "expired";
  return start > now ? "scheduled" : "active";
}

export function subscriptionProducts(subscription, now = new Date()) {
  return SUBSCRIPTION_PRODUCT_IDS.map((id) => {
    const product = productSubscription(subscription, id);
    return {
      id, name: NAMES[id], status: productPeriodStatus(product, now),
      enabled: Boolean(product && product.enabled !== false && !["cancelled", "canceled", "revoked"].includes(product.status)),
      currentPeriodStart: product?.currentPeriodStart || null,
      currentPeriodEnd: product?.currentPeriodEnd || null,
      monthlyFen: id === ENGLISH_COACH_PLAN_ID ? ENGLISH_COACH_MONTHLY_PRICE_FEN : id === GULONG_ENGINE_PLAN_ID ? GULONG_ENGINE_MONTHLY_PRICE_FEN : id === "short_video_monthly" ? SHORT_VIDEO_MONTHLY_PRICE_FEN : null,
      yearlyFen: id === "short_video_monthly" ? SHORT_VIDEO_YEARLY_PRICE_FEN : null,
      cycle: product?.cycle || ([ENGLISH_COACH_PLAN_ID, GULONG_ENGINE_PLAN_ID].includes(id) ? "month" : null),
      autoRenew: false,
    };
  });
}

export function englishEntitlement(subscription, now = new Date()) {
  const product = productSubscription(subscription, ENGLISH_COACH_PLAN_ID);
  const status = productPeriodStatus(product, now);
  return {
    product: "english_coach", plan_id: ENGLISH_COACH_PLAN_ID, active: status === "active", status,
    starts_at: product?.currentPeriodStart || null, expires_at: product?.currentPeriodEnd || null,
    capabilities: status === "active" ? [...CAPABILITIES] : [],
    monthly_price_fen: ENGLISH_COACH_MONTHLY_PRICE_FEN,
  };
}

export function gulongEngineEntitlement(subscription, now = new Date()) {
  const product = productSubscription(subscription, GULONG_ENGINE_PLAN_ID);
  const status = productPeriodStatus(product, now);
  return {
    product: "gulong_engine", plan_id: GULONG_ENGINE_PLAN_ID, active: status === "active", status,
    starts_at: product?.currentPeriodStart || null, expires_at: product?.currentPeriodEnd || null,
    capabilities: status === "active" ? ["pearapi.free_text", "gulong_engine.text", "gulong_engine.image", "gulong_engine.video"] : [],
    monthly_price_fen: GULONG_ENGINE_MONTHLY_PRICE_FEN,
  };
}

export function legacyAccessSubscription(subscription, now = new Date()) {
  if (!subscription) return null;
  if (!subscription.products && ![ENGLISH_COACH_PLAN_ID, GULONG_ENGINE_PLAN_ID].includes(subscription.plan)) return subscription;
  const candidates = ["member", "short_video_monthly"].map((id) => productSubscription(subscription, id)).filter(Boolean);
  const selected = candidates.find((product) => productPeriodStatus(product, now) === "active")
    || candidates.find((product) => product.plan === subscription.plan)
    || candidates.sort((a, b) => new Date(b.currentPeriodEnd || 0) - new Date(a.currentPeriodEnd || 0))[0];
  if (!selected) return { ...subscription, plan: "member", status: "inactive", currentPeriodStart: null, currentPeriodEnd: null };
  const inactive = selected.enabled === false || ["cancelled", "canceled", "revoked"].includes(selected.status);
  return { ...subscription, ...selected, products: subscription.products, status: productPeriodStatus(selected, now),
    ...(inactive ? { currentPeriodStart: null, currentPeriodEnd: null } : {}) };
}

export async function readEnglishEntitlement(ownerId, now = new Date(), collectionProvider = databaseCollection) {
  if (!ObjectId.isValid(ownerId)) return englishEntitlement(null, now);
  const subscription = await (await collectionProvider("subscriptions")).findOne({ ownerId: new ObjectId(ownerId) });
  return englishEntitlement(subscription, now);
}

export async function readGulongEngineEntitlement(ownerId, now = new Date(), collectionProvider = databaseCollection) {
  if (!ObjectId.isValid(ownerId)) return gulongEngineEntitlement(null, now);
  const subscription = await (await collectionProvider("subscriptions")).findOne({ ownerId: new ObjectId(ownerId) });
  return gulongEngineEntitlement(subscription, now);
}

function periodError(message) {
  return Object.assign(new Error(message), { code: "INVALID_SUBSCRIPTION_PERIOD", status: 400 });
}

// Deliberately returns dot-path fields, never a whole products replacement.
export function buildProductPeriodPatch(previous, products, metadata = {}, now = new Date()) {
  if (!Array.isArray(products) || products.length < 1 || products.length > SUBSCRIPTION_PRODUCT_IDS.length) {
    throw periodError("请选择本次修改的产品及各自有效期");
  }
  const fields = {};
  const legacyId = previous?.plan || "member";
  if (previous && SUBSCRIPTION_PRODUCT_IDS.includes(legacyId) && !previous.products?.[legacyId]
    && !products.some((product) => product?.id === legacyId)) {
    const snapshot = { ...previous };
    delete snapshot._id; delete snapshot.ownerId; delete snapshot.products;
    fields[`products.${legacyId}`] = snapshot;
  }
  const seen = new Set();
  for (const product of products) {
    if (!SUBSCRIPTION_PRODUCT_IDS.includes(product?.id) || seen.has(product.id)) throw periodError("订阅产品无效或重复");
    seen.add(product.id);
    const old = productSubscription(previous, product.id);
    if (product.enabled === false) {
      const entry = { ...old, ...metadata, plan: product.id, enabled: false, status: "cancelled", autoRenew: false, updatedAt: now };
      delete entry._id; delete entry.ownerId; delete entry.products;
      fields[`products.${product.id}`] = entry;
      continue;
    }
    const start = new Date(product.currentPeriodStart);
    const end = new Date(product.currentPeriodEnd);
    if (!product.currentPeriodStart || !product.currentPeriodEnd || !Number.isFinite(start.getTime())
      || !Number.isFinite(end.getTime()) || end <= start || end - start > 10 * 366 * 86_400_000) {
      throw periodError("每项产品的到期时间必须晚于生效时间，且最长不超过 10 年");
    }
    const entry = { ...old, ...metadata, plan: product.id, enabled: true, currentPeriodStart: start, currentPeriodEnd: end, autoRenew: false, updatedAt: now };
    delete entry._id;
    delete entry.ownerId;
    delete entry.products;
    entry.status = productPeriodStatus({ ...entry, status: "active" }, now);
    fields[`products.${product.id}`] = entry;
  }
  return fields;
}
