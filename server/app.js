import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as signBytes, verify as verifyBytes } from "node:crypto";
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
  issueShortDramaSsoToken,
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
  createMockPaymentUrl,
  paymentCapabilities,
} from "./payments.js";
import {
  ChandlerError,
  chandlerConfig,
  chandlerRequest,
  createDirectPaymentOrder,
  createPartnerPriceVersion,
  createPartnerSku,
  createSubscriptionCheckout,
  changeChandlerPassword,
  bindChandlerPhone,
  deleteChandlerIdentity,
  externalAuthFromResponse,
  forgotPasswordWithChandler,
  forgotPasswordWithChandlerPhone,
  getChandlerAuthCapabilities,
  getChandlerAccessToken,
  getDirectPaymentOrder,
  issueOfflineCredential,
  isChandlerBootstrapAdmin,
  isChandlerPhoneRegistrationConfigured,
  isChandlerRegistrationAttributionConfigured,
  getPartnerClientUserAttributes,
  listAllPartnerClientUsers,
  listChandlerIdentities,
  listPartnerPriceVersions,
  listPartnerSubscriptionPlans,
  loginWithChandler,
  loginWithChandlerOtp,
  resolveWebsiteLoginEmail,
  logoutFromChandler,
  logoutAllFromChandler,
  markChandlerProductEdition,
  productEditionFromChannel,
  registerPhoneWithChandler,
  registerWithChandler,
  resetPasswordWithChandler,
  resetPasswordWithChandlerPhone,
  resolveChandlerIdentity,
  setPartnerSkuStatus,
  setPrimaryChandlerIdentity,
  sendChandlerReauthCode,
  sendChandlerVerificationEmail,
  sendLoginOtpWithChandler,
  sendPhoneRegistrationOtpWithChandler,
  upsertChandlerUser,
  verifyChandlerEmail,
  verifyChandlerIdentity,
  verifyChandlerWebhook,
  websiteUsernameIdentity,
  websiteUsernameOwnerFilter,
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
import { buildPearAccountUsageSnapshot, creditPaymentBalanceWithPromotion, paymentPromotionBonusFen, registerPearApiRoutes } from "./pearapi.js";
import { registerH3SharedRoutes } from "./h3-shared.js";
import {
  SHORT_VIDEO_MONTHLY_PRICE_FEN,
  SHORT_VIDEO_PLAN_ID,
  SHORT_VIDEO_PLAN_NAME,
  SHORT_VIDEO_YEARLY_PRICE_FEN,
  creditShortVideoSubscriptionBalance,
  expireShortVideoPackageAllowance,
  shortVideoPackageView,
  shortVideoSubscriptionPriceFen,
} from "./short-video-subscription.js";
import { localizeErrorMessage } from "../shared/error-messages.js";
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

function requestValidationMessage(error) {
  const issue = error?.issues?.[0];
  const field = String(issue?.path?.at(-1) || "");
  if (field === "email") return "请输入有效的邮箱地址";
  if (field === "displayName") return "显示名称不能只包含空格，且最多允许 64 个字符";
  if (field === "inviteCode") return "邀请码最多允许 64 个字符";
  if (field === "password") return issue?.code === "too_big" ? "密码最多允许 255 个字符" : "请输入密码";
  if (field === "phone") return "请输入正确的大陆手机号或带国家码的国际手机号";
  if (field === "target") return "请输入正确的邮箱或手机号";
  if (field === "targetType") return "验证码登录类型不正确";
  if (field === "code") return "请输入 6 位数字验证码";
  if (field === "activation_receipt") return "请提供当前设备的有效激活回执";
  if (field === "app_version") return "请提供桌面客户端版本号";
  if (field === "device_name") return "设备名称最多允许 120 个字符";
  if (field === "os_version") return "系统版本最多允许 120 个字符";
  if (field === "token") return "请输入邮件中的完整验证码或验证令牌";
  return "请检查填写内容是否正确";
}

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (result.success) return undefined;
    return c.json({
      code: "VALIDATION_ERROR",
      message: requestValidationMessage(result.error),
      requestId: c.get("requestId"),
    }, 400);
  },
});

const MINIMAX_API_HOST = "https://api.minimaxi.com/v1";
const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const AVATAR_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const FEEDBACK_RESPONSE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]);
const FEEDBACK_RESPONSE_MAX_BYTES = 200 * 1024 * 1024;
const WORKFLOW_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const WORKFLOW_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const SUBSCRIPTION_PRICE_MIN_FEN = 100;
const SUBSCRIPTION_PRICE_MAX_FEN = 10_000_000;
const CUSTOM_ORDER_MAX_FEN = 10_000_000;
const ACTIVATION_CODE_MAX_BATCH = 500;
const ACTIVATION_PRODUCT_DEFAULT = "minimax-h3-universal";
const RENEWAL_REMINDER_DAYS = 7;
let authCapabilitiesCache = { expiresAt: 0, value: null };
const ONLINE_PAYMENT_AVAILABILITY = Object.freeze({
  online: true,
  status: "available",
  notice: "微信在线支付已开通；会员到期前 7 天起每天提醒手动续费。",
  priorityProvider: "wechat",
  channels: {
    wechat: { enabled: true, status: "available", label: "微信支付", message: "扫码完成单次付款，到账后自动开通或续费。" },
  },
});
let offlinePaymentSyncPromise = null;
let offlinePaymentSynchronizedAt = 0;

function normalizeActivationCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function hashActivationCode(value) {
  return createHash("sha256").update(normalizeActivationCode(value)).digest("hex");
}

function activationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  const groups = [];
  for (let group = 0; group < 4; group += 1) {
    let part = "";
    for (let index = 0; index < 5; index += 1) {
      part += alphabet[bytes[group * 5 + index] % alphabet.length];
    }
    groups.push(part);
  }
  return `H3-${groups.join("-")}`;
}

const HARDWARE_FINGERPRINT_VERSION = "h3-hw-v2";
const HARDWARE_COMPONENT_WEIGHTS = Object.freeze({
  systemUuid: 30,
  baseboardSerial: 22,
  baseboardModel: 8,
  biosSerial: 12,
  chassisSerial: 8,
  tpm: 5,
  cpu: 5,
  systemDisk: 4,
  gpu: 2,
  physicalMacs: 2,
  systemModel: 1,
  oemStrings: 1,
});
const HARDWARE_COMPONENT_NAMES = Object.freeze(Object.keys(HARDWARE_COMPONENT_WEIGHTS));
const HARDWARE_BINDING_V2_FIELDS = Object.freeze([
  "fingerprintVersion",
  "hardwareHash",
  "hardwareEvidenceHash",
  "fingerprintConfidence",
  "hardwareScore",
  "bindingScore",
  "identityComponents",
  "hardwareComponentDigests",
]);
const HARDWARE_BINDING_V2_ALLOWED_REQUEST_FIELDS = new Set([
  "code",
  "deviceId",
  "deviceName",
  "macHint",
  ...HARDWARE_BINDING_V2_FIELDS,
]);
const RAW_HARDWARE_FIELD_PATTERN = /(uuid|smbios|baseboard|motherboard|bios|chassis|serial|tpm|cpu|disk|gpu|mac|oem|hardwarecomponents?|hardwareevidence)/i;
const HardwareDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const HardwareIdentityComponentSchema = z.enum(HARDWARE_COMPONENT_NAMES);
const HardwareBindingV2RequestShape = {
  fingerprintVersion: z.literal(HARDWARE_FINGERPRINT_VERSION),
  hardwareHash: HardwareDigestSchema,
  hardwareEvidenceHash: HardwareDigestSchema,
  fingerprintConfidence: z.enum(["high", "medium", "low"]),
  hardwareScore: z.number().int().min(0).max(100),
  bindingScore: z.number().int().min(0).max(100),
  identityComponents: z.array(HardwareIdentityComponentSchema).min(1).max(HARDWARE_COMPONENT_NAMES.length),
  hardwareComponentDigests: z.record(z.string(), HardwareDigestSchema),
};
const HardwareBindingV2RequestSchema = z.object(HardwareBindingV2RequestShape);

function activationHardwareError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function parseActivationHardwareBindingV2(bodyValue) {
  const body = bodyValue && typeof bodyValue === "object" && !Array.isArray(bodyValue) ? bodyValue : {};
  const rawHardwareFields = Object.keys(body).filter(
    (field) => !HARDWARE_BINDING_V2_ALLOWED_REQUEST_FIELDS.has(field) && RAW_HARDWARE_FIELD_PATTERN.test(field),
  );
  if (rawHardwareFields.length) {
    throw activationHardwareError("RAW_HARDWARE_EVIDENCE_REJECTED", "硬件指纹请求只能提交分类摘要，不能提交原始硬件值");
  }
  const hasV2Field = HARDWARE_BINDING_V2_FIELDS.some((field) => Object.hasOwn(body, field));
  if (!hasV2Field) return null;

  const unexpectedFields = Object.keys(body).filter((field) => !HARDWARE_BINDING_V2_ALLOWED_REQUEST_FIELDS.has(field));
  if (unexpectedFields.length) {
    throw activationHardwareError("RAW_HARDWARE_EVIDENCE_REJECTED", "硬件指纹请求只能提交分类摘要，不能提交原始硬件值");
  }

  const candidate = Object.fromEntries(HARDWARE_BINDING_V2_FIELDS.map((field) => [field, body[field]]));
  const parsed = HardwareBindingV2RequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw activationHardwareError("INVALID_HARDWARE_FINGERPRINT", "硬件指纹摘要格式不正确");
  }

  const identitySet = new Set(parsed.data.identityComponents);
  if (identitySet.size !== parsed.data.identityComponents.length) {
    throw activationHardwareError("INVALID_HARDWARE_FINGERPRINT", "硬件指纹分类不能重复");
  }
  const digestKeys = Object.keys(parsed.data.hardwareComponentDigests);
  if (digestKeys.length !== identitySet.size || digestKeys.some((key) => !identitySet.has(key))) {
    throw activationHardwareError("INVALID_HARDWARE_FINGERPRINT", "硬件分类与分类摘要必须一一对应");
  }
  const expectedHardwareScore = [...identitySet].reduce((total, name) => total + HARDWARE_COMPONENT_WEIGHTS[name], 0);
  if (parsed.data.hardwareScore !== expectedHardwareScore) {
    throw activationHardwareError("INVALID_HARDWARE_FINGERPRINT", "硬件指纹权重得分不正确");
  }

  const identityComponents = HARDWARE_COMPONENT_NAMES.filter((name) => identitySet.has(name));
  return {
    fingerprintVersion: HARDWARE_FINGERPRINT_VERSION,
    hardwareHash: parsed.data.hardwareHash,
    hardwareEvidenceHash: parsed.data.hardwareEvidenceHash,
    fingerprintConfidence: parsed.data.fingerprintConfidence,
    hardwareScore: parsed.data.hardwareScore,
    bindingScore: parsed.data.bindingScore,
    identityComponents,
    hardwareComponentDigests: Object.fromEntries(identityComponents.map((name) => [name, parsed.data.hardwareComponentDigests[name]])),
  };
}

function activationHardwareBindingAction(record, incomingBinding) {
  if (!incomingBinding) return "unchanged";
  const existingHash = String(record?.hardwareBindingV2?.hardwareHash || "");
  if (!existingHash) return "bind";
  return existingHash === incomingBinding.hardwareHash ? "unchanged" : "mismatch";
}

async function persistActivationHardwareBindingV2(codes, record, incomingBinding, now = new Date()) {
  const action = activationHardwareBindingAction(record, incomingBinding);
  if (action === "unchanged") return record;
  if (action === "mismatch") {
    throw activationHardwareError("HARDWARE_FINGERPRINT_MISMATCH", "激活码已绑定到另一组主板硬件指纹", 409);
  }

  const updated = await codes.findOneAndUpdate(
    {
      _id: record._id,
      status: "used",
      deviceId: record.deviceId,
      "hardwareBindingV2.hardwareHash": { $exists: false },
    },
    {
      $set: {
        hardwareBindingV2: { ...incomingBinding, boundAt: now },
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (updated) return updated;

  const current = await codes.findOne({ _id: record._id });
  if (activationHardwareBindingAction(current, incomingBinding) === "mismatch") {
    throw activationHardwareError("HARDWARE_FINGERPRINT_MISMATCH", "激活码已绑定到另一组主板硬件指纹", 409);
  }
  return current || record;
}

function activationReceiptPayload(record) {
  return {
    version: 1,
    licenseId: record._id.toString(),
    product: record.product,
    deviceId: record.deviceId,
    macHint: record.macHint || null,
    activatedAt: new Date(record.activatedAt).toISOString(),
    perpetual: true,
  };
}

function activationSigningPrivateKey(encodedValue = process.env.ACTIVATION_SIGNING_PRIVATE_KEY_B64) {
  const encodedKey = String(encodedValue || "").trim();
  if (!encodedKey) throw new ConfigurationError("授权签名密钥尚未配置");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey) || encodedKey.length % 4 !== 0) {
    throw new ConfigurationError("授权签名密钥格式无效");
  }
  try {
    const privateKey = createPrivateKey(Buffer.from(encodedKey, "base64").toString("utf8"));
    if (privateKey.asymmetricKeyType !== "rsa" || Number(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072) {
      throw new Error("activation signing key must be RSA-3072 or stronger");
    }
    return privateKey;
  } catch {
    throw new ConfigurationError("授权签名密钥格式无效");
  }
}

function signActivationReceipt(payload, privateKey = activationSigningPrivateKey()) {
  const canonical = JSON.stringify(payload);
  return {
    algorithm: "RS256",
    signature: signBytes("RSA-SHA256", Buffer.from(canonical), privateKey).toString("base64"),
  };
}

async function verifyActivationReceipt(receiptValue) {
  let receipt;
  try { receipt = typeof receiptValue === "string" ? JSON.parse(receiptValue) : receiptValue; }
  catch { throw Object.assign(new Error("激活回执不是有效 JSON"), { code: "INVALID_ACTIVATION_PROOF", status: 403 }); }
  if (!receipt || typeof receipt !== "object" || receipt.version !== 1 || receipt.algorithm !== "RS256" || !ObjectId.isValid(receipt.licenseId) || !/^[a-f0-9]{64}$/.test(String(receipt.deviceId || "")) || typeof receipt.signature !== "string") {
    throw Object.assign(new Error("激活回执格式无效"), { code: "INVALID_ACTIVATION_PROOF", status: 403 });
  }
  const payload = {
    version: 1,
    licenseId: String(receipt.licenseId),
    product: String(receipt.product || ""),
    deviceId: String(receipt.deviceId),
    macHint: receipt.macHint == null ? null : String(receipt.macHint),
    activatedAt: String(receipt.activatedAt || ""),
    perpetual: receipt.perpetual === true,
  };
  let signatureValid = false;
  try {
    signatureValid = verifyBytes("RSA-SHA256", Buffer.from(JSON.stringify(payload)), createPublicKey(activationSigningPrivateKey()), Buffer.from(receipt.signature, "base64"));
  } catch { signatureValid = false; }
  if (!signatureValid) throw Object.assign(new Error("激活回执签名无效"), { code: "INVALID_ACTIVATION_PROOF", status: 403 });
  const record = await (await getCollection("activationCodes")).findOne({ _id: new ObjectId(payload.licenseId), status: "used" });
  if (!record || record.product !== payload.product || record.deviceId !== payload.deviceId || new Date(record.activatedAt).toISOString() !== payload.activatedAt) {
    throw Object.assign(new Error("激活授权不存在、已停用或与设备不匹配"), { code: "INVALID_ACTIVATION_PROOF", status: 403 });
  }
  return { record, payload };
}

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
    username: z.string().optional(),
    email: z.email(),
    displayName: z.string().trim().min(1).max(64).optional(),
    inviteCode: z.string().trim().max(64).optional(),
    password: z.string().min(1).max(255),
  });

const LoginSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1).max(128),
});

const ShortDramaSsoResponseSchema = z.object({
  token: z.string(),
  expiresIn: z.literal(120),
});

const ForgotPasswordSchema = z.object({
  email: z.email(),
});

const ResetPasswordSchema = z.object({
  email: z.email(),
  code: z.string().trim().regex(/^\d{6}$/),
  newPassword: z.string().min(8).max(255),
});

const PhoneSchema = z.string().trim().regex(/^(?:1[3-9]\d{9}|\+[1-9]\d{6,14})$/);
const OtpTargetTypeSchema = z.enum(["email", "phone"]);
const OtpSendSchema = z.object({
  target: z.string().trim().min(3).max(254),
  targetType: OtpTargetTypeSchema,
});
const OtpLoginSchema = OtpSendSchema.extend({
  code: z.string().trim().regex(/^\d{6}$/),
});
const PhoneForgotPasswordSchema = z.object({ phone: PhoneSchema });
const PhoneResetPasswordSchema = z.object({
  phone: PhoneSchema,
  code: z.string().trim().regex(/^\d{6}$/),
  newPassword: z.string().min(8).max(255),
});
const BindPhoneSchema = z.object({
  phone: PhoneSchema,
  currentPassword: z.string().min(1).max(255).optional(),
  reauthCode: z.string().trim().min(6).max(128).optional(),
}).refine((value) => Boolean(value.currentPassword || value.reauthCode), {
  message: "请输入当前密码或身份验证码",
});
const VerifyCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
const VerifyEmailSchema = z.object({ token: z.string().trim().min(6).max(2048) });
const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(255),
  newPassword: z.string().min(8).max(255),
});

const ActivationRedeemRequestSchema = z.object({
  code: z.string().trim().regex(/^H3(?:-[A-HJ-NP-Z2-9]{5}){4}$/).openapi({ example: "H3-ABCDE-FGHJK-MNPQR-STUVW" }),
  deviceId: z.string().regex(/^[a-f0-9]{64}$/).openapi({ example: "0".repeat(64) }),
  deviceName: z.string().trim().max(120).optional().openapi({ example: "CREATOR-PC" }),
  macHint: z.string().trim().max(32).optional().openapi({ example: "A1B2C3" }),
  ...Object.fromEntries(Object.entries(HardwareBindingV2RequestShape).map(([name, schema]) => [name, schema.optional()])),
});

const ActivationReceiptSchema = z.object({
  version: z.literal(1),
  licenseId: z.string(),
  product: z.string(),
  deviceId: z.string(),
  macHint: z.string().nullable(),
  activatedAt: z.string().datetime(),
  perpetual: z.literal(true),
  algorithm: z.literal("RS256"),
  signature: z.string(),
});

const DesktopRegistrationContextSchema = z.object({
  activation_receipt: z.union([z.string().trim().min(32).max(16_384), ActivationReceiptSchema]),
  app_version: z.string().trim().min(1).max(40),
  device_name: z.string().trim().min(1).max(120).optional(),
  os_version: z.string().trim().min(1).max(120).optional(),
  client_id: z.string().trim().min(3).max(128).optional(),
});
const DesktopEmailRegistrationSchema = DesktopRegistrationContextSchema.extend({
  email: z.email(),
  password: z.string().min(1).max(255),
  display_name: z.string().trim().min(1).max(64).optional(),
  invite_code: z.string().trim().max(64).optional(),
  client_id: z.string().trim().min(3).max(128),
});
const DesktopPhoneRegistrationBaseSchema = DesktopRegistrationContextSchema.extend({ phone: PhoneSchema });
const DesktopPhoneRegistrationSendSchema = DesktopPhoneRegistrationBaseSchema;
const DesktopPhoneRegistrationSchema = DesktopPhoneRegistrationBaseSchema.extend({
  code: z.string().trim().regex(/^\d{6}$/),
  display_name: z.string().trim().min(1).max(64).optional(),
});

async function requireAdmin(c) {
  let auth = await authenticate(c, { required: false });
  if (!auth && bearerToken(c) && !bearerToken(c).startsWith("gla_live_")) {
    const desktop = await authenticateDesktopChandler(c, { admin: true });
    if (desktop.error) return desktop;
    auth = {
      kind: "desktop-chandler",
      user: {
        ...desktop.user,
        id: desktop.user._id.toString(),
        role: desktop.identity.role,
        authProvider: "chandler",
      },
      session: null,
      desktop,
    };
  }
  if (!auth) return { error: c.json({ code: "UNAUTHORIZED", message: "请先登录或提供有效管理员凭据" }, 401) };
  if (auth.error) return auth;
  const locallyVerifiedAdmin = auth.user.role === "admin";
  if (auth.user.authProvider === "chandler" && auth.kind !== "desktop-chandler") {
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
      auth.chandlerWarning = localizeErrorMessage(error, "统一账号服务暂时不可用");
    }
  }
  if (auth.user.role !== "admin") {
    return { error: c.json({ code: "FORBIDDEN", message: "仅管理员可执行此操作" }, 403) };
  }
  return auth;
}

async function getAdminChandlerAccessToken(auth) {
  if (chandlerConfig().apiKey) return null;
  if (auth?.kind === "desktop-chandler" && auth.desktop?.accessToken) {
    return auth.desktop.accessToken;
  }
  return getChandlerAccessToken(auth?.session);
}

function requireTrustedMutation(c) {
  const authorization = String(c.req.header("authorization") || "");
  if (authorization.startsWith("Bearer ") && authorization.slice(7).trim()) return null;
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

function workflowTargetUrl(value) {
  const input = String(value || "").trim();
  if (input.startsWith("/") && !input.startsWith("//")) return input;
  return parseHttpUrl(input);
}

function workflowJson(workflow) {
  return {
    id: workflow._id.toString(),
    name: workflow.name,
    description: workflow.description || "",
    url: workflow.url,
    imageUrl: workflow.imageMode === "cos" ? `/api/workflows/${workflow._id}/image` : workflow.imageUrl,
    status: workflow.status || "active",
    sort: Number(workflow.sort || 0),
    systemKey: workflow.systemKey || null,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

async function ensureDefaultPublicWorkflows() {
  const tombstones = await getCollection("publicWorkflowTombstones");
  const deleted = await tombstones.findOne({ _id: "worker-market" }, { projection: { _id: 1 } });
  if (deleted) return;
  const workflows = await getCollection("publicWorkflows");
  const now = new Date();
  await workflows.updateOne(
    { systemKey: "worker-market" },
    {
      $setOnInsert: {
        name: "威客",
        description: "发布任务或接单赚钱，让 AI 攻城狮军团协同完成复杂交付。",
        url: "/worker?tab=publish",
        imageMode: "bundled",
        imageUrl: "/assets/workflow-worker-v1.png",
        status: "active",
        sort: 10,
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true },
  );
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
    plan: subscription.plan || "member",
    sku_name: subscription.plan === SHORT_VIDEO_PLAN_ID
      ? `${SHORT_VIDEO_PLAN_NAME} · ${subscription.cycle === "year" ? "年度" : "月度"}`
      : subscription.cycle === "year" ? "古龙年度会员" : subscription.cycle === "month" ? "古龙月度会员" : "古龙会员",
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
  const plan = attributes.subscription_plan === SHORT_VIDEO_PLAN_ID || attributes.plan_kind === SHORT_VIDEO_PLAN_ID
    ? SHORT_VIDEO_PLAN_ID
    : attributes.product_id || attributes.plan || "member";
  return {
    plan,
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
      ...(period.plan === SHORT_VIDEO_PLAN_ID ? { $unset: { allowanceExpiredAt: "", allowanceClearedFen: "" } } : {}),
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
    account_type: user.role === "admin" ? "administrator" : isMember && subscription?.plan === SHORT_VIDEO_PLAN_ID ? "short_video_member" : isMember ? "subscription_member" : "standard_user",
    is_member: isMember,
    subscription_plan: subscription?.plan || null,
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

function feedbackResponseAssetJson(asset, feedbackId = asset.feedbackId) {
  const resolvedFeedbackId = feedbackId?.toString?.() || String(feedbackId || "");
  return {
    id: asset._id?.toString?.() || String(asset.id || ""),
    filename: asset.filename,
    contentType: asset.contentType,
    bytes: asset.bytes,
    kind: String(asset.contentType || "").startsWith("video/") ? "video" : "image",
    url: `/api/feedback/${resolvedFeedbackId}/assets/${asset._id?.toString?.() || asset.id}`,
    createdAt: asset.createdAt,
  };
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

function subscriptionLifecycle(subscription, now = new Date()) {
  const status = subscription
    ? subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd, now)
    : "inactive";
  const end = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const remainingMs = end && !Number.isNaN(end.getTime()) ? end.getTime() - now.getTime() : null;
  const daysRemaining = remainingMs === null ? null : Math.max(0, Math.ceil(remainingMs / 86_400_000));
  return {
    status,
    plan: subscription?.plan || null,
    restricted: status === "expired",
    renewalDue: status === "active" && daysRemaining !== null && daysRemaining <= RENEWAL_REMINDER_DAYS,
    daysRemaining,
    currentPeriodEnd: end,
    renewalMode: "manual",
  };
}

async function refreshSubscriptionLifecycle(ownerId, now = new Date()) {
  const subscriptions = await getCollection("subscriptions");
  const subscription = await subscriptions.findOne({ ownerId });
  const lifecycle = subscriptionLifecycle(subscription, now);
  if (!subscription) return lifecycle;

  if (subscription.plan === SHORT_VIDEO_PLAN_ID && lifecycle.status === "expired") {
    await expireShortVideoPackageAllowance({ getCollection, ownerId, subscription, now });
  }

  if (subscription.status !== lifecycle.status || subscription.autoRenew) {
    await subscriptions.updateOne(
      { _id: subscription._id },
      { $set: { status: lifecycle.status, autoRenew: false, statusEvaluatedAt: now, updatedAt: now } },
    );
  }

  if (lifecycle.renewalDue) {
    const reminderDate = now.toISOString().slice(0, 10);
    await (await getCollection("notifications")).updateOne(
      { ownerId, type: "subscription_renewal_due", reminderDate },
      {
        $setOnInsert: {
          title: `会员将在 ${lifecycle.daysRemaining} 天后到期`,
          message: `当前套餐将于 ${lifecycle.currentPeriodEnd.toLocaleDateString("zh-CN")} 到期。Chandler 暂不支持自动扣款，请及时使用微信手动续费。`,
          actionPath: "/pricing",
          readAt: null,
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true },
    );
  }
  return lifecycle;
}

async function sendDailyRenewalReminders(now = new Date()) {
  const upperBound = new Date(now.getTime() + RENEWAL_REMINDER_DAYS * 86_400_000);
  const subscriptions = await getCollection("subscriptions");
  const expiring = await subscriptions.find({
    currentPeriodEnd: { $gt: now, $lte: upperBound },
    status: { $nin: ["cancelled", "canceled", "expired"] },
  }, { projection: { ownerId: 1 } }).limit(10_000).toArray();
  await mapWithConcurrency(expiring, 12, (item) => refreshSubscriptionLifecycle(item.ownerId, now));
  const expiredShortVideo = await subscriptions.find({
    plan: SHORT_VIDEO_PLAN_ID,
    currentPeriodEnd: { $lte: now },
    allowanceExpiredAt: { $exists: false },
  }, { projection: { ownerId: 1 } }).limit(10_000).toArray();
  await mapWithConcurrency(expiredShortVideo, 12, (item) => refreshSubscriptionLifecycle(item.ownerId, now));
  const expired = await subscriptions.updateMany(
    { currentPeriodEnd: { $lte: now }, status: { $nin: ["expired", "cancelled", "canceled"] } },
    { $set: { status: "expired", autoRenew: false, statusEvaluatedAt: now, updatedAt: now } },
  );
  return { reminded: expiring.length, expired: expired.modifiedCount, shortVideoAllowancesCleared: expiredShortVideo.length, evaluatedAt: now };
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

function desktopChandlerApplication(applicationKey, themeName = "") {
  const editionKey = applicationKey === "airos-eternal-flower" ? "yongshenghua" : "gulong";
  const target = chandlerApplicationTargets().find((item) => item.editionKey === editionKey);
  if (!target?.id) throw new ChandlerError("订阅应用尚未配置", { status: 503, code: "CHANDLER_APPLICATION_REQUIRED" });
  return {
    key: editionKey === "yongshenghua" ? "airos-eternal-flower" : "gulong",
    name: editionKey === "yongshenghua" ? "爱若斯-永生花" : "古龙智能引擎",
    clientId: target.id,
    themeName: String(themeName || (editionKey === "yongshenghua" ? "永生花" : "上古神龙")).trim(),
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
        kind: "subscription",
        cycle: candidate.cycle,
        subscriptionPlan: candidate.subscriptionPlan,
        amountFen: candidate.amountFen,
        promotionBonusFen: Number(candidate.partnerData.promotion_bonus_fen || 0),
        creditedFen: Number(candidate.partnerData.wallet_credit_fen || candidate.amountFen),
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
  const isRecharge = order.kind === "recharge";
  const isShortVideoSubscription = !isRecharge && (order.subscriptionPlan === SHORT_VIDEO_PLAN_ID || order.partnerData?.subscription_plan === SHORT_VIDEO_PLAN_ID);
  const promotionBonusFen = isShortVideoSubscription
    ? 0
    : paymentPromotionBonusFen({ amountFen: order.amountFen, kind: isRecharge ? "recharge" : "subscription_payment" });
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
  if (!isRecharge && end <= start) return { error: { code: "VALIDATION_ERROR", message: "订阅截止日期必须晚于生效日期", status: 400 } };
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
    ...(!isRecharge ? [(await getCollection("subscriptions")).updateOne(
      { ownerId: order.ownerId },
      { $set: { plan: isShortVideoSubscription ? SHORT_VIDEO_PLAN_ID : "member", cycle: order.cycle, provider: "offline", status: "active", currentPeriodStart: start, currentPeriodEnd: end, autoRenew: false, updatedAt: now }, $unset: { allowanceExpiredAt: "", allowanceClearedFen: "" }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    )] : []),
    (await getCollection("notifications")).updateOne(
      { ownerId: order.ownerId, type: "offline_payment_approved", orderId: order._id },
      { $set: { title: "线下支付审核已通过", message: isRecharge ? `订单 ${order.orderNo} 已确认到账，实付余额${promotionBonusFen ? `及赠送的 ${(promotionBonusFen / 100).toFixed(2)} 元` : ""}已经入账。` : isShortVideoSubscription ? `订单 ${order.orderNo} 已确认到账，短视频包月权益已生效，实付金额已按 1:1 计入可用余额。` : `订单 ${order.orderNo} 已确认到账，会员权益与赠送的 ${(promotionBonusFen / 100).toFixed(2)} 元余额已经生效。`, orderNo: order.orderNo, readAt: null, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    ),
    ...(isRecharge
      ? [creditPaymentBalanceWithPromotion({ ownerId: order.ownerId, amountFen: order.amountFen, source: "offline_recharge", sourceId: order.orderNo, kind: "recharge" })]
      : isShortVideoSubscription
        ? [creditShortVideoSubscriptionBalance({ getCollection, ownerId: order.ownerId, amountFen: order.amountFen, source: "offline_short_video_subscription", sourceId: order.orderNo, expiresAt: end })]
        : [creditPaymentBalanceWithPromotion({ ownerId: order.ownerId, amountFen: order.amountFen, source: "offline_subscription", sourceId: order.orderNo, kind: "subscription_payment" })]),
  ]);
  if (accessToken && order.chandlerOrderNo) {
    const applicationId = order.applicationId || chandlerConfig().applicationId;
    await chandlerRequest(`/v1/me/orders/${encodeURIComponent(order.chandlerOrderNo)}/partner-data?client_id=${encodeURIComponent(applicationId)}`, { method: "PUT", accessToken, body: { partner_data: partnerData } }).catch(() => null);
  }
  if (!isRecharge && accessToken && order.chandlerUserId) {
    try {
      const applicationId = order.applicationId || chandlerConfig().applicationId;
      const path = `/v1/me/oauth/clients/${encodeURIComponent(applicationId)}/users/${encodeURIComponent(order.chandlerUserId)}/attributes`;
      const current = await chandlerRequest(path, { accessToken });
      const attributes = current.attributes && typeof current.attributes === "object" ? current.attributes : {};
      await chandlerRequest(path, { method: "PUT", accessToken, body: { attributes: { ...attributes, subscription_status: "active", subscription_plan: isShortVideoSubscription ? SHORT_VIDEO_PLAN_ID : "member", plan_kind: isShortVideoSubscription ? SHORT_VIDEO_PLAN_ID : order.cycle === "year" ? "yearly" : "monthly", subscription_source: "offline_review", subscription_order_no: order.orderNo, subscription_valid_from: start.toISOString(), subscription_valid_until: end.toISOString(), subscription_valid_from_unix_ms: start.getTime(), subscription_valid_until_unix_ms: end.getTime(), subscription_reviewed_at_unix_ms: now.getTime() } } });
    } catch { /* Website MongoDB remains authoritative and desktop reads it directly. */ }
  }
  return { ok: true, orderNo: order.orderNo, status: "approved", planType: isShortVideoSubscription ? SHORT_VIDEO_PLAN_ID : isRecharge ? null : "member", creditedFen: order.amountFen + promotionBonusFen, bonusFen: promotionBonusFen, ...(isRecharge ? {} : { validFrom: start, validUntil: end }), message: isRecharge ? "审核已通过，充值余额与符合条件的赠送金额已经入账并可由桌面端立即同步" : isShortVideoSubscription ? "审核已通过，短视频包月权益与实付等额余额已经生效并可由桌面端立即同步" : "审核已通过，会员权益与 10% 赠送余额已经生效并可由桌面端立即同步" };
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
const DesktopPhoneRegistrationResponseSchema = z.object({
  status: z.literal("registered"),
  auth: z.object({
    access_token: z.string(),
    refresh_token: z.string().nullable(),
    token_type: z.string(),
    expires_in: z.number().int().positive(),
  }),
  user: PublicUserSchema,
});

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
  summary: "修改用户订阅类型与会员有效期",
  description: "由管理员设置会员用户或短视频包月用户，并精确配置生效与到期时间；官网与桌面端均以该时间段为准，并尽力同步 Chandler 用户属性。",
  request: {
    params: z.object({ id: z.string().min(1).max(100) }),
    body: { content: { "application/json": { schema: z.object({
      plan: z.enum(["member", SHORT_VIDEO_PLAN_ID]).optional(),
      currentPeriodStart: z.string().datetime(),
      currentPeriodEnd: z.string().datetime(),
    }) } } },
  },
  responses: {
    200: { description: "会员有效期已更新", content: { "application/json": { schema: z.object({
      ok: z.literal(true),
      userId: z.string(),
      plan: z.enum(["member", SHORT_VIDEO_PLAN_ID]),
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
  priorityProvider: z.literal("wechat"),
  channels: z.object({
    wechat: z.object({ enabled: z.boolean(), status: z.enum(["available", "coming_soon", "planned"]), label: z.string(), message: z.string() }),
  }),
});

const getSubscriptionPricingRoute = createRoute({
  method: "get",
  path: "/api/v1/pricing/subscriptions",
  tags: ["Desktop Synchronization"],
  summary: "桌面端实时同步订阅价格",
  description: "公开返回古龙官网当前生效的会员价格及短视频包月固定价格。管理员发布会员价格后立即更新；响应禁止缓存，桌面端应在打开订阅页时重新拉取。",
  security: [],
  responses: {
    200: { description: "当前生效的订阅价格与支付渠道快照", content: { "application/json": { schema: z.object({ revision: z.string(), currency: z.literal("CNY"), monthly: SubscriptionPricePointSchema, yearly: SubscriptionPricePointSchema, shortVideo: z.object({ id: z.literal("short_video_monthly"), name: z.literal("短视频包月"), monthlyFen: z.number().int(), yearlyFen: z.number().int(), paymentProviders: z.array(z.literal("offline")), walletCreditMultiplier: z.literal(1), unlimitedModel: z.literal("minimax_h3_shared") }), updatedAt: z.coerce.date(), paymentAvailability: PaymentAvailabilitySchema }) } } },
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
  description: "使用当前 Chandler Bearer Token 映射官网账号，返回 MongoDB 权威订阅状态；短视频包月返回剩余套餐额度和 H3 无限使用标记，线下订单通过后桌面端下次轮询即可立即解锁。",
  security: [{ bearerAuth: [] }],
  responses: { 200: { description: "实时订阅状态", content: { "application/json": { schema: z.object({ isMember: z.boolean(), balanceFen: z.number().int(), shortVideoPackage: z.object({ active: z.boolean(), unlimitedH3: z.boolean(), packageBalanceFen: z.number().int(), packageExpiresAt: z.coerce.date().nullable(), chargeMode: z.literal("deduct_until_exhausted_then_free") }), subscription: z.record(z.string(), z.unknown()).nullable(), checkedAt: z.coerce.date() }) } } }, 401: { description: "Chandler 登录失效", content: { "application/json": { schema: ErrorSchema } } } },
});

const RollingUsageDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  usedFen: z.number().int().min(0),
  calls: z.number().int().min(0),
});
const RollingUsageWindowSchema = z.object({
  rollingDays: z.number().int().min(1),
  usedFen: z.number().int().min(0),
  calls: z.number().int().min(0),
  days: z.array(RollingUsageDaySchema),
});
const UsageEstimateSchema = z.object({
  minimum: z.number().int().min(0),
  maximum: z.number().int().min(0),
  cheapestUnitFen: z.number().int().min(0),
  mostExpensiveUnitFen: z.number().int().min(0),
}).nullable();
const desktopAccountUsageRoute = createRoute({
  method: "get",
  path: "/api/v1/desktop/account/usage",
  tags: ["Desktop Synchronization"],
  summary: "读取官网剩余用量面板数据",
  description: "使用桌面端当前 Chandler Bearer Token，返回与官网右上角“剩余用量”面板同口径的钱包余额、图片/视频预计创作范围，以及滚动 7 天和 30 天真实用量。金额均为整数分。",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "当前账户剩余用量",
      content: { "application/json": { schema: z.object({
        currency: z.literal("CNY"),
        quota: z.object({
          balanceFen: z.number().int().min(0),
          unlimited: z.boolean(),
          estimates: z.object({ images: UsageEstimateSchema, videos: UsageEstimateSchema }),
          weekly: RollingUsageWindowSchema,
          monthly: RollingUsageWindowSchema,
        }),
        subscription: z.object({
          active: z.boolean(),
          restricted: z.boolean(),
          plan: z.string().nullable(),
          currentPeriodEnd: z.coerce.date().nullable(),
        }),
        shortVideoPackage: z.object({
          active: z.boolean(),
          unlimitedH3: z.boolean(),
          packageBalanceFen: z.number().int().min(0),
          packageExpiresAt: z.coerce.date().nullable(),
          chargeMode: z.literal("deduct_until_exhausted_then_free"),
        }),
        checkedAt: z.coerce.date(),
      }) } },
    },
    401: { description: "Chandler 登录失效", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const DesktopChandlerApplicationKeySchema = z.enum(["gulong", "airos-eternal-flower"]);

const desktopChandlerCatalogRoute = createRoute({
  method: "get",
  path: "/api/v1/desktop/chandler/catalog",
  tags: ["Desktop Synchronization"],
  summary: "通过官网服务端凭据读取 Chandler 订阅目录",
  security: [{ bearerAuth: [] }],
  request: { query: z.object({ applicationKey: DesktopChandlerApplicationKeySchema, themeName: z.string().max(100).optional() }) },
  responses: {
    200: { description: "订阅目录", content: { "application/json": { schema: z.object({ plans: z.array(z.record(z.string(), z.unknown())) }) } } },
    401: { description: "登录失效", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopChandlerPublishPriceRoute = createRoute({
  method: "post",
  path: "/api/v1/desktop/chandler/prices",
  tags: ["Desktop Synchronization"],
  summary: "通过官网服务端凭据发布 Chandler 价格版本",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: z.object({ applicationKey: DesktopChandlerApplicationKeySchema, themeName: z.string().max(100).optional(), skuId: z.string().min(1).max(100), amountFen: z.number().int().min(SUBSCRIPTION_PRICE_MIN_FEN).max(SUBSCRIPTION_PRICE_MAX_FEN), effectiveAt: z.string().datetime() }) } } } },
  responses: {
    201: { description: "价格版本", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "登录失效", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopChandlerCheckoutRoute = createRoute({
  method: "post",
  path: "/api/v1/desktop/chandler/checkout",
  tags: ["Desktop Synchronization"],
  summary: "通过官网服务端凭据创建桌面端在线订阅订单",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: z.object({ applicationKey: DesktopChandlerApplicationKeySchema, themeName: z.string().max(100), planKind: z.enum(["monthly", "yearly"]), channel: z.literal("wechat"), expectedAmountFen: z.number().int().min(SUBSCRIPTION_PRICE_MIN_FEN).max(SUBSCRIPTION_PRICE_MAX_FEN), clientOrderNo: z.string().min(16).max(200), releaseChannel: z.string().min(1).max(100) }) } } } },
  responses: {
    201: { description: "待支付订单", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "登录失效", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "价格已变化", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopChandlerOrderStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/desktop/chandler/orders/{orderNo}",
  tags: ["Desktop Synchronization"],
  summary: "查询当前桌面用户的在线订阅订单",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ orderNo: z.string().min(1).max(200) }) },
  responses: {
    200: { description: "订单状态", content: { "application/json": { schema: z.object({ orderNo: z.string(), status: z.string(), paid: z.boolean() }) } } },
    401: { description: "登录失效", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "订单不存在", content: { "application/json": { schema: ErrorSchema } } },
  },
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
  description: "通过 Chandler v3.2 应用级单次价格版本接口在远程服务器创建不可变价格版本；远程成功后镜像到官网 MongoDB，会员周期由古龙业务账本维护。",
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
  description: "对应 Chandler v3.2 POST /v1/me/oauth/clients/{client_id}/skus，仅应用 owner/admin 可执行。",
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

const adminExportUnusedActivationCodesRoute = createRoute({
  method: "post",
  path: "/api/admin/activation-codes/export-unused",
  tags: ["Admin · Activation"],
  summary: "批量导出未使用激活码",
  description: "仅管理员可调用。服务端实时筛选未使用授权，并生成 UTF-8 TXT 文件；已使用和已停用授权不会出现在文件中。",
  responses: {
    200: { description: "每行一个完整激活码的 TXT 文件", content: { "text/plain": { schema: z.string() } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员或来源不受信任", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "当前没有未使用激活码", content: { "application/json": { schema: ErrorSchema } } },
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

const shortDramaSsoRoute = createRoute({
  method: "post",
  path: "/api/auth/short-drama-sso",
  tags: ["Authentication"],
  summary: "为短剧生产站签发一次性登录票据",
  responses: {
    200: { description: "票据签发成功", content: { "application/json": { schema: ShortDramaSsoResponseSchema } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "来源不受信任", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const forgotPasswordRoute = createRoute({
  method: "post",
  path: "/api/auth/forgot-password",
  tags: ["Authentication"],
  summary: "发送找回密码邮件",
  description: "通过 Chandler v3.9 统一身份服务向邮箱发送 6 位数字验证码。无论邮箱是否存在，成功受理时都返回相同响应，防止账号枚举。",
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
  description: "校验邮件中的 6 位数字验证码并设置新密码。成功后吊销该用户在古龙官网与 Chandler 的既有登录会话。",
  request: { body: { content: { "application/json": { schema: ResetPasswordSchema } } } },
  responses: {
    200: { description: "密码已重置", content: { "application/json": { schema: z.object({ status: z.literal("reset"), message: z.string() }) } } },
    400: { description: "验证码无效或过期", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "新密码强度不足", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "尝试过于频繁", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const AuthCapabilitiesResponseSchema = z.object({
  smsOtpEnabled: z.boolean(),
  emailOtpEnabled: z.literal(true),
  phoneRegistrationEnabled: z.boolean(),
  desktopPhoneRegistrationRequiresActivation: z.literal(true),
  otpCodeLength: z.literal(6),
});
const IdentitySchema = z.object({
  id: z.string(),
  provider: z.enum(["email", "phone", "wechat"]),
  value: z.string(),
  verified: z.boolean(),
  isPrimary: z.boolean(),
  createdAt: z.string().nullable(),
});
const AccountSecurityResponseSchema = z.object({
  profile: z.object({
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    mfaEnabled: z.boolean(),
  }),
  capabilities: AuthCapabilitiesResponseSchema,
  identities: z.array(IdentitySchema),
});

const authCapabilitiesRoute = createRoute({
  method: "get",
  path: "/api/auth/capabilities",
  tags: ["Authentication"],
  summary: "查询验证码登录能力",
  description: "实时读取 Chandler v3.9 能力开关。官网仍只开放邮箱注册；已激活桌面客户端可通过受控服务端代理进行邮箱或手机号注册，OAuth 客户端密钥不会下发到桌面端。",
  responses: { 200: { description: "认证能力", content: { "application/json": { schema: AuthCapabilitiesResponseSchema } } } },
});

const otpSendRoute = createRoute({
  method: "post",
  path: "/api/auth/otp/send",
  tags: ["Authentication"],
  summary: "发送邮箱或手机登录验证码",
  description: "固定成功语义避免账号枚举；官网按 IP 与目标摘要双重限流，客户端需等待 60 秒后再重发。",
  request: { body: { content: { "application/json": { schema: OtpSendSchema } } } },
  responses: {
    200: { description: "验证码请求已受理", content: { "application/json": { schema: z.object({ status: z.literal("sent"), retryAfter: z.literal(60) }) } } },
    400: { description: "目标格式不正确", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "发送过于频繁", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const otpLoginRoute = createRoute({
  method: "post",
  path: "/api/auth/otp/login",
  tags: ["Authentication"],
  summary: "使用邮箱或手机验证码登录",
  request: { body: { content: { "application/json": { schema: OtpLoginSchema } } } },
  responses: {
    200: { description: "登录成功", content: { "application/json": { schema: AuthResponseSchema } } },
    401: { description: "验证码错误或过期", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "尝试过于频繁", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const phoneForgotPasswordRoute = createRoute({
  method: "post",
  path: "/api/auth/phone/forgot-password",
  tags: ["Authentication"],
  summary: "发送手机密码重置验证码",
  description: "仅适用于已经绑定手机号的邮箱账号；无论账号是否存在均返回相同结果。",
  request: { body: { content: { "application/json": { schema: PhoneForgotPasswordSchema } } } },
  responses: {
    202: { description: "请求已受理", content: { "application/json": { schema: z.object({ status: z.literal("accepted"), retryAfter: z.literal(60) }) } } },
    429: { description: "发送过于频繁", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const phoneResetPasswordRoute = createRoute({
  method: "post",
  path: "/api/auth/phone/reset-password",
  tags: ["Authentication"],
  summary: "使用短信验证码重置密码",
  request: { body: { content: { "application/json": { schema: PhoneResetPasswordSchema } } } },
  responses: {
    200: { description: "密码已重置", content: { "application/json": { schema: z.object({ status: z.literal("reset"), message: z.string() }) } } },
    401: { description: "验证码错误或过期", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "新密码强度不足", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopPhoneRegistrationSendRoute = createRoute({
  method: "post",
  path: "/api/v1/desktop/auth/phone/send-otp",
  tags: ["Desktop Authentication"],
  summary: "已激活桌面客户端发送手机号注册验证码",
  description: "先校验 RS256 激活回执，再由古龙服务端代持 Chandler OAuth 客户端密钥发送 6 位短信验证码。响应与日志不会返回 OAuth 密钥，也不会保存原始设备 MAC。",
  request: { body: { required: true, content: { "application/json": { schema: DesktopPhoneRegistrationSendSchema } } } },
  responses: {
    202: { description: "短信发送请求已受理", content: { "application/json": { schema: z.object({ status: z.literal("accepted"), retryAfter: z.literal(60), codeLength: z.literal(6) }) } } },
    400: { description: "手机号或参数不正确", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "激活回执无效", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "手机号已经注册，请改用手机号验证码登录", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "发送过于频繁", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "短信能力或服务端 OAuth 配置未启用", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopEmailRegistrationRoute = createRoute({
  method: "post",
  path: "/api/v1/desktop/auth/email/register",
  tags: ["Desktop Authentication"],
  summary: "已激活桌面客户端代用户邮箱注册并记录应用来源",
  description: "校验 RS256 激活回执后，由古龙官网服务端注入对应 Chandler OAuth 应用凭证。client_secret 永不进入桌面客户端。",
  request: { body: { required: true, content: { "application/json": { schema: DesktopEmailRegistrationSchema } } } },
  responses: {
    201: { description: "邮箱账号注册成功", content: { "application/json": { schema: z.object({ access_token: z.string(), refresh_token: z.string().nullable(), token_type: z.string(), expires_in: z.number(), user: z.record(z.string(), z.unknown()) }) } } },
    400: { description: "邮箱、应用或参数不正确", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "激活回执无效", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "邮箱已经注册", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "注册尝试过于频繁", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "对应应用的归因凭证未配置", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const desktopPhoneRegistrationRoute = createRoute({
  method: "post",
  path: "/api/v1/desktop/auth/phone/register",
  tags: ["Desktop Authentication"],
  summary: "已激活桌面客户端使用手机号和 6 位验证码注册",
  description: "服务端以激活回执中的稳定匿名 deviceId 作为 Chandler install_id；客户端上报内容不能覆盖该设备身份。成功后返回可由桌面端安全存储的 Chandler 登录令牌与古龙用户摘要。",
  request: { body: { required: true, content: { "application/json": { schema: DesktopPhoneRegistrationSchema } } } },
  responses: {
    201: { description: "手机号账号注册成功", content: { "application/json": { schema: DesktopPhoneRegistrationResponseSchema } } },
    400: { description: "验证码或参数不正确", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "激活回执无效", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "手机号已经注册", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "验证尝试过于频繁", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "服务端 OAuth 配置未启用", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const accountSecurityRoute = createRoute({
  method: "get",
  path: "/api/account/security",
  tags: ["Account Security"],
  summary: "查看邮箱验证与绑定身份",
  responses: {
    200: { description: "账号安全信息", content: { "application/json": { schema: AccountSecurityResponseSchema } } },
    401: { description: "需要登录", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const sendVerificationEmailRoute = createRoute({
  method: "post",
  path: "/api/account/security/email/send-verification",
  tags: ["Account Security"],
  summary: "重新发送邮箱验证邮件",
  responses: { 202: { description: "邮件已受理", content: { "application/json": { schema: z.object({ status: z.literal("accepted"), retryAfter: z.literal(60) }) } } } },
});

const verifyAccountEmailRoute = createRoute({
  method: "post",
  path: "/api/account/security/email/verify",
  tags: ["Account Security"],
  summary: "验证注册邮箱",
  request: { body: { content: { "application/json": { schema: VerifyEmailSchema } } } },
  responses: { 200: { description: "验证成功", content: { "application/json": { schema: z.object({ status: z.literal("verified") }) } } } },
});

const bindPhoneRoute = createRoute({
  method: "post",
  path: "/api/account/security/phone/bind",
  tags: ["Account Security"],
  summary: "绑定手机号并发送验证短信",
  description: "要求当前 Chandler 账号已有已验证邮箱；手机号不会作为注册入口。",
  request: { body: { content: { "application/json": { schema: BindPhoneSchema } } } },
  responses: {
    201: { description: "手机号身份已创建并发送验证码", content: { "application/json": { schema: z.object({ identity: IdentitySchema, retryAfter: z.literal(60) }) } } },
    403: { description: "邮箱尚未验证", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "手机号已绑定", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const verifyIdentityRoute = createRoute({
  method: "post",
  path: "/api/account/security/identities/{identityId}/verify",
  tags: ["Account Security"],
  summary: "验证绑定手机号",
  request: {
    params: z.object({ identityId: z.string().min(1).max(128) }),
    body: { content: { "application/json": { schema: VerifyCodeSchema } } },
  },
  responses: { 200: { description: "验证成功", content: { "application/json": { schema: z.object({ status: z.literal("verified") }) } } } },
});

const deleteIdentityRoute = createRoute({
  method: "delete",
  path: "/api/account/security/identities/{identityId}",
  tags: ["Account Security"],
  summary: "解绑手机号",
  description: "官网只允许解绑手机号，不能通过该接口删除注册邮箱。",
  request: { params: z.object({ identityId: z.string().min(1).max(128) }) },
  responses: { 200: { description: "解绑成功", content: { "application/json": { schema: z.object({ status: z.literal("deleted") }) } } } },
});

const sendReauthCodeRoute = createRoute({
  method: "post",
  path: "/api/account/security/reauth/send",
  tags: ["Account Security"],
  summary: "发送敏感操作再认证码",
  description: "用于无密码账号绑定新身份；验证码发送到当前已验证主身份。",
  responses: {
    200: { description: "验证码已发送", content: { "application/json": { schema: z.object({ status: z.string(), provider: z.string().optional(), value: z.string().optional(), retryAfter: z.literal(60) }) } } },
    401: { description: "需要登录", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "发送过于频繁", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const setPrimaryIdentityRoute = createRoute({
  method: "post",
  path: "/api/account/security/identities/{identityId}/primary",
  tags: ["Account Security"],
  summary: "设置已验证主身份",
  request: { params: z.object({ identityId: z.string().min(1).max(128) }) },
  responses: {
    200: { description: "主身份已更新", content: { "application/json": { schema: z.object({ status: z.literal("primary") }) } } },
    404: { description: "身份不存在", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const changePasswordRoute = createRoute({
  method: "post",
  path: "/api/account/security/password/change",
  tags: ["Account Security"],
  summary: "登录状态下修改密码",
  request: { body: { content: { "application/json": { schema: ChangePasswordSchema } } } },
  responses: {
    200: { description: "密码已修改", content: { "application/json": { schema: z.object({ status: z.literal("changed") }) } } },
    401: { description: "当前密码错误", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "新密码强度不足", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const logoutAllRoute = createRoute({
  method: "post",
  path: "/api/account/security/sessions/logout-all",
  tags: ["Account Security"],
  summary: "注销账号的全部登录会话",
  responses: {
    200: { description: "全部会话已注销", content: { "application/json": { schema: z.object({ status: z.literal("logged_out") }) } } },
    401: { description: "需要登录", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function normalizedPhone(value) {
  const phone = String(value || "").trim().replace(/[\s()-]/g, "");
  return /^1[3-9]\d{9}$/.test(phone) ? `+86${phone}` : phone;
}

function otpTarget(input) {
  if (input.targetType === "email") {
    const email = String(input.target || "").trim().toLowerCase();
    if (!z.email().safeParse(email).success) throw new ChandlerError("请输入有效的邮箱地址", { status: 400, code: "request.invalid" });
    return email;
  }
  const phone = normalizedPhone(input.target);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new ChandlerError("请输入正确的大陆手机号或 E.164 国际手机号", { status: 400, code: "auth.invalid_phone" });
  return phone;
}

function maskedIdentityValue(provider, rawValue) {
  const value = String(rawValue || "");
  if (!value || value.includes("*")) return value;
  if (provider === "phone") return `${value.slice(0, Math.min(3, value.length))}••••${value.slice(-4)}`;
  if (provider === "email") {
    const [local, domain] = value.split("@");
    if (!domain) return value;
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return "已绑定";
}

function publicIdentity(identity) {
  return {
    id: String(identity?.id || ""),
    provider: ["email", "phone", "wechat"].includes(identity?.provider) ? identity.provider : "email",
    value: maskedIdentityValue(identity?.provider, identity?.value),
    verified: Boolean(identity?.verified),
    isPrimary: Boolean(identity?.is_primary ?? identity?.isPrimary),
    createdAt: identity?.created_at || identity?.createdAt || null,
  };
}

function chandlerIdentities(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.identities)) return payload.identities;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function chandlerIdentity(payload) {
  return payload?.identity || payload?.item || payload;
}

async function currentAuthCapabilities({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && authCapabilitiesCache.value && authCapabilitiesCache.expiresAt > now) return authCapabilitiesCache.value;
  let smsOtpEnabled = false;
  try {
    const remote = await getChandlerAuthCapabilities();
    smsOtpEnabled = remote?.sms_otp_enabled === true;
  } catch {
    // Fail closed: a Chandler outage must hide the SMS entry instead of
    // presenting a flow that cannot deliver a code.
  }
  const value = {
    smsOtpEnabled,
    emailOtpEnabled: true,
    phoneRegistrationEnabled: smsOtpEnabled && isChandlerPhoneRegistrationConfigured(),
    desktopPhoneRegistrationRequiresActivation: true,
    otpCodeLength: 6,
  };
  authCapabilitiesCache = { value, expiresAt: now + 60_000 };
  return value;
}

async function recordDesktopPhoneAuthAudit(action, activationPayload, phone, details = {}) {
  try {
    await (await getCollection("authAudit")).insertOne({
      action,
      product: activationPayload.product,
      licenseId: new ObjectId(activationPayload.licenseId),
      deviceIdHash: hashOpaqueToken(activationPayload.deviceId, "desktop-phone-auth-device"),
      phoneHash: hashOpaqueToken(normalizedPhone(phone), "desktop-phone-auth-phone"),
      ...details,
      createdAt: new Date(),
    });
  } catch {
    // Authentication must not fail solely because the audit sink is briefly unavailable.
  }
}

async function recordDesktopEmailAuthAudit(action, activationPayload, email, details = {}) {
  try {
    await (await getCollection("authAudit")).insertOne({
      action,
      product: activationPayload.product,
      licenseId: new ObjectId(activationPayload.licenseId),
      deviceIdHash: hashOpaqueToken(activationPayload.deviceId, "desktop-email-auth-device"),
      emailHash: hashOpaqueToken(normalizeEmail(email), "desktop-email-auth-email"),
      ...details,
      createdAt: new Date(),
    });
  } catch {
    // Authentication must not fail solely because the audit sink is briefly unavailable.
  }
}

async function verifiedDesktopPhoneRegistrationRequest(input, action) {
  const activation = await verifyActivationReceipt(input.activation_receipt);
  const phone = normalizedPhone(input.phone);
  const application = desktopRegistrationApplication(input.client_id, activation.payload);
  await recordDesktopPhoneAuthAudit(`${action}_requested`, activation.payload, phone, { appVersion: input.app_version, applicationId: application.id });
  return { activation, phone, application };
}

function activationRegistrationEdition(activationPayload) {
  const product = String(activationPayload?.product || "").trim().toLowerCase();
  if (!product) return null;
  if (product.includes("minimax-h3") || product.includes("yongshenghua") || product.includes("airos")) return "yongshenghua";
  if (product.includes("gulong") || product.includes("古龙")) return "gulong";
  return null;
}

function desktopRegistrationApplication(clientId, activationPayload) {
  const requested = String(clientId || chandlerConfig().applicationId || "").trim();
  const target = chandlerApplicationTargets().find((item) => item.id === requested);
  if (!target) {
    throw new ChandlerError("桌面客户端提交了未登记的 Chandler 应用", { status: 400, code: "CHANDLER_APPLICATION_INVALID" });
  }
  const activationEdition = activationRegistrationEdition(activationPayload);
  if (activationEdition && target.editionKey !== activationEdition) {
    throw new ChandlerError("桌面客户端应用与激活授权不匹配", { status: 403, code: "CHANDLER_APPLICATION_ACTIVATION_MISMATCH" });
  }
  return target;
}

function publicWebsiteUser(user) {
  return {
    id: user._id.toString(),
    username: user.username || null,
    email: user.email || null,
    displayName: user.displayName || null,
    avatar: user.avatar || null,
    authProvider: "chandler",
    role: user.role,
    edition: { key: user.editionKey, name: user.editionName, source: user.editionSource },
    createdAt: user.createdAt,
  };
}

async function establishChandlerWebsiteSession(c, chandlerAuth, { username, phone } = {}) {
  const identity = await resolveChandlerIdentity(chandlerAuth.user, chandlerAuth.access_token);
  const user = await upsertChandlerUser(chandlerAuth.user, { username, identity, defaultEdition: "gulong" });
  if (phone) {
    await (await getCollection("users")).updateOne(
      { _id: user._id },
      { $set: { chandlerPhoneHash: hashOpaqueToken(normalizedPhone(phone), "chandler-phone"), updatedAt: new Date() } },
    );
  }
  await issueSession(c, user._id, { externalAuth: externalAuthFromResponse(chandlerAuth) });
  return publicWebsiteUser(user);
}

async function requireChandlerAccountSession(c) {
  const auth = await authenticate(c);
  if (auth.error) return auth;
  if (auth.kind !== "session" || auth.user.authProvider !== "chandler") {
    return { error: c.json({ code: "CHANDLER_SESSION_REQUIRED", message: "请使用 Chandler 统一账号登录后管理账号安全" }, 401) };
  }
  return { auth, accessToken: await getChandlerAccessToken(auth.session) };
}

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
      { code: error.code, message: localizeErrorMessage(error, "统一账号服务暂时不可用，请稍后重试"), requestId: c.get("requestId") },
      error.status,
    );
  }
  if (error instanceof ConfigurationError || error.code === "CONFIG_REQUIRED") {
    return c.json(
      { code: "CONFIG_REQUIRED", message: localizeErrorMessage(error, "服务配置尚未完成，请联系管理员"), requestId: c.get("requestId") },
      503,
    );
  }
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && typeof error?.code === "string") {
    return c.json(
      { code: error.code, message: localizeErrorMessage(error, "请求未通过安全校验，请检查后重试"), requestId: c.get("requestId") },
      error.status,
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

registerPearApiRoutes(app, { authenticate, requireAdmin, requireTrustedMutation });
registerH3SharedRoutes(app, { authenticate, requireAdmin, requireTrustedMutation, verifyActivationReceipt });

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
  const websiteUsername = websiteUsernameIdentity(input.username);
  if (websiteUsername) {
    const existingUsername = await (await getCollection("users")).findOne(websiteUsernameOwnerFilter(websiteUsername.username), { projection: { _id: 1 } });
    if (existingUsername) return c.json({ code: "USERNAME_TAKEN", message: "该用户名已被使用，请换一个用户名或使用邮箱登录" }, 409);
  }
  const auth = await registerWithChandler({
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    inviteCode: input.inviteCode,
  });
  await markChandlerProductEdition(auth.access_token, auth.user.id, "gulong", "website-registration").catch(() => null);
  const identity = { role: auth.user.is_admin || isChandlerBootstrapAdmin(auth.user) ? "admin" : "user", editionKey: "gulong", editionName: "古龙版", editionSource: "website-registration" };
  const user = await upsertChandlerUser(auth.user, { username: websiteUsername?.username, identity, defaultEdition: "gulong", forceEdition: true });
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
  return c.json({ user: await establishChandlerWebsiteSession(c, chandlerAuth, {
    username: input.identifier.includes("@") ? undefined : input.identifier,
  }) });
});

app.openapi(authCapabilitiesRoute, async (c) => {
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json(await currentAuthCapabilities());
});

app.openapi(otpSendRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const input = c.req.valid("json");
  const target = otpTarget(input);
  const capabilities = await currentAuthCapabilities();
  if (input.targetType === "phone" && !capabilities.smsOtpEnabled) {
    return c.json({ code: "SMS_OTP_DISABLED", message: "短信验证码服务暂时关闭，请改用邮箱或密码登录" }, 503);
  }
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const targetKey = hashOpaqueToken(`${input.targetType}:${target}`, "auth-otp-target").slice(0, 32);
  const [ipRate, targetRate] = await Promise.all([
    enforceRateLimit(`auth-otp-send-ip:${ipKey}`, { limit: 10, windowMs: 10 * 60_000 }),
    enforceRateLimit(`auth-otp-send-target:${targetKey}`, { limit: 5, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !targetRate.allowed) {
    c.header("Retry-After", "60");
    return c.json({ code: "RATE_LIMITED", message: "验证码发送过于频繁，请 60 秒后再试" }, 429);
  }
  await sendLoginOtpWithChandler(target, input.targetType);
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Retry-After", "60");
  return c.json({ status: "sent", retryAfter: 60 });
});

app.openapi(otpLoginRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const input = c.req.valid("json");
  const target = otpTarget(input);
  const capabilities = await currentAuthCapabilities();
  if (input.targetType === "phone" && !capabilities.smsOtpEnabled) {
    return c.json({ code: "SMS_OTP_DISABLED", message: "短信验证码服务暂时关闭，请改用邮箱或密码登录" }, 503);
  }
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const targetKey = hashOpaqueToken(`${input.targetType}:${target}`, "auth-otp-target").slice(0, 32);
  const [ipRate, targetRate] = await Promise.all([
    enforceRateLimit(`auth-otp-login-ip:${ipKey}`, { limit: 20, windowMs: 10 * 60_000 }),
    enforceRateLimit(`auth-otp-login-target:${targetKey}`, { limit: 8, windowMs: 10 * 60_000 }),
  ]);
  if (!ipRate.allowed || !targetRate.allowed) {
    return c.json({ code: "RATE_LIMITED", message: "验证码校验尝试过多，请重新获取验证码" }, 429);
  }
  const chandlerAuth = await loginWithChandlerOtp(target, input.targetType, input.code);
  return c.json({ user: await establishChandlerWebsiteSession(c, chandlerAuth, {
    ...(input.targetType === "phone" ? { phone: target } : {}),
  }) });
});

app.openapi(phoneForgotPasswordRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const capabilities = await currentAuthCapabilities();
  if (!capabilities.smsOtpEnabled) return c.json({ code: "SMS_OTP_DISABLED", message: "短信验证码服务暂时关闭，请使用邮箱找回密码" }, 503);
  const phone = normalizedPhone(c.req.valid("json").phone);
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const phoneKey = hashOpaqueToken(phone, "phone-password-reset").slice(0, 32);
  const [ipRate, phoneRate] = await Promise.all([
    enforceRateLimit(`phone-password-forgot-ip:${ipKey}`, { limit: 6, windowMs: 30 * 60_000 }),
    enforceRateLimit(`phone-password-forgot-target:${phoneKey}`, { limit: 3, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !phoneRate.allowed) {
    c.header("Retry-After", "60");
    return c.json({ code: "RATE_LIMITED", message: "短信发送过于频繁，请稍后再试" }, 429);
  }
  await forgotPasswordWithChandlerPhone(phone);
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Retry-After", "60");
  return c.json({ status: "accepted", retryAfter: 60 }, 202);
});

app.openapi(phoneResetPasswordRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const input = c.req.valid("json");
  const phone = normalizedPhone(input.phone);
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const attemptKey = hashOpaqueToken(`${phone}:${input.code}`, "phone-password-reset-attempt").slice(0, 32);
  const [ipRate, attemptRate] = await Promise.all([
    enforceRateLimit(`phone-password-reset-ip:${ipKey}`, { limit: 12, windowMs: 30 * 60_000 }),
    enforceRateLimit(`phone-password-reset-attempt:${attemptKey}`, { limit: 5, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !attemptRate.allowed) {
    return c.json({ code: "RATE_LIMITED", message: "短信验证码校验尝试过多，请重新获取验证码" }, 429);
  }
  await resetPasswordWithChandlerPhone(phone, input.code, input.newPassword);
  const users = await getCollection("users");
  const user = await users.findOne({ chandlerPhoneHash: hashOpaqueToken(phone, "chandler-phone") }, { projection: { _id: 1 } });
  if (user) {
    await Promise.all([
      (await getCollection("sessions")).deleteMany({ userId: user._id }),
      users.updateOne({ _id: user._id }, { $set: { passwordResetAt: new Date(), updatedAt: new Date() } }),
    ]);
  }
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({ status: "reset", message: "密码已重置，请使用新密码重新登录" });
});

app.openapi(desktopEmailRegistrationRoute, async (c) => {
  const input = c.req.valid("json");
  const activation = await verifyActivationReceipt(input.activation_receipt);
  const application = desktopRegistrationApplication(input.client_id, activation.payload);
  if (!isChandlerRegistrationAttributionConfigured(application.editionKey)) {
    return c.json({ code: "REGISTRATION_ATTRIBUTION_NOT_CONFIGURED", message: `${application.editionName}注册来源归因尚未完成安全配置，请联系管理员` }, 503);
  }
  const email = normalizeEmail(input.email);
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const emailKey = hashOpaqueToken(email, "desktop-email-register-target").slice(0, 32);
  const deviceKey = hashOpaqueToken(activation.payload.deviceId, "desktop-email-register-device").slice(0, 32);
  const [ipRate, emailRate, deviceRate] = await Promise.all([
    enforceRateLimit(`desktop-email-register-ip:${ipKey}`, { limit: 10, windowMs: 30 * 60_000 }),
    enforceRateLimit(`desktop-email-register-target:${emailKey}`, { limit: 5, windowMs: 30 * 60_000 }),
    enforceRateLimit(`desktop-email-register-device:${deviceKey}`, { limit: 8, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !emailRate.allowed || !deviceRate.allowed) {
    return c.json({ code: "RATE_LIMITED", message: "注册尝试过多，请稍后重试" }, 429);
  }
  await recordDesktopEmailAuthAudit("desktop_email_register_requested", activation.payload, email, {
    appVersion: input.app_version,
    applicationId: application.id,
  });
  const chandlerAuth = await registerWithChandler({
    email,
    password: input.password,
    displayName: input.display_name,
    inviteCode: input.invite_code,
    edition: application.editionKey,
    deviceType: "desktop",
    clientVersion: input.app_version,
  });
  if (!chandlerAuth?.access_token || !chandlerAuth?.user?.id) {
    throw Object.assign(new Error("统一账号服务返回的注册结果不完整，请稍后重试"), { code: "CHANDLER_AUTH_RESPONSE_INVALID", status: 502 });
  }
  await markChandlerProductEdition(chandlerAuth.access_token, chandlerAuth.user.id, application.editionKey, "desktop-email-registration").catch(() => null);
  const identity = { role: chandlerAuth.user.is_admin || isChandlerBootstrapAdmin(chandlerAuth.user) ? "admin" : "user", editionKey: application.editionKey, editionName: application.editionName, editionSource: "desktop-email-registration" };
  const user = await upsertChandlerUser(chandlerAuth.user, { identity, defaultEdition: application.editionKey, forceEdition: true });
  await recordDesktopEmailAuthAudit("desktop_email_register_succeeded", activation.payload, email, {
    userId: user._id,
    chandlerUserId: chandlerAuth.user.id,
    appVersion: input.app_version,
    applicationId: application.id,
  });
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({
    access_token: chandlerAuth.access_token,
    refresh_token: chandlerAuth.refresh_token || null,
    token_type: chandlerAuth.token_type || "Bearer",
    expires_in: Math.max(60, Number(chandlerAuth.expires_in || 3600)),
    user: chandlerAuth.user,
  }, 201);
});

app.openapi(desktopPhoneRegistrationSendRoute, async (c) => {
  const input = c.req.valid("json");
  const { activation, phone, application } = await verifiedDesktopPhoneRegistrationRequest(input, "desktop_phone_register_send");
  const capabilities = await currentAuthCapabilities();
  if (!capabilities.smsOtpEnabled) {
    return c.json({ code: "SMS_OTP_DISABLED", message: "短信验证码服务暂时关闭，请稍后重试" }, 503);
  }
  if (!isChandlerPhoneRegistrationConfigured(application.editionKey)) {
    return c.json({ code: "PHONE_REGISTRATION_NOT_CONFIGURED", message: "桌面手机号注册服务尚未完成安全配置，请联系管理员" }, 503);
  }
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const phoneKey = hashOpaqueToken(phone, "desktop-phone-register-target").slice(0, 32);
  const deviceKey = hashOpaqueToken(activation.payload.deviceId, "desktop-phone-register-device").slice(0, 32);
  const [ipRate, phoneRate, deviceRate] = await Promise.all([
    enforceRateLimit(`desktop-phone-register-send-ip:${ipKey}`, { limit: 10, windowMs: 30 * 60_000 }),
    enforceRateLimit(`desktop-phone-register-send-target:${phoneKey}`, { limit: 3, windowMs: 30 * 60_000 }),
    enforceRateLimit(`desktop-phone-register-send-device:${deviceKey}`, { limit: 5, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !phoneRate.allowed || !deviceRate.allowed) {
    c.header("Retry-After", "60");
    return c.json({ code: "RATE_LIMITED", message: "短信验证码发送过于频繁，请稍后再试" }, 429);
  }
  await sendPhoneRegistrationOtpWithChandler(phone, application.editionKey);
  await recordDesktopPhoneAuthAudit("desktop_phone_register_send_accepted", activation.payload, phone, { appVersion: input.app_version, applicationId: application.id });
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Retry-After", "60");
  return c.json({ status: "accepted", retryAfter: 60, codeLength: 6 }, 202);
});

app.openapi(desktopPhoneRegistrationRoute, async (c) => {
  const input = c.req.valid("json");
  const { activation, phone, application } = await verifiedDesktopPhoneRegistrationRequest(input, "desktop_phone_register");
  if (!isChandlerPhoneRegistrationConfigured(application.editionKey)) {
    return c.json({ code: "PHONE_REGISTRATION_NOT_CONFIGURED", message: "桌面手机号注册服务尚未完成安全配置，请联系管理员" }, 503);
  }
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const attemptKey = hashOpaqueToken(`${phone}:${input.code}`, "desktop-phone-register-attempt").slice(0, 32);
  const deviceKey = hashOpaqueToken(activation.payload.deviceId, "desktop-phone-register-device").slice(0, 32);
  const [ipRate, attemptRate, deviceRate] = await Promise.all([
    enforceRateLimit(`desktop-phone-register-ip:${ipKey}`, { limit: 12, windowMs: 30 * 60_000 }),
    enforceRateLimit(`desktop-phone-register-attempt:${attemptKey}`, { limit: 5, windowMs: 30 * 60_000 }),
    enforceRateLimit(`desktop-phone-register-device:${deviceKey}`, { limit: 8, windowMs: 30 * 60_000 }),
  ]);
  if (!ipRate.allowed || !attemptRate.allowed || !deviceRate.allowed) {
    return c.json({ code: "RATE_LIMITED", message: "验证码校验尝试过多，请重新获取验证码" }, 429);
  }
  const chandlerAuth = await registerPhoneWithChandler({
    phone,
    code: input.code,
    displayName: input.display_name,
    installId: activation.payload.deviceId,
    deviceName: input.device_name,
    osVersion: input.os_version,
    appVersion: input.app_version,
    edition: application.editionKey,
  });
  if (!chandlerAuth?.access_token || !chandlerAuth?.user?.id) {
    throw Object.assign(new Error("统一账号服务返回的注册结果不完整，请稍后重试"), { code: "CHANDLER_AUTH_RESPONSE_INVALID", status: 502 });
  }
  await markChandlerProductEdition(chandlerAuth.access_token, chandlerAuth.user.id, application.editionKey, "desktop-phone-registration").catch(() => null);
  const identity = { role: chandlerAuth.user.is_admin || isChandlerBootstrapAdmin(chandlerAuth.user) ? "admin" : "user", editionKey: application.editionKey, editionName: application.editionName, editionSource: "desktop-phone-registration" };
  const user = await upsertChandlerUser(chandlerAuth.user, { identity, defaultEdition: application.editionKey, forceEdition: true });
  await (await getCollection("users")).updateOne(
    { _id: user._id },
    { $set: { chandlerPhoneHash: hashOpaqueToken(phone, "chandler-phone"), updatedAt: new Date() } },
  );
  await recordDesktopPhoneAuthAudit("desktop_phone_register_succeeded", activation.payload, phone, { userId: user._id, chandlerUserId: chandlerAuth.user.id, appVersion: input.app_version, applicationId: application.id });
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({
    status: "registered",
    auth: {
      access_token: chandlerAuth.access_token,
      refresh_token: chandlerAuth.refresh_token || null,
      token_type: chandlerAuth.token_type || "Bearer",
      expires_in: Math.max(60, Number(chandlerAuth.expires_in || 3600)),
    },
    user: publicWebsiteUser(user),
  }, 201);
});

app.openapi(accountSecurityRoute, async (c) => {
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const [profile, identitiesPayload, capabilities] = await Promise.all([
    chandlerRequest("/v1/me", { accessToken: session.accessToken, timeoutMs: 8_000 }),
    listChandlerIdentities(session.accessToken),
    currentAuthCapabilities(),
  ]);
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({
    profile: {
      email: profile?.email || session.auth.user.email || null,
      emailVerified: Boolean(profile?.email_verified),
      mfaEnabled: Boolean(profile?.mfa_enabled),
    },
    capabilities,
    identities: chandlerIdentities(identitiesPayload).map(publicIdentity).filter((item) => item.id),
  });
});

app.openapi(sendVerificationEmailRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const [userRate, ipRate] = await Promise.all([
    enforceRateLimit(`verify-email-user:${session.auth.user.id}`, { limit: 3, windowMs: 30 * 60_000 }),
    enforceRateLimit(`verify-email-ip:${ipKey}`, { limit: 8, windowMs: 30 * 60_000 }),
  ]);
  if (!userRate.allowed || !ipRate.allowed) {
    c.header("Retry-After", "60");
    return c.json({ code: "RATE_LIMITED", message: "验证邮件发送过于频繁，请稍后再试" }, 429);
  }
  await sendChandlerVerificationEmail(session.accessToken);
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Retry-After", "60");
  return c.json({ status: "accepted", retryAfter: 60 }, 202);
});

app.openapi(verifyAccountEmailRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const rate = await enforceRateLimit(`verify-email-token:${session.auth.user.id}`, { limit: 10, windowMs: 30 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "邮箱验证码校验尝试过多，请重新获取验证码" }, 429);
  await verifyChandlerEmail(c.req.valid("json").token);
  await (await getCollection("users")).updateOne(
    { _id: new ObjectId(session.auth.user.id) },
    { $set: { emailVerified: true, updatedAt: new Date() } },
  );
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ status: "verified" });
});

app.openapi(bindPhoneRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const capabilities = await currentAuthCapabilities();
  if (!capabilities.smsOtpEnabled) return c.json({ code: "SMS_OTP_DISABLED", message: "短信验证码服务暂时关闭，请稍后再试" }, 503);
  const input = c.req.valid("json");
  const phone = normalizedPhone(input.phone);
  const targetKey = hashOpaqueToken(phone, "phone-binding-target").slice(0, 32);
  const [userRate, targetRate] = await Promise.all([
    enforceRateLimit(`phone-bind-user:${session.auth.user.id}`, { limit: 5, windowMs: 30 * 60_000 }),
    enforceRateLimit(`phone-bind-target:${targetKey}`, { limit: 3, windowMs: 30 * 60_000 }),
  ]);
  if (!userRate.allowed || !targetRate.allowed) {
    c.header("Retry-After", "60");
    return c.json({ code: "RATE_LIMITED", message: "手机号绑定请求过于频繁，请稍后再试" }, 429);
  }
  const payload = await bindChandlerPhone(session.accessToken, {
    phone,
    currentPassword: input.currentPassword,
    reauthCode: input.reauthCode,
  });
  const remoteIdentity = chandlerIdentity(payload);
  const identity = publicIdentity({ ...remoteIdentity, provider: "phone", value: remoteIdentity?.value || phone });
  if (!identity.id) throw new ChandlerError("统一账号服务没有返回手机号身份编号，请稍后重试", { status: 502, code: "IDENTITY_ID_MISSING" });
  await (await getCollection("users")).updateOne(
    { _id: new ObjectId(session.auth.user.id) },
    { $set: { pendingChandlerPhoneIdentityId: identity.id, pendingChandlerPhoneHash: hashOpaqueToken(phone, "chandler-phone"), updatedAt: new Date() } },
  );
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Retry-After", "60");
  return c.json({ identity, retryAfter: 60 }, 201);
});

app.openapi(verifyIdentityRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const identityId = c.req.valid("param").identityId;
  const identitiesPayload = await listChandlerIdentities(session.accessToken);
  const remoteIdentity = chandlerIdentities(identitiesPayload).find((item) => String(item.id) === identityId);
  if (!remoteIdentity || remoteIdentity.provider !== "phone") return c.json({ code: "IDENTITY_NOT_FOUND", message: "没有找到当前账号的手机号绑定记录" }, 404);
  const rate = await enforceRateLimit(`phone-verify:${session.auth.user.id}:${identityId}`, { limit: 8, windowMs: 30 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "短信验证码校验尝试过多，请重新绑定手机号" }, 429);
  await verifyChandlerIdentity(session.accessToken, identityId, c.req.valid("json").code);
  const users = await getCollection("users");
  const localUser = await users.findOne({ _id: new ObjectId(session.auth.user.id) });
  const phoneHash = localUser?.pendingChandlerPhoneIdentityId === identityId
    ? localUser.pendingChandlerPhoneHash
    : remoteIdentity.value && !String(remoteIdentity.value).includes("*")
      ? hashOpaqueToken(normalizedPhone(remoteIdentity.value), "chandler-phone")
      : null;
  await users.updateOne(
    { _id: new ObjectId(session.auth.user.id) },
    {
      $set: { chandlerPhoneIdentityId: identityId, ...(phoneHash ? { chandlerPhoneHash: phoneHash } : {}), updatedAt: new Date() },
      $unset: { pendingChandlerPhoneIdentityId: "", pendingChandlerPhoneHash: "" },
    },
  );
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ status: "verified" });
});

app.openapi(deleteIdentityRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const identityId = c.req.valid("param").identityId;
  const identitiesPayload = await listChandlerIdentities(session.accessToken);
  const remoteIdentity = chandlerIdentities(identitiesPayload).find((item) => String(item.id) === identityId);
  if (!remoteIdentity || remoteIdentity.provider !== "phone") return c.json({ code: "IDENTITY_NOT_FOUND", message: "只允许解绑当前账号的手机号" }, 404);
  await deleteChandlerIdentity(session.accessToken, identityId);
  await (await getCollection("users")).updateOne(
    { _id: new ObjectId(session.auth.user.id) },
    {
      $unset: {
        chandlerPhoneIdentityId: "",
        chandlerPhoneHash: "",
        pendingChandlerPhoneIdentityId: "",
        pendingChandlerPhoneHash: "",
      },
      $set: { updatedAt: new Date() },
    },
  );
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ status: "deleted" });
});

app.openapi(sendReauthCodeRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const rate = await enforceRateLimit(`account-reauth:${session.auth.user.id}`, { limit: 3, windowMs: 30 * 60_000 });
  if (!rate.allowed) {
    c.header("Retry-After", "60");
    return c.json({ code: "RATE_LIMITED", message: "再认证验证码发送过于频繁，请稍后重试" }, 429);
  }
  const result = await sendChandlerReauthCode(session.accessToken);
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Retry-After", "60");
  return c.json({
    status: String(result?.status || "sent"),
    provider: result?.provider ? String(result.provider) : undefined,
    value: result?.value ? String(result.value) : undefined,
    retryAfter: 60,
  });
});

app.openapi(setPrimaryIdentityRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const identityId = c.req.valid("param").identityId;
  const identitiesPayload = await listChandlerIdentities(session.accessToken);
  const remoteIdentity = chandlerIdentities(identitiesPayload).find((item) => String(item.id) === identityId);
  if (!remoteIdentity || !remoteIdentity.verified) return c.json({ code: "IDENTITY_NOT_FOUND", message: "只能将当前账号已验证的身份设为主身份" }, 404);
  await setPrimaryChandlerIdentity(session.accessToken, identityId);
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ status: "primary" });
});

app.openapi(changePasswordRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  const input = c.req.valid("json");
  const rate = await enforceRateLimit(`change-password:${session.auth.user.id}`, { limit: 5, windowMs: 30 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "密码修改尝试过于频繁，请稍后重试" }, 429);
  await changeChandlerPassword(session.accessToken, input.oldPassword, input.newPassword);
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ status: "changed" });
});

app.openapi(logoutAllRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const session = await requireChandlerAccountSession(c); if (session.error) return session.error;
  await logoutAllFromChandler(session.accessToken);
  await (await getCollection("sessions")).deleteMany({ userId: new ObjectId(session.auth.user.id) });
  await revokeSession(c);
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ status: "logged_out" });
});

app.openapi(shortDramaSsoRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const rate = await enforceRateLimit(`short-drama-sso:${auth.user.id}`, {
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "短剧登录授权过于频繁，请稍后重试" }, 429);
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({ token: issueShortDramaSsoToken(auth.user), expiresIn: 120 });
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

  await resetPasswordWithChandler(email, input.code, input.newPassword);
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
  const evaluatedLifecycle = auth?.user
    ? await refreshSubscriptionLifecycle(new ObjectId(auth.user.id)).catch(() => null)
    : null;
  const lifecycle = auth?.user?.role === "admin" && evaluatedLifecycle
    ? { ...evaluatedLifecycle, restricted: false, renewalDue: false }
    : evaluatedLifecycle;
  return c.json({
    user: auth?.user || null,
    subscriptionLifecycle: lifecycle,
    databaseConfigured: isDatabaseConfigured(),
    identityProvider: "chandler",
  });
});

app.post("/api/licenses/redeem", async (c) => {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const ipKey = fingerprintIp(c.req.header("x-forwarded-for") || "local");
  const rate = await enforceRateLimit(`activation-redeem:${ipKey}`, { limit: 12, windowMs: 15 * 60_000 });
  if (!rate.allowed) return c.json({ code: "RATE_LIMITED", message: "激活尝试过多，请 15 分钟后重试" }, 429);

  const body = await c.req.json().catch(() => ({}));
  const code = normalizeActivationCode(body.code);
  const deviceId = String(body.deviceId || "").trim().toLowerCase();
  const deviceName = String(body.deviceName || "").trim().slice(0, 120);
  const macHint = String(body.macHint || "").trim().toUpperCase().slice(-8);
  if (!/^H3(?:-[A-HJ-NP-Z2-9]{5}){4}$/.test(code)) {
    return c.json({ code: "INVALID_ACTIVATION_CODE", message: "激活码格式不正确" }, 400);
  }
  if (!/^[a-f0-9]{64}$/.test(deviceId)) {
    return c.json({ code: "INVALID_DEVICE", message: "设备指纹不正确" }, 400);
  }
  let hardwareBindingV2;
  try {
    hardwareBindingV2 = parseActivationHardwareBindingV2(body);
  } catch (error) {
    return c.json({ code: error.code || "INVALID_HARDWARE_FINGERPRINT", message: error.message || "硬件指纹摘要格式不正确" }, error.status || 400);
  }

  const codes = await getCollection("activationCodes");
  const codeHash = hashActivationCode(code);
  let record = await codes.findOne({ codeHash });
  if (!record) return c.json({ code: "INVALID_ACTIVATION_CODE", message: "激活码不存在或已失效" }, 404);
  if (record.status === "revoked") return c.json({ code: "ACTIVATION_REVOKED", message: "激活码已被停用" }, 403);
  // Validate the production signing key before binding an unused code. A
  // deployment configuration error must never consume a customer's license.
  const privateKey = activationSigningPrivateKey();

  if (record.status === "unused") {
    try {
      const activatedAt = new Date();
      record = await codes.findOneAndUpdate(
        { _id: record._id, status: "unused" },
        {
          $set: {
            status: "used",
            deviceId,
            deviceName,
            macHint,
            activatedAt,
            updatedAt: activatedAt,
            ...(hardwareBindingV2 ? { hardwareBindingV2: { ...hardwareBindingV2, boundAt: activatedAt } } : {}),
          },
        },
        { returnDocument: "after" },
      );
    } catch (error) {
      if (error?.code === 11000) {
        return c.json({ code: "DEVICE_ALREADY_LICENSED", message: "这台电脑已经绑定过同一产品授权" }, 409);
      }
      throw error;
    }
    if (!record) record = await codes.findOne({ codeHash });
  }

  if (!record || record.status !== "used" || record.deviceId !== deviceId) {
    return c.json({ code: "ACTIVATION_ALREADY_USED", message: "激活码已绑定到其他电脑" }, 409);
  }
  if (hardwareBindingV2) {
    try {
      record = await persistActivationHardwareBindingV2(codes, record, hardwareBindingV2);
    } catch (error) {
      if (error?.code !== "HARDWARE_FINGERPRINT_MISMATCH") throw error;
      return c.json({ code: error.code, message: error.message || "硬件指纹与现有授权不匹配" }, error.status || 409);
    }
  }
  const payload = activationReceiptPayload(record);
  return c.json({ ok: true, receipt: { ...payload, ...signActivationReceipt(payload, privateKey) } });
});

app.get("/api/admin/activation-codes", async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const auth = await requireAdmin(c);
  if (auth.error) return auth.error;
  const status = String(c.req.query("status") || "").trim();
  const product = String(c.req.query("product") || "").trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  const filter = {};
  if (["unused", "used", "revoked"].includes(status)) filter.status = status;
  if (product) filter.product = product;
  const collection = await getCollection("activationCodes");
  const [items, counts] = await Promise.all([
    collection.aggregate([
      { $match: filter },
      { $addFields: { _statusOrder: { $switch: { branches: [{ case: { $eq: ["$status", "unused"] }, then: 0 }, { case: { $eq: ["$status", "revoked"] }, then: 1 }, { case: { $eq: ["$status", "used"] }, then: 2 }], default: 3 } } } },
      { $sort: { _statusOrder: 1, createdAt: -1 } },
      { $limit: limit },
    ]).toArray(),
    collection.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
  ]);
  return c.json({
    items: items.map((item) => ({
      id: item._id.toString(),
      code: item.codeEncrypted ? readUserSecret(item.codeEncrypted, "activation-code") : null,
      codePreview: item.codePreview,
      product: item.product,
      status: item.status,
      note: item.note || "",
      deviceName: item.deviceName || null,
      macHint: item.macHint || null,
      createdAt: item.createdAt,
      activatedAt: item.activatedAt || null,
    })),
    counts: Object.fromEntries(counts.map((item) => [item._id, item.count])),
  });
});

app.openapi(adminExportUnusedActivationCodesRoute, async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const originError = requireTrustedMutation(c);
  if (originError) return originError;
  const auth = await requireAdmin(c);
  if (auth.error) return auth.error;

  const collection = await getCollection("activationCodes");
  const unused = await collection.find({ status: "unused" }).sort({ createdAt: -1, _id: -1 }).toArray();
  if (!unused.length) {
    return c.json({ code: "NO_UNUSED_ACTIVATION_CODES", message: "当前没有可导出的未使用激活码" }, 404);
  }

  const codes = [];
  let reissuedCount = 0;
  for (const item of unused) {
    let code = item.codeEncrypted ? readUserSecret(item.codeEncrypted, "activation-code") : null;
    if (!code) {
      const replacement = activationCode();
      const now = new Date();
      const encryptedMatch = item.codeEncrypted
        ? { codeEncrypted: item.codeEncrypted }
        : { codeEncrypted: { $exists: false } };
      const updated = await collection.findOneAndUpdate(
        { _id: item._id, status: "unused", ...encryptedMatch },
        {
          $set: {
            codeHash: hashActivationCode(replacement),
            codeEncrypted: sealUserSecret(replacement, "activation-code"),
            codePreview: `${replacement.slice(0, 8)}...${replacement.slice(-5)}`,
            reissuedAt: now,
            reissuedBy: new ObjectId(auth.user.id),
            updatedAt: now,
          },
          $unset: { code: "" },
        },
        { returnDocument: "after" },
      );
      if (updated) {
        code = replacement;
        reissuedCount += 1;
      } else {
        const current = await collection.findOne({ _id: item._id, status: "unused" });
        code = current?.codeEncrypted ? readUserSecret(current.codeEncrypted, "activation-code") : null;
      }
    }
    if (code) codes.push(code);
  }

  if (!codes.length) {
    return c.json({ code: "NO_UNUSED_ACTIVATION_CODES", message: "未使用激活码状态刚刚发生变化，请刷新后重试" }, 404);
  }

  const exportedAt = new Date();
  await (await getCollection("authAudit")).insertOne({
    action: "admin_activation_codes_exported",
    actorUserId: new ObjectId(auth.user.id),
    count: codes.length,
    reissuedCount,
    createdAt: exportedAt,
  }).catch(() => null);
  const date = exportedAt.toISOString().slice(0, 10);
  const chineseFilename = `古龙-未使用激活码-${date}.txt`;
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="gulong-unused-activation-codes-${date}.txt"; filename*=UTF-8''${encodeURIComponent(chineseFilename)}`);
  c.header("X-Exported-Count", String(codes.length));
  return c.body(`\uFEFF${codes.join("\r\n")}\r\n`);
});

app.post("/api/admin/activation-codes", async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const originError = requireTrustedMutation(c);
  if (originError) return originError;
  const auth = await requireAdmin(c);
  if (auth.error) return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const count = Math.trunc(Number(body.count));
  const product = String(body.product || ACTIVATION_PRODUCT_DEFAULT).trim().slice(0, 80);
  const note = String(body.note || "").trim().slice(0, 200);
  if (!Number.isInteger(count) || count < 1 || count > ACTIVATION_CODE_MAX_BATCH) {
    return c.json({ code: "INVALID_COUNT", message: `一次可生成 1-${ACTIVATION_CODE_MAX_BATCH} 个激活码` }, 400);
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(product)) {
    return c.json({ code: "INVALID_PRODUCT", message: "产品标识格式不正确" }, 400);
  }

  const now = new Date();
  const plaintext = Array.from({ length: count }, () => activationCode());
  const records = plaintext.map((code) => ({
    _id: new ObjectId(),
    codeHash: hashActivationCode(code),
    codeEncrypted: sealUserSecret(code, "activation-code"),
    codePreview: `${code.slice(0, 8)}...${code.slice(-5)}`,
    product,
    note,
    status: "unused",
    createdBy: new ObjectId(auth.user.id),
    createdAt: now,
    updatedAt: now,
  }));
  await (await getCollection("activationCodes")).insertMany(records, { ordered: true });
  return c.json({ product, count, codes: plaintext, createdAt: now }, 201);
});

app.post("/api/admin/activation-codes/:id/reissue", async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const originError = requireTrustedMutation(c);
  if (originError) return originError;
  const auth = await requireAdmin(c);
  if (auth.error) return auth.error;
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ code: "NOT_FOUND", message: "授权记录不存在" }, 404);
  const collection = await getCollection("activationCodes");
  const existing = await collection.findOne({ _id: new ObjectId(id) });
  if (!existing) return c.json({ code: "NOT_FOUND", message: "授权记录不存在" }, 404);
  if (existing.status !== "unused") return c.json({ code: "ACTIVATION_NOT_REISSUABLE", message: "只有未使用的旧激活码可以重新生成" }, 409);
  const readable = existing.codeEncrypted ? readUserSecret(existing.codeEncrypted, "activation-code") : null;
  if (readable) return c.json({ ok: true, code: readable, reissued: false });
  const code = activationCode();
  const now = new Date();
  const updated = await collection.findOneAndUpdate(
    { _id: existing._id, status: "unused" },
    { $set: { codeHash: hashActivationCode(code), codeEncrypted: sealUserSecret(code, "activation-code"), codePreview: `${code.slice(0, 8)}...${code.slice(-5)}`, reissuedAt: now, reissuedBy: new ObjectId(auth.user.id), updatedAt: now }, $unset: { code: "" } },
    { returnDocument: "after" },
  );
  if (!updated) return c.json({ code: "ACTIVATION_CHANGED", message: "授权状态刚刚发生变化，请刷新后重试" }, 409);
  return c.json({ ok: true, code, reissued: true, codePreview: updated.codePreview });
});

app.post("/api/admin/activation-codes/:id/revoke", async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const originError = requireTrustedMutation(c);
  if (originError) return originError;
  const auth = await requireAdmin(c);
  if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) {
    return c.json({ code: "INVALID_ID", message: "授权记录编号不正确" }, 400);
  }
  const updated = await (await getCollection("activationCodes")).findOneAndUpdate(
    { _id: new ObjectId(c.req.param("id")) },
    { $set: { status: "revoked", revokedAt: new Date(), revokedBy: new ObjectId(auth.user.id), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!updated) return c.json({ code: "NOT_FOUND", message: "授权记录不存在" }, 404);
  return c.json({ ok: true, id: updated._id.toString(), status: updated.status });
});

app.get("/api/account/dashboard", async (c) => {
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const ownerId = new ObjectId(auth.user.id);
  const lifecycle = await refreshSubscriptionLifecycle(ownerId).catch(() => null);
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
    subscriptionLifecycle: lifecycle,
    balanceFen: wallet?.balanceFen || 0,
    shortVideoPackage: shortVideoPackageView(effectiveSubscription, wallet),
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
      progress: item.progress || null,
      response: item.response || item.adminResponse || null,
      screenshots: (Array.isArray(item.screenshots) ? item.screenshots : []).map(parseHttpUrl).filter(Boolean),
      responseAttachments: (Array.isArray(item.responseAttachments) ? item.responseAttachments : []).map((asset) => feedbackResponseAssetJson(asset, item._id)),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt || item.createdAt,
      processingAt: item.processingAt || null,
      resolvedAt: item.resolvedAt || null,
    })),
    orders: [
      ...payments.map((item) => ({ id: item._id.toString(), orderNo: item.orderNo, kind: item.kind, cycle: item.cycle, subscriptionPlan: item.subscriptionPlan || null, provider: item.provider, amountFen: item.amountFen, bonusFen: item.promotionBonusFen || 0, creditedFen: item.creditedFen || item.amountFen, status: item.status, createdAt: item.createdAt })),
      ...offlineOrders.map((item) => ({
        id: item._id.toString(),
        orderNo: item.orderNo,
        kind: item.kind || "subscription",
        cycle: item.cycle,
        subscriptionPlan: item.subscriptionPlan || item.partnerData?.subscription_plan || null,
        provider: "offline",
        amountFen: item.amountFen,
        bonusFen: item.promotionBonusFen || 0,
        creditedFen: item.creditedFen || item.amountFen,
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
    const accessToken = await getAdminChandlerAccessToken(auth);
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
    ...["apiKeys", "tasks", "memories", "feedback", "payments", "subscriptions", "wallets", "walletCreditLedger", "uploads", "offlinePayments", "userConfigurations", "notifications", "avatarUploads", "offlinePaymentReviewWorkers", "workerTasks", "workerTaskUploads", "workerEarnings", "workerWorkflows", "workerWorkflowRevenueLedger", "workerContactPayments"]
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
    const accessToken = await getAdminChandlerAccessToken(auth);
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
        warning: localizeErrorMessage(error, "统一账号服务暂时不可用，当前显示官网同步数据"),
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
      const accessToken = await getAdminChandlerAccessToken(auth);
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
  const plan = body.plan || previous?.plan || "member";
  if (previous?.plan === SHORT_VIDEO_PLAN_ID && plan !== SHORT_VIDEO_PLAN_ID) {
    await expireShortVideoPackageAllowance({ getCollection, ownerId: target._id, subscription: previous, now, force: true });
  }
  await subscriptions.updateOne(
    { ownerId: target._id },
    {
      $set: {
        plan,
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
      ...(plan === SHORT_VIDEO_PLAN_ID ? { $unset: { allowanceExpiredAt: "", allowanceClearedFen: "" } } : {}),
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  await (await getCollection("subscriptionPeriodAudits")).insertOne({
    ownerId: target._id,
    targetChandlerUserId: target.chandlerUserId || null,
    previous: previous ? {
      status: previous.status || null,
      plan: previous.plan || "member",
      currentPeriodStart: previous.currentPeriodStart || null,
      currentPeriodEnd: previous.currentPeriodEnd || null,
      manualPeriodOverride: Boolean(previous.manualPeriodOverride),
    } : null,
    next: { plan, status, currentPeriodStart, currentPeriodEnd, manualPeriodOverride: true },
    actorId: new ObjectId(auth.user.id),
    createdAt: now,
  });

  const displayStart = currentPeriodStart.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const displayEnd = currentPeriodEnd.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  await notifyUser(
    target._id,
    "subscription_period_updated",
    "订阅类型与有效期已调整",
    `管理员已将你的订阅类型设置为${plan === SHORT_VIDEO_PLAN_ID ? "短视频包月" : "会员用户"}，有效期为 ${displayStart} 至 ${displayEnd}。`,
    { plan, currentPeriodStart, currentPeriodEnd, status, actorId: new ObjectId(auth.user.id) },
  );

  let chandlerSynced = false;
  if (target.chandlerUserId) {
    try {
      const accessToken = await getAdminChandlerAccessToken(auth);
      const path = `/v1/me/oauth/clients/${encodeURIComponent(chandlerConfig().applicationId)}/users/${encodeURIComponent(target.chandlerUserId)}/attributes`;
      const current = await chandlerRequest(path, { accessToken });
      const attributes = current.attributes && typeof current.attributes === "object" ? current.attributes : {};
      await chandlerRequest(path, {
        method: "PUT",
        accessToken,
        body: { attributes: {
          ...attributes,
          subscription_status: status,
          subscription_plan: plan,
          plan_kind: plan,
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
    plan,
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
  const accessToken = await getAdminChandlerAccessToken(auth);
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
      const accessToken = await getAdminChandlerAccessToken(auth);
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
      remoteWarning = actionableFailures[0]
        ? localizeErrorMessage(actionableFailures[0].reason, "部分统一账号数据暂时无法同步")
        : null;
      const subscriptionAttributes = successful
        .filter((item) => chandlerAttributePeriod(item.attributes))
        .sort((left, right) => Number(right.attributes.subscription_period_updated_at_unix_ms || right.attributes.subscription_reviewed_at_unix_ms || 0) - Number(left.attributes.subscription_period_updated_at_unix_ms || left.attributes.subscription_reviewed_at_unix_ms || 0))[0];
      if (subscriptionAttributes) await synchronizeChandlerAttributeSubscription(user._id, subscriptionAttributes.attributes, subscriptionAttributes.target.id);
    } catch (error) {
      remoteWarning = localizeErrorMessage(error, "统一账号数据暂时无法同步");
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
  const accessToken = await getAdminChandlerAccessToken(auth);
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
  return c.json({ plans: mergedPlans, targetPrices: { month: pricing.monthly.amountFen, year: pricing.yearly.amountFen }, pricingRevision: pricing.revision, desktopSyncEndpoint: "/api/v1/pricing/subscriptions", pricingAuthority: "chandler-v3.2-once-price-plus-gulong-membership-ledger", applicationId: chandlerConfig().applicationId });
});

app.openapi(adminPublishChandlerPriceRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const input = c.req.valid("json");
  const accessToken = await getAdminChandlerAccessToken(auth);
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
    remoteAuthority: "chandler-v3.2-api-key",
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
  const accessToken = await getAdminChandlerAccessToken(auth);
  return c.json(await createPartnerSku(accessToken, c.req.valid("json")), 201);
});

app.openapi(adminListChandlerPriceVersionsRoute, async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const accessToken = await getAdminChandlerAccessToken(auth);
  const prices = await listPartnerPriceVersions(accessToken, c.req.valid("param").skuId);
  return c.json({ prices });
});

app.openapi(adminSetChandlerSkuStatusRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const accessToken = await getAdminChandlerAccessToken(auth);
  const { skuId } = c.req.valid("param");
  const { status } = c.req.valid("json");
  const result = await setPartnerSkuStatus(accessToken, skuId, status);
  return c.json({ ...(result && typeof result === "object" ? result : {}), skuId, status });
});

app.openapi(adminRequestChandlerEntitlementRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const input = c.req.valid("json");
  const accessToken = await getAdminChandlerAccessToken(auth);
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
    { $set: { status: "failed", error: localizeErrorMessage(body.error, "发行工作流失败").slice(0, 4000), failedAt: new Date(), updatedAt: new Date() } },
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
  const lifecycle = await refreshSubscriptionLifecycle(new ObjectId(auth.user.id));
  if (auth.user.role !== "admin" && lifecycle.restricted) return c.json({ code: "SUBSCRIPTION_EXPIRED", message: "会员已到期，请先续费后再上传第二大脑" }, 402);
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
  const requestedStatus = ["open", "processing", "resolved"].includes(c.req.query("status")) ? c.req.query("status") : "open";
  const baseFilter = {};

  if (query) {
    const keyword = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = { $regex: keyword, $options: "i" };
    const users = await getCollection("users");
    const matchingUsers = await users.find({
      $or: ["displayName", "username", "email", "emailNormalized"].map((field) => ({ [field]: regex })),
    }, { projection: { _id: 1 } }).limit(1000).toArray();
    const statusLabels = { open: "待处理", processing: "处理中", resolved: "已处理", closed: "已处理" };
    const matchingStatuses = Object.entries(statusLabels)
      .filter(([status, label]) => status.includes(query.toLowerCase()) || label.includes(query) || query.includes(label))
      .map(([status]) => status);
    baseFilter.$or = [
      { message: regex },
      { status: regex },
      ...(matchingUsers.length ? [{ ownerId: { $in: matchingUsers.map((user) => user._id) } }] : []),
      ...(matchingStatuses.length ? [{ status: { $in: matchingStatuses } }] : []),
      ...(ObjectId.isValid(query) ? [{ _id: new ObjectId(query) }] : []),
    ];
  }

  const feedback = await getCollection("feedback");
  const openClause = { $or: [{ status: "open" }, { status: null }, { status: { $exists: false } }] };
  const processingClause = { status: "processing" };
  const resolvedClause = { status: { $in: ["resolved", "closed"] } };
  const statusClause = requestedStatus === "processing" ? processingClause : requestedStatus === "resolved" ? resolvedClause : openClause;
  const filter = { $and: [baseFilter, statusClause] };
  const [items, total, openCount, processingCount, resolvedCount] = await Promise.all([
    feedback.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    feedback.countDocuments(filter),
    feedback.countDocuments({ $and: [baseFilter, openClause] }),
    feedback.countDocuments({ $and: [baseFilter, processingClause] }),
    feedback.countDocuments({ $and: [baseFilter, resolvedClause] }),
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
        progress: item.progress || null,
        response: item.response || item.adminResponse || null,
        responseAttachments: (Array.isArray(item.responseAttachments) ? item.responseAttachments : []).map((asset) => feedbackResponseAssetJson(asset, item._id)),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt || null,
        processingAt: item.processingAt || null,
        resolvedAt: item.resolvedAt || null,
        owner: owner ? {
          id: owner._id.toString(),
          displayName: owner.displayName || null,
          username: owner.username || null,
          email: owner.email || null,
          avatar: parseHttpUrl(owner.avatar),
        } : null,
      };
    }),
    summary: { open: openCount, processing: processingCount, resolved: resolvedCount, total: openCount + processingCount + resolvedCount },
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

app.post("/api/admin/feedback/:id/assets/presign", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "FEEDBACK_NOT_FOUND", message: "用户反馈不存在" }, 404);
  const feedbackId = new ObjectId(c.req.param("id"));
  const feedback = await (await getCollection("feedback")).findOne({ _id: feedbackId });
  if (!feedback) return c.json({ code: "FEEDBACK_NOT_FOUND", message: "用户反馈不存在" }, 404);
  const body = await c.req.json();
  const filename = sanitizeFilename(body.filename, "feedback-result.bin");
  const contentType = String(body.contentType || "").split(";")[0].trim().toLowerCase();
  const bytes = Number(body.bytes);
  if (!FEEDBACK_RESPONSE_CONTENT_TYPES.has(contentType) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > FEEDBACK_RESPONSE_MAX_BYTES) {
    return c.json({ code: "VALIDATION_ERROR", message: "处理附件仅支持图片或 MP4、WebM、MOV 视频，单个文件不超过 200 MB" }, 400);
  }
  try { await ensureBrowserUploadCors(); }
  catch { return c.json({ code: "COS_CORS_CONFIGURATION_FAILED", message: "腾讯云 COS 暂未允许官网上传处理附件，请稍后重试" }, 503); }
  const uploadId = new ObjectId();
  const objectKey = `feedback/responses/${feedbackId}/${uploadId}-${filename}`;
  const now = new Date();
  await (await getCollection("feedbackResponseUploads")).insertOne({
    _id: uploadId,
    feedbackId,
    objectKey,
    filename,
    contentType,
    bytes,
    status: "uploading",
    createdBy: new ObjectId(auth.user.id),
    createdAt: now,
    updatedAt: now,
  });
  const requiredHeaders = { "Content-Type": contentType };
  return c.json({
    uploadId: uploadId.toString(),
    uploadUrl: createPresignedPutUrl(objectKey, { expires: 60 * 60, headers: requiredHeaders }),
    requiredHeaders,
    expiresIn: 3600,
  }, 201);
});

app.post("/api/admin/feedback/:id/assets/:uploadId/complete", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id")) || !ObjectId.isValid(c.req.param("uploadId"))) return c.json({ code: "UPLOAD_NOT_FOUND", message: "处理附件上传记录不存在" }, 404);
  const feedbackId = new ObjectId(c.req.param("id"));
  const uploads = await getCollection("feedbackResponseUploads");
  const upload = await uploads.findOne({ _id: new ObjectId(c.req.param("uploadId")), feedbackId, status: "uploading" });
  if (!upload) return c.json({ code: "UPLOAD_NOT_FOUND", message: "处理附件上传记录不存在或已完成" }, 404);
  let head;
  try { head = await headObject(upload.objectKey); }
  catch { return c.json({ code: "UPLOAD_NOT_READY", message: "腾讯云 COS 尚未收到完整附件，请稍后重试" }, 409); }
  const actualBytes = objectSize(head);
  const actualType = String(head?.headers?.["content-type"] || head?.ContentType || "").split(";")[0].trim().toLowerCase();
  if (actualBytes !== upload.bytes || (actualType && actualType !== upload.contentType)) {
    await deleteObject(upload.objectKey).catch(() => {});
    await uploads.updateOne({ _id: upload._id }, { $set: { status: "failed", error: "COS_OBJECT_MISMATCH", updatedAt: new Date() } });
    return c.json({ code: "UPLOAD_MISMATCH", message: "处理附件大小或类型校验失败，请重新上传" }, 409);
  }
  const completedAt = new Date();
  const completed = { ...upload, status: "ready", completedAt, updatedAt: completedAt };
  await uploads.updateOne({ _id: upload._id, status: "uploading" }, { $set: { status: "ready", completedAt, updatedAt: completedAt } });
  return c.json({ asset: feedbackResponseAssetJson(completed) });
});

app.get("/api/feedback/:id/assets/:assetId", async (c) => {
  const auth = await authenticate(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id")) || !ObjectId.isValid(c.req.param("assetId"))) return c.json({ code: "ASSET_NOT_FOUND", message: "处理附件不存在" }, 404);
  const feedbackId = new ObjectId(c.req.param("id"));
  const feedback = await (await getCollection("feedback")).findOne({ _id: feedbackId });
  const asset = await (await getCollection("feedbackResponseUploads")).findOne({ _id: new ObjectId(c.req.param("assetId")), feedbackId, status: "attached" });
  if (!feedback || !asset) return c.json({ code: "ASSET_NOT_FOUND", message: "处理附件不存在" }, 404);
  const isOwner = feedback.ownerId?.toString?.() === auth.user.id;
  if (!isOwner && auth.user.role !== "admin") return c.json({ code: "FORBIDDEN", message: "你没有权限查看该处理附件" }, 403);
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.redirect(createPresignedDownloadUrl(asset.objectKey), 302);
});

app.put("/api/admin/feedback/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "FEEDBACK_NOT_FOUND", message: "用户反馈不存在" }, 404);
  const feedbackId = new ObjectId(c.req.param("id"));
  const body = await c.req.json();
  const status = body.status === "resolved" ? "resolved" : body.status === "processing" ? "processing" : null;
  const progress = String(body.progress || "").trim();
  const response = String(body.response || "").trim();
  const attachmentIds = [...new Set((Array.isArray(body.attachmentIds) ? body.attachmentIds : []).map(String))].slice(0, 12);
  if (!status || progress.length < 2 || progress.length > 5_000 || response.length > 20_000 || (status === "resolved" && response.length < 2) || attachmentIds.some((id) => !ObjectId.isValid(id))) {
    return c.json({ code: "VALIDATION_ERROR", message: "请填写处理进度；标记已处理时还必须填写处理结果" }, 400);
  }
  const feedbackCollection = await getCollection("feedback");
  const current = await feedbackCollection.findOne({ _id: feedbackId });
  if (!current) return c.json({ code: "FEEDBACK_NOT_FOUND", message: "用户反馈不存在" }, 404);
  const uploads = await getCollection("feedbackResponseUploads");
  const selectedUploads = attachmentIds.length ? await uploads.find({ _id: { $in: attachmentIds.map((id) => new ObjectId(id)) }, feedbackId, status: "ready" }).toArray() : [];
  if (selectedUploads.length !== attachmentIds.length) return c.json({ code: "ATTACHMENT_NOT_READY", message: "部分处理附件尚未上传完成，请重新选择" }, 409);
  const existingAttachments = Array.isArray(current.responseAttachments) ? current.responseAttachments : [];
  const attachmentMap = new Map(existingAttachments.map((asset) => [asset._id?.toString?.() || String(asset.id || ""), asset]));
  for (const upload of selectedUploads) attachmentMap.set(upload._id.toString(), { _id: upload._id, filename: upload.filename, contentType: upload.contentType, bytes: upload.bytes, objectKey: upload.objectKey, createdAt: upload.createdAt });
  const now = new Date();
  const set = {
    status,
    progress,
    response: response || null,
    responseAttachments: [...attachmentMap.values()],
    handledBy: new ObjectId(auth.user.id),
    updatedAt: now,
    ...(status === "processing" && !current.processingAt ? { processingAt: now } : {}),
    ...(status === "resolved" ? { resolvedAt: now } : {}),
  };
  const updated = await feedbackCollection.findOneAndUpdate({ _id: feedbackId }, { $set: set }, { returnDocument: "after" });
  if (selectedUploads.length) await uploads.updateMany({ _id: { $in: selectedUploads.map((upload) => upload._id) } }, { $set: { status: "attached", attachedAt: now, updatedAt: now } });
  if (status === "resolved" && current.status !== "resolved" && current.ownerId) {
    await notifyUser(current.ownerId, "feedback_resolved", "你的问题反馈已处理", response, { feedbackId, feedbackStatus: status });
  }
  return c.json({
    item: {
      id: updated._id.toString(),
      status: updated.status,
      progress: updated.progress,
      response: updated.response,
      responseAttachments: (updated.responseAttachments || []).map((asset) => feedbackResponseAssetJson(asset, updated._id)),
      updatedAt: updated.updatedAt,
      processingAt: updated.processingAt || null,
      resolvedAt: updated.resolvedAt || null,
    },
  });
});

app.delete("/api/admin/feedback/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "FEEDBACK_NOT_FOUND", message: "用户反馈不存在" }, 404);
  const feedbackId = new ObjectId(c.req.param("id"));
  const feedbackCollection = await getCollection("feedback");
  const item = await feedbackCollection.findOne({ _id: feedbackId });
  if (!item) return c.json({ code: "FEEDBACK_NOT_FOUND", message: "用户反馈不存在" }, 404);
  const uploads = await getCollection("feedbackResponseUploads");
  const uploadRecords = await uploads.find({ feedbackId }).toArray();
  const objectKeys = [...new Set([
    ...uploadRecords.map((asset) => asset.objectKey),
    ...(Array.isArray(item.responseAttachments) ? item.responseAttachments.map((asset) => asset.objectKey) : []),
  ].filter(Boolean))];
  await Promise.allSettled(objectKeys.map((objectKey) => deleteObject(objectKey)));
  await Promise.all([uploads.deleteMany({ feedbackId }), feedbackCollection.deleteOne({ _id: feedbackId })]);
  return c.json({ ok: true, deletedAttachments: objectKeys.length });
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
    { _id: taskId, publisherId: ownerId, status: { $in: ["awaiting_payment", "payment_rejected"] }, paymentStatus: { $in: ["awaiting_payment", "rejected"] } },
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

async function notifyWorkerTaskReady(task, { online = false } = {}) {
  const assignmentType = task.assignmentType || "open";
  const publisherMessage = assignmentType === "platform_team"
    ? `“${task.title}”已进入平台团队任务池，管理员现在可以接单处理。`
    : assignmentType === "user"
      ? `“${task.title}”已通知你指定的用户接单。`
      : `“${task.title}”已进入接单大厅，任何用户现在都可以接单。`;
  const assignmentNotifications = [];
  if (assignmentType === "user" && task.designatedAssigneeId) {
    assignmentNotifications.push(notifyUserOnce(task.designatedAssigneeId, "worker_task_designated", "你收到一项指定威客任务", `“${task.title}”已完成付款，发单人指定由你接单处理。`, { taskId: task._id }));
  }
  if (assignmentType === "platform_team") {
    const administrators = await (await getCollection("users")).find({ role: "admin", status: { $nin: ["disabled", "deleted"] } }, { projection: { _id: 1 } }).toArray();
    assignmentNotifications.push(...administrators.map((administrator) => notifyUserOnce(administrator._id, "worker_platform_task_ready", "平台团队收到新任务", `“${task.title}”已完成付款，请管理员统一接单处理。`, { taskId: task._id })));
  }
  await Promise.all([
    notifyUserOnce(
      task.publisherId,
      online ? "worker_online_payment_succeeded" : "worker_payment_approved",
      online ? "威客任务微信支付成功" : "威客任务付款审核已通过",
      publisherMessage,
      { taskId: task._id, orderNo: task.paymentOrderNo },
    ),
    ...assignmentNotifications,
  ]);
}

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
  await notifyWorkerTaskReady(task);
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

app.get("/api/workflows", async (c) => {
  await ensureDefaultPublicWorkflows();
  const q = String(c.req.query("q") || "").trim();
  const filter = { status: "active" };
  if (q) {
    const keyword = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = ["name", "description"].map((field) => ({ [field]: { $regex: keyword, $options: "i" } }));
  }
  const workflows = await (await getCollection("publicWorkflows")).find(filter).sort({ sort: 1, createdAt: -1 }).limit(100).toArray();
  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  return c.json({ workflows: workflows.map(workflowJson), query: q });
});

app.get("/api/workflows/:id/image", async (c) => {
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" }, 404);
  const workflow = await (await getCollection("publicWorkflows")).findOne({ _id: new ObjectId(c.req.param("id")), imageMode: "cos", imageObjectKey: { $type: "string" } });
  if (!workflow) return c.json({ code: "WORKFLOW_IMAGE_NOT_FOUND", message: "工作流图片不存在" }, 404);
  c.header("Cache-Control", "public, max-age=300");
  return c.redirect(createPresignedDownloadUrl(workflow.imageObjectKey, { expiresIn: 900 }), 302);
});

app.get("/api/admin/workflows", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  await ensureDefaultPublicWorkflows();
  const workflows = await (await getCollection("publicWorkflows")).find({}).sort({ sort: 1, createdAt: -1 }).limit(500).toArray();
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ workflows: workflows.map(workflowJson) });
});

app.post("/api/admin/workflows/assets/presign", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const contentType = String(body.contentType || "").toLowerCase();
  const bytes = Number(body.bytes);
  const filename = sanitizeFilename(body.filename, "workflow.png");
  if (!WORKFLOW_IMAGE_CONTENT_TYPES.has(contentType) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > WORKFLOW_IMAGE_MAX_BYTES) {
    return c.json({ code: "VALIDATION_ERROR", message: "请上传不超过 20MB 的 PNG、JPG、WebP 或 GIF 图片" }, 400);
  }
  const uploadId = new ObjectId();
  const objectKey = `workflows/images/${uploadId}-${filename}`;
  const requiredHeaders = { "Content-Type": contentType };
  const now = new Date();
  await (await getCollection("workflowImageUploads")).insertOne({ _id: uploadId, objectKey, filename, contentType, bytes, status: "uploading", createdBy: new ObjectId(auth.user.id), createdAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000) });
  return c.json({ uploadId: uploadId.toString(), uploadUrl: createPresignedPutUrl(objectKey, { headers: requiredHeaders }), requiredHeaders, expiresIn: 3600 }, 201);
});

app.post("/api/admin/workflows/assets/:uploadId/complete", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("uploadId"))) return c.json({ code: "UPLOAD_NOT_FOUND", message: "上传记录不存在" }, 404);
  const uploads = await getCollection("workflowImageUploads");
  const upload = await uploads.findOne({ _id: new ObjectId(c.req.param("uploadId")), status: "uploading" });
  if (!upload) return c.json({ code: "UPLOAD_NOT_FOUND", message: "上传记录不存在或已完成" }, 404);
  const head = await headObject(upload.objectKey);
  if (objectSize(head) !== upload.bytes) return c.json({ code: "UPLOAD_SIZE_MISMATCH", message: "COS 文件大小校验失败" }, 409);
  await uploads.updateOne({ _id: upload._id, status: "uploading" }, { $set: { status: "ready", completedAt: new Date() } });
  return c.json({ uploadId: upload._id.toString(), status: "ready" });
});

app.post("/api/admin/workflows", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const url = workflowTargetUrl(body.url);
  if (name.length < 2 || name.length > 60 || description.length > 300 || !url) return c.json({ code: "VALIDATION_ERROR", message: "请填写 2–60 字名称和有效站内路径或 HTTPS 链接" }, 400);
  let image = { imageMode: "bundled", imageUrl: "/assets/workflow-worker-v1.png" };
  if (body.imageUploadId) {
    if (!ObjectId.isValid(body.imageUploadId)) return c.json({ code: "UPLOAD_NOT_FOUND", message: "图片上传记录无效" }, 400);
    const upload = await (await getCollection("workflowImageUploads")).findOneAndUpdate({ _id: new ObjectId(body.imageUploadId), status: "ready" }, { $set: { status: "attached", attachedAt: new Date() } }, { returnDocument: "after" });
    if (!upload) return c.json({ code: "UPLOAD_NOT_READY", message: "请等待图片上传完成" }, 409);
    image = { imageMode: "cos", imageObjectKey: upload.objectKey, imageContentType: upload.contentType };
  }
  const now = new Date();
  const result = await (await getCollection("publicWorkflows")).insertOne({ name, description, url, ...image, status: body.status === "disabled" ? "disabled" : "active", sort: Number.isFinite(Number(body.sort)) ? Math.trunc(Number(body.sort)) : 100, createdBy: new ObjectId(auth.user.id), createdAt: now, updatedAt: now });
  const workflow = await (await getCollection("publicWorkflows")).findOne({ _id: result.insertedId });
  return c.json({ workflow: workflowJson(workflow) }, 201);
});

app.put("/api/admin/workflows/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" }, 404);
  const workflows = await getCollection("publicWorkflows");
  const current = await workflows.findOne({ _id: new ObjectId(c.req.param("id")) });
  if (!current) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? current.name).trim();
  const description = String(body.description ?? current.description ?? "").trim();
  const url = workflowTargetUrl(body.url ?? current.url);
  if (name.length < 2 || name.length > 60 || description.length > 300 || !url) return c.json({ code: "VALIDATION_ERROR", message: "工作流信息不完整" }, 400);
  const set = { name, description, url, status: body.status === "disabled" ? "disabled" : "active", sort: Number.isFinite(Number(body.sort)) ? Math.trunc(Number(body.sort)) : Number(current.sort || 100), updatedAt: new Date(), updatedBy: new ObjectId(auth.user.id) };
  let oldObjectKey = null;
  if (body.imageUploadId) {
    if (!ObjectId.isValid(body.imageUploadId)) return c.json({ code: "UPLOAD_NOT_FOUND", message: "图片上传记录无效" }, 400);
    const upload = await (await getCollection("workflowImageUploads")).findOneAndUpdate({ _id: new ObjectId(body.imageUploadId), status: "ready" }, { $set: { status: "attached", attachedAt: new Date() } }, { returnDocument: "after" });
    if (!upload) return c.json({ code: "UPLOAD_NOT_READY", message: "请等待图片上传完成" }, 409);
    oldObjectKey = current.imageMode === "cos" ? current.imageObjectKey : null;
    Object.assign(set, { imageMode: "cos", imageObjectKey: upload.objectKey, imageContentType: upload.contentType });
  }
  const updated = await workflows.findOneAndUpdate({ _id: current._id }, { $set: set }, { returnDocument: "after" });
  if (oldObjectKey) await deleteObject(oldObjectKey).catch(() => null);
  return c.json({ workflow: workflowJson(updated) });
});

app.delete("/api/admin/workflows/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" }, 404);
  const workflows = await getCollection("publicWorkflows");
  const workflow = await workflows.findOne({ _id: new ObjectId(c.req.param("id")) });
  if (!workflow) return c.json({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" }, 404);
  if (workflow.systemKey) {
    await (await getCollection("publicWorkflowTombstones")).updateOne(
      { _id: workflow.systemKey },
      {
        $set: { deletedAt: new Date(), deletedBy: new ObjectId(auth.user.id), workflowId: workflow._id },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }
  await workflows.deleteOne({ _id: workflow._id });
  if (workflow.imageMode === "cos" && workflow.imageObjectKey) await deleteObject(workflow.imageObjectKey).catch(() => null);
  return c.json({ ok: true, deletedSystemKey: workflow.systemKey || null });
});

app.get("/api/billing/plans", async (c) => {
  const pricing = await currentSubscriptionPricing();
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({
    plans: [
      { id: "free", name: "普通用户", monthlyFen: 0, yearlyFen: 0, autoRenew: false },
      { id: "member", name: "会员用户", monthlyFen: pricing.monthly.amountFen, yearlyFen: pricing.yearly.amountFen, autoRenew: false, renewalMode: "manual", reminderDays: RENEWAL_REMINDER_DAYS },
      { id: SHORT_VIDEO_PLAN_ID, name: SHORT_VIDEO_PLAN_NAME, monthlyFen: SHORT_VIDEO_MONTHLY_PRICE_FEN, yearlyFen: SHORT_VIDEO_YEARLY_PRICE_FEN, autoRenew: false, renewalMode: "manual", paymentProviders: ["offline"], unlimitedModel: "minimax_h3_shared", walletCreditMultiplier: 1 },
      { id: "custom", name: "深度定制", pricing: "结果式付费 · 利润五五分", autoRenew: false },
    ],
    providers: {
      mode: "live",
      wechat: true,
      offline: true,
      autoRenew: { wechat: false },
      availability: ONLINE_PAYMENT_AVAILABILITY,
    },
    walletPromotion: {
      subscriptionBonusRate: 0.1,
      rechargeBonusRate: 0.1,
      rechargeThresholdFen: 50_000,
      thresholdInclusive: true,
      shortVideoSubscriptionBonusRate: 1,
    },
    pricingRevision: pricing.revision,
  });
});

app.get("/api/cron/subscription-reminders", async (c) => {
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const authorization = String(c.req.header("authorization") || "");
  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    return c.json({ code: "CRON_UNAUTHORIZED", message: "定时任务认证失败" }, 401);
  }
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json(await sendDailyRenewalReminders());
});

app.post("/api/billing/orders", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json();
  const provider = ["wechat", "offline"].includes(body.provider) ? body.provider : null;
  const cycle = body.cycle === "year" ? "year" : body.cycle === "month" ? "month" : null;
  const kind = body.kind === "recharge"
    ? "recharge"
    : body.kind === "custom"
      ? "custom"
      : body.kind === "worker_task"
        ? "worker_task"
        : "subscription";
  const subscriptionPlan = kind === "subscription" && body.planType === SHORT_VIDEO_PLAN_ID
    ? SHORT_VIDEO_PLAN_ID
    : "member";
  const now = new Date();
  const ownerId = new ObjectId(auth.user.id);
  const pricing = kind === "subscription" ? await currentSubscriptionPricing(now) : null;
  let workerTask = null;
  if (kind === "worker_task") {
    if (!ObjectId.isValid(body.taskId)) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在" }, 404);
    const taskId = new ObjectId(body.taskId);
    workerTask = await (await getCollection("workerTasks")).findOne({ _id: taskId, publisherId: ownerId });
    if (!workerTask) return c.json({ code: "TASK_NOT_FOUND", message: "威客任务不存在或不属于当前账号" }, 404);
    const existingPayment = await (await getCollection("payments")).findOne({ taskId, ownerId, kind: "worker_task", status: "pending" }, { sort: { createdAt: -1 } });
    if (existingPayment) {
      c.header("Cache-Control", "private, no-store, max-age=0");
      return c.json({
        orderNo: existingPayment.orderNo,
        status: existingPayment.status,
        paymentUrl: existingPayment.paymentUrl || null,
        qrCodeDataUrl: existingPayment.qrCodeDataUrl || null,
        mode: "chandler",
        provider: existingPayment.provider,
        amountFen: existingPayment.amountFen,
        taskId: taskId.toString(),
      });
    }
    if (!["awaiting_payment", "payment_rejected"].includes(workerTask.status) || !["awaiting_payment", "rejected"].includes(workerTask.paymentStatus)) {
      return c.json({ code: "TASK_STATE_CHANGED", message: "该任务已提交付款、已发布或状态已变化" }, 409);
    }
  }
  let amountFen = kind === "worker_task"
    ? Number(workerTask.budgetFen)
    : kind === "recharge" || kind === "custom"
      ? Number(body.amountFen)
      : subscriptionPlan === SHORT_VIDEO_PLAN_ID
        ? shortVideoSubscriptionPriceFen(cycle)
        : cycle === "year"
          ? pricing.yearly.amountFen
          : pricing.monthly.amountFen;
  const maxAmountFen = kind === "custom"
    ? CUSTOM_ORDER_MAX_FEN
    : kind === "worker_task"
      ? 5_000_000
      : SUBSCRIPTION_PRICE_MAX_FEN;
  if (!provider || !Number.isInteger(amountFen) || amountFen < 100 || amountFen > maxAmountFen) {
    return c.json({ code: "VALIDATION_ERROR", message: "支付方式、周期或金额不正确" }, 400);
  }
  if (!cycle && kind === "subscription") return c.json({ code: "VALIDATION_ERROR", message: "订阅周期不正确" }, 400);
  if (provider === "offline" && !["subscription", "recharge"].includes(kind)) return c.json({ code: "VALIDATION_ERROR", message: "线下支付仅用于会员订阅或账户充值审核" }, 400);
  if (subscriptionPlan === SHORT_VIDEO_PLAN_ID && provider !== "offline") return c.json({ code: "OFFLINE_PAYMENT_REQUIRED", message: "短视频包月当前仅支持线下支付" }, 400);
  const orderNo = `GL${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
  const autoRenewRequested = kind === "subscription" && Boolean(body.autoRenew);
  const activeSubscription = kind === "subscription" && subscriptionPlan === "member" && cycle === "year"
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
  const localPriceVersion = kind === "subscription" && subscriptionPlan === "member" && !isMonthlyUpgrade
    ? await effectiveLocalPrice({ cycle, at: now })
    : null;
  if (localPriceVersion) amountFen = localPriceVersion.amountFen;
  const autoRenew = false;

  if (provider === "offline") {
    const promotionBonusFen = subscriptionPlan === SHORT_VIDEO_PLAN_ID
      ? 0
      : paymentPromotionBonusFen({ amountFen, kind: kind === "recharge" ? "recharge" : "subscription_payment" });
    let plans = [];
    let offlineAccessToken = null;
    try {
      offlineAccessToken = await getChandlerAccessToken(auth.session);
      plans = await listPartnerSubscriptionPlans(offlineAccessToken);
    }
    catch { /* The website keeps accepting offline review orders while Chandler catalog access is unavailable. */ }
    const marker = cycle === "year" ? "year" : "month";
    const plan = kind === "recharge" ? {
      productId: "gulong-wallet-recharge",
      productName: "古龙账户余额充值",
      skuId: "gulong-wallet-offline-recharge",
      skuName: "线下余额充值",
      skuType: "recharge",
      billingInterval: "one_time",
      amountFen,
      source: "website-offline-recharge",
    } : subscriptionPlan === SHORT_VIDEO_PLAN_ID ? {
      productId: SHORT_VIDEO_PLAN_ID,
      productName: SHORT_VIDEO_PLAN_NAME,
      skuId: cycle === "year" ? "gulong-short-video-year" : "gulong-short-video-month",
      skuName: `${SHORT_VIDEO_PLAN_NAME} · ${cycle === "year" ? "年度" : "月度"}`,
      skuType: cycle,
      billingInterval: cycle,
      amountFen,
      source: "website-short-video-package",
    } : plans.find((item) => `${item.skuType} ${item.billingInterval}`.toLowerCase().includes(marker)) || {
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
      kind,
      subscription_plan: kind === "subscription" ? subscriptionPlan : null,
      plan_kind: kind === "recharge" ? "recharge" : subscriptionPlan === SHORT_VIDEO_PLAN_ID ? SHORT_VIDEO_PLAN_ID : cycle === "year" ? "yearly" : "monthly",
      billing_interval: kind === "subscription" ? cycle : "one_time",
      amount_fen: amountFen,
      promotion_bonus_fen: promotionBonusFen,
      wallet_credit_fen: amountFen + promotionBonusFen,
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
        subject: kind === "recharge" ? "古龙账户余额充值（线下审核）" : subscriptionPlan === SHORT_VIDEO_PLAN_ID ? `${SHORT_VIDEO_PLAN_NAME}（线下审核）` : cycle === "year" ? "年度订阅会员（线下审核）" : "月度订阅会员（线下审核）",
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
      kind,
      cycle,
      subscriptionPlan,
      amountFen,
      promotionBonusFen,
      creditedFen: amountFen + promotionBonusFen,
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
    return c.json({ id: result.insertedId.toString(), orderNo, status: "pending_review", mode: "offline", planType: subscriptionPlan, amountFen, bonusFen: promotionBonusFen, creditedFen: amountFen + promotionBonusFen, upgradeCreditFen }, 201);
  }

  // Creating an order is a service-side, role-guarded operation and is
  // authenticated with the configured Chandler API Key inside the adapter.
  // Prepay deliberately retains the end-user token so Chandler can resolve
  // the real payer/openid for JSAPI and other user-bound payment modes.
  const accessToken = await getChandlerAccessToken(auth.session);
  let result;
  if (kind === "subscription" && !isMonthlyUpgrade) {
    result = await createSubscriptionCheckout(accessToken, {
      cycle,
      channel: provider,
      merchantOrderNo: orderNo,
      expectedAmountFen: amountFen,
      partnerData: { user_id: auth.user.id, user_email: auth.user.email },
    });
  } else if (kind === "subscription") {
    result = await createDirectPaymentOrder(accessToken, {
      merchantOrderNo: orderNo,
      channel: provider,
      amountFen,
      subject: isMonthlyUpgrade ? "月度会员升级年度会员" : cycle === "year" ? "古龙年度会员" : "古龙月度会员",
      source: "gulong-web-subscription-upgrade",
      partnerData: { schema_version: 2, kind: "subscription_upgrade", cycle: "year", upgrade_from: "month", upgrade_credit_fen: upgradeCreditFen, upgrade_base_start: upgradeBaseStart.toISOString(), amount_fen: amountFen },
    });
  } else if (kind === "worker_task") {
    result = await createDirectPaymentOrder(accessToken, {
      merchantOrderNo: orderNo,
      channel: provider,
      amountFen,
      subject: `威客任务预算 · ${workerTask.title}`.slice(0, 80),
      source: "gulong-web-worker-task",
      partnerData: {
        schema_version: 3,
        kind: "worker_task_escrow",
        task_id: workerTask._id.toString(),
        amount_fen: amountFen,
        user_id: auth.user.id,
        user_email: auth.user.email,
      },
    });
  } else {
    result = await createDirectPaymentOrder(accessToken, {
      merchantOrderNo: orderNo,
      channel: provider,
      amountFen,
      subject: kind === "custom" ? String(body.subject || "古龙深度定制服务订单").trim().slice(0, 80) : "古龙账户充值",
      source: kind === "custom" ? "gulong-web-custom-order" : "gulong-web-topup",
      partnerData: { schema_version: 3, kind: kind === "custom" ? "custom_service_order" : "wallet_topup", amount_fen: amountFen, user_id: auth.user.id, user_email: auth.user.email },
    });
  }
  const chandlerAmountFen = Number(result.checkout?.amount ?? result.order?.amount);
  if (Number.isSafeInteger(chandlerAmountFen) && chandlerAmountFen >= 0) amountFen = chandlerAmountFen;
  const promotionBonusFen = paymentPromotionBonusFen({ amountFen, kind: kind === "subscription" ? "subscription_payment" : kind });
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
    promotionBonusFen,
    creditedFen: ["subscription", "recharge"].includes(kind) ? amountFen + promotionBonusFen : amountFen,
    ...(workerTask ? { taskId: workerTask._id } : {}),
    autoRenew,
    chandler: true,
    status: "pending",
    paymentUrl: paymentUrl || null,
    qrCodeDataUrl: qrCodeDataUrl || null,
    ...(isMonthlyUpgrade ? { upgradeFrom: "month", upgradeCreditFen, upgradeBaseStart } : {}),
    ...(localPriceVersion ? { localPriceVersionId: localPriceVersion._id } : {}),
    createdAt: now,
    updatedAt: now,
  });
  if (workerTask) {
    const linked = await (await getCollection("workerTasks")).updateOne(
      { _id: workerTask._id, publisherId: ownerId, status: { $in: ["awaiting_payment", "payment_rejected"] }, paymentStatus: { $in: ["awaiting_payment", "rejected"] } },
      {
        $set: {
          paymentStatus: "pending_online",
          paymentMethod: "wechat",
          paymentOrderNo: actualOrderNo,
          paymentSubmittedAt: now,
          updatedAt: now,
        },
        $unset: { paymentReviewReason: "", paymentReviewedAt: "", paymentReviewedBy: "" },
        $inc: { paymentSubmissionCount: 1 },
      },
    );
    if (!linked.matchedCount) {
      await (await getCollection("payments")).updateOne({ orderNo: actualOrderNo }, { $set: { status: "failed", failureCode: "TASK_STATE_CHANGED", updatedAt: new Date() } });
      return c.json({ code: "TASK_STATE_CHANGED", message: "任务状态已变化，请刷新后重试" }, 409);
    }
  }
  return c.json({
    orderNo: actualOrderNo,
    status: "pending",
    paymentUrl,
    qrCodeDataUrl,
    mode: "chandler",
    provider,
    amountFen,
    bonusFen: promotionBonusFen,
    creditedFen: ["subscription", "recharge"].includes(kind) ? amountFen + promotionBonusFen : amountFen,
    upgradeCreditFen,
    autoRenewRequested,
    autoRenewAvailable: !isMonthlyUpgrade,
    priceSource: kind === "subscription" ? "website-membership-ledger" : "chandler",
    ...(workerTask ? { taskId: workerTask._id.toString() } : {}),
  }, 201);
});

async function activatePayment(orderNo, providerTransactionId) {
  const payments = await getCollection("payments");
  let payment = await payments.findOneAndUpdate(
    { orderNo, status: "pending" },
    { $set: { status: "paid", providerTransactionId, paidAt: new Date(), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!payment) {
    const completed = await payments.findOne({ orderNo, status: "paid" });
    if (!completed || completed.kind !== "worker_task") return;
    payment = completed;
  }
  if (payment.kind === "subscription") {
    const existingSubscription = await (await getCollection("subscriptions")).findOne({ ownerId: payment.ownerId });
    const now = new Date();
    const existingEnd = existingSubscription?.currentPeriodEnd ? new Date(existingSubscription.currentPeriodEnd) : null;
    const extendingActivePeriod = Boolean(existingEnd && existingEnd > now);
    const renewalBase = extendingActivePeriod ? existingEnd : now;
    const start = payment.upgradeFrom === "month"
      ? new Date(payment.upgradeBaseStart || existingSubscription?.currentPeriodStart || now)
      : extendingActivePeriod ? new Date(existingSubscription.currentPeriodStart || now) : now;
    const end = new Date(payment.upgradeFrom === "month" ? start : renewalBase);
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
          autoRenew: false,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    await creditPaymentBalanceWithPromotion({ ownerId: payment.ownerId, amountFen: payment.amountFen, source: "online_subscription", sourceId: payment.orderNo, kind: "subscription_payment" });
    await notifyUserOnce(payment.ownerId, "subscription_payment_succeeded", "会员续费已生效", `微信支付已到账，${payment.cycle === "year" ? "年度" : "月度"}会员权益已同步到官网与桌面端。`, { orderNo: payment.orderNo });
  } else if (payment.kind === "recharge") {
    await creditPaymentBalanceWithPromotion({ ownerId: payment.ownerId, amountFen: payment.amountFen, source: "online_recharge", sourceId: payment.orderNo, kind: "recharge" });
  } else if (payment.kind === "custom") {
    await notifyUserOnce(payment.ownerId, "custom_order_paid", "深度定制订单支付成功", "微信支付已到账，我们会根据订单信息与你联系并推进交付。", { orderNo: payment.orderNo });
  } else if (payment.kind === "worker_task" && payment.taskId) {
    const now = new Date();
    const tasks = await getCollection("workerTasks");
    let task = await tasks.findOneAndUpdate(
      {
        _id: payment.taskId,
        publisherId: payment.ownerId,
        paymentOrderNo: payment.orderNo,
        status: { $in: ["awaiting_payment", "payment_rejected"] },
        paymentStatus: "pending_online",
      },
      {
        $set: {
          status: "open",
          paymentStatus: "approved",
          paymentMethod: "wechat",
          paymentReviewedAt: now,
          onlinePaidAt: now,
          escrowStatus: "locked",
          updatedAt: now,
        },
        $unset: { paymentReviewReason: "", paymentReviewedBy: "" },
      },
      { returnDocument: "after" },
    );
    if (!task) task = await tasks.findOne({ _id: payment.taskId, publisherId: payment.ownerId, paymentOrderNo: payment.orderNo, status: "open", paymentStatus: "approved" });
    if (task) await notifyWorkerTaskReady(task, { online: true });
  }
}

function chandlerOrderPaid(order = {}) {
  return ["paid", "success", "succeeded", "completed"].includes(String(order.status || order.trade_state || "").toLowerCase());
}

async function reconcileChandlerPayment(orderNo) {
  const payment = await (await getCollection("payments")).findOne({ orderNo });
  if (!payment) return null;
  if (payment.status === "paid") {
    if (payment.kind === "worker_task") await activatePayment(orderNo, payment.providerTransactionId || orderNo);
    return payment;
  }
  const order = await getDirectPaymentOrder(orderNo);
  const remoteAmount = Number(order.amount);
  if (Number.isSafeInteger(remoteAmount) && remoteAmount !== payment.amountFen) {
    throw new ChandlerError("Chandler 订单金额与官网订单不一致", { status: 409, code: "PAYMENT_AMOUNT_MISMATCH" });
  }
  if (chandlerOrderPaid(order)) {
    await activatePayment(orderNo, order.transaction_id || order.channel_transaction_no || orderNo);
    return (await getCollection("payments")).findOne({ orderNo });
  }
  return { ...payment, remoteStatus: order.status || null };
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

app.post("/api/billing/webhooks/chandler", async (c) => {
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  if (!verifyChandlerWebhook(rawBody, c.req.header("x-chandler-signature"))) {
    return c.json({ code: "INVALID_SIGNATURE", message: "Chandler Webhook 签名验证失败" }, 401);
  }
  let notification;
  try {
    notification = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return c.json({ code: "INVALID_WEBHOOK_BODY", message: "Chandler Webhook 不是有效的 JSON" }, 400);
  }
  const orderNo = String(notification.platform_order_no || notification.data?.platform_order_no || "").trim();
  if (!orderNo) return c.json({ code: "ORDER_NUMBER_REQUIRED", message: "Chandler Webhook 缺少订单号" }, 400);
  // reconcileChandlerPayment and activatePayment are both idempotent. A
  // delayed or replayed webhook therefore cannot grant an entitlement twice.
  await reconcileChandlerPayment(orderNo);
  return c.json({ ok: true });
});

app.get("/api/billing/payments/:orderNo/status", async (c) => {
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const orderNo = String(c.req.param("orderNo") || "").trim();
  const payment = await (await getCollection("payments")).findOne({ orderNo, ownerId: new ObjectId(auth.user.id) });
  if (!payment) return c.json({ code: "ORDER_NOT_FOUND", message: "订单不存在" }, 404);
  const reconciled = await reconcileChandlerPayment(orderNo);
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({ orderNo, status: reconciled?.status || "pending", remoteStatus: reconciled?.remoteStatus || null });
});

app.get("/api/billing/subscription", async (c) => {
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const ownerId = new ObjectId(auth.user.id);
  const pendingOrders = await (await getCollection("payments")).find({ ownerId, chandler: true, status: "pending" }, { projection: { orderNo: 1 } }).sort({ createdAt: -1 }).limit(8).toArray();
  await mapWithConcurrency(pendingOrders, 4, (item) => reconcileChandlerPayment(item.orderNo).catch(() => null));
  const evaluatedLifecycle = await refreshSubscriptionLifecycle(ownerId);
  const lifecycle = auth.user.role === "admin" ? { ...evaluatedLifecycle, restricted: false, renewalDue: false } : evaluatedLifecycle;
  const subscription = await (await getCollection("subscriptions")).findOne({ ownerId });
  const wallet = await (await getCollection("wallets")).findOne({ ownerId });
  const subscriptionStatus = subscription
    ? subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd)
    : null;
  return c.json({
    subscription: subscription ? { ...subscription, status: subscriptionStatus, id: subscription._id.toString(), _id: undefined, ownerId: undefined } : null,
    subscriptionLifecycle: lifecycle,
    balanceFen: wallet?.balanceFen || 0,
    shortVideoPackage: shortVideoPackageView(subscription, wallet),
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
  const requestedKind = String(c.req.query("kind") || "").trim();
  if (requestedKind && !["recharge", "subscription"].includes(requestedKind)) {
    return c.json({ code: "VALIDATION_ERROR", message: "订单类型只能是充值或订阅" }, 400);
  }
  const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query("limit") || "30", 10) || 30));
  const filter = {
    ownerId: new ObjectId(auth.user.id),
    ...(requestedKind ? { kind: requestedKind } : {}),
  };
  const orders = await (await getCollection("offlinePayments"))
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({
    orders: orders.map((order) => ({
      id: order._id.toString(),
      orderNo: order.orderNo,
      kind: order.kind || "subscription",
      provider: "offline",
      cycle: order.cycle || null,
      amountFen: Number(order.amountFen || 0),
      bonusFen: Number(order.promotionBonusFen || 0),
      creditedFen: Number(order.creditedFen || order.amountFen || 0),
      status: order.status,
      reviewReason: order.reviewReason || null,
      previousReviewReason: order.previousReviewReason || null,
      resubmissionNote: order.resubmissionNote || null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt || order.createdAt,
      reviewedAt: order.reviewedAt || null,
      validUntil: order.validUntil || null,
    })),
    query: { kind: requestedKind || null, limit },
  });
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
  await syncChandlerOfflinePayments(await getAdminChandlerAccessToken(auth).catch(() => null)).catch(() => null);
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
    accessToken: await getAdminChandlerAccessToken(auth).catch(() => null),
    validFrom: body.validFrom,
    validUntil: body.validUntil,
  });
  if (result.error) return c.json({ code: result.error.code, message: localizeErrorMessage(result.error.message) }, result.error.status);
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
    accessToken: await getAdminChandlerAccessToken(auth).catch(() => null),
    reason: body.reason,
  });
  if (result.error) return c.json({ code: result.error.code, message: localizeErrorMessage(result.error.message) }, result.error.status);
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
  if (result.error) return c.json({ code: result.error.code, message: localizeErrorMessage(result.error.message) }, result.error.status);
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
    return c.json({ code: result.error.code, message: localizeErrorMessage(result.error.message) }, result.error.status);
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
  const lifecycle = await refreshSubscriptionLifecycle(auth.user._id, now);
  const subscription = await (await getCollection("subscriptions")).findOne({ ownerId: auth.user._id });
  const wallet = await (await getCollection("wallets")).findOne({ ownerId: auth.user._id });
  const status = subscription
    ? subscriptionPeriodState(subscription.currentPeriodStart, subscription.currentPeriodEnd, now)
    : "inactive";
  const active = status === "active";
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  return c.json({
    isMember: auth.identity.role === "admin" || Boolean(active),
    restricted: auth.identity.role === "admin" ? false : lifecycle.restricted,
    renewalDue: lifecycle.renewalDue,
    daysRemaining: lifecycle.daysRemaining,
    renewalAction: lifecycle.restricted || lifecycle.renewalDue ? { type: "open_url", url: "https://www.sologle.com/pricing?tab=subscription&source=desktop", paymentChannel: "wechat" } : null,
    subscription: subscription ? {
      plan: subscription.plan || "member",
      cycle: subscription.cycle || null,
      provider: subscription.provider || null,
      status,
      currentPeriodStart: subscription.currentPeriodStart || null,
      currentPeriodEnd: subscription.currentPeriodEnd || null,
      autoRenew: false,
      renewalMode: "manual",
    } : null,
    balanceFen: wallet?.balanceFen || 0,
    shortVideoPackage: shortVideoPackageView(subscription, wallet, now),
    checkedAt: now,
  });
});

app.openapi(desktopAccountUsageRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c);
  if (auth.error) return auth.error;
  const now = new Date();
  const usage = await buildPearAccountUsageSnapshot({
    ownerId: auth.user._id,
    unlimited: auth.identity.role === "admin",
    now,
  });
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  return c.json({
    currency: "CNY",
    quota: usage.quota,
    subscription: usage.subscription,
    shortVideoPackage: usage.shortVideoPackage,
    checkedAt: now,
  });
});

app.openapi(desktopChandlerCatalogRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const query = c.req.valid("query");
  const application = desktopChandlerApplication(query.applicationKey, query.themeName);
  const plans = await listPartnerSubscriptionPlans(null, application.clientId);
  return c.json({
    plans: plans.map((plan) => ({
      application,
      productId: plan.productId,
      productName: application.name,
      productDescription: plan.skuCode || "",
      skuId: plan.skuId,
      skuName: plan.skuName,
      skuType: plan.skuType || plan.skuCode || "",
      priceId: plan.priceId || "",
      amountFen: Number(plan.amountFen || 0),
      currency: plan.currency || "CNY",
      billingInterval: plan.billingInterval || "",
    })),
  });
});

app.openapi(desktopChandlerPublishPriceRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c, { admin: true });
  if (auth.error) return auth.error;
  const input = c.req.valid("json");
  const application = desktopChandlerApplication(input.applicationKey, input.themeName);
  const plans = await listPartnerSubscriptionPlans(null, application.clientId);
  const plan = plans.find((item) => item.skuId === input.skuId);
  if (!plan) return c.json({ code: "SKU_NOT_FOUND", message: "所选订阅套餐已经下架，请刷新后重试" }, 404);
  const price = await createPartnerPriceVersion(null, {
    skuId: plan.skuId,
    amountFen: input.amountFen,
    currency: plan.currency || "CNY",
    billingInterval: plan.billingInterval,
    intervalCount: plan.intervalCount || 1,
    effectiveAt: input.effectiveAt,
    applicationId: application.clientId,
  });
  await persistChandlerPriceVersion({ plan, price, createdBy: auth.user._id.toString(), source: "desktop-admin-official-proxy" });
  return c.json({
    application,
    skuId: price.sku_id || input.skuId,
    priceId: price.id || "",
    amountFen: Number(price.amount || input.amountFen),
    currency: price.currency || plan.currency || "CNY",
    billingInterval: price.billing_interval || "once",
    status: price.status || "active",
    effectiveAt: price.effective_at || input.effectiveAt,
    message: "新的订阅价格版本已由官网安全代理发布",
  }, 201);
});

app.openapi(desktopChandlerCheckoutRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c);
  if (auth.error) return auth.error;
  const input = c.req.valid("json");
  const application = desktopChandlerApplication(input.applicationKey, input.themeName);
  const cycle = input.planKind === "yearly" ? "year" : "month";
  const pricing = await currentSubscriptionPricing();
  const amountFen = cycle === "year" ? pricing.yearly.amountFen : pricing.monthly.amountFen;
  if (input.expectedAmountFen !== amountFen) {
    return c.json({ code: "PRICE_CHANGED", message: `官网订阅价格已更新为 ¥${(amountFen / 100).toFixed(2)}，请刷新后重新提交` }, 409);
  }
  const payments = await getCollection("payments");
  const existing = await payments.findOne({ ownerId: auth.user._id, desktopRequestId: input.clientOrderNo });
  if (existing) {
    return c.json({
      application,
      orderNo: existing.orderNo,
      amountFen: existing.amountFen,
      currency: existing.currency || "CNY",
      subject: existing.subject || (cycle === "year" ? "年度订阅会员" : "月度订阅会员"),
      channel: existing.provider || "wechat",
      codeUrl: existing.codeUrl || "",
      h5Url: existing.h5Url || "",
      payUrl: existing.payUrl || "",
    }, 201);
  }
  const result = await createSubscriptionCheckout(auth.accessToken, {
    cycle,
    channel: input.channel,
    merchantOrderNo: input.clientOrderNo,
    expectedAmountFen: amountFen,
    source: "windows-desktop-official-proxy",
    applicationId: application.clientId,
    applicationKey: application.key,
    productName: `${application.name}会员`,
    partnerData: {
      user_id: String(auth.chandlerUser.id),
      user_email: auth.user.email || auth.chandlerUser.email || null,
      theme_name: application.themeName,
      release_channel: input.releaseChannel,
      release_channel_name: input.releaseChannel,
      client_version: c.req.header("x-gulong-version") || null,
    },
  });
  const orderNo = result.orderNo || result.order?.platform_order_no || result.order?.order_no;
  if (!orderNo) return c.json({ code: "CHANDLER_ORDER_INVALID", message: "合作平台没有返回订单号，未发起支付" }, 502);
  const prepay = result.prepay || result.payment || {};
  const checkout = result.checkout || result.order || {};
  const subject = checkout.subject || (cycle === "year" ? "年度订阅会员" : "月度订阅会员");
  const document = {
    orderNo,
    merchantOrderNo: input.clientOrderNo,
    desktopRequestId: input.clientOrderNo,
    ownerId: auth.user._id,
    provider: input.channel,
    kind: "subscription",
    cycle,
    applicationKey: application.key,
    applicationId: application.clientId,
    themeName: application.themeName,
    releaseChannel: input.releaseChannel,
    amountFen,
    currency: checkout.currency || "CNY",
    subject,
    codeUrl: prepay.code_url || "",
    h5Url: prepay.h5_url || "",
    payUrl: prepay.pay_url || "",
    autoRenew: false,
    chandler: true,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await payments.insertOne(document);
  return c.json({
    application,
    orderNo,
    amountFen,
    currency: document.currency,
    subject,
    channel: input.channel,
    codeUrl: document.codeUrl,
    h5Url: document.h5Url,
    payUrl: document.payUrl,
  }, 201);
});

app.openapi(desktopChandlerOrderStatusRoute, async (c) => {
  const auth = await authenticateDesktopChandler(c);
  if (auth.error) return auth.error;
  const { orderNo } = c.req.valid("param");
  const payment = await (await getCollection("payments")).findOne({ orderNo, ownerId: auth.user._id });
  if (!payment) return c.json({ code: "ORDER_NOT_FOUND", message: "订单不存在或不属于当前账号" }, 404);
  const reconciled = await reconcileChandlerPayment(orderNo);
  const status = reconciled?.status || payment.status || "pending";
  return c.json({
    orderNo,
    status,
    paid: chandlerOrderPaid({ status }) || chandlerOrderPaid({ status: reconciled?.remoteStatus }),
  });
});

app.openapi(createTaskRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["tasks:write"] });
  if (auth.error) return auth.error;
  const lifecycle = await refreshSubscriptionLifecycle(new ObjectId(auth.user.id));
  if (auth.user.role !== "admin" && lifecycle.restricted) return c.json({ code: "SUBSCRIPTION_EXPIRED", message: "会员已到期，请使用微信续费后继续创建任务", renewalUrl: "https://www.sologle.com/pricing" }, 402);
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
  const lifecycle = await refreshSubscriptionLifecycle(new ObjectId(auth.user.id));
  if (auth.user.role !== "admin" && lifecycle.restricted) return c.json({ code: "SUBSCRIPTION_EXPIRED", message: "会员已到期，请续费后继续写入第二大脑" }, 402);
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
  return c.json({
    ...pricing,
    shortVideo: { id: SHORT_VIDEO_PLAN_ID, name: SHORT_VIDEO_PLAN_NAME, monthlyFen: SHORT_VIDEO_MONTHLY_PRICE_FEN, yearlyFen: SHORT_VIDEO_YEARLY_PRICE_FEN, paymentProviders: ["offline"], walletCreditMultiplier: 1, unlimitedModel: "minimax_h3_shared" },
    paymentAvailability: ONLINE_PAYMENT_AVAILABILITY,
  });
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

app.openAPIRegistry.registerComponent("securitySchemes", "chandlerWebhookSignature", {
  type: "apiKey",
  in: "header",
  name: "X-Chandler-Signature",
  description: "Chandler v3.2 支付通知 HMAC-SHA256 十六进制签名；必须基于原始请求体校验。",
});

app.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/workflows",
  tags: ["Public Workflows"],
  summary: "搜索官网工作流",
  security: [],
  request: { query: z.object({ q: z.string().optional() }) },
  responses: { 200: { description: "工作流列表", content: { "application/json": { schema: z.object({ workflows: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), url: z.string(), imageUrl: z.string(), status: z.string() })), query: z.string() }) } } } },
});

app.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/billing/plans",
  tags: ["Billing"],
  summary: "读取实时会员价格与钱包赠送规则",
  security: [],
  responses: { 200: { description: "会员价格、支付渠道和促销口径；金额均为整数分" } },
});

app.openAPIRegistry.registerPath({
  method: "post",
  path: "/api/billing/orders",
  tags: ["Billing"],
  summary: "创建微信支付或线下审核订单",
  description: "线上仅支持微信。subscription 默认创建普通会员月/年订单；planType=short_video_monthly 创建短视频包月订单且仅允许 provider=offline，月费 599900 分、年费 5999900 分，审核后按实付金额 1:1 计入套餐余额，不额外赠送。普通会员实付金额额外赠送 10%；recharge 单次实付满 500 元额外赠送 10%。金额单位均为整数分。",
  request: { body: { content: { "application/json": { schema: z.object({ kind: z.enum(["subscription", "recharge", "custom", "worker_task"]), planType: z.enum(["member", "short_video_monthly"]).optional(), provider: z.enum(["wechat", "offline"]), cycle: z.enum(["month", "year"]).optional(), amountFen: z.number().int().min(100).optional(), subject: z.string().max(80).optional(), taskId: z.string().optional() }) } } } },
  responses: { 201: { description: "Chandler 微信预支付信息，或线下待审核订单" }, 400: { description: "参数或渠道不受支持" }, 401: { description: "未登录" } },
});

app.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/billing/offline-orders",
  tags: ["Billing"],
  summary: "查询当前用户的线下充值或订阅订单",
  description: "只返回当前登录账户的数据，按创建时间倒序。充值页使用 kind=recharge 展示可查询的充值订单；审核通过后 creditedFen 才会由服务端幂等计入钱包。金额均为整数分。",
  request: { query: z.object({ kind: z.enum(["recharge", "subscription"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
  responses: {
    200: { description: "当前账户线下订单", content: { "application/json": { schema: z.object({
      orders: z.array(z.object({
        id: z.string(),
        orderNo: z.string(),
        kind: z.enum(["recharge", "subscription"]),
        provider: z.literal("offline"),
        cycle: z.enum(["month", "year"]).nullable(),
        amountFen: z.number().int().min(0),
        bonusFen: z.number().int().min(0),
        creditedFen: z.number().int().min(0),
        status: z.string(),
        reviewReason: z.string().nullable(),
        previousReviewReason: z.string().nullable(),
        resubmissionNote: z.string().nullable(),
        createdAt: z.coerce.date(),
        updatedAt: z.coerce.date(),
        reviewedAt: z.coerce.date().nullable(),
        validUntil: z.coerce.date().nullable(),
      })),
      query: z.object({ kind: z.enum(["recharge", "subscription"]).nullable(), limit: z.number().int() }),
    }) } } },
    400: { description: "查询参数无效", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/billing/payments/{orderNo}/status",
  tags: ["Billing"],
  summary: "查询并同步微信支付状态",
  request: { params: z.object({ orderNo: z.string() }) },
  responses: { 200: { description: "支付状态" }, 404: { description: "订单不存在" } },
});

app.openAPIRegistry.registerPath({
  method: "post",
  path: "/api/billing/webhooks/chandler",
  tags: ["Billing"],
  summary: "接收 Chandler 支付通知",
  security: [{ chandlerWebhookSignature: [] }],
  responses: { 200: { description: "通知已验签并幂等处理" }, 401: { description: "签名无效" } },
});

app.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/admin/workflows",
  tags: ["Administration"],
  summary: "管理员读取工作流目录",
  responses: { 200: { description: "全部工作流" }, 403: { description: "需要管理员角色" } },
});

app.openAPIRegistry.registerPath({
  method: "post",
  path: "/api/licenses/redeem",
  tags: ["Licensing"],
  summary: "兑换设备永久离线授权",
  description: "安装器首次联网时提交一次性激活码与旧版 deviceId。激活码原子绑定首台设备；同一旧版 deviceId 可幂等恢复原 RS256 回执。新客户端可同时提交 h3-hw-v2 加权硬件分类摘要，服务端只保存 SHA-256 摘要和分类名，不接收原始主板、SMBIOS、TPM、MAC 或序列号值；旧授权在旧版 deviceId 精确匹配后可补录一次 v2 绑定，不改变 activatedAt。已有 v2 hardwareHash 不一致时拒绝激活。回执 canonical 字段与签名顺序保持兼容。",
  security: [],
  request: { body: { required: true, content: { "application/json": { schema: ActivationRedeemRequestSchema } } } },
  responses: {
    200: { description: "激活成功或同设备恢复成功", content: { "application/json": { schema: z.object({ ok: z.literal(true), receipt: ActivationReceiptSchema }) } } },
    400: { description: "激活码、设备指纹或硬件分类摘要格式不正确；原始硬件值会被拒绝", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "激活码已停用", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "激活码不存在", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "激活码已绑定其他设备、设备已有授权或 hardwareHash 与既有 v2 绑定不一致", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "激活尝试过于频繁", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "生产签名密钥尚未正确配置", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openAPIRegistry.registerPath({
  method: "post",
  path: "/api/admin/workflows",
  tags: ["Administration"],
  summary: "管理员创建工作流",
  request: { body: { content: { "application/json": { schema: z.object({ name: z.string().min(2).max(60), description: z.string().max(300).optional(), url: z.string(), imageUploadId: z.string().optional(), status: z.enum(["active", "disabled"]).optional(), sort: z.number().int().optional() }) } } } },
  responses: { 201: { description: "工作流已创建" }, 403: { description: "需要管理员角色" } },
});

app.doc("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "古龙 Gulong Agent Engine API",
    version: "2.5.0",
    description: "已按 Chandler v3.9 与 PearAPI 统一接入升级：OAuth 应用密钥配置完成后，官网邮箱注册和已激活桌面客户端的邮箱/手机号注册均由官网服务端注入对应应用凭据，写入 Chandler 应用来源归因；client_secret 永不进入浏览器或桌面客户端。桌面端缺少归因凭据时故障关闭；官网公开邮箱注册按 Chandler 兼容合同保持可用但不伪造归因。邮箱和短信验证码统一为 6 位数字；服务端管理与支付调用使用受保护 API Key，线上收银仅支持微信单次付款，Webhook 使用原始请求体 HMAC-SHA256 验签并二次查询订单。网页版古龙 Agent 只允许管理员公布的 PearAPI 免费模型，令牌经 AES-256-GCM 加密保存且不会返回浏览器。普通会员由古龙维护月/年有效期，到期前 7 天每天提醒手动续费；实付额外赠送 10% 钱包余额，单次充值满 500 元同样赠送 10%。短视频包月固定月费 5999 元、年费 59999 元，只支持线下审核，审核后实付金额按 1:1 组成可到期套餐余额，不额外赠送；有效期内 MiniMaxH3 套餐余额归零后仍可无限生成，但不再扣费或分佣。所有入账、扣款、退款和分账均使用独立幂等流水。MiniMax H3 共享节点支持钱包预扣、幂等退款与 50% 节点分成、激活设备账号绑定、按能力原子领取、腾讯云 COS 输入下载和输出直传票据，并提供仅按绑定账户聚合的桌面收益接口；工作器领取 DTO 不含需求用户身份和内部计费信息。永久离线授权继续签发旧版 canonical RS256 回执，同时可选绑定 h3-hw-v2 加权硬件分类摘要；服务端不保存任何原始硬件值。另提供第二大脑、工作流、发行版本、管理员经营分析与桌面同步接口。古龙开发者 API Key 仅在创建时显示一次；COS 下载链接默认 15 分钟失效。",
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

export {
  HARDWARE_COMPONENT_WEIGHTS,
  activationHardwareBindingAction,
  activationReceiptPayload,
  activationSigningPrivateKey,
  parseActivationHardwareBindingV2,
  persistActivationHardwareBindingV2,
  signActivationReceipt,
  verifyActivationReceipt,
};
export default app;
