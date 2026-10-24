import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection, withDatabaseTransaction } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { normalizeComputeGroupId } from "./compute-groups.js";
import { inspectVerificationBinary } from "./capability-verification-media.js";
import { inspectFlacStream } from "./capability-flac.js";
import { validateSpecialInlineResult } from "./worklucky-capabilities.js";
import { createLocalResultChunkStore, registerLocalResultChunkRoute, LOCAL_RESULT_STORAGE_BYTES, LOCAL_RESULT_OUTPUT_TYPES } from "./capability-local-result-chunks.js";

export const LOCAL_RESULT_PROTOCOL = "gulong-local-capability-result/v1";
export const LOCAL_RESULT_COLLECTION = "capabilityLocalResultReports";
// Nine original identities plus ACE-Step, which replaces (not aliases) Music3.
export const LOCAL_RESULT_CAPABILITIES = Object.freeze([
  "gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music",
  "qwen_image_2_1.text_to_image", "qwen_image_2_1.multi_image_edit", "sam.video_track",
  "mediapipe.video_analysis", "whisper.transcribe", "minimax_music_3.generate", "ace_step_1_5.generate",
]);
const SHA = z.string().regex(/^[a-f0-9]{64}$/);
const SIMPLE = z.union([z.string().max(240), z.number().finite(), z.boolean()]);
const object = z.record(z.string(), z.unknown());
const group = z.string().regex(/^gug_[a-f0-9]{32}$/).nullable();
export const LOCAL_RESULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const OUTPUT_ROLES = {
  "gulong_engine.agent_chat": [], "gulong_engine.embedding": [], "gulong_engine.music": ["primary_audio"],
  "qwen_image_2_1.text_to_image": ["primary_image"], "qwen_image_2_1.multi_image_edit": ["primary_image"],
  "sam.video_track": ["manifest_json", "tracks_jsonl", "mask_archive"],
  "mediapipe.video_analysis": ["analysis_json", "pose_tracks_jsonl", "person_layers_archive"],
  "whisper.transcribe": ["transcript_json", "transcript_text"], "minimax_music_3.generate": ["primary_audio"],
  "ace_step_1_5.generate": ["primary_audio"],
};
const base64 = (max) => z.string().min(4).max(4 * Math.ceil(max / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const source = z.object({ protocol: z.literal("h3-direct-capabilities/v1"), request_id: z.string().uuid(), job_id: z.string().uuid(),
  owner_sha256: SHA, capability_id: z.enum(LOCAL_RESULT_CAPABILITIES), capability_version: z.string().min(1).max(120),
  request_sha256: SHA, website_verified: z.literal(false) }).strict();
const outputBase = z.object({ artifact_id: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/), role: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), filename: z.string().min(1).max(120).regex(/^[^/\\\u0000-\u001f]+$/),
  content_type: z.enum(["image/png", "audio/flac", "application/json", "application/x-ndjson", "application/zip", "text/plain"]),
  bytes: z.number().int().min(1).max(64 * 1024 * 1024), sha256: SHA }).strict();
const output = z.union([outputBase.extend({ bytes: z.number().int().min(1).max(LOCAL_RESULT_MAX_FILE_BYTES), content_base64: base64(LOCAL_RESULT_MAX_FILE_BYTES) }).strict(),
  outputBase.extend({ upload_id: z.string().uuid() }).strict()]);
// This is an evidence *intake*, not a new proof authority. No consumer key or
// supplied signature is trusted until its native contract is release-reviewed.
export const localResultSchema = z.object({
  protocol: z.literal(LOCAL_RESULT_PROTOCOL), report_id: z.string().uuid(), local_request_id: z.string().uuid(),
  node_id: z.string().min(12).max(256), compute_group_id: group,
  capability_id: z.enum(LOCAL_RESULT_CAPABILITIES), capability_version: z.string().min(1).max(120),
  artifact_sha256: SHA, consumer_artifact_sha256: SHA, matrix_sha256: SHA,
  model: z.object({ id: z.string().min(1).max(240) }).catchall(SIMPLE),
  asr_languages: z.array(z.enum(["zh", "en"])).max(2),
  case_id: z.string().min(1).max(120), started_at: z.iso.datetime(), completed_at: z.iso.datetime(),
  local_direct_source: source, request_body_base64: base64(65536), response_body_base64: base64(320 * 1024),
  execution: z.object({ origin: z.enum(["local", "lan"]), transport: z.enum(["http", "https", "native_pipe"]),
    endpoint_path: z.string().max(200).regex(/^\/[A-Za-z0-9_./:-]*$/) }).strict(),
  status: z.enum(["completed", "failed"]), parameters: object, inline_result: object.nullable(),
  outputs: z.array(output).max(8), error_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(),
  native_receipt: z.object({ protocol: z.string().min(1).max(120), key_id: z.string().min(1).max(120),
    algorithm: z.enum(["RS256", "Ed25519"]), payload_base64: z.string().min(1).max(32768).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    signature_base64: z.string().min(1).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict().optional(),
}).strict();
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const digest = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => JSON.stringify(v, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
function safeTree(root) {
  const stack = [[root, 0]]; let count = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++count > 20000 || depth > 24) throw fail("LOCAL_RESULT_TOO_COMPLEX", "结果证据层级或字段数量超过安全上限");
    if (typeof value === "number" && !Number.isFinite(value)) throw fail("LOCAL_RESULT_INVALID", "结果中不能包含非有限数值");
    if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || /^(?:authorization|password|privatekey|apikey|apitoken|accesstoken|refreshtoken|bindingtoken|leasetoken|clientsecret|xh3clientsession|xh3clientdevice)$/i.test(key.replace(/[_-]/g, ""))) {
        throw fail("LOCAL_RESULT_SECRET_REJECTED", "结果证据不能包含凭据、私钥或不安全字段");
      }
      stack.push([item, depth + 1]);
    }
  }
}
// JSON.parse alone silently discards duplicate keys. Inspect the original
// UTF-8 spelling as well, so a report cannot change meaning across parsers.
function strictJson(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const result = JSON.parse(text); let at = 0;
  const ws = () => { while (/\s/.test(text[at] || "") && at < text.length) at++; };
  function string() {
    const start = at++;
    while (at < text.length) { const c = text[at++]; if (c === "\\") at++; else if (c === '"') return JSON.parse(text.slice(start, at)); }
    throw fail("LOCAL_RESULT_INVALID", "结果 JSON 字符串不完整");
  }
  function value(depth) {
    if (depth > 24) throw fail("LOCAL_RESULT_TOO_COMPLEX", "结果 JSON 层级超过安全上限");
    ws(); const c = text[at];
    if (c === "{") {
      at++; ws(); const keys = new Set();
      while (text[at] !== "}") {
        const key = string(); if (keys.has(key)) throw fail("LOCAL_RESULT_DUPLICATE_KEY", "结果 JSON 不能包含重复字段");
        keys.add(key); ws(); at++; value(depth + 1); ws();
        if (text[at] !== ",") break; at++; ws();
      }
      at++;
    } else if (c === "[") {
      at++; ws(); while (text[at] !== "]") { value(depth + 1); ws(); if (text[at] !== ",") break; at++; }
      at++;
    } else if (c === '"') string();
    else { while (at < text.length && !/[\s,\]}]/.test(text[at])) at++; }
  }
  value(0); safeTree(result); return result;
}
function originalBytes(value, maximum) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) throw fail("LOCAL_RESULT_BYTES_INVALID", "原始文件编码或大小不正确，不能截断或替换原文件");
  return bytes;
}
async function checkOriginalEvidence(input, binding, store) {
  const direct = input.local_direct_source;
  if (direct.request_id !== input.local_request_id || direct.capability_id !== input.capability_id || direct.capability_version !== input.capability_version) throw fail("LOCAL_RESULT_SCOPE_MISMATCH", "本地原始请求与报告能力不一致", 403);
  const requestBytes = originalBytes(input.request_body_base64, 65536);
  if (digest(requestBytes) !== direct.request_sha256) throw fail("LOCAL_RESULT_REQUEST_HASH_MISMATCH", "原始请求完整摘要不一致");
  let request, response;
  try { request = strictJson(requestBytes); response = strictJson(originalBytes(input.response_body_base64, 320 * 1024)); }
  catch (error) { if (error.status) throw error; throw fail("LOCAL_RESULT_INVALID", "原始请求或响应不是完整的 UTF-8 JSON"); }
  if (!request || Array.isArray(request) || Object.keys(request).sort().join() !== "assets,capability_id,capability_version,parameters,request_id"
    || request.request_id !== direct.request_id || request.capability_id !== input.capability_id || request.capability_version !== input.capability_version
    || canonical(request.parameters) !== canonical(input.parameters) || !Array.isArray(request.assets)) throw fail("LOCAL_RESULT_REQUEST_MISMATCH", "须保留原始直连请求的全部字段与参数");
  if (!response || response.protocol !== direct.protocol || response.request_id !== direct.request_id || response.job_id !== direct.job_id
    || response.capability_id !== input.capability_id || response.capability_version !== input.capability_version
    || canonical(response.local_direct_source) !== canonical(direct) || response.terminal !== true
    || !(input.status === "completed" ? response.state === "succeeded" : ["failed", "cancelled"].includes(response.state))
    || canonical(response.result) !== canonical(input.inline_result) || !Array.isArray(response.artifacts) || response.artifacts.length !== input.outputs.length) {
    throw fail("LOCAL_RESULT_RESPONSE_MISMATCH", "报告必须对应原始终态响应及全部输出，不能省略或重新组织结果");
  }
  if (input.status === "failed" && !input.error_code) throw fail("LOCAL_RESULT_INVALID", "失败结果必须保留明确错误码");
  if (new Set(input.outputs.map(o => o.role)).size !== input.outputs.length || new Set(input.outputs.map(o => o.artifact_id)).size !== input.outputs.length
    || input.outputs.reduce((sum, o) => sum + o.bytes, 0) > LOCAL_RESULT_STORAGE_BYTES
    || input.outputs.filter(o => o.content_base64).reduce((sum, o) => sum + o.bytes, 0) > LOCAL_RESULT_MAX_FILE_BYTES) throw fail("LOCAL_RESULT_OUTPUT_LIMIT", "输出重复或超过完整文件上报预算；大文件请按原字节分块，不要裁切", 413);
  const roles = input.outputs.map(o => o.role).sort();
  const expectedRoles = input.capability_id === "whisper.transcribe" && !roles.includes("transcript_text") ? ["transcript_json"] : OUTPUT_ROLES[input.capability_id];
  if (input.status === "completed" && canonical(roles) !== canonical([...expectedRoles].sort())) throw fail("LOCAL_RESULT_OUTPUT_MISSING", "成功报告必须保留本能力的全部原始输出，不能遗漏媒体或逐帧文件");
  const observations = [];
  for (const file of input.outputs) {
    if (!OUTPUT_ROLES[input.capability_id].includes(file.role) || !LOCAL_RESULT_OUTPUT_TYPES[file.role]?.includes(file.content_type)) throw fail("LOCAL_RESULT_OUTPUT_INVALID", "输出角色与实际文件类型不匹配");
    const matches = response.artifacts.filter(o => o.artifact_id === file.artifact_id);
    if (matches.length !== 1 || ["role", "content_type", "bytes", "sha256"].some(key => matches[0][key] !== file[key])) throw fail("LOCAL_RESULT_MANIFEST_MISMATCH", "原响应输出清单与完整原文件不一致");
    const bytes = file.upload_id ? await store.read(binding, input, file) : originalBytes(file.content_base64, LOCAL_RESULT_MAX_FILE_BYTES);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw fail("LOCAL_RESULT_OUTPUT_HASH_MISMATCH", "输出原文件的完整长度或 SHA-256 不一致");
    let metadata;
    try {
      if (file.content_type === "audio/flac") metadata = await inspectFlacStream((async function* () { yield bytes; })(), { maxBytes: 64 * 1024 * 1024, expectedBytes: file.bytes, expectedSha256: file.sha256 });
      else if (file.content_type === "text/plain") {
        if (bytes.length > 4 * 1024 * 1024) throw new Error("text limit");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\u0000")) throw new Error("invalid text");
        metadata = { actualContentType: "text/plain", utf8: true };
      } else {
        metadata = inspectVerificationBinary(bytes, file.content_type);
        if (file.content_type === "application/json") strictJson(bytes);
        if (file.content_type === "application/x-ndjson") for (const line of bytes.toString("utf8").trimEnd().split("\n")) strictJson(Buffer.from(line));
      }
    } catch { throw fail("LOCAL_RESULT_OUTPUT_INVALID", "输出原文件的完整格式校验未通过，请保留原始失败证据"); }
    observations.push({ artifact_id: file.artifact_id, role: file.role, content_type: file.content_type, bytes: bytes.length, sha256: digest(bytes), ...metadata });
  }
  if (input.status === "completed" && ["gulong_engine.agent_chat", "gulong_engine.embedding"].includes(input.capability_id)) {
    try {
      if (input.parameters.model !== input.model.id || input.capability_id === "gulong_engine.embedding" && input.parameters.dimension !== input.model.dimension) throw new Error("model");
      validateSpecialInlineResult({ capabilityId: input.capability_id, parameters: input.parameters }, input.inline_result, { outputs: observations });
    } catch { throw fail("LOCAL_RESULT_INLINE_INVALID", "完整原始模型响应、模型编号或向量维度与请求不一致"); }
  }
  // Native task success is not semantic acceptance. Store the original whole
  // audio/ASR (including failed/missing lyrics) without invoking a music probe
  // validator that could demand re-generation or silently grant model trust.
  if (input.capability_id === "ace_step_1_5.generate" && input.capability_version !== "1.5-turbo-dit-only"
    || input.capability_id === "gulong_engine.music" && !["1.0.0", "2.0.0"].includes(input.capability_version)) {
    throw fail("LOCAL_RESULT_CAPABILITY_VERSION_MISMATCH", "音乐能力版本与独立的原始能力标识不匹配，不可冒用旧版通过记录");
  }
  return { requestSha256: digest(requestBytes), responseSha256: digest(originalBytes(input.response_body_base64, 320 * 1024)),
    completeOriginalBytes: true, outputs: observations };
}
async function readBody(c) {
  if (!/^application\/json(?:;|$)/i.test(c.req.header("content-type") || "")) throw fail("LOCAL_RESULT_INVALID", "请使用 application/json 上报完整结果");
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw fail("LOCAL_RESULT_INVALID", "请提供完整的结果 JSON");
  const chunks = []; let length = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw fail("LOCAL_RESULT_TOO_LARGE", "完整结果不能超过 4 MiB，请保留原始证据，不要裁切或重跑", 413); }
      chunks.push(part.value);
    }
    return strictJson(Buffer.concat(chunks));
  } catch (error) { if (error.status) throw error; throw fail("LOCAL_RESULT_INVALID", "结果必须是完整的 UTF-8 JSON"); }
}
function receipt(record, idempotent) {
  return { ok: true, protocol: LOCAL_RESULT_PROTOCOL, receipt_id: record._id, report_id: record.reportId,
    status: "pending-native-review", submitted_status: record.evidence.status, idempotent,
    verified: false, grants_admission: false, task_dispatched: false,
    output_integrity_verified: true, local_direct_tested: false,
    missing_requirements: ["native_execution_review", "installed_scope_review"],
    message: "已收到完整本地结果，字节校验通过，待原生执行审核；不授予官网共享准入，不派发任务" };
}

export function registerLocalCapabilityResultRoutes(app, dependencies) {
  const table = dependencies.getCollection || databaseCollection;
  const transaction = dependencies.transaction || withDatabaseTransaction;
  const limited = dependencies.enforceRateLimit || databaseRateLimit;
  const now = dependencies.now || (() => new Date());
  const store = createLocalResultChunkStore({ table, transaction, now });
  registerLocalResultChunkRoute(app, { requireBinding: dependencies.requireBinding, transaction, limited, store, roles: OUTPUT_ROLES, parseJson: strictJson });
  app.post("/api/v1/capability-verifications/local-results", async (c) => {
    c.header("Cache-Control", "private, no-store");
    try {
      const auth = await dependencies.requireBinding(c); if (auth.error) return auth.error;
      const binding = auth.binding;
      if (!binding?._id || binding.status !== "active" || binding.revokedAt) throw fail("BINDING_REQUIRED", "节点绑定已失效", 401);
      const bindingId = String(binding._id);
      if (!(await limited(`local-results:${bindingId}`, { limit: 60, windowMs: 60000 })).allowed) throw fail("RATE_LIMITED", "结果上报过于频繁，请稍后重试", 429);
      const raw = await readBody(c); safeTree(raw);
      if (Array.isArray(raw?.outputs) && raw.outputs.some(file => !file?.upload_id && (file?.bytes > LOCAL_RESULT_MAX_FILE_BYTES || typeof file?.content_base64 === "string" && file.content_base64.length > 4 * Math.ceil(LOCAL_RESULT_MAX_FILE_BYTES / 3)))) throw fail("LOCAL_RESULT_OUTPUT_LIMIT", "内嵌原始输出超过 2 MiB，请按原字节分块上报，不要裁切", 413);
      const parsed = localResultSchema.safeParse(raw);
      if (!parsed.success) throw fail("LOCAL_RESULT_INVALID", "本地验收结果合同不完整或包含不支持字段");
      const input = parsed.data;
      if (input.node_id !== binding.nodeId || input.compute_group_id !== normalizeComputeGroupId(binding.computeGroupId)) throw fail("LOCAL_RESULT_SCOPE_MISMATCH", "结果节点或算力分组与当前绑定不一致", 403);
      const fingerprint = digest(canonical(input)), id = `glr_${digest(`${bindingId}:${input.report_id}`)}`;
      const existing = await (await table(LOCAL_RESULT_COLLECTION)).findOne({ _id: id });
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw fail("LOCAL_RESULT_CONFLICT", "原报告内容已固定，重报必须保持原编号与完整原始证据", 409);
        return c.json(receipt(existing, true), 200);
      }
      const start = +new Date(input.started_at), end = +new Date(input.completed_at), instant = +now();
      if (start > end || end > instant + 5000 || start < instant - 7 * 86400000) throw fail("LOCAL_RESULT_TIME_INVALID", "验收起止时间无效，首次收件不能使用未来结果或超过七天的旧结果");
      const integrity = input.outputs.length ? await store.validate(() => checkOriginalEvidence(input, binding, store)) : await checkOriginalEvidence(input, binding, store);
      const saved = await transaction(async (session) => {
        const reports = await table(LOCAL_RESULT_COLLECTION);
        const old = await reports.findOne({ _id: id }, { session });
        if (old) {
          if (old.fingerprint !== fingerprint) throw fail("LOCAL_RESULT_CONFLICT", "原报告内容已固定，重报必须保持原编号与完整原始证据", 409);
          return { record: old, repeated: true };
        }
        if (await reports.findOne({ bindingId, localRequestId: input.local_request_id }, { session })) throw fail("LOCAL_RESULT_CONFLICT", "该本地请求已上报，请沿用原报告编号", 409);
        const fresh = await limited(`local-results-new:${bindingId}:${now().toISOString().slice(0, 10)}`, { limit: 64, windowMs: 86400000 });
        if (!fresh.allowed) throw fail("LOCAL_RESULT_LIMIT", "本日新结果报告已达上限，保留原报告后稍后重报", 429);
        const record = { _id: id, reportId: input.report_id, bindingId, nodeId: binding.nodeId, userId: String(binding.userId),
          computeGroupId: normalizeComputeGroupId(binding.computeGroupId), localRequestId: input.local_request_id, capabilityId: input.capability_id,
          fingerprint, evidence: input, integrity, status: "pending-native-review", verified: false, grantsAdmission: false, receivedAt: now() };
        await store.seal(binding, input, session);
        await reports.insertOne(record, { session });
        await (await table("capabilityLocalResultAudits")).insertOne({ _id: id, action: "local_result_pending_native_review", bindingId,
          reportId: input.report_id, capabilityId: input.capability_id, fingerprint, createdAt: now() }, { session });
        return { record, repeated: false };
      });
      return c.json(receipt(saved.record, saved.repeated), saved.repeated ? 200 : 202);
    } catch (error) {
      if (error.code === 11000) return c.json({ code: "LOCAL_RESULT_RETRY_ORIGINAL", message: "相同结果正在登记，请保留原编号和证据后重报" }, 409);
      return c.json({ code: error.status ? error.code : "LOCAL_RESULT_UNAVAILABLE", message: error.status ? error.message : "结果暂时无法登记，请保留原始证据后重报" }, error.status || 503);
    }
  });
  app.openAPIRegistry?.registerPath({ method: "post", path: "/api/v1/capability-verifications/local-results", tags: ["Local Result Intake"], security: [{ accountBinding: [] }],
    summary: "仅接收本地/LAN验收结果；未核验，不授共享准入，不创建任务",
    description: "仅POST完整结果，无GET、任务领取、素材查询、模型调用、额度或钱包写入。原始请求/响应使用规范base64；总JSON最大4MiB。原文件可内嵌（合计2MiB）或先POST纯结果chunks后以upload_id引用（8文件/128MiB，每文件64MiB）；完整原始字节重组，不裁切/转码/重跑。本绑定所有证据总预算128MiB/64文件，不自动删旧证据。核对原始request SHA、终态job/owner/能力/清单对应及全文件大小/SHA/格式；全局受控完整性校验锁仅限结果收件，不是推理租约。统一pending-native-review、verified=false、grants_admission=false；客户端公钥/签名不授信，不签发旧challenge。原报告与原本地请求幂等，失败记录不覆盖、不重开窗口。完整合同见docs/local-node-results.md。",
    request: { body: { content: { "application/json": { schema: localResultSchema } } } },
    responses: { 202: { description: "完整字节已校验，pending-native-review；无准入" }, 200: { description: "原报告幂等回执，仍待原生审核" }, 400: { description: "格式、时间、摘要或原响应无效" }, 401: { description: "绑定无效" }, 403: { description: "跨节点或跨组" }, 409: { description: "同编号证据冲突" }, 413: { description: "超过受控完整证据上限" }, 429: { description: "上报限流" }, 503: { description: "无法保存；保留原证据重报" } } });
}
