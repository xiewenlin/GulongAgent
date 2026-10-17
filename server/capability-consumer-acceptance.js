import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { normalizeSpecialNodeModels } from "./worklucky-capabilities.js";

const COLLECTION = "capabilityConsumerAcceptances";
const AUDITS = "capabilityConsumerAcceptanceAudits";
const MAX_AGE_MS = 30 * 86400_000;
const BODY_LIMIT = 64 * 1024;
const acceptanceIdPattern = /^gca_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashSchema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const modelIdSchema = z.string().regex(/^[A-Za-z0-9_./:@+-]{1,240}$/);
const bindingIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/);
const capabilitySchema = z.enum(["gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music"]);
const testsSchema = z.object({
  exact_request: z.boolean().optional(), complete_response: z.boolean().optional(), exact_model_dimension: z.boolean().optional(),
  music_generation: z.boolean().optional(), whole_audio_asr: z.boolean().optional(), exact_lyrics: z.boolean().optional(),
  exact_duration: z.boolean().optional(), tools: z.boolean().optional(), multimodal: z.boolean().optional(),
}).strict();
const common = {
  binding_id: bindingIdSchema, capability_version: z.literal("1.0.0"), artifact_sha256: hashSchema,
  test_evidence_sha256: hashSchema, contract_tests: testsSchema, tested_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  admin_confirmed_real_consumer: z.literal(true),
};
const requestSchema = z.discriminatedUnion("capability_id", [
  z.object({ ...common, capability_id: z.literal("gulong_engine.agent_chat"),
    models: z.array(z.object({ id: modelIdSchema, tools: z.boolean(), multimodal: z.boolean() }).strict()).min(1).max(64),
    default_model: modelIdSchema,
  }).strict(),
  z.object({ ...common, capability_id: z.literal("gulong_engine.embedding"),
    models: z.array(z.object({ id: modelIdSchema, dimension: z.number().int().min(1).max(65536) }).strict()).min(1).max(64),
    default_model: modelIdSchema.nullable().optional(),
  }).strict(),
  z.object({ ...common, capability_id: z.literal("gulong_engine.music"),
    models: z.array(z.object({ id: modelIdSchema }).strict()).min(1).max(64),
    default_model: modelIdSchema.nullable().optional(), asr_languages: z.array(z.enum(["zh", "en"])).min(1).max(2),
  }).strict(),
]);

function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonical(item))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))])));
  return JSON.stringify(value);
}

function matrix(models) {
  return [...models].sort((left, right) => left.id.localeCompare(right.id) || (left.dimension || 0) - (right.dimension || 0));
}

function acceptanceView(record) {
  return {
    id: record._id, binding_id: record.bindingId, capability_id: record.capabilityId, capability_version: record.capabilityVersion,
    artifact_sha256: record.artifactSha256, models: record.models, default_model: record.defaultModel,
    contract_tests: record.contractTests, asr_languages: record.asrLanguages, test_evidence_sha256: record.testEvidenceSha256,
    tested_at: record.testedAt, expires_at: record.expiresAt, status: record.status, created_at: record.createdAt,
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

async function boundedJson(c) {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return { oversized: true };
  const reader = c.req.raw.body?.getReader();
  if (!reader) return { value: null };
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY_LIMIT) { await reader.cancel(); return { oversized: true }; }
      chunks.push(value);
    }
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch { return { value: null }; }
}

/** Administrator-only attestation registry. This never manufactures a live consumer or a test result. */
export function registerCapabilityConsumerAcceptanceRoutes(app, dependencies) {
  const { getCollection, requireAdmin, requireTrustedMutation, openapi = true } = dependencies;
  if (typeof getCollection !== "function" || typeof requireAdmin !== "function" || typeof requireTrustedMutation !== "function") {
    throw new TypeError("Consumer acceptance registration requires database, administrator and trusted-mutation guards");
  }
  const now = dependencies.now || (() => new Date());
  const path = "/api/admin/capability-consumers/acceptances";
  app.use(path, async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });

  app.get(path, async (c) => {
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const parsed = z.object({
      binding_id: bindingIdSchema.optional(), capability_id: capabilitySchema.optional(),
      status: z.enum(["active", "pending_audit", "revoked", "expired"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict().safeParse(c.req.query());
    if (!parsed.success) return c.json({ code: "VALIDATION_ERROR", message: "验收列表筛选条件不正确" }, 400);
    const input = parsed.data;
    const filter = { ...(input.binding_id ? { bindingId: input.binding_id.toLowerCase() } : {}),
      ...(input.capability_id ? { capabilityId: input.capability_id } : {}), ...(input.status ? { status: input.status } : {}) };
    const records = await (await getCollection(COLLECTION)).find(filter).sort({ createdAt: -1, _id: -1 }).limit(input.limit).toArray();
    return c.json({ acceptances: records.map(acceptanceView) });
  });

  app.post(path, async (c) => {
    const rejected = await requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const payload = await boundedJson(c);
    if (payload.oversized) return c.json({ code: "REQUEST_TOO_LARGE", message: "消费者验收记录不能超过 64 KB" }, 413);
    const parsed = requestSchema.safeParse(payload.value);
    if (!parsed.success) return c.json({ code: "VALIDATION_ERROR", message: "请提供完整消费者验收信息、模型矩阵、证据摘要，并明确确认已完成真实消费者验收" }, 400);
    const input = parsed.data;
    const instant = new Date(now());
    const testedAt = new Date(input.tested_at);
    const expiresAt = new Date(input.expires_at);
    if (testedAt > instant || testedAt <= new Date(instant.getTime() - MAX_AGE_MS) || expiresAt <= instant
      || expiresAt <= testedAt || expiresAt.getTime() - testedAt.getTime() > MAX_AGE_MS) {
      return c.json({ code: "CONSUMER_ACCEPTANCE_TIME_INVALID", message: "验收时间必须真实有效，且验收有效期自测试日起不得超过 30 天" }, 400);
    }
    let features;
    try {
      features = normalizeSpecialNodeModels(input.capability_id, { ...input, validation: { contract_tests: input.contract_tests } });
    } catch (error) { return c.json({ code: error.code || "VALIDATION_ERROR", message: error.message }, error.status || 400); }
    const binding = await (await getCollection("nodeAccountBindings")).findOne({
      _id: new ObjectId(input.binding_id), status: "active", revokedAt: null,
    });
    if (!binding) return c.json({ code: "CONSUMER_BINDING_UNAVAILABLE", message: "节点绑定不存在或已停用，不能登记消费者验收" }, 409);
    const record = {
      _id: `gca_${randomUUID()}`, bindingId: String(binding._id), nodeId: binding.nodeId, userId: binding.userId,
      capabilityId: input.capability_id, capabilityVersion: input.capability_version, artifactSha256: input.artifact_sha256.toUpperCase(),
      models: matrix(features.models), defaultModel: features.defaultModel, contractTests: features.contractTests, asrLanguages: features.asrLanguages,
      testEvidenceSha256: input.test_evidence_sha256.toUpperCase(), testedAt, expiresAt,
      status: "pending_audit", createdAt: instant, createdByUserId: String(auth.user.id ?? auth.user._id),
      adminConfirmedRealConsumer: true,
    };
    const acceptances = await getCollection(COLLECTION);
    try {
      await acceptances.insertOne(record);
      await (await getCollection(AUDITS)).insertOne({
        _id: randomUUID(), action: "capability_consumer.acceptance_created", acceptanceId: record._id, actorUserId: record.createdByUserId,
        bindingId: record.bindingId, capabilityId: record.capabilityId, capabilityVersion: record.capabilityVersion,
        artifactSha256: record.artifactSha256, testEvidenceSha256: record.testEvidenceSha256, createdAt: instant,
      });
      const updated = await acceptances.findOneAndUpdate({ _id: record._id, status: "pending_audit" }, {
        $set: { status: "active", activatedAt: instant },
      }, { returnDocument: "after" });
      const active = updated && (Object.hasOwn(updated, "value") ? updated.value : updated);
      if (!active || active.status !== "active") throw new Error("Acceptance activation was not persisted");
      return c.json({ acceptance: acceptanceView(active) }, 201);
    } catch {
      return c.json({ code: "CONSUMER_ACCEPTANCE_NOT_ACTIVATED", message: "验收登记未能确认完成，请查询验收列表核对结果后再重试；未经成功审计的记录不会开放派单" }, 503);
    }
  });

  if (openapi !== false && app.openAPIRegistry) {
    app.openAPIRegistry.registerPath({ method: "get", path, tags: ["Consumer Acceptance"], summary: "管理员查询可信消费者验收记录", security: [{ sessionCookie: [] }],
      responses: { 200: { description: "仅管理员可见；不缓存；最多返回 100 条验收记录" }, 401: { description: "未登录" }, 403: { description: "不是管理员" } } });
    app.openAPIRegistry.registerPath({ method: "post", path, tags: ["Consumer Acceptance"], summary: "管理员显式登记真实消费者验收", security: [{ sessionCookie: [] }],
      description: "仅验收注册，不执行推理或生成证据。必须明确确认真实消费者已验收，审计成功后激活；模型、维度、功能矩阵、制品与绑定完全匹配且自测试日起最多有效 30 天。",
      request: { body: { content: { "application/json": { schema: requestSchema } } } },
      responses: { 201: { description: "已审计并激活" }, 400: { description: "信息或有效期不正确" }, 401: { description: "未登录" }, 403: { description: "不是管理员或来源不受信任" }, 409: { description: "节点绑定不可用" }, 413: { description: "超过大小限制" }, 503: { description: "未激活，禁止用于派单" } } });
  }
}
