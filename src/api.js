import { localizeErrorMessage } from "../shared/error-messages.js";

export class ApiError extends Error {
  constructor(message, code = "API_ERROR", status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export async function localizedFetch(path, options = {}) {
  try {
    return await fetch(path, options);
  } catch (error) {
    throw new ApiError(localizeErrorMessage(error, "网络连接失败，请检查网络后重试"), "NETWORK_ERROR", 0);
  }
}

export { localizeErrorMessage };

export async function apiFetch(path, options = {}) {
  const response = await localizedFetch(path, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const contentType = response.headers.get("content-type") || "";
  let payload;
  try {
    payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
  } catch {
    throw new ApiError("服务返回的数据格式不正确，请稍后重试", "INVALID_RESPONSE", response.status);
  }

  if (!response.ok) {
    const nestedMessage = payload && typeof payload === "object" ? payload.error?.message : "";
    const validationFallback = payload?.error?.name === "ZodError"
      ? "请检查填写内容是否正确"
      : "";
    const candidate = payload?.message
        || validationFallback
        || (typeof nestedMessage === "string" && nestedMessage.trim() ? nestedMessage : "")
        || (typeof payload === "string" && payload.trim() ? payload : "")
        || "请求失败，请稍后重试";
    throw new ApiError(
      localizeErrorMessage(candidate),
      payload?.code || "API_ERROR",
      response.status,
    );
  }
  return payload;
}

export function formatMoney(fen) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: Number(fen) % 100 === 0 ? 0 : 2,
  }).format(Number(fen || 0) / 100);
}

function analyticsId(storage, key) {
  try {
    const current = storage.getItem(key);
    if (current) return current;
    const generated = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
      || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    storage.setItem(key, generated);
    return generated;
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

function analyticsSource(url) {
  if (url.searchParams.get("utm_source")) return "CAMPAIGN";
  if (!document.referrer) return "DIRECT";
  try {
    const referrer = new URL(document.referrer);
    if (referrer.origin === url.origin) return "DIRECT";
    if (/(baidu|bing|google|sogou|so\.com|duckduckgo)\./i.test(referrer.hostname)) return "SEARCH";
    if (/(weixin|wechat|weibo|douyin|xiaohongshu|bilibili|zhihu)\./i.test(referrer.hostname)) return "SOCIAL";
    return "REFERRAL";
  } catch {
    return "DIRECT";
  }
}

function analyticsDevice() {
  const agent = navigator.userAgent || "";
  if (/ipad|tablet/i.test(agent) || (navigator.maxTouchPoints > 1 && window.innerWidth >= 700 && window.innerWidth < 1100)) return "TABLET";
  if (/mobile|android|iphone/i.test(agent) || window.innerWidth < 700) return "MOBILE";
  return "DESKTOP";
}

export function trackAnalyticsEvent(eventType, { path } = {}) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const payload = {
    eventType,
    visitorId: analyticsId(window.localStorage, "gulong-analytics-visitor"),
    sessionId: analyticsId(window.sessionStorage, "gulong-analytics-session"),
    path: path || `${url.pathname}${url.search}`,
    source: analyticsSource(url),
    deviceType: analyticsDevice(),
    referrer: (() => { try { return document.referrer ? new URL(document.referrer).origin : null; } catch { return null; } })(),
    utmSource: url.searchParams.get("utm_source"),
  };
  void fetch("/api/analytics/events", {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
