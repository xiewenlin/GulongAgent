export const DIGITAL_LIVE_PRODUCT_ID = "digital_live";
export const DIGITAL_LIVE_TEXT_MODEL = "qwen38-27b-uncensored";
export const DIGITAL_LIVE_CAPABILITY_IDS = Object.freeze([
  "gulong_engine.agent_chat", "qwen_image_2_1.text_to_image", "qwen_image_2_1.multi_image_edit",
  "gulong_engine.image_2k", "whisper.transcribe", "gulong_engine.tts",
]);
export const isDigitalLiveCapability = (id) => DIGITAL_LIVE_CAPABILITY_IDS.includes(id);
export function digitalLiveModelAllowed(capabilityId, model) {
  if (!model || typeof model.id !== "string") return false;
  if (capabilityId === "gulong_engine.agent_chat") return model.id === DIGITAL_LIVE_TEXT_MODEL;
  if (capabilityId.startsWith("qwen_image_2_1.")) return ["qwen-image21-uc", "qwen_image_2_1"].includes(model.id);
  if (capabilityId === "gulong_engine.image_2k") return model.id === "qwen_image_2_1";
  if (capabilityId === "whisper.transcribe") return model.id === "whisper-large-v3-turbo";
  return capabilityId === "gulong_engine.tts" && typeof model.voice_id === "string" && model.voice_id.length > 0;
}
export function digitalLiveReport(report) {
  if (report?.automaticVerification !== true || report?.trustedAcceptance !== true || !isDigitalLiveCapability(report.capabilityId)) return null;
  const models = (report.models || []).filter((model) => digitalLiveModelAllowed(report.capabilityId, model));
  if (!models.length) return null;
  return { ...report, models, supportedModels: [...new Set(models.map((model) => model.id))],
    supportedVoices: [...new Set(models.map((model) => model.voice_id).filter(Boolean))],
    defaultModel: models.some((model) => model.id === report.defaultModel) ? report.defaultModel : models[0].id };
}
export function digitalLiveAvailability(capabilityId, reports) {
  if (!["gulong_engine.agent_chat", "gulong_engine.image_2k", "gulong_engine.tts", "qwen_image_2_1.text_to_image"].includes(capabilityId)) return {};
  const matrix = new Map();
  for (const report of reports) for (const model of digitalLiveReport(report)?.models || []) {
    const key = JSON.stringify(Object.fromEntries(Object.entries(model).sort(([a], [b]) => a.localeCompare(b))));
    matrix.set(key, model);
  }
  return { models: [...matrix.values()] };
}
export function digitalLiveParameterError(capabilityId, parameters, raw = parameters) {
  if (!isDigitalLiveCapability(capabilityId)) return "数字直播尚未接通该能力，请从本产品的真实能力目录选择";
  if (capabilityId === "gulong_engine.agent_chat" && (parameters.model !== DIGITAL_LIVE_TEXT_MODEL || parameters.request?.model !== DIGITAL_LIVE_TEXT_MODEL)) {
    return "数字直播文本模型必须精确选择 qwen38-27b-uncensored，不会自动替换为其他模型";
  }
  if (capabilityId === "gulong_engine.image_2k" && parameters.model !== "qwen_image_2_1") return "数字直播图像仅支持已实测的 Qwen-Image 模型";
  if (capabilityId === "gulong_engine.tts" && (typeof raw?.model !== "string" || !raw.model.trim() || typeof raw?.voice_id !== "string" || !raw.voice_id.trim())) {
    return "请从真实目录选择同一条已验收的配音模型与音色，不能省略或自动猜测";
  }
  return null;
}
export function digitalLiveNodeMatchesOrder(report, order) {
  if (order.clientProduct !== DIGITAL_LIVE_PRODUCT_ID) return true;
  if (report?.capabilityId !== order.capabilityId) return false;
  const accepted = digitalLiveReport(report);
  if (!accepted || digitalLiveParameterError(order.capabilityId, order.parameters || {}) && !order.catalogProbe) return false;
  if (order.catalogProbe) return true;
  return accepted.models.some((model) => (!order.parameters?.model || model.id === order.parameters.model)
    && (order.capabilityId !== "gulong_engine.tts" || model.voice_id === order.parameters.voice_id));
}
export function digitalLiveConfig(monthlyPriceFen) {
  if (!Number.isSafeInteger(monthlyPriceFen) || monthlyPriceFen <= 0) throw new Error("Missing authoritative Gulong Engine price");
  return { schema_version: "digital-live-product-v1", product: DIGITAL_LIVE_PRODUCT_ID, product_id: DIGITAL_LIVE_PRODUCT_ID, name: "数字直播",
    subscription: { plan_id: "gulong_engine_monthly", monthly_price_fen: monthlyPriceFen, required_capability: "digital_live.use", included_in_plan: true, separate_purchase: false },
    auth: { login: "/api/v1/desktop/gulong-engine/auth/login", refresh: "/api/v1/desktop/gulong-engine/auth/refresh", logout: "/api/v1/desktop/gulong-engine/auth/logout", account: "/api/v1/desktop/gulong-engine/account" },
    capability_orders: { product: DIGITAL_LIVE_PRODUCT_ID, catalog: "/api/v1/capability-orders/catalog?product=digital_live", create: "/api/v1/capability-orders",
      capability_ids: [...DIGITAL_LIVE_CAPABILITY_IDS], pricing: "zero_price_shared_only", paid_fallback: false, availability_source: "authenticated_catalog",
      text_model: DIGITAL_LIVE_TEXT_MODEL, image_family: "Qwen-Image", idempotency: "Idempotency-Key or identical client_request_id; persist before sending" },
    realtime: { status: "integration_required", session_url: null, interrupt_url: null, media_transport: null,
      reason: "当前仅有异步共享订单；连续实时音视频、会话型流式传输、打断及背压尚未接通" },
    avatar: { status: "integration_required", dispatchable: false }, highlights: { status: "integration_required", dispatchable: false } };
}
