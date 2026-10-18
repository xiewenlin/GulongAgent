import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { normalizeSpecialNodeModels } from "./worklucky-capabilities.js";

const COLLECTION = "capabilityConsumerAcceptances";
const MAX_AGE_MS = 30 * 86400_000;
const acceptanceIdPattern = /^gca_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashSchema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const bindingIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/);
const capabilitySchema = z.enum(["gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music"]);

function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonical(item))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))])));
  return JSON.stringify(value);
}

function matrix(models) {
  return [...models].sort((left, right) => left.id.localeCompare(right.id) || (left.dimension || 0) - (right.dimension || 0));
}

function acceptanceView(record, now = new Date()) {
  const expiresAt = new Date(record.expiresAt);
  const effectiveStatus = record.status === "active" && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) ? "expired" : record.status;
  return {
    id: record._id, binding_id: record.bindingId, capability_id: record.capabilityId, capability_version: record.capabilityVersion,
    artifact_sha256: record.artifactSha256, models: record.models, default_model: record.defaultModel,
    contract_tests: record.contractTests, asr_languages: record.asrLanguages, test_evidence_sha256: record.testEvidenceSha256,
    tested_at: record.testedAt, expires_at: record.expiresAt, status: record.status, effective_status: effectiveStatus, created_at: record.createdAt,
  };
}

/** Self-reported validated=true never grants admission; every identity and feature must match this registry. */
export async function findTrustedConsumerAcceptance({ getCollection, bindingId, report, now = new Date() }) {
  const acceptanceId = report?.validation?.acceptanceId ?? report?.validation?.acceptance_id;
  if (typeof acceptanceId !== "string" || !acceptanceIdPattern.test(acceptanceId) || !ObjectId.isValid(bindingId)) return null;
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) return null;
  const capabilityId = report.capabilityId ?? report.capability_id;
  const capabilityVersion = report.capabilityVersion ?? report.capability_version ?? report.specialContractVersion;
  const artifactSha256 = report.validation?.artifactSha256 ?? report.validation?.artifact_sha256;
  if (!capabilitySchema.safeParse(capabilityId).success || !hashSchema.safeParse(artifactSha256).success) return null;
  let features;
  try { features = normalizeSpecialNodeModels(capabilityId, report); } catch { return null; }
  const record = await (await getCollection(COLLECTION)).findOne({
    _id: acceptanceId, bindingId: String(bindingId), capabilityId, capabilityVersion, status: "active",
  });
  if (!record || record.adminConfirmedRealConsumer !== true || !Array.isArray(record.models)
    || !record.contractTests || typeof record.contractTests !== "object" || Array.isArray(record.contractTests) || !Array.isArray(record.asrLanguages)
    || typeof record.artifactSha256 !== "string" || record.artifactSha256.toUpperCase() !== artifactSha256.toUpperCase()
    || !Number.isFinite(new Date(record.testedAt).getTime()) || !Number.isFinite(new Date(record.expiresAt).getTime())
    || new Date(record.testedAt) > instant || new Date(record.expiresAt) <= instant
    || new Date(record.expiresAt) - new Date(record.testedAt) > MAX_AGE_MS
    || new Date(record.expiresAt) <= new Date(record.testedAt)
    || !hashSchema.safeParse(record.testEvidenceSha256).success
    || canonical(matrix(record.models || [])) !== canonical(matrix(features.models))
    || canonical(record.contractTests) !== canonical(features.contractTests)
    || record.defaultModel !== features.defaultModel
    || canonical(record.asrLanguages) !== canonical(features.asrLanguages)) return null;
  return record;
}

// Vercel dynamic files/rewrites can carry route captures alongside the real
// search parameters. They are transport metadata, not database filters. Accept
// only captures that exactly describe the route already selected by Hono;
// arbitrary/duplicate business filters still fail the strict query schemas.
function consumerListQuery(request) {
  const query = { ...request.query() };
  const entries = request.queries();
  const route = request.path.replace(/^\/api\//, "");
  const leaf = route.split("/").at(-1);
  let invalid = false;
  for (const [key, values] of Object.entries(entries)) {
    if (["_platform_path", "path", "route"].includes(key)) {
      const exact = values.length === 1 && (values[0] === route || (key === "path" && values[0] === leaf));
      const segments = key === "route" && values.length <= 4 && values.join("/") === route;
      if (!exact && !segments) invalid = true;
      delete query[key];
    } else if (values.length !== 1) invalid = true;
  }
  return { query, invalid };
}

/** Administrator-only attestation registry. This never manufactures a live consumer or a test result. */
export function registerCapabilityConsumerAcceptanceRoutes(app, dependencies) {
  const { getCollection, requireAdmin, requireTrustedMutation, openapi = true } = dependencies;
  if (typeof getCollection !== "function" || typeof requireAdmin !== "function" || typeof requireTrustedMutation !== "function") {
    throw new TypeError("Consumer acceptance registration requires database, administrator and trusted-mutation guards");
  }
  const now = dependencies.now || (() => new Date());
  const path = "/api/admin/capability-consumers/acceptances";
  const bindingsPath = "/api/admin/capability-consumers/bindings";
  app.use(path, async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  app.use(bindingsPath, async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });

  const bindingQuerySchema = z.object({
    node_id: z.string().trim().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f]+$/).optional(),
    q: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  }).strict();
  app.get(bindingsPath, async (c) => {
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const search = consumerListQuery(c.req);
    const parsed = bindingQuerySchema.safeParse(search.query);
    if (search.invalid || !parsed.success) return c.json({ code: "VALIDATION_ERROR", message: "节点绑定筛选条件不正确：节点 ID 最多 256 字、关键词最多 100 字，每次最多查询 50 条" }, 400);
    const input = parsed.data;
    const keyword = input.q?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = { status: "active", revokedAt: null,
      ...(input.node_id ? { nodeId: input.node_id } : {}),
      ...(keyword ? { $or: ["nodeName", "deviceName", "nodeId"].map((field) => ({ [field]: { $regex: keyword, $options: "i" } })) } : {}),
    };
    const bindings = await (await getCollection("nodeAccountBindings")).find(filter, {
      projection: { _id: 1, nodeId: 1, nodeName: 1, deviceName: 1, userId: 1, computeGroupId: 1, updatedAt: 1 },
    }).sort({ updatedAt: -1, _id: -1 }).limit(input.limit).toArray();
    return c.json({ bindings: bindings.map((binding) => ({
      binding_id: String(binding._id), node_id: binding.nodeId, node_name: binding.nodeName || binding.deviceName || null,
      user_id: binding.userId == null ? null : String(binding.userId), compute_group_id: binding.computeGroupId == null ? null : String(binding.computeGroupId),
    })) });
  });

  app.get(path, async (c) => {
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const search = consumerListQuery(c.req);
    const parsed = z.object({
      binding_id: bindingIdSchema.optional(), capability_id: capabilitySchema.optional(),
      status: z.enum(["active", "pending_audit", "revoked", "expired"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict().safeParse(search.query);
    if (search.invalid || !parsed.success) return c.json({ code: "VALIDATION_ERROR", message: "验收列表筛选条件不正确" }, 400);
    const input = parsed.data;
    const filter = { ...(input.binding_id ? { bindingId: input.binding_id.toLowerCase() } : {}),
      ...(input.capability_id ? { capabilityId: input.capability_id } : {}), ...(input.status ? { status: input.status } : {}) };
    const records = await (await getCollection(COLLECTION)).find(filter).sort({ createdAt: -1, _id: -1 }).limit(input.limit).toArray();
    const instant = new Date(now());
    return c.json({ acceptances: records.map((record) => acceptanceView(record, instant)) });
  });

  app.post(path, async (c) => {
    const rejected = await requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    return c.json({ code: "MANUAL_ACCEPTANCE_RETIRED", message: "手工新增验收已停用，节点上报模型后将自动验收。已有有效记录保持兼容。" }, 410);
  });

  if (openapi !== false && app.openAPIRegistry) {
    app.openAPIRegistry.registerPath({ method: "get", path: bindingsPath, tags: ["Consumer Acceptance"], summary: "管理员搜索可登记验收的有效节点绑定", security: [{ sessionCookie: [] }],
      description: "仅管理员可查询 active 且未撤销的绑定。node_id 精确匹配，q 按节点名、设备名或节点 ID 进行字面量模糊搜索；最多 50 条，按 updatedAt 倒序。仅返回绑定 ID、节点 ID/名称、用户 ID 和分组 ID，绝不返回邮箱、令牌摘要或凭据。不缓存。",
      request: { query: bindingQuerySchema },
      responses: { 200: { description: "可用于验收登记的有效绑定列表", content: { "application/json": { schema: z.object({ bindings: z.array(z.object({
        binding_id: z.string(), node_id: z.string(), node_name: z.string().nullable(), user_id: z.string().nullable(), compute_group_id: z.string().nullable(),
      })) }) } } }, 400: { description: "筛选条件、长度、数量或重复参数不正确" }, 401: { description: "未登录" }, 403: { description: "不是管理员" } } });
    app.openAPIRegistry.registerPath({ method: "get", path, tags: ["Consumer Acceptance"], summary: "管理员查询可信消费者验收记录", security: [{ sessionCookie: [] }],
      responses: { 200: { description: "仅管理员可见；不缓存；最多返回 100 条验收记录。保留原始 status，额外返回按当前有效期推导的 effective_status；原 active 到期或有效期无效时显示 expired。该字段不代表节点在线。" }, 401: { description: "未登录" }, 403: { description: "不是管理员" } } });
    app.openAPIRegistry.registerPath({ method: "post", path, tags: ["Consumer Acceptance"], summary: "已停用：手工新增消费者验收", deprecated: true, security: [{ sessionCookie: [] }],
      description: "由节点自动验收接口替代；已有可信验收在原有效期内兼容。此接口不再创建或激活任何记录。",
      responses: { 410: { description: "MANUAL_ACCEPTANCE_RETIRED，使用自动验收接口" }, 401: { description: "未登录" }, 403: { description: "不是管理员或来源不受信任" } } });
  }
}
