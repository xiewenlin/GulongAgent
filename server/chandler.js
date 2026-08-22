import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { getCollection } from "./db.js";
import { readExternalAuth, sealExternalAuth } from "./security.js";
import { localizeErrorMessage } from "../shared/error-messages.js";

const DEFAULT_BASE_URL = "https://api.chandler.work";
const DEFAULT_APPLICATION_ID = "cm_89be865af1af48f4a83406f0cf1a472e";
const DEFAULT_AIROS_APPLICATION_ID = "cm_8b022909f72d4daab8379517271e9658";
const BOOTSTRAP_ADMIN_EMAIL = "1186664388@qq.com";
const accessRefreshPromises = new Map();

const PRODUCT_EDITIONS = Object.freeze({
  gulong: Object.freeze({ key: "gulong", name: "古龙版" }),
  yongshenghua: Object.freeze({ key: "yongshenghua", name: "永生花版" }),
});

export function productEdition(value = "gulong") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.includes("yongshenghua") || normalized.includes("airos") || normalized.includes("永生花")
    ? PRODUCT_EDITIONS.yongshenghua
    : PRODUCT_EDITIONS.gulong;
}

export function productEditionFromChannel(channel) {
  if (!channel) return null;
  return productEdition(channel.profileKey || channel.name || (channel.themeNames || []).join(" "));
}

export function isChandlerBootstrapAdmin(user) {
  return String(user?.email || "").trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
}

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
    airosApplicationId: process.env.CHANDLER_AIROS_APPLICATION_ID?.trim() || DEFAULT_AIROS_APPLICATION_ID,
    monthlyPriceFen: Number(process.env.CHANDLER_MONTHLY_PRICE_FEN || 29_800),
    yearlyPriceFen: Number(process.env.CHANDLER_YEARLY_PRICE_FEN || 298_000),
    apiKey: process.env.GulongAgent?.trim() || process.env.CHANDLER_API_KEY?.trim() || "",
    clientSecret: process.env.CHANDLER_CLIENT_SECRET?.trim() || process.env.CHANDLER_OAUTH_CLIENT_SECRET?.trim() || "",
    webhookHmacKey: process.env.CHANDLER_WEBHOOK_HMAC_KEY?.trim() || "",
  };
}

function serverApiKey(apiKey) {
  const value = String(apiKey || chandlerConfig().apiKey || "").trim();
  if (!value) {
    throw new ChandlerError("Chandler 服务端 API Key 尚未配置", {
      status: 503,
      code: "CHANDLER_API_KEY_REQUIRED",
    });
  }
  return value;
}

function partnerCredential(accessToken) {
  const apiKey = chandlerConfig().apiKey;
  if (apiKey) return { apiKey };
  if (accessToken) return { accessToken };
  return { apiKey: serverApiKey() };
}

function partnerServiceCredential() {
  return { apiKey: serverApiKey() };
}

function prepayCredential(accessToken) {
  if (accessToken) return { accessToken };
  return partnerServiceCredential();
}

function friendlyMessage(status, payload) {
  const code = payload?.error?.code || payload?.code || "";
  const raw = payload?.error?.message || payload?.message || "";
  if (code === "catalog.sku_inactive") return "该订阅套餐已经停售，请刷新套餐列表后重试";
  if (code === "catalog.price_not_found") return "该订阅套餐当前没有生效中的价格版本";
  if (code === "catalog.sku_exists") return "当前应用中已经存在相同编码的 SKU";
  if (code === "auth.invalid_credentials") return "用户名、邮箱、手机号、密码或验证码不正确";
  if (code === "auth.otp_delivery_failed") return "验证码暂时无法发送，请稍后重试";
  if (code === "auth.sms_disabled") return "短信验证码服务暂时关闭，请改用邮箱或密码登录";
  if (code === "auth.invalid_phone") return "请输入正确的大陆手机号或 E.164 国际手机号";
  if (code === "auth.phone_register_disabled") return "当前桌面客户端暂未开通手机号注册，请联系管理员检查 Chandler OAuth 客户端配置";
  if (code === "auth.phone_taken") return "该手机号已经注册，请直接使用手机验证码登录";
  if (["auth.invalid_code", "auth.otp_invalid", "auth.otp_expired"].includes(code)) return "6 位验证码不正确或已过期，请重新获取";
  if (code === "auth.email_verification_required") return "请先完成注册邮箱验证，再绑定手机号";
  if (code === "auth.identity_taken") return "该邮箱或手机号已经绑定到其他账号";
  if (code === "auth.identity_not_found") return "没有找到这项账号身份，请刷新后重试";
  if (code === "auth.weak_password") return "统一账号服务判定密码过弱：请使用 8–255 个字符，并在小写字母、大写字母、数字、符号中至少包含三类";
  if (["auth.email_exists", "auth.user_exists", "account.exists"].includes(code)) return "该邮箱已经注册，请直接登录或找回密码";
  if (code === "token.invalid" || code === "auth.token_invalid") return "登录已失效，请重新登录";
  if (code === "client.not_found") return "支付服务端账号尚未获得当前应用的管理员或财务权限，请管理员检查 Chandler API Key 所属账号的应用角色";
  if (code === "payment.direct_contract_required") return "当前应用尚未完成 Chandler 线下合同确认，请管理员在合作伙伴后台完成确认后重试";
  if (code === "pay.openid_required") return "当前微信支付缺少付款人的微信身份，请重新登录或检查支付配置中的 AppID";
  if (code === "order.not_refundable") return "该订单当前不可退款，请检查订单状态与可退金额";
  if (code === "order.invalid" && /refund amount/i.test(raw)) return "退款金额必须大于 0，且不能超过订单可退金额";
  if (code === "request.invalid" && /malformed json/i.test(raw)) return "发送给 Chandler 的字段与当前接口契约不一致，请更新客户端后重试";
  if (status === 401) return localizeErrorMessage(raw, "登录已失效，请重新登录");
  if (status === 403) return "当前账号没有执行该操作的 Chandler 权限";
  if (status === 409) return "该账号、订单或操作已存在，请刷新后查看";
  if (status === 428) return "该账号已启用多因素认证，请先在 Chandler 完成验证";
  if (status === 429) return "操作过于频繁，请稍后重试";
  if (status >= 500) return "Chandler 服务暂时不可用，请稍后重试";
  return localizeErrorMessage(raw || code, "统一账号服务请求失败，请稍后重试");
}

export async function chandlerRequest(path, {
  method = "GET",
  accessToken,
  apiKey,
  body,
  form,
  headers: customHeaders,
  idempotencyKey,
  timeoutMs = 15_000,
} = {}) {
  const headers = { Accept: "application/json", ...(customHeaders || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (form !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey).trim();
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (apiKey) headers.Authorization = `Apikey ${apiKey}`;
  let response;
  try {
    response = await fetch(`${chandlerConfig().baseUrl}${path}`, {
      method,
      headers,
      body: form !== undefined
        ? new URLSearchParams(form).toString()
        : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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

export function chandlerServerRequest(path, options = {}) {
  return chandlerRequest(path, { ...options, accessToken: undefined, apiKey: serverApiKey(options.apiKey) });
}

export function chandlerWebhookHmacKey() {
  const config = chandlerConfig();
  if (config.webhookHmacKey) return config.webhookHmacKey.toLowerCase();
  if (config.clientSecret) return createHash("sha256").update(config.clientSecret, "utf8").digest("hex");
  throw new ChandlerError("Chandler Webhook 验签密钥尚未配置", {
    status: 503,
    code: "CHANDLER_WEBHOOK_KEY_REQUIRED",
  });
}

export function verifyChandlerWebhook(rawBody, signature) {
  const received = String(signature || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", chandlerWebhookHmacKey())
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8"))
    .digest("hex");
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

export function registerWithChandler({ email, password, displayName, inviteCode }) {
  return chandlerRequest("/v1/auth/register", {
    method: "POST",
    body: {
      email: email.trim(),
      password,
      display_name: (displayName || email.split("@")[0]).trim(),
      ...(inviteCode ? { invite_code: inviteCode.trim() } : {}),
      agree_policies: true,
      client_version: "gulong-web-1.1",
      device_type: "web",
    },
  });
}

export function websiteUsernameIdentity(value) {
  const username = String(value ?? "").trim();
  if (!username) return null;
  const normalized = username.normalize("NFKC").toLowerCase();
  return {
    username,
    normalized,
    lookupHash: createHash("sha256").update(normalized).digest("hex"),
    legacyNormalized: normalized.length <= 32 ? normalized : null,
  };
}

export function websiteUsernameOwnerFilter(value) {
  const identity = websiteUsernameIdentity(value);
  if (!identity) return null;
  return {
    $or: [
      { usernameLookupHash: identity.lookupHash },
      ...(identity.legacyNormalized ? [{ usernameNormalized: identity.legacyNormalized }] : []),
    ],
  };
}

export function loginWithChandler(identifier, password) {
  return chandlerRequest("/v1/auth/login", {
    method: "POST",
    body: { email: identifier.trim(), password, device_type: "web" },
  });
}

export function getChandlerAuthCapabilities() {
  return chandlerRequest("/v1/auth/capabilities", { timeoutMs: 8_000 });
}

export function sendLoginOtpWithChandler(target, targetType) {
  return chandlerRequest("/v1/auth/otp/send", {
    method: "POST",
    body: { target: String(target || "").trim(), target_type: targetType },
  });
}

export function loginWithChandlerOtp(target, targetType, code) {
  return chandlerRequest("/v1/auth/otp/login", {
    method: "POST",
    body: {
      target: String(target || "").trim(),
      target_type: targetType,
      code: String(code || "").trim(),
      device_type: "web",
    },
  });
}

function phoneRegistrationCredential() {
  const config = chandlerConfig();
  if (!config.applicationId || !config.clientSecret) {
    throw new ChandlerError("桌面手机号注册服务尚未完成安全配置，请联系管理员", {
      status: 503,
      code: "CHANDLER_PHONE_REGISTRATION_NOT_CONFIGURED",
    });
  }
  return { clientId: config.applicationId, clientSecret: config.clientSecret };
}

export function isChandlerPhoneRegistrationConfigured() {
  const config = chandlerConfig();
  return Boolean(config.applicationId && config.clientSecret);
}

export function sendPhoneRegistrationOtpWithChandler(phone) {
  const credential = phoneRegistrationCredential();
  return chandlerRequest("/v1/auth/phone/send-otp", {
    method: "POST",
    body: {
      phone: String(phone || "").trim(),
      purpose: "register",
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
    },
  });
}

export function registerPhoneWithChandler({ phone, code, displayName, installId, deviceName, osVersion, appVersion }) {
  const credential = phoneRegistrationCredential();
  return chandlerRequest("/v1/auth/phone/register", {
    method: "POST",
    body: {
      phone: String(phone || "").trim(),
      code: String(code || "").trim(),
      ...(displayName ? { display_name: String(displayName).trim() } : {}),
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      install_id: String(installId || "").trim(),
      ...(deviceName ? { device_name: String(deviceName).trim() } : {}),
      device_type: "desktop",
      ...(osVersion ? { os_version: String(osVersion).trim() } : {}),
      ...(appVersion ? { app_version: String(appVersion).trim() } : {}),
    },
  });
}

export function forgotPasswordWithChandlerPhone(phone) {
  return chandlerRequest("/v1/auth/phone/forgot-password", {
    method: "POST",
    body: { phone: String(phone || "").trim() },
  });
}

export function resetPasswordWithChandlerPhone(phone, code, newPassword) {
  return chandlerRequest("/v1/auth/phone/reset-password", {
    method: "POST",
    body: {
      phone: String(phone || "").trim(),
      code: String(code || "").trim(),
      new_password: newPassword,
    },
  });
}

export function listChandlerIdentities(accessToken) {
  return chandlerRequest("/v1/me/identities", { accessToken, timeoutMs: 8_000 });
}

export function bindChandlerPhone(accessToken, { phone, currentPassword, reauthCode }) {
  return chandlerRequest("/v1/me/identities", {
    method: "POST",
    accessToken,
    body: {
      provider: "phone",
      value: String(phone || "").trim(),
      ...(currentPassword ? { current_password: currentPassword } : {}),
      ...(reauthCode ? { reauth_code: String(reauthCode).trim() } : {}),
    },
  });
}

export function verifyChandlerIdentity(accessToken, identityId, code) {
  return chandlerRequest(`/v1/me/identities/${encodeURIComponent(identityId)}/verify`, {
    method: "POST",
    accessToken,
    body: { code: String(code || "").trim() },
  });
}

export function deleteChandlerIdentity(accessToken, identityId) {
  return chandlerRequest(`/v1/me/identities/${encodeURIComponent(identityId)}`, {
    method: "DELETE",
    accessToken,
  });
}

export function setPrimaryChandlerIdentity(accessToken, identityId) {
  return chandlerRequest(`/v1/me/identities/${encodeURIComponent(identityId)}/primary`, {
    method: "POST",
    accessToken,
  });
}

export function sendChandlerReauthCode(accessToken) {
  return chandlerRequest("/v1/auth/reauth/send", {
    method: "POST",
    accessToken,
  });
}

export function changeChandlerPassword(accessToken, oldPassword, newPassword) {
  return chandlerRequest("/v1/auth/change-password", {
    method: "POST",
    accessToken,
    body: { old_password: oldPassword, new_password: newPassword },
  });
}

export function logoutAllFromChandler(accessToken) {
  return chandlerRequest("/v1/auth/logout-all", {
    method: "POST",
    accessToken,
  });
}

export function sendChandlerVerificationEmail(accessToken) {
  return chandlerRequest("/v1/auth/send-verification-email", {
    method: "POST",
    accessToken,
    body: {},
  });
}

export function verifyChandlerEmail(token) {
  return chandlerRequest("/v1/auth/verify-email", {
    method: "POST",
    body: { token: String(token || "").trim() },
  });
}

export function forgotPasswordWithChandler(email) {
  return chandlerRequest("/v1/auth/forgot-password", {
    method: "POST",
    body: { email: email.trim().toLowerCase() },
  });
}

export async function resetPasswordWithChandler(email, code, newPassword) {
  try {
    return await chandlerRequest("/v1/auth/reset-password", {
      method: "POST",
      body: { email: email.trim().toLowerCase(), code: code.trim(), new_password: newPassword },
    });
  } catch (error) {
    if (error instanceof ChandlerError && ["token.invalid", "auth.token_invalid"].includes(error.code)) {
      throw new ChandlerError("邮箱验证码无效或已过期，请重新获取", { status: 400, code: error.code, detail: error.detail });
    }
    if (error instanceof ChandlerError && error.code === "auth.weak_password") {
      throw new ChandlerError("新密码强度不足，请至少使用大写字母、小写字母、数字和符号中的三类", { status: 422, code: error.code, detail: error.detail });
    }
    throw error;
  }
}

export async function resolveWebsiteLoginEmail(identifier) {
  const normalized = String(identifier || "").trim().normalize("NFKC").toLowerCase();
  if (!normalized || normalized.includes("@")) return normalized;
  const ownerFilter = websiteUsernameOwnerFilter(normalized);
  const user = await (await getCollection("users")).findOne(
    ownerFilter,
    { projection: { email: 1, emailNormalized: 1 } },
  );
  return String(user?.emailNormalized || user?.email || normalized).trim().toLowerCase();
}

export function logoutFromChandler(refreshToken) {
  return chandlerRequest("/v1/auth/logout", {
    method: "POST",
    body: { refresh_token: refreshToken },
  });
}

function responseAttributes(payload) {
  const root = payload?.data || payload || {};
  return root.attributes && typeof root.attributes === "object" && !Array.isArray(root.attributes) ? root.attributes : {};
}

function responseMembers(payload) {
  const root = payload?.data || payload || {};
  if (Array.isArray(root)) return root;
  return Array.isArray(root.members) ? root.members : [];
}

function memberRole(payload, user) {
  const email = String(user?.email || "").trim().toLowerCase();
  const id = String(user?.id || "");
  const member = responseMembers(payload).find((item) => {
    const nested = item.user || {};
    return String(item.user_id || nested.id || nested.user_id || "") === id
      || String(item.email || nested.email || "").trim().toLowerCase() === email;
  });
  return String(member?.role || "").trim().toLowerCase() || null;
}

function editionFromAttributes(attributes, fallbackKey) {
  const marker = attributes.product_edition
    || attributes.edition
    || attributes.release_profile_key
    || attributes.application_key
    || attributes.theme_name;
  if (!marker) return null;
  return {
    ...productEdition(marker || fallbackKey),
    updatedAt: Number(attributes.product_edition_updated_at_unix_ms || attributes.edition_updated_at_unix_ms || 0),
  };
}

async function applicationIdentitySnapshot(accessToken, user, applicationId, editionKey) {
  const encodedApplication = encodeURIComponent(applicationId);
  const encodedUser = encodeURIComponent(user.id);
  const [members, attributePayload] = await Promise.all([
    chandlerRequest(`/v1/me/oauth/clients/${encodedApplication}/members`, { accessToken, timeoutMs: 5_000 }).catch(() => null),
    chandlerRequest(`/v1/me/oauth/clients/${encodedApplication}/users/${encodedUser}/attributes`, { accessToken, timeoutMs: 5_000 }).catch(() => null),
  ]);
  const attributes = responseAttributes(attributePayload);
  return {
    editionKey,
    role: memberRole(members, user),
    attributes,
    hasApplicationState: Boolean(memberRole(members, user)) || Object.keys(attributes).length > 0,
    explicitEdition: editionFromAttributes(attributes, editionKey),
  };
}

export async function resolveChandlerIdentity(user, accessToken) {
  const fallbackRole = user?.is_admin || isChandlerBootstrapAdmin(user) ? "admin" : "user";
  if (fallbackRole === "admin" || !accessToken || !user?.id) return { role: fallbackRole, editionKey: "gulong", editionName: "古龙版", editionSource: "default" };
  const config = chandlerConfig();
  const snapshots = await Promise.all([
    applicationIdentitySnapshot(accessToken, user, config.applicationId, "gulong"),
    applicationIdentitySnapshot(accessToken, user, config.airosApplicationId, "yongshenghua"),
  ]);
  const teamAdministrator = snapshots.every((snapshot) => ["owner", "admin"].includes(snapshot.role))
    && snapshots.every((snapshot) => !["user", "free", "member"].includes(String(snapshot.attributes.role || "").toLowerCase()));
  const explicit = snapshots.map((snapshot) => snapshot.explicitEdition).filter(Boolean).sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const activeApplications = snapshots.filter((snapshot) => snapshot.hasApplicationState);
  const inferredKey = explicit?.key
    || (activeApplications.length === 1 ? activeApplications[0].editionKey : "gulong");
  const edition = productEdition(inferredKey);
  return {
    role: fallbackRole === "admin" || teamAdministrator ? "admin" : "user",
    editionKey: edition.key,
    editionName: edition.name,
    editionSource: explicit ? "chandler-attributes" : activeApplications.length === 1 ? "chandler-application" : "default",
  };
}

export async function markChandlerProductEdition(accessToken, userId, editionValue = "gulong", source = "website") {
  const edition = productEdition(editionValue);
  const applicationId = edition.key === "yongshenghua" ? chandlerConfig().airosApplicationId : chandlerConfig().applicationId;
  const path = `/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/users/${encodeURIComponent(userId)}/attributes`;
  const current = await chandlerRequest(path, { accessToken, timeoutMs: 5_000 }).catch(() => null);
  const attributes = responseAttributes(current);
  return chandlerRequest(path, {
    method: "PUT",
    accessToken,
    timeoutMs: 5_000,
    body: {
      attributes: {
        ...attributes,
        product_edition: edition.key,
        product_edition_name: edition.name,
        product_edition_source: source,
        product_edition_updated_at_unix_ms: Date.now(),
      },
    },
  });
}

export async function upsertChandlerUser(chandlerUser, { username, identity, defaultEdition, forceEdition = false } = {}) {
  const users = await getCollection("users");
  const releaseAssignment = await (await getCollection("releaseAssignments")).findOne({ chandlerUserId: chandlerUser.id });
  const assignmentChannel = releaseAssignment?.channelId
    ? await (await getCollection("releaseChannels")).findOne({ _id: releaseAssignment.channelId })
    : null;
  const now = new Date();
  const email = chandlerUser.email?.trim() || null;
  const emailNormalized = email?.toLowerCase();
  let chandlerMatch = await users.findOne({ chandlerUserId: chandlerUser.id });
  let emailMatch = emailNormalized ? await users.findOne({ emailNormalized }) : null;

  // Older website accounts were created before Chandler became the identity
  // provider. Bind the existing e-mail owner instead of inserting a second user,
  // otherwise MongoDB's unique e-mail index turns a successful login into 409.
  if (chandlerMatch && emailMatch && !chandlerMatch._id.equals(emailMatch._id)) {
    const canonicalId = emailMatch._id;
    const duplicateId = chandlerMatch._id;
    await Promise.all([
      ...["apiKeys", "tasks", "memories", "feedback", "payments", "subscriptions", "wallets", "uploads", "offlinePayments", "userConfigurations", "notifications", "avatarUploads", "offlinePaymentReviewWorkers", "workerTasks", "workerTaskUploads", "workerEarnings", "workerWorkflows", "workerWorkflowRevenueLedger"]
        .map(async (name) => (await getCollection(name)).updateMany({ ownerId: duplicateId }, { $set: { ownerId: canonicalId } })),
      (await getCollection("workerTasks")).updateMany({ publisherId: duplicateId }, { $set: { publisherId: canonicalId } }),
      (await getCollection("workerTasks")).updateMany({ contractorId: duplicateId }, { $set: { contractorId: canonicalId } }),
      (await getCollection("workerEarnings")).updateMany({ publisherId: duplicateId }, { $set: { publisherId: canonicalId } }),
      (await getCollection("workerWorkflows")).updateMany({ publisherId: duplicateId }, { $set: { publisherId: canonicalId } }),
      (await getCollection("workerWorkflows")).updateMany({ contractorId: duplicateId }, { $set: { contractorId: canonicalId } }),
      (await getCollection("workerWorkflowRevenueLedger")).updateMany({ publisherId: duplicateId }, { $set: { publisherId: canonicalId } }),
      (await getCollection("workerWorkflowRevenueLedger")).updateMany({ contractorId: duplicateId }, { $set: { contractorId: canonicalId } }),
      (await getCollection("workerContactPayments")).updateMany({ requesterId: duplicateId }, { $set: { requesterId: canonicalId } }),
      (await getCollection("workerContactPayments")).updateMany({ targetId: duplicateId }, { $set: { targetId: canonicalId } }),
      (await getCollection("sessions")).updateMany({ userId: duplicateId }, { $set: { userId: canonicalId } }),
    ]);
    await users.deleteOne({ _id: duplicateId });
    chandlerMatch = emailMatch;
  }

  const canonical = emailMatch || chandlerMatch;
  const assignmentEdition = releaseAssignment?.editionKey
    ? productEdition(releaseAssignment.editionKey)
    : productEditionFromChannel(assignmentChannel);
  const inferredEdition = identity?.editionKey ? productEdition(identity.editionKey) : null;
  const existingEdition = canonical?.editionKey ? productEdition(canonical.editionKey) : null;
  const requestedEdition = defaultEdition ? productEdition(defaultEdition) : null;
  const edition = assignmentEdition
    || (forceEdition ? requestedEdition : null)
    || (identity?.editionSource !== "default" ? inferredEdition : null)
    || existingEdition
    || requestedEdition
    || inferredEdition
    || PRODUCT_EDITIONS.gulong;
  const editionSource = assignmentEdition ? "desktop-theme-access"
    : forceEdition ? "website-registration"
      : identity?.editionSource !== "default" ? identity?.editionSource
        : canonical?.editionSource || identity?.editionSource || "default";
  const record = {
    chandlerUserId: chandlerUser.id,
    email,
    emailNormalized,
    displayName: canonical?.displayNameUserManaged ? canonical.displayName : chandlerUser.display_name || canonical?.displayName || null,
    avatar: canonical?.avatarUserManaged ? canonical.avatar : chandlerUser.avatar || canonical?.avatar || null,
    ...(canonical?.avatarUserManaged ? { avatarUserManaged: true, avatarObjectKey: canonical.avatarObjectKey, avatarUpdatedAt: canonical.avatarUpdatedAt } : {}),
    emailVerified: chandlerUser.email_verified === undefined ? Boolean(canonical?.emailVerified) : Boolean(chandlerUser.email_verified),
    role: canonical?.roleOverride || identity?.role || (chandlerUser.is_admin || isChandlerBootstrapAdmin(chandlerUser) ? "admin" : "user"),
    ...(canonical?.roleOverride ? { roleOverride: canonical.roleOverride } : {}),
    editionKey: edition.key,
    editionName: edition.name,
    editionSource,
    status: ["active", "disabled", "deleted"].includes(chandlerUser.status) ? chandlerUser.status : canonical?.status || "active",
    authProvider: "chandler",
    ...(releaseAssignment?.channelId ? { releaseChannelId: releaseAssignment.channelId, releaseChannelGroupId: releaseAssignment.groupId } : {}),
    updatedAt: now,
  };
  const websiteUsername = websiteUsernameIdentity(username);
  if (websiteUsername && !canonical?.username) {
    const usernameOwner = await users.findOne(websiteUsernameOwnerFilter(websiteUsername.username));
    if (!usernameOwner || usernameOwner._id.equals(canonical?._id)) {
      record.username = websiteUsername.username;
      record.usernameLookupHash = websiteUsername.lookupHash;
    }
  }
  try {
    return await users.findOneAndUpdate(
      canonical ? { _id: canonical._id } : { chandlerUserId: chandlerUser.id },
      { $set: record, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    // Two simultaneous first logins may both observe no local shadow record.
    // The winner creates it; the loser retries against that new canonical user.
    if (error?.code === 11000) return upsertChandlerUser(chandlerUser, { username, identity, defaultEdition, forceEdition });
    throw error;
  }
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

export async function refreshChandlerLogin(refreshToken) {
  try {
    return await chandlerRequest("/v1/oauth/token", {
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: refreshToken },
    });
  } catch (error) {
    // Chandler v3.3 uses the OAuth token endpoint. Keep the legacy endpoint
    // only as a rolling-upgrade fallback when an older node returns 404/405.
    if (!(error instanceof ChandlerError) || ![404, 405].includes(error.status)) throw error;
    return chandlerRequest("/v1/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
    });
  }
}

async function refreshChandlerSession(session, { forceRefresh = false } = {}) {
  const sessionId = session._id instanceof ObjectId ? session._id : new ObjectId(session._id);
  const sessions = await getCollection("sessions");
  const currentSession = await sessions.findOne({ _id: sessionId });
  let auth = readExternalAuth(currentSession || session);
  if (!auth || auth.provider !== "chandler" || !auth.refreshToken) {
    throw new ChandlerError("Chandler 登录已失效，请重新登录", { status: 401, code: "CHANDLER_SESSION_EXPIRED" });
  }
  if (!forceRefresh && auth.accessToken && auth.accessExpiresAt > Date.now() + 60_000) return auth.accessToken;
  const refreshed = await refreshChandlerLogin(auth.refreshToken);
  if (!refreshed?.access_token) {
    throw new ChandlerError("Chandler 没有返回新的访问令牌，请重新登录", { status: 401, code: "CHANDLER_REFRESH_INVALID" });
  }
  auth = {
    ...auth,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || auth.refreshToken,
    accessExpiresAt: accessExpiresAt(refreshed),
  };
  await sessions.updateOne(
    { _id: sessionId },
    { $set: { externalAuth: sealExternalAuth(auth), lastSeenAt: new Date() } },
  );
  return auth.accessToken;
}

export async function getChandlerAccessToken(session, { forceRefresh = false } = {}) {
  const auth = readExternalAuth(session);
  if (!auth || auth.provider !== "chandler") {
    throw new ChandlerError("当前会话不是 Chandler 统一账号", { status: 401, code: "CHANDLER_SESSION_REQUIRED" });
  }
  if (!forceRefresh && auth.accessToken && auth.accessExpiresAt > Date.now() + 60_000) {
    return auth.accessToken;
  }
  const refreshKey = String(session._id);
  let pending = accessRefreshPromises.get(refreshKey);
  if (!pending) {
    pending = refreshChandlerSession(session, { forceRefresh });
    accessRefreshPromises.set(refreshKey, pending);
  }
  try {
    return await pending;
  } finally {
    if (accessRefreshPromises.get(refreshKey) === pending) accessRefreshPromises.delete(refreshKey);
  }
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

function partnerSkus(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.skus) ? payload.skus : [];
}

function partnerPrices(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.prices) ? payload.prices : [];
}

function partnerClientUsers(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  return Array.isArray(payload?.users) ? payload.users : [];
}

export async function listPartnerClientUsers(accessToken, applicationId = chandlerConfig().applicationId, { page = 1, limit = 100 } = {}) {
  const result = await chandlerRequest(
    `/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/users?page=${Math.max(1, Math.trunc(page))}&limit=${Math.min(100, Math.max(1, Math.trunc(limit)))}`,
    partnerCredential(accessToken),
  );
  const items = partnerClientUsers(result);
  return {
    items,
    meta: {
      ...(result?.meta || {}),
      total: Number(result?.meta?.total ?? items.length),
      page: Number(result?.meta?.page ?? page),
      limit: Number(result?.meta?.limit ?? limit),
    },
  };
}

export async function listAllPartnerClientUsers(accessToken, applicationId = chandlerConfig().applicationId, { limit = 100, maxPages = 50 } = {}) {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(limit)));
  const first = await listPartnerClientUsers(accessToken, applicationId, { page: 1, limit: pageSize });
  const totalPages = Math.min(maxPages, Math.max(1, Math.ceil(first.meta.total / pageSize)));
  const remaining = totalPages > 1
    ? await Promise.all(Array.from({ length: totalPages - 1 }, (_, index) => listPartnerClientUsers(accessToken, applicationId, { page: index + 2, limit: pageSize })))
    : [];
  return {
    items: [first, ...remaining].flatMap((page) => page.items),
    meta: { ...first.meta, page: 1, limit: pageSize, pages: totalPages },
  };
}

export function getPartnerClientUserAttributes(accessToken, userId, applicationId = chandlerConfig().applicationId) {
  return chandlerRequest(
    `/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/users/${encodeURIComponent(userId)}/attributes`,
    partnerCredential(accessToken),
  );
}

export async function listPartnerSkus(accessToken, applicationId = chandlerConfig().applicationId) {
  return partnerSkus(await chandlerRequest(
    `/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/skus`,
    partnerCredential(accessToken),
  ));
}

export async function listPartnerSubscriptionPlans(accessToken, applicationId = chandlerConfig().applicationId) {
  const skus = await listPartnerSkus(accessToken, applicationId);
  return skus
    .map((sku) => {
      const marker = `${sku.code || ""} ${sku.name || ""} ${sku.active_price?.billing_interval || ""}`.toLowerCase();
      const billingInterval = marker.includes("year") || marker.includes("annual") || marker.includes("年度") ? "year"
        : marker.includes("month") || marker.includes("月度") || marker.includes("月卡") ? "month"
          : null;
      if (!billingInterval) return null;
      const price = sku.active_price || null;
      return {
        productId: applicationId,
        productName: "古龙智能引擎会员",
        skuId: sku.id,
        skuCode: sku.code,
        skuName: sku.name || sku.code,
        skuType: sku.code,
        skuStatus: sku.status || "active",
        amountFen: price ? Number(price.amount) : null,
        currency: price?.currency || "CNY",
        billingInterval,
        intervalCount: Number(price?.interval_count || 1),
        priceId: price?.id || null,
        priceStatus: price?.status || null,
        priceEffectiveAt: price?.effective_at || null,
        priceExpiresAt: price?.expires_at || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (left.amountFen ?? Number.MAX_SAFE_INTEGER) - (right.amountFen ?? Number.MAX_SAFE_INTEGER));
}

export function createPartnerSku(accessToken, { code, name, applicationId = chandlerConfig().applicationId }) {
  return chandlerRequest(`/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/skus`, {
    method: "POST",
    ...partnerCredential(accessToken),
    body: { code, name },
  });
}

export function setPartnerSkuStatus(accessToken, skuId, status, applicationId = chandlerConfig().applicationId) {
  return chandlerRequest(`/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/skus/${encodeURIComponent(skuId)}/status`, {
    method: "POST",
    ...partnerCredential(accessToken),
    body: { status },
  });
}

export async function listPartnerPriceVersions(accessToken, skuId, applicationId = chandlerConfig().applicationId) {
  return partnerPrices(await chandlerRequest(
    `/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/skus/${encodeURIComponent(skuId)}/prices`,
    partnerCredential(accessToken),
  ));
}

export function createPartnerPriceVersion(accessToken, {
  skuId,
  amountFen,
  currency = "CNY",
  billingInterval,
  intervalCount = 1,
  effectiveAt,
  expiresAt = null,
  applicationId = chandlerConfig().applicationId,
}) {
  return chandlerRequest(`/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/skus/${encodeURIComponent(skuId)}/prices`, {
    method: "POST",
    ...partnerCredential(accessToken),
    body: {
      amount: amountFen,
      currency,
      billing_interval: "once",
      interval_count: 1,
      effective_at: effectiveAt,
      expires_at: expiresAt,
    },
  });
}

export async function createSubscriptionCheckout(accessToken, {
  cycle,
  channel = "wechat",
  merchantOrderNo,
  expectedAmountFen,
  source = "gulong-web",
  partnerData = {},
  applicationId = chandlerConfig().applicationId,
  applicationKey = "gulong-web",
  productName = "古龙智能引擎会员",
}) {
  if (channel !== "wechat") throw new ChandlerError("线上支付当前仅支持微信支付", { status: 400, code: "PAYMENT_CHANNEL_UNSUPPORTED" });
  if (!Number.isSafeInteger(expectedAmountFen) || expectedAmountFen < 100) {
    throw new ChandlerError("订阅订单金额无效", { status: 400, code: "PAYMENT_AMOUNT_INVALID" });
  }
  const singlePaymentPlan = {
    productId: applicationId,
    productName,
    skuName: cycle === "year" ? "年度订阅会员" : "月度订阅会员",
    billingInterval: cycle === "year" ? "year" : "month",
    amountFen: expectedAmountFen,
    currency: "CNY",
    priceSource: "gulong-membership-ledger",
  };
  const singlePayment = await createDirectPaymentOrder(accessToken, {
    merchantOrderNo,
    channel,
    amountFen: expectedAmountFen,
    subject: singlePaymentPlan.skuName,
    source,
    partnerData: {
      schema_version: 3,
      application_key: applicationKey,
      kind: "subscription",
      cycle: singlePaymentPlan.billingInterval,
      amount_fen: expectedAmountFen,
      renewal_mode: "manual",
      ...partnerData,
    },
    applicationId,
  });
  return { checkout: singlePayment.order, prepay: singlePayment.payment, plan: singlePaymentPlan, orderNo: singlePayment.orderNo };
}

export async function createDirectPaymentOrder(accessToken, {
  merchantOrderNo,
  channel,
  amountFen,
  skuId,
  subject,
  source,
  partnerData,
  prepay = true,
  applicationId = chandlerConfig().applicationId,
}) {
  if (channel !== "wechat") throw new ChandlerError("线上支付当前仅支持微信支付", { status: 400, code: "PAYMENT_CHANNEL_UNSUPPORTED" });
  const config = chandlerConfig();
  const order = await chandlerRequest("/v1/pay/orders", {
    method: "POST",
    ...partnerServiceCredential(),
    idempotencyKey: merchantOrderNo,
    body: {
      application_id: applicationId || config.applicationId,
      merchant_order_no: merchantOrderNo,
      channel,
      ...(skuId ? { sku_id: skuId } : { amount: amountFen, currency: "CNY" }),
      subject,
      source,
      partner_data: partnerData,
    },
  });
  const orderNo = order.platform_order_no || order.order_no;
  if (!orderNo) {
    throw new ChandlerError("Chandler 没有返回订单号，未发起预支付", {
      status: 502,
      code: "CHANDLER_ORDER_INVALID",
      detail: order,
    });
  }
  const payment = prepay ? await chandlerRequest(`/v1/pay/orders/${encodeURIComponent(orderNo)}/prepay`, {
    method: "POST",
    ...prepayCredential(accessToken),
    idempotencyKey: `prepay-${merchantOrderNo}`,
    body: {},
  }) : null;
  return { order, payment, orderNo };
}

export function getDirectPaymentOrder(orderNo) {
  return chandlerServerRequest(`/v1/pay/orders/${encodeURIComponent(orderNo)}`);
}

export function issueOfflineCredential(accessToken, installId) {
  return chandlerRequest("/v1/me/entitlements/offline-credential", {
    method: "POST",
    accessToken,
    body: installId ? { install_id: installId } : {},
  });
}
