// WorkLucky is included in the existing subscription, never a second billing SKU.
export const WORKLUCKY_PRODUCT_ID = "worklucky";
export const WORKLUCKY_ROOT = "/api/v1/desktop/worklucky";
export const WORKLUCKY_ORIGIN = "https://www.sologle.com";
export const WORKLUCKY_PLAN_ID = "gulong_engine_monthly";
export const WORKLUCKY_CAPABILITY_IDS = Object.freeze([
  "gulong_engine.text", "gulong_engine.image", "gulong_engine.image_2k", "gulong_engine.tts", "gulong_engine.video",
  "gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music",
]);

export function workLuckyEntitlement(value) {
  const eligible = value?.product === "gulong_engine" && value?.plan_id === WORKLUCKY_PLAN_ID;
  const active = eligible && value.active === true && value.status === "active";
  return {
    product: WORKLUCKY_PRODUCT_ID, plan_id: WORKLUCKY_PLAN_ID, active,
    status: eligible ? value.status : "inactive",
    starts_at: eligible ? value.starts_at : null, expires_at: eligible ? value.expires_at : null,
    capabilities: active ? ["worklucky.use", ...WORKLUCKY_CAPABILITY_IDS] : [],
    monthly_price_fen: eligible && Number.isSafeInteger(value.monthly_price_fen) ? value.monthly_price_fen : null,
  };
}

export function workLuckyConfig(monthlyPriceFen) {
  if (!Number.isSafeInteger(monthlyPriceFen) || monthlyPriceFen <= 0) throw new Error("Missing authoritative Gulong Engine price");
  return {
    schema_version: "worklucky-product-v1", product_id: WORKLUCKY_PRODUCT_ID,
    product: WORKLUCKY_PRODUCT_ID, name: "WorkLucky", protocol_version: "worklucky-desktop-v1",
    subscription: { plan_id: WORKLUCKY_PLAN_ID, monthly_price_fen: monthlyPriceFen, included_in_plan: true, separate_purchase: false },
    auth: { login: `${WORKLUCKY_ROOT}/auth/login`, refresh: `${WORKLUCKY_ROOT}/auth/refresh`, logout: `${WORKLUCKY_ROOT}/auth/logout`, account: `${WORKLUCKY_ROOT}/account` },
    capability_orders: {
      catalog: "/api/v1/capability-orders/catalog?product=worklucky", create: "/api/v1/capability-orders",
      product: WORKLUCKY_PRODUCT_ID, capability_ids: [...WORKLUCKY_CAPABILITY_IDS],
      pricing: "zero_price_shared_only", video: "adapter_required",
      availability_source: "authenticated_catalog", execution_requires: "verified_consumer_contract",
      paid_fallback: false,
    },
    updates: { endpoint: `${WORKLUCKY_ORIGIN}${WORKLUCKY_ROOT}/updates`, signature_algorithm: "worklucky-ed25519-sha256-v1" },
    updates_url: `${WORKLUCKY_ROOT}/updates`,
  };
}

export function workLuckyUpdates() {
  // This endpoint must remain no_update until a separately verified WorkLucky
  // executable manifest is published. An upstream source tag is not an EXE.
  return { product_id: WORKLUCKY_PRODUCT_ID, product: WORKLUCKY_PRODUCT_ID, status: "no_update", release: null, reason: "release_not_published" };
}

export function capabilityProducts(capabilityId) {
  return WORKLUCKY_CAPABILITY_IDS.includes(capabilityId) ? ["gulong_engine", WORKLUCKY_PRODUCT_ID] : [];
}

// Keep legacy fingerprints byte-for-byte unchanged when the optional marker
// is absent; a marked WorkLucky request has a different idempotency identity.
export function withClientProductFingerprint(value, clientProduct) {
  return clientProduct ? { ...value, clientProduct } : value;
}

// Check before returning even a cancellation tombstone for a reused key.
export function clientProductConflicts(existingOrder, clientProduct) {
  return (existingOrder?.clientProduct ?? null) !== (clientProduct ?? null);
}
