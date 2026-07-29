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
  createSubscriptionCheckout,
  externalAuthFromResponse,
  getChandlerAccessToken,
  issueOfflineCredential,
  listCatalogPlans,
  loginWithChandler,
  logoutFromChandler,
  registerWithChandler,
  upsertChandlerUser,
} from "./chandler.js";
import {
  cosConfig,
  createPresignedDownloadUrl,
  createPresignedPutUrl,
  deleteObject,
  headObject,
  sanitizeFilename,
} from "./cos.js";

const app = new OpenAPIHono();

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
  createdAt: z.coerce.date(),
});

const RegisterSchema = z
  .object({
    username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u).optional(),
    email: z.email(),
    displayName: z.string().trim().min(1).max(64).optional(),
    inviteCode: z.string().trim().max(64).optional(),
    password: z.string().min(10).max(128),
  });

const LoginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

async function requireAdmin(c) {
  const auth = await authenticate(c);
  if (auth.error) return auth;
  if (auth.user.authProvider === "chandler") {
    const accessToken = await getChandlerAccessToken(auth.session);
    const profile = await chandlerRequest("/v1/me", { accessToken });
    const role = profile.is_admin ? "admin" : "user";
    if (role !== auth.user.role) {
      await (await getCollection("users")).updateOne(
        { _id: new ObjectId(auth.user.id) },
        { $set: { role, updatedAt: new Date() } },
      );
      auth.user.role = role;
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

function safeDate(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function objectSize(head) {
  return Number(head?.headers?.["content-length"] || head?.ContentLength || head?.contentLength || 0);
}

function brainProgress(item) {
  if (Number.isFinite(item?.progress)) return Math.max(0, Math.min(100, Number(item.progress)));
  return ({ uploading: 20, queued_for_analysis: 40, analyzing: 72, completed: 100, failed: 100 })[item?.status] || 0;
}

function workerAuthorized(c) {
  const configured = process.env.RELEASE_WORKER_KEY?.trim();
  const provided = c.req.header("x-release-worker-key")?.trim();
  return Boolean(configured && provided && hashOpaqueToken(configured, "release-worker") === hashOpaqueToken(provided, "release-worker"));
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
  summary: "搜索 Chandler 平台用户",
  description: "仅接受已登录的 Chandler 管理员会话。查询结果直接来自 Chandler 公共 OpenAPI。",
  request: { query: z.object({ q: z.string().max(160).optional(), status: z.enum(["active", "disabled", "deleted"]).optional(), page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
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
  summary: "读取 Chandler 用户订阅",
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
  summary: "发布新的不可变订阅价格版本",
  description: "金额由官网目标月价/年价自动推导，Chandler 会把旧价格版本标记为 superseded。",
  request: { body: { content: { "application/json": { schema: z.object({ skuId: z.string().min(1).max(100), effectiveAt: z.string().datetime() }) } } } },
  responses: {
    201: { description: "新价格版本", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "SKU 或生效时间无效", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "未登录", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "非管理员", content: { "application/json": { schema: ErrorSchema } } },
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
  const user = await upsertChandlerUser(auth.user, { username: input.username });
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
  const chandlerAuth = await loginWithChandler(input.identifier, input.password);
  const user = await upsertChandlerUser(chandlerAuth.user, {
    username: input.identifier.includes("@") ? undefined : input.identifier,
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
      createdAt: user.createdAt,
    },
  });
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
  const chandlerSubscriptionsPromise = auth.kind === "session" && auth.user.authProvider === "chandler"
    ? getChandlerAccessToken(auth.session).then((accessToken) => chandlerRequest("/v1/me/subscriptions", { accessToken, timeoutMs: 5_000 })).catch(() => null)
    : Promise.resolve(null);
  const [user, subscription, wallet, uploads, feedback, payments, offlineOrders, minimax, chandlerSubscriptions] = await Promise.all([
    (await getCollection("users")).findOne({ _id: ownerId }),
    (await getCollection("subscriptions")).findOne({ ownerId }),
    (await getCollection("wallets")).findOne({ ownerId }),
    (await getCollection("uploads")).find({ ownerId, kind: "brain" }).sort({ createdAt: -1 }).limit(50).toArray(),
    (await getCollection("feedback")).find({ ownerId }).sort({ createdAt: -1 }).limit(20).toArray(),
    (await getCollection("payments")).find({ ownerId }).sort({ createdAt: -1 }).limit(20).toArray(),
    (await getCollection("offlinePayments")).find({ ownerId }).sort({ createdAt: -1 }).limit(20).toArray(),
    (await getCollection("userConfigurations")).findOne({ ownerId, provider: "minimax" }),
    chandlerSubscriptionsPromise,
  ]);
  const remoteSubscription = (chandlerSubscriptions?.subscriptions || []).find((item) => item.status === "active") || null;
  const effectiveSubscription = subscription?.status === "active" ? subscription : remoteSubscription ? {
    plan: remoteSubscription.sku_name || remoteSubscription.product_name || "member",
    cycle: remoteSubscription.billing_interval || remoteSubscription.cycle || null,
    provider: remoteSubscription.channel || "chandler",
    status: remoteSubscription.status,
    currentPeriodStart: remoteSubscription.current_period_start || null,
    currentPeriodEnd: remoteSubscription.current_period_end || null,
    autoRenew: remoteSubscription.cancel_at_period_end !== true,
    cancelAtPeriodEnd: Boolean(remoteSubscription.cancel_at_period_end),
  } : null;
  return c.json({
    profile: {
      id: auth.user.id,
      username: user?.username || null,
      email: user?.email || null,
      displayName: user?.displayName || null,
      avatar: user?.avatar || null,
      bio: user?.bio || "",
      role: user?.role || auth.user.role,
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
      ...offlineOrders.map((item) => ({ id: item._id.toString(), orderNo: item.orderNo, kind: "subscription", cycle: item.cycle, provider: "offline", amountFen: item.amountFen, status: item.status, createdAt: item.createdAt })),
    ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).slice(0, 30),
    minimax: minimax ? {
      configured: true,
      maskedKey: `••••••••${minimax.keyLast4 || ""}`,
      apiHost: minimax.apiHost,
      model: minimax.model,
      updatedAt: minimax.updatedAt,
    } : { configured: false, maskedKey: null, apiHost: "https://api.minimax.chat/v1", model: "MiniMax-M2.1" },
  });
});

app.put("/api/account/profile", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const displayName = String(body.displayName || "").trim();
  const username = String(body.username || "").trim();
  const bio = String(body.bio || "").trim();
  if (displayName.length < 1 || displayName.length > 64 || bio.length > 240 || (username && (username.length < 3 || username.length > 32 || !/^[\p{L}\p{N}_-]+$/u.test(username)))) {
    return c.json({ code: "VALIDATION_ERROR", message: "昵称、用户名或个人简介格式不正确" }, 400);
  }
  const update = { displayName, displayNameUserManaged: true, bio, updatedAt: new Date() };
  if (username) {
    update.username = username;
    update.usernameNormalized = normalizeUsername(username);
  }
  const user = await (await getCollection("users")).findOneAndUpdate(
    { _id: new ObjectId(auth.user.id) },
    { $set: update },
    { returnDocument: "after" },
  );
  return c.json({ user: { id: user._id.toString(), username: user.username || null, email: user.email || null, displayName: user.displayName || null, avatar: user.avatar || null, bio: user.bio || "", role: user.role || "user" } });
});

app.put("/api/account/integrations/minimax", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await authenticate(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const ownerId = new ObjectId(auth.user.id);
  const configurations = await getCollection("userConfigurations");
  const existing = await configurations.findOne({ ownerId, provider: "minimax" });
  const apiKey = String(body.apiKey || "").trim();
  const apiHost = String(body.apiHost || existing?.apiHost || "https://api.minimax.chat/v1").trim().replace(/\/$/, "");
  const model = String(body.model || existing?.model || "MiniMax-M2.1").trim();
  let parsedHost;
  try { parsedHost = new URL(apiHost); } catch { parsedHost = null; }
  if ((!existing?.apiKeyEncrypted && apiKey.length < 8) || apiKey.length > 500 || !parsedHost || parsedHost.protocol !== "https:" || model.length < 2 || model.length > 100) {
    return c.json({ code: "VALIDATION_ERROR", message: "MiniMax API Key、HTTPS 接口地址或模型名称不正确" }, 400);
  }
  const now = new Date();
  const values = {
    apiHost: parsedHost.toString().replace(/\/$/, ""),
    model,
    updatedAt: now,
    ...(apiKey ? { apiKeyEncrypted: sealUserSecret(apiKey, "minimax-api-key"), keyLast4: apiKey.slice(-4) } : {}),
  };
  await configurations.updateOne(
    { ownerId, provider: "minimax" },
    { $set: values, $setOnInsert: { ownerId, provider: "minimax", createdAt: now } },
    { upsert: true },
  );
  return c.json({ configured: true, maskedKey: `••••••••${apiKey ? apiKey.slice(-4) : existing.keyLast4 || ""}`, apiHost: values.apiHost, model, updatedAt: now });
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
  await Promise.all([
    (await getCollection("sessions")).deleteMany({ userId: ownerId }),
    ...["apiKeys", "tasks", "memories", "feedback", "payments", "subscriptions", "wallets", "uploads", "offlinePayments", "userConfigurations"]
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
  const allowedScopes = new Set(["tasks:read", "tasks:write", "brain:read", "brain:write", "brain:attachments:read", "workflows:read", "configuration:read"]);
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
  const query = c.req.valid("query");
  const params = new URLSearchParams({
    page: String(query.page || 1),
    limit: String(query.limit || 30),
  });
  if (query.q) params.set("q", query.q.trim());
  if (query.status) params.set("status", query.status);
  const accessToken = await getChandlerAccessToken(auth.session);
  return c.json(await chandlerRequest(`/v1/admin/users?${params}`, { accessToken }));
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
  const accessToken = await getChandlerAccessToken(auth.session);
  const subscriptions = await chandlerRequest(`/v1/admin/users/${encodeURIComponent(c.req.valid("param").id)}/subscriptions`, { accessToken });
  return c.json(subscriptions);
});

app.openapi(adminChandlerCatalogRoute, async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const plans = await listCatalogPlans();
  const config = chandlerConfig();
  return c.json({ plans, targetPrices: { month: config.monthlyPriceFen, year: config.yearlyPriceFen } });
});

app.openapi(adminPublishChandlerPriceRoute, async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const input = c.req.valid("json");
  const plans = await listCatalogPlans();
  const plan = plans.find((item) => item.skuId === input.skuId);
  if (!plan) return c.json({ code: "SKU_NOT_FOUND", message: "所选订阅套餐已下架，请刷新后重试" }, 404);
  const yearly = `${plan.skuType} ${plan.billingInterval}`.toLowerCase().includes("year");
  const config = chandlerConfig();
  const accessToken = await getChandlerAccessToken(auth.session);
  const price = await chandlerRequest("/v1/admin/prices", {
    method: "POST",
    accessToken,
    body: {
      sku_id: plan.skuId,
      currency: plan.currency || "CNY",
      amount: yearly ? config.yearlyPriceFen : config.monthlyPriceFen,
      billing_interval: yearly ? "year" : "month",
      interval_count: 1,
      effective_at: input.effectiveAt,
      expires_at: null,
    },
  });
  return c.json(price, 201);
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
      logoUrl: partner.logoMode === "url" ? partner.logoUrl : `/api/partners/${partner._id}/logo.svg`,
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

app.get("/api/admin/partners", async (c) => {
  const auth = await requireAdmin(c);
  if (auth.error) return auth.error;
  const partners = await (await getCollection("partners")).find({}).sort({ sort: 1, createdAt: -1 }).toArray();
  return c.json({
    partners: partners.map((partner) => ({
      ...partner,
      id: partner._id.toString(),
      _id: undefined,
      logoPreviewUrl: partner.logoMode === "url" ? partner.logoUrl : `/api/partners/${partner._id}/logo.svg`,
    })),
  });
});

app.post("/api/admin/partners", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const websiteUrl = parseHttpUrl(body.websiteUrl);
  const logoMode = body.logoMode === "url" ? "url" : "generated";
  const logoUrl = logoMode === "url" ? parseHttpUrl(body.logoUrl) : null;
  if (name.length < 2 || name.length > 80 || !websiteUrl || (logoMode === "url" && !logoUrl)) {
    return c.json({ code: "VALIDATION_ERROR", message: "合作伙伴名称、官网域名或 Logo 链接不正确" }, 400);
  }
  const now = new Date();
  const result = await (await getCollection("partners")).insertOne({
    name, websiteUrl, logoMode, logoUrl,
    enabled: body.enabled !== false,
    sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : 100,
    createdBy: new ObjectId(auth.user.id),
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id: result.insertedId.toString(), logoUrl: logoMode === "url" ? logoUrl : `/api/partners/${result.insertedId}/logo.svg` }, 201);
});

app.put("/api/admin/partners/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const websiteUrl = parseHttpUrl(body.websiteUrl);
  const logoMode = body.logoMode === "url" ? "url" : "generated";
  const logoUrl = logoMode === "url" ? parseHttpUrl(body.logoUrl) : null;
  if (name.length < 2 || name.length > 80 || !websiteUrl || (logoMode === "url" && !logoUrl)) {
    return c.json({ code: "VALIDATION_ERROR", message: "合作伙伴名称、官网域名或 Logo 链接不正确" }, 400);
  }
  const result = await (await getCollection("partners")).updateOne(
    { _id: new ObjectId(c.req.param("id")) },
    { $set: { name, websiteUrl, logoMode, logoUrl, enabled: body.enabled !== false, sort: Number(body.sort || 100), updatedAt: new Date() } },
  );
  if (!result.matchedCount) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/admin/partners/:id", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "NOT_FOUND", message: "合作伙伴不存在" }, 404);
  await (await getCollection("partners")).deleteOne({ _id: new ObjectId(c.req.param("id")) });
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
  const latest = channel?.latestRelease;
  return c.json({
    release: latest?.objectKey ? {
      channelId: channel._id.toString(),
      channelName: channel.name,
      version: latest.version,
      filename: latest.filename,
      bytes: latest.bytes,
      sha256: latest.sha256,
      signatureStatus: latest.signatureStatus,
      publishedAt: latest.publishedAt,
    } : null,
  });
});

app.get("/api/releases/:channelId/download", async (c) => {
  const auth = await authenticate(c, { required: false });
  const id = c.req.param("channelId");
  if (!ObjectId.isValid(id)) return c.json({ code: "RELEASE_NOT_FOUND", message: "发行渠道不存在" }, 404);
  const channel = await (await getCollection("releaseChannels")).findOne({ _id: new ObjectId(id), enabled: true });
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
  const channel = await (await getCollection("releaseChannels")).findOne({ _id: new ObjectId(body.channelId), enabled: true });
  if (!channel) return c.json({ code: "CHANNEL_NOT_FOUND", message: "发行渠道不存在或已停用" }, 404);
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
      assignmentMap.set(chandlerUserId, {
        chandlerUserId,
        displayName: String(assignment.displayName || "").trim().slice(0, 160),
        groupId,
        channelId: channel._id,
        updatedAt: now,
      });
    }
  }
  const normalizedAssignments = [...assignmentMap.values()];
  const releaseAssignments = await getCollection("releaseAssignments");
  await releaseAssignments.deleteMany({});
  if (normalizedAssignments.length) await releaseAssignments.insertMany(normalizedAssignments, { ordered: false });
  const users = await getCollection("users");
  await users.updateMany(
    { releaseChannelGroupId: { $exists: true } },
    { $unset: { releaseChannelId: "", releaseChannelGroupId: "" }, $set: { updatedAt: now } },
  );
  if (normalizedAssignments.length) {
    await users.bulkWrite(normalizedAssignments.map((assignment) => ({
      updateOne: {
        filter: { chandlerUserId: assignment.chandlerUserId },
        update: { $set: { releaseChannelId: assignment.channelId, releaseChannelGroupId: assignment.groupId, updatedAt: now } },
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
  const channel = await (await getCollection("releaseChannels")).findOne({ _id: job.channelId });
  const filename = sanitizeFilename(body.filename, "Gulong-Agent-Setup.exe");
  const bytes = Number(body.bytes);
  if (!filename.toLowerCase().endsWith(".exe") || !Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 5 * 1024 * 1024 * 1024) {
    return c.json({ code: "VALIDATION_ERROR", message: "安装包文件名或大小无效" }, 400);
  }
  if (channel?.latestRelease?.objectKey) await deleteObject(channel.latestRelease.objectKey);
  await (await getCollection("releaseChannels")).updateOne({ _id: job.channelId }, { $unset: { latestRelease: "" }, $set: { updatedAt: new Date() } });
  const objectKey = `releases/${channel.groupId}/${Date.now()}-${randomBytes(8).toString("hex")}-${filename}`;
  await (await getCollection("releaseJobs")).updateOne(
    { _id: job._id },
    { $set: { status: "uploading", objectKey, filename, version: String(body.version || "").slice(0, 40), bytes, sha256: String(body.sha256 || "").toUpperCase(), signatureStatus: String(body.signatureStatus || "unknown").slice(0, 40), updatedAt: new Date() } },
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
  await Promise.all([
    (await getCollection("releaseChannels")).updateOne({ _id: job.channelId }, { $set: { latestRelease, updatedAt: now } }),
    (await getCollection("releaseJobs")).updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: now, updatedAt: now } }),
  ]);
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
  if (!isDatabaseConfigured()) return c.json({ links: defaults, release: null });
  const [custom, channel] = await Promise.all([
    (await getCollection("downloadLinks")).find({ enabled: true }).sort({ sort: 1 }).toArray(),
    (await getCollection("releaseChannels")).findOne({ isDefault: true, enabled: true }),
  ]);
  return c.json({
    links: custom.length
      ? custom.map(({ _id, provider, label, url, code }) => ({ id: provider || _id.toString(), label, url, code }))
      : defaults,
    release: channel?.latestRelease?.objectKey ? {
      channelId: channel._id.toString(),
      channelName: channel.name,
      version: channel.latestRelease.version,
      filename: channel.latestRelease.filename,
      bytes: channel.latestRelease.bytes,
      sha256: channel.latestRelease.sha256,
      signatureStatus: channel.latestRelease.signatureStatus,
      publishedAt: channel.latestRelease.publishedAt,
    } : null,
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
    uploadUrl: createPresignedPutUrl(key),
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

app.get("/api/billing/plans", (c) =>
  c.json({
    plans: [
      { id: "free", name: "普通用户", monthlyFen: 0, yearlyFen: 0, autoRenew: false },
      { id: "member", name: "会员用户", monthlyFen: chandlerConfig().monthlyPriceFen, yearlyFen: chandlerConfig().yearlyPriceFen, autoRenew: true },
      { id: "custom", name: "深度定制", pricing: "结果式付费 · 利润五五分", autoRenew: false },
    ],
    providers: { mode: "chandler", alipay: true, wechat: true, offline: true, autoRenew: { alipay: true, wechat: true } },
  }),
);

app.post("/api/billing/orders", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json();
  const provider = ["wechat", "alipay", "offline"].includes(body.provider) ? body.provider : null;
  const cycle = body.cycle === "year" ? "year" : body.cycle === "month" ? "month" : null;
  const kind = body.kind === "recharge" ? "recharge" : "subscription";
  let amountFen = kind === "recharge" ? Number(body.amountFen) : cycle === "year" ? chandlerConfig().yearlyPriceFen : chandlerConfig().monthlyPriceFen;
  if (!provider || !Number.isInteger(amountFen) || amountFen < 100 || amountFen > 5_000_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "支付方式、周期或金额不正确" }, 400);
  }
  if (!cycle && kind === "subscription") return c.json({ code: "VALIDATION_ERROR", message: "订阅周期不正确" }, 400);
  if (provider === "offline" && kind !== "subscription") return c.json({ code: "VALIDATION_ERROR", message: "线下支付仅用于会员订阅审核" }, 400);
  const accessToken = await getChandlerAccessToken(auth.session);
  const orderNo = `GL${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
  const autoRenew = kind === "subscription" && Boolean(body.autoRenew);
  const now = new Date();

  if (provider === "offline") {
    const plans = await listCatalogPlans();
    const marker = cycle === "year" ? "year" : "month";
    const plan = plans.find((item) => `${item.skuType} ${item.billingInterval}`.toLowerCase().includes(marker));
    if (!plan) return c.json({ code: "PLAN_NOT_CONFIGURED", message: "Chandler 当前没有对应订阅套餐" }, 503);
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
    };
    let chandlerOrderNo = null;
    try {
      const mirrored = await createDirectPaymentOrder(accessToken, {
        merchantOrderNo: orderNo,
        channel: "wechat",
        amountFen,
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
      ownerId: new ObjectId(auth.user.id),
      chandlerUserId: partnerData.chandler_user_id,
      userEmail: auth.user.email,
      cycle,
      amountFen,
      plan,
      partnerData,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ id: result.insertedId.toString(), orderNo, status: "pending_review", mode: "offline", amountFen }, 201);
  }

  let result;
  if (kind === "subscription") {
    result = await createSubscriptionCheckout(accessToken, { cycle, channel: provider });
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
  const actualOrderNo = result.orderNo || orderNo;
  const prepay = result.prepay || result.payment || {};
  const paymentUrl = prepay.pay_url || prepay.h5_url || prepay.code_url;
  const qrCodeDataUrl = prepay.code_url ? await QRCode.toDataURL(prepay.code_url, { width: 280, margin: 1, color: { dark: "#0b3f3a", light: "#fffdfa" } }) : null;
  await (await getCollection("payments")).insertOne({
    orderNo: actualOrderNo,
    merchantOrderNo: orderNo,
    ownerId: new ObjectId(auth.user.id),
    provider,
    kind,
    cycle,
    amountFen,
    autoRenew,
    chandler: true,
    status: "pending",
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
    autoRenewRequested: autoRenew,
    autoRenewAvailable: true,
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
    const start = new Date();
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
  return c.json({
    subscription: subscription ? { ...subscription, id: subscription._id.toString(), _id: undefined, ownerId: undefined } : null,
    balanceFen: wallet?.balanceFen || 0,
  });
});

app.post("/api/billing/subscription/cancel", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const result = await (await getCollection("subscriptions")).updateOne(
    { ownerId: new ObjectId(auth.user.id), status: "active" },
    { $set: { autoRenew: false, cancelAtPeriodEnd: true, updatedAt: new Date() } },
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
  return c.json({ orders: orders.map((order) => ({ id: order._id.toString(), orderNo: order.orderNo, cycle: order.cycle, amountFen: order.amountFen, status: order.status, createdAt: order.createdAt, validUntil: order.validUntil })) });
});

app.get("/api/admin/offline-payments", async (c) => {
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  const status = ["pending", "approved", "rejected"].includes(c.req.query("status")) ? c.req.query("status") : undefined;
  const orders = await (await getCollection("offlinePayments"))
    .find(status ? { status } : {})
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return c.json({ orders: orders.map((order) => ({ ...order, id: order._id.toString(), ownerId: order.ownerId.toString(), _id: undefined })) });
});

app.post("/api/admin/offline-payments/:id/approve", async (c) => {
  const rejected = requireTrustedMutation(c); if (rejected) return rejected;
  const auth = await requireAdmin(c); if (auth.error) return auth.error;
  if (!ObjectId.isValid(c.req.param("id"))) return c.json({ code: "ORDER_NOT_FOUND", message: "线下支付申请不存在" }, 404);
  const orders = await getCollection("offlinePayments");
  const order = await orders.findOne({ _id: new ObjectId(c.req.param("id")), status: "pending" });
  if (!order) return c.json({ code: "ORDER_NOT_FOUND", message: "申请不存在或已经审核" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const start = safeDate(body.validFrom) || new Date();
  const end = safeDate(body.validUntil, true) || new Date(start);
  if (!body.validUntil) {
    if (order.cycle === "year") end.setFullYear(end.getFullYear() + 1);
    else end.setMonth(end.getMonth() + 1);
  }
  if (end <= start) return c.json({ code: "VALIDATION_ERROR", message: "订阅截止日期必须晚于生效日期" }, 400);
  const now = new Date();
  const partnerData = {
    ...order.partnerData,
    review_status: "approved",
    business_payment_status: "paid_offline",
    reviewed_by: readExternalAuth(auth.session)?.chandlerUserId,
    reviewed_at: now.toISOString(),
    valid_from: start.toISOString(),
    valid_until: end.toISOString(),
  };
  await Promise.all([
    orders.updateOne({ _id: order._id, status: "pending" }, { $set: { status: "approved", partnerData, validFrom: start, validUntil: end, reviewedBy: new ObjectId(auth.user.id), reviewedAt: now, updatedAt: now } }),
    (await getCollection("subscriptions")).updateOne(
      { ownerId: order.ownerId },
      { $set: { plan: "member", cycle: order.cycle, provider: "offline", status: "active", currentPeriodStart: start, currentPeriodEnd: end, autoRenew: false, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    ),
  ]);
  const accessToken = await getChandlerAccessToken(auth.session);
  if (order.chandlerOrderNo) {
    try {
      await chandlerRequest(`/v1/me/orders/${encodeURIComponent(order.chandlerOrderNo)}/partner-data?client_id=${encodeURIComponent(chandlerConfig().applicationId)}`, { method: "PUT", accessToken, body: { partner_data: partnerData } });
    } catch { /* Approval remains durable in MongoDB; sync can be retried. */ }
  }
  if (order.chandlerUserId) {
    try {
      const current = await chandlerRequest(`/v1/me/oauth/clients/${encodeURIComponent(chandlerConfig().applicationId)}/users/${encodeURIComponent(order.chandlerUserId)}/attributes`, { accessToken });
      const attributes = current.attributes && typeof current.attributes === "object" ? current.attributes : {};
      await chandlerRequest(`/v1/me/oauth/clients/${encodeURIComponent(chandlerConfig().applicationId)}/users/${encodeURIComponent(order.chandlerUserId)}/attributes`, {
        method: "PUT",
        accessToken,
        body: { attributes: { ...attributes, subscription_status: "active", subscription_source: "offline_review", subscription_order_no: order.orderNo, subscription_valid_from: start.toISOString(), subscription_valid_until: end.toISOString() } },
      });
    } catch { /* The website remains authoritative for this approval until Chandler sync succeeds. */ }
  }
  return c.json({ ok: true, orderNo: order.orderNo, status: "approved", validFrom: start, validUntil: end });
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

app.openapi(getMiniMaxConfigurationRoute, async (c) => {
  const auth = await authenticate(c, { scopes: ["configuration:read"] });
  if (auth.error) return auth.error;
  if (auth.kind !== "apiKey") return c.json({ code: "API_KEY_REQUIRED", message: "请使用具有 configuration:read 权限的 API Key" }, 403);
  const configuration = await (await getCollection("userConfigurations")).findOne({ ownerId: new ObjectId(auth.user.id), provider: "minimax" });
  const apiKey = readUserSecret(configuration?.apiKeyEncrypted, "minimax-api-key");
  if (!configuration || !apiKey) return c.json({ code: "CONFIGURATION_NOT_FOUND", message: "当前用户尚未配置 MiniMax API Key" }, 404);
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  return c.json({ provider: "minimax", apiKey, apiHost: configuration.apiHost, model: configuration.model, updatedAt: configuration.updatedAt });
});

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Gulong API Key",
  description: "Authorization: Bearer gla_live_...",
});

app.doc("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "古龙 Gulong Agent Engine API",
    version: "1.2.0",
    description: "面向开发者的任务执行、长期记忆、用户模型配置、第二大脑附件、发行版本、Chandler 统一账号与计费接口。API Key 仅在创建时显示一次；COS 下载链接默认 15 分钟失效。",
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
