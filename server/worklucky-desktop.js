import { z } from "@hono/zod-openapi";
import { WORKLUCKY_ROOT, WORKLUCKY_CAPABILITY_IDS, workLuckyConfig, workLuckyEntitlement } from "./worklucky-product.js";
import { createWorkLuckyReleaseService, workLuckyPublishedManifestSchema } from "./worklucky-releases.js";
import { createPresignedDownloadUrl } from "./cos.js";

// These declarations are part of the live /api/openapi.json registry, not just
// an offline companion document. They describe the existing shared session;
// they neither mint a new credential scope nor widen the H3 auth boundary.
function registerOpenAPI(app) {
  if (!app.openAPIRegistry) return;
  const registry = app.openAPIRegistry;
  registry.registerComponent("securitySchemes", "workLuckyDesktopBearer", {
    type: "http", scheme: "bearer", bearerFormat: "gge_at_ opaque access token",
    description: "与古龙引擎桌面端共用的会话族，不是独立权限域；不可用于付费媒体或绕过 H3 鉴权。",
  });
  const error = z.object({ code: z.string(), message: z.string() });
  const json = (schema) => ({ content: { "application/json": { schema } } });
  const body = (schema) => ({ body: { required: true, ...json(schema) } });
  const response = (description, schema) => ({ description, ...json(schema) });
  const token = z.object({ access_token: z.string(), refresh_token: z.string(), token_type: z.literal("Bearer"), expires_in: z.number().int() });
  const security = [{ workLuckyDesktopBearer: [] }];
  const description = "WorkLucky 是现有 Gulong Engine 的 shared session 路由别名；沿用 gge 令牌、刷新轮换、撤销、限流和服务端会员校验。client_product 仅为产品归因和幂等隔离，不能授权其他能力。静态 capability_ids 不代表在线；仅鉴权目录中的 dispatchable、真实模型和空闲槽位有效。无付费回退，视频仍 adapter_required。";
  const productQuery = z.object({ product: z.literal("worklucky").optional() });
  const register = (method, suffix, summary, properties) => registry.registerPath({
    method, path: `${WORKLUCKY_ROOT}/${suffix}`, tags: ["WorkLucky Desktop"], summary,
    description, ...properties,
    responses: { ...properties.responses, 400: response("请求无效或产品不匹配", error), 429: response("请求过于频繁", error) },
  });
  register("get", "config", "读取 WorkLucky 产品配置与真实能力目录入口", {
    security: [], request: { query: productQuery },
    responses: { 200: response("不缓存的配置；能力列表不等于可用消费者", z.object({
      schema_version: z.literal("worklucky-product-v1"), product_id: z.literal("worklucky"),
      product: z.literal("worklucky"), name: z.literal("WorkLucky"), protocol_version: z.literal("worklucky-desktop-v1"),
      subscription: z.object({ plan_id: z.literal("gulong_engine_monthly"), monthly_price_fen: z.number().int().positive(), included_in_plan: z.literal(true), separate_purchase: z.literal(false) }),
      auth: z.object({ login: z.string(), refresh: z.string(), logout: z.string(), account: z.string() }),
      capability_orders: z.object({ catalog: z.string(), create: z.string(), product: z.literal("worklucky"), capability_ids: z.array(z.enum(WORKLUCKY_CAPABILITY_IDS)), pricing: z.literal("zero_price_shared_only"), video: z.literal("adapter_required"), availability_source: z.literal("authenticated_catalog"), execution_requires: z.literal("verified_consumer_contract"), paid_fallback: z.literal(false) }),
      updates: z.object({ endpoint: z.string(), signature_algorithm: z.literal("worklucky-ed25519-sha256-v1") }), updates_url: z.string(),
    })) },
  });
  register("get", "updates", "读取 WorkLucky 已核验桌面版本状态", {
    security: [], request: { query: productQuery },
    responses: { 200: response("仅返回已审定且通过固定公钥验签的最终清单；未发布时为 no_update", z.union([
      z.object({ product_id: z.literal("worklucky"), product: z.literal("worklucky"), status: z.literal("no_update"), release: z.null(), reason: z.literal("release_not_published") }),
      workLuckyPublishedManifestSchema,
    ])) },
  });
  register("get", "releases/{version}/{filename}", "下载固定版本的已审定 WorkLucky 绿色包", {
    security: [], request: { params: z.object({ version: z.string(), filename: z.string() }) },
    responses: { 302: { description: "短时 HTTPS COS 下载重定向；版本地址不指向 latest" },
      404: response("未审定/未发布的候选不可下载", error), 503: response("发布清单配置校验失败", error) },
  });
  register("post", "auth/login", "使用官网账号登录 WorkLucky", {
    security: [], request: body(z.object({ identifier: z.string().min(1).max(320), password: z.string().min(1).max(1024) })),
    responses: { 200: response("共享 GGE 会话令牌，不返回 Chandler 凭据", token), 401: response("账号或密码无效", error), 503: response("账号服务暂不可用", error) },
  });
  register("post", "auth/refresh", "原子轮换同一 GGE 会话族", {
    security: [], request: body(z.object({ refresh_token: z.string() })),
    responses: { 200: response("旧令牌失效；可与原 GGE 路由交叉刷新", token), 401: response("会话过期、撤销或刷新重放", error) },
  });
  register("post", "auth/logout", "撤销当前共享桌面会话", {
    security, request: body(z.object({ refresh_token: z.string() })),
    responses: { 200: response("该会话在 WorkLucky 与 GGE 路由同时撤销", z.object({ ok: z.literal(true) })), 401: response("会话无效", error) },
  });
  register("get", "account", "读取当前账号与 WorkLucky 包含权益", {
    security,
    responses: { 200: response("仅当前令牌账户；权益不代表节点在线", z.object({
      user: z.object({ id: z.string(), display_name: z.string(), email: z.string() }),
      entitlement: z.object({ product: z.literal("worklucky"), plan_id: z.literal("gulong_engine_monthly"), active: z.boolean(), status: z.string(), starts_at: z.coerce.date().nullable(), expires_at: z.coerce.date().nullable(), capabilities: z.array(z.string()), monthly_price_fen: z.number().int().nullable() }),
      checked_at: z.iso.datetime(),
    })), 401: response("未登录、过期或其他账户令牌无效", error) },
  });
}

// Dependency injection preserves the existing password verification, rate
// limits, refresh rotation, session revocation and authoritative entitlement.
export function registerWorkLuckyDesktopRoutes(app, { createAuth, readEntitlement, monthlyPriceFen,
  releaseService = createWorkLuckyReleaseService({ downloadUrl: createPresignedDownloadUrl }) }) {
  // A fixed product alias must not silently accept another product selector.
  app.use(`${WORKLUCKY_ROOT}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store, max-age=0");
    const products = c.req.queries("product");
    if (products && (products.length !== 1 || products[0] !== "worklucky")) {
      return c.json({ code: "WORKLUCKY_PRODUCT_INVALID", message: "产品参数不正确，请使用 WorkLucky 入口" }, 400);
    }
    await next();
  });
  const auth = createAuth({ root: WORKLUCKY_ROOT, loginAccountSummary: false, readEntitlement: async (...args) => workLuckyEntitlement(await readEntitlement(...args)) });
  auth.register(app);
  const publicReply = (c, value) => {
    c.header("Cache-Control", "no-store, max-age=0");
    c.header("Pragma", "no-cache");
    return c.json(value);
  };
  app.get(`${WORKLUCKY_ROOT}/config`, (c) => publicReply(c, workLuckyConfig(monthlyPriceFen)));
  app.get(`${WORKLUCKY_ROOT}/updates`, (c) => publicReply(c, releaseService.updates()));
  app.get(`${WORKLUCKY_ROOT}/releases/:version/:filename`, (c) => {
    const url = releaseService.download(c.req.param("version"), c.req.param("filename"));
    return url ? c.redirect(url, 302) : c.json({ code: "RELEASE_NOT_FOUND", message: "该 WorkLucky 版本尚未发布" }, 404);
  });
  registerOpenAPI(app);
}
