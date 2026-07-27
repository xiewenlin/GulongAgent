import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { handleUpload } from "@vercel/blob/client";
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
  role: z.enum(["user", "developer", "admin"]),
  createdAt: z.coerce.date(),
});

const RegisterSchema = z
  .object({
    username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u).optional(),
    email: z.email().optional(),
    password: z.string().min(10).max(128),
  })
  .refine((value) => Boolean(value.username || value.email), {
    message: "用户名或邮箱至少填写一项",
  });

const LoginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

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
    status: database.configured && !database.ok ? "degraded" : "ok",
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

  await ensureIndexes();
  const input = c.req.valid("json");
  const usernameNormalized = normalizeUsername(input.username);
  const emailNormalized = normalizeEmail(input.email);
  const users = await getCollection("users");
  const duplicateConditions = [];
  if (usernameNormalized) duplicateConditions.push({ usernameNormalized });
  if (emailNormalized) duplicateConditions.push({ emailNormalized });
  if (duplicateConditions.length && (await users.findOne({ $or: duplicateConditions }))) {
    return c.json({ code: "ACCOUNT_EXISTS", message: "用户名或邮箱已被注册" }, 409);
  }

  const now = new Date();
  const user = {
    username: input.username?.trim() || null,
    email: input.email?.trim() || null,
    passwordHash: await hashPassword(input.password),
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  if (usernameNormalized) user.usernameNormalized = usernameNormalized;
  if (emailNormalized) user.emailNormalized = emailNormalized;
  const result = await users.insertOne(user);
  await issueSession(c, result.insertedId);
  return c.json(
    {
      user: {
        id: result.insertedId.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: now,
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
  const normalized = input.identifier.includes("@")
    ? { emailNormalized: normalizeEmail(input.identifier) }
    : { usernameNormalized: normalizeUsername(input.identifier) };
  const user = await (await getCollection("users")).findOne({ ...normalized, status: "active" });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    return c.json({ code: "INVALID_CREDENTIALS", message: "用户名、邮箱或密码不正确" }, 401);
  }
  await issueSession(c, user._id);
  return c.json({
    user: {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
  });
});

app.get("/api/auth/me", async (c) => {
  const auth = await authenticate(c, { required: false });
  return c.json({ user: auth?.user || null, databaseConfigured: isDatabaseConfigured() });
});

app.post("/api/auth/logout", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  await revokeSession(c);
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
  const allowedScopes = new Set(["tasks:read", "tasks:write", "brain:read", "brain:write", "workflows:read"]);
  if (name.length < 2 || name.length > 40 || scopes.some((scope) => !allowedScopes.has(scope))) {
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
  if (!isDatabaseConfigured()) return c.json({ links: defaults });
  const custom = await (await getCollection("downloadLinks"))
    .find({ enabled: true })
    .sort({ sort: 1 })
    .toArray();
  return c.json({
    links: custom.length
      ? custom.map(({ _id, provider, label, url, code }) => ({ id: provider || _id.toString(), label, url, code }))
      : defaults,
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
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return c.json({ code: "CONFIG_REQUIRED", message: "文件存储尚未配置 BLOB_READ_WRITE_TOKEN" }, 503);
  }
  const result = await handleUpload({
    body: await c.req.json(),
    request: c.req.raw,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const payload = JSON.parse(clientPayload || "{}");
      const kind = payload.kind === "brain" ? "brain" : "feedback";
      const isZip = /\.zip$/i.test(pathname);
      if (kind === "brain" && !isZip) throw new Error("第二大脑仅支持 ZIP 文件");
      return {
        allowedContentTypes: kind === "brain"
          ? ["application/zip", "application/x-zip-compressed", "application/octet-stream"]
          : ["image/png", "image/jpeg", "image/webp", "image/gif"],
        maximumSizeInBytes: kind === "brain" ? 500 * 1024 * 1024 : 15 * 1024 * 1024,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ ownerId: auth.user.id, kind }),
      };
    },
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      const payload = JSON.parse(tokenPayload || "{}");
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
      { id: "member", name: "会员用户", monthlyFen: 19_800, yearlyFen: 99_900, autoRenew: true },
      { id: "custom", name: "深度定制", pricing: "结果式付费 · 利润五五分", autoRenew: false },
    ],
    providers: paymentCapabilities(),
  }),
);

app.post("/api/billing/orders", async (c) => {
  if (!isTrustedBrowserRequest(c)) return c.json({ code: "ORIGIN_REJECTED", message: "请求来源不受信任" }, 403);
  const auth = await authenticate(c);
  if (auth.error) return auth.error;
  const body = await c.req.json();
  const provider = body.provider === "wechat" ? "wechat" : body.provider === "alipay" ? "alipay" : null;
  const cycle = body.cycle === "year" ? "year" : body.cycle === "month" ? "month" : null;
  const kind = body.kind === "recharge" ? "recharge" : "subscription";
  let amountFen = kind === "recharge" ? Number(body.amountFen) : cycle === "year" ? 99_900 : 19_800;
  if (!provider || !Number.isInteger(amountFen) || amountFen < 100 || amountFen > 5_000_000) {
    return c.json({ code: "VALIDATION_ERROR", message: "支付方式、周期或金额不正确" }, 400);
  }
  const orderNo = `GL${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
  const autoRenew = kind === "subscription" && Boolean(body.autoRenew);
  const capabilities = paymentCapabilities();
  const mockToken = capabilities.mode === "mock" ? randomBytes(18).toString("base64url") : null;
  const now = new Date();
  await (await getCollection("payments")).insertOne({
    orderNo,
    ownerId: new ObjectId(auth.user.id),
    provider,
    kind,
    cycle,
    amountFen,
    autoRenew,
    mockTokenHash: mockToken ? hashOpaqueToken(mockToken, "mock-payment") : null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  if (capabilities.mode === "mock") {
    return c.json({ orderNo, status: "pending", paymentUrl: createMockPaymentUrl(orderNo, provider, mockToken), mode: "mock" }, 201);
  }
  if (!capabilities[provider]) {
    return c.json({ code: "PAYMENT_NOT_CONFIGURED", message: `${provider === "wechat" ? "微信" : "支付宝"}商户参数尚未配置` }, 503);
  }
  const subject = kind === "recharge" ? "古龙账户充值" : `古龙会员${cycle === "year" ? "年度" : "月度"}订阅`;
  const paymentUrl = provider === "alipay"
    ? buildAlipayPagePayUrl({ orderNo, amountFen, subject })
    : await createWechatNativeOrder({ orderNo, amountFen, subject });
  return c.json({ orderNo, status: "pending", paymentUrl, mode: "live", autoRenewAvailable: capabilities.autoRenew[provider] }, 201);
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
    version: "1.0.0",
    description: "面向开发者的任务执行、长期记忆、工作流、账户与计费接口。API Key 仅在创建时显示一次。",
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
