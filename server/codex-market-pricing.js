import { createHash } from "node:crypto";

export const CODEX_MARKET_MODELS = Object.freeze([
  { id: "longyan", name: "龙言", modality: "text", priceLabel: "0–272K：输入 ¥3.9/百万 Tokens，输出 ¥19.5/百万 Tokens；272K+：输入 ¥7.8/百万 Tokens，输出 ¥29.25/百万 Tokens" },
  { id: "longtu", name: "龙图", modality: "image", priceLabel: "¥0.14/次" },
]);
export const CODEX_MARKET_PRICING_REVISION = "desktop-20260910-v4";
export const CODEX_MARKET_MAX_JSON_BYTES = 3_000_000;
export const CODEX_MARKET_MAX_IMAGE_BYTES = 2_500_000;
export const LONGYAN_CONTEXT_TIER_THRESHOLD = 272_000;
const NANO_FEN_PER_FEN = 1_000_000_000n;
const MAX_USAGE_TOKENS = 2_000_000;

const LONGYAN_RATES = Object.freeze({
  standard: Object.freeze({
    inputTokens: 390_000,
    outputTokens: 1_950_000,
    cacheWriteTokens: 487_500,
    cacheReadTokens: 39_000,
  }),
  extended: Object.freeze({
    inputTokens: 780_000,
    outputTokens: 2_925_000,
    cacheWriteTokens: 975_000,
    cacheReadTokens: 78_000,
  }),
});

export function marketError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function marketFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeMarketImages(value = []) {
  if (!Array.isArray(value) || value.length > 4) throw marketError("INVALID_IMAGES", "最多支持 4 张图片");
  let bytes = 0;
  return value.map((image) => {
    const dataUrl = typeof image === "string" ? image : image?.dataUrl;
    const match = typeof dataUrl === "string" && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[2].length % 4 !== 0) throw marketError("INVALID_IMAGES", "图片必须是 PNG、JPEG 或 WebP 的 base64 data URL");
    const buffer = Buffer.from(match[2], "base64");
    const validMagic = match[1] === "png" ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === "jpeg" ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
    if (!validMagic || buffer.toString("base64") !== match[2]) throw marketError("INVALID_IMAGES", "图片编码或文件类型无效");
    bytes += buffer.length;
    if (bytes > CODEX_MARKET_MAX_IMAGE_BYTES) throw marketError("IMAGE_PAYLOAD_TOO_LARGE", "图片总大小超过当前共享节点接口限制", 413);
    return { dataUrl };
  });
}

export function normalizeMarketRequest(model, value = {}) {
  if (!CODEX_MARKET_MODELS.some((item) => item.id === model)) throw marketError("INVALID_MODEL", "仅支持龙言或龙图");
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt || prompt.length > 32_000) throw marketError("INVALID_PROMPT", "提示词长度必须为 1–32000 个字符");
  const images = normalizeMarketImages(value.images);
  const size = value.size == null ? "auto" : String(value.size).trim();
  if (!["auto", "1024x1024", "1024x1536", "1536x1024", "1:1", "16:9", "9:16"].includes(size)) throw marketError("INVALID_SIZE", "图片尺寸不受支持");
  const inputMessages = value.messages || [];
  if (!Array.isArray(inputMessages) || inputMessages.length > 40) throw marketError("INVALID_MESSAGES", "对话历史最多 40 条");
  let chars = prompt.length;
  const messages = inputMessages.map((message) => {
    if (!["user", "assistant"].includes(message?.role) || typeof message.content !== "string") throw marketError("INVALID_MESSAGES", "对话历史只支持 user 和 assistant 文本消息");
    chars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (chars > 64_000) throw marketError("INVALID_MESSAGES", "提示词与历史消息总长度超过限制");
  return { prompt, images, size, messages };
}

function usageInteger(value, field, { positive = false, status = 400 } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_USAGE_TOKENS) {
    throw marketError("INVALID_USAGE", `${field} 必须是 0–${MAX_USAGE_TOKENS} 范围内的整数`, status);
  }
  return value;
}

export function normalizeLongyanUsage(value, { actual = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw marketError(actual ? "CODEX_USAGE_REQUIRED" : "USAGE_LIMIT_REQUIRED", actual ? "龙言完成回调必须携带 Codex 应用服务返回的真实用量" : "龙言报价必须声明本次订单的最大计费用量", actual ? 422 : 400);
  }
  const usage = {
    inputTokens: usageInteger(value.inputTokens, "inputTokens", { status: actual ? 422 : 400 }),
    outputTokens: usageInteger(value.outputTokens, "outputTokens", { status: actual ? 422 : 400 }),
    cacheReadTokens: usageInteger(value.cacheReadTokens, "cacheReadTokens", { status: actual ? 422 : 400 }),
  };
  if (actual && ![true, false].includes(value.cacheWriteTokensMeasured)) throw marketError("USAGE_BREAKDOWN_INCOMPLETE", "请明确缓存写入用量是否由 Codex 应用服务报告", 422);
  if (actual && value.cacheWriteTokensMeasured === false && value.cacheWriteTokens !== null) throw marketError("INVALID_USAGE", "缓存写入量未报告时必须明确传 null，不能用估算值或 0 代替", 422);
  const cacheWriteTokens = actual && value.cacheWriteTokensMeasured === false
    ? null
    : usageInteger(value.cacheWriteTokens, "cacheWriteTokens", { status: actual ? 422 : 400 });
  if ([usage.inputTokens, usage.outputTokens, cacheWriteTokens || 0, usage.cacheReadTokens].every((count) => count === 0)) {
    throw marketError("INVALID_USAGE", "龙言用量不能全部为 0", actual ? 422 : 400);
  }
  if (!actual) return { ...usage, cacheWriteTokens };
  const source = String(value.source || "");
  const providerRequestId = String(value.providerRequestId || "");
  if (source !== "codex_app_server") throw marketError("INVALID_USAGE_SOURCE", "龙言真实用量必须来自 Codex 应用服务", 422);
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(providerRequestId)) throw marketError("INVALID_USAGE_RECEIPT", "龙言真实用量缺少有效的 Codex 请求编号", 422);
  return { ...usage, cacheWriteTokens, source, providerRequestId, cacheWriteTokensMeasured: value.cacheWriteTokensMeasured };
}

export function calculateLongyanAmount(usage, pricingSnapshot = null) {
  const normalized = normalizeLongyanUsage(usage, { actual: Boolean(usage?.source || usage?.providerRequestId) });
  const thresholdTokens = pricingSnapshot?.thresholdTokens || LONGYAN_CONTEXT_TIER_THRESHOLD;
  const rateTable = pricingSnapshot?.rates || LONGYAN_RATES;
  const totalInputTokens = normalized.inputTokens + (normalized.cacheWriteTokens || 0) + normalized.cacheReadTokens;
  const tier = totalInputTokens <= thresholdTokens ? "standard" : "extended";
  const rates = rateTable[tier];
  let amountNanoFen = 0n;
  for (const field of ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"]) {
    amountNanoFen += BigInt(normalized[field] || 0) * BigInt(rates[field]);
  }
  const amountFen = Number((amountNanoFen + NANO_FEN_PER_FEN - 1n) / NANO_FEN_PER_FEN);
  return {
    tier,
    thresholdTokens,
    totalInputTokens,
    amountFen,
    exactAmountNanoFen: amountNanoFen.toString(),
    ratesNanoFenPerToken: { ...rates },
  };
}

export function assertUsageWithinLimit(actual, limit) {
  const current = normalizeLongyanUsage(actual, { actual: true });
  const ceiling = normalizeLongyanUsage(limit);
  for (const field of ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"]) {
    if ((current[field] || 0) > ceiling[field]) throw marketError("USAGE_EXCEEDS_RESERVATION", `实际 ${field} 超过已授权的订单用量上限`, 409);
  }
  return current;
}

// These are the user-confirmed Gulong desktop rates, not OpenAI or PearAPI
// prices. Text quotes reserve the caller-authorized ceiling and settle only
// against the authenticated node's Codex app-server usage report.
export function readMarketPricing() {
  if (process.env.GULONG_CODEX_MARKET_DISABLED === "true") return null;
  return {
    revision: CODEX_MARKET_PRICING_REVISION,
    currency: "CNY",
    officialSourceUrl: "gulong-desktop-model-catalog",
    models: [
      { ...CODEX_MARKET_MODELS[0], executionModel: "gpt-6-astra", reasoningEffort: "low", rates: LONGYAN_RATES, thresholdTokens: LONGYAN_CONTEXT_TIER_THRESHOLD },
      { ...CODEX_MARKET_MODELS[1], executionModel: "gpt-image-2", officialAmountFen: 14 },
    ],
  };
}

export function marketQuotePrice(pricing, model, { administrator = false, usageLimit = null } = {}) {
  const rate = pricing?.models.find((item) => item.id === model);
  if (!rate) throw marketError("OFFICIAL_PRICING_UNAVAILABLE", "官网尚未配置经过核验的官方报价，暂不能创建收费订单", 503);
  const usagePricing = model === "longyan" ? calculateLongyanAmount(normalizeLongyanUsage(usageLimit)) : null;
  const officialAmountFen = usagePricing?.amountFen ?? rate.officialAmountFen;
  const chargedFen = administrator ? 0 : officialAmountFen;
  const nodeShareFen = Math.floor(chargedFen / 2);
  return {
    executionModel: rate.executionModel,
    reasoningEffort: rate.reasoningEffort || null,
    officialAmountFen,
    chargedFen,
    nodeShareFen,
    platformShareFen: chargedFen - nodeShareFen,
    pricingRevision: pricing.revision,
    currency: "CNY",
    officialSourceUrl: pricing.officialSourceUrl,
    ...(usagePricing ? { usageLimit: normalizeLongyanUsage(usageLimit), usagePricing, pricingSnapshot: { thresholdTokens: rate.thresholdTokens, rates: rate.rates } } : {}),
  };
}
