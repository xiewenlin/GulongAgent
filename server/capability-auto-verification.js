import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { validateSpecialInlineResult } from "./worklucky-capabilities.js";
import { CAPABILITY_VERIFICATION_POLICY, requiresAutomaticCapabilityVerification } from "./capability-verification-policy.js";
import { normalizeProbeInputs, validateProbeInputTickets } from "./capability-probe-inputs.js";
import { PROBE_OUTPUT_TYPES, normalizeProbeOutputRules, validateProbeOutputDescriptor } from "./capability-probe-outputs.js";
import { NATIVE_PROBE_VERSIONS } from "./capability-native-verification.js";

export const AUTO_VERIFICATION_PROTOCOL = "gulong-auto-verification-v1";
export const AUTO_VERIFICATION_COLLECTION = "capabilityAutoVerifications";
export const AUTO_VERIFICATION_CAPABILITY_VERSIONS = Object.freeze({
  ...NATIVE_PROBE_VERSIONS,
  "gulong_engine.agent_chat": Object.freeze(["1.0.0"]),
  "gulong_engine.embedding": Object.freeze(["1.0.0"]),
  "gulong_engine.music": Object.freeze(["1.0.0"]),
  "gulong_engine.text": Object.freeze(["1", "1.0.0"]),
  "gulong_engine.image": Object.freeze(["1", "1.0.0"]),
  "gulong_engine.image_2k": Object.freeze(["1.0.0"]),
  "gulong_engine.tts": Object.freeze(["1.0.0"]),
  "qwen_image_2_1.text_to_image": Object.freeze(["2.1"]),
});
const LEASES = "capabilityVerificationLeases";
const BUDGETS = "capabilityVerificationBudgets";
const AUDITS = "capabilityVerificationAudits";
const CHALLENGES = "capabilityVerificationChallenges";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/i;
const MODEL = /^[A-Za-z0-9_./:@+-]{1,240}$/;
const CAPABILITY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const CONTRACT_VERSION = /^\d{1,3}(?:\.\d{1,3}){0,2}$/;
const LEGACY_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,119}$/;
const DAY = 86400_000;
const VALID_FOR = 7 * DAY;
const LEASE_MS = 15 * 60_000;
const RESULT_LIMIT = 4 * 1024 * 1024;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => JSON.stringify(value, (_, item) => isObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const group = (value) => value == null || value === "" ? null : String(value);
const unwrap = (value) => value && Object.hasOwn(value, "value") ? value.value : value;
function failure(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function assert(condition, code, message, status) { if (!condition) throw failure(code, message, status); }
function publicError(error, fallback = "自动验收暂时不可用，请稍后重试") {
  return { code: typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : "VERIFICATION_UNAVAILABLE",
    message: typeof error?.message === "string" && /[\u3400-\u9fff]/.test(error.message) ? error.message.slice(0, 500) : fallback };
}
function secretMatches(secret, digest) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 256 || !HASH.test(digest || "")) return false;
  return timingSafeEqual(Buffer.from(sha(secret), "hex"), Buffer.from(digest, "hex"));
}

/** Inventory is untrusted input: validated/contract_tests never confer trust. */
export function normalizeAutoVerificationInventory(report, { allowLegacyVersion = false } = {}) {
  assert(isObject(report), "VERIFICATION_REPORT_INVALID", "共享能力清单格式不正确", 400);
  const capabilityId = report.capability_id ?? report.capabilityId;
  const capabilityVersion = report.capability_version ?? report.capabilityVersion ?? report.specialContractVersion ?? "1.0.0";
  const artifactSha256 = report.validation?.artifact_sha256 ?? report.validation?.artifactSha256 ?? report.artifact_sha256 ?? report.artifactSha256;
  assert(typeof capabilityId === "string" && CAPABILITY.test(capabilityId) && capabilityId.length <= 120
    && typeof capabilityVersion === "string" && (allowLegacyVersion || Object.hasOwn(NATIVE_PROBE_VERSIONS, capabilityId) ? LEGACY_VERSION : CONTRACT_VERSION).test(capabilityVersion)
    && HASH.test(artifactSha256 || ""), "VERIFICATION_REPORT_INVALID", "能力清单必须包含能力名称、合同版本和真实制品摘要", 400);
  const rawModels = report.models ?? report.supported_models ?? report.supportedModels;
  assert(Array.isArray(rawModels) && rawModels.length > 0 && rawModels.length <= 64,
    "VERIFICATION_MODELS_REQUIRED", "请上报 1 至 64 个已安装模型的精确参数", 400);
  const models = rawModels.map((value) => {
    const item = typeof value === "string" ? { id: value } : value;
    assert(isObject(item) && MODEL.test(item.id || ""), "VERIFICATION_MODEL_INVALID", "模型标识格式不正确", 400);
    const model = { id: item.id };
    if (capabilityId === "gulong_engine.agent_chat") {
      assert(typeof item.tools === "boolean" && typeof item.multimodal === "boolean", "VERIFICATION_FEATURES_REQUIRED", "对话模型须明确上报工具和多模态能力", 400);
      model.tools = item.tools; model.multimodal = item.multimodal;
    }
    if (capabilityId === "gulong_engine.embedding") {
      assert(Number.isSafeInteger(item.dimension) && item.dimension > 0 && item.dimension <= 65536,
        "VERIFICATION_DIMENSION_REQUIRED", "向量模型须上报实际维度", 400);
      model.dimension = item.dimension;
    }
    if (capabilityId === "gulong_engine.music" || /^(minimax_music_3|yue_2)\.generate$/.test(capabilityId)) {
      assert(Number.isFinite(item.max_duration_seconds) && item.max_duration_seconds >= 1 && item.max_duration_seconds <= 600,
        "VERIFICATION_DURATION_REQUIRED", "音乐模型须上报实际时长上限", 400);
      model.max_duration_seconds = item.max_duration_seconds;
    }
    // Adapter-owned features remain in the fingerprint; dropping an unrecognised
    // feature would let a changed model matrix inherit a previous approval.
    for (const [key, value] of Object.entries(item)) {
      if (Object.hasOwn(model, key) || key === "id") continue;
      assert(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)
        && (typeof value === "string" && value.length <= 240 || typeof value === "boolean"
          || typeof value === "number" && Number.isFinite(value)), "VERIFICATION_FEATURE_INVALID", "模型特征必须为有界的简单值", 400);
      model[key] = value;
    }
    return model;
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  assert(new Set(models.map(canonical)).size === models.length, "VERIFICATION_DUPLICATE_MODEL", "不能重复上报相同模型和参数", 400);
  const defaultModel = report.default_model ?? report.defaultModel ?? models[0].id;
  assert(models.some((model) => model.id === defaultModel), "VERIFICATION_DEFAULT_MODEL_INVALID", "默认模型必须在当前已安装模型中", 400);
  const rawLanguages = report.asr_languages ?? report.asrLanguages ?? [];
  assert(Array.isArray(rawLanguages) && rawLanguages.length <= 2 && rawLanguages.every((language) => ["zh", "en"].includes(language)),
    "VERIFICATION_LANGUAGE_INVALID", "整段语音验证语言仅支持中文和英文", 400);
  const asrLanguages = [...new Set(rawLanguages)].sort();
  const enabled = report.installed === true && report.enabled === true && (report.sharing_opt_in === true || report.sharingOptIn === true);
  const matrixSha256 = sha({ capabilityId, capabilityVersion, artifactSha256: artifactSha256.toLowerCase(), models, defaultModel, asrLanguages });
  return { capabilityId, capabilityVersion, artifactSha256: artifactSha256.toLowerCase(), models, defaultModel, asrLanguages, enabled, matrixSha256 };
}

function baseProbe(inventory, model, nonce) {
  if (!(AUTO_VERIFICATION_CAPABILITY_VERSIONS[inventory.capabilityId] || []).includes(inventory.capabilityVersion)) return null;
  const budget = { max_inferences: 1, max_output_tokens: 32, max_audio_seconds: 12 };
  if (inventory.capabilityId === "gulong_engine.agent_chat") {
    // Multimodal/tool contracts require their own server adapter. A text-only
    // success must never approve tools=true or multimodal=true.
    if (model.tools || model.multimodal) return null;
    return { probeKind: "chat", budget, parameters: { model: model.id, request: { model: model.id,
      messages: [{ role: "user", content: `Reply with exactly this verification text and nothing else: ${nonce}` }],
      max_tokens: 32, temperature: 0, stream: false, chat_template_kwargs: { enable_thinking: false } } } };
  }
  if (inventory.capabilityId === "gulong_engine.text") return { probeKind: "text", budget,
    parameters: { model: model.id, prompt: `Reply with exactly this verification text and nothing else: ${nonce}` } };
  if (inventory.capabilityId === "gulong_engine.embedding") return { probeKind: "embedding", budget,
    parameters: { model: model.id, dimension: model.dimension, request: { model: model.id, input: [`A calm blue river ${nonce}`, `A noisy red engine ${nonce}`], encoding_format: "float", dimensions: model.dimension } } };
  if (inventory.capabilityId === "gulong_engine.music") {
    if (!inventory.asrLanguages.length) return null;
    const language = inventory.asrLanguages[0];
    const digits = nonce.match(/\d/g)?.slice(0, 4) || ["1", "2", "3", "4"];
    const words = language === "zh" ? ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] : ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const lyrics = language === "zh" ? `蓝色天空，银色河流。\n${digits.map((digit) => words[Number(digit)]).join("，")}。` : `Blue sky, silver river.\n${digits.map((digit) => words[Number(digit)]).join(", ")}.`;
    return { probeKind: "music", budget, language, parameters: { caption: "A clear solo singing voice, simple gentle accompaniment, sing the complete lyrics exactly once.",
      lyrics, seconds: Math.min(12, model.max_duration_seconds), seed: Number.parseInt(sha(nonce).slice(0, 8), 16), model: model.id } };
  }
  return null;
}

function publicState(record) {
  return { id: record._id, binding_id: record.bindingId, node_id: record.nodeId, capability_id: record.capabilityId,
    capability_version: record.capabilityVersion, artifact_sha256: record.artifactSha256, model: record.model,
    status: record.status, attempts: record.attempts || 0, tested_at: record.testedAt ?? null,
    verified_model: record.status === "active" ? record.verifiedModel ?? null : null,
    contract_tests: record.status === "active" ? record.contractTests ?? null : null,
    asr_languages: record.status === "active" ? record.asrLanguages || [] : [],
    expires_at: record.expiresAt ?? null, next_retry_at: record.nextRetryAt ?? null, next_attempt_at: record.nextRetryAt ?? null,
    error: record.error ?? null, created_at: record.createdAt, updated_at: record.updatedAt };
}

export function createCapabilityAutoVerificationService(dependencies) {
  const { getCollection, verifyMediaOutputs, issueProbeOutputUpload, getProbeOutputStatus, issueProbeInputDownloads, canProbe, acquireExecution, releaseExecution, adapters = {} } = dependencies;
  assert(typeof getCollection === "function", "VERIFICATION_DEPENDENCY_INVALID", "自动验收数据库未配置", 500);
  const now = dependencies.now || (() => new Date());
  const rateLimit = dependencies.enforceRateLimit || (async () => ({ allowed: false }));
  const collection = () => getCollection(AUTO_VERIFICATION_COLLECTION);
  const requestRecordId = (bindingId, requestId) => sha(`verification-request:${bindingId}:${requestId}`);
  async function currentBinding(binding) {
    assert(binding && ObjectId.isValid(binding._id) && typeof binding.nodeId === "string", "INVALID_ACCOUNT_BINDING", "请先绑定有效的官网账号", 401);
    const active = await (await getCollection("nodeAccountBindings")).findOne({ _id: new ObjectId(binding._id), status: "active", revokedAt: null });
    assert(active && active.nodeId === binding.nodeId && String(active.userId) === String(binding.userId)
      && group(active.computeGroupId) === group(binding.computeGroupId)
      && (binding.tokenHash == null || binding.tokenHash === active.tokenHash), "INVALID_ACCOUNT_BINDING", "节点绑定或用户分组已变化，请重新获取绑定状态", 401);
    return active;
  }
  async function limited(bindingId, action, limit) {
    const decision = await rateLimit(`capability-auto-verification:${bindingId}:${action}`, { limit, windowMs: 60_000 });
    assert(decision?.allowed === true, "RATE_LIMITED", "自动验收请求过于频繁，请稍后重试", 429);
  }
  function validateRequestIdentity(requestId, leaseToken) {
    const supplied = requestId !== undefined || leaseToken !== undefined;
    assert(!supplied || typeof requestId === "string" && REQUEST_ID.test(requestId)
      && typeof leaseToken === "string" && CLIENT_SECRET.test(leaseToken)
      && Buffer.from(leaseToken, "base64url").byteLength === 32 && Buffer.from(leaseToken, "base64url").toString("base64url") === leaseToken,
    "VERIFICATION_REQUEST_ID_INVALID", "请求编号与 32 字节安全凭据必须成对提供，且格式必须正确", 400);
    return supplied;
  }
  async function inputTickets(record, active) {
    const inputs = normalizeProbeInputs(record.probeInputs);
    if (!inputs.length) return [];
    assert(typeof issueProbeInputDownloads === "function", "VERIFICATION_FIXTURE_REQUIRED", "该能力的固定输入夹具尚未配置，禁止开始验收", 503);
    const tickets = await issueProbeInputDownloads({ binding: active, challenge: record });
    return validateProbeInputTickets(inputs, tickets, record.leaseExpiresAt, new Date(now()));
  }
  async function recoveryView(record, active, leaseToken) {
    assert(record && record.bindingId === String(active._id) && record.nodeId === active.nodeId
      && secretMatches(leaseToken, record.leaseTokenHash), "VERIFICATION_REQUEST_CONFLICT", "请求编号已存在，但安全凭据或节点不一致", 409);
    assert(group(record.computeGroupId) === group(active.computeGroupId), "COMPUTE_GROUP_MISMATCH", "用户分组已变化，禁止恢复旧验收任务", 403);
    const feature = record.challengeId && ["leased", "verifying"].includes(record.status)
      ? await (await collection()).findOne({ challengeId: record.challengeId, bindingId: record.bindingId }) : null;
    const snapshot = feature || record;
    let state = feature?.status || record.status;
    // A changed matrix can never be resumed through an old idempotency key.
    if (["leased", "verifying", "preparing"].includes(state) && snapshot.leaseExpiresAt && new Date(snapshot.leaseExpiresAt) <= new Date(now())) state = "expired";
    if (record.featureId && !feature && ["leased", "verifying"].includes(state)) state = "invalidated";
    const leaseValid = ["leased", "verifying"].includes(state) && new Date(snapshot.leaseExpiresAt) > new Date(now());
    const challenge = snapshot.parameters ? { id: record.challengeId, expires_at: snapshot.leaseExpiresAt,
      capability_id: snapshot.capabilityId, capability_version: snapshot.capabilityVersion, artifact_sha256: snapshot.artifactSha256,
      model: snapshot.model, parameters: snapshot.parameters, budget: snapshot.budget, compute_group_id: snapshot.computeGroupId,
      node_id: snapshot.nodeId, output_upload_required: snapshot.outputUploadRequired === true,
      ...(snapshot.probeOutputRules?.length ? { output_requirements: snapshot.probeOutputRules } : {}),
      ...(snapshot.probeInputs?.length ? { input_assets: leaseValid ? await inputTickets(snapshot, active) : normalizeProbeInputs(snapshot.probeInputs) } : {}) } : null;
    return { ok: true, protocol: AUTO_VERIFICATION_PROTOCOL, recovered: true, request_id: record.requestId || null,
      state, lease_valid: leaseValid, execute_once: true, execution_policy: "resume_existing_journal_only", challenge,
      ...(snapshot.error ? { error: snapshot.error } : {}) };
  }
  async function byRequest({ binding, requestId, leaseToken }) {
    const active = await currentBinding(binding);
    validateRequestIdentity(requestId, leaseToken);
    await limited(String(active._id), "lookup", 30);
    const record = await (await getCollection(CHALLENGES)).findOne({ _id: requestRecordId(active._id, requestId), bindingId: String(active._id) });
    assert(record, "VERIFICATION_REQUEST_NOT_FOUND", "该请求编号从未创建自动验收任务", 404);
    return recoveryView(record, active, leaseToken);
  }
  async function getChallenge({ binding, challengeId, leaseToken }) {
    const active = await currentBinding(binding);
    assert(/^gcv_[a-f0-9-]{36}$/.test(challengeId || ""), "VERIFICATION_CHALLENGE_INVALID", "自动验收任务编号不正确", 400);
    await limited(String(active._id), "lookup", 30);
    const record = await (await getCollection(CHALLENGES)).findOne({ challengeId, bindingId: String(active._id) });
    assert(record, "VERIFICATION_CHALLENGE_NOT_FOUND", "未找到当前节点的自动验收任务", 404);
    return recoveryView(record, active, leaseToken);
  }
  async function releaseLocks(record) {
    const leases = await getCollection(LEASES);
    const held = await leases.findOne({ challengeId: record._id });
    if (typeof releaseExecution === "function") await releaseExecution({ bindingId: record.bindingId || held?.bindingId, challengeId: record._id, now: new Date(now()) });
    await leases.updateMany({ challengeId: record._id }, { $set: { leaseUntil: new Date(0) }, $unset: { challengeId: "" } });
  }
  function adapterFor(inventory, model) {
    const custom = adapters[inventory.capabilityId];
    const versions = AUTO_VERIFICATION_CAPABILITY_VERSIONS[inventory.capabilityId] || custom?.versions || ["1.0.0"];
    if (!Array.isArray(versions) || !versions.includes(inventory.capabilityVersion)) return null;
    if (custom && typeof custom.createProbe === "function" && typeof custom.validateResult === "function") {
      if (custom.requiresProbeInputs === true && typeof issueProbeInputDownloads !== "function") return null;
      return typeof custom.supports !== "function" || custom.supports(inventory, model) === true ? custom : null;
    }
    const sample = baseProbe(inventory, model, "gcv-12345678");
    if (!sample || sample.probeKind === "music" && (typeof verifyMediaOutputs !== "function" || typeof issueProbeOutputUpload !== "function")) return null;
    return { createProbe: ({ nonce }) => baseProbe(inventory, model, nonce) };
  }
  function verifiedAdapterScope(record, fallbackInventory) {
    const adapter = adapters[record.capabilityId];
    if (typeof adapter?.isVerifiedModel !== "function") return true;
    const inventory = record.inventory || fallbackInventory;
    return Boolean(inventory && adapterFor(inventory, record.model)
      && adapter.isVerifiedModel(inventory, record.verifiedModel, record.contractTests) === true);
  }
  async function report({ binding, reports, migrationPolicy, automaticCapabilityIds }) {
    const active = await currentBinding(binding);
    await limited(String(active._id), "report", 12);
    assert(Array.isArray(reports) && reports.length > 0 && reports.length <= 64, "VERIFICATION_REPORT_INVALID", "每次须上报 1 至 64 项能力", 400);
    assert(migrationPolicy === undefined || migrationPolicy === CAPABILITY_VERIFICATION_POLICY,
      "VERIFICATION_POLICY_INVALID", "自动验收迁移策略不正确", 400);
    assert(automaticCapabilityIds === undefined || migrationPolicy === CAPABILITY_VERIFICATION_POLICY,
      "VERIFICATION_POLICY_INVALID", "逐能力迁移列表必须使用 capability-v2 策略", 400);
    if (migrationPolicy === CAPABILITY_VERIFICATION_POLICY) {
      assert(Array.isArray(automaticCapabilityIds) && automaticCapabilityIds.length <= 64
        && automaticCapabilityIds.every((id) => typeof id === "string" && CAPABILITY.test(id))
        && new Set(automaticCapabilityIds).size === automaticCapabilityIds.length,
      "VERIFICATION_POLICY_INVALID", "请提供不重复的自动迁移能力列表，最多64项", 400);
      assert(active.autoVerificationPolicy === CAPABILITY_VERIFICATION_POLICY || !active.autoVerificationEnrolledAt,
        "VERIFICATION_MIGRATION_REVIEW_REQUIRED", "此绑定已采用旧版整体验收策略，不能自动降级；请先完成迁移审计", 409);
    }
    const inventories = reports.map((input) => {
      const id = input?.capability_id ?? input?.capabilityId;
      // Opaque native versions are inventory fingerprints only. They must never
      // relax an already/newly migrated capability's verifier contract.
      const allowLegacyVersion = migrationPolicy === CAPABILITY_VERIFICATION_POLICY
        && !automaticCapabilityIds.includes(id) && !requiresAutomaticCapabilityVerification(active, id);
      return normalizeAutoVerificationInventory(input, { allowLegacyVersion });
    });
    assert(new Set(inventories.map((item) => item.capabilityId)).size === inventories.length
      && inventories.reduce((count, item) => count + item.models.length, 0) <= 256,
    "VERIFICATION_REPORT_INVALID", "能力不能重复，单节点每次最多上报 256 个模型参数组合", 400);
    const instant = new Date(now());
    const records = await collection();
    const bindings = await getCollection("nodeAccountBindings");
    if (migrationPolicy === CAPABILITY_VERIFICATION_POLICY) {
      for (const id of automaticCapabilityIds) {
        const inventory = inventories.find((item) => item.capabilityId === id);
        assert(inventory && (requiresAutomaticCapabilityVerification(active, id) || inventory.models.every((model) => adapterFor(inventory, model))),
          "VERIFICATION_CAPABILITY_NOT_MIGRATABLE", "待迁移能力须在完整库存中，且每个模型均须有对应自动验收适配器", 409);
      }
      // Never downgrade an already-enrolled v1 binding, including a concurrent
      // v1 report. Existing v2 sets are extended atomically, never replaced.
      const enrolled = await bindings.updateOne({ _id: active._id, status: "active", revokedAt: null,
        $or: [{ autoVerificationPolicy: CAPABILITY_VERIFICATION_POLICY }, { autoVerificationEnrolledAt: null }] },
      { $set: { autoVerificationEnrolledAt: active.autoVerificationEnrolledAt || instant, autoVerificationPolicy: CAPABILITY_VERIFICATION_POLICY },
        $addToSet: { autoVerificationCapabilityIds: { $each: automaticCapabilityIds } } });
      assert(enrolled.matchedCount === 1 || enrolled.modifiedCount === 1,
        "VERIFICATION_MIGRATION_REVIEW_REQUIRED", "此绑定已采用旧版整体验收策略，不能自动降级；请先完成迁移审计", 409);
    } else {
      const enrolled = await bindings.updateOne({ _id: active._id, status: "active", revokedAt: null,
        autoVerificationPolicy: { $ne: CAPABILITY_VERIFICATION_POLICY } }, { $set: { autoVerificationEnrolledAt: instant } });
      assert(enrolled.matchedCount === 1 || enrolled.modifiedCount === 1,
        "VERIFICATION_POLICY_REQUIRED", "此绑定已采用逐能力迁移，请沿用 capability-v2 及完整能力库存", 409);
    }
    const enrolledBinding = await currentBinding(binding);
    // A concurrent report may have migrated a previously-unlisted capability.
    // Recheck before any inventory/evidence writes; never persist a legacy-only
    // version as an automatically eligible contract after that transition.
    inventories.forEach((inventory) => {
      if (requiresAutomaticCapabilityVerification(enrolledBinding, inventory.capabilityId)) {
        assert((Object.hasOwn(NATIVE_PROBE_VERSIONS, inventory.capabilityId) ? LEGACY_VERSION : CONTRACT_VERSION).test(inventory.capabilityVersion),
          "VERIFICATION_REPORT_INVALID", "自动验收能力须使用对应的合同版本或已注册的原生组件版本格式", 400);
      }
    });
    for (const inventory of inventories) {
      const automatic = requiresAutomaticCapabilityVerification(enrolledBinding, inventory.capabilityId);
      await records.updateMany({ bindingId: String(active._id), capabilityId: inventory.capabilityId,
        $or: [{ matrixSha256: { $ne: inventory.matrixSha256 } }, { computeGroupId: { $ne: group(active.computeGroupId) } }] },
      { $set: { status: "invalidated", updatedAt: instant, error: { code: "VERIFICATION_MATRIX_CHANGED", message: "模型、制品或分组已变化，等待重新自动验收" } } });
      for (const model of inventory.models) {
        const _id = sha({ bindingId: String(active._id), group: group(active.computeGroupId), matrix: inventory.matrixSha256, model });
        const adapter = adapterFor(inventory, model);
        await records.updateOne({ _id }, { $setOnInsert: { bindingId: String(active._id), nodeId: active.nodeId, userId: String(active.userId),
          computeGroupId: group(active.computeGroupId), capabilityId: inventory.capabilityId, capabilityVersion: inventory.capabilityVersion,
          artifactSha256: inventory.artifactSha256, matrixSha256: inventory.matrixSha256, model, inventory,
          status: !inventory.enabled ? "disabled" : !automatic ? "migration_deferred" : adapter ? "pending" : "adapter_required", attempts: 0, createdAt: instant,
          ...(!automatic ? { automaticMigrationEnabled: false } : {}) },
        $set: { reportedAt: instant, updatedAt: instant, inventoryEnabled: inventory.enabled,
          ...(automatic ? { automaticMigrationEnabled: true } : {}) } }, { upsert: true });
        if (typeof adapters[inventory.capabilityId]?.isVerifiedModel === "function") {
          const previous = await records.findOne({ _id, status: "active" });
          if (previous && !verifiedAdapterScope(previous, inventory)) {
            await records.updateOne({ _id, status: "active" }, { $set: { status: adapter ? "pending" : "adapter_required", updatedAt: instant,
              error: { code: "VERIFICATION_SCOPE_RECHECK_REQUIRED", message: "历史图像验收未记录完整任务范围，等待按已支持范围重新自动验收" } } });
          }
        }
        if (!inventory.enabled) await records.updateOne({ _id }, { $set: { status: "disabled", updatedAt: instant } });
        else if (automatic && adapter) await records.updateOne({ _id, status: { $in: ["disabled", "adapter_required", "invalidated", "migration_deferred"] } }, { $set: { status: "pending", updatedAt: instant } });
      }
    }
    return { ok: true, protocol: AUTO_VERIFICATION_PROTOCOL, migration: {
      policy: enrolledBinding.autoVerificationPolicy || "binding-v1",
      automatic_capability_ids: enrolledBinding.autoVerificationPolicy === CAPABILITY_VERIFICATION_POLICY
        ? enrolledBinding.autoVerificationCapabilityIds : inventories.map((item) => item.capabilityId),
      capabilities: inventories.map((item) => ({ capability_id: item.capabilityId,
        mode: requiresAutomaticCapabilityVerification(enrolledBinding, item.capabilityId) ? "automatic" : "legacy_compatibility",
        all_models_have_adapter: item.models.every((model) => Boolean(adapterFor(item, model))) })),
    }, verifications: await list({ bindingId: String(active._id), limit: 256 }) };
  }
  async function list({ bindingId, limit = 100 } = {}) {
    assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 256, "VERIFICATION_QUERY_INVALID", "每次最多查询 256 项自动验收状态", 400);
    const rows = await (await collection()).find(bindingId ? { bindingId: String(bindingId) } : {}).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
    const instant = new Date(now());
    return rows.map((record) => publicState(record.status === "active" && (new Date(record.expiresAt) <= instant || !verifiedAdapterScope(record))
      ? { ...record, status: "expired" } : record));
  }
  async function lock(_id, challengeId, instant, bindingId) {
    const leases = await getCollection(LEASES);
    try { await leases.updateOne({ _id }, { $setOnInsert: { leaseUntil: new Date(0) } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    return unwrap(await leases.findOneAndUpdate({ _id, leaseUntil: { $lte: instant } },
      { $set: { challengeId, bindingId, leaseUntil: new Date(+instant + LEASE_MS) } }, { returnDocument: "after" }));
  }
  async function next({ binding, dryRun = false, resources, requestId, leaseToken: clientLeaseToken }) {
    const active = await currentBinding(binding);
    await limited(String(active._id), "next", 20);
    assert(typeof dryRun === "boolean", "VERIFICATION_REQUEST_INVALID", "测试连接参数格式不正确", 400);
    const controlled = validateRequestIdentity(requestId, clientLeaseToken);
    if (dryRun) return { ok: true, protocol: AUTO_VERIFICATION_PROTOCOL, queue: "reachable", challenge: null };
    const instant = new Date(now());
    const challengeId = `gcv_${randomUUID()}`;
    const requestRecords = await getCollection(CHALLENGES);
    const associationId = controlled ? requestRecordId(active._id, requestId) : challengeId;
    // Recovery must precede the busy guard: the existing lease itself makes the
    // node busy, and losing an HTTP response must not create another probe.
    if (controlled) {
      const previous = await requestRecords.findOne({ _id: associationId });
      if (previous) return recoveryView(previous, active, clientLeaseToken);
      const journalBudget = await rateLimit(`capability-auto-verification:${active._id}:new-request:${instant.toISOString().slice(0, 10)}`,
        { limit: 64, windowMs: DAY });
      assert(journalBudget?.allowed === true, "VERIFICATION_REQUEST_BUDGET_EXHAUSTED", "今日新建验收请求已达上限，原请求仍可安全查询", 429);
      try {
        await requestRecords.insertOne({ _id: associationId, challengeId, requestId, leaseTokenHash: sha(clientLeaseToken),
          bindingId: String(active._id), nodeId: active.nodeId, computeGroupId: group(active.computeGroupId), status: "preparing", createdAt: instant, updatedAt: instant });
      } catch (error) {
        if (error.code !== 11000) throw error;
        const winner = await requestRecords.findOne({ _id: associationId });
        assert(winner, "VERIFICATION_REQUEST_UNCERTAIN", "请求状态暂时无法确认，请按原请求编号查询，不要重新创建", 503);
        return recoveryView(winner, active, clientLeaseToken);
      }
    }
    const noChallenge = async (response) => {
      if (controlled) await requestRecords.updateOne({ _id: associationId, status: "preparing" },
        { $set: { status: "not_issued", responseCode: response.code || null, updatedAt: new Date(now()) } });
      return { ...response, ...(controlled ? { request_id: requestId, state: "not_issued", lease_valid: false } : {}) };
    };
    // The server must independently check active H3/capability slots and the
    // authenticated node report. A client's idle boolean alone is insufficient.
    if (typeof canProbe !== "function" || await canProbe({ binding: active, resources, now: instant }) !== true) {
      return noChallenge({ ok: true, challenge: null, code: "VERIFICATION_NODE_BUSY", retry_after_seconds: 30 });
    }
    const records = await collection();
    // Expired leases are retriable but count against the same daily budget.
    await records.updateMany({ bindingId: String(active._id), status: { $in: ["leased", "verifying"] }, leaseExpiresAt: { $lte: instant } },
      { $set: { status: "failed", nextRetryAt: new Date(+instant + 60_000), updatedAt: instant, error: { code: "VERIFICATION_LEASE_EXPIRED", message: "自动验收超时，稍后自动重试" } } });
    const candidates = await records.find({ bindingId: String(active._id), computeGroupId: group(active.computeGroupId), inventoryEnabled: true,
      $or: [{ status: "pending" }, { status: "failed", nextRetryAt: { $lte: instant } }, { status: "active", expiresAt: { $lte: instant } }] }).sort({ createdAt: 1, _id: 1 }).limit(32).toArray();
    const budgetId = `${active._id}:${instant.toISOString().slice(0, 10)}`;
    const priorBudget = await (await getCollection(BUDGETS)).findOne({ _id: budgetId });
    if ((priorBudget?.count || 0) >= 16) return noChallenge({ ok: true, challenge: null, code: "VERIFICATION_DAILY_BUDGET_EXHAUSTED", retry_after_seconds: 3600 });
    const selected = candidates.find((item) => item.automaticMigrationEnabled !== false
      && requiresAutomaticCapabilityVerification(active, item.capabilityId)
      && (priorBudget?.models?.[item._id] || 0) < 3 && adapterFor(item.inventory, item.model));
    if (!selected) return noChallenge({ ok: true, challenge: null, retry_after_seconds: 60 });
    if (!await lock(`binding:${active._id}`, challengeId, instant, String(active._id))) return noChallenge({ ok: true, challenge: null, retry_after_seconds: 15 });
    let globalSlot = null;
    for (let index = 0; index < 4; index += 1) if (await lock(`global:${index}`, challengeId, instant, String(active._id))) { globalSlot = index; break; }
    if (globalSlot == null) { await releaseLocks({ _id: challengeId }); return noChallenge({ ok: true, challenge: null, retry_after_seconds: 30 }); }
    try {
      if (typeof acquireExecution !== "function" || await acquireExecution({ binding: active, challengeId, expiresAt: new Date(+instant + LEASE_MS) }) !== true) {
        await releaseLocks({ _id: challengeId });
        return noChallenge({ ok: true, challenge: null, code: "VERIFICATION_NODE_BUSY", retry_after_seconds: 30 });
      }
      const budgets = await getCollection(BUDGETS);
      try { await budgets.updateOne({ _id: budgetId }, { $setOnInsert: { count: 0, models: {}, expiresAt: new Date(+instant + 2 * DAY) } }, { upsert: true }); }
      catch (error) { if (error.code !== 11000) throw error; }
      const reserved = unwrap(await budgets.findOneAndUpdate({ _id: budgetId, count: { $lt: 16 }, [`models.${selected._id}`]: { $not: { $gte: 3 } } },
        { $inc: { count: 1, [`models.${selected._id}`]: 1 } }, { returnDocument: "after" }));
      if (!reserved) { await releaseLocks({ _id: challengeId }); return noChallenge({ ok: true, challenge: null, code: "VERIFICATION_DAILY_BUDGET_EXHAUSTED", retry_after_seconds: 3600 }); }
      const nonce = `gcv-${randomBytes(5).toString("hex")}`;
      const adapter = adapterFor(selected.inventory, selected.model);
      const probe = await adapter.createProbe({ inventory: selected.inventory, model: selected.model, nonce, binding: active });
      assert(isObject(probe) && isObject(probe.parameters) && probe.budget?.max_inferences === 1,
        "VERIFICATION_ADAPTER_INVALID", "自动验收适配器未提供安全探测预算", 503);
      assert(Buffer.byteLength(canonical(probe.parameters)) <= 64 * 1024 && (probe.budget.max_output_tokens ?? 0) <= 128
        && (probe.budget.max_audio_seconds ?? 0) <= 12 && (probe.budget.max_images ?? 0) <= 1
        && (probe.budget.max_image_pixels ?? 0) <= 2048 * 2048
        && (probe.budget.max_input_assets ?? 0) <= 3 && (probe.budget.max_input_bytes ?? 0) <= 8 * 1024 * 1024
        && (probe.budget.max_video_frames ?? 0) <= 64 && (probe.budget.max_video_seconds ?? 0) <= 12
        && (probe.budget.max_asr_passes ?? 0) <= 1
        && Object.values(probe.budget).every((value) => Number.isSafeInteger(value) && value >= 0),
      "VERIFICATION_BUDGET_INVALID", "自动验收超过单次安全预算", 503);
      const probeInputs = normalizeProbeInputs(probe.inputAssets);
      const probeOutputRules = normalizeProbeOutputRules(probe.outputRules, probe.probeKind);
      assert(!probeInputs.length || probeInputs.length <= probe.budget.max_input_assets
        && probeInputs.reduce((total, item) => total + item.bytes, 0) <= probe.budget.max_input_bytes,
      "VERIFICATION_BUDGET_INVALID", "固定输入夹具超过本次探测的独立安全预算", 503);
      const leaseExpiresAt = new Date(+instant + LEASE_MS);
      // Prepare/sign before committing an executable challenge. Failure must
      // leave no leased record whose physical slot has already been released.
      const signedInputs = probeInputs.length ? await inputTickets({ ...selected, probeInputs, leaseExpiresAt }, active) : [];
      const leaseToken = controlled ? clientLeaseToken : randomBytes(32).toString("base64url");
      const updated = unwrap(await records.findOneAndUpdate({ _id: selected._id, status: selected.status, matrixSha256: selected.matrixSha256 },
        { $set: { challengeId, leaseTokenHash: sha(leaseToken), leaseExpiresAt, status: "leased", probeInputs, probeOutputRules,
          nonce, probeKind: probe.probeKind, parameters: probe.parameters, budget: probe.budget, language: probe.language ?? null,
          requestId: controlled ? requestId : null, outputUploadRequired: probe.outputUploadRequired === true || probe.probeKind === "music", updatedAt: instant },
          $unset: { resultFingerprint: "", error: "" }, $inc: { attempts: 1 } }, { returnDocument: "after" }));
      if (!updated) { await releaseLocks({ _id: challengeId }); return noChallenge({ ok: true, challenge: null, retry_after_seconds: 15 }); }
      const { _id: featureId, requestId: snapshotRequestId, ...snapshot } = updated;
      await requestRecords.updateOne({ _id: associationId }, { $set: { ...snapshot, ...(controlled ? { requestId: snapshotRequestId } : {}), featureId, updatedAt: instant },
        $setOnInsert: { createdAt: instant } }, { upsert: true });
      return { ok: true, protocol: AUTO_VERIFICATION_PROTOCOL, ...(controlled ? { request_id: requestId } : {}), state: "leased", lease_valid: true,
        execute_once: true, challenge: { id: challengeId, lease_token: leaseToken,
        expires_at: updated.leaseExpiresAt, capability_id: updated.capabilityId, capability_version: updated.capabilityVersion,
        artifact_sha256: updated.artifactSha256, model: updated.model, parameters: updated.parameters, budget: updated.budget,
        compute_group_id: updated.computeGroupId, node_id: updated.nodeId, output_upload_required: updated.outputUploadRequired,
        ...(probeOutputRules.length ? { output_requirements: probeOutputRules } : {}),
        ...(signedInputs.length ? { input_assets: signedInputs } : {}) } };
    } catch (error) {
      // A partially persisted issuance is not permission to run. Retain a
      // deterministic failed/preparing journal state rather than returning 404.
      if (controlled) {
        try { await requestRecords.updateOne({ _id: associationId, status: "preparing" },
          { $set: { status: "failed", error: publicError(error, "验收任务创建未完成，请勿执行；请保留原请求编号核对状态"), updatedAt: new Date(now()) } }); }
        catch { /* Preserve preparing when persistence is unavailable: no execution is allowed. */ }
      }
      await releaseLocks({ _id: challengeId }); throw error;
    }
  }
  async function ownedChallenge(binding, challengeId, leaseToken, statuses = ["leased"]) {
    const active = await currentBinding(binding);
    assert(/^gcv_[a-f0-9-]{36}$/.test(challengeId || ""), "VERIFICATION_CHALLENGE_INVALID", "自动验收任务编号不正确", 400);
    const record = await (await collection()).findOne({ challengeId, bindingId: String(active._id), nodeId: active.nodeId });
    assert(record && secretMatches(leaseToken, record.leaseTokenHash), "VERIFICATION_LEASE_INVALID", "自动验收凭据无效或不属于当前节点", 403);
    assert(group(record.computeGroupId) === group(active.computeGroupId), "COMPUTE_GROUP_MISMATCH", "用户分组已变化，禁止使用旧验收任务", 403);
    assert(statuses.includes(record.status) && new Date(record.leaseExpiresAt) > new Date(now()),
      "VERIFICATION_LEASE_EXPIRED", "自动验收任务已结束或超时，请等待新的探测", 409);
    return record;
  }
  async function outputUpload({ binding, challengeId, leaseToken, output }) {
    const challenge = await ownedChallenge(binding, challengeId, leaseToken);
    await limited(challenge.bindingId, "output", 12);
    assert(typeof issueProbeOutputUpload === "function", "VERIFICATION_ADAPTER_REQUIRED", "媒体验收上传适配器尚未就绪", 409);
    assert(isObject(output) && typeof output.filename === "string" && output.filename.length > 0 && output.filename.length <= 240
      && !/[\\/\u0000-\u001f\u007f]/.test(output.filename) && ![".", ".."].includes(output.filename)
      && typeof output.content_type === "string" && output.content_type.length <= 100
      && Number.isSafeInteger(output.bytes) && output.bytes > 0 && output.bytes <= 64 * 1024 * 1024
      && HASH.test(output.sha256 || "") && Object.hasOwn(PROBE_OUTPUT_TYPES, output.role)
      && challenge.outputUploadRequired === true
      && (challenge.probeKind !== "music" || output.role === "primary_audio" && ["audio/flac", "audio/x-flac"].includes(output.content_type)),
    "VERIFICATION_OUTPUT_INVALID", "自动验收只能上传当前任务要求的有界媒体文件", 400);
    validateProbeOutputDescriptor(challenge, output);
    return issueProbeOutputUpload({ binding, challenge: { ...challenge, verificationId: challenge._id, _id: challenge.challengeId }, output });
  }
  async function outputStatus({ binding, challengeId, leaseToken, outputId }) {
    const challenge = await ownedChallenge(binding, challengeId, leaseToken, ["leased", "verifying"]);
    assert(/^[A-Za-z0-9_-]{43}$/.test(outputId || ""), "VERIFICATION_OUTPUT_ID_INVALID", "验收输出编号格式不正确", 400);
    await limited(challenge.bindingId, "output-status", 60);
    assert(typeof getProbeOutputStatus === "function", "VERIFICATION_ADAPTER_REQUIRED", "验收输出只读恢复尚未就绪，请停止写入", 503);
    const result = await getProbeOutputStatus({ binding, challenge: { ...challenge, verificationId: challenge._id, _id: challenge.challengeId }, outputId });
    const current = await ownedChallenge(binding, challengeId, leaseToken, ["leased", "verifying"]);
    return result.state === "confirmed_absent" && current.status !== "leased"
      ? { ...result, state: "uncertain", retry_put_allowed: false, reason_code: "CHALLENGE_NOT_WRITABLE" } : result;
  }
  async function validateResult(record, inlineResult, outputs, binding) {
    const adapter = adapters[record.capabilityId];
    if (adapter?.validateResult) {
      const result = await adapter.validateResult({ challenge: { ...record, _id: record.challengeId }, inlineResult, outputs, binding });
      assert(isObject(result) && isObject(result.contractTests) && Object.values(result.contractTests).every((item) => typeof item === "boolean")
        && isObject(result.verifiedModel) && result.verifiedModel.id === record.model.id,
        "VERIFICATION_RESULT_INVALID", "服务端适配器未返回完整验证结果", 409);
      return result;
    }
    assert(isObject(inlineResult) && Buffer.byteLength(canonical(inlineResult)) <= RESULT_LIMIT,
      "VERIFICATION_RESULT_INVALID", "自动验收须返回完整且未超限的原始结果", 400);
    if (record.probeKind === "text") {
      assert(inlineResult.text?.trim() === record.nonce, "VERIFICATION_NONCE_MISMATCH", "模型未正确完成本次随机文字探测", 409);
      return { verifiedModel: record.model, contractTests: { exact_request: true, complete_response: true } };
    }
    let verifiedOutputs = [];
    if (record.probeKind === "music") {
      assert(typeof verifyMediaOutputs === "function" && Array.isArray(outputs) && outputs.length === 1
        && outputs.every((item) => isObject(item) && typeof item.output_id === "string" && Object.keys(item).length === 1),
      "VERIFICATION_OUTPUT_INVALID", "音乐验收必须引用本次任务的一份上传票据", 409);
      verifiedOutputs = await verifyMediaOutputs({ binding, challenge: { ...record, verificationId: record._id, _id: record.challengeId }, outputs });
      assert(Array.isArray(verifiedOutputs) && verifiedOutputs.length === 1, "VERIFICATION_OUTPUT_INVALID", "完整音乐文件未完成服务端实物校验", 409);
    }
    validateSpecialInlineResult({ capabilityId: record.capabilityId, parameters: record.parameters }, inlineResult, { outputs: verifiedOutputs });
    if (record.probeKind === "chat") {
      assert(inlineResult.response.choices[0]?.message?.content?.trim() === record.nonce
        && inlineResult.response.usage.completion_tokens <= record.budget.max_output_tokens,
      "VERIFICATION_NONCE_MISMATCH", "模型未正确完成本次随机文字探测或超过输出预算", 409);
      return { verifiedModel: record.model, contractTests: { exact_request: true, complete_response: true } };
    }
    if (record.probeKind === "embedding") {
      const vectors = inlineResult.response.data.map((item) => item.embedding);
      assert(vectors.every((vector) => vector.some((value) => value !== 0)) && canonical(vectors[0]) !== canonical(vectors[1]),
        "VERIFICATION_VECTOR_INVALID", "向量探测返回了无效的全零或相同结果", 409);
      return { verifiedModel: record.model, contractTests: { exact_request: true, complete_response: true, exact_model_dimension: true } };
    }
    if (record.probeKind === "music") {
      assert(inlineResult.lyric_verification.language === record.language, "VERIFICATION_LANGUAGE_MISMATCH", "整段音频识别语言与本次探测不一致", 409);
      const duration = verifiedOutputs[0].durationSeconds ?? verifiedOutputs[0].duration_seconds;
      assert(duration >= Math.max(1, record.parameters.seconds - 1), "VERIFICATION_AUDIO_TOO_SHORT", "音乐探测未覆盖本次要求的完整时长", 409);
      return { verifiedModel: { ...record.model, max_duration_seconds: Math.min(record.parameters.seconds, duration) },
        contractTests: { music_generation: true, whole_audio_asr: true, exact_lyrics: true, exact_duration: true }, asrLanguages: [record.language] };
    }
    throw failure("VERIFICATION_ADAPTER_REQUIRED", "该能力仍需真实结果验证适配器", 409);
  }
  async function submit({ binding, challengeId, leaseToken, status, inlineResult, outputs = [], error: reportedError }) {
    assert(["completed", "failed"].includes(status), "VERIFICATION_STATUS_INVALID", "自动验收结果状态不正确", 400);
    const active = await currentBinding(binding);
    await limited(String(active._id), "result", 12);
    const records = await collection();
    const existing = await records.findOne({ challengeId, bindingId: String(active._id) })
      || await (await getCollection(CHALLENGES)).findOne({ challengeId, bindingId: String(active._id) });
    const fingerprint = sha({ status, inlineResult: inlineResult ?? null, outputs, error: reportedError ?? null });
    if (existing && secretMatches(leaseToken, existing.leaseTokenHash) && existing.resultFingerprint) {
      assert(group(existing.computeGroupId) === group(active.computeGroupId), "COMPUTE_GROUP_MISMATCH", "用户分组已变化，禁止恢复旧验收结果", 403);
      assert(existing.resultFingerprint === fingerprint, "VERIFICATION_REPLAY_CONFLICT", "同一验收任务不能更改结果内容", 409);
      return { ok: true, idempotent: true, verification: publicState(existing.status === "active" && !verifiedAdapterScope(existing)
        ? { ...existing, status: "expired" } : existing) };
    }
    const record = await ownedChallenge(active, challengeId, leaseToken);
    const instant = new Date(now());
    const owned = unwrap(await records.findOneAndUpdate({ _id: record._id, challengeId, status: "leased", leaseExpiresAt: { $gt: instant } },
      { $set: { status: "verifying", updatedAt: instant } }, { returnDocument: "after" }));
    assert(owned, "VERIFICATION_STATE_CONFLICT", "该验收结果正在校验或已处理，请稍后查询状态", 409);
    let verified, validationError;
    try {
      if (status === "failed") throw failure("VERIFICATION_EXECUTION_FAILED", "节点探测未完成，将在退避后自动重试");
      verified = await validateResult(owned, inlineResult, outputs, active);
      await currentBinding(active);
      assert(new Date(owned.leaseExpiresAt) > new Date(now()), "VERIFICATION_LEASE_EXPIRED", "验收结果已超时，不能开放派单", 409);
      await (await getCollection(AUDITS)).insertOne({ _id: randomUUID(), action: "capability.automatic_verification_passed", challengeId,
        verificationId: owned._id, bindingId: owned.bindingId, nodeId: owned.nodeId, computeGroupId: owned.computeGroupId,
        matrixSha256: owned.matrixSha256, artifactSha256: owned.artifactSha256, model: verified.verifiedModel,
        resultSha256: sha({ inlineResult, outputs }), createdAt: new Date(now()) });
    } catch (error) { validationError = error; }
    const finished = new Date(now());
    const update = validationError ? { status: "failed", error: publicError(validationError, "自动验收服务暂时不可用，稍后自动重试"),
    nextRetryAt: new Date(+finished + Math.min(3600_000, 60_000 * 2 ** Math.min(owned.attempts - 1, 6))) }
      : { status: "active", verifiedModel: verified.verifiedModel, contractTests: verified.contractTests, asrLanguages: verified.asrLanguages || [],
        testedAt: finished, expiresAt: new Date(+finished + VALID_FOR), testEvidenceSha256: sha({ challengeId, parameters: owned.parameters, inlineResult, outputs }), error: null };
    const saved = unwrap(await records.findOneAndUpdate({ _id: owned._id, challengeId, status: "verifying", matrixSha256: owned.matrixSha256, inventoryEnabled: true },
      { $set: { ...update, updatedAt: finished, resultFingerprint: fingerprint } }, { returnDocument: "after" }));
    await (await getCollection(CHALLENGES)).updateOne({ challengeId, bindingId: String(active._id) }, { $set: {
      ...(saved ? update : { status: "invalidated", error: { code: "VERIFICATION_STATE_CONFLICT", message: "模型清单已变化，本次验收结果已失效" } }),
      resultFingerprint: fingerprint, updatedAt: finished,
    } });
    await releaseLocks({ _id: challengeId });
    assert(saved, "VERIFICATION_STATE_CONFLICT", "模型清单已变化，本次结果不会开放派单", 409);
    return { ok: true, idempotent: false, verification: publicState(saved) };
  }
  async function findTrusted({ bindingId, report: rawReport, now: suppliedNow }) {
    let inventory;
    try { inventory = normalizeAutoVerificationInventory(rawReport); } catch { return null; }
    if (!inventory.enabled || !ObjectId.isValid(bindingId)) return null;
    const binding = await (await getCollection("nodeAccountBindings")).findOne({ _id: new ObjectId(bindingId), status: "active", revokedAt: null });
    if (!binding) return null;
    const instant = new Date(suppliedNow || now());
    const accepted = await (await collection()).find({ bindingId: String(bindingId), nodeId: binding.nodeId, userId: String(binding.userId),
      computeGroupId: group(binding.computeGroupId), matrixSha256: inventory.matrixSha256, status: "active", inventoryEnabled: true,
      automaticMigrationEnabled: { $ne: false },
      testedAt: { $lte: instant }, expiresAt: { $gt: instant } }).limit(64).toArray();
    if (!accepted.length) return null;
    const records = accepted.filter((item) => item.verifiedModel && item.contractTests && HASH.test(item.testEvidenceSha256 || "")
      && new Date(item.expiresAt) - new Date(item.testedAt) <= VALID_FOR && verifiedAdapterScope(item, inventory));
    if (!records.length) return null;
    const models = records.map((item) => item.verifiedModel);
    const keys = [...new Set(records.flatMap((item) => Object.keys(item.contractTests)))];
    const contractTests = Object.fromEntries(keys.map((key) => [key, records.every((item) => item.contractTests[key] === true)]));
    return { source: "automatic", status: "active", artifactSha256: inventory.artifactSha256, matrixSha256: inventory.matrixSha256,
      capabilityId: inventory.capabilityId, capabilityVersion: inventory.capabilityVersion, models,
      defaultModel: models.some((model) => model.id === inventory.defaultModel) ? inventory.defaultModel : models[0].id,
      contractTests, asrLanguages: [...new Set(records.flatMap((item) => item.asrLanguages || []))].sort(),
      testedAt: new Date(Math.min(...records.map((item) => +new Date(item.testedAt)))),
      expiresAt: new Date(Math.min(...records.map((item) => +new Date(item.expiresAt)))), verificationIds: records.map((item) => item._id) };
  }
  return { report, next, submit, outputUpload, outputStatus, findTrusted, list, byRequest, getChallenge };
}

async function boundedBody(c, limit = 64 * 1024) {
  const reader = c.req.raw.body?.getReader();
  assert(reader, "VALIDATION_ERROR", "请提供完整 JSON 请求", 400);
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw failure("REQUEST_TOO_LARGE", "自动验收请求超过大小上限", 413); }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error.code) throw error; throw failure("VALIDATION_ERROR", "JSON 请求格式不正确", 400); }
}

export function registerCapabilityAutoVerificationRoutes(app, dependencies) {
  const { service, requireBinding, requireAdmin, openapi = true } = dependencies;
  assert(service && typeof requireBinding === "function" && typeof requireAdmin === "function", "VERIFICATION_DEPENDENCY_INVALID", "自动验收鉴权未配置", 500);
  const base = "/api/v1/capability-verifications";
  const admin = "/api/admin/capability-verifications";
  const route = (handler) => async (c) => {
    c.header("Cache-Control", "private, no-store");
    try { return await handler(c); }
    catch (error) { return c.json(publicError(error), Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503); }
  };
  const bound = (action) => route(async (c) => {
    const auth = await requireBinding(c); if (auth.error) return auth.error;
    const payload = await boundedBody(c, c.req.path.endsWith("/result") ? RESULT_LIMIT : 64 * 1024);
    assert(isObject(payload), "VALIDATION_ERROR", "请提供 JSON 对象", 400);
    return c.json(await action(auth.binding, payload, c));
  });
  app.post(`${base}/report`, bound((binding, body) => service.report({ binding, reports: body.capabilities,
    migrationPolicy: body.migration_policy, automaticCapabilityIds: body.automatic_capability_ids })));
  // Old deployments must return 404 rather than ignore v2 fields and enroll
  // the whole binding. New consumers never fall back from this dedicated URL.
  app.post(`${base}/report-v2`, bound((binding, body) => {
    assert(body.migration_policy === CAPABILITY_VERIFICATION_POLICY,
      "VERIFICATION_POLICY_INVALID", "逐能力上报必须使用 capability-v2 策略", 400);
    return service.report({ binding, reports: body.capabilities, migrationPolicy: CAPABILITY_VERIFICATION_POLICY,
      automaticCapabilityIds: body.automatic_capability_ids });
  }));
  app.post(`${base}/next`, bound((binding, body) => service.next({ binding, dryRun: body.dry_run ?? false, resources: body.resources,
    requestId: body.request_id, leaseToken: body.lease_token })));
  app.post(`${base}/:id/outputs`, bound((binding, body, c) => service.outputUpload({ binding, challengeId: c.req.param("id"), leaseToken: body.lease_token,
    output: { role: body.role, filename: body.filename, content_type: body.content_type, bytes: body.bytes, sha256: body.sha256 } })));
  app.post(`${base}/:id/result`, bound((binding, body, c) => service.submit({ binding, challengeId: c.req.param("id"), leaseToken: body.lease_token,
    status: body.status, inlineResult: body.inline_result, outputs: body.outputs ?? [], error: body.error })));
  const boundLookup = (method, field) => route(async (c) => {
    const auth = await requireBinding(c); if (auth.error) return auth.error;
    return c.json(await service[method]({ binding: auth.binding, [field]: c.req.param("key") || c.req.param("id"),
      leaseToken: c.req.header("X-Gulong-Verification-Lease") }));
  });
  app.get(`${base}/by-request/:key`, boundLookup("byRequest", "requestId"));
  app.get(`${base}/challenges/:id`, boundLookup("getChallenge", "challengeId"));
  app.get(`${base}/:id/outputs/:output_id`, route(async (c) => {
    const auth = await requireBinding(c); if (auth.error) return auth.error;
    assert(!Object.keys(c.req.query()).length, "VERIFICATION_QUERY_INVALID", "输出状态查询不能更改原文件清单", 400);
    return c.json(await service.outputStatus({ binding: auth.binding, challengeId: c.req.param("id"), outputId: c.req.param("output_id"),
      leaseToken: c.req.header("X-Gulong-Verification-Lease") }));
  }));
  app.get(admin, route(async (c) => {
    const auth = await requireAdmin(c); if (auth.error) return auth.error;
    const parsed = z.object({ binding_id: z.string().regex(/^[a-f0-9]{24}$/i).optional(), limit: z.coerce.number().int().min(1).max(256).default(100) }).safeParse(c.req.query());
    assert(parsed.success, "VERIFICATION_QUERY_INVALID", "自动验收查询条件不正确", 400);
    return c.json({ verifications: await service.list({ bindingId: parsed.data.binding_id, limit: parsed.data.limit }) });
  }));
  if (openapi && app.openAPIRegistry) {
    const objectSchema = z.record(z.string(), z.unknown());
    const modelSchema = z.object({ id: z.string().min(1).max(240) }).catchall(z.union([z.string(), z.number(), z.boolean()]));
    const artifactSchema = z.string().regex(/^[a-f0-9]{64}$/i);
    const inventorySchema = z.object({ capability_id: z.string().min(1).max(120), capability_version: z.string().max(120).default("1.0.0")
      .describe("自动迁移能力须通过对应精确版本适配器白名单；已注册的原生组件能力原样使用有界组件版本，其他自动能力须数字合同版本。仅capability-v2未迁移能力可保留其他1-120位原生版本[A-Za-z0-9][A-Za-z0-9_.+-]*作库存指纹，不授予验收资格"),
      installed: z.boolean(), enabled: z.boolean(), sharing_opt_in: z.boolean().default(false), artifact_sha256: artifactSchema.optional(),
      validation: z.object({ artifact_sha256: artifactSchema }).passthrough().optional(),
      models: z.array(modelSchema).min(1).max(64), default_model: z.string().optional(), asr_languages: z.array(z.enum(["zh", "en"])).max(2).optional(),
    }).passthrough();
    const resourceSchema = z.object({ gpu_state: z.enum(["idle", "busy", "unknown"]), gpu_observed_at: z.iso.datetime(),
      current_task_remaining_seconds: z.number().int().min(0), running_task_count: z.number().int().min(0) }).passthrough();
    const manifestSchema = z.object({ lease_token: z.string().min(32).max(256), role: z.enum(Object.keys(PROBE_OUTPUT_TYPES)),
      filename: z.string().min(1).max(240), content_type: z.string().max(100), bytes: z.number().int().positive().max(64 * 1024 * 1024), sha256: artifactSchema });
    const migrationSchema = z.object({ policy: z.enum(["binding-v1", CAPABILITY_VERIFICATION_POLICY]),
      automatic_capability_ids: z.array(z.string()), capabilities: z.array(z.object({ capability_id: z.string(),
        mode: z.enum(["automatic", "legacy_compatibility"]), all_models_have_adapter: z.boolean() })) });
    const requestSchemas = {
      report: z.object({ capabilities: z.array(inventorySchema).min(1).max(64).describe("完整的结构化安装与共享库存，不能仅上报待迁移的三项能力而丢弃其他能力"),
        migration_policy: z.literal(CAPABILITY_VERIFICATION_POLICY).optional().describe("新消费者显式使用capability-v2；省略保留旧版绑定级行为，已迁移v2节点不得再省略"),
        automatic_capability_ids: z.array(z.string().regex(CAPABILITY)).max(64).optional().describe("capability-v2时必填；服务器原子追加的能力迁移范围，不是验收通过列表；清空或遗漏不能撤销已迁移ID") }),
      next: z.object({ dry_run: z.boolean().default(false), resources: resourceSchema.optional(),
        request_id: z.string().regex(REQUEST_ID).optional(), lease_token: z.string().regex(CLIENT_SECRET).optional() }),
      "{id}/outputs": manifestSchema,
      "{id}/result": z.object({ lease_token: z.string().min(32).max(256), status: z.enum(["completed", "failed"]),
        inline_result: objectSchema.optional(), outputs: z.array(z.object({ output_id: z.string() }).strict()).max(4).optional(), error: z.string().max(1000).optional() }),
    };
    requestSchemas["report-v2"] = requestSchemas.report.required({ migration_policy: true, automatic_capability_ids: true });
    const inputAssetSchema = z.object({ fixture_id: z.string().max(80), role: z.enum(["reference_image", "source_image", "source_video", "media", "reference_audio"]),
      filename: z.string().max(120), content_type: z.enum(["image/png", "image/jpeg", "video/mp4", "audio/flac", "audio/wav"]),
      bytes: z.number().int().positive().max(4 * 1024 * 1024), sha256: artifactSchema,
      download_url: z.string().url().optional(), expires_at: z.iso.datetime().optional() });
    const challengeSchema = z.object({ id: z.string(), lease_token: z.string().optional(), expires_at: z.iso.datetime(), capability_id: z.string(), capability_version: z.string(),
      artifact_sha256: artifactSchema, model: modelSchema, parameters: objectSchema,
      budget: z.object({ max_inferences: z.literal(1), max_output_tokens: z.number().max(128).optional(), max_audio_seconds: z.number().max(12).optional(),
        max_images: z.number().int().max(1).optional(), max_image_pixels: z.number().int().max(2048 * 2048).optional(),
        max_input_assets: z.number().int().max(3).optional(), max_input_bytes: z.number().int().max(8 * 1024 * 1024).optional(),
        max_video_frames: z.number().int().max(64).optional(), max_video_seconds: z.number().int().max(12).optional(), max_asr_passes: z.number().int().max(1).optional() }),
      input_assets: z.array(inputAssetSchema).max(3).optional().describe("仅服务器固定夹具；下载后必须校验完整大小及SHA-256，不能替换为用户文件或传官网令牌到下载地址。下载票据最多5分钟且不超过租约；原请求GET恢复可重签同一输入，不新增推理。终态仅返回无URL的描述符，禁止重执行"),
      output_requirements: z.array(z.object({ role: z.enum(Object.keys(PROBE_OUTPUT_TYPES)), content_types: z.array(z.string()),
        max_bytes: z.number().int().positive().max(64 * 1024 * 1024), min_count: z.number().int().min(0).max(1), max_count: z.literal(1) })).max(4).optional(),
      compute_group_id: z.string().nullable(), node_id: z.string(), output_upload_required: z.boolean() });
    for (const suffix of ["report", "report-v2", "next", "{id}/outputs", "{id}/result"]) app.openAPIRegistry.registerPath({ method: "post", path: `${base}/${suffix}`,
      tags: ["Automatic Capability Verification"], summary: { report: "上报未验收的已安装模型清单", "report-v2": "新消费者专用逐能力迁移，旧部署404时禁止回退report", next: "领取单次随机自动验收探测", "{id}/outputs": "签发本次媒体探测的私有上传票据", "{id}/result": "提交真实探测结果并由服务端自动验收" }[suffix],
      security: [{ accountBinding: [] }], description: "使用 X-Gulong-Account-Binding。身份、分组、制品及完整模型矩阵绑定；每节点仅一项探测、全局最多四项；每天最多 16 次，每模型最多 3 次。单探测最多一次模型推理，文字 32 token、音频最多 12 秒；不产生用户订单、钱包流水或分佣。validated=true 不构成验收。失败退避重试，七天到期。音乐必须上传完整 FLAC，服务端流式验证实物摘要/时长并核验整段 ASR 完整歌词。未知适配器保持 adapter_required。",
      request: { ...(suffix.startsWith("{id}") ? { params: z.object({ id: z.string().regex(/^gcv_[a-f0-9-]{36}$/) }) } : {}),
        body: { content: { "application/json": { schema: requestSchemas[suffix] } } } },
      responses: { 200: { description: "仅自动真实验收通过的精确模型/维度/功能可开放；next 的 dry_run 不领取、不消耗预算",
        ...(["report", "report-v2"].includes(suffix) ? { content: { "application/json": { schema: z.object({ ok: z.literal(true), protocol: z.string(),
          migration: migrationSchema, verifications: z.array(objectSchema) }) } } }
          : suffix === "next" ? { content: { "application/json": { schema: z.object({ ok: z.literal(true), protocol: z.string().optional(), challenge: challengeSchema.nullable(),
          request_id: z.string().nullable().optional(), state: z.string().optional(), lease_valid: z.boolean().optional(), recovered: z.boolean().optional(),
          execute_once: z.boolean().optional(), execution_policy: z.string().optional(), retry_after_seconds: z.number().optional(), code: z.string().optional(), queue: z.string().optional() }) } } }
          : suffix.endsWith("outputs") ? { content: { "application/json": { schema: z.object({ output_id: z.string(), object_key: z.string(), url: z.string().url(), method: z.literal("PUT"), headers: z.record(z.string(), z.string()), expires_at: z.iso.datetime() }) } } } : {}) },
        400: { description: "参数不正确" }, 401: { description: "节点未绑定" }, 403: { description: "跨节点、跨分组或租约无效" },
        409: { description: "状态或实物校验不通过；report: VERIFICATION_CAPABILITY_NOT_MIGRATABLE=新追加能力没有完整适配器，VERIFICATION_MIGRATION_REVIEW_REQUIRED=v1绑定不可降级，VERIFICATION_POLICY_REQUIRED=v2请求须保留策略" },
        429: { description: "限流" }, 503: { description: "服务或适配器未就绪，不开放派单" } } });
    for (const [suffix, params] of [["by-request/{key}", z.object({ key: z.string().regex(REQUEST_ID) })], ["challenges/{id}", z.object({ id: z.string().regex(/^gcv_[a-f0-9-]{36}$/) })]]) {
      app.openAPIRegistry.registerPath({ method: "get", path: `${base}/${suffix}`, tags: ["Automatic Capability Verification"], summary: "按原请求编号或验收任务恢复安全状态",
        security: [{ accountBinding: [] }], request: { params, headers: z.object({ "X-Gulong-Verification-Lease": z.string().min(32).max(256) }) },
        description: "同时提供 X-Gulong-Account-Binding 和客户端本地 journal 保存的 X-Gulong-Verification-Lease。仅当前绑定节点及同组可读；不返回原始令牌。404 表示该绑定下从未创建，不能将网络错误当作404。相同 request_id 必须沿用原secret；终态、not_issued、preparing或过期任务不能重新执行。只恢复原journal，不生成新探测、不重复预算或模型调用。",
        responses: { 200: { description: "原始challenge及当前state；lease_valid=false或终态禁止执行", content: { "application/json": { schema: z.object({ ok: z.literal(true),
          protocol: z.literal(AUTO_VERIFICATION_PROTOCOL), recovered: z.literal(true), request_id: z.string().nullable(), state: z.string(), lease_valid: z.boolean(),
          execute_once: z.literal(true), execution_policy: z.literal("resume_existing_journal_only"), challenge: challengeSchema.nullable() }) } } },
          400: { description: "编号或安全凭据格式不正确" }, 401: { description: "绑定已失效" }, 403: { description: "分组不一致" },
          404: { description: "当前节点从未创建此请求或任务" }, 409: { description: "已有请求的安全凭据不一致" }, 429: { description: "查询过于频繁" } } });
    }
    app.openAPIRegistry.registerPath({ method: "get", path: `${base}/{id}/outputs/{output_id}`, tags: ["Automatic Capability Verification"],
      summary: "只读恢复原自动验收输出状态，不签发新上传或验收证明", security: [{ accountBinding: [] }],
      request: { params: z.object({ id: z.string().regex(/^gcv_[a-f0-9-]{36}$/), output_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
        headers: z.object({ "X-Gulong-Verification-Lease": z.string().min(32).max(256) }) },
      description: "同时提供绑定令牌和原journal租约，校验当前绑定/分组/租约及服务器登记的完整descriptor。仅HEAD及版本策略只读查询，不返回URL/PUT/新对象，不延长expires_at、不开放模型。confirmed_present仍须提交原output_id走result完整字节SHA与媒体校验。只有confirmed_absent且retry_put_allowed=true才可在原期限内按原对象/原字节/原headers重试原PUT；uncertain、404、403、409、429或网络未知必须停写保留journal。新票据签名含x-cos-forbid-overwrite=true；旧无防覆盖票据不授予absent重传。普通用户素材恢复入口不能替代本接口。",
      responses: { 200: { description: "原输出的只读状态；不是模型或媒体验收通过", content: { "application/json": { schema: z.object({
        ok: z.literal(true), challenge_id: z.string(), output_id: z.string(), state: z.enum(["confirmed_present", "confirmed_absent", "uncertain"]),
        retry_put_allowed: z.boolean(), content_verified: z.literal(false), reason_code: z.string().nullable(),
        descriptor: z.object({ role: z.enum(Object.keys(PROBE_OUTPUT_TYPES)), filename: z.string(), content_type: z.string(), bytes: z.number().int().positive(), sha256: artifactSchema, object_key: z.string() }),
        expires_at: z.iso.datetime(), checked_at: z.iso.datetime() }) } } },
        400: { description: "编号或查询参数不正确" }, 401: { description: "节点绑定已失效" }, 403: { description: "跨节点/分组或租约不匹配" },
        404: { description: "当前租约没有登记此输出；不能当成COS对象不存在" }, 409: { description: "验收已结束、过期或清单不一致" },
        429: { description: "每节点每分钟最多60次状态查询" }, 503: { description: "恢复适配器不可用，请停止写入" } } });
    app.openAPIRegistry.registerPath({ method: "get", path: admin, tags: ["Automatic Capability Verification"], summary: "管理员只读查询自动模型验收状态", security: [{ sessionCookie: [] }], responses: { 200: { description: "不包含租约令牌、随机探测内容、用户邮箱或模型原始结果" } } });
  }
}
