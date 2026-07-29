export class ApiError extends Error {
  constructor(message, code = "API_ERROR", status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new ApiError(
      payload?.message || "请求失败，请稍后重试",
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
