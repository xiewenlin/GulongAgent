import { ObjectId } from "mongodb";
import { getCollection } from "./db.js";
import { readExternalAuth, sealExternalAuth } from "./security.js";

const DEFAULT_BASE_URL = "https://api.chandler.work";
const DEFAULT_APPLICATION_ID = "cm_89be865af1af48f4a83406f0cf1a472e";

export class ChandlerError extends Error {
  constructor(message, { status = 502, code = "CHANDLER_ERROR", detail } = {}) {
    super(message);
    this.name = "ChandlerError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function chandlerConfig() {
  return {
    baseUrl: (process.env.CHANDLER_API_BASE || DEFAULT_BASE_URL).replace(/\/$/, ""),
    applicationId: process.env.CHANDLER_APPLICATION_ID?.trim() || DEFAULT_APPLICATION_ID,
    monthlyPriceFen: Number(process.env.CHANDLER_MONTHLY_PRICE_FEN || 29_800),
    yearlyPriceFen: Number(process.env.CHANDLER_YEARLY_PRICE_FEN || 298_000),
  };
}

function friendlyMessage(status, payload) {
  const code = payload?.error?.code || payload?.code || "";
  const raw = payload?.error?.message || payload?.message || "";
  if (status === 401) return "登录已失效，请重新登录";
  if (status === 403) return "当前账号没有执行该操作的 Chandler 权限";
  if (status === 409) return "该账号、订单或操作已存在，请刷新后查看";
  if (status === 428) return "该账号已启用多因素认证，请先在 Chandler 完成验证";
  if (status === 429) return "操作过于频繁，请稍后重试";
  if (status >= 500) return "Chandler 服务暂时不可用，请稍后重试";
  return raw || code || "Chandler 请求失败";
}

export async function chandlerRequest(path, {
  method = "GET",
  accessToken,
  apiKey,
  body,
} = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (apiKey) headers["X-API-Key"] = apiKey;
  let response;
  try {
    response = await fetch(`${chandlerConfig().baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ChandlerError("无法连接 Chandler，请检查网络后重试", { detail: error.message });
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text.slice(0, 300) }; }
  if (!response.ok) {
    throw new ChandlerError(friendlyMessage(response.status, payload), {
      status: response.status,
      code: payload?.error?.code || payload?.code || "CHANDLER_ERROR",
      detail: payload,
    });
  }
  return payload?.data ?? payload;
}

export function registerWithChandler({ email, username, password, displayName, inviteCode }) {
  return chandlerRequest("/v1/auth/register", {
    method: "POST",
    body: {
      email: email.trim(),
      password,
      display_name: (displayName || username || email.split("@")[0]).trim(),
      ...(username ? { username: username.trim() } : {}),
      ...(inviteCode ? { invite_code: inviteCode.trim() } : {}),
      agree_policies: true,
      client_version: "gulong-web-1.1",
      device_type: "web",
    },
  });
}

export function loginWithChandler(identifier, password) {
  return chandlerRequest("/v1/auth/login", {
    method: "POST",
    body: { email: identifier.trim(), password, device_type: "web" },
  });
}

export function logoutFromChandler(refreshToken) {
  return chandlerRequest("/v1/auth/logout", {
    method: "POST",
    body: { refresh_token: refreshToken },
  });
}

export async function upsertChandlerUser(chandlerUser, { username } = {}) {
  const users = await getCollection("users");
  const releaseAssignment = await (await getCollection("releaseAssignments")).findOne({ chandlerUserId: chandlerUser.id });
  const now = new Date();
  const email = chandlerUser.email?.trim() || null;
  const record = {
    chandlerUserId: chandlerUser.id,
    email,
    emailNormalized: email?.toLowerCase(),
    displayName: chandlerUser.display_name || null,
    avatar: chandlerUser.avatar || null,
    emailVerified: Boolean(chandlerUser.email_verified),
    role: chandlerUser.is_admin ? "admin" : "user",
    status: "active",
    authProvider: "chandler",
    ...(releaseAssignment?.channelId ? { releaseChannelId: releaseAssignment.channelId, releaseChannelGroupId: releaseAssignment.groupId } : {}),
    updatedAt: now,
  };
  if (username) {
    record.username = username.trim();
    record.usernameNormalized = username.trim().toLowerCase();
  }
  const result = await users.findOneAndUpdate(
    { chandlerUserId: chandlerUser.id },
    { $set: record, $setOnInsert: { createdAt: now } },
    { upsert: true, returnDocument: "after" },
  );
  return result;
}

function accessExpiresAt(auth) {
  return Date.now() + Math.max(60, Number(auth.expires_in || 3600)) * 1000;
}

export function externalAuthFromResponse(auth) {
  return {
    provider: "chandler",
    accessToken: auth.access_token,
    refreshToken: auth.refresh_token,
    accessExpiresAt: accessExpiresAt(auth),
    chandlerUserId: auth.user?.id,
  };
}

export async function getChandlerAccessToken(session, { forceRefresh = false } = {}) {
  let auth = readExternalAuth(session);
  if (!auth || auth.provider !== "chandler") {
    throw new ChandlerError("当前会话不是 Chandler 统一账号", { status: 401, code: "CHANDLER_SESSION_REQUIRED" });
  }
  if (!forceRefresh && auth.accessToken && auth.accessExpiresAt > Date.now() + 60_000) {
    return auth.accessToken;
  }
  const refreshed = await chandlerRequest("/v1/auth/refresh", {
    method: "POST",
    body: { refresh_token: auth.refreshToken },
  });
  auth = {
    ...auth,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || auth.refreshToken,
    accessExpiresAt: accessExpiresAt(refreshed),
  };
  await (await getCollection("sessions")).updateOne(
    { _id: new ObjectId(session._id) },
    { $set: { externalAuth: sealExternalAuth(auth), lastSeenAt: new Date() } },
  );
  return auth.accessToken;
}

export async function listCatalogPlans() {
  const catalog = await chandlerRequest("/v1/catalog/products?product_type=subscription");
  const products = catalog?.products || [];
  const plans = [];
  for (const product of products) {
    const detail = await chandlerRequest(`/v1/catalog/products/${encodeURIComponent(product.id)}`);
    for (const skuDetail of detail?.skus || []) {
      const price = skuDetail.active_price;
      if (!price) continue;
      plans.push({
        productId: detail.product?.id || product.id,
        productName: detail.product?.name || product.name,
        skuId: skuDetail.sku?.id,
        skuName: skuDetail.sku?.name,
        skuType: skuDetail.sku?.sku_type,
        amountFen: price.amount,
        currency: price.currency,
        billingInterval: price.billing_interval,
      });
    }
  }
  return plans.sort((a, b) => a.amountFen - b.amountFen);
}

export async function createSubscriptionCheckout(accessToken, { cycle, channel, source = "gulong-web" }) {
  const config = chandlerConfig();
  const plans = await listCatalogPlans();
  const marker = cycle === "year" ? "year" : "month";
  const expected = cycle === "year" ? config.yearlyPriceFen : config.monthlyPriceFen;
  const plan = plans.find((item) => `${item.skuType} ${item.billingInterval}`.toLowerCase().includes(marker));
  if (!plan) throw new ChandlerError("Chandler 当前没有可用的对应订阅套餐", { status: 503, code: "PLAN_NOT_CONFIGURED" });
  if (plan.amountFen !== expected) {
    throw new ChandlerError(`Chandler 当前价格为 ¥${(plan.amountFen / 100).toFixed(2)}，尚未更新到官网目标价格 ¥${(expected / 100).toFixed(2)}`, { status: 409, code: "PRICE_VERSION_MISMATCH" });
  }
  const checkout = await chandlerRequest("/v1/checkout/subscriptions", {
    method: "POST",
    accessToken,
    body: {
      sku_id: plan.skuId,
      quantity: 1,
      channel,
      application_id: config.applicationId,
      source,
      partner_data: {
        schema_version: 1,
        application_key: "gulong-web",
        product_id: plan.productId,
        product_name: plan.productName,
        sku_id: plan.skuId,
        sku_name: plan.skuName,
      },
    },
  });
  const orderNo = checkout.order_no || checkout.platform_order_no;
  const prepay = await chandlerRequest(`/v1/pay/orders/${encodeURIComponent(orderNo)}/prepay`, {
    method: "POST",
    accessToken,
    body: {},
  });
  return { checkout, prepay, plan, orderNo };
}

export async function createDirectPaymentOrder(accessToken, {
  merchantOrderNo,
  channel,
  amountFen,
  subject,
  source,
  partnerData,
  prepay = true,
}) {
  const config = chandlerConfig();
  const order = await chandlerRequest("/v1/pay/orders", {
    method: "POST",
    accessToken,
    body: {
      application_id: config.applicationId,
      merchant_order_no: merchantOrderNo,
      channel,
      amount: amountFen,
      currency: "CNY",
      subject,
      source,
      partner_data: partnerData,
    },
  });
  const orderNo = order.platform_order_no || order.order_no;
  const payment = prepay ? await chandlerRequest(`/v1/pay/orders/${encodeURIComponent(orderNo)}/prepay`, {
    method: "POST",
    accessToken,
    body: {},
  }) : null;
  return { order, payment, orderNo };
}

export function issueOfflineCredential(accessToken, installId) {
  return chandlerRequest("/v1/me/entitlements/offline-credential", {
    method: "POST",
    accessToken,
    body: installId ? { install_id: installId } : {},
  });
}
