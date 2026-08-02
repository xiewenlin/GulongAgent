import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { handleUpload } from "@vercel/blob/client";
import QRCode from "qrcode";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import {
  ConfigurationError,
  ensureIndexes,
  getCollection,
  isDatabaseConfigured,
  pingDatabase,
} from "./db.js";
import {
  authenticate,
  createApiKey,
  fingerprintIp,
  hashOpaqueToken,
  hashPassword,
  isTrustedBrowserRequest,
  issueSession,
  normalizeEmail,
  normalizeUsername,
  revokeSession,
  verifyPassword,
  readExternalAuth,
  readUserSecret,
  sealUserSecret,
} from "./security.js";
import { enforceRateLimit } from "./rate-limit.js";
import {
  buildAlipayPagePayUrl,
  createMockPaymentUrl,
  createWechatNativeOrder,
  decryptWechatResource,
  paymentCapabilities,
  verifyAlipayNotification,
  verifyWechatNotification,
} from "./payments.js";
import {
  ChandlerError,
  chandlerConfig,
  chandlerRequest,
  createDirectPaymentOrder,
  createPartnerPriceVersion,
  createPartnerSku,
  createSubscriptionCheckout,
  externalAuthFromResponse,
  forgotPasswordWithChandler,
  getChandlerAccessToken,
  issueOfflineCredential,
  isChandlerBootstrapAdmin,
  getPartnerClientUserAttributes,
  listAllPartnerClientUsers,
  listPartnerPriceVersions,
  listPartnerSubscriptionPlans,
  loginWithChandler,
  resolveWebsiteLoginEmail,
  logoutFromChandler,
  markChandlerProductEdition,
  productEditionFromChannel,
  registerWithChandler,
  resetPasswordWithChandler,
  resolveChandlerIdentity,
  setPartnerSkuStatus,
  upsertChandlerUser,
} from "./chandler.js";
import {
  cosConfig,
  createPresignedDownloadUrl,
  createPresignedPutUrl,
  deleteObject,
  ensureBrowserUploadCors,
  headObject,
  sanitizeFilename,
} from "./cos.js";
import { buildAdminAnalyticsDashboard, recordAnalyticsEvent } from "./analytics.js";
import { recoverExpiredDirectReleaseLock } from "./release-lock.js";
import {
  OFFLINE_REVIEW_REJECTION_REASON,
  chandlerOrderItems,
  normalizeChandlerOfflineOrder,
  offlineReviewWechatMessage,
} from "./offline-review.js";
import {
  WORKER_MAX_ASSETS_PER_SECTION,
  canBypassWorkerContactPayment,
  canClaimWorkerTask,
  workerAssignmentInput,
  workerAssetInput,
  workerTaskFinancials,
  workerTaskFingerprint,
  workerTaskTitle,
  workerWorkflowRevenue,
} from "./worker-market.js";

const app = new OpenAPIHono();

const MINIMAX_API_HOST = "https://api.minimaxi.com/v1";
const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const AVATAR_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const SUBSCRIPTION_PRICE_MIN_FEN = 100;
const SUBSCRIPTION_PRICE_MAX_FEN = 5_000_000;
const ONLINE_PAYMENT_AVAILABILITY = Object.freeze({
  online: false,
  status: "coming_soon",
  notice: "线上支付将在近期开通，敬请期待。",
  priorityProvider: "wechat",
  channels: {
    wechat: { enabled: false, status: "coming_soon", label: "微信支付", message: "微信支付将优先开通，敬请期待。" },
    alipay: { enabled: false, status: "planned", label: "支付宝", message: "支付宝渠道暂未开放，将在后续陆续开通。" },
  },
});
let offlinePaymentSyncPromise = null;
let offlinePaymentSynchronizedAt = 0;

const ErrorSchema = z.object({
  code: z.string().openapi({ example: "VALIDATION_ERROR" }),
  message: z.string().openapi({ example: "请求参数不正确" }),
  requestId: z.string().optional(),
});

const PublicUserSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  displayName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  authProvider: z.enum(["local", "chandler"]).optional(),
  role: z.enum(["user", "developer", "admin"]),
  edition: z.object({ key: z.enum(["gulong", "yongshenghua"]), name: z.enum(["古龙版", "永生花版"]), source: z.string() }).optional(),
  createdAt: z.coerce.date(),
});

const RegisterSchema = z
  .object({
    username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u).optional(),
    email: z.email(),
    displayName: z.string().trim().min(1).max(64).optional(),
    inviteCode: z.string().trim().max(64).optional(),
    password: z.string().min(8).max(128),
  });

const LoginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

const ForgotPasswordSchema = z.object({
  email: z.email(),
});

const ResetPasswordSchema = z.object({
  email: z.email(),
  code: z.string().trim().min(6).max(2048),
  newPassword: z.string().min(8).max(255),
});

async function requireAdmin(c) {
  const auth = await authenticate(c);
  if (auth.error) return auth;
  const locallyVerifiedAdmin = auth.user.role === "admin";
  if (auth.user.authProvider === "chandler") {
    try {
      const accessToken = await getChandlerAccessToken(auth.session);
      const profile = await chandlerRequest("/v1/me", { accessToken });
      const identity = await resolveChandlerIdentity(profile, accessToken);
      const user = await upsertChandlerUser(profile, { identity });
      auth.user.role = user.role;
      auth.user.edition = { key: user.editionKey || "gulong", name: user.editionName || "古龙版", source: user.editionSource || "default" };
    } catch (error) {
      if (!locallyVerifiedAdmin) throw error;
      // A previously verified local administrator must retain access to
      // MongoDB-backed operations during a transient Chandler outage. Remote
      // mutations still call Chandler separately and keep their own guards.
      auth.chandlerWarning = error.message;
    }
  }
  if (auth.user.role !== "admin") {
    return { error: c.json({ code: "FORBIDDEN", message: "仅管理员可执行此操作" }, 403) };
  }
  return auth;
}

function requireTrustedMutation(c) {
  return isTrustedBrowserRequest(c)
    ? null
    : c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function generatedPartnerLogo(partner) {
  const name = partner.name || "Partner";
  const mark = [...name.replace(/\s+/g, "")].slice(0, 2).join("").toUpperCase() || "P";
  const seed = [...name].reduce((total, character) => total + character.codePointAt(0), 0);
  const palettes = [
    ["#0d675e", "#d8b463"],
    ["#315f46", "#9db879"],
    ["#4c4d8a", "#aa92db"],
    ["#9b5235", "#e6aa69"],
  ];
  const [primary, accent] = palettes[seed % palettes.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" role="img" aria-label="${escapeXml(name)} Logo"><rect width="320" height="160" rx="28" fill="#fffdfa"/><rect x="1" y="1" width="318" height="158" rx="27" fill="none" stroke="#e9e4d9"/><circle cx="78" cy="80" r="46" fill="${primary}"/><circle cx="78" cy="80" r="36" fill="none" stroke="${accent}" stroke-width="3"/><text x="78" y="91" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" font-size="34" font-weight="800" fill="#fff">${escapeXml(mark)}</text><text x="142" y="73" font-family="system-ui,Segoe UI,sans-serif" font-size="22" font-weight="750" fill="#172522">${escapeXml(name.slice(0, 12))}</text><text x="142" y="99" font-family="system-ui,Segoe UI,sans-serif" font-size="12" letter-spacing="2" fill="#7d857f">GULONG PARTNER</text></svg>`;
}

const PARTNER_INDUSTRIES = [
  { key: "technology", name: "科技与人工智能", keywords: /人工智能|\bai\b|智能|科技|软件|互联网|云计算|数据|机器人|芯片|saas/i },
  { key: "finance", name: "金融与保险", keywords: /金融|银行|保险|证券|基金|支付|投资|财富/i },
  { key: "education", name: "教育与培训", keywords: /教育|学校|大学|学院|培训|课程|学习/i },
  { key: "healthcare", name: "医疗与健康", keywords: /医疗|医药|健康|医院|诊所|生物|养老/i },
  { key: "commerce", name: "零售与商业", keywords: /零售|电商|商贸|消费|餐饮|酒店|门店|品牌/i },
  { key: "industry", name: "工业与制造", keywords: /工业|制造|汽车|能源|建筑|工程|物流|供应链|农业/i },
  { key: "culture", name: "文化与传媒", keywords: /文化|传媒|影视|游戏|出版|旅游|艺术|设计|广告/i },
  { key: "public", name: "政务与公共服务", keywords: /政府|政务|公共|协会|公益|研究院|事业单位/i },
  { key: "services", name: "专业服务", keywords: /咨询|法律|会计|人力|服务|地产|知识产权/i },
];

function classifyPartnerIndustry(industry, name = "") {
  const input = String(industry || "").trim().slice(0, 80);
  const haystack = `${input} ${name}`;
  const match = PARTNER_INDUSTRIES.find((item) => item.keywords.test(haystack));
  return { industryInput: input || "其他", industryKey: match?.key || "other", industryName: match?.name || "其他行业" };
}

function partnerLogoUrl(partner) {
  if (partner.logoMode === "upload" && partner.logoObjectKey) return `/api/partners/${partner._id}/image/logo`;
  return partner.logoMode === "url" ? partner.logoUrl : `/api/partners/${partner._id}/logo.svg`;
}

function partnerAssetUploadInput(body) {
  const kind = body.kind === "promotion" ? "promotion" : body.kind === "logo" ? "logo" : null;
  const contentType = String(body.contentType || "").toLowerCase();
  const size = Number(body.size);
  const filename = sanitizeFilename(body.filename, `${kind || "image"}.png`);
  if (!kind || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType) || !Number.isSafeInteger(size) || size < 1 || size > 30 * 1024 * 1024) return null;
  return { kind, contentType, size, filename };
}

function partnerAssetUploadTicket({ kind, contentType, filename }) {
  const objectKey = `partners/assets/${kind}/${Date.now()}-${randomBytes(10).toString("hex")}-${filename}`;
  return {
    uploadUrl: createPresignedPutUrl(objectKey, { headers: { "Content-Type": contentType } }),
    objectKey,
    expiresIn: 1200,
    requiredHeaders: { "Content-Type": contentType },
  };
}

function safeDate(value, endOfDay = false) {
  const input = String(value || "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input)
    ? new Date(`${input}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`)
    : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function subscriptionPeriodState(currentPeriodStart, currentPeriodEnd, now = new Date()) {
  const start = currentPeriodStart ? new Date(currentPeriodStart) : null;
  const end = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  if (!end || Number.isNaN(end.getTime())) return "inactive";
  if (!start || Number.isNaN(start.getTime())) return now >= end ? "expired" : "active";
  if (end <= start) return "inactive";
  if (now < start) return "scheduled";
  if (now >= end) return "expired";
  return "active";
}

function adminSubscriptionJson(subscription) {
  if (!subscription) return null;
  const status = subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd);
  return {
    id: subscription._id.toString(),
    status,
    sku_name: subscription.cycle === "year" ? "古龙年度会员" : subscription.cycle === "month" ? "古龙月度会员" : "古龙会员",
    current_period_start: subscription.currentPeriodStart || null,
    current_period_end: subscription.currentPeriodEnd || null,
    provider: subscription.provider || "admin",
    source: "website",
    authoritative: Boolean(subscription.manualPeriodOverride),
  };
}

function chandlerApplicationTargets() {
  const config = chandlerConfig();
  return [
    { id: config.applicationId, editionKey: "gulong", editionName: "古龙版" },
    { id: config.airosApplicationId, editionKey: "yongshenghua", editionName: "永生花版" },
  ].filter((target, index, targets) => target.id && targets.findIndex((item) => item.id === target.id) === index);
}

function chandlerAttributePeriod(attributes = {}) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return null;
  const startValue = attributes.subscription_valid_from || attributes.valid_from || attributes.current_period_start || attributes.subscription_valid_from_unix_ms || null;
  const endValue = attributes.subscription_valid_until || attributes.valid_until || attributes.current_period_end || attributes.subscription_valid_until_unix_ms || null;
  const start = startValue ? new Date(startValue) : null;
  const end = endValue ? new Date(endValue) : null;
  if (!end || Number.isNaN(end.getTime()) || (start && Number.isNaN(start.getTime()))) return null;
  const marker = `${attributes.plan_kind || ""} ${attributes.billing_interval || ""} ${attributes.product_id || ""} ${attributes.sku_id || ""}`.toLowerCase();
  const cycle = marker.includes("year") || marker.includes("annual") ? "year" : marker.includes("month") ? "month" : "custom";
  return {
    plan: attributes.product_id || attributes.plan || "member",
    cycle,
    status: subscriptionPeriodState(start, end),
    currentPeriodStart: start,
    currentPeriodEnd: end,
    autoRenew: Boolean(attributes.auto_renew),
    provider: "chandler",
  };
}

async function synchronizeChandlerAttributeSubscription(ownerId, attributes, applicationId) {
  const period = chandlerAttributePeriod(attributes);
  if (!period) return false;
  const subscriptions = await getCollection("subscriptions");
  const existing = await subscriptions.findOne({ ownerId });
  if (existing?.manualPeriodOverride) return false;
  const now = new Date();
  await subscriptions.updateOne(
    { ownerId },
    {
      $set: {
        ...period,
        chandlerApplicationId: applicationId,
        chandlerAttributes: attributes,
        chandlerSynchronizedAt: now,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return true;
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await iteratee(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

async function synchronizeChandlerApplicationUsers(accessToken) {
  const targets = chandlerApplicationTargets();
  const results = await Promise.allSettled(targets.map(async (target) => ({
    target,
    result: await listAllPartnerClientUsers(accessToken, target.id, { limit: 100, maxPages: 50 }),
  })));
  const successful = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (!successful.length) throw results.find((result) => result.status === "rejected")?.reason || new ChandlerError("Chandler 应用用户同步失败");

  const merged = new Map();
  for (const { target, result } of successful) {
    for (const remote of result.items) {
      const userId = String(remote.user_id || remote.id || "").trim();
      const email = String(remote.email || "").trim().toLowerCase();
      if (!userId || !email) continue;
      const key = userId || email;
      const current = merged.get(key) || { remote, targets: [], attributes: null, attributesTarget: null, attributeUpdatedAt: 0 };
      current.remote = { ...current.remote, ...remote, id: userId };
      current.targets.push(target);
      const attributes = remote.attributes && typeof remote.attributes === "object" && !Array.isArray(remote.attributes) ? remote.attributes : null;
      const updatedAt = Number(attributes?.subscription_period_updated_at_unix_ms || attributes?.subscription_reviewed_at_unix_ms || Date.parse(remote.updated_at || remote.granted_at || "") || 0);
      if (attributes && (!current.attributes || updatedAt >= current.attributeUpdatedAt)) {
        current.attributes = attributes;
        current.attributesTarget = target;
        current.attributeUpdatedAt = updatedAt;
      }
      merged.set(key, current);
    }
  }

  const users = await getCollection("users");
  const synchronized = await mapWithConcurrency([...merged.values()], 8, async (entry) => {
    const defaultTarget = entry.targets.length === 1 ? entry.targets[0] : entry.targets.find((target) => target.editionKey === "gulong") || entry.targets[0];
    try {
      const local = await upsertChandlerUser({
        id: entry.remote.id,
        email: entry.remote.email,
        display_name: entry.remote.display_name,
        status: entry.remote.status,
      }, {
        identity: { role: "user", editionKey: defaultTarget.editionKey, editionName: defaultTarget.editionName, editionSource: "default" },
        defaultEdition: defaultTarget.editionKey,
      });
      const now = new Date();
      await users.updateOne({ _id: local._id }, { $set: {
        chandlerGrantScopes: entry.remote.scopes || null,
        chandlerGrantUpdatedAt: entry.remote.updated_at ? new Date(entry.remote.updated_at) : now,
        chandlerAuthorizedApplications: entry.targets.map((target) => target.id),
        chandlerAttributes: entry.attributes,
        chandlerSynchronizedAt: now,
        updatedAt: now,
      } });
      if (entry.attributes && entry.attributesTarget) await synchronizeChandlerAttributeSubscription(local._id, entry.attributes, entry.attributesTarget.id);
      return local._id;
    } catch {
      return null;
    }
  });

  return {
    remoteTotal: successful.reduce((total, item) => total + Number(item.result.meta.total || item.result.items.length), 0),
    synchronizedCount: synchronized.filter(Boolean).length,
    applicationCount: successful.length,
    partial: successful.length !== targets.length,
    synchronizedAt: new Date(),
  };
}

async function releaseChannelUserFilter(channelId) {
  if (channelId === "unassigned") return { $or: [{ releaseChannelId: { $exists: false } }, { releaseChannelId: null }] };
  if (!ObjectId.isValid(channelId)) return null;
  const releaseChannelId = new ObjectId(channelId);
  const channel = await (await getCollection("releaseChannels")).findOne({ _id: releaseChannelId }, { projection: { isDefault: 1 } });
  return channel?.isDefault
    ? { $or: [{ releaseChannelId }, { releaseChannelId: { $exists: false } }, { releaseChannelId: null }] }
    : { releaseChannelId };
}

async function adminUserDirectoryFilter(query = {}) {
  const clauses = [];
  if (query.status === "active") clauses.push({ $or: [{ status: "active" }, { status: { $exists: false } }] });
  else if (query.status) clauses.push({ status: query.status });
  if (query.channelId) {
    const channelFilter = await releaseChannelUserFilter(query.channelId);
    if (channelFilter) clauses.push(channelFilter);
  }
  if (query.q?.trim()) {
    const keyword = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clauses.push({ $or: ["email", "username", "displayName", "chandlerUserId"].map((field) => ({ [field]: { $regex: keyword, $options: "i" } })) });
  }
  return clauses.length ? { $and: clauses } : {};
}

function adminUserDirectoryItem(user, subscription = null, now = new Date()) {
  const membershipStatus = subscription
    ? subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd, now)
    : "inactive";
  const isMember = membershipStatus === "active";
  return {
    id: user.chandlerUserId || user._id.toString(),
    website_user_id: user._id.toString(),
    email: user.email || null,
    display_name: user.displayName || user.username || null,
    status: user.status || "active",
    role: user.role || "user",
    account_type: user.role === "admin" ? "administrator" : isMember ? "subscription_member" : "standard_user",
    is_member: isMember,
    membership_status: membershipStatus,
    membership_valid_from: subscription?.currentPeriodStart || null,
    membership_valid_until: subscription?.currentPeriodEnd || null,
    edition_name: user.editionName || "古龙版",
    created_at: new Date(user.createdAt || 0).toISOString(),
  };
}

async function websiteAdminUserDirectory(query = {}) {
  const page = query.page || 1;
  const limit = query.limit || 30;
  const filter = await adminUserDirectoryFilter(query);
  const usersCollection = await getCollection("users");
  const [users, total] = await Promise.all([
    usersCollection.find(filter, { projection: { passwordHash: 0 } }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    usersCollection.countDocuments(filter),
  ]);
  const ownerIds = users.map((user) => user._id);
  const subscriptions = ownerIds.length
    ? await (await getCollection("subscriptions")).find({ ownerId: { $in: ownerIds } }).toArray()
    : [];
  const subscriptionsByOwner = new Map(subscriptions.map((subscription) => [subscription.ownerId.toString(), subscription]));
  const now = new Date();
  return {
    users: users.map((user) => adminUserDirectoryItem(user, subscriptionsByOwner.get(user._id.toString()), now)),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

function subscriptionDirectoryCapabilities({ synchronized = false } = {}) {
  return {
    applicationUserSync: synchronized,
    applicationSubscriptionSync: synchronized,
    websiteRoleManagement: true,
    websiteSubscriptionPeriod: true,
    globalUserStatus: false,
    globalEntitlementApproval: false,
  };
}

function combineMongoFilters(...filters) {
  const active = filters.filter((filter) => filter && Object.keys(filter).length);
  if (!active.length) return {};
  return active.length === 1 ? active[0] : { $and: active };
}

function adminOrderDateFilter(fromValue, toValue) {
  const from = fromValue ? safeDate(fromValue) : null;
  const to = toValue ? safeDate(toValue, true) : null;
  if ((fromValue && !from) || (toValue && !to) || (from && to && from > to)) return null;
  return from || to ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};
}

async function adminOrderBaseFilter(query = {}) {
  const clauses = [];
  const dateFilter = adminOrderDateFilter(query.from, query.to);
  if (dateFilter === null) return { error: "请选择正确的订单起止日期" };
  if (Object.keys(dateFilter).length) clauses.push(dateFilter);

  const users = await getCollection("users");
  if (query.channelId) {
    const userFilter = await releaseChannelUserFilter(query.channelId);
    if (!userFilter) return { error: "发行渠道筛选值无效" };
    const ownerIds = await users.distinct("_id", userFilter);
    clauses.push({ ownerId: { $in: ownerIds } });
  }

  if (query.q?.trim()) {
    const keyword = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = { $regex: keyword, $options: "i" };
    const matchedUsers = await users.find({
      $or: ["email", "emailNormalized", "username", "displayName", "chandlerUserId"].map((field) => ({ [field]: regex })),
    }, { projection: { _id: 1 } }).limit(5000).toArray();
    clauses.push({
      $or: [
        "orderNo",
        "merchantOrderNo",
        "chandlerOrderNo",
        "providerTransactionId",
        "userEmail",
        "provider",
        "kind",
        "cycle",
        "status",
        "plan.productName",
        "plan.skuName",
      ].map((field) => ({ [field]: regex })).concat({ ownerId: { $in: matchedUsers.map((user) => user._id) } }),
    });
  }
  return { filter: clauses.length ? { $and: clauses } : {} };
}

async function adminOrderRows(orders) {
  const ownerIds = [...new Map(orders.filter((order) => order.ownerId).map((order) => [String(order.ownerId), order.ownerId])).values()];
  const users = ownerIds.length
    ? await (await getCollection("users")).find({ _id: { $in: ownerIds } }, { projection: { email: 1, username: 1, displayName: 1, releaseChannelId: 1 } }).toArray()
    : [];
  const channelIds = [...new Map(users.filter((user) => user.releaseChannelId).map((user) => [String(user.releaseChannelId), user.releaseChannelId])).values()];
  const channels = channelIds.length
    ? await (await getCollection("releaseChannels")).find({ _id: { $in: channelIds } }, { projection: { name: 1, groupId: 1, isDefault: 1 } }).toArray()
    : [];
  const userMap = new Map(users.map((user) => [String(user._id), user]));
  const channelMap = new Map(channels.map((channel) => [String(channel._id), channel]));
  return orders.map((order) => {
    const user = userMap.get(String(order.ownerId));
    const channel = user?.releaseChannelId ? channelMap.get(String(user.releaseChannelId)) : null;
    return {
      ...order,
      id: order._id.toString(),
      ownerId: order.ownerId?.toString?.() || null,
      _id: undefined,
      user: user ? { id: user._id.toString(), email: user.email || null, displayName: user.displayName || user.username || null } : null,
      releaseChannel: channel
        ? { id: channel._id.toString(), name: channel.name, groupId: channel.groupId || null, isDefault: Boolean(channel.isDefault) }
        : { id: null, name: "古龙版", groupId: null, isDefault: true },
    };
  });
}

function objectSize(head) {
  return Number(head?.headers?.["content-length"] || head?.ContentLength || head?.contentLength || 0);
}

function workerPerson(user) {
  if (!user) return null;
  return {
    id: user._id?.toString?.() || String(user.id || ""),
    displayName: user.displayName || user.username || "古龙用户",
    avatar: user.avatar || null,
  };
}

function workerAssetJson(asset) {
  return {
    id: asset._id.toString(),
    section: asset.section,
    filename: asset.filename,
    contentType: asset.contentType,
    bytes: asset.bytes,
    status: asset.status,
    downloadPath: asset.status === "ready" ? `/api/worker/tasks/${asset.taskId}/assets/${asset._id}/download` : null,
  };
}

function workerTaskJson(task, { publisher, contractor, designatedAssignee, assets = [] } = {}) {
  const financials = workerTaskFinancials(task.budgetFen);
  const assignmentType = task.assignmentType || "open";
  const designatedUser = workerPerson(designatedAssignee);
  return {
    id: task._id.toString(),
    title: task.title,
    inputDescription: task.inputDescription,
    outputDescription: task.outputDescription,
    exampleDescription: task.exampleDescription || "",
    deadline: task.deadline,
    budgetFen: task.budgetFen,
    contractorIncomeFen: task.contractorIncomeFen ?? financials.contractorIncomeFen,
    platformServiceFeeFen: task.platformServiceFeeFen ?? financials.platformServiceFeeFen,
    status: task.status,
    paymentStatus: task.paymentStatus,
    paymentOrderNo: task.paymentOrderNo || null,
    paymentReviewReason: task.paymentReviewReason || null,
    progress: Number(task.progress || 0),
    progressNote: task.progressNote || "",
    deliveryNote: task.deliveryNote || "",
    publisher: workerPerson(publisher),
    contractor: workerPerson(contractor),
    assignment: {
      type: assignmentType,
      label: assignmentType === "platform_team"
        ? "平台团队"
        : assignmentType === "user"
          ? `指定用户 · ${designatedUser?.displayName || "待接单用户"}`
          : "公开接单",
      designatedUser,
    },
    assets: assets.map(workerAssetJson),
    workflowId: task.workflowId?.toString?.() || null,
    createdAt: task.createdAt,
    claimedAt: task.claimedAt || null,
    submittedAt: task.submittedAt || null,
    acceptedAt: task.acceptedAt || null,
    updatedAt: task.updatedAt,
  };
}

async function notifyUser(ownerId, type, title, message, details = {}) {
  const now = new Date();
  return (await getCollection("notifications")).insertOne({
    ownerId,
    type,
    title,
    message,
    readAt: null,
    ...details,
    createdAt: now,
    updatedAt: now,
  });
}

async function notifyUserOnce(ownerId, type, title, message, details = {}) {
  const now = new Date();
  const dedupe = { ownerId, type, ...(details.taskId ? { taskId: details.taskId } : {}), ...(details.workflowId ? { workflowId: details.workflowId } : {}) };
  return (await getCollection("notifications")).updateOne(
    dedupe,
    { $set: { title, message, readAt: null, ...details, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
}

async function workerTaskDetails(task) {
  if (!task) return null;
  const peopleIds = [task.publisherId, task.contractorId, task.designatedAssigneeId].filter(Boolean);
  const [people, assets] = await Promise.all([
    peopleIds.length ? (await getCollection("users")).find({ _id: { $in: peopleIds } }, { projection: { displayName: 1, username: 1, avatar: 1 } }).toArray() : [],
    (await getCollection("workerTaskUploads")).find({ taskId: task._id, status: "ready" }).sort({ createdAt: 1 }).toArray(),
  ]);
  const peopleMap = new Map(people.map((person) => [person._id.toString(), person]));
  return workerTaskJson(task, {
    publisher: peopleMap.get(task.publisherId?.toString()),
    contractor: peopleMap.get(task.contractorId?.toString()),
    designatedAssignee: peopleMap.get(task.designatedAssigneeId?.toString()),
    assets,
  });
}

function brainProgress(item) {
  if (Number.isFinite(item?.progress)) return Math.max(0, Math.min(100, Number(item.progress)));
  return ({ uploading: 20, queued_for_analysis: 40, analyzing: 72, completed: 100, failed: 100 })[item?.status] || 0;
}

async function effectiveLocalPrice({ skuId, cycle, at = new Date() } = {}) {
  const filter = {
    effectiveAt: { $lte: at },
    status: { $in: ["active", "scheduled"] },
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: at } }],
    ...(skuId ? { skuId } : {}),
    ...(cycle ? { billingInterval: cycle } : {}),
  };
  return (await getCollection("pricingVersions")).findOne(filter, { sort: { effectiveAt: -1, createdAt: -1 } });
}

async function persistChandlerPriceVersion({ plan, price, createdBy, source = "chandler-remote" }) {
  const amountFen = Number(price?.amount);
  const billingInterval = price?.billing_interval || plan.billingInterval;
  const effectiveAt = new Date(price?.effective_at || new Date());
  const expiresAt = price?.expires_at ? new Date(price.expires_at) : null;
  if (!price?.id || !Number.isSafeInteger(amountFen) || !["month", "year"].includes(billingInterval) || Number.isNaN(effectiveAt.getTime())) {
    throw new ChandlerError("Chandler 返回的价格版本数据不完整", { status: 502, code: "CHANDLER_PRICE_INVALID" });
  }
  const versions = await getCollection("pricingVersions");
  const now = new Date();
  const status = effectiveAt <= now ? "active" : "scheduled";
  const record = {
    skuId: plan.skuId,
    productId: plan.productId,
    productName: plan.productName,
    skuName: plan.skuName,
    currency: price.currency || plan.currency || "CNY",
    amountFen,
    billingInterval,
    intervalCount: Number(price.interval_count || plan.intervalCount || 1),
    effectiveAt,
    expiresAt,
    status,
    source,
    chandlerPriceId: price.id,
    chandlerSyncStatus: "synced",
    ...(createdBy ? { createdBy: new ObjectId(createdBy) } : {}),
    updatedAt: now,
  };
  const saved = await versions.findOneAndUpdate(
    { chandlerPriceId: price.id },
    { $set: record, $setOnInsert: { createdAt: now } },
    { upsert: true, returnDocument: "after" },
  );
  if (status === "active") {
    await versions.updateMany(
      { _id: { $ne: saved._id }, billingInterval, effectiveAt: { $lte: effectiveAt }, status: "active" },
      { $set: { status: "superseded", supersededAt: effectiveAt, updatedAt: now } },
    );
  }
  return saved;
}

async function synchronizeActiveChandlerPrices(plans, createdBy) {
  return Promise.all(plans
    .filter((plan) => plan.priceId)
    .map((plan) => persistChandlerPriceVersion({
      plan,
      price: {
        id: plan.priceId,
        amount: plan.amountFen,
        currency: plan.currency,
        billing_interval: plan.billingInterval,
        interval_count: plan.intervalCount,
        effective_at: plan.priceEffectiveAt || new Date(0).toISOString(),
        expires_at: plan.priceExpiresAt,
      },
      createdBy,
    })));
}

async function currentSubscriptionPricing(at = new Date()) {
  const config = chandlerConfig();
  const [monthVersion, yearVersion] = isDatabaseConfigured()
    ? await Promise.all([
        effectiveLocalPrice({ cycle: "month", at }),
        effectiveLocalPrice({ cycle: "year", at }),
      ])
    : [null, null];
  const point = (cycle, version, fallbackAmountFen) => ({
    cycle,
    amountFen: version?.amountFen ?? fallbackAmountFen,
    amountCny: (version?.amountFen ?? fallbackAmountFen) / 100,
    currency: version?.currency || "CNY",
    source: version?.source === "chandler-remote" ? "chandler" : version ? "website-admin" : "default",
    versionId: version?._id?.toString() || null,
    effectiveAt: version?.effectiveAt || null,
    updatedAt: version?.updatedAt || version?.createdAt || null,
  });
  const monthly = point("month", monthVersion, config.monthlyPriceFen);
  const yearly = point("year", yearVersion, config.yearlyPriceFen);
  const updatedAt = [monthly.updatedAt, yearly.updatedAt].filter(Boolean).sort((left, right) => new Date(right) - new Date(left))[0] || new Date(0);
  return {
    revision: `${monthly.versionId || `default-${monthly.amountFen}`}.${yearly.versionId || `default-${yearly.amountFen}`}`,
    currency: "CNY",
    monthly,
    yearly,
    updatedAt,
  };
}

function workerAuthorized(c) {
  const configured = process.env.RELEASE_WORKER_KEY?.trim();
  const provided = c.req.header("x-release-worker-key")?.trim();
  return Boolean(configured && provided && hashOpaqueToken(configured, "release-worker") === hashOpaqueToken(provided, "release-worker"));
}

async function releaseChannelAvailability(channel) {
  return recoverExpiredDirectReleaseLock(channel, {
    uploads: await getCollection("releaseUploads"),
    channels: await getCollection("releaseChannels"),
    deleteStoredObject: deleteObject,
  });
}

function bearerToken(c) {
  const authorization = String(c.req.header("authorization") || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

async function authenticateDesktopChandler(c, { admin = false } = {}) {
  const accessToken = bearerToken(c);
  if (!accessToken || accessToken.startsWith("gla_live_")) {
    return { error: c.json({ code: "CHANDLER_SESSION_REQUIRED", message: "请在古龙桌面端登录 Chandler 账号" }, 401) };
  }
  const payload = await chandlerRequest("/v1/me", { accessToken, timeoutMs: 8_000 });
  const chandlerUser = payload?.user || payload;
  if (!chandlerUser?.id) return { error: c.json({ code: "CHANDLER_SESSION_REQUIRED", message: "无法识别当前 Chandler 账号" }, 401) };
  const identity = await resolveChandlerIdentity(chandlerUser, accessToken);
  const user = await upsertChandlerUser(chandlerUser, { identity, defaultEdition: "gulong" });
  if (admin && identity.role !== "admin") {
    return { error: c.json({ code: "ADMIN_REQUIRED", message: "只有管理员账号对应的桌面端微信可以接收和处理审核订单" }, 403) };
  }
  return { accessToken, chandlerUser, user, identity };
}

async function enqueueOfflineReviewEvent(order, source = "new-order") {
  const now = new Date();
  await (await getCollection("offlinePaymentReviewEvents")).updateOne(
    { orderId: order._id },
    {
      $set: { orderNo: order.orderNo, status: "pending", source, availableAt: now, updatedAt: now },
      $unset: { claimedBy: "", claimedByChandlerUserId: "", workerId: "", leaseUntil: "", notifiedAt: "", outboundId: "", completedAt: "", action: "", actionMessageId: "" },
      $setOnInsert: { createdAt: now },
      $inc: { generation: 1 },
    },
    { upsert: true },
  );
}

async function ensureOfflineReviewEvent(order, source = "backfill") {
  const events = await getCollection("offlinePaymentReviewEvents");
  const existing = await events.findOne({ orderId: order._id });
  if (existing && !["completed", "cancelled"].includes(existing.status)) return false;
  await enqueueOfflineReviewEvent(order, source);
  return true;
}

function desktopOfflinePaymentRow(order) {
  const editionKey = order.editionKey === "yongshenghua" || String(order.applicationKey || "").includes("airos") ? "yongshenghua" : "gulong";
  const target = chandlerApplicationTargets().find((item) => item.editionKey === editionKey) || chandlerApplicationTargets()[0];
  return {
    id: order._id.toString(),
    websiteOrderId: order._id.toString(),
    application: {
      key: editionKey === "yongshenghua" ? "airos-eternal-flower" : "gulong",
      name: editionKey === "yongshenghua" ? "爱若斯-永生花" : "古龙智能引擎",
      clientId: target?.id || "",
      themeName: editionKey === "yongshenghua" ? "永生花" : "上古神龙",
    },
    orderNo: order.orderNo,
    userId: order.chandlerUserId || "",
    userEmail: order.userEmail || "",
    planKind: order.cycle === "year" ? "yearly" : "monthly",
    productName: order.plan?.productName || (order.cycle === "year" ? "年度订阅会员" : "月度订阅会员"),
    amountFen: order.amountFen,
    reviewStatus: order.status,
    submittedAt: order.createdAt,
    reviewedAt: order.reviewedAt ? new Date(order.reviewedAt).toISOString() : "",
    validFrom: order.validFrom ? new Date(order.validFrom).toISOString() : "",
    validUntil: order.validUntil ? new Date(order.validUntil).toISOString() : "",
  };
}

async function synchronizeChandlerOfflinePayments(accessToken) {
  if (!accessToken) return { imported: 0, inspected: 0 };
  const offlinePayments = await getCollection("offlinePayments");
  let imported = 0;
  let inspected = 0;
  for (const target of chandlerApplicationTargets()) {
    let payload;
    try {
      payload = await chandlerRequest(`/v1/me/orders?client_id=${encodeURIComponent(target.id)}&page=1&limit=100`, { accessToken, timeoutMs: 8_000 });
    } catch {
      continue;
    }
    for (const rawOrder of chandlerOrderItems(payload)) {
      const candidate = normalizeChandlerOfflineOrder(rawOrder, { ...target, key: target.editionKey === "yongshenghua" ? "airos-eternal-flower" : "gulong" });
      if (!candidate || candidate.reviewStatus !== "pending") continue;
      inspected += 1;
      const owner = await upsertChandlerUser({
        id: candidate.chandlerUserId,
        email: candidate.userEmail,
        display_name: candidate.userEmail.split("@")[0],
        status: "active",
      }, {
        identity: { role: "user", editionKey: candidate.editionKey, editionName: candidate.editionName, editionSource: "desktop-offline-payment" },
        defaultEdition: candidate.editionKey,
      });
      const document = {
        orderNo: candidate.orderNo,
        chandlerOrderNo: candidate.orderNo,
        ownerId: owner._id,
        chandlerUserId: candidate.chandlerUserId,
        userEmail: candidate.userEmail,
        cycle: candidate.cycle,
        amountFen: candidate.amountFen,
        plan: {
          productId: candidate.partnerData.product_id || "subscription",
          productName: candidate.partnerData.product_name || (candidate.cycle === "year" ? "年度订阅会员" : "月度订阅会员"),
          skuId: candidate.partnerData.sku_id || null,
          skuName: candidate.partnerData.sku_name || null,
          source: "desktop-chandler-import",
        },
        partnerData: candidate.partnerData,
        applicationId: candidate.applicationId,
        applicationKey: candidate.applicationKey,
        editionKey: candidate.editionKey,
        status: "pending",
        source: "desktop-chandler-import",
        createdAt: candidate.createdAt,
        updatedAt: new Date(),
      };
      let order = await offlinePayments.findOne({ orderNo: candidate.orderNo });
      if (!order) {
        try {
          const result = await offlinePayments.insertOne(document);
          order = { ...document, _id: result.insertedId };
          imported += 1;
        } catch (error) {
          if (error?.code !== 11000) throw error;
          order = await offlinePayments.findOne({ orderNo: candidate.orderNo });
        }
      }
      if (order?.status === "pending") await ensureOfflineReviewEvent(order, imported ? "desktop-chandler-import" : "desktop-chandler-backfill").catch(() => null);
    }
  }
  return { imported, inspected };
}

async function syncChandlerOfflinePayments(accessToken, { force = false } = {}) {
  if (!accessToken) return { imported: 0, inspected: 0, skipped: true };
  if (!force && Date.now() - offlinePaymentSynchronizedAt < 30_000) return { imported: 0, inspected: 0, skipped: true };
  if (offlinePaymentSyncPromise) return offlinePaymentSyncPromise;
  offlinePaymentSyncPromise = synchronizeChandlerOfflinePayments(accessToken);
  try {
    const result = await offlinePaymentSyncPromise;
    offlinePaymentSynchronizedAt = Date.now();
    return result;
  } finally {
    offlinePaymentSyncPromise = null;
  }
}

function desktopReviewEvent(event, order) {
  return {
    eventId: event._id.toString(),
    generation: Number(event.generation || 1),
    orderId: order._id.toString(),
    orderNo: order.orderNo,
    cycle: order.cycle,
    amountFen: order.amountFen,
    userEmail: order.userEmail || null,
    message: offlineReviewWechatMessage(order),
    status: event.status,
    leaseUntil: event.leaseUntil || null,
  };
}

async function approveOfflinePayment({ orderId, actorUserId, actorChandlerUserId, accessToken, validFrom, validUntil }) {
  const orders = await getCollection("offlinePayments");
  const order = await orders.findOne({ _id: new ObjectId(orderId) });
  if (!order || !["pending", "approved"].includes(order.status)) return { error: { code: "ORDER_STATE_CHANGED", message: "申请不存在或已经被拒绝", status: 409 } };
  const alreadyApproved = order.status === "approved";
  const storedStart = alreadyApproved ? new Date(order.validFrom) : null;
  const storedEnd = alreadyApproved ? new Date(order.validUntil) : null;
  const start = storedStart && !Number.isNaN(storedStart.getTime())
    ? storedStart
    : safeDate(validFrom) || (order.upgradeFrom === "month" && order.upgradeBaseStart ? new Date(order.upgradeBaseStart) : new Date());
  const end = storedEnd && !Number.isNaN(storedEnd.getTime())
    ? storedEnd
    : safeDate(validUntil, true) || new Date(start);
  if (!alreadyApproved && !validUntil) {
    if (order.cycle === "year") end.setFullYear(end.getFullYear() + 1);
    else end.setMonth(end.getMonth() + 1);
  }
  if (end <= start) return { error: { code: "VALIDATION_ERROR", message: "订阅截止日期必须晚于生效日期", status: 400 } };
  const now = new Date();
  const partnerData = { ...order.partnerData, review_status: "approved", business_payment_status: "paid_offline", reviewed_by: actorChandlerUserId || null, reviewed_at: now.toISOString(), valid_from: start.toISOString(), valid_until: end.toISOString() };
  if (!alreadyApproved) {
    const changed = await orders.updateOne(
      { _id: order._id, status: "pending" },
      { $set: { status: "approved", partnerData, validFrom: start, validUntil: end, reviewedBy: new ObjectId(actorUserId), reviewedAt: now, updatedAt: now } },
    );
    if (!changed.modifiedCount) return { error: { code: "ORDER_STATE_CHANGED", message: "订单状态已变化，请刷新后重试", status: 409 } };
  }
  await Promise.all([
    (await getCollection("subscriptions")).updateOne(
      { ownerId: order.ownerId },
      { $set: { plan: "member", cycle: order.cycle, provider: "offline", status: "active", currentPeriodStart: start, currentPeriodEnd: end, autoRenew: false, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    ),
    (await getCollection("notifications")).updateOne(
      { ownerId: order.ownerId, type: "offline_payment_approved", orderId: order._id },
      { $set: { title: "线下支付审核已通过", message: `订单 ${order.orderNo} 已确认到账，会员权益已经生效。`, orderNo: order.orderNo, readAt: null, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    ),
  ]);
  if (accessToken && order.chandlerOrderNo) {
    const applicationId = order.applicationId || chandlerConfig().applicationId;
    await chandlerRequest(`/v1/me/orders/${encodeURIComponent(order.chandlerOrderNo)}/partner-data?client_id=${encodeURIComponent(applicationId)}`, { method: "PUT", accessToken, body: { partner_data: partnerData } }).catch(() => null);
  }
  if (accessToken && order.chandlerUserId) {
    try {
      const applicationId = order.applicationId || chandlerConfig().applicationId;
      const path = `/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/users/${encodeURIComponent(order.chandlerUserId)}/attributes`;
      const current = await chandlerRequest(path, { accessToken });
      const attributes = current.attributes && typeof current.attributes === "object" ? current.attributes : {};
      await chandlerRequest(path, { method: "PUT", accessToken, body: { attributes: { ...attributes, subscription_status: "active", subscription_source: "offline_review", subscription_order_no: order.orderNo, subscription_valid_from: start.toISOString(), subscription_valid_until: end.toISOString(), subscription_valid_from_unix_ms: start.getTime(), subscription_valid_until_unix_ms: end.getTime(), subscription_reviewed_at_unix_ms: now.getTime() } } });
    } catch { /* Website MongoDB remains authoritative and desktop reads it directly. */ }
  }
  return { ok: true, orderNo: order.orderNo, status: "approved", validFrom: start, validUntil: end, message: "审核已通过，会员权益已经生效并可由桌面端立即同步" };
}

async function rejectOfflinePayment({ orderId, actorUserId, actorChandlerUserId, accessToken, reason }) {
  const orders = await getCollection("offlinePayments");
  const order = await orders.findOne({ _id: new ObjectId(orderId) });
  if (!order || !["pending", "rejected"].includes(order.status)) return { error: { code: "ORDER_STATE_CHANGED", message: "申请不存在或已经通过", status: 409 } };
  const alreadyRejected = order.status === "rejected";
  const normalizedReason = String(alreadyRejected ? order.reviewReason : reason || OFFLINE_REVIEW_REJECTION_REASON).trim();
  if (normalizedReason.length < 2 || normalizedReason.length > 500) return { error: { code: "VALIDATION_ERROR", message: "请填写 2–500 字的拒绝原因", status: 400 } };
  const now = new Date();
  const partnerData = { ...order.partnerData, review_status: "rejected", business_payment_status: "rejected_offline", rejection_reason: normalizedReason, reviewed_by: actorChandlerUserId || null, reviewed_at: now.toISOString() };
  if (!alreadyRejected) {
    const changed = await orders.updateOne(
      { _id: order._id, status: "pending" },
      { $set: { status: "rejected", reviewReason: normalizedReason, partnerData, reviewedBy: new ObjectId(actorUserId), reviewedAt: now, rejectedAt: now, updatedAt: now } },
    );
    if (!changed.modifiedCount) return { error: { code: "ORDER_STATE_CHANGED", message: "订单状态已变化，请刷新后重试", status: 409 } };
  }
  await (await getCollection("notifications")).updateOne(
    { ownerId: order.ownerId, type: "offline_payment_rejected", orderId: order._id },
    { $set: { title: "线下支付申请未通过", message: `订单 ${order.orderNo} 未通过审核，请查看原因并调整后重新申请。`, reason: normalizedReason, orderNo: order.orderNo, readAt: null, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  if (accessToken && order.chandlerOrderNo) {
    const applicationId = order.applicationId || chandlerConfig().applicationId;
    await chandlerRequest(`/v1/me/orders/${encodeURIComponent(order.chandlerOrderNo)}/partner-data?client_id=${encodeURIComponent(applicationId)}`, { method: "PUT", accessToken, body: { partner_data: partnerData } }).catch(() => null);
  }
  return { ok: true, orderNo: order.orderNo, status: "rejected", reason: normalizedReason, message: `审核已拒绝，原因已经同步给用户：${normalizedReason}` };
}

function publicReleaseMetadata(channel, edition = productEditionFromChannel(channel)) {
  const latest = channel?.latestRelease;
  if (!edition || channel?.distributionStatus === "uploading" || !latest?.objectKey) return null;
  return {
    editionKey: edition.key,
    editionName: edition.name,
    channelId: channel._id.toString(),
    channelName: channel.name,
    version: latest.version,
    filename: latest.filename,
    bytes: latest.bytes,
    sha256: latest.sha256,
    signatureStatus: latest.signatureStatus,
    publishedAt: latest.publishedAt,
  };
}

async function publicEditionChannels() {
  if (!isDatabaseConfigured()) return new Map();
  const channels = await (await getCollection("releaseChannels"))
    .find({ enabled: true, distributionStatus: { $ne: "uploading" }, "latestRelease.objectKey": { $exists: true } })
    .sort({ isDefault: -1, "latestRelease.publishedAt": -1, sort: 1 })
    .limit(128)
    .toArray();
  const result = new Map();
  for (const channel of channels) {
    const edition = productEditionFromChannel(channel);
    if (edition && !result.has(edition.key)) result.set(edition.key, channel);
  }
  return result;
}

const AuthResponseSchema = z.object({ user: PublicUserSchema });

const TaskSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  workflowId: z.string(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  callbackUrl: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const createTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks",
  tags: ["Tasks"],
  summary: "创建智能体任务",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            prompt: z.string().min(1).max(20_000),
            workflowId: z.string().max(80).optional(),
            callbackUrl: z.url().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "任务已进入执行队列",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            status: z.enum(["queued", "running", "completed", "failed"]),
            createdAt: z.coerce.date(),
          }),
        },
      },
    },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listTasksRoute = createRoute({
  method: "get",
  path: "/api/v1/tasks",
  tags: ["Tasks"],
  summary: "列出当前开发者的任务",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "最近 50 个任务", content: { "application/json": { schema: z.object({ tasks: z.array(TaskSchema) }) } } },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getTaskRoute = createRoute({
  method: "get",
  path: "/api/v1/tasks/{id}",
  tags: ["Tasks"],
  summary: "读取单个任务状态",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "任务详情", content: { "application/json": { schema: TaskSchema } } },
    404: { description: "任务不存在", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const MemorySchema = z.object({
  id: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  createdAt: z.coerce.date(),
});

const createMemoryRoute = createRoute({
  method: "post",
  path: "/api/v1/brain/memories",
  tags: ["Second Brain"],
  summary: "写入长期记忆",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: z.object({ content: z.string().min(1).max(30_000), tags: z.array(z.string()).max(20).optional() }) } } } },
  responses: {
    201: { description: "已存储", content: { "application/json": { schema: z.object({ id: z.string(), status: z.literal("stored") }) } } },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listMemoriesRoute = createRoute({
  method: "get",
  path: "/api/v1/brain/memories",
  tags: ["Second Brain"],
  summary: "读取长期记忆",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "最近 50 条记忆", content: { "application/json": { schema: z.object({ memories: z.array(MemorySchema) }) } } },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listWorkflowsRoute = createRoute({
  method: "get",
  path: "/api/v1/workflows",
  tags: ["Workflows"],
  summary: "列出可用工作流",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "工作流目录", content: { "application/json": { schema: z.object({ workflows: z.array(z.object({ id: z.string(), name: z.string(), access: z.enum(["free", "member"]) })) }) } } },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const issueOfflineCredentialRoute = createRoute({
  method: "post",
  path: "/api/auth/offline-credential",
  tags: ["Authentication"],
  summary: "签发 Chandler 离线权益凭据",
  description: "签发短期 RS256 JWT，可在桌面端通过 Chandler JWKS 离线验签；可选绑定 installId。",
  request: { body: { required: false, content: { "application/json": { schema: z.object({ installId: z.string().max(160).optional() }) } } } },
  responses: {
    201: { description: "离线权益凭据", content: { "application/json": { schema: z.object({ credential: z.string(), expires_at: z.string().optional(), verificationJwks: z.url() }) } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const latestBrainAttachmentRoute = createRoute({
  method: "get",
  path: "/api/v1/brain/attachments/latest",
  tags: ["Second Brain"],
  summary: "按日期获取最新第二大脑附件",
  description: "管理员会话或具有 brain:attachments:read 权限的管理员 API Key 可调用。返回 15 分钟有效的腾讯云 COS 签名下载地址。",
  security: [{ bearerAuth: [] }],
  request: { query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), keyword: z.string().max(160).optional() }) },
  responses: {
    200: { description: "指定日期的最新附件", content: { "application/json": { schema: z.object({ id: z.string(), date: z.string(), originalName: z.string(), size: z.number(), createdAt: z.coerce.date(), downloadUrl: z.url(), expiresIn: z.number() }) } } },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "指定日期没有附件", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const latestReleaseRoute = createRoute({
  method: "get",
  path: "/api/releases/latest",
  tags: ["Releases"],
  summary: "读取当前账号可用的最新 Windows 版本",
  responses: { 200: { description: "最新发行元数据", content: { "application/json": { schema: z.object({ release: z.object({ channelId: z.string(), channelName: z.string(), version: z.string(), filename: z.string(), bytes: z.number(), sha256: z.string(), signatureStatus: z.string(), publishedAt: z.coerce.date() }).nullable() }) } } } },
});

const WorkerTaskResponseSchema = z.object({ task: z.record(z.string(), z.unknown()) }).passthrough();
const workerCreateTaskRoute = createRoute({
  method: "post", path: "/api/worker/tasks", tags: ["Worker Market"], summary: "发布威客需求并创建预算托管单",
  description: "发布者必须先填写微信号。支持公开接单、指定用户或平台团队；任务内容创建后锁定，附件通过腾讯云 COS 直传。",
  request: { body: { content: { "application/json": { schema: z.object({ inputDescription: z.string().min(10).max(10000), outputDescription: z.string().min(10).max(10000), exampleDescription: z.string().max(5000).optional(), deadline: z.string(), budgetFen: z.number().int().min(100).max(5000000), assignmentType: z.enum(["open", "user", "platform_team"]).optional(), assigneeUserId: z.string().optional() }) } } } },
  responses: { 201: { description: "待付款任务", content: { "application/json": { schema: WorkerTaskResponseSchema } } }, 400: { description: "参数不正确", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } } },
});
const workerSearchAssigneesRoute = createRoute({
  method: "get", path: "/api/worker/assignees", tags: ["Worker Market"], summary: "搜索可指定的接单用户",
  description: "登录用户可按昵称或邮箱关键词模糊搜索；返回结果不包含当前发单人。",
  request: { query: z.object({ q: z.string().min(2).max(100) }) },
  responses: {
    200: { description: "候选接单用户", content: { "application/json": { schema: z.object({ users: z.array(z.object({ id: z.string(), displayName: z.string(), email: z.string().nullable(), avatar: z.string().nullable(), role: z.string() })) }) } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
  },
});
const workerListTasksRoute = createRoute({
  method: "get", path: "/api/worker/tasks", tags: ["Worker Market"], summary: "读取接单大厅或我的威客任务",
  request: { query: z.object({ view: z.enum(["market", "published", "claimed"]).optional() }) },
  responses: { 200: { description: "真实任务列表", content: { "application/json": { schema: z.object({ tasks: z.array(z.record(z.string(), z.unknown())), view: z.string() }) } } }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } } },
});
function workerActionRoute(method, path, summary, requestBody) {
  return createRoute({ method, path, tags: ["Worker Market"], summary, ...(requestBody ? { request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: requestBody } } } } } : { request: { params: z.object({ id: z.string() }) } }), responses: { 200: { description: "任务状态已更新", content: { "application/json": { schema: WorkerTaskResponseSchema } } }, 400: { description: "参数不正确", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } }, 409: { description: "任务状态冲突", content: { "application/json": { schema: ErrorSchema } } } } });
}
const workerSubmitPaymentRoute = workerActionRoute("post", "/api/worker/tasks/{id}/payment-submit", "提交威客预算线下付款审核");
const workerClaimTaskRoute = workerActionRoute("post", "/api/worker/tasks/{id}/claim", "接单并原子锁定任务");
const workerUpdateProgressRoute = workerActionRoute("patch", "/api/worker/tasks/{id}/progress", "接单者更新任务进度与文字说明", z.object({ progress: z.number().int().min(5).max(99), note: z.string().min(2).max(1000) }));
const workerSubmitTaskRoute = workerActionRoute("post", "/api/worker/tasks/{id}/submit", "接单者提交最终交付", z.object({ deliveryNote: z.string().min(10).max(10000) }));
const workerAcceptTaskRoute = workerActionRoute("post", "/api/worker/tasks/{id}/accept", "发布者验收并按 80/20 结算");
const adminSetWebsiteRoleRoute = createRoute({
  method: "put", path: "/api/admin/users/{id}/role", tags: ["Admin · Users"], summary: "将官网用户提升为管理员",
  description: "写入持久 roleOverride，后续 Chandler 登录不会覆盖管理员角色。",
  request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: z.object({ role: z.literal("admin") }) } } } },
  responses: { 200: { description: "角色已更新", content: { "application/json": { schema: z.object({ ok: z.literal(true), userId: z.string(), role: z.literal("admin"), message: z.string() }) } } }, 403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } }, 404: { description: "用户不存在", content: { "application/json": { schema: ErrorSchema } } } },
});

const adminUpdateSubscriptionPeriodRoute = createRoute({
  method: "put",
  path: "/api/admin/users/{id}/subscription-period",
  tags: ["Admin · Users"],
  summary: "修改用户会员有效期",
  description: "由管理员精确设置官网会员的生效时间和到期时间；官网与桌面端均以该时间段为准，并尽力同步 Chandler 用户属性。",
  request: {
    params: z.object({ id: z.string().min(1).max(100) }),
    body: { content: { "application/json": { schema: z.object({
      currentPeriodStart: z.string().datetime(),
      currentPeriodEnd: z.string().datetime(),
    }) } } },
  },
  responses: {
    200: { description: "会员有效期已更新", content: { "application/json": { schema: z.object({
      ok: z.literal(true),
      userId: z.string(),
      status: z.enum(["scheduled", "active", "expired"]),
      currentPeriodStart: z.string().datetime(),
      currentPeriodEnd: z.string().datetime(),
      chandlerSynced: z.boolean(),
      message: z.string(),
    }) } } },
    400: { description: "时间范围无效", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "用户不存在", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminManualReleaseUploadRoute = createRoute({
  method: "post",
  path: "/api/admin/release-channels/{id}/manual-upload",
  tags: ["Admin · Releases"],
  summary: "创建发行渠道的手动 COS 上传任务",
  description: "管理员获取限时 PUT 地址后从浏览器直传腾讯云 COS。上传完成前不会移除当前线上版本。",
  request: {
    params: z.object({ id: z.string().min(1).max(100) }),
    body: { content: { "application/json": { schema: z.object({ filename: z.string().min(1).max(180), bytes: z.number().int().min(1024).max(5 * 1024 * 1024 * 1024), version: z.string().min(1).max(40) }) } } },
  },
  responses: {
    201: { description: "COS 直传凭据", content: { "application/json": { schema: z.object({ uploadId: z.string(), uploadUrl: z.url(), objectKey: z.string(), expiresIn: z.number(), requiredHeaders: z.record(z.string(), z.string()) }).passthrough() } } },
    400: { description: "安装包信息无效", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "渠道已有任务", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminCompleteManualReleaseUploadRoute = createRoute({
  method: "post",
  path: "/api/admin/release-uploads/{id}/complete",
  tags: ["Admin · Releases"],
  summary: "校验并发布手动上传的安装包",
  description: "核对 COS 对象大小，原子切换渠道最新版，成功后再清理旧安装包。",
  request: { params: z.object({ id: z.string().min(1).max(100) }) },
  responses: {
    200: { description: "新版本已生效", content: { "application/json": { schema: z.object({ ok: z.literal(true), channelId: z.string(), latestRelease: z.record(z.string(), z.unknown()), cleanupWarning: z.string().nullable() }) } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "上传任务不存在", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "对象不完整或渠道版本冲突", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const releaseWorkerPrepareRoute = createRoute({
  method: "post",
  path: "/api/release-worker/releases/prepare",
  tags: ["Release Worker"],
  summary: "旧版桌面端直传发行（已停用）",
  description: "此协议已永久停用。发行只能由管理员在版本管理中显式选择“手动上传”或创建“手动打包发布”任务。",
  deprecated: true,
  responses: {
    410: { description: "旧版直传协议已停用", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const releaseWorkerCompleteRoute = createRoute({
  method: "post",
  path: "/api/release-worker/releases/{publishId}/complete",
  tags: ["Release Worker"],
  summary: "旧版桌面端直传完成（已停用）",
  description: "此协议已永久停用，不再接受任何旧版直传发行的完成回执。",
  deprecated: true,
  request: {
    params: z.object({ publishId: z.string().min(1).max(100) }),
  },
  responses: {
    410: { description: "旧版直传协议已停用", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const releaseWorkerFailRoute = createRoute({
  method: "post",
  path: "/api/release-worker/releases/{publishId}/fail",
  tags: ["Release Worker"],
  summary: "旧版桌面端直传失败回执（已停用）",
  description: "此协议已永久停用，不再接受任何旧版直传发行的失败回执。",
  deprecated: true,
  request: {
    params: z.object({ publishId: z.string().min(1).max(100) }),
  },
  responses: {
    410: { description: "旧版直传协议已停用", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getMiniMaxConfigurationRoute = createRoute({
  method: "get",
  path: "/api/v1/configuration/minimax",
  tags: ["User Configuration"],
  summary: "桌面端读取当前用户的 MiniMax 配置",
  description: "只接受具有 configuration:read 权限的古龙 API Key。返回当前 Key 所属用户自己的 MiniMax 配置；响应禁止缓存。",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "MiniMax 运行配置", content: { "application/json": { schema: z.object({ provider: z.literal("minimax"), apiKey: z.string(), apiHost: z.url(), model: z.string(), updatedAt: z.coerce.date() }) } } },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "必须使用带权限的 API Key", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "尚未配置", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getAccountProfileRoute = createRoute({
  method: "get",
  path: "/api/v1/account/profile",
  tags: ["User Configuration"],
  summary: "桌面端同步当前用户资料与头像",
  description: "只接受具有 profile:read 权限的古龙 API Key。头像地址会在用户更新头像后自动变化，响应禁止缓存。",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "当前用户资料", content: { "application/json": { schema: z.object({ id: z.string(), username: z.string().nullable(), displayName: z.string().nullable(), avatar: z.string().nullable(), edition: z.object({ key: z.string(), name: z.string() }), updatedAt: z.coerce.date() }) } } },
    401: { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "必须使用带权限的 API Key", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const SubscriptionPricePointSchema = z.object({
  cycle: z.enum(["month", "year"]),
  amountFen: z.number().int(),
  amountCny: z.number(),
  currency: z.literal("CNY"),
  source: z.enum(["chandler", "website-admin", "default"]),
  versionId: z.string().nullable(),
  effectiveAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date().nullable(),
});

const PaymentAvailabilitySchema = z.object({
  online: z.boolean(),
  status: z.enum(["available", "coming_soon"]),
  notice: z.string(),
  priorityProvider: z.enum(["wechat", "alipay"]),
  channels: z.object({
    wechat: z.object({ enabled: z.boolean(), status: z.enum(["available", "coming_soon", "planned"]), label: z.string(), message: z.string() }),
    alipay: z.object({ enabled: z.boolean(), status: z.enum(["available", "coming_soon", "planned"]), label: z.string(), message: z.string() }),
  }),
});

const getSubscriptionPricingRoute = createRoute({
  method: "get",
  path: "/api/v1/pricing/subscriptions",
  tags: ["Desktop Synchronization"],
  summary: "桌面端实时同步订阅价格",
  description: "公开返回古龙官网当前生效的月度与年度会员价格。管理员发布后立即更新；响应禁止缓存，桌面端应在打开订阅页时重新拉取。",
  security: [],
  responses: {
    200: { description: "当前生效的订阅价格与支付渠道快照", content: { "application/json": { schema: z.object({ revision: z.string(), currency: z.literal("CNY"), monthly: SubscriptionPricePointSchema, yearly: SubscriptionPricePointSchema, updatedAt: z.coerce.date(), paymentAvailability: PaymentAvailabilitySchema }) } } },
  },
});

const DesktopReviewEventSchema = z.object({
  eventId: z.string(),
  generation: z.number().int().min(1),
  orderId: z.string(),
  orderNo: z.string(),
  cycle: z.enum(["month", "year"]),
  amountFen: z.number().int(),
  userEmail: z.string().nullable(),
  message: z.string(),
  status: z.enum(["leased", "awaiting_action"]),
  leaseUntil: z.coerce.date().nullable(),
});

const DesktopOfflinePaymentSchema = z.object({
  id: z.string(),
  websiteOrderId: z.string(),
  application: z.object({ key: z.string(), name: z.string(), clientId: z.string(), themeName: z.string() }),
  orderNo: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  planKind: z.enum(["monthly", "yearly"]),
  productName: z.string(),
  amountFen: z.number().int(),
  reviewStatus: z.enum(["pending", "approved", "rejected"]),
  submittedAt: z.coerce.date(),
  reviewedAt: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
});

const desktopCreateOfflinePaymentRoute = createRoute({
  method: "post",
  path: "/api/v1/desktop/offline-payments",
  tags: ["Desktop Synchronization"],
  summary: "桌面端提交线下支付待审核订单",
  description: "使用普通用户当前 Chandler Bearer Token，将“我已支付”声明幂等写入官网 MongoDB 权威审核队列。成功后网页管理员和已绑定的管理员桌面端可跨设备立即读取。",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: z.object({
    clientOrderNo: z.string().min(16).max(200),
    applicationKey: z.enum(["gulong", "airos-eternal-flower"]),
    themeName: z.string().min(1).max(80),
    releaseChannel: z.string().min(1).max(100),
    planKind: z.enum(["monthly", "yearly"]),
    expectedAmountFen: z.number().int().min(100).max(5_000_000),
  }) } } } },
  responses: {
    201: { description: "已进入统一审核队列", content: { "application/json": { schema: z.object({ order: DesktopOfflinePaymentSchema, idempotent: z.boolean() }) } } },
    401: { description: "Chandler 登录失效", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "价格或幂等订单冲突", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopAdminOfflinePaymentsRoute = createRoute({
  method: "get",
  path: "/api/v1/admin/offline-payments",
  tags: ["Desktop Synchronization"],
  summary: "管理员桌面端跨设备读取线下支付订单",
  description: "只允许 Chandler 全局管理员读取官网统一审核队列；同时补录旧版桌面端已经镜像到 Chandler、但尚未进入官网 MongoDB 的订单。",
  security: [{ bearerAuth: [] }],
  request: { query: z.object({ status: z.enum(["pending", "reviewed", "approved", "rejected"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
  responses: {
    200: { description: "统一审核订单", content: { "application/json": { schema: z.object({ orders: z.array(DesktopOfflinePaymentSchema), synchronized: z.object({ imported: z.number().int(), inspected: z.number().int(), skipped: z.boolean().optional() }) }) } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopAdminApproveOfflinePaymentRoute = createRoute({
  method: "post",
  path: "/api/v1/admin/offline-payments/{orderId}/approve",
  tags: ["Desktop Synchronization"],
  summary: "管理员桌面端审核通过官网线下支付订单",
  description: "使用 Chandler 全局管理员身份审核官网 MongoDB 权威订单，会员权益会立即同步到网页端和普通用户桌面端。",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ orderId: z.string().min(1).max(100) }),
    body: { content: { "application/json": { schema: z.object({ validFrom: z.string().optional(), validUntil: z.string().optional() }) } } },
  },
  responses: {
    200: { description: "审核完成", content: { "application/json": { schema: DesktopOfflinePaymentSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "订单状态已经变化", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopReviewBindRoute = createRoute({
  method: "post",
  path: "/api/v1/admin/wechat-review/bind",
  tags: ["Desktop Synchronization"],
  summary: "绑定管理员桌面端微信审核工作器",
  description: "使用桌面端当前 Chandler Bearer Token 验证全局管理员。普通用户与会员统一返回 403，不会获得待审核订单。",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: z.object({ workerId: z.string().min(16).max(160), channel: z.literal("personal-wechat") }) } } } },
  responses: {
    200: { description: "管理员工作器已绑定", content: { "application/json": { schema: z.object({ ok: z.literal(true), workerId: z.string(), administrator: z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string().nullable() }) }) } } },
    401: { description: "Chandler 登录失效", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员不推送", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopReviewClaimRoute = createRoute({
  method: "post",
  path: "/api/v1/admin/wechat-review/claim",
  tags: ["Desktop Synchronization"],
  summary: "领取下一个微信端线下支付审核提醒",
  description: "每个管理员微信工作器同一时间只领取一个订单，使回复数字 1/2 始终对应唯一订单。没有待审核订单时 event 为 null。",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: z.object({ workerId: z.string().min(16).max(160) }) } } } },
  responses: { 200: { description: "审核事件", content: { "application/json": { schema: z.object({ event: DesktopReviewEventSchema.nullable() }) } } }, 403: { description: "非管理员不推送", content: { "application/json": { schema: ErrorSchema } } } },
});

const desktopReviewNotifiedRoute = createRoute({
  method: "post",
  path: "/api/v1/admin/wechat-review/{eventId}/notified",
  tags: ["Desktop Synchronization"],
  summary: "确认审核菜单已经进入管理员微信发送队列",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ eventId: z.string().min(1).max(100) }), body: { content: { "application/json": { schema: z.object({ workerId: z.string().min(16).max(160), outboundId: z.string().min(1).max(200) }) } } } },
  responses: { 200: { description: "等待数字回复", content: { "application/json": { schema: z.object({ ok: z.literal(true), status: z.literal("awaiting_action") }) } } }, 409: { description: "事件已变化", content: { "application/json": { schema: ErrorSchema } } } },
});

const desktopReviewActionRoute = createRoute({
  method: "post",
  path: "/api/v1/admin/wechat-review/{eventId}/action",
  tags: ["Desktop Synchronization"],
  summary: "通过管理员微信数字回复审核订单",
  description: "action=approve 对应回复 1；action=reject 对应回复 2。拒绝时可附带 reason，否则使用安全默认原因。操作完成后会员权益立即写入官网并同步 Chandler。",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ eventId: z.string().min(1).max(100) }), body: { content: { "application/json": { schema: z.object({ workerId: z.string().min(16).max(160), action: z.enum(["approve", "reject"]), reason: z.string().min(2).max(500).optional(), messageId: z.string().max(200).optional() }) } } } },
  responses: { 200: { description: "审核完成", content: { "application/json": { schema: z.object({ ok: z.literal(true), orderNo: z.string(), status: z.enum(["approved", "rejected"]), message: z.string() }).passthrough() } } }, 403: { description: "非管理员或工作器不匹配", content: { "application/json": { schema: ErrorSchema } } }, 409: { description: "订单已经审核", content: { "application/json": { schema: ErrorSchema } } } },
});

const desktopSubscriptionStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/desktop/account/subscription",
  tags: ["Desktop Synchronization"],
  summary: "桌面端读取官网实时会员权益",
  description: "使用当前 Chandler Bearer Token 映射官网账号，返回 MongoDB 权威订阅状态；线下订单通过后桌面端下次轮询即可立即解锁。",
  security: [{ bearerAuth: [] }],
  responses: { 200: { description: "实时订阅状态", content: { "application/json": { schema: z.object({ isMember: z.boolean(), subscription: z.record(z.string(), z.unknown()).nullable(), checkedAt: z.coerce.date() }) } } }, 401: { description: "Chandler 登录失效", content: { "application/json": { schema: ErrorSchema } } } },
});

const ChandlerAdminUserSchema = z.object({
  id: z.string(),
  email: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  status: z.string().optional(),
  risk_level: z.string().nullable().optional(),
  created_at: z.string().optional(),
}).passthrough();

const adminListChandlerUsersRoute = createRoute({
  method: "get",
  path: "/api/admin/chandler/users",
  tags: ["Admin · Chandler"],
  summary: "搜索官网与 Chandler 应用订阅用户",
  description: "通过 Chandler 应用级接口同步古龙版、永生花版授权用户及订阅属性，再与官网 MongoDB 用户合并。此接口不要求 Chandler 平台运营管理员权限。",
  request: { query: z.object({ q: z.string().max(160).optional(), channelId: z.string().max(100).optional(), status: z.enum(["active", "disabled", "deleted"]).optional(), page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
  responses: {
    200: { description: "Chandler 用户列表", content: { "application/json": { schema: z.object({ users: z.array(ChandlerAdminUserSchema), meta: z.record(z.string(), z.unknown()).optional() }).passthrough() } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminSetChandlerUserStatusRoute = createRoute({
  method: "put",
  path: "/api/admin/chandler/users/{id}/status",
  tags: ["Admin · Chandler"],
  summary: "启用或冻结 Chandler 用户",
  description: "删除账号必须走 Chandler 的双人审批流程，本接口只允许 active 与 disabled。",
  request: {
    params: z.object({ id: z.string().min(1).max(100) }),
    body: { content: { "application/json": { schema: z.object({ status: z.enum(["active", "disabled"]) }) } } },
  },
  responses: {
    200: { description: "更新后的用户", content: { "application/json": { schema: ChandlerAdminUserSchema } } },
    400: { description: "状态无效", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminChandlerUserSubscriptionsRoute = createRoute({
  method: "get",
  path: "/api/admin/chandler/users/{id}/subscriptions",
  tags: ["Admin · Chandler"],
  summary: "读取统一用户订阅",
  description: "从 Chandler 古龙版、永生花版应用属性同步订阅有效期，并与官网权威有效期及线下支付审核记录合并；管理员手动设置的官网有效期不会被远程同步覆盖。",
  request: { params: z.object({ id: z.string().min(1).max(100) }) },
  responses: {
    200: { description: "订阅列表", content: { "application/json": { schema: z.object({ subscriptions: z.array(z.record(z.string(), z.unknown())) }).passthrough() } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminChandlerCatalogRoute = createRoute({
  method: "get",
  path: "/api/admin/chandler/catalog",
  tags: ["Admin · Chandler"],
  summary: "读取订阅目录与实时价格",
  responses: {
    200: { description: "当前有效价格", content: { "application/json": { schema: z.object({ plans: z.array(z.record(z.string(), z.unknown())), targetPrices: z.object({ month: z.number(), year: z.number() }) }) } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminPublishChandlerPriceRoute = createRoute({
  method: "post",
  path: "/api/admin/chandler/prices",
  tags: ["Admin · Chandler"],
  summary: "手动修改并立即发布订阅价格",
  description: "通过 Chandler v2.2 应用级价格版本接口在远程服务器创建不可变价格版本；远程成功后再镜像到官网 MongoDB，官网定价页、下单接口与桌面端价格 API 读取同一版本。",
  request: { body: { content: { "application/json": { schema: z.object({ skuId: z.string().min(1).max(100), amountFen: z.number().int().min(SUBSCRIPTION_PRICE_MIN_FEN).max(SUBSCRIPTION_PRICE_MAX_FEN), effectiveAt: z.string().datetime().optional(), expiresAt: z.string().datetime().nullable().optional() }) } } } },
  responses: {
    201: { description: "新价格版本", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "SKU 或生效时间无效", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminCreateChandlerSkuRoute = createRoute({
  method: "post",
  path: "/api/admin/chandler/skus",
  tags: ["Admin · Chandler"],
  summary: "在古龙应用中创建 Chandler SKU",
  description: "对应 Chandler v2.2 POST /v1/me/oauth/clients/{client_id}/skus，仅应用 owner/admin 可执行。",
  request: { body: { content: { "application/json": { schema: z.object({ code: z.string().min(1).max(100), name: z.string().min(1).max(160) }) } } } },
  responses: {
    201: { description: "新 SKU", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "参数无效", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "不是应用 owner/admin", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "SKU 编码重复", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminListChandlerPriceVersionsRoute = createRoute({
  method: "get",
  path: "/api/admin/chandler/skus/{skuId}/prices",
  tags: ["Admin · Chandler"],
  summary: "读取 Chandler SKU 价格版本历史",
  request: { params: z.object({ skuId: z.string().min(1).max(100) }) },
  responses: {
    200: { description: "远程价格版本，按时间倒序", content: { "application/json": { schema: z.object({ prices: z.array(z.record(z.string(), z.unknown())) }) } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "没有应用查看权限", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminSetChandlerSkuStatusRoute = createRoute({
  method: "post",
  path: "/api/admin/chandler/skus/{skuId}/status",
  tags: ["Admin · Chandler"],
  summary: "停售或恢复 Chandler SKU",
  request: {
    params: z.object({ skuId: z.string().min(1).max(100) }),
    body: { content: { "application/json": { schema: z.object({ status: z.enum(["active", "inactive"]) }) } } },
  },
  responses: {
    200: { description: "状态已更新", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "不是应用 owner/admin", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminRequestChandlerEntitlementRoute = createRoute({
  method: "post",
  path: "/api/admin/chandler/entitlement-requests",
  tags: ["Admin · Chandler"],
  summary: "提交订阅权益双人审批",
  description: "申请人不能自行批准；请求进入 Chandler approvals 队列。",
  request: { body: { content: { "application/json": { schema: z.object({ userId: z.string().min(1).max(100), entitlementCode: z.string().min(1).max(120), validUntil: z.string().datetime(), reason: z.string().min(2).max(1024) }) } } } },
  responses: {
    201: { description: "审批请求", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "参数无效", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminAnalyticsDashboardRoute = createRoute({
  method: "get",
  path: "/api/admin/analytics/dashboard",
  tags: ["Admin · Analytics"],
  summary: "古龙平台实时数据看板",
  description: "按 7、30 或 90 天汇总用户增长、活跃、访问、核心功能采用、会员订阅、已确认收入、待支付金额与运营健康度。仅 Chandler 管理员可访问。",
  request: { query: z.object({ days: z.enum(["7", "30", "90"]).optional() }) },
  responses: {
    200: { description: "实时经营分析数据", content: { "application/json": { schema: z.object({ dataMode: z.literal("live"), dataSources: z.array(z.string()), generatedAt: z.coerce.date(), timezone: z.literal("Asia/Shanghai"), days: z.number(), today: z.record(z.string(), z.unknown()), scale: z.record(z.string(), z.unknown()), period: z.record(z.string(), z.unknown()), comparisons: z.record(z.string(), z.unknown()), trend: z.array(z.record(z.string(), z.unknown())), insights: z.array(z.record(z.string(), z.unknown())) }).passthrough() } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/api/health",
  tags: ["System"],
  summary: "服务健康检查",
  responses: {
    200: {
      description: "服务状态",
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["ok", "degraded"]),
            service: z.literal("gulong-platform"),
            database: z.object({ configured: z.boolean(), ok: z.boolean() }),
          }),
        },
      },
    },
  },
});

const registerRoute = createRoute({
  method: "post",
  path: "/api/auth/register",
  tags: ["Authentication"],
  summary: "注册账号",
  request: { body: { content: { "application/json": { schema: RegisterSchema } } } },
  responses: {
    201: { description: "注册成功", content: { "application/json": { schema: AuthResponseSchema } } },
    409: { description: "账号已存在", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const loginRoute = createRoute({
  method: "post",
  path: "/api/auth/login",
  tags: ["Authentication"],
  summary: "用户名或邮箱登录",
  request: { body: { content: { "application/json": { schema: LoginSchema } } } },
  responses: {
    200: { description: "登录成功", content: { "application/json": { schema: AuthResponseSchema } } },
    401: { description: "凭据无效", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const forgotPasswordRoute = createRoute({
  method: "post",
  path: "/api/auth/forgot-password",
  tags: ["Authentication"],
  summary: "发送找回密码邮件",
  description: "通过 Chandler 统一身份服务向邮箱发送一次性验证码或重置令牌。无论邮箱是否存在，成功受理时都返回相同响应，防止账号枚举。",
  request: { body: { content: { "application/json": { schema: ForgotPasswordSchema } } } },
  responses: {
    202: { description: "邮件请求已受理", content: { "application/json": { schema: z.object({ status: z.literal("accepted"), message: z.string() }) } } },
    429: { description: "请求过于频繁", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const resetPasswordRoute = createRoute({
  method: "post",
  path: "/api/auth/reset-password",
  tags: ["Authentication"],
  summary: "使用邮箱验证码重置密码",
  description: "校验邮件中的一次性验证码或重置令牌并设置新密码。成功后吊销该用户在古龙官网与 Chandler 的既有登录会话。",
  request: { body: { content: { "application/json": { schema: ResetPasswordSchema } } } },
  responses: {
    200: { description: "密码已重置", content: { "application/json": { schema: z.object({ status: z.literal("reset"), message: z.string() }) } } },
    400: { description: "验证码无效或过期", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "新密码强度不足", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "尝试过于频繁", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.use("*", requestId());
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: "strict-origin-when-cross-origin",
  }),
);

app.onError((error, c) => {
  console.error(`[${c.get("requestId")}]`, error);
  if (error instanceof ChandlerError) {
    return c.json(
      { code: error.code, message: error.message, requestId: c.get("requestId") },
      error.status,
    );
  }
  if (error instanceof ConfigurationError || error.code === "CONFIG_REQUIRED") {
    return c.json(
      { code: "CONFIG_REQUIRED", message: error.message, requestId: c.get("requestId") },
      503,
    );
  }
  if (error?.name === "MongoServerError" && error.code === 11000) {
    return c.json(
      { code: "ACCOUNT_EXISTS", message: "用户名或邮箱已被注册", requestId: c.get("requestId") },
      409,
    );
  }
  return c.json(
    { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试", requestId: c.get("requestId") },
    500,
  );
});

app.notFound((c) =>
  c.json({ code: "NOT_FOUND", message: "接口不存在", requestId: c.get("requestId") }, 404),
);

app.openapi(healthRoute, async (c) => {
  const database = await pingDatabase();
  return c.json({
    status: database.ok ? "ok" : "degraded",
    service: "gulong-platform",
    database,
  });
});

app.openapi(adminAnalyticsDashboardRoute, async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json(await buildAdminAnalyticsDashboard(Number(c.req.valid("query").days || 30)));
});

app.post("/api/analytics/events", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const body = await c.req.json().catch(() => ({}));
  const eventType = ["PAGE_VIEW", "DOWNLOAD_CLICK", "CHECKOUT_START"].includes(body.eventType) ? body.eventType : null;
  const visitorId = String(body.visitorId || "").trim();
  const sessionId = String(body.sessionId || "").trim();
  const path = String(body.path || "/").trim().slice(0, 256);
  const source = ["DIRECT", "SEARCH", "SOCIAL", "REFERRAL", "CAMPAIGN"].includes(body.source) ? body.source : "DIRECT";
  const deviceType = ["DESKTOP", "MOBILE", "TABLET"].includes(body.deviceType) ? body.deviceType : "DESKTOP";
  if (!eventType || !/^[A-Za-z0-9_-]{8,80}$/.test(visitorId) || !/^[A-Za-z0-9_-]{8,80}$/.test(sessionId) || !path.startsWith("/")) {
    return c.json({ code: "VALIDATION_ERROR", message: "分析事件格式不正确" }, 400);
  }
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const [visitorRate, ipRate] = await Promise.all([
    enforceRateLimit(`analytics:${visitorId}`, { limit: 300, windowMs: 60 * 60_000 }),
    enforceRateLimit(`analytics-ip:${ipKey}`, { limit: 1200, windowMs: 60 * 60_000 }),
  ]);
  if (!visitorRate.allowed || !ipRate.allowed) return c.json({ code: "RATE_LIMITED", message: "分析事件提交过于频繁" }, 429);
  const auth = await authenticate(c, { required: false });
  let referrer = null;
  try { referrer = body.referrer ? new URL(String(body.referrer)).origin.slice(0, 180) : null; } catch { /* Ignore invalid referrers. */ }
  await recordAnalyticsEvent({
    eventType,
    visitorId,
    sessionId,
    path,
    source,
    deviceType,
    referrer,
    utmSource: body.utmSource ? String(body.utmSource).trim().slice(0, 100) : null,
    ownerId: auth?.user?.id ? new ObjectId(auth.user.id) : null,
  });
  return c.json({ accepted: true }, 202);
});

app.openapi(registerRoute, async (c) => {
  if (!isTrustedBrowserRequest(c)) {
    return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  }
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const rate = await enforceRateLimit(`register:${ipKey}`, { limit: 5, windowMs: 10 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "注册尝试过多，请稍后重试" }, 429);

  const input = c.req.valid("json");
  const auth = await registerWithChandler({
    email: input.email,
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    inviteCode: input.inviteCode,
  });
  await markChandlerProductEdition(auth.access_token, auth.user.id, "gulong", "website-registration").catch(() => null);
  const identity = { role: auth.user.is_admin || isChandlerBootstrapAdmin(auth.user) ? "admin" : "user", editionKey: "gulong", editionName: "古龙版", editionSource: "website-registration" };
  const user = await upsertChandlerUser(auth.user, { username: input.username, identity, defaultEdition: "gulong", forceEdition: true });
  await issueSession(c, user._id, { externalAuth: externalAuthFromResponse(auth) });
  return c.json(
    {
      user: {
        id: user._id.toString(),
        username: user.username || null,
        email: user.email || null,
        displayName: user.displayName || null,
        avatar: user.avatar || null,
        authProvider: "chandler",
        role: user.role,
        edition: { key: user.editionKey, name: user.editionName, source: user.editionSource },
        createdAt: user.createdAt,
      },
    },
    201,
  );
});

app.openapi(loginRoute, async (c) => {
  if (!isTrustedBrowserRequest(c)) {
    return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  }
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const rate = await enforceRateLimit(`login:${ipKey}`, { limit: 10, windowMs: 10 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "登录尝试过多，请稍后重试" }, 429);

  const input = c.req.valid("json");
  const loginEmail = await resolveWebsiteLoginEmail(input.identifier);
  const chandlerAuth = await loginWithChandler(loginEmail, input.password);
  const identity = await resolveChandlerIdentity(chandlerAuth.user, chandlerAuth.access_token);
  const user = await upsertChandlerUser(chandlerAuth.user, {
    username: input.identifier.includes("@") ? undefined : input.identifier,
    identity,
    defaultEdition: "gulong",
  });
  await issueSession(c, user._id, { externalAuth: externalAuthFromResponse(chandlerAuth) });
  return c.json({
    user: {
      id: user._id.toString(),
      username: user.username || null,
      email: user.email || null,
      displayName: user.displayName || null,
      avatar: user.avatar || null,
      authProvider: "chandler",
      role: user.role,
      edition: { key: user.editionKey, name: user.editionName, source: user.editionSource },
      createdAt: user.createdAt,
    },
  });
});

app.openapi(forgotPasswordRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const input = c.req.valid("json");
  const email = normalizeEmail(input.email);
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const emailKey = hashOpaqueToken(email, "password-reset-email").slice(0, 24);
  const [ipRate, emailRate] = await Promise.all([
    enforceRateLimit(`password-forgot-ip:${ipKey}`, { limit: 8, windowMs: 30 * 60_000 }),
    enforceRateLimit(`password-forgot-email:${emailKey}`, { limit: 3, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !emailRate.allowed) {
    return c.json({ code: "RATE_LIMITED", message: "验证码发送过于频繁，请稍后再试" }, 429);
  }
  await forgotPasswordWithChandler(email);
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({ status: "accepted", message: "如果该邮箱已注册，验证码邮件会在几分钟内送达" }, 202);
});

app.openapi(resetPasswordRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const input = c.req.valid("json");
  const email = normalizeEmail(input.email);
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const codeKey = hashOpaqueToken(input.code, "password-reset-code").slice(0, 24);
  const [ipRate, codeRate] = await Promise.all([
    enforceRateLimit(`password-reset-ip:${ipKey}`, { limit: 12, windowMs: 30 * 60_000 }),
    enforceRateLimit(`password-reset-code:${codeKey}`, { limit: 5, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !codeRate.allowed) {
    return c.json({ code: "RATE_LIMITED", message: "验证码校验尝试过多，请重新获取验证码" }, 429);
  }

  await resetPasswordWithChandler(input.code, input.newPassword);
  const users = await getCollection("users");
  const user = await users.findOne({ emailNormalized: email }, { projection: { _id: 1 } });
  if (user) {
    await Promise.all([
      (await getCollection("sessions")).deleteMany({ userId: user._id }),
      users.updateOne({ _id: user._id }, { $set: { passwordResetAt: new Date(), updatedAt: new Date() } }),
    ]);
  }
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({ status: "reset", message: "密码已重置，请使用新密码重新登录" });
});

app.get("/api/auth/me", async (c) => {
  const auth = await authenticate(c, { required: false });
  return c.json({
    user: auth?.user || null,
    databaseConfigured: isDatabaseConfigured(),
    identityProvider: "chandler",
  });
});

app.get("/api/account/dashboard", async (c) => {
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const ownerId = new ObjectId(auth.user.id);
  let chandlerAccessToken = null;
  if (auth.kind === "session" && auth.user.authProvider === "chandler") {
    try {
      chandlerAccessToken = await getChandlerAccessToken(auth.session);
      const profile = await chandlerRequest("/v1/me", { accessToken: chandlerAccessToken, timeoutMs: 5_000 });
      const identity = await resolveChandlerIdentity(profile, chandlerAccessToken);
      const synchronizedUser = await upsertChandlerUser(profile, { identity, defaultEdition: "gulong" });
      auth.user.role = synchronizedUser.role;
      auth.user.edition = {
        key: synchronizedUser.editionKey || "gulong",
        name: synchronizedUser.editionName || "古龙版",
        source: synchronizedUser.editionSource || "default",
      };
    } catch {
      // Keep the dashboard available during a transient Chandler outage. The
      // desktop bootstrap administrator still receives the same fail-safe role
      // used by the desktop client.
      if (auth.user.role !== "admin" && isChandlerBootstrapAdmin(auth.user)) {
        await (await getCollection("users")).updateOne({ _id: ownerId }, { $set: { role: "admin", updatedAt: new Date() } });
        auth.user.role = "admin";
      }
    }
  }
  const chandlerSubscriptionsPromise = chandlerAccessToken
    ? chandlerRequest("/v1/me/subscriptions", { accessToken: chandlerAccessToken, timeoutMs: 5_000 }).catch(() => null)
    : Promise.resolve(null);
  const [user, subscription, wallet, uploads, feedback, payments, offlineOrders, minimax, notifications, chandlerSubscriptions] = await Promise.all([
    (await getCollection("users")).findOne({ _id: ownerId }),
    (await getCollection("subscriptions")).findOne({ ownerId }),
    (await getCollection("wallets")).findOne({ ownerId }),
    (await getCollection("uploads")).find({ ownerId, kind: "brain" }).sort({ createdAt: -1 }).limit(50).toArray(),
    (await getCollection("feedback")).find({ ownerId }).sort({ createdAt: -1 }).limit(20).toArray(),
    (await getCollection("payments")).find({ ownerId }).sort({ createdAt: -1 }).limit(20).toArray(),
    (await getCollection("offlinePayments")).find({ ownerId }).sort({ createdAt: -1 }).limit(20).toArray(),
    (await getCollection("userConfigurations")).findOne({ ownerId, provider: "minimax" }),
    (await getCollection("notifications")).find({ ownerId }).sort({ createdAt: -1 }).limit(20).toArray(),
    chandlerSubscriptionsPromise,
  ]);
  const remoteSubscription = (chandlerSubscriptions?.subscriptions || []).find((item) => item.status === "active") || null;
  const localSubscriptionStatus = subscription
    ? subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd)
    : "inactive";
  const localSubscription = subscription ? { ...subscription, status: localSubscriptionStatus } : null;
  if (subscription && subscription.status !== localSubscriptionStatus) {
    await (await getCollection("subscriptions")).updateOne(
      { _id: subscription._id },
      { $set: { status: localSubscriptionStatus, statusEvaluatedAt: new Date(), updatedAt: new Date() } },
    );
  }
  const remoteSubscriptionView = remoteSubscription ? {
    plan: remoteSubscription.sku_name || remoteSubscription.product_name || "member",
    cycle: remoteSubscription.billing_interval || remoteSubscription.cycle || null,
    provider: remoteSubscription.channel || "chandler",
    status: remoteSubscription.status,
    currentPeriodStart: remoteSubscription.current_period_start || null,
    currentPeriodEnd: remoteSubscription.current_period_end || null,
    autoRenew: remoteSubscription.cancel_at_period_end !== true,
    cancelAtPeriodEnd: Boolean(remoteSubscription.cancel_at_period_end),
  } : null;
  const effectiveSubscription = subscription?.manualPeriodOverride
    ? localSubscription
    : localSubscriptionStatus === "active"
      ? localSubscription
      : remoteSubscriptionView || localSubscription;
  return c.json({
    profile: {
      id: auth.user.id,
      username: user?.username || null,
      email: user?.email || null,
      displayName: user?.displayName || null,
      avatar: user?.avatar || null,
      bio: user?.bio || "",
      wechatId: user?.wechatId || "",
      role: user?.role || auth.user.role,
      edition: {
        key: user?.editionKey || auth.user.edition?.key || "gulong",
        name: user?.editionName || auth.user.edition?.name || "古龙版",
        source: user?.editionSource || auth.user.edition?.source || "default",
      },
      createdAt: user?.createdAt,
    },
    subscription: effectiveSubscription ? {
      plan: effectiveSubscription.plan,
      cycle: effectiveSubscription.cycle,
      provider: effectiveSubscription.provider,
      status: effectiveSubscription.status,
      currentPeriodStart: effectiveSubscription.currentPeriodStart,
      currentPeriodEnd: effectiveSubscription.currentPeriodEnd,
      autoRenew: Boolean(effectiveSubscription.autoRenew),
      cancelAtPeriodEnd: Boolean(effectiveSubscription.cancelAtPeriodEnd),
    } : null,
    balanceFen: wallet?.balanceFen || 0,
    brainUploads: uploads.map((item) => ({
      id: item._id.toString(),
      originalName: item.originalName || item.pathname?.split("/").pop() || "第二大脑.zip",
      size: item.size || 0,
      status: item.status,
      progress: brainProgress(item),
      result: item.result || null,
      feedback: item.feedback || null,
      createdAt: item.createdAt,
      completedAt: item.completedAt || null,
      updatedAt: item.updatedAt || item.createdAt,
    })),
    feedback: feedback.map((item) => ({
      id: item._id.toString(),
      message: item.message,
      status: item.status,
      response: item.response || item.adminResponse || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt || item.createdAt,
    })),
    orders: [
      ...payments.map((item) => ({ id: item._id.toString(), orderNo: item.orderNo, kind: item.kind, cycle: item.cycle, provider: item.provider, amountFen: item.amountFen, status: item.status, createdAt: item.createdAt })),
      ...offlineOrders.map((item) => ({
        id: item._id.toString(),
        orderNo: item.orderNo,
        kind: "subscription",
        cycle: item.cycle,
        provider: "offline",
        amountFen: item.amountFen,
        status: item.status,
        reviewReason: item.reviewReason || null,
        previousReviewReason: item.previousReviewReason || null,
        resubmissionNote: item.resubmissionNote || null,
        resubmittedAt: item.resubmittedAt || null,
        createdAt: item.createdAt,
      })),
    ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).slice(0, 30),
    notifications: notifications.map((item) => ({
      id: item._id.toString(),
      type: item.type,
      title: item.title,
      message: item.message,
      reason: item.reason || null,
      orderId: item.orderId?.toString() || null,
      orderNo: item.orderNo || null,
      readAt: item.readAt || null,
      createdAt: item.createdAt,
    })),
    minimax: minimax ? {
      configured: true,
      maskedKey: `••••••••${minimax.keyLast4 || ""}`,
      apiHost: MINIMAX_API_HOST,
      model: MINIMAX_DEFAULT_MODEL,
      updatedAt: minimax.updatedAt,
    } : { configured: false, maskedKey: null, apiHost: MINIMAX_API_HOST, model: MINIMAX_DEFAULT_MODEL },
  });
});

app.put("/api/account/profile", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const displayName = String(body.displayName || "").trim();
  const username = String(body.username || "").trim();
  const bio = String(body.bio || "").trim();
  const wechatId = String(body.wechatId || "").trim();
  if (displayName.length < 1 || displayName.length > 64 || bio.length > 240 || (username && (username.length < 3 || username.length > 32 || !/^[\p{L}\p{N}_-]+$/u.test(username))) || (wechatId && (wechatId.length < 5 || wechatId.length > 64 || !/^[A-Za-z0-9_+.-]+$/.test(wechatId)))) {
    return c.json({ code: "VALIDATION_ERROR", message: "昵称、用户名、微信号或个人简介格式不正确" }, 400);
  }
  const update = { displayName, displayNameUserManaged: true, bio, wechatId, updatedAt: new Date() };
  if (username) {
    update.username = username;
    update.usernameNormalized = normalizeUsername(username);
  }
  const user = await (await getCollection("users")).findOneAndUpdate(
    { _id: new ObjectId(auth.user.id) },
    { $set: update },
    { returnDocument: "after" },
  );
  return c.json({ user: { id: user._id.toString(), username: user.username || null, email: user.email || null, displayName: user.displayName || null, avatar: user.avatar || null, bio: user.bio || "", wechatId: user.wechatId || "", role: user.role || "user" } });
});

app.get("/api/account/worker-profile", async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const user = await (await getCollection("users")).findOne({ _id: new ObjectId(auth.user.id) }, { projection: { wechatId: 1 } });
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ wechatId: user?.wechatId || "", ready: Boolean(user?.wechatId) });
});

app.put("/api/account/wechat", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const wechatId = String(body.wechatId || "").trim();
  if (wechatId.length < 5 || wechatId.length > 64 || !/^[A-Za-z0-9_+.-]+$/.test(wechatId)) return c.json({ code: "VALIDATION_ERROR", message: "请输入 5–64 位正确微信号" }, 400);
  await (await getCollection("users")).updateOne({ _id: new ObjectId(auth.user.id) }, { $set: { wechatId, updatedAt: new Date() } });
  return c.json({ ok: true, wechatId, ready: true });
});

app.get("/api/users/:id/avatar", async (c) => {
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "AVATAR_NOT_FOUND", message: "头像不存在" }, 404);
  const user = await (await getCollection("users")).findOne(
    { _id: new ObjectId(c.req.param("id")), avatarObjectKey: { $exists: true, $ne: null } },
    { projection: { avatarObjectKey: 1 } },
  );
  if (!user?.avatarObjectKey) return c.json({ code: "AVATAR_NOT_FOUND", message: "头像不存在" }, 404);
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.redirect(createPresignedDownloadUrl(user.avatarObjectKey, { expires: 10 * 60 }), 302);
});

app.post("/api/account/avatar/presign", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const filename = sanitizeFilename(body.filename, "avatar.webp");
  const contentType = String(body.contentType || "").trim().toLowerCase();
  const bytes = Number(body.bytes || 0);
  if (!AVATAR_CONTENT_TYPES.has(contentType) || !Number.isInteger(bytes) || bytes < 1 || bytes > AVATAR_MAX_BYTES) {
    return c.json({ code: "VALIDATION_ERROR", message: "头像仅支持 JPG、PNG、WebP 或 GIF，且不能超过 10MB" }, 400);
  }
  const uploadId = new ObjectId();
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase().slice(0, 8) : ".img";
  const objectKey = `users/${auth.user.id}/avatar/${uploadId.toString()}${extension}`;
  const now = new Date();
  await (await getCollection("avatarUploads")).insertOne({
    _id: uploadId,
    ownerId: new ObjectId(auth.user.id),
    objectKey,
    filename,
    contentType,
    bytes,
    status: "uploading",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60_000),
  });
  return c.json({
    uploadId: uploadId.toString(),
    uploadUrl: createPresignedPutUrl(objectKey, { expires: 60 * 60, headers: { "Content-Type": contentType } }),
    objectKey,
    expiresIn: 3600,
    requiredHeaders: { "Content-Type": contentType },
  }, 201);
});

app.post("/api/account/avatar/:uploadId/complete", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("uploadId"))) return c.json({ code: "UPLOAD_NOT_FOUND", message: "头像上传记录不存在" }, 404);
  const ownerId = new ObjectId(auth.user.id);
  const uploads = await getCollection("avatarUploads");
  const upload = await uploads.findOne({ _id: new ObjectId(c.req.param("uploadId")), ownerId, status: "uploading", expiresAt: { $gt: new Date() } });
  if (!upload) return c.json({ code: "UPLOAD_NOT_FOUND", message: "头像上传记录不存在或已失效" }, 404);
  const head = await headObject(upload.objectKey);
  const actualBytes = objectSize(head);
  const actualType = String(head?.headers?.["content-type"] || head?.ContentType || "").split(";")[0].trim().toLowerCase();
  if (actualBytes !== upload.bytes || (actualType && actualType !== upload.contentType)) {
    await deleteObject(upload.objectKey).catch(() => {});
    await uploads.updateOne({ _id: upload._id }, { $set: { status: "failed", error: "COS_OBJECT_MISMATCH", updatedAt: new Date() } });
    return c.json({ code: "UPLOAD_MISMATCH", message: "头像文件校验失败，请重新上传" }, 409);
  }
  const users = await getCollection("users");
  const previous = await users.findOne({ _id: ownerId }, { projection: { avatarObjectKey: 1 } });
  const now = new Date();
  const avatar = `/api/users/${auth.user.id}/avatar?v=${now.getTime()}`;
  await Promise.all([
    users.updateOne({ _id: ownerId }, { $set: { avatar, avatarObjectKey: upload.objectKey, avatarUserManaged: true, avatarUpdatedAt: now, updatedAt: now } }),
    uploads.updateOne({ _id: upload._id, status: "uploading" }, { $set: { status: "completed", completedAt: now, updatedAt: now } }),
  ]);
  if (previous?.avatarObjectKey && previous.avatarObjectKey !== upload.objectKey) await deleteObject(previous.avatarObjectKey).catch(() => {});
  return c.json({ ok: true, avatar, updatedAt: now });
});

app.post("/api/account/notifications/:id/read", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOTIFICATION_NOT_FOUND", message: "消息不存在" }, 404);
  const result = await (await getCollection("notifications")).updateOne(
    { _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id) },
    { $set: { readAt: new Date() } },
  );
  if (!result.matchedCount) return c.json({ code: "NOTIFICATION_NOT_FOUND", message: "消息不存在" }, 404);
  return c.json({ ok: true });
});

app.get("/api/account/notifications", async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const ownerId = new ObjectId(auth.user.id);
  const notifications = await getCollection("notifications");
  const [items, unread] = await Promise.all([
    notifications.find({ ownerId }).sort({ createdAt: -1 }).limit(8).toArray(),
    notifications.countDocuments({ ownerId, readAt: null }),
  ]);
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({
    unread,
    notifications: items.map((item) => ({
      id: item._id.toString(),
      type: item.type,
      title: item.title,
      message: item.message,
      reason: item.reason || null,
      taskId: item.taskId?.toString?.() || null,
      readAt: item.readAt || null,
      createdAt: item.createdAt,
    })),
  });
});

app.put("/api/account/integrations/minimax", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const ownerId = new ObjectId(auth.user.id);
  const configurations = await getCollection("userConfigurations");
  const existing = await configurations.findOne({ ownerId, provider: "minimax" });
  const apiKey = String(body.apiKey || "").trim();
  if ((!existing?.apiKeyEncrypted && apiKey.length < 8) || apiKey.length > 500) {
    return c.json({ code: "VALIDATION_ERROR", message: "MiniMax API Key 格式不正确" }, 400);
  }
  const now = new Date();
  const values = {
    apiHost: MINIMAX_API_HOST,
    model: MINIMAX_DEFAULT_MODEL,
    updatedAt: now,
    ...(apiKey ? { apiKeyEncrypted: sealUserSecret(apiKey, "minimax-api-key"), keyLast4: apiKey.slice(-4) } : {}),
  };
  await configurations.updateOne(
    { ownerId, provider: "minimax" },
    { $set: values, $setOnInsert: { ownerId, provider: "minimax", createdAt: now } },
    { upsert: true },
  );
  return c.json({ configured: true, maskedKey: `••••••••${apiKey ? apiKey.slice(-4) : existing.keyLast4 || ""}`, apiHost: values.apiHost, model: MINIMAX_DEFAULT_MODEL, updatedAt: now });
});

app.delete("/api/account/integrations/minimax", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  await (await getCollection("userConfigurations")).deleteOne({ ownerId: new ObjectId(auth.user.id), provider: "minimax" });
  return c.json({ ok: true });
});

app.openapi(issueOfflineCredentialRoute, async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const installId = body.installId ? String(body.installId).trim().slice(0, 160) : undefined;
  const accessToken = await getChandlerAccessToken(auth.session);
  const credential = await issueOfflineCredential(accessToken, installId);
  return c.json({ ...credential, verificationJwks: `${chandlerConfig().baseUrl}/.well-known/jwks.json` }, 201);
});

app.post("/api/auth/logout", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c, { required: false });
  const external = readExternalAuth(auth?.session);
  if (external?.provider === "chandler" && external.refreshToken) {
    try { await logoutFromChandler(external.refreshToken); } catch { /* Local logout must still succeed. */ }
  }
  await revokeSession(c);
  return c.json({ ok: true });
});

app.delete("/api/auth/account", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json();
  const ownerId = new ObjectId(auth.user.id);
  const user = await (await getCollection("users")).findOne({ _id: ownerId });
  if (!user) return c.json({ code: "USER_NOT_FOUND", message: "账户不存在" }, 404);
  if (user.authProvider === "chandler") {
    const accessToken = await getChandlerAccessToken(auth.session);
    await chandlerRequest("/v1/me/deletion-requests", {
      method: "POST",
      accessToken,
      body: { reason: String(body.reason || "用户从古龙官网发起账户注销") },
    });
  } else if (!(await verifyPassword(String(body.password || ""), user.passwordHash))) {
    return c.json({ code: "INVALID_CREDENTIALS", message: "密码不正确，账户未删除" }, 401);
  }
  await revokeSession(c);
  if (user.avatarObjectKey) await deleteObject(user.avatarObjectKey).catch(() => {});
  const offlineOrderIds = await (await getCollection("offlinePayments"))
    .find({ ownerId })
    .project({ _id: 1 })
    .toArray();
  await Promise.all([
    (await getCollection("sessions")).deleteMany({ userId: ownerId }),
    (await getCollection("offlinePaymentReviewEvents")).deleteMany({ orderId: { $in: offlineOrderIds.map((order) => order._id) } }),
    ...["apiKeys", "tasks", "memories", "feedback", "payments", "subscriptions", "wallets", "uploads", "offlinePayments", "userConfigurations", "notifications", "avatarUploads", "offlinePaymentReviewWorkers", "workerTasks", "workerTaskUploads", "workerEarnings", "workerWorkflows", "workerWorkflowRevenueLedger", "workerContactPayments"]
      .map((name) => getCollection(name).then((collection) => collection.deleteMany({ ownerId }))),
  ]);
  await (await getCollection("users")).deleteOne({ _id: ownerId });
  return c.json({ ok: true });
});

app.get("/api/developer/keys", async (c) => {
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const keys = await (await getCollection("apiKeys"))
    .find({ ownerId: new ObjectId(auth.user.id), revokedAt: null })
    .sort({ createdAt: -1 })
    .project({ keyHash: 0, ownerId: 0 })
    .toArray();
  return c.json({
    keys: keys.map((key) => ({ ...key, id: key._id.toString(), _id: undefined })),
  });
});

app.post("/api/developer/keys", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const scopes = Array.isArray(body.scopes) ? body.scopes : ["tasks:read", "tasks:write"];
  const allowedScopes = new Set(["tasks:read", "tasks:write", "brain:read", "brain:write", "brain:attachments:read", "workflows:read", "configuration:read", "profile:read"]);
  if (name.length < 2 || name.length > 40 || scopes.some((scope) => !allowedScopes.has(scope)) || (scopes.includes("brain:attachments:read") && auth.user.role !== "admin")) {
    return c.json({ code: "VALIDATION_ERROR", message: "API Key 名称或权限不正确" }, 400);
  }
  const existing = await (await getCollection("apiKeys")).countDocuments({
    ownerId: new ObjectId(auth.user.id),
    revokedAt: null,
  });
  if (existing >= 10) return c.json({ code: "KEY_LIMIT", message: "每个账号最多保留 10 个 API Key" }, 409);
  return c.json({ apiKey: await createApiKey(auth.user.id, { name, scopes }) }, 201);
});

app.delete("/api/developer/keys/:id", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "VALIDATION_ERROR", message: "Key ID 无效" }, 400);
  await (await getCollection("apiKeys")).updateOne(
    { _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id) },
    { $set: { revokedAt: new Date() } },
  );
  return c.json({ ok: true });
});

app.openapi(adminListChandlerUsersRoute, async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  c.header("Cache-Control", "private, no-store, max-age=0");
  const query = c.req.valid("query");
  if (query.channelId && query.channelId !== "unassigned" && !ObjectId.isValid(query.channelId)) return c.json({ code: "VALIDATION_ERROR", message: "发行渠道筛选值无效" }, 400);
  try {
    const accessToken = await getChandlerAccessToken(auth.session);
    const synchronized = await synchronizeChandlerApplicationUsers(accessToken);
    const directory = await websiteAdminUserDirectory(query);
    return c.json({
      users: directory.users,
      meta: {
        total: directory.total,
        page: directory.page,
        limit: directory.limit,
        pages: directory.pages,
        source: "chandler-applications+website",
        permissionLimited: false,
        synchronized: true,
        remoteTotal: synchronized.remoteTotal,
        synchronizedCount: synchronized.synchronizedCount,
        applicationCount: synchronized.applicationCount,
        partial: synchronized.partial,
        synchronizedAt: synchronized.synchronizedAt,
        capabilities: subscriptionDirectoryCapabilities({ synchronized: true }),
      },
    });
  } catch (error) {
    const directory = await websiteAdminUserDirectory(query);
    return c.json({
      users: directory.users,
      meta: {
        total: directory.total,
        page: directory.page,
        limit: directory.limit,
        pages: directory.pages,
        source: "website-snapshot",
        permissionLimited: true,
        synchronized: false,
        warning: error.message,
        capabilities: subscriptionDirectoryCapabilities(),
      },
    });
  }
});

app.openapi(adminSetWebsiteRoleRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const body = await c.req.json().catch(() => ({}));
  if (body.role !== "admin") return c.json({ code: "VALIDATION_ERROR", message: "当前仅支持将普通用户提升为管理员" }, 400);
  const targetId = String(c.req.param("id") || "").trim();
  const filters = [{ chandlerUserId: targetId }];
  if (ObjectId.isValid(targetId)) filters.unshift({ _id: new ObjectId(targetId) });
  const users = await getCollection("users");
  let target = await users.findOne({ $or: filters });
  if (!target) {
    try {
      const accessToken = await getChandlerAccessToken(auth.session);
      const remote = await chandlerRequest(`/v1/admin/users/${encodeURIComponent(targetId)}`, { accessToken });
      target = await upsertChandlerUser(remote, { identity: { role: "admin", editionKey: "gulong", editionName: "古龙版", editionSource: "admin-promotion" } });
    } catch {
      return c.json({ code: "USER_NOT_FOUND", message: "该用户尚未登录过古龙官网，暂时无法设置官网管理员角色" }, 404);
    }
  }
  const now = new Date();
  await users.updateOne(
    { _id: target._id },
    { $set: { role: "admin", roleOverride: "admin", roleUpdatedAt: now, roleUpdatedBy: new ObjectId(auth.user.id), updatedAt: now } },
  );
  await notifyUser(target._id, "administrator_role_granted", "你已成为古龙管理员", "管理员权限已经生效，可从网站右上角进入管理员后台。", { actorId: new ObjectId(auth.user.id) });
  return c.json({ ok: true, userId: target._id.toString(), role: "admin", message: "用户已提升为管理员，下次登录仍会保留该角色。" });
});

app.openapi(adminUpdateSubscriptionPeriodRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const targetId = String(c.req.valid("param").id || "").trim();
  const body = c.req.valid("json");
  const currentPeriodStart = new Date(body.currentPeriodStart);
  const currentPeriodEnd = new Date(body.currentPeriodEnd);
  const maximumPeriodMs = 10 * 366 * 86_400_000;
  if (
    Number.isNaN(currentPeriodStart.getTime())
    || Number.isNaN(currentPeriodEnd.getTime())
    || currentPeriodEnd <= currentPeriodStart
    || currentPeriodEnd.getTime() - currentPeriodStart.getTime() > maximumPeriodMs
  ) {
    return c.json({ code: "INVALID_SUBSCRIPTION_PERIOD", message: "到期时间必须晚于生效时间，且单次设置最长不超过 10 年" }, 400);
  }

  const filters = [{ chandlerUserId: targetId }];
  if (ObjectId.isValid(targetId)) filters.unshift({ _id: new ObjectId(targetId) });
  const users = await getCollection("users");
  const target = await users.findOne({ $or: filters });
  if (!target) return c.json({ code: "USER_NOT_FOUND", message: "该用户尚未登录过古龙官网，暂时无法设置会员有效期" }, 404);

  const now = new Date();
  const status = subscriptionPeriodState(currentPeriodStart, currentPeriodEnd, now);
  const subscriptions = await getCollection("subscriptions");
  const previous = await subscriptions.findOne({ ownerId: target._id });
  await subscriptions.updateOne(
    { ownerId: target._id },
    {
      $set: {
        plan: previous?.plan || "member",
        cycle: previous?.cycle || "custom",
        provider: previous?.provider || "admin",
        status,
        currentPeriodStart,
        currentPeriodEnd,
        autoRenew: Boolean(previous?.autoRenew),
        manualPeriodOverride: true,
        periodSource: "admin",
        periodUpdatedAt: now,
        periodUpdatedBy: new ObjectId(auth.user.id),
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  await (await getCollection("subscriptionPeriodAudits")).insertOne({
    ownerId: target._id,
    targetChandlerUserId: target.chandlerUserId || null,
    previous: previous ? {
      status: previous.status || null,
      currentPeriodStart: previous.currentPeriodStart || null,
      currentPeriodEnd: previous.currentPeriodEnd || null,
      manualPeriodOverride: Boolean(previous.manualPeriodOverride),
    } : null,
    next: { status, currentPeriodStart, currentPeriodEnd, manualPeriodOverride: true },
    actorId: new ObjectId(auth.user.id),
    createdAt: now,
  });

  const displayStart = currentPeriodStart.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const displayEnd = currentPeriodEnd.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  await notifyUser(
    target._id,
    "subscription_period_updated",
    "会员有效期已调整",
    `管理员已将你的会员有效期调整为 ${displayStart} 至 ${displayEnd}。`,
    { currentPeriodStart, currentPeriodEnd, status, actorId: new ObjectId(auth.user.id) },
  );

  let chandlerSynced = false;
  if (target.chandlerUserId) {
    try {
      const accessToken = await getChandlerAccessToken(auth.session);
      const path = `/v1/me/oauth/clients/${encodeURIComponent(chandlerConfig().applicationId)}/users/${encodeURIComponent(target.chandlerUserId)}/attributes`;
      const current = await chandlerRequest(path, { accessToken });
      const attributes = current.attributes && typeof current.attributes === "object" ? current.attributes : {};
      await chandlerRequest(path, {
        method: "PUT",
        accessToken,
        body: { attributes: {
          ...attributes,
          subscription_status: status,
          subscription_source: "website_admin_period",
          subscription_valid_from: currentPeriodStart.toISOString(),
          subscription_valid_until: currentPeriodEnd.toISOString(),
          subscription_valid_from_unix_ms: currentPeriodStart.getTime(),
          subscription_valid_until_unix_ms: currentPeriodEnd.getTime(),
          subscription_period_updated_at_unix_ms: now.getTime(),
        } },
      });
      chandlerSynced = true;
    } catch {
      // MongoDB remains authoritative; Chandler attributes can be synchronized later.
    }
  }

  return c.json({
    ok: true,
    userId: target._id.toString(),
    status,
    currentPeriodStart: currentPeriodStart.toISOString(),
    currentPeriodEnd: currentPeriodEnd.toISOString(),
    chandlerSynced,
    message: `会员有效期已保存，当前状态：${status === "active" ? "生效中" : status === "scheduled" ? "尚未生效" : "已到期"}。`,
  });
});

app.openapi(adminSetChandlerUserStatusRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const accessToken = await getChandlerAccessToken(auth.session);
  const user = await chandlerRequest(`/v1/admin/users/${encodeURIComponent(c.req.valid("param").id)}/status`, {
    method: "PUT",
    accessToken,
    body: c.req.valid("json"),
  });
  return c.json(user);
});

app.openapi(adminChandlerUserSubscriptionsRoute, async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  c.header("Cache-Control", "private, no-store, max-age=0");
  const userId = c.req.valid("param").id;
  const idFilter = ObjectId.isValid(userId) ? [{ _id: new ObjectId(userId) }, { chandlerUserId: userId }] : [{ chandlerUserId: userId }];
  const user = await (await getCollection("users")).findOne({ $or: idFilter });
  let remoteApplicationCount = 0;
  let remoteWarning = null;
  let partial = false;

  if (user?.chandlerUserId) {
    try {
      const accessToken = await getChandlerAccessToken(auth.session);
      const authorizedIds = Array.isArray(user.chandlerAuthorizedApplications) ? new Set(user.chandlerAuthorizedApplications) : null;
      const targets = chandlerApplicationTargets().filter((target) => !authorizedIds?.size || authorizedIds.has(target.id));
      const results = await Promise.allSettled(targets.map(async (target) => {
        const payload = await getPartnerClientUserAttributes(accessToken, user.chandlerUserId, target.id);
        const attributes = payload?.attributes && typeof payload.attributes === "object" ? payload.attributes : payload;
        return { target, attributes: attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes : {} };
      }));
      const successful = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const actionableFailures = results.filter((result) => result.status === "rejected" && result.reason?.status !== 404);
      remoteApplicationCount = successful.length;
      partial = successful.length > 0 && actionableFailures.length > 0;
      remoteWarning = actionableFailures[0]?.reason?.message || null;
      const subscriptionAttributes = successful
        .filter((item) => chandlerAttributePeriod(item.attributes))
        .sort((left, right) => Number(right.attributes.subscription_period_updated_at_unix_ms || right.attributes.subscription_reviewed_at_unix_ms || 0) - Number(left.attributes.subscription_period_updated_at_unix_ms || left.attributes.subscription_reviewed_at_unix_ms || 0))[0];
      if (subscriptionAttributes) await synchronizeChandlerAttributeSubscription(user._id, subscriptionAttributes.attributes, subscriptionAttributes.target.id);
    } catch (error) {
      remoteWarning = error.message;
    }
  }

  const [localSubscription, offlineOrders] = user ? await Promise.all([
    (await getCollection("subscriptions")).findOne({ ownerId: user._id }),
    (await getCollection("offlinePayments")).find({ ownerId: user._id }).sort({ createdAt: -1 }).limit(10).toArray(),
  ]) : [null, []];
  const local = [];
  const localSubscriptionItem = adminSubscriptionJson(localSubscription);
  if (localSubscriptionItem) local.push(localSubscriptionItem);
  for (const order of offlineOrders) local.push({
    id: order._id.toString(),
    status: order.status === "pending" ? "pending_review" : order.status,
    sku_name: order.cycle === "year" ? "线下年度会员" : "线下月度会员",
    valid_from: order.validFrom || null,
    valid_until: order.validUntil || null,
    provider: "offline",
    order_no: order.orderNo,
    source: "website",
  });
  const synchronized = remoteApplicationCount > 0;
  return c.json({
    subscriptions: local,
    meta: {
      source: synchronized ? "chandler-applications+website" : "website",
      permissionLimited: Boolean(user?.chandlerUserId && remoteWarning && !synchronized),
      synchronized,
      partial,
      remoteApplicationCount,
      websitePeriodOverride: Boolean(localSubscription?.manualPeriodOverride),
      ...(remoteWarning ? { warning: remoteWarning } : {}),
      capabilities: subscriptionDirectoryCapabilities({ synchronized }),
    },
  });
});

app.openapi(adminChandlerCatalogRoute, async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const accessToken = await getChandlerAccessToken(auth.session);
  const plans = await listPartnerSubscriptionPlans(accessToken);
  await synchronizeActiveChandlerPrices(plans, auth.user.id);
  const now = new Date();
  const pricing = await currentSubscriptionPricing(now);
  const skuIds = plans.map((plan) => plan.skuId).filter(Boolean);
  const localVersions = skuIds.length
    ? await (await getCollection("pricingVersions")).find({ skuId: { $in: skuIds }, status: { $ne: "superseded" } }).sort({ effectiveAt: -1, createdAt: -1 }).toArray()
    : [];
  const mergedPlans = plans.map((plan) => {
    const versions = localVersions.filter((item) => item.skuId === plan.skuId);
    const effective = versions.find((item) => new Date(item.effectiveAt) <= now);
    const scheduled = versions.filter((item) => new Date(item.effectiveAt) > now).sort((left, right) => new Date(left.effectiveAt) - new Date(right.effectiveAt))[0];
    return {
      ...plan,
      catalogAmountFen: plan.amountFen,
      amountFen: plan.amountFen,
      priceSource: "chandler-remote",
      remotePriceId: plan.priceId || null,
      remotePriceEffectiveAt: plan.priceEffectiveAt || null,
      localVersionId: effective?._id?.toString() || null,
      scheduledPriceFen: scheduled?.amountFen ?? null,
      scheduledEffectiveAt: scheduled?.effectiveAt || null,
    };
  });
  return c.json({ plans: mergedPlans, targetPrices: { month: pricing.monthly.amountFen, year: pricing.yearly.amountFen }, pricingRevision: pricing.revision, desktopSyncEndpoint: "/api/v1/pricing/subscriptions", pricingAuthority: "chandler-partner-sku-v2.2", applicationId: chandlerConfig().applicationId });
});

app.openapi(adminPublishChandlerPriceRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const input = c.req.valid("json");
  const accessToken = await getChandlerAccessToken(auth.session);
  const plans = await listPartnerSubscriptionPlans(accessToken);
  const plan = plans.find((item) => item.skuId === input.skuId);
  if (!plan) return c.json({ code: "SKU_NOT_FOUND", message: "所选订阅套餐已下架，请刷新后重试" }, 404);
  const amountFen = input.amountFen;
  const now = new Date();
  const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : now;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (Number.isNaN(effectiveAt.getTime()) || (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= effectiveAt))) {
    return c.json({ code: "VALIDATION_ERROR", message: "价格生效时间或过期时间不正确" }, 400);
  }
  const chandlerPrice = await createPartnerPriceVersion(accessToken, {
    skuId: plan.skuId,
    amountFen,
    currency: plan.currency || "CNY",
    billingInterval: plan.billingInterval,
    intervalCount: plan.intervalCount || 1,
    effectiveAt: effectiveAt.toISOString(),
    expiresAt: expiresAt?.toISOString() || null,
  });
  const saved = await persistChandlerPriceVersion({ plan, price: chandlerPrice, createdBy: auth.user.id, source: "website-admin" });
  return c.json({
    id: saved._id.toString(),
    chandlerPriceId: chandlerPrice.id,
    source: "website-admin",
    remoteAuthority: "chandler-partner-sku-v2.2",
    chandlerSyncStatus: "synced",
    amountFen,
    billingInterval: plan.billingInterval,
    effectiveAt,
    expiresAt,
    status: saved.status,
    desktopSyncEndpoint: "/api/v1/pricing/subscriptions",
    message: effectiveAt <= now
      ? "Chandler 远程价格版本已生效，并同步到官网、下单与桌面端价格接口"
      : "Chandler 远程价格版本已创建，将在指定时间自动生效",
  }, 201);
});

app.openapi(adminCreateChandlerSkuRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const accessToken = await getChandlerAccessToken(auth.session);
  return c.json(await createPartnerSku(accessToken, c.req.valid("json")), 201);
});

app.openapi(adminListChandlerPriceVersionsRoute, async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const accessToken = await getChandlerAccessToken(auth.session);
  const prices = await listPartnerPriceVersions(accessToken, c.req.valid("param").skuId);
  return c.json({ prices });
});

app.openapi(adminSetChandlerSkuStatusRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const accessToken = await getChandlerAccessToken(auth.session);
  const { skuId } = c.req.valid("param");
  const { status } = c.req.valid("json");
  const result = await setPartnerSkuStatus(accessToken, skuId, status);
  return c.json({ ...(result && typeof result === "object" ? result : {}), skuId, status });
});

app.openapi(adminRequestChandlerEntitlementRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const input = c.req.valid("json");
  const accessToken = await getChandlerAccessToken(auth.session);
  const approval = await chandlerRequest("/v1/admin/approvals", {
    method: "POST",
    accessToken,
    body: {
      type: "entitlement_grant",
      payload: {
        user_id: input.userId,
        entitlement_code: input.entitlementCode,
        valid_until: input.validUntil,
        reason: input.reason,
      },
      reason: input.reason,
    },
  });
  return c.json(approval, 201);
});

app.get("/api/partners", async (c) => {
  if (!isDatabaseConfigured()) return c.json({ partners: [] });
  const partners = await (await getCollection("partners"))
    .find({ enabled: true })
    .sort({ sort: 1, createdAt: -1 })
    .limit(60)
    .toArray();
  return c.json({
    partners: partners.map((partner) => ({
      id: partner._id.toString(),
      name: partner.name,
      websiteUrl: partner.websiteUrl,
      logoUrl: partnerLogoUrl(partner),
      promotionalImageUrl: partner.promotionObjectKey ? `/api/partners/${partner._id}/image/promotion` : partner.promotionUrl || null,
      nodeAction: partner.nodeAction === "promotion" && (partner.promotionObjectKey || partner.promotionUrl) ? "promotion" : "website",
      industryInput: partner.industryInput || "其他",
      industryKey: partner.industryKey || "other",
      industryName: partner.industryName || "其他行业",
    })),
  });
});

app.get("/api/partners/:id/logo.svg", async (c) => {
  if (!ObjectId.isValid(c.req.param("id"))) return c.text("Not found", 404);
  const partner = await (await getCollection("partners")).findOne({ _id: new ObjectId(c.req.param("id")), enabled: true });
  if (!partner || partner.logoMode === "url") return c.text("Not found", 404);
  return c.body(generatedPartnerLogo(partner), 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  });
});

app.get("/api/partners/:id/image/:kind", async (c) => {
  if (!ObjectId.isValid(c.req.param("id"))) return c.text("Not found", 404);
  const kind = c.req.param("kind");
  if (!['logo', 'promotion'].includes(kind)) return c.text("Not found", 404);
  const partner = await (await getCollection("partners")).findOne({ _id: new ObjectId(c.req.param("id")), enabled: true });
  const objectKey = kind === "logo" ? partner?.logoObjectKey : partner?.promotionObjectKey;
  if (!objectKey) return c.text("Not found", 404);
  c.header("Cache-Control", "private, no-store");
  return c.redirect(createPresignedDownloadUrl(objectKey, { expires: 10 * 60 }), 302);
});

app.get("/api/admin/partners", async (c) => {
  const auth = await requireAdmin(c);
  if (auth.error) return auth.error;
  const partners = await (await getCollection("partners")).find({}).sort({ sort: 1, createdAt: -1 }).toArray();
  return c.json({
    partners: partners.map((partner) => ({
      ...partner,
      id: partner._id.toString(),
      _id: undefined,
      logoPreviewUrl: partnerLogoUrl(partner),
      promotionPreviewUrl: partner.promotionObjectKey ? `/api/partners/${partner._id}/image/promotion` : partner.promotionUrl || null,
    })),
  });
});

app.post("/api/admin/partners/assets/presign", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const input = partnerAssetUploadInput(body);
  if (!input) {
    return c.json({ code: "VALIDATION_ERROR", message: "仅支持 PNG、JPG、WebP 或 GIF 图片，单张不超过 30 MB" }, 400);
  }
  try {
    await ensureBrowserUploadCors();
  } catch {
    return c.json({ code: "COS_CORS_CONFIGURATION_FAILED", message: "腾讯云 COS 暂未允许官网上传图片，请确认当前密钥具有存储桶跨域配置权限后重试" }, 503);
  }
  return c.json(partnerAssetUploadTicket(input), 201);
});

app.post("/api/admin/partners/:id/assets/replace", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  const body = await c.req.json();
  const input = partnerAssetUploadInput(body);
  if (!input) return c.json({ code: "VALIDATION_ERROR", message: "仅支持 PNG、JPG、WebP 或 GIF 图片，单张不超过 30 MB" }, 400);
  try {
    await ensureBrowserUploadCors();
  } catch {
    return c.json({ code: "COS_CORS_CONFIGURATION_FAILED", message: "腾讯云 COS 暂未允许官网上传图片，请确认当前密钥具有存储桶跨域配置权限后重试" }, 503);
  }
  const partners = await getCollection("partners");
  const partnerId = new ObjectId(c.req.param("id"));
  const partner = await partners.findOne({ _id: partnerId });
  if (!partner) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  const assetField = input.kind === "logo" ? "logoObjectKey" : "promotionObjectKey";
  const previousObjectKey = partner[assetField] || null;
  if (previousObjectKey) {
    try {
      await deleteObject(previousObjectKey);
    } catch {
      return c.json({ code: "COS_DELETE_FAILED", message: "旧图片尚未从腾讯云 COS 删除，请稍后重试" }, 502);
    }
    await partners.updateOne(
      { _id: partnerId, [assetField]: previousObjectKey },
      { $set: { [assetField]: null, updatedAt: new Date() } },
    );
  }
  return c.json({ ...partnerAssetUploadTicket(input), previousDeleted: Boolean(previousObjectKey) }, 201);
});

app.post("/api/admin/partners", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const websiteUrl = parseHttpUrl(body.websiteUrl);
  const logoMode = body.logoMode === "upload" ? "upload" : body.logoMode === "url" ? "url" : "generated";
  const logoUrl = logoMode === "url" ? parseHttpUrl(body.logoUrl) : null;
  const logoObjectKey = logoMode === "upload" && String(body.logoObjectKey || "").startsWith("partners/assets/logo/") ? String(body.logoObjectKey) : null;
  const promotionObjectKey = String(body.promotionObjectKey || "").startsWith("partners/assets/promotion/") ? String(body.promotionObjectKey) : null;
  const promotionUrl = body.promotionUrl ? parseHttpUrl(body.promotionUrl) : null;
  const nodeAction = body.nodeAction === "promotion" ? "promotion" : "website";
  const industry = String(body.industry || "").trim();
  const classification = classifyPartnerIndustry(industry, name);
  if (name.length < 2 || name.length > 80 || industry.length < 2 || industry.length > 80 || !websiteUrl || (logoMode === "url" && !logoUrl) || (logoMode === "upload" && !logoObjectKey) || (nodeAction === "promotion" && !promotionObjectKey && !promotionUrl)) {
    return c.json({ code: "VALIDATION_ERROR", message: "企业名称、所属行业、官网网址或 Logo 信息不正确" }, 400);
  }
  if (logoObjectKey || promotionObjectKey) {
    try { await Promise.all([logoObjectKey && headObject(logoObjectKey), promotionObjectKey && headObject(promotionObjectKey)].filter(Boolean)); }
    catch { return c.json({ code: "ASSET_NOT_FOUND", message: "Logo 或宣传图片尚未完整上传到 COS" }, 409); }
  }
  const now = new Date();
  const result = await (await getCollection("partners")).insertOne({
    name, websiteUrl, logoMode, logoUrl, logoObjectKey, promotionObjectKey, promotionUrl, nodeAction, ...classification,
    enabled: body.enabled !== false,
    sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : 100,
    createdBy: new ObjectId(auth.user.id),
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id: result.insertedId.toString(), logoUrl: logoMode === "upload" ? `/api/partners/${result.insertedId}/image/logo` : logoMode === "url" ? logoUrl : `/api/partners/${result.insertedId}/logo.svg`, classification }, 201);
});

app.put("/api/admin/partners/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  const partners = await getCollection("partners");
  const partnerId = new ObjectId(c.req.param("id"));
  const current = await partners.findOne({ _id: partnerId });
  if (!current) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const websiteUrl = parseHttpUrl(body.websiteUrl);
  const logoMode = body.logoMode === "upload" ? "upload" : body.logoMode === "url" ? "url" : "generated";
  const logoUrl = logoMode === "url" ? parseHttpUrl(body.logoUrl) : null;
  const logoObjectKey = logoMode === "upload" && String(body.logoObjectKey || "").startsWith("partners/assets/logo/") ? String(body.logoObjectKey) : null;
  const promotionObjectKey = String(body.promotionObjectKey || "").startsWith("partners/assets/promotion/") ? String(body.promotionObjectKey) : null;
  const promotionUrl = body.promotionUrl ? parseHttpUrl(body.promotionUrl) : null;
  const nodeAction = body.nodeAction === "promotion" ? "promotion" : "website";
  const industry = String(body.industry || "").trim();
  const classification = classifyPartnerIndustry(industry, name);
  if (name.length < 2 || name.length > 80 || industry.length < 2 || industry.length > 80 || !websiteUrl || (logoMode === "url" && !logoUrl) || (logoMode === "upload" && !logoObjectKey) || (nodeAction === "promotion" && !promotionObjectKey && !promotionUrl)) {
    return c.json({ code: "VALIDATION_ERROR", message: "企业名称、所属行业、官网网址或 Logo 信息不正确" }, 400);
  }
  const bypassedReplacementFlow = [
    current.logoObjectKey && logoObjectKey && current.logoObjectKey !== logoObjectKey,
    current.promotionObjectKey && promotionObjectKey && current.promotionObjectKey !== promotionObjectKey,
  ].some(Boolean);
  if (bypassedReplacementFlow) {
    return c.json({ code: "PARTNER_ASSET_REPLACE_REQUIRED", message: "替换图片前必须先调用图片替换接口删除 COS 旧图" }, 409);
  }
  const changedObjectKeys = [
    logoObjectKey && logoObjectKey !== current.logoObjectKey ? logoObjectKey : null,
    promotionObjectKey && promotionObjectKey !== current.promotionObjectKey ? promotionObjectKey : null,
  ].filter(Boolean);
  if (changedObjectKeys.length) {
    try { await Promise.all(changedObjectKeys.map((objectKey) => headObject(objectKey))); }
    catch { return c.json({ code: "ASSET_NOT_FOUND", message: "新的 Logo 或宣传图片尚未完整上传到 COS" }, 409); }
  }
  const staleObjectKeys = [
    current.logoObjectKey && current.logoObjectKey !== logoObjectKey ? current.logoObjectKey : null,
    current.promotionObjectKey && current.promotionObjectKey !== promotionObjectKey ? current.promotionObjectKey : null,
  ].filter(Boolean);
  if (staleObjectKeys.length) {
    try { await Promise.all(staleObjectKeys.map((objectKey) => deleteObject(objectKey))); }
    catch { return c.json({ code: "COS_DELETE_FAILED", message: "旧图片尚未从腾讯云 COS 删除，合作伙伴资料未修改" }, 502); }
  }
  const result = await partners.updateOne(
    { _id: partnerId },
    { $set: { name, websiteUrl, logoMode, logoUrl, logoObjectKey, promotionObjectKey, promotionUrl, nodeAction, ...classification, enabled: body.enabled !== false, sort: Number(body.sort || 100), updatedAt: new Date() } },
  );
  return c.json({ ok: Boolean(result.matchedCount), classification });
});

app.delete("/api/admin/partners/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  const partners = await getCollection("partners");
  const partner = await partners.findOne({ _id: new ObjectId(c.req.param("id")) });
  if (!partner) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  await partners.deleteOne({ _id: partner._id });
  await Promise.allSettled([partner.logoObjectKey && deleteObject(partner.logoObjectKey), partner.promotionObjectKey && deleteObject(partner.promotionObjectKey)].filter(Boolean));
  return c.json({ ok: true });
});

app.openapi(latestReleaseRoute, async (c) => {
  if (!isDatabaseConfigured()) return c.json({ release: null });
  const auth = await authenticate(c, { required: false });
  const users = auth?.user?.id && ObjectId.isValid(auth.user.id) ? await getCollection("users") : null;
  const user = users ? await users.findOne({ _id: new ObjectId(auth.user.id) }) : null;
  const requested = String(c.req.query("channel") || "").trim();
  const filter = requested && auth?.user?.role === "admin"
    ? { _id: ObjectId.isValid(requested) ? new ObjectId(requested) : null, enabled: true }
    : user?.releaseChannelId
      ? { _id: user.releaseChannelId, enabled: true }
      : { isDefault: true, enabled: true };
  let channel = filter._id === null ? null : await (await getCollection("releaseChannels")).findOne(filter);
  if (!channel) channel = await (await getCollection("releaseChannels")).findOne({ enabled: true }, { sort: { sort: 1, updatedAt: -1 } });
  return c.json({ release: publicReleaseMetadata(channel) });
});

app.get("/api/releases/:channelId/download", async (c) => {
  const auth = await authenticate(c, { required: false });
  const id = c.req.param("channelId");
  if (!ObjectId.isValid(id)) return c.json({ code: "RELEASE_NOT_FOUND", message: "发行渠道不存在" }, 404);
  const channel = await (await getCollection("releaseChannels")).findOne({ _id: new ObjectId(id), enabled: true });
  if (channel?.distributionStatus === "uploading") return c.json({ code: "RELEASE_UPDATING", message: "该渠道正在上传新版本，请稍后重试" }, 409);
  if (!channel?.latestRelease?.objectKey) return c.json({ code: "RELEASE_NOT_FOUND", message: "该渠道尚未上传新版本" }, 404);
  if (!channel.isDefault && auth?.user?.role !== "admin") {
    const user = auth?.user?.id ? await (await getCollection("users")).findOne({ _id: new ObjectId(auth.user.id) }) : null;
    if (!user?.releaseChannelId?.equals?.(channel._id)) {
      return c.json({ code: "FORBIDDEN", message: "当前账号无权下载该发行渠道" }, 403);
    }
  }
  return c.json({
    url: createPresignedDownloadUrl(channel.latestRelease.objectKey, { filename: channel.latestRelease.filename }),
    filename: channel.latestRelease.filename,
    expiresIn: 900,
  });
});

app.get("/api/admin/release-channels", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const keyword = String(c.req.query("keyword") || "").trim();
  const filter = keyword ? { name: { $regex: keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {};
  const [channels, jobs] = await Promise.all([
    (await getCollection("releaseChannels")).find(filter).sort({ sort: 1, name: 1 }).limit(128).toArray(),
    (await getCollection("releaseJobs")).find({}).sort({ createdAt: -1 }).limit(30).toArray(),
  ]);
  return c.json({
    channels: channels.map((channel) => ({ ...channel, id: channel._id.toString(), _id: undefined })),
    jobs: jobs.map((job) => ({ ...job, id: job._id.toString(), channelId: job.channelId.toString(), _id: undefined })),
  });
});

app.post("/api/admin/release-jobs", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  if (!ObjectId.isValid(body.channelId)) return c.json({ code: "VALIDATION_ERROR", message: "发行渠道无效" }, 400);
  let channel = await (await getCollection("releaseChannels")).findOne({ _id: new ObjectId(body.channelId), enabled: true });
  if (!channel) return c.json({ code: "CHANNEL_NOT_FOUND", message: "发行渠道不存在或已停用" }, 404);
  const availability = await releaseChannelAvailability(channel);
  if (availability.blocked) return c.json({ code: "RELEASE_IN_PROGRESS", message: "该渠道已有上传任务正在进行" }, 409);
  channel = availability.channel;
  const active = await (await getCollection("releaseJobs")).findOne({ channelId: channel._id, status: { $in: ["queued", "building", "uploading"] } });
  if (active) return c.json({ code: "RELEASE_IN_PROGRESS", message: "该渠道已有发版任务正在执行" }, 409);
  const now = new Date();
  const result = await (await getCollection("releaseJobs")).insertOne({
    channelId: channel._id,
    channelName: channel.name,
    groupId: channel.groupId,
    menuSelection: channel.menuSelection,
    status: "queued",
    requestedBy: new ObjectId(auth.user.id),
    sourceThreadId: "019f4ac3-0097-7f31-a3d7-a745df981544",
    releaseWorkflowThreadId: "019f91fb-3c27-7c12-a6dc-2c14fe9d467d",
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id: result.insertedId.toString(), status: "queued", channelName: channel.name }, 201);
});

app.openapi(adminManualReleaseUploadRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const id = c.req.valid("param").id;
  if (!ObjectId.isValid(id)) return c.json({ code: "CHANNEL_NOT_FOUND", message: "发行渠道不存在" }, 404);
  const body = c.req.valid("json");
  const filename = sanitizeFilename(body.filename, "Gulong-Agent-Setup.exe");
  const bytes = Number(body.bytes);
  const version = String(body.version || "").trim();
  const extension = filename.toLowerCase().match(/\.(exe|msix|msixbundle|zip)$/)?.[1];
  if (!extension || !Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 5 * 1024 * 1024 * 1024 || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(version)) {
    return c.json({ code: "VALIDATION_ERROR", message: "请提供有效版本号和不超过 5 GB 的 Windows 安装包" }, 400);
  }
  let channel = await (await getCollection("releaseChannels")).findOne({ _id: new ObjectId(id), enabled: true });
  if (!channel) return c.json({ code: "CHANNEL_NOT_FOUND", message: "发行渠道不存在或已停用" }, 404);
  const availability = await releaseChannelAvailability(channel);
  if (availability.blocked) return c.json({ code: "RELEASE_IN_PROGRESS", message: "该渠道已有发版或上传任务正在进行" }, 409);
  channel = availability.channel;
  const [activeJob, activeUpload] = await Promise.all([
    (await getCollection("releaseJobs")).findOne({ channelId: channel._id, status: { $in: ["queued", "building", "uploading"] } }),
    (await getCollection("releaseUploads")).findOne({ channelId: channel._id, status: { $in: ["prepared", "uploading"] }, expiresAt: { $gt: new Date() } }),
  ]);
  if (activeJob || activeUpload) return c.json({ code: "RELEASE_IN_PROGRESS", message: "该渠道已有发版或上传任务正在进行" }, 409);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60_000);
  const objectKey = `releases/${channel._id}/manual/${Date.now()}-${randomBytes(8).toString("hex")}-${filename}`;
  const result = await (await getCollection("releaseUploads")).insertOne({
    channelId: channel._id,
    channelName: channel.name,
    requestedBy: new ObjectId(auth.user.id),
    objectKey,
    previousObjectKey: channel.latestRelease?.objectKey || null,
    filename,
    version,
    bytes,
    status: "uploading",
    source: "admin-browser",
    createdAt: now,
    updatedAt: now,
    expiresAt,
  });
  const requiredHeaders = { "Content-Type": "application/octet-stream" };
  return c.json({
    uploadId: result.insertedId.toString(),
    uploadUrl: createPresignedPutUrl(objectKey, { expires: 60 * 60, headers: requiredHeaders }),
    objectKey,
    expiresIn: 3600,
    requiredHeaders,
    storage: { provider: "腾讯云 COS", ...cosConfig() },
  }, 201);
});

app.openapi(adminCompleteManualReleaseUploadRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const id = c.req.valid("param").id;
  if (!ObjectId.isValid(id)) return c.json({ code: "UPLOAD_NOT_FOUND", message: "版本上传记录不存在" }, 404);
  const uploads = await getCollection("releaseUploads");
  const upload = await uploads.findOne({ _id: new ObjectId(id), status: "uploading" });
  if (!upload) return c.json({ code: "UPLOAD_NOT_FOUND", message: "版本上传记录不存在或已经完成" }, 404);
  let head;
  try { head = await headObject(upload.objectKey); }
  catch { return c.json({ code: "UPLOAD_NOT_FOUND", message: "COS 中尚未找到完整安装包，请确认上传完成后重试" }, 409); }
  const actualBytes = objectSize(head);
  if (!actualBytes || actualBytes !== upload.bytes) {
    return c.json({ code: "UPLOAD_SIZE_MISMATCH", message: "COS 中安装包大小与上传声明不一致" }, 409);
  }
  const channels = await getCollection("releaseChannels");
  const channel = await channels.findOne({ _id: upload.channelId, enabled: true });
  if (!channel) return c.json({ code: "CHANNEL_NOT_FOUND", message: "发行渠道不存在或已停用" }, 404);
  if ((channel.latestRelease?.objectKey || null) !== upload.previousObjectKey) {
    return c.json({ code: "RELEASE_CHANGED", message: "该渠道的线上版本已发生变化，请重新选择文件上传" }, 409);
  }
  const now = new Date();
  const latestRelease = {
    objectKey: upload.objectKey,
    filename: upload.filename,
    version: upload.version,
    bytes: upload.bytes,
    sha256: "manual-pending",
    signatureStatus: "manual-upload",
    source: "admin-browser",
    publishedAt: now,
  };
  const swapped = await channels.updateOne(
    { _id: channel._id, updatedAt: channel.updatedAt },
    { $set: { latestRelease, distributionStatus: "ready", updatedAt: now }, $unset: { releaseError: "", releaseFailedAt: "" } },
  );
  if (!swapped.modifiedCount) return c.json({ code: "RELEASE_CHANGED", message: "发行渠道刚刚被更新，请重新上传" }, 409);
  await uploads.updateOne({ _id: upload._id }, { $set: { status: "completed", completedAt: now, updatedAt: now } });
  let cleanupWarning = null;
  if (upload.previousObjectKey && upload.previousObjectKey !== upload.objectKey) {
    try { await deleteObject(upload.previousObjectKey); }
    catch {
      cleanupWarning = "新版本已生效，但旧文件清理失败，系统已记录待清理对象";
      await uploads.updateOne({ _id: upload._id }, { $set: { cleanupPendingObjectKey: upload.previousObjectKey } });
    }
  }
  return c.json({ ok: true, channelId: channel._id.toString(), latestRelease, cleanupWarning });
});

app.openapi(releaseWorkerPrepareRoute, (c) => c.json({
  code: "DIRECT_RELEASE_DISABLED",
  message: "旧版直传发行协议已停用，请由管理员在版本管理中手动上传或创建手动打包发布任务",
}, 410));

app.openapi(releaseWorkerCompleteRoute, (c) => c.json({
  code: "DIRECT_RELEASE_DISABLED",
  message: "旧版直传发行协议已停用，请由管理员在版本管理中手动上传或创建手动打包发布任务",
}, 410));

app.openapi(releaseWorkerFailRoute, (c) => c.json({
  code: "DIRECT_RELEASE_DISABLED",
  message: "旧版直传发行协议已停用，请由管理员在版本管理中手动上传或创建手动打包发布任务",
}, 410));
app.post("/api/release-worker/channels/sync", async (c) => {
  if (!workerAuthorized(c)) return c.json({ code: "UNAUTHORIZED", message: "发行工作器凭据无效" }, 401);
  const body = await c.req.json();
  const groups = Array.isArray(body.groups) ? body.groups.slice(0, 128) : [];
  const assignments = Array.isArray(body.assignments) ? body.assignments.slice(0, 50_000) : [];
  if (!groups.length) return c.json({ code: "VALIDATION_ERROR", message: "没有可同步的用户分组" }, 400);
  const collection = await getCollection("releaseChannels");
  const now = new Date();
  const seen = [];
  for (const [index, group] of groups.entries()) {
    const groupId = String(group.id || "").trim();
    const name = String(group.name || "").trim();
    const themeNames = Array.isArray(group.themeNames) ? group.themeNames.map(String).slice(0, 20) : [];
    if (!groupId || !name || !themeNames.length) continue;
    seen.push(groupId);
    await collection.updateOne(
      { groupId },
      {
        $set: {
          name,
          themeNames,
          menuSelection: index + 1,
          profileKey: String(group.profileKey || ""),
          enabled: true,
          isDefault: index === 0,
          sort: index + 1,
          source: "desktop-theme-access",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }
  await collection.updateMany({ groupId: { $nin: seen } }, { $set: { enabled: false, isDefault: false, updatedAt: now } });
  const channels = await collection.find({ groupId: { $in: seen } }).toArray();
  const channelMap = new Map(channels.map((channel) => [channel.groupId, channel]));
  const assignmentMap = new Map();
  for (const assignment of assignments) {
    const chandlerUserId = String(assignment.userId || "").trim();
    const groupId = String(assignment.groupId || "").trim();
    const channel = channelMap.get(groupId);
    if (chandlerUserId && channel) {
      const edition = productEditionFromChannel(channel);
      assignmentMap.set(chandlerUserId, {
        chandlerUserId,
        displayName: String(assignment.displayName || "").trim().slice(0, 160),
        groupId,
        channelId: channel._id,
        editionKey: edition.key,
        editionName: edition.name,
        updatedAt: now,
      });
    }
  }
  const normalizedAssignments = [...assignmentMap.values()];
  const releaseAssignments = await getCollection("releaseAssignments");
  const previousAssignedUserIds = await releaseAssignments.distinct("chandlerUserId");
  await releaseAssignments.deleteMany({});
  if (normalizedAssignments.length) await releaseAssignments.insertMany(normalizedAssignments, { ordered: false });
  const users = await getCollection("users");
  const currentAssignedUserIds = new Set(normalizedAssignments.map((assignment) => assignment.chandlerUserId));
  const removedAssignedUserIds = previousAssignedUserIds.filter((id) => !currentAssignedUserIds.has(String(id)));
  if (removedAssignedUserIds.length) {
    await users.updateMany(
      { chandlerUserId: { $in: removedAssignedUserIds } },
      { $unset: { releaseChannelId: "", releaseChannelGroupId: "", releaseChannelSource: "" }, $set: { updatedAt: now } },
    );
  }
  if (normalizedAssignments.length) {
    await users.bulkWrite(normalizedAssignments.map((assignment) => ({
      updateOne: {
        filter: { chandlerUserId: assignment.chandlerUserId },
        update: { $set: { releaseChannelId: assignment.channelId, releaseChannelGroupId: assignment.groupId, releaseChannelSource: "desktop-theme-access", editionKey: assignment.editionKey, editionName: assignment.editionName, editionSource: "desktop-theme-access", updatedAt: now } },
      },
    })), { ordered: false });
  }
  return c.json({ ok: true, synchronized: seen.length, assignments: normalizedAssignments.length });
});

app.post("/api/release-worker/jobs/claim", async (c) => {
  if (!workerAuthorized(c)) return c.json({ code: "UNAUTHORIZED", message: "发行工作器凭据无效" }, 401);
  const now = new Date();
  const job = await (await getCollection("releaseJobs")).findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "building", workerId: String((await c.req.json().catch(() => ({}))).workerId || "windows-release-worker").slice(0, 80), claimedAt: now, leaseUntil: new Date(now.getTime() + 4 * 60 * 60_000), updatedAt: now } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!job) return c.json({ job: null });
  return c.json({ job: { ...job, id: job._id.toString(), channelId: job.channelId.toString(), _id: undefined } });
});

app.post("/api/release-worker/jobs/:id/upload", async (c) => {
  if (!workerAuthorized(c)) return c.json({ code: "UNAUTHORIZED", message: "发行工作器凭据无效" }, 401);
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "发版任务不存在" }, 404);
  const body = await c.req.json();
  const job = await (await getCollection("releaseJobs")).findOne({ _id: new ObjectId(c.req.param("id")), status: "building" });
  if (!job) return c.json({ code: "JOB_NOT_BUILDING", message: "发版任务不在可上传状态" }, 409);
  let channel = await (await getCollection("releaseChannels")).findOne({ _id: job.channelId });
  if (!channel) return c.json({ code: "CHANNEL_NOT_FOUND", message: "发行渠道不存在或已停用" }, 404);
  const availability = await releaseChannelAvailability(channel);
  if (availability.blocked) return c.json({ code: "RELEASE_IN_PROGRESS", message: "该渠道已有上传任务正在进行" }, 409);
  channel = availability.channel;
  const filename = sanitizeFilename(body.filename, "Gulong-Agent-Setup.exe");
  const bytes = Number(body.bytes);
  if (!filename.toLowerCase().endsWith(".exe") || !Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 5 * 1024 * 1024 * 1024) {
    return c.json({ code: "VALIDATION_ERROR", message: "安装包文件名或大小无效" }, 400);
  }
  const objectKey = `releases/${channel.groupId}/${Date.now()}-${randomBytes(8).toString("hex")}-${filename}`;
  await (await getCollection("releaseJobs")).updateOne(
    { _id: job._id },
    { $set: { status: "uploading", objectKey, previousObjectKey: channel?.latestRelease?.objectKey || null, filename, version: String(body.version || "").slice(0, 40), bytes, sha256: String(body.sha256 || "").toUpperCase(), signatureStatus: String(body.signatureStatus || "unknown").slice(0, 40), updatedAt: new Date() } },
  );
  return c.json({ uploadUrl: createPresignedPutUrl(objectKey, { expires: 60 * 60 }), objectKey, expiresIn: 3600 });
});

app.post("/api/release-worker/jobs/:id/complete", async (c) => {
  if (!workerAuthorized(c)) return c.json({ code: "UNAUTHORIZED", message: "发行工作器凭据无效" }, 401);
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "发版任务不存在" }, 404);
  const job = await (await getCollection("releaseJobs")).findOne({ _id: new ObjectId(c.req.param("id")), status: "uploading" });
  if (!job) return c.json({ code: "JOB_NOT_UPLOADING", message: "发版任务不在上传状态" }, 409);
  const head = await headObject(job.objectKey);
  const actualBytes = objectSize(head);
  if (actualBytes && actualBytes !== job.bytes) return c.json({ code: "UPLOAD_SIZE_MISMATCH", message: "COS 中安装包大小与发版回执不一致" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const now = new Date();
  const latestRelease = {
    objectKey: job.objectKey,
    filename: job.filename,
    version: job.version,
    bytes: job.bytes,
    sha256: job.sha256,
    signatureStatus: job.signatureStatus,
    receipt: body.receipt || null,
    publishedAt: now,
  };
  const channels = await getCollection("releaseChannels");
  const channel = await channels.findOne({ _id: job.channelId });
  if ((channel?.latestRelease?.objectKey || null) !== (job.previousObjectKey || null)) {
    return c.json({ code: "RELEASE_CHANGED", message: "该渠道最新版已变化，拒绝覆盖" }, 409);
  }
  const swapped = await channels.updateOne({ _id: job.channelId, updatedAt: channel.updatedAt }, { $set: { latestRelease, distributionStatus: "ready", updatedAt: now }, $unset: { releaseError: "", releaseFailedAt: "" } });
  if (!swapped.modifiedCount) return c.json({ code: "RELEASE_CHANGED", message: "该渠道刚刚被更新，拒绝覆盖" }, 409);
  await (await getCollection("releaseJobs")).updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: now, updatedAt: now } });
  if (job.previousObjectKey && job.previousObjectKey !== job.objectKey) {
    try { await deleteObject(job.previousObjectKey); }
    catch { await (await getCollection("releaseJobs")).updateOne({ _id: job._id }, { $set: { cleanupPendingObjectKey: job.previousObjectKey } }); }
  }
  return c.json({ ok: true, publishedAt: now });
});

app.post("/api/release-worker/jobs/:id/fail", async (c) => {
  if (!workerAuthorized(c)) return c.json({ code: "UNAUTHORIZED", message: "发行工作器凭据无效" }, 401);
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "发版任务不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  await (await getCollection("releaseJobs")).updateOne(
    { _id: new ObjectId(c.req.param("id")), status: { $in: ["building", "uploading"] } },
    { $set: { status: "failed", error: String(body.error || "发行工作流失败").slice(0, 4000), failedAt: new Date(), updatedAt: new Date() } },
  );
  return c.json({ ok: true });
});

app.get("/api/downloads", async (c) => {
  c.header("Cache-Control", "no-store, max-age=0");
  const defaults = [
    { id: "feishu", label: "飞书下载", url: process.env.DOWNLOAD_FEISHU_URL || null, code: null },
    { id: "quark", label: "夸克网盘", url: process.env.DOWNLOAD_QUARK_URL || null, code: null },
    {
      id: "baidu",
      label: "百度网盘",
      url: process.env.DOWNLOAD_BAIDU_URL || null,
      code: process.env.DOWNLOAD_BAIDU_CODE || null,
    },
  ];
  if (!isDatabaseConfigured()) return c.json({ links: defaults, release: null, editions: [] });
  const [custom, editionChannels] = await Promise.all([
    (await getCollection("downloadLinks")).find({ enabled: true }).sort({ sort: 1 }).toArray(),
    publicEditionChannels(),
  ]);
  const editions = ["gulong", "yongshenghua"]
    .map((key) => publicReleaseMetadata(editionChannels.get(key)))
    .filter(Boolean);
  return c.json({
    links: custom.length
      ? custom.map(({ _id, provider, label, url, code }) => ({ id: provider || _id.toString(), label, url, code }))
      : defaults,
    release: editions.find((item) => item.editionKey === "gulong") || null,
    editions,
  });
});

app.get("/api/downloads/:edition/download", async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  const editionKey = String(c.req.param("edition") || "").trim().toLowerCase();
  if (!["gulong", "yongshenghua"].includes(editionKey)) return c.json({ code: "RELEASE_NOT_FOUND", message: "桌面版本类型不存在" }, 404);
  const channels = await publicEditionChannels();
  const channel = channels.get(editionKey);
  if (!channel?.latestRelease?.objectKey) return c.json({ code: "RELEASE_NOT_FOUND", message: "该桌面版本正在准备中" }, 404);
  return c.json({
    url: createPresignedDownloadUrl(channel.latestRelease.objectKey, { filename: channel.latestRelease.filename }),
    filename: channel.latestRelease.filename,
    channelId: channel._id.toString(),
    editionKey,
    expiresIn: 900,
  });
});

app.put("/api/admin/downloads", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  if (auth.user.role !== "admin") return c.json({ code: "FORBIDDEN", message: "仅管理员可配置下载链接" }, 403);
  const body = await c.req.json();
  const provider = ["feishu", "quark", "baidu"].includes(body.provider) ? body.provider : null;
  const label = String(body.label || "").trim();
  let url;
  try { url = new URL(String(body.url || "")); } catch { url = null; }
  if (!provider || label.length < 2 || label.length > 30 || !url || !["https:", "http:"].includes(url.protocol)) {
    return c.json({ code: "VALIDATION_ERROR", message: "下载渠道、名称或链接不正确" }, 400);
  }
  await (await getCollection("downloadLinks")).updateOne(
    { provider },
    {
      $set: {
        label,
        url: url.toString(),
        code: body.code ? String(body.code).trim().slice(0, 20) : null,
        enabled: body.enabled !== false,
        sort: provider === "feishu" ? 1 : provider === "quark" ? 2 : 3,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  return c.json({ ok: true });
});

app.post("/api/uploads/token", async (c) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return c.json({ code: "CONFIG_REQUIRED", message: "文件存储尚未配置 BLOB_READ_WRITE_TOKEN" }, 503);
  }
  const body = await c.req.json();
  let ownerId = null;
  if (body.type === "blob.generate-client-token") {
    if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
    const auth = await authenticate(c);
    if (auth.error) return auth.error;
    ownerId = auth.user.id;
  }
  const result = await handleUpload({
    body,
    request: c.req.raw,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const payload = JSON.parse(clientPayload || "{}");
      const kind = "feedback";
      const isZip = /\.zip$/i.test(pathname);
      if (payload.kind === "brain") throw new Error("第二大脑文件已迁移到腾讯云 COS，请刷新页面后重试");
      return {
        allowedContentTypes: kind === "brain"
          ? ["application/zip", "application/x-zip-compressed", "application/octet-stream"]
          : ["image/png", "image/jpeg", "image/webp", "image/gif"],
        maximumSizeInBytes: kind === "brain" ? 500 * 1024 * 1024 : 15 * 1024 * 1024,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ ownerId, kind }),
      };
    },
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      const payload = JSON.parse(tokenPayload || "{}");
      if (!ObjectId.isValid(payload.ownerId) || !["brain", "feedback"].includes(payload.kind)) {
        throw new Error("上传回调负载无效");
      }
      await (await getCollection("uploads")).insertOne({
        ownerId: new ObjectId(payload.ownerId),
        kind: payload.kind,
        pathname: blob.pathname,
        url: blob.url,
        size: blob.size,
        contentType: blob.contentType,
        status: payload.kind === "brain" ? "queued_for_analysis" : "ready",
        createdAt: new Date(),
      });
    },
  });
  return c.json(result);
});

app.post("/api/brain/uploads/presign", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const originalName = sanitizeFilename(body.filename, "second-brain.zip");
  const size = Number(body.size);
  const contentType = String(body.contentType || "application/zip").toLowerCase();
  if (!originalName.toLowerCase().endsWith(".zip") || !Number.isSafeInteger(size) || size < 1 || size > 2 * 1024 * 1024 * 1024) {
    return c.json({ code: "VALIDATION_ERROR", message: "仅支持不超过 2 GB 的 ZIP 文件" }, 400);
  }
  if (!["application/zip", "application/x-zip-compressed", "application/octet-stream", ""].includes(contentType)) {
    return c.json({ code: "VALIDATION_ERROR", message: "文件类型必须是 ZIP" }, 400);
  }
  const now = new Date();
  const key = `second-brain/${auth.user.id}/${now.toISOString().slice(0, 10)}/${randomBytes(12).toString("hex")}-${originalName}`;
  const result = await (await getCollection("uploads")).insertOne({
    ownerId: new ObjectId(auth.user.id),
    kind: "brain",
    storage: "tencent-cos",
    objectKey: key,
    originalName,
    size,
    contentType: contentType || "application/zip",
    status: "uploading",
    createdAt: now,
    updatedAt: now,
  });
  return c.json({
    uploadId: result.insertedId.toString(),
    uploadUrl: createPresignedPutUrl(key, { headers: { "Content-Type": contentType || "application/zip" } }),
    objectKey: key,
    expiresIn: 1200,
    requiredHeaders: { "Content-Type": contentType || "application/zip" },
    storage: { provider: "腾讯云 COS", ...cosConfig() },
  }, 201);
});

app.post("/api/brain/uploads/:id/complete", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "UPLOAD_NOT_FOUND", message: "上传记录不存在" }, 404);
  const uploads = await getCollection("uploads");
  const upload = await uploads.findOne({ _id: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id), kind: "brain", status: "uploading" });
  if (!upload) return c.json({ code: "UPLOAD_NOT_FOUND", message: "上传记录不存在或已经完成" }, 404);
  const head = await headObject(upload.objectKey);
  const actualSize = objectSize(head);
  if (actualSize && actualSize !== upload.size) {
    return c.json({ code: "UPLOAD_SIZE_MISMATCH", message: "COS 中的文件大小与上传声明不一致" }, 409);
  }
  const now = new Date();
  await uploads.updateOne({ _id: upload._id }, { $set: { status: "queued_for_analysis", completedAt: now, updatedAt: now } });
  return c.json({ id: upload._id.toString(), status: "queued_for_analysis", completedAt: now });
});

app.get("/api/admin/brain-attachments", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const keyword = String(c.req.query("keyword") || "").trim();
  const from = safeDate(c.req.query("from"));
  const to = safeDate(c.req.query("to"), true);
  const page = Math.max(1, Math.min(5000, Number(c.req.query("page") || 1)));
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") || 30)));
  const filter = { kind: "brain", status: { $ne: "uploading" } };
  if (keyword) filter.originalName = { $regex: keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const uploads = await getCollection("uploads");
  const [items, total] = await Promise.all([
    uploads.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    uploads.countDocuments(filter),
  ]);
  const ownerIds = [...new Set(items.map((item) => item.ownerId?.toString()).filter(Boolean))].map((id) => new ObjectId(id));
  const users = ownerIds.length ? await (await getCollection("users")).find({ _id: { $in: ownerIds } }).toArray() : [];
  const userMap = new Map(users.map((user) => [user._id.toString(), user]));
  return c.json({
    items: items.map((item) => ({
      id: item._id.toString(),
      originalName: item.originalName || item.pathname?.split("/").pop(),
      size: item.size,
      status: item.status,
      progress: brainProgress(item),
      result: item.result || null,
      feedback: item.feedback || null,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
      owner: (() => { const user = userMap.get(item.ownerId?.toString()); return user ? { id: user._id.toString(), email: user.email, username: user.username, displayName: user.displayName } : null; })(),
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

app.get("/api/admin/brain-attachments/:id/download", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ATTACHMENT_NOT_FOUND", message: "附件不存在" }, 404);
  const upload = await (await getCollection("uploads")).findOne({ _id: new ObjectId(c.req.param("id")), kind: "brain", objectKey: { $exists: true } });
  if (!upload) return c.json({ code: "ATTACHMENT_NOT_FOUND", message: "附件不存在" }, 404);
  return c.json({ url: createPresignedDownloadUrl(upload.objectKey, { filename: upload.originalName }), filename: upload.originalName, expiresIn: 900 });
});

app.put("/api/admin/brain-attachments/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ATTACHMENT_NOT_FOUND", message: "附件不存在" }, 404);
  const body = await c.req.json();
  const status = ["queued_for_analysis", "analyzing", "completed", "failed"].includes(body.status) ? body.status : null;
  const progress = Number(body.progress);
  const result = String(body.result || "").trim();
  const feedback = String(body.feedback || "").trim();
  if (!status || !Number.isFinite(progress) || progress < 0 || progress > 100 || result.length > 20_000 || feedback.length > 5_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "处理状态、进度或反馈内容不正确" }, 400);
  }
  const now = new Date();
  const updated = await (await getCollection("uploads")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), kind: "brain" },
    { $set: { status, progress: Math.round(progress), result: result || null, feedback: feedback || null, updatedAt: now, ...(status === "completed" ? { completedAt: now } : {}) } },
    { returnDocument: "after" },
  );
  if (!updated) return c.json({ code: "ATTACHMENT_NOT_FOUND", message: "附件不存在" }, 404);
  return c.json({ id: updated._id.toString(), status: updated.status, progress: brainProgress(updated), result: updated.result, feedback: updated.feedback, updatedAt: updated.updatedAt });
});

app.openapi(latestBrainAttachmentRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["brain:attachments:read"] });
  if (auth.error) return auth.error;
  if (auth.user.role !== "admin") return c.json({ code: "FORBIDDEN", message: "仅管理员可按日期拉取第二大脑附件" }, 403);
  const query = c.req.valid("query");
  const date = query.date;
  const from = safeDate(date);
  const to = safeDate(date, true);
  if (!from || !to) return c.json({ code: "VALIDATION_ERROR", message: "date 必须使用 YYYY-MM-DD 格式" }, 400);
  const keyword = String(query.keyword || "").trim();
  const filter = { kind: "brain", status: { $ne: "uploading" }, objectKey: { $exists: true }, createdAt: { $gte: from, $lte: to } };
  if (keyword) filter.originalName = { $regex: keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const upload = await (await getCollection("uploads")).findOne(filter, { sort: { createdAt: -1 } });
  if (!upload) return c.json({ code: "ATTACHMENT_NOT_FOUND", message: "指定日期没有符合条件的附件" }, 404);
  return c.json({
    id: upload._id.toString(),
    date,
    originalName: upload.originalName,
    size: upload.size,
    createdAt: upload.createdAt,
    downloadUrl: createPresignedDownloadUrl(upload.objectKey, { filename: upload.originalName }),
    expiresIn: 900,
  });
});

app.get("/api/uploads", async (c) => {
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const uploads = await (await getCollection("uploads"))
    .find({ ownerId: new ObjectId(auth.user.id) })
    .sort({ createdAt: -1 })
    .limit(30)
    .project({ ownerId: 0 })
    .toArray();
  return c.json({ uploads: uploads.map((item) => ({ ...item, id: item._id.toString(), _id: undefined })) });
});

app.post("/api/feedback", async (c) => {
  const auth = await authenticate(c, { required: false });
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const rate = await enforceRateLimit(`feedback:${auth?.user?.id || ipKey}`, { limit: 8, windowMs: 60 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "反馈过于频繁，请稍后重试" }, 429);
  const body = await c.req.json();
  const message = String(body.message || "").trim();
  const screenshots = Array.isArray(body.screenshots) ? body.screenshots.slice(0, 9) : [];
  if (message.length < 5 || message.length > 5_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "反馈内容需为 5–5000 个字符" }, 400);
  }
  const result = await (await getCollection("feedback")).insertOne({
    ownerId: auth?.user?.id ? new ObjectId(auth.user.id) : null,
    message,
    screenshots,
    status: "open",
    createdAt: new Date(),
    ipFingerprint: ipKey,
  });
  return c.json({ id: result.insertedId.toString(), status: "open" }, 201);
});

app.get("/api/admin/feedback", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  c.header("Cache-Control", "private, no-store, max-age=0");
  const page = Math.max(1, Math.min(5000, Number.parseInt(c.req.query("page") || "1", 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(c.req.query("limit") || "30", 10) || 30));
  const query = String(c.req.query("q") || "").trim().slice(0, 160);
  const filter = {};

  if (query) {
    const keyword = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = { $regex: keyword, $options: "i" };
    const users = await getCollection("users");
    const matchingUsers = await users.find({
      $or: ["displayName", "username", "email", "emailNormalized"].map((field) => ({ [field]: regex })),
    }, { projection: { _id: 1 } }).limit(1000).toArray();
    const statusLabels = { open: "待处理", processing: "处理中", resolved: "已回复", closed: "已关闭" };
    const matchingStatuses = Object.entries(statusLabels)
      .filter(([status, label]) => status.includes(query.toLowerCase()) || label.includes(query) || query.includes(label))
      .map(([status]) => status);
    filter.$or = [
      { message: regex },
      { status: regex },
      ...(matchingUsers.length ? [{ ownerId: { $in: matchingUsers.map((user) => user._id) } }] : []),
      ...(matchingStatuses.length ? [{ status: { $in: matchingStatuses } }] : []),
      ...(ObjectId.isValid(query) ? [{ _id: new ObjectId(query) }] : []),
    ];
  }

  const feedback = await getCollection("feedback");
  const [items, total] = await Promise.all([
    feedback.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    feedback.countDocuments(filter),
  ]);
  const ownerIds = [...new Set(items.map((item) => item.ownerId?.toString()).filter((id) => ObjectId.isValid(id)))].map((id) => new ObjectId(id));
  const owners = ownerIds.length ? await (await getCollection("users")).find(
    { _id: { $in: ownerIds } },
    { projection: { displayName: 1, username: 1, email: 1, avatar: 1 } },
  ).toArray() : [];
  const ownerMap = new Map(owners.map((owner) => [owner._id.toString(), owner]));

  return c.json({
    items: items.map((item) => {
      const owner = ownerMap.get(item.ownerId?.toString());
      return {
        id: item._id.toString(),
        message: item.message,
        status: item.status || "open",
        screenshots: (Array.isArray(item.screenshots) ? item.screenshots : []).map(parseHttpUrl).filter(Boolean),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt || null,
        owner: owner ? {
          id: owner._id.toString(),
          displayName: owner.displayName || null,
          username: owner.username || null,
          email: owner.email || null,
          avatar: parseHttpUrl(owner.avatar),
        } : null,
      };
    }),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

app.openapi(workerSearchAssigneesRoute, async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const query = c.req.valid("query").q.trim();
  const rate = await enforceRateLimit(`worker-assignees:${auth.user.id}`, { limit: 60, windowMs: 60 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "搜索过于频繁，请稍后再试" }, 429);
  const keyword = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownerId = new ObjectId(auth.user.id);
  const users = await (await getCollection("users")).find({
    _id: { $ne: ownerId },
    status: { $nin: ["disabled", "deleted"] },
    $or: ["displayName", "username", "email", "emailNormalized"].map((field) => ({ [field]: { $regex: keyword, $options: "i" } })),
  }, { projection: { displayName: 1, username: 1, email: 1, avatar: 1, role: 1 } }).sort({ displayName: 1, createdAt: -1 }).limit(20).toArray();
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ users: users.map((user) => ({
    id: user._id.toString(),
    displayName: user.displayName || user.username || user.email || "古龙用户",
    email: user.email || null,
    avatar: user.avatar || null,
    role: user.role || "user",
  })) });
});

app.openapi(workerCreateTaskRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const publisher = await (await getCollection("users")).findOne({ _id: new ObjectId(auth.user.id) }, { projection: { wechatId: 1 } });
  if (!publisher?.wechatId) return c.json({ code: "WECHAT_REQUIRED", message: "发布需求前请先在个人资料中填写微信号" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const inputDescription = String(body.inputDescription || "").trim();
  const outputDescription = String(body.outputDescription || "").trim();
  const exampleDescription = String(body.exampleDescription || "").trim();
  const deadline = new Date(body.deadline);
  const budgetFen = Math.round(Number(body.budgetFen));
  const assignment = workerAssignmentInput(body);
  if (inputDescription.length < 10 || inputDescription.length > 10_000 || outputDescription.length < 10 || outputDescription.length > 10_000 || exampleDescription.length > 5_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "任务说明和预期结果至少 10 字，单项最多 10,000 字" }, 400);
  }
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() < Date.now() + 60 * 60_000 || deadline.getTime() > Date.now() + 366 * 86400_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "截止时间需在 1 小时至 1 年以内" }, 400);
  }
  if (!Number.isSafeInteger(budgetFen) || budgetFen < 100 || budgetFen > 5_000_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "任务预算需在 ¥1–¥50,000 之间" }, 400);
  }
  if (!assignment) return c.json({ code: "INVALID_ASSIGNMENT", message: "请选择公开接单、指定用户或平台团队" }, 400);
  let designatedAssignee = null;
  if (assignment.type === "user") {
    if (!ObjectId.isValid(assignment.assigneeUserId) || assignment.assigneeUserId === auth.user.id) {
      return c.json({ code: "INVALID_ASSIGNEE", message: "指定接单用户无效，且不能指定自己接单" }, 400);
    }
    designatedAssignee = await (await getCollection("users")).findOne({
      _id: new ObjectId(assignment.assigneeUserId),
      status: { $nin: ["disabled", "deleted"] },
    }, { projection: { _id: 1 } });
    if (!designatedAssignee) return c.json({ code: "ASSIGNEE_NOT_FOUND", message: "指定用户不存在或当前不可接单" }, 400);
  }
  const now = new Date();
  const financials = workerTaskFinancials(budgetFen);
  const result = await (await getCollection("workerTasks")).insertOne({
    publisherId: new ObjectId(auth.user.id),
    title: workerTaskTitle(inputDescription),
    inputDescription,
    outputDescription,
    exampleDescription,
    deadline,
    ...financials,
    assignmentType: assignment.type,
    designatedAssigneeId: designatedAssignee?._id || null,
    status: "awaiting_payment",
    paymentStatus: "awaiting_payment",
    progress: 0,
    workflowFingerprint: workerTaskFingerprint(inputDescription, outputDescription, exampleDescription),
    createdAt: now,
    updatedAt: now,
  });
  const task = await (await getCollection("workerTasks")).findOne({ _id: result.insertedId });
  return c.json({ task: await workerTaskDetails(task) }, 201);
});

app.openapi(workerListTasksRoute, async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const ownerId = new ObjectId(auth.user.id);
  const view = ["market", "published", "claimed"].includes(c.req.query("view")) ? c.req.query("view") : "market";
  const assignmentVisibility = [
    { assignmentType: { $exists: false } },
    { assignmentType: "open" },
    { assignmentType: "user", designatedAssigneeId: ownerId },
    ...(auth.user.role === "admin" ? [{ assignmentType: "platform_team" }] : []),
  ];
  const filter = view === "published"
    ? { publisherId: ownerId }
    : view === "claimed"
      ? { contractorId: ownerId }
      : { status: { $in: ["open", "in_progress", "submitted", "accepted"] }, $or: assignmentVisibility };
  const tasks = await (await getCollection("workerTasks")).find(filter).sort({ status: 1, createdAt: -1 }).limit(100).toArray();
  const items = await Promise.all(tasks.map(workerTaskDetails));
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ tasks: items, view });
});

app.get("/api/worker/tasks/:id", async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const task = await (await getCollection("workerTasks")).findOne({ _id: new ObjectId(c.req.param("id")) });
  if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const ownerId = new ObjectId(auth.user.id);
  const isRelated = task.publisherId.equals(ownerId) || task.contractorId?.equals?.(ownerId) || auth.user.role === "admin";
  const assignmentVisible = canClaimWorkerTask(task, { id: auth.user.id, role: auth.user.role });
  if (!isRelated && (!assignmentVisible || !["open", "in_progress", "submitted", "accepted"].includes(task.status))) return c.json({ code: "FORBIDDEN", message: "该任务未向当前账号开放" }, 403);
  return c.json({ task: await workerTaskDetails(task) });
});

app.delete("/api/worker/tasks/:id/draft", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const taskId = new ObjectId(c.req.param("id"));
  const ownerId = new ObjectId(auth.user.id);
  const tasks = await getCollection("workerTasks");
  const task = await tasks.findOne({ _id: taskId, publisherId: ownerId, status: "awaiting_payment" });
  if (!task) return c.json({ code: "TASK_STATE_CHANGED", message: "只有尚未提交付款的任务可以撤销" }, 409);
  const uploads = await getCollection("workerTaskUploads");
  const assets = await uploads.find({ taskId, ownerId }).toArray();
  await Promise.allSettled(assets.map((asset) => deleteObject(asset.objectKey)));
  await Promise.all([uploads.deleteMany({ taskId, ownerId }), tasks.deleteOne({ _id: taskId, publisherId: ownerId, status: "awaiting_payment" })]);
  return c.json({ ok: true });
});

app.post("/api/worker/tasks/:id/assets/presign", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const input = workerAssetInput(body);
  const filename = sanitizeFilename(body.filename, "attachment.bin");
  if (!input) return c.json({ code: "VALIDATION_ERROR", message: "附件类型不支持、为空或超过 200 MB" }, 400);
  const ownerId = new ObjectId(auth.user.id);
  const taskId = new ObjectId(c.req.param("id"));
  const task = await (await getCollection("workerTasks")).findOne({ _id: taskId });
  if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const mayUploadBrief = task.publisherId.equals(ownerId) && ["awaiting_payment", "payment_rejected"].includes(task.status) && ["input", "output"].includes(input.section);
  const mayUploadDelivery = task.contractorId?.equals?.(ownerId) && task.status === "in_progress" && input.section === "delivery";
  if (!mayUploadBrief && !mayUploadDelivery) return c.json({ code: "FORBIDDEN", message: "当前任务状态不允许上传该附件" }, 403);
  const uploads = await getCollection("workerTaskUploads");
  const count = await uploads.countDocuments({ taskId, section: input.section, status: { $in: ["uploading", "ready"] } });
  if (count >= WORKER_MAX_ASSETS_PER_SECTION) return c.json({ code: "ASSET_LIMIT", message: "每个区域最多上传 10 个附件" }, 409);
  await ensureBrowserUploadCors();
  const uploadId = new ObjectId();
  const objectKey = `worker/tasks/${taskId}/${input.section}/${uploadId}-${filename}`;
  const now = new Date();
  await uploads.insertOne({ _id: uploadId, taskId, ownerId, objectKey, filename, ...input, status: "uploading", createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000) });
  const requiredHeaders = { "Content-Type": input.contentType };
  return c.json({ uploadId: uploadId.toString(), uploadUrl: createPresignedPutUrl(objectKey, { expires: 60 * 60, headers: requiredHeaders }), objectKey, requiredHeaders, expiresIn: 3600 }, 201);
});

app.post("/api/worker/tasks/:id/assets/:uploadId/complete", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id")) || !ObjectId.isValid(c.req.param("uploadId"))) return c.json({ code: "UPLOAD_NOT_FOUND", message: "附件上传记录不存在" }, 404);
  const uploads = await getCollection("workerTaskUploads");
  const upload = await uploads.findOne({ _id: new ObjectId(c.req.param("uploadId")), taskId: new ObjectId(c.req.param("id")), ownerId: new ObjectId(auth.user.id), status: "uploading", expiresAt: { $gt: new Date() } });
  if (!upload) return c.json({ code: "UPLOAD_NOT_FOUND", message: "附件上传记录不存在或已失效" }, 404);
  const head = await headObject(upload.objectKey);
  if (objectSize(head) !== upload.bytes) {
    await deleteObject(upload.objectKey).catch(() => {});
    await uploads.updateOne({ _id: upload._id }, { $set: { status: "failed", error: "COS_OBJECT_MISMATCH", updatedAt: new Date() } });
    return c.json({ code: "UPLOAD_MISMATCH", message: "附件文件大小校验失败，请重新上传" }, 409);
  }
  const now = new Date();
  await uploads.updateOne({ _id: upload._id, status: "uploading" }, { $set: { status: "ready", completedAt: now, updatedAt: now }, $unset: { expiresAt: "" } });
  return c.json({ asset: workerAssetJson({ ...upload, status: "ready" }) });
});

app.get("/api/worker/tasks/:id/assets/:assetId/download", async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id")) || !ObjectId.isValid(c.req.param("assetId"))) return c.json({ code: "ASSET_NOT_FOUND", message: "附件不存在" }, 404);
  const taskId = new ObjectId(c.req.param("id"));
  const [task, asset] = await Promise.all([
    (await getCollection("workerTasks")).findOne({ _id: taskId }),
    (await getCollection("workerTaskUploads")).findOne({ _id: new ObjectId(c.req.param("assetId")), taskId, status: "ready" }),
  ]);
  if (!task || !asset) return c.json({ code: "ASSET_NOT_FOUND", message: "附件不存在" }, 404);
  const ownerId = new ObjectId(auth.user.id);
  const related = task.publisherId.equals(ownerId) || task.contractorId?.equals?.(ownerId) || auth.user.role === "admin";
  const marketplaceBrief = canClaimWorkerTask(task, { id: auth.user.id, role: auth.user.role })
    && ["input", "output"].includes(asset.section)
    && ["open", "in_progress", "submitted", "accepted"].includes(task.status);
  if (!related && !marketplaceBrief) return c.json({ code: "FORBIDDEN", message: "你没有权限下载该附件" }, 403);
  return c.redirect(createPresignedDownloadUrl(asset.objectKey, { filename: asset.filename }), 302);
});

app.openapi(workerSubmitPaymentRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const taskId = new ObjectId(c.req.param("id"));
  const ownerId = new ObjectId(auth.user.id);
  const now = new Date();
  const paymentOrderNo = `WK${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
  const task = await (await getCollection("workerTasks")).findOneAndUpdate(
    { _id: taskId, publisherId: ownerId, status: { $in: ["awaiting_payment", "payment_rejected"] } },
    { $set: { status: "pending_payment_review", paymentStatus: "pending", paymentOrderNo, paymentSubmittedAt: now, updatedAt: now }, $unset: { paymentReviewReason: "", paymentReviewedAt: "", paymentReviewedBy: "" }, $inc: { paymentSubmissionCount: 1 } },
    { returnDocument: "after" },
  );
  if (!task) return c.json({ code: "TASK_STATE_CHANGED", message: "任务不存在、付款已提交或不属于当前账号" }, 409);
  return c.json({ task: await workerTaskDetails(task), orderNo: paymentOrderNo, status: "pending_payment_review" });
});

app.get("/api/worker/tasks/:id/contact", async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const task = await (await getCollection("workerTasks")).findOne({ _id: new ObjectId(c.req.param("id")) });
  if (!task?.contractorId) return c.json({ code: "CONTACT_NOT_READY", message: "任务尚未被接单，暂时没有可查看的联系人" }, 409);
  const requesterId = new ObjectId(auth.user.id);
  const isPublisher = task.publisherId.equals(requesterId);
  const isContractor = task.contractorId.equals(requesterId);
  if (!isPublisher && !isContractor) return c.json({ code: "FORBIDDEN", message: "只有任务双方可以申请查看联系方式" }, 403);
  const targetId = isPublisher ? task.contractorId : task.publisherId;
  const administratorBypass = canBypassWorkerContactPayment({ role: auth.user.role, isContractor });
  const order = administratorBypass
    ? null
    : await (await getCollection("workerContactPayments")).findOne({ taskId: task._id, requesterId, targetId }, { sort: { createdAt: -1 } });
  const target = administratorBypass || order?.status === "approved"
    ? await (await getCollection("users")).findOne({ _id: targetId }, { projection: { wechatId: 1, displayName: 1, username: 1 } })
    : null;
  if (administratorBypass) {
    await (await getCollection("workerContactAccessAudits")).insertOne({
      taskId: task._id,
      requesterId,
      targetId,
      accessType: "administrator_contractor_bypass",
      createdAt: new Date(),
    });
  }
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({
    status: administratorBypass ? "admin_access" : order?.status || "not_requested",
    paymentRequired: !administratorBypass,
    order: order ? { id: order._id.toString(), orderNo: order.orderNo, amountFen: order.amountFen, status: order.status, reviewReason: order.reviewReason || null, createdAt: order.createdAt } : null,
    contact: target?.wechatId ? { displayName: target.displayName || target.username || "任务联系人", wechatId: target.wechatId } : null,
  });
});

app.post("/api/worker/tasks/:id/contact-orders", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const task = await (await getCollection("workerTasks")).findOne({ _id: new ObjectId(c.req.param("id")) });
  if (!task?.contractorId) return c.json({ code: "CONTACT_NOT_READY", message: "任务尚未被接单，暂时不能申请联系方式" }, 409);
  const requesterId = new ObjectId(auth.user.id);
  const isPublisher = task.publisherId.equals(requesterId);
  const isContractor = task.contractorId.equals(requesterId);
  if (!isPublisher && !isContractor) return c.json({ code: "FORBIDDEN", message: "只有任务双方可以申请查看联系方式" }, 403);
  const targetId = isPublisher ? task.contractorId : task.publisherId;
  if (canBypassWorkerContactPayment({ role: auth.user.role, isContractor })) {
    const target = await (await getCollection("users")).findOne({ _id: targetId }, { projection: { wechatId: 1, displayName: 1, username: 1 } });
    await (await getCollection("workerContactAccessAudits")).insertOne({
      taskId: task._id,
      requesterId,
      targetId,
      accessType: "administrator_contractor_bypass",
      legacyContactOrderRequest: true,
      createdAt: new Date(),
    });
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      status: "admin_access",
      paymentRequired: false,
      order: null,
      contact: target?.wechatId ? { displayName: target.displayName || target.username || "发单人", wechatId: target.wechatId } : null,
    });
  }
  const contacts = await getCollection("workerContactPayments");
  let order = await contacts.findOne({ taskId: task._id, requesterId, targetId }, { sort: { createdAt: -1 } });
  if (!order) {
    const now = new Date();
    const result = await contacts.insertOne({ taskId: task._id, requesterId, targetId, requesterRole: isPublisher ? "publisher" : "contractor", orderNo: `WC${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`, amountFen: 200, status: "awaiting_payment", createdAt: now, updatedAt: now });
    order = await contacts.findOne({ _id: result.insertedId });
  }
  return c.json({ order: { id: order._id.toString(), orderNo: order.orderNo, amountFen: 200, status: order.status, reviewReason: order.reviewReason || null } }, order.status === "awaiting_payment" ? 201 : 200);
});

app.post("/api/worker/contact-orders/:id/payment-submit", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "联系方式订单不存在" }, 404);
  const now = new Date();
  const order = await (await getCollection("workerContactPayments")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), requesterId: new ObjectId(auth.user.id), status: { $in: ["awaiting_payment", "rejected"] } },
    { $set: { status: "pending", submittedAt: now, updatedAt: now }, $unset: { reviewReason: "", reviewedAt: "", reviewedBy: "" }, $inc: { submissionCount: 1 } },
    { returnDocument: "after" },
  );
  if (!order) return c.json({ code: "ORDER_STATE_CHANGED", message: "订单已提交、已审核或不属于当前账号" }, 409);
  return c.json({ order: { id: order._id.toString(), orderNo: order.orderNo, amountFen: order.amountFen, status: order.status } });
});

app.openapi(workerClaimTaskRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const contractorId = new ObjectId(auth.user.id);
  const contractor = await (await getCollection("users")).findOne({ _id: contractorId }, { projection: { wechatId: 1 } });
  if (!contractor?.wechatId) return c.json({ code: "WECHAT_REQUIRED", message: "接单前请先在个人资料中填写微信号" }, 409);
  const tasks = await getCollection("workerTasks");
  const candidate = await tasks.findOne({ _id: new ObjectId(c.req.param("id")), status: "open", publisherId: { $ne: contractorId }, contractorId: { $exists: false } });
  if (!candidate) return c.json({ code: "TASK_ALREADY_CLAIMED", message: "任务已被接单、状态已变化，或不能承接自己发布的任务" }, 409);
  if (!canClaimWorkerTask(candidate, { id: auth.user.id, role: auth.user.role })) {
    const message = candidate.assignmentType === "platform_team" ? "该任务指定由平台团队处理，只有管理员可以接单" : "该任务已指定其他用户接单";
    return c.json({ code: "ASSIGNMENT_FORBIDDEN", message }, 403);
  }
  const now = new Date();
  const task = await tasks.findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), status: "open", publisherId: { $ne: contractorId }, contractorId: { $exists: false } },
    { $set: { status: "in_progress", contractorId, claimedAt: now, progress: 5, progressNote: "已接单，正在梳理任务与交付计划。", updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!task) return c.json({ code: "TASK_ALREADY_CLAIMED", message: "任务已被接单、状态已变化，或不能承接自己发布的任务" }, 409);
  await notifyUser(task.publisherId, "worker_task_claimed", "你的威客任务已被接单", `“${task.title}”已进入处理中，接单者会持续更新进度。`, { taskId: task._id });
  return c.json({ task: await workerTaskDetails(task) });
});

app.openapi(workerUpdateProgressRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const progress = Math.trunc(Number(body.progress));
  const progressNote = String(body.note || "").trim();
  if (!Number.isInteger(progress) || progress < 5 || progress > 99 || progressNote.length < 2 || progressNote.length > 1000) return c.json({ code: "VALIDATION_ERROR", message: "进度需为 5–99，进度说明需为 2–1000 字" }, 400);
  const now = new Date();
  const task = await (await getCollection("workerTasks")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), contractorId: new ObjectId(auth.user.id), status: "in_progress" },
    { $set: { progress, progressNote, progressUpdatedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!task) return c.json({ code: "FORBIDDEN", message: "只有当前接单者可更新处理中的任务进度" }, 403);
  await notifyUser(task.publisherId, "worker_task_progress", "威客任务进度已更新", `“${task.title}”当前进度 ${progress}%：${progressNote}`, { taskId: task._id });
  return c.json({ task: await workerTaskDetails(task) });
});

app.openapi(workerSubmitTaskRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const deliveryNote = String(body.deliveryNote || "").trim();
  if (deliveryNote.length < 10 || deliveryNote.length > 10_000) return c.json({ code: "VALIDATION_ERROR", message: "交付说明需为 10–10,000 字" }, 400);
  const now = new Date();
  const task = await (await getCollection("workerTasks")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), contractorId: new ObjectId(auth.user.id), status: "in_progress" },
    { $set: { status: "submitted", progress: 100, progressNote: "任务已完成并提交验收。", deliveryNote, submittedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!task) return c.json({ code: "FORBIDDEN", message: "只有当前接单者可提交处理中的任务" }, 403);
  await notifyUser(task.publisherId, "worker_task_submitted", "威客任务等待你的验收", `“${task.title}”已完成交付，请检查结果与附件后确认验收。`, { taskId: task._id });
  return c.json({ task: await workerTaskDetails(task) });
});

app.openapi(workerAcceptTaskRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const now = new Date();
  const tasks = await getCollection("workerTasks");
  const taskId = new ObjectId(c.req.param("id"));
  const publisherId = new ObjectId(auth.user.id);
  let task = await tasks.findOne({ _id: taskId, publisherId, status: { $in: ["submitted", "accepted"] }, contractorId: { $exists: true } });
  if (!task) return c.json({ code: "TASK_STATE_CHANGED", message: "只有发布者可验收已提交的任务" }, 409);
  if (task.status === "submitted") {
    task = await tasks.findOneAndUpdate(
      { _id: taskId, publisherId, status: "submitted", contractorId: task.contractorId },
      { $set: { status: "accepted", acceptedAt: now, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!task) task = await tasks.findOne({ _id: taskId, publisherId, status: "accepted" });
  }
  if (!task) return c.json({ code: "TASK_STATE_CHANGED", message: "任务状态已变化，请刷新后查看" }, 409);
  const financials = workerTaskFinancials(task.budgetFen);
  const workflows = await getCollection("workerWorkflows");
  let workflow = task.workflowId ? await workflows.findOne({ _id: task.workflowId }) : null;
  if (!workflow) workflow = await workflows.findOneAndUpdate(
    { fingerprint: task.workflowFingerprint },
    {
      $set: { updatedAt: now, revenueRule: workerWorkflowRevenue({ grossFen: 0 }).rule },
      $setOnInsert: { sourceTaskId: task._id, publisherId: task.publisherId, contractorId: task.contractorId, name: task.title, status: "ready", reuseCount: 0, createdAt: now },
      $addToSet: { acceptedTaskIds: task._id },
    },
    { upsert: true, returnDocument: "after" },
  );
  await tasks.updateOne({ _id: task._id }, { $set: { workflowId: workflow._id, workflowRevenueRule: workflow.revenueRule, updatedAt: now } });
  const earnings = await getCollection("workerEarnings");
  const earning = await earnings.updateOne(
    { taskId: task._id, kind: "task_acceptance" },
    { $setOnInsert: { ownerId: task.contractorId, publisherId: task.publisherId, amountFen: financials.contractorIncomeFen, platformAmountFen: financials.platformServiceFeeFen, status: "available", createdAt: now, availableAt: now } },
    { upsert: true },
  );
  if (earning.upsertedCount) {
    await (await getCollection("wallets")).updateOne(
      { ownerId: task.contractorId },
      { $inc: { balanceFen: financials.contractorIncomeFen }, $set: { updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }
  await Promise.all([
    notifyUserOnce(task.contractorId, "worker_task_accepted", "任务已验收，收入已到账", `“${task.title}”已通过验收，${(financials.contractorIncomeFen / 100).toFixed(2)} 元已计入账户余额。`, { taskId: task._id, amountFen: financials.contractorIncomeFen }),
    notifyUserOnce(task.publisherId, "worker_task_accepted", "威客任务已完成", `“${task.title}”已完成结算，并沉淀为可复用工作流。`, { taskId: task._id, workflowId: workflow._id }),
  ]);
  const accepted = await tasks.findOne({ _id: task._id });
  return c.json({ task: await workerTaskDetails(accepted), settlement: financials, workflow: { id: workflow._id.toString(), revenueRule: workflow.revenueRule } });
});

app.get("/api/admin/worker-payments", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const requested = c.req.query("status");
  const filter = requested === "reviewed" ? { paymentStatus: { $in: ["approved", "rejected"] } } : { paymentStatus: "pending" };
  const tasks = await getCollection("workerTasks");
  const [items, pending, approved, rejectedCount] = await Promise.all([
    tasks.find(filter).sort(requested === "reviewed" ? { paymentReviewedAt: -1 } : { paymentSubmittedAt: 1 }).limit(100).toArray(),
    tasks.countDocuments({ paymentStatus: "pending" }),
    tasks.countDocuments({ paymentStatus: "approved" }),
    tasks.countDocuments({ paymentStatus: "rejected" }),
  ]);
  return c.json({ tasks: await Promise.all(items.map(workerTaskDetails)), summary: { pending, reviewed: approved + rejectedCount, approved, rejected: rejectedCount } });
});

app.post("/api/admin/worker-payments/:id/approve", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const now = new Date();
  const task = await (await getCollection("workerTasks")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), status: "pending_payment_review", paymentStatus: "pending" },
    { $set: { status: "open", paymentStatus: "approved", paymentReviewedAt: now, paymentReviewedBy: new ObjectId(auth.user.id), escrowStatus: "locked", updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!task) return c.json({ code: "TASK_STATE_CHANGED", message: "该任务付款已处理或状态已变化" }, 409);
  const assignmentType = task.assignmentType || "open";
  const publisherMessage = assignmentType === "platform_team"
    ? `“${task.title}”已进入平台团队任务池，管理员现在可以接单处理。`
    : assignmentType === "user"
      ? `“${task.title}”已通知你指定的用户接单。`
      : `“${task.title}”已进入接单大厅，任何用户现在都可以接单。`;
  const assignmentNotifications = [];
  if (assignmentType === "user" && task.designatedAssigneeId) {
    assignmentNotifications.push(notifyUser(task.designatedAssigneeId, "worker_task_designated", "你收到一项指定威客任务", `“${task.title}”已通过付款审核，发单人指定由你接单处理。`, { taskId: task._id }));
  }
  if (assignmentType === "platform_team") {
    const administrators = await (await getCollection("users")).find({ role: "admin", status: { $nin: ["disabled", "deleted"] } }, { projection: { _id: 1 } }).toArray();
    assignmentNotifications.push(...administrators.map((administrator) => notifyUserOnce(administrator._id, "worker_platform_task_ready", "平台团队收到新任务", `“${task.title}”已通过付款审核，请管理员统一接单处理。`, { taskId: task._id })));
  }
  await Promise.all([
    notifyUser(task.publisherId, "worker_payment_approved", "威客任务付款审核已通过", publisherMessage, { taskId: task._id, orderNo: task.paymentOrderNo }),
    ...assignmentNotifications,
  ]);
  return c.json({ task: await workerTaskDetails(task) });
});

app.post("/api/admin/worker-payments/:id/reject", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason || "").trim();
  if (reason.length < 2 || reason.length > 500) return c.json({ code: "VALIDATION_ERROR", message: "请填写 2–500 字的拒绝原因" }, 400);
  const now = new Date();
  const task = await (await getCollection("workerTasks")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), status: "pending_payment_review", paymentStatus: "pending" },
    { $set: { status: "payment_rejected", paymentStatus: "rejected", paymentReviewReason: reason, paymentReviewedAt: now, paymentReviewedBy: new ObjectId(auth.user.id), updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!task) return c.json({ code: "TASK_STATE_CHANGED", message: "该任务付款已处理或状态已变化" }, 409);
  await notifyUser(task.publisherId, "worker_payment_rejected", "威客任务付款审核未通过", `“${task.title}”暂未通过付款审核，请调整后重新提交。`, { taskId: task._id, orderNo: task.paymentOrderNo, reason });
  return c.json({ task: await workerTaskDetails(task) });
});

app.get("/api/admin/worker-contact-payments", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const requested = c.req.query("status");
  const filter = requested === "reviewed" ? { status: { $in: ["approved", "rejected"] } } : { status: "pending" };
  const contacts = await getCollection("workerContactPayments");
  const [orders, pending, approved, rejectedCount] = await Promise.all([
    contacts.find(filter).sort(requested === "reviewed" ? { reviewedAt: -1 } : { submittedAt: 1 }).limit(100).toArray(),
    contacts.countDocuments({ status: "pending" }),
    contacts.countDocuments({ status: "approved" }),
    contacts.countDocuments({ status: "rejected" }),
  ]);
  const taskIds = orders.map((order) => order.taskId);
  const userIds = orders.flatMap((order) => [order.requesterId, order.targetId]);
  const [tasks, users] = await Promise.all([
    taskIds.length ? (await getCollection("workerTasks")).find({ _id: { $in: taskIds } }, { projection: { title: 1 } }).toArray() : [],
    userIds.length ? (await getCollection("users")).find({ _id: { $in: userIds } }, { projection: { displayName: 1, username: 1, email: 1 } }).toArray() : [],
  ]);
  const taskMap = new Map(tasks.map((task) => [task._id.toString(), task]));
  const userMap = new Map(users.map((user) => [user._id.toString(), user]));
  return c.json({
    orders: orders.map((order) => ({
      id: order._id.toString(), orderNo: order.orderNo, amountFen: order.amountFen, status: order.status, requesterRole: order.requesterRole,
      taskId: order.taskId.toString(), taskTitle: taskMap.get(order.taskId.toString())?.title || "威客任务",
      requester: workerPerson(userMap.get(order.requesterId.toString())), target: workerPerson(userMap.get(order.targetId.toString())),
      reviewReason: order.reviewReason || null, createdAt: order.createdAt, submittedAt: order.submittedAt || null,
    })),
    summary: { pending, reviewed: approved + rejectedCount, approved, rejected: rejectedCount },
  });
});

app.post("/api/admin/worker-contact-payments/:id/approve", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "联系方式订单不存在" }, 404);
  const now = new Date();
  const order = await (await getCollection("workerContactPayments")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), status: "pending" },
    { $set: { status: "approved", reviewedAt: now, reviewedBy: new ObjectId(auth.user.id), updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!order) return c.json({ code: "ORDER_STATE_CHANGED", message: "订单已审核或状态已变化" }, 409);
  await notifyUser(order.requesterId, "worker_contact_approved", "任务联系人已解锁", "2 元线下支付已审核通过，现在可以在威客管理中查看对方微信号。", { taskId: order.taskId, orderNo: order.orderNo });
  return c.json({ ok: true, status: "approved" });
});

app.post("/api/admin/worker-contact-payments/:id/reject", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "联系方式订单不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason || "").trim();
  if (reason.length < 2 || reason.length > 500) return c.json({ code: "VALIDATION_ERROR", message: "请填写 2–500 字的拒绝原因" }, 400);
  const now = new Date();
  const order = await (await getCollection("workerContactPayments")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")), status: "pending" },
    { $set: { status: "rejected", reviewReason: reason, reviewedAt: now, reviewedBy: new ObjectId(auth.user.id), updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!order) return c.json({ code: "ORDER_STATE_CHANGED", message: "订单已审核或状态已变化" }, 409);
  await notifyUser(order.requesterId, "worker_contact_rejected", "联系方式支付审核未通过", "请查看原因并调整后重新提交。", { taskId: order.taskId, orderNo: order.orderNo, reason });
  return c.json({ ok: true, status: "rejected", reason });
});

app.post("/api/admin/worker-workflows/:id/revenue", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const reference = String(body.reference || "").trim();
  if (reference.length < 3 || reference.length > 120) return c.json({ code: "VALIDATION_ERROR", message: "请输入 3–120 字的复用收入业务编号" }, 400);
  const revenue = workerWorkflowRevenue(body);
  if (revenue.grossFen < 1) return c.json({ code: "VALIDATION_ERROR", message: "复用收入必须大于 0" }, 400);
  const workflow = await (await getCollection("workerWorkflows")).findOne({ _id: new ObjectId(c.req.param("id")), status: "ready" });
  if (!workflow) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" }, 404);
  const now = new Date();
  const ledger = await (await getCollection("workerWorkflowRevenueLedger")).updateOne(
    { workflowId: workflow._id, reference },
    { $setOnInsert: { ...revenue, publisherId: workflow.publisherId, contractorId: workflow.contractorId, status: "settled", reviewedBy: new ObjectId(auth.user.id), createdAt: now } },
    { upsert: true },
  );
  if (!ledger.upsertedCount) return c.json({ code: "REVENUE_ALREADY_RECORDED", message: "该业务编号的分佣已经结算" }, 409);
  await Promise.all([
    (await getCollection("wallets")).updateOne({ ownerId: workflow.publisherId }, { $inc: { balanceFen: revenue.publisherShareFen }, $set: { updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true }),
    (await getCollection("wallets")).updateOne({ ownerId: workflow.contractorId }, { $inc: { balanceFen: revenue.contractorShareFen }, $set: { updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true }),
    (await getCollection("workerWorkflows")).updateOne({ _id: workflow._id }, { $inc: { reuseCount: 1, totalNetProfitFen: revenue.netProfitFen }, $set: { updatedAt: now } }),
    notifyUser(workflow.publisherId, "worker_workflow_revenue", "工作流复用分佣已到账", `${(revenue.publisherShareFen / 100).toFixed(2)} 元已计入账户余额。`, { workflowId: workflow._id, amountFen: revenue.publisherShareFen }),
    notifyUser(workflow.contractorId, "worker_workflow_revenue", "工作流复用分佣已到账", `${(revenue.contractorShareFen / 100).toFixed(2)} 元已计入账户余额。`, { workflowId: workflow._id, amountFen: revenue.contractorShareFen }),
  ]);
  return c.json({ ok: true, revenue });
});

app.get("/api/billing/plans", async (c) => {
  const pricing = await currentSubscriptionPricing();
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({
    plans: [
      { id: "free", name: "普通用户", monthlyFen: 0, yearlyFen: 0, autoRenew: false },
      { id: "member", name: "会员用户", monthlyFen: pricing.monthly.amountFen, yearlyFen: pricing.yearly.amountFen, autoRenew: true },
      { id: "custom", name: "深度定制", pricing: "结果式付费 · 利润五五分", autoRenew: false },
    ],
    providers: {
      mode: "coming_soon",
      alipay: false,
      wechat: false,
      offline: true,
      autoRenew: { alipay: false, wechat: false },
      availability: ONLINE_PAYMENT_AVAILABILITY,
    },
    pricingRevision: pricing.revision,
  });
});

app.post("/api/billing/orders", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json();
  const provider = ["wechat", "alipay", "offline"].includes(body.provider) ? body.provider : null;
  const cycle = body.cycle === "year" ? "year" : body.cycle === "month" ? "month" : null;
  const kind = body.kind === "recharge" ? "recharge" : "subscription";
  if (provider === "wechat" || provider === "alipay") {
    const channel = ONLINE_PAYMENT_AVAILABILITY.channels[provider];
    return c.json({
      code: "ONLINE_PAYMENT_COMING_SOON",
      message: provider === "alipay" ? channel.message : `${ONLINE_PAYMENT_AVAILABILITY.notice}${channel.message}`,
      paymentAvailability: ONLINE_PAYMENT_AVAILABILITY,
    }, 503);
  }
  const now = new Date();
  const pricing = kind === "subscription" ? await currentSubscriptionPricing(now) : null;
  let amountFen = kind === "recharge" ? Number(body.amountFen) : cycle === "year" ? pricing.yearly.amountFen : pricing.monthly.amountFen;
  if (!provider || !Number.isInteger(amountFen) || amountFen < 100 || amountFen > 5_000_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "支付方式、周期或金额不正确" }, 400);
  }
  if (!cycle && kind === "subscription") return c.json({ code: "VALIDATION_ERROR", message: "订阅周期不正确" }, 400);
  if (provider === "offline" && kind !== "subscription") return c.json({ code: "VALIDATION_ERROR", message: "线下支付仅用于会员订阅审核" }, 400);
  const orderNo = `GL${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
  const autoRenewRequested = kind === "subscription" && Boolean(body.autoRenew);
  const ownerId = new ObjectId(auth.user.id);
  const activeSubscription = kind === "subscription" && cycle === "year"
    ? await (await getCollection("subscriptions")).findOne({
      ownerId,
      cycle: "month",
      status: { $nin: ["cancelled", "canceled"] },
      currentPeriodStart: { $lte: now },
      currentPeriodEnd: { $gt: now },
    })
    : null;
  const isMonthlyUpgrade = Boolean(activeSubscription);
  const upgradeCreditFen = isMonthlyUpgrade ? pricing.monthly.amountFen : 0;
  const upgradeBaseStart = isMonthlyUpgrade
    ? new Date(activeSubscription.currentPeriodStart || now)
    : null;
  if (isMonthlyUpgrade) amountFen = Math.max(100, pricing.yearly.amountFen - upgradeCreditFen);
  const localPriceVersion = kind === "subscription" && !isMonthlyUpgrade
    ? await effectiveLocalPrice({ cycle, at: now })
    : null;
  if (localPriceVersion) amountFen = localPriceVersion.amountFen;
  const autoRenew = autoRenewRequested && !isMonthlyUpgrade;

  if (provider === "offline") {
    let plans = [];
    let offlineAccessToken = null;
    try {
      offlineAccessToken = await getChandlerAccessToken(auth.session);
      plans = await listPartnerSubscriptionPlans(offlineAccessToken);
    }
    catch { /* The website keeps accepting offline review orders while Chandler catalog access is unavailable. */ }
    const marker = cycle === "year" ? "year" : "month";
    const plan = plans.find((item) => `${item.skuType} ${item.billingInterval}`.toLowerCase().includes(marker)) || {
      productId: "gulong-member",
      productName: "古龙会员",
      skuId: cycle === "year" ? "gulong-member-year" : "gulong-member-month",
      skuName: cycle === "year" ? "年度订阅会员" : "月度订阅会员",
      skuType: cycle,
      billingInterval: cycle,
      amountFen,
      source: "website-fallback",
    };
    const partnerData = {
      schema_version: 2,
      application_key: "gulong-web",
      user_id: auth.user.id,
      chandler_user_id: readExternalAuth(auth.session)?.chandlerUserId,
      user_email: auth.user.email,
      product_id: plan.productId,
      product_name: plan.productName,
      sku_id: plan.skuId,
      sku_name: plan.skuName,
      plan_kind: cycle === "year" ? "yearly" : "monthly",
      amount_fen: amountFen,
      payment_method: "offline",
      platform_service_fee: false,
      review_status: "pending",
      business_payment_status: "awaiting_manual_review",
      submitted_at: now.toISOString(),
      ...(isMonthlyUpgrade ? { upgrade_from: "month", upgrade_credit_fen: upgradeCreditFen, upgrade_base_start: upgradeBaseStart.toISOString() } : {}),
      ...(localPriceVersion ? { price_source: "website-local", price_version_id: localPriceVersion._id.toString() } : {}),
    };
    let chandlerOrderNo = null;
    try {
      const mirrored = await createDirectPaymentOrder(offlineAccessToken || await getChandlerAccessToken(auth.session), {
        merchantOrderNo: orderNo,
        channel: "wechat",
        amountFen,
        ...(plan.priceId && !isMonthlyUpgrade ? { skuId: plan.skuId } : {}),
        subject: cycle === "year" ? "年度订阅会员（线下审核）" : "月度订阅会员（线下审核）",
        source: "gulong-web-offline-review",
        partnerData,
        prepay: false,
      });
      chandlerOrderNo = mirrored.orderNo;
    } catch { /* MongoDB remains the durable queue before payment onboarding is complete. */ }
    const result = await (await getCollection("offlinePayments")).insertOne({
      orderNo,
      chandlerOrderNo,
      ownerId,
      chandlerUserId: partnerData.chandler_user_id,
      userEmail: auth.user.email,
      cycle,
      amountFen,
      plan,
      partnerData,
      status: "pending",
      ...(isMonthlyUpgrade ? { upgradeFrom: "month", upgradeCreditFen, upgradeBaseStart } : {}),
      ...(localPriceVersion ? { localPriceVersionId: localPriceVersion._id } : {}),
      createdAt: now,
      updatedAt: now,
    });
    // The claim endpoint can backfill any pending order, so a transient queue
    // write must never turn a durably created payment order into a client-side
    // failure that the user may submit twice.
    await enqueueOfflineReviewEvent({ _id: result.insertedId, orderNo }, "new-order").catch(() => null);
    return c.json({ id: result.insertedId.toString(), orderNo, status: "pending_review", mode: "offline", amountFen, upgradeCreditFen }, 201);
  }

  const accessToken = await getChandlerAccessToken(auth.session);
  let result;
  if (kind === "subscription" && !isMonthlyUpgrade) {
    result = await createSubscriptionCheckout(accessToken, { cycle, channel: provider, merchantOrderNo: orderNo, expectedAmountFen: amountFen });
  } else if (kind === "subscription") {
    result = await createDirectPaymentOrder(accessToken, {
      merchantOrderNo: orderNo,
      channel: provider,
      amountFen,
      subject: isMonthlyUpgrade ? "月度会员升级年度会员" : cycle === "year" ? "古龙年度会员" : "古龙月度会员",
      source: "gulong-web-subscription-upgrade",
      partnerData: { schema_version: 2, kind: "subscription_upgrade", cycle: "year", upgrade_from: "month", upgrade_credit_fen: upgradeCreditFen, upgrade_base_start: upgradeBaseStart.toISOString(), amount_fen: amountFen },
    });
  } else {
    result = await createDirectPaymentOrder(accessToken, {
      merchantOrderNo: orderNo,
      channel: provider,
      amountFen,
      subject: "古龙账户充值",
      source: "gulong-web-topup",
      partnerData: { schema_version: 1, kind: "wallet_topup", amount_fen: amountFen },
    });
  }
  const chandlerAmountFen = Number(result.checkout?.amount ?? result.order?.amount);
  if (Number.isSafeInteger(chandlerAmountFen) && chandlerAmountFen >= 0) amountFen = chandlerAmountFen;
  const actualOrderNo = result.orderNo || orderNo;
  const prepay = result.prepay || result.payment || {};
  const paymentUrl = prepay.pay_url || prepay.h5_url || prepay.code_url;
  const qrCodeDataUrl = prepay.code_url ? await QRCode.toDataURL(prepay.code_url, { width: 280, margin: 1, color: { dark: "#0b3f3a", light: "#fffdfa" } }) : null;
  await (await getCollection("payments")).insertOne({
    orderNo: actualOrderNo,
    merchantOrderNo: orderNo,
    ownerId,
    provider,
    kind,
    cycle,
    amountFen,
    autoRenew,
    chandler: true,
    status: "pending",
    ...(isMonthlyUpgrade ? { upgradeFrom: "month", upgradeCreditFen, upgradeBaseStart } : {}),
    ...(localPriceVersion ? { localPriceVersionId: localPriceVersion._id } : {}),
    createdAt: now,
    updatedAt: now,
  });
  return c.json({
    orderNo: actualOrderNo,
    status: "pending",
    paymentUrl,
    qrCodeDataUrl,
    mode: "chandler",
    provider,
    amountFen,
    upgradeCreditFen,
    autoRenewRequested,
    autoRenewAvailable: !isMonthlyUpgrade,
    priceSource: kind === "subscription" && !isMonthlyUpgrade ? "chandler-partner-sku" : localPriceVersion ? "website-local" : "chandler",
  }, 201);
});

async function activatePayment(orderNo, providerTransactionId) {
  const payments = await getCollection("payments");
  const payment = await payments.findOneAndUpdate(
    { orderNo, status: "pending" },
    { $set: { status: "paid", providerTransactionId, paidAt: new Date(), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!payment) return;
  if (payment.kind === "subscription") {
    const existingSubscription = await (await getCollection("subscriptions")).findOne({ ownerId: payment.ownerId });
    const start = payment.upgradeFrom === "month"
      ? new Date(payment.upgradeBaseStart || existingSubscription?.currentPeriodStart || new Date())
      : new Date();
    const end = new Date(start);
    if (payment.cycle === "year") end.setFullYear(end.getFullYear() + 1);
    else end.setMonth(end.getMonth() + 1);
    await (await getCollection("subscriptions")).updateOne(
      { ownerId: payment.ownerId },
      {
        $set: {
          plan: "member",
          cycle: payment.cycle,
          provider: payment.provider,
          status: "active",
          currentPeriodStart: start,
          currentPeriodEnd: end,
          autoRenew: payment.autoRenew,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  } else {
    await (await getCollection("wallets")).updateOne(
      { ownerId: payment.ownerId },
      { $inc: { balanceFen: payment.amountFen }, $set: { updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  }
}

app.post("/api/billing/mock/complete", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  if (paymentCapabilities().mode !== "mock") {
    return c.json({ code: "NOT_AVAILABLE", message: "生产支付模式不能使用模拟确认" }, 404);
  }
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json();
  const orderNo = String(body.orderNo || "").trim();
  const tokenHash = hashOpaqueToken(String(body.token || ""), "mock-payment");
  const payment = await (await getCollection("payments")).findOne({
    orderNo,
    ownerId: new ObjectId(auth.user.id),
    status: "pending",
    mockTokenHash: tokenHash,
  });
  if (!payment) return c.json({ code: "ORDER_NOT_FOUND", message: "订单不存在、已完成或不属于当前账号" }, 404);
  await activatePayment(orderNo, `mock_${randomBytes(8).toString("hex")}`);
  return c.json({ ok: true, orderNo, status: "paid" });
});

app.post("/api/billing/webhooks/alipay", async (c) => {
  const payload = await c.req.parseBody();
  if (!verifyAlipayNotification(payload)) return c.text("failure", 400);
  if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(payload.trade_status)) {
    await activatePayment(payload.out_trade_no, payload.trade_no);
  }
  return c.text("success");
});

app.post("/api/billing/webhooks/wechat", async (c) => {
  const rawBody = await c.req.text();
  if (!verifyWechatNotification(c.req.raw.headers, rawBody)) {
    return c.json({ code: "FAIL", message: "签名验证失败" }, 401);
  }
  const notification = JSON.parse(rawBody);
  const resource = decryptWechatResource(notification.resource);
  if (resource.trade_state === "SUCCESS") {
    await activatePayment(resource.out_trade_no, resource.transaction_id);
  }
  return c.json({ code: "SUCCESS", message: "成功" });
});

app.get("/api/billing/subscription", async (c) => {
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const subscription = await (await getCollection("subscriptions")).findOne({ ownerId: new ObjectId(auth.user.id) });
  const wallet = await (await getCollection("wallets")).findOne({ ownerId: new ObjectId(auth.user.id) });
  const subscriptionStatus = subscription
    ? subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd)
    : null;
  return c.json({
    subscription: subscription ? { ...subscription, status: subscriptionStatus, id: subscription._id.toString(), _id: undefined, ownerId: undefined } : null,
    balanceFen: wallet?.balanceFen || 0,
  });
});

app.post("/api/billing/subscription/cancel", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const now = new Date();
  const result = await (await getCollection("subscriptions")).updateOne(
    { ownerId: new ObjectId(auth.user.id), currentPeriodStart: { $lte: now }, currentPeriodEnd: { $gt: now } },
    { $set: { autoRenew: false, cancelAtPeriodEnd: true, updatedAt: now } },
  );
  if (!result.matchedCount) return c.json({ code: "SUBSCRIPTION_NOT_FOUND", message: "当前没有生效中的订阅" }, 404);
  return c.json({ ok: true, cancelAtPeriodEnd: true });
});

app.get("/api/billing/offline-orders", async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const orders = await (await getCollection("offlinePayments"))
    .find({ ownerId: new ObjectId(auth.user.id) })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  return c.json({ orders: orders.map((order) => ({ id: order._id.toString(), orderNo: order.orderNo, cycle: order.cycle, amountFen: order.amountFen, status: order.status, reviewReason: order.reviewReason || null, previousReviewReason: order.previousReviewReason || null, resubmissionNote: order.resubmissionNote || null, createdAt: order.createdAt, validUntil: order.validUntil })) });
});

app.get("/api/admin/payments", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  c.header("Cache-Control", "private, no-store, max-age=0");
  const page = Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query("limit") || "100", 10) || 100));
  const query = {
    q: String(c.req.query("q") || "").slice(0, 160),
    from: c.req.query("from"),
    to: c.req.query("to"),
    channelId: c.req.query("channelId"),
  };
  const base = await adminOrderBaseFilter(query);
  if (base.error) return c.json({ code: "VALIDATION_ERROR", message: base.error }, 400);
  const payments = await getCollection("payments");
  const [orders, total, groupedStatuses] = await Promise.all([
    payments.find(base.filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    payments.countDocuments(base.filter),
    payments.aggregate([{ $match: base.filter }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
  ]);
  const summary = Object.fromEntries(groupedStatuses.map((item) => [item._id || "unknown", item.count]));
  return c.json({
    orders: await adminOrderRows(orders),
    summary: { total, ...summary },
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  });
});

app.get("/api/admin/offline-payments", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  await syncChandlerOfflinePayments(await getChandlerAccessToken(auth.session).catch(() => null)).catch(() => null);
  c.header("Cache-Control", "private, no-store, max-age=0");
  const requestedStatus = c.req.query("status");
  const page = Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query("limit") || "100", 10) || 100));
  const base = await adminOrderBaseFilter({
    q: String(c.req.query("q") || "").slice(0, 160),
    from: c.req.query("from"),
    to: c.req.query("to"),
    channelId: c.req.query("channelId"),
  });
  if (base.error) return c.json({ code: "VALIDATION_ERROR", message: base.error }, 400);
  const statusFilter = requestedStatus === "reviewed"
    ? { status: { $in: ["approved", "rejected"] } }
    : ["pending", "approved", "rejected"].includes(requestedStatus)
      ? { status: requestedStatus }
      : {};
  const filter = combineMongoFilters(base.filter, statusFilter);
  const sort = requestedStatus === "reviewed" ? { reviewedAt: -1, updatedAt: -1 } : { createdAt: -1 };
  const offlinePayments = await getCollection("offlinePayments");
  const [orders, total, pendingCount, approvedCount, rejectedCount] = await Promise.all([
    offlinePayments.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
    offlinePayments.countDocuments(filter),
    offlinePayments.countDocuments(combineMongoFilters(base.filter, { status: "pending" })),
    offlinePayments.countDocuments(combineMongoFilters(base.filter, { status: "approved" })),
    offlinePayments.countDocuments(combineMongoFilters(base.filter, { status: "rejected" })),
  ]);
  return c.json({
    orders: await adminOrderRows(orders),
    summary: { pending: pendingCount, reviewed: approvedCount + rejectedCount, approved: approvedCount, rejected: rejectedCount },
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  });
});

app.post("/api/admin/offline-payments/:id/approve", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "线下支付申请不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const result = await approveOfflinePayment({
    orderId: c.req.param("id"),
    actorUserId: auth.user.id,
    actorChandlerUserId: readExternalAuth(auth.session)?.chandlerUserId,
    accessToken: await getChandlerAccessToken(auth.session).catch(() => null),
    validFrom: body.validFrom,
    validUntil: body.validUntil,
  });
  if (result.error) return c.json({ code: result.error.code, message: result.error.message }, result.error.status);
  await (await getCollection("offlinePaymentReviewEvents")).updateOne(
    { orderId: new ObjectId(c.req.param("id")), status: { $in: ["pending", "leased", "awaiting_action"] } },
    { $set: { status: "completed", action: "approve", completedAt: new Date(), updatedAt: new Date() } },
  );
  return c.json(result);
});

app.post("/api/admin/offline-payments/:id/reject", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "线下支付申请不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const result = await rejectOfflinePayment({
    orderId: c.req.param("id"),
    actorUserId: auth.user.id,
    actorChandlerUserId: readExternalAuth(auth.session)?.chandlerUserId,
    accessToken: await getChandlerAccessToken(auth.session).catch(() => null),
    reason: body.reason,
  });
  if (result.error) return c.json({ code: result.error.code, message: result.error.message }, result.error.status);
  await (await getCollection("offlinePaymentReviewEvents")).updateOne(
    { orderId: new ObjectId(c.req.param("id")), status: { $in: ["pending", "leased", "awaiting_action"] } },
    { $set: { status: "completed", action: "reject", completedAt: new Date(), updatedAt: new Date() } },
  );
  return c.json(result);
});
app.post("/api/billing/offline-payments/:id/resubmit", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "线下支付申请不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || "").trim();
  if (note.length < 2 || note.length > 500) return c.json({ code: "VALIDATION_ERROR", message: "请填写 2–500 字的调整说明" }, 400);
  const orders = await getCollection("offlinePayments");
  const ownerId = new ObjectId(auth.user.id);
  const order = await orders.findOne({ _id: new ObjectId(c.req.param("id")), ownerId, status: "rejected" });
  if (!order) return c.json({ code: "ORDER_NOT_FOUND", message: "申请不存在、已重新提交或不属于当前账号" }, 404);
  const now = new Date();
  const partnerData = { ...order.partnerData, review_status: "pending", business_payment_status: "awaiting_manual_review", previous_rejection_reason: order.reviewReason, resubmission_note: note, resubmitted_at: now.toISOString() };
  const result = await orders.updateOne(
    { _id: order._id, ownerId, status: "rejected" },
    { $set: { status: "pending", previousReviewReason: order.reviewReason, resubmissionNote: note, resubmittedAt: now, partnerData, updatedAt: now }, $unset: { reviewReason: "", reviewedBy: "", reviewedAt: "", rejectedAt: "" }, $inc: { resubmissionCount: 1 } },
  );
  if (!result.modifiedCount) return c.json({ code: "ORDER_STATE_CHANGED", message: "订单状态已变化，请刷新后重试" }, 409);
  await (await getCollection("notifications")).updateMany({ ownerId, orderId: order._id, type: "offline_payment_rejected", readAt: null }, { $set: { readAt: now } });
  await enqueueOfflineReviewEvent(order, "resubmission").catch(() => null);
  return c.json({ ok: true, orderNo: order.orderNo, status: "pending" });
});

app.openapi(desktopCreateOfflinePaymentRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c);
  if (auth.error) return auth.error;
  const body = c.req.valid("json");
  const cycle = body.planKind === "yearly" ? "year" : "month";
  const pricing = await currentSubscriptionPricing();
  const amountFen = cycle === "year" ? pricing.yearly.amountFen : pricing.monthly.amountFen;
  if (body.expectedAmountFen !== amountFen) {
    return c.json({ code: "PRICE_CHANGED", message: `官网订阅价格已更新为 ¥${(amountFen / 100).toFixed(2)}，请刷新桌面端套餐后重新提交` }, 409);
  }
  const orders = await getCollection("offlinePayments");
  const existing = await orders.findOne({ desktopRequestId: body.clientOrderNo });
  if (existing) {
    if (String(existing.ownerId) !== String(auth.user._id)) return c.json({ code: "ORDER_CONFLICT", message: "该桌面端订单号已经属于其他账号" }, 409);
    return c.json({ order: desktopOfflinePaymentRow(existing), idempotent: true }, 201);
  }
  const now = new Date();
  const editionKey = body.applicationKey === "airos-eternal-flower" ? "yongshenghua" : "gulong";
  const orderNo = `GLD${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
  const partnerData = {
    schema_version: 3,
    application_key: body.applicationKey,
    application_name: editionKey === "yongshenghua" ? "爱若斯-永生花" : "古龙智能引擎",
    theme_name: body.themeName,
    release_channel: body.releaseChannel,
    release_channel_name: body.releaseChannel,
    user_id: String(auth.chandlerUser.id),
    user_email: auth.user.email || auth.chandlerUser.email || null,
    product_id: "subscription",
    product_name: cycle === "year" ? "年度订阅会员" : "月度订阅会员",
    plan_kind: body.planKind,
    amount_fen: amountFen,
    payment_method: "offline",
    platform_service_fee: false,
    review_status: "pending",
    business_payment_status: "awaiting_manual_review",
    submitted_at: now.toISOString(),
    submitted_at_unix_ms: now.getTime(),
    source: "windows-desktop-official-queue",
  };
  const document = {
    orderNo,
    desktopRequestId: body.clientOrderNo,
    chandlerOrderNo: null,
    ownerId: auth.user._id,
    chandlerUserId: String(auth.chandlerUser.id),
    userEmail: auth.user.email || auth.chandlerUser.email || null,
    cycle,
    amountFen,
    plan: { productId: "subscription", productName: partnerData.product_name, skuId: null, skuName: null, source: "desktop-official-queue" },
    partnerData,
    applicationKey: body.applicationKey,
    editionKey,
    releaseChannelName: body.releaseChannel,
    status: "pending",
    source: "desktop-official-queue",
    createdAt: now,
    updatedAt: now,
  };
  let result;
  try {
    result = await orders.insertOne(document);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const duplicate = await orders.findOne({ desktopRequestId: body.clientOrderNo });
    if (!duplicate || String(duplicate.ownerId) !== String(auth.user._id)) return c.json({ code: "ORDER_CONFLICT", message: "订单提交发生冲突，请刷新后重试" }, 409);
    return c.json({ order: desktopOfflinePaymentRow(duplicate), idempotent: true }, 201);
  }
  const order = { ...document, _id: result.insertedId };
  await enqueueOfflineReviewEvent(order, "desktop-official-queue");
  return c.json({ order: desktopOfflinePaymentRow(order), idempotent: false }, 201);
});

app.openapi(desktopAdminOfflinePaymentsRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const synchronized = await syncChandlerOfflinePayments(auth.accessToken).catch(() => ({ imported: 0, inspected: 0 }));
  const requested = c.req.valid("query").status;
  const limit = c.req.valid("query").limit || 100;
  const statusFilter = requested === "reviewed"
    ? { $in: ["approved", "rejected"] }
    : ["pending", "approved", "rejected"].includes(requested)
      ? requested
      : { $in: ["pending", "approved", "rejected"] };
  const orders = await (await getCollection("offlinePayments"))
    .find({ status: statusFilter })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ orders: orders.map(desktopOfflinePaymentRow), synchronized });
});

app.openapi(desktopAdminApproveOfflinePaymentRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const { orderId } = c.req.valid("param");
  if (!ObjectId.isValid(orderId)) return c.json({ code: "ORDER_NOT_FOUND", message: "线下支付申请不存在" }, 404);
  const body = c.req.valid("json");
  const result = await approveOfflinePayment({
    orderId,
    actorUserId: auth.user._id.toString(),
    actorChandlerUserId: String(auth.chandlerUser.id),
    accessToken: auth.accessToken,
    validFrom: body.validFrom,
    validUntil: body.validUntil,
  });
  if (result.error) return c.json({ code: result.error.code, message: result.error.message }, result.error.status);
  const now = new Date();
  await (await getCollection("offlinePaymentReviewEvents")).updateOne(
    { orderId: new ObjectId(orderId), status: { $in: ["pending", "leased", "awaiting_action"] } },
    { $set: { status: "completed", action: "approve", completedAt: now, updatedAt: now } },
  );
  const order = await (await getCollection("offlinePayments")).findOne({ _id: new ObjectId(orderId) });
  return c.json(desktopOfflinePaymentRow(order));
});

app.openapi(desktopReviewBindRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const { workerId, channel } = c.req.valid("json");
  const workers = await getCollection("offlinePaymentReviewWorkers");
  const existing = await workers.findOne({ workerId });
  if (existing && String(existing.ownerId) !== String(auth.user._id)) {
    return c.json({ code: "WORKER_ALREADY_BOUND", message: "此桌面审核工作器已绑定其他管理员账号" }, 409);
  }
  const now = new Date();
  await workers.updateOne(
    { workerId },
    {
      $set: {
        ownerId: auth.user._id,
        chandlerUserId: String(auth.chandlerUser.id),
        channel,
        enabled: true,
        lastSeenAt: now,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return c.json({
    ok: true,
    workerId,
    administrator: {
      id: String(auth.chandlerUser.id),
      displayName: auth.user.displayName || auth.chandlerUser.display_name || auth.chandlerUser.name || null,
      email: auth.user.email || auth.chandlerUser.email || null,
    },
  });
});

app.openapi(desktopReviewClaimRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const { workerId } = c.req.valid("json");
  const ownerId = auth.user._id;
  const workers = await getCollection("offlinePaymentReviewWorkers");
  const worker = await workers.findOne({ workerId, ownerId, enabled: true, channel: "personal-wechat" });
  if (!worker) return c.json({ code: "WORKER_NOT_BOUND", message: "请先在管理员桌面端绑定当前微信会话" }, 403);
  const rate = await enforceRateLimit(`desktop-review-claim:${workerId}`, { limit: 90, windowMs: 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "审核任务轮询过于频繁" }, 429);
  await syncChandlerOfflinePayments(auth.accessToken).catch(() => null);

  const now = new Date();
  const events = await getCollection("offlinePaymentReviewEvents");
  const orders = await getCollection("offlinePayments");
  await Promise.all([
    workers.updateOne({ _id: worker._id }, { $set: { lastSeenAt: now, updatedAt: now } }),
    events.updateMany(
      { status: "leased", leaseUntil: { $lte: now } },
      { $set: { status: "pending", availableAt: now, updatedAt: now }, $unset: { claimedBy: "", claimedByChandlerUserId: "", workerId: "", leaseUntil: "", claimedAt: "" } },
    ),
  ]);

  const outstanding = await events.findOne({ claimedBy: ownerId, workerId, status: { $in: ["leased", "awaiting_action"] } }, { sort: { claimedAt: 1 } });
  if (outstanding) {
    const order = await orders.findOne({ _id: outstanding.orderId, status: "pending" });
    if (order) return c.json({ event: desktopReviewEvent(outstanding, order) });
    await events.updateOne({ _id: outstanding._id }, { $set: { status: "cancelled", completedAt: now, updatedAt: now } });
  }

  let event = await events.findOneAndUpdate(
    { status: "pending", availableAt: { $lte: now } },
    {
      $set: {
        status: "leased",
        claimedBy: ownerId,
        claimedByChandlerUserId: String(auth.chandlerUser.id),
        workerId,
        claimedAt: now,
        leaseUntil: new Date(now.getTime() + 2 * 60_000),
        updatedAt: now,
      },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );

  if (!event) {
    const pendingOrder = await orders.findOne({ status: "pending" }, { sort: { createdAt: 1 } });
    if (!pendingOrder) return c.json({ event: null });
    const knownEvent = await events.findOne({ orderId: pendingOrder._id });
    if (!knownEvent || ["completed", "cancelled"].includes(knownEvent.status)) {
      await enqueueOfflineReviewEvent(pendingOrder, "backfill");
      event = await events.findOneAndUpdate(
        { orderId: pendingOrder._id, status: "pending", availableAt: { $lte: now } },
        {
          $set: {
            status: "leased",
            claimedBy: ownerId,
            claimedByChandlerUserId: String(auth.chandlerUser.id),
            workerId,
            claimedAt: now,
            leaseUntil: new Date(now.getTime() + 2 * 60_000),
            updatedAt: now,
          },
        },
        { returnDocument: "after" },
      );
    }
  }
  if (!event) return c.json({ event: null });
  const order = await orders.findOne({ _id: event.orderId, status: "pending" });
  if (!order) {
    await events.updateOne({ _id: event._id }, { $set: { status: "cancelled", completedAt: now, updatedAt: now } });
    return c.json({ event: null });
  }
  return c.json({ event: desktopReviewEvent(event, order) });
});

app.openapi(desktopReviewNotifiedRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const { eventId } = c.req.valid("param");
  const { workerId, outboundId } = c.req.valid("json");
  if (!ObjectId.isValid(eventId)) return c.json({ code: "REVIEW_EVENT_NOT_FOUND", message: "审核事件不存在" }, 404);
  const worker = await (await getCollection("offlinePaymentReviewWorkers")).findOne({ workerId, ownerId: auth.user._id, enabled: true, channel: "personal-wechat" });
  if (!worker) return c.json({ code: "WORKER_NOT_BOUND", message: "当前桌面微信工作器未绑定此管理员" }, 403);
  const now = new Date();
  const events = await getCollection("offlinePaymentReviewEvents");
  const changed = await events.updateOne(
    { _id: new ObjectId(eventId), claimedBy: auth.user._id, workerId, status: "leased", leaseUntil: { $gt: now } },
    { $set: { status: "awaiting_action", outboundId, notifiedAt: now, updatedAt: now }, $unset: { leaseUntil: "" } },
  );
  if (!changed.modifiedCount) {
    const refreshed = await events.updateOne(
      { _id: new ObjectId(eventId), claimedBy: auth.user._id, workerId, status: "awaiting_action" },
      { $set: { outboundId, notifiedAt: now, updatedAt: now } },
    );
    if (!refreshed.matchedCount) return c.json({ code: "REVIEW_EVENT_CHANGED", message: "审核事件已过期或已由其他管理员处理" }, 409);
  }
  return c.json({ ok: true, status: "awaiting_action" });
});

app.openapi(desktopReviewActionRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const { eventId } = c.req.valid("param");
  const { workerId, action, reason, messageId } = c.req.valid("json");
  if (!ObjectId.isValid(eventId)) return c.json({ code: "REVIEW_EVENT_NOT_FOUND", message: "审核事件不存在" }, 404);
  const worker = await (await getCollection("offlinePaymentReviewWorkers")).findOne({ workerId, ownerId: auth.user._id, enabled: true, channel: "personal-wechat" });
  if (!worker) return c.json({ code: "WORKER_NOT_BOUND", message: "当前桌面微信工作器未绑定此管理员" }, 403);
  const now = new Date();
  const events = await getCollection("offlinePaymentReviewEvents");
  const event = await events.findOneAndUpdate(
    {
      _id: new ObjectId(eventId),
      claimedBy: auth.user._id,
      claimedByChandlerUserId: String(auth.chandlerUser.id),
      workerId,
      $or: [{ status: "awaiting_action" }, { status: "leased", leaseUntil: { $gt: now } }],
    },
    { $set: { status: "processing", actionStartedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!event) return c.json({ code: "REVIEW_EVENT_CHANGED", message: "订单已处理、审核菜单已过期或微信会话不匹配" }, 409);

  const input = {
    orderId: event.orderId.toString(),
    actorUserId: auth.user._id.toString(),
    actorChandlerUserId: String(auth.chandlerUser.id),
    accessToken: auth.accessToken,
  };
  let result;
  try {
    result = action === "approve"
      ? await approveOfflinePayment(input)
      : await rejectOfflinePayment({ ...input, reason });
  } catch (error) {
    await events.updateOne(
      { _id: event._id, status: "processing" },
      { $set: { status: "awaiting_action", updatedAt: new Date() }, $unset: { actionStartedAt: "" } },
    ).catch(() => null);
    throw error;
  }
  if (result.error) {
    const terminal = result.error.code === "ORDER_STATE_CHANGED";
    await events.updateOne(
      { _id: event._id, status: "processing" },
      terminal
        ? { $set: { status: "cancelled", completedAt: new Date(), updatedAt: new Date() } }
        : { $set: { status: "awaiting_action", updatedAt: new Date() }, $unset: { actionStartedAt: "" } },
    );
    return c.json({ code: result.error.code, message: result.error.message }, result.error.status);
  }
  await events.updateOne(
    { _id: event._id, status: "processing" },
    { $set: { status: "completed", action, actionMessageId: messageId || null, completedAt: new Date(), updatedAt: new Date() }, $unset: { leaseUntil: "", actionStartedAt: "" } },
  );
  return c.json(result);
});

app.openapi(desktopSubscriptionStatusRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c);
  if (auth.error) return auth.error;
  const now = new Date();
  const subscription = await (await getCollection("subscriptions")).findOne({ ownerId: auth.user._id });
  const status = subscription
    ? subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd, now)
    : "inactive";
  const active = status === "active";
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  return c.json({
    isMember: auth.identity.role === "admin" || Boolean(active),
    subscription: subscription ? {
      plan: subscription.plan || "member",
      cycle: subscription.cycle || null,
      provider: subscription.provider || null,
      status,
      currentPeriodStart: subscription.currentPeriodStart || null,
      currentPeriodEnd: subscription.currentPeriodEnd || null,
      autoRenew: Boolean(subscription.autoRenew),
    } : null,
    checkedAt: now,
  });
});

app.openapi(createTaskRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["tasks:write"] });
  if (auth.error) return auth.error;
  const body = c.req.valid("json");
  const now = new Date();
  const result = await (await getCollection("tasks")).insertOne({
    ownerId: new ObjectId(auth.user.id),
    prompt: body.prompt,
    workflowId: body.workflowId || "smart-assembly",
    callbackUrl: body.callbackUrl || null,
    metadata: body.metadata || {},
    status: "queued",
    source: auth.kind,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id: result.insertedId.toString(), status: "queued", createdAt: now }, 201);
});

app.openapi(listTasksRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["tasks:read"] });
  if (auth.error) return auth.error;
  const tasks = await (await getCollection("tasks"))
    .find({ ownerId: new ObjectId(auth.user.id) })
    .sort({ createdAt: -1 })
    .limit(50)
    .project({ ownerId: 0 })
    .toArray();
  return c.json({ tasks: tasks.map((task) => ({ ...task, id: task._id.toString(), _id: undefined })) });
});

app.openapi(getTaskRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["tasks:read"] });
  if (auth.error) return auth.error;
  const id = c.req.valid("param").id;
  if (!ObjectId.isValid(id)) return c.json({ code: "TASK_NOT_FOUND", message: "任务不存在" }, 404);
  const task = await (await getCollection("tasks")).findOne({ _id: new ObjectId(id), ownerId: new ObjectId(auth.user.id) });
  if (!task) return c.json({ code: "TASK_NOT_FOUND", message: "任务不存在" }, 404);
  const { _id, ownerId, ...rest } = task;
  return c.json({ ...rest, id: _id.toString() });
});

app.openapi(createMemoryRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["brain:write"] });
  if (auth.error) return auth.error;
  const body = c.req.valid("json");
  const content = body.content.trim();
  const result = await (await getCollection("memories")).insertOne({
    ownerId: new ObjectId(auth.user.id),
    content,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 20) : [],
    createdAt: new Date(),
  });
  return c.json({ id: result.insertedId.toString(), status: "stored" }, 201);
});

app.openapi(listMemoriesRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["brain:read"] });
  if (auth.error) return auth.error;
  const memories = await (await getCollection("memories"))
    .find({ ownerId: new ObjectId(auth.user.id) })
    .sort({ createdAt: -1 })
    .limit(50)
    .project({ ownerId: 0 })
    .toArray();
  return c.json({ memories: memories.map((memory) => ({ ...memory, id: memory._id.toString(), _id: undefined })) });
});

app.openapi(listWorkflowsRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["workflows:read"] });
  if (auth.error) return auth.error;
  return c.json({
    workflows: [
      { id: "smart-assembly", name: "智能任务组装", access: "free" },
      { id: "second-brain-analysis", name: "第二大脑分析", access: "member" },
      { id: "short-drama-studio", name: "短剧创作工作台", access: "member" },
    ],
  });
});

app.openapi(getAccountProfileRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["profile:read"] });
  if (auth.error) return auth.error;
  if (auth.kind !== "apiKey") return c.json({ code: "API_KEY_REQUIRED", message: "请使用具有 profile:read 权限的 API Key" }, 403);
  const user = await (await getCollection("users")).findOne({ _id: new ObjectId(auth.user.id) });
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const avatar = user?.avatar ? new URL(user.avatar, c.req.url).toString() : null;
  return c.json({
    id: auth.user.id,
    username: user?.username || null,
    displayName: user?.displayName || null,
    avatar,
    edition: { key: user?.editionKey || "gulong", name: user?.editionName || "古龙版" },
    updatedAt: user?.updatedAt || user?.createdAt || new Date(0),
  });
});

app.openapi(getSubscriptionPricingRoute, async (c) => {
  const pricing = await currentSubscriptionPricing();
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ...pricing, paymentAvailability: ONLINE_PAYMENT_AVAILABILITY });
});

app.openapi(getMiniMaxConfigurationRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["configuration:read"] });
  if (auth.error) return auth.error;
  if (auth.kind !== "apiKey") return c.json({ code: "API_KEY_REQUIRED", message: "请使用具有 configuration:read 权限的 API Key" }, 403);
  const configuration = await (await getCollection("userConfigurations")).findOne({ ownerId: new ObjectId(auth.user.id), provider: "minimax" });
  const apiKey = readUserSecret(configuration?.apiKeyEncrypted, "minimax-api-key");
  if (!configuration || !apiKey) return c.json({ code: "CONFIGURATION_NOT_FOUND", message: "当前用户尚未配置 MiniMax API Key" }, 404);
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  return c.json({ provider: "minimax", apiKey, apiHost: MINIMAX_API_HOST, model: MINIMAX_DEFAULT_MODEL, updatedAt: configuration.updatedAt });
});

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Gulong API Key / Chandler Access Token",
  description: "开发者接口使用 gla_live_...；桌面同步接口使用桌面端当前 Chandler Access Token。",
});

app.doc("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "古龙 Gulong Agent Engine API",
    version: "1.6.0",
    description: "面向开发者的任务执行、长期记忆、用户模型配置、第二大脑附件、发行版本、Chandler 统一账号、应用级 SKU 价格版本、计费、管理员经营分析与桌面端个人微信订单审核接口。API Key 仅在创建时显示一次；COS 下载链接默认 15 分钟失效。",
  },
  servers: [
    { url: "/", description: "当前环境" },
  ],
  security: [{ bearerAuth: [] }],
});

app.get(
  "/api/docs",
  apiReference({
    theme: "saturn",
    layout: "modern",
    spec: { url: "/api/openapi.json" },
    pageTitle: "古龙 API 文档",
    customCss: ":root{--scalar-color-accent:#0b6c62}",
  }),
);

export default app;
