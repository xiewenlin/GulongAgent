import { createHash, randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { normalizeComputeGroupId } from "./compute-groups.js";
import { PROBE_OUTPUT_TYPES } from "./capability-probe-outputs.js";

// Intake-only formats; do not widen automatic-probe/admission output rules.
export const LOCAL_RESULT_OUTPUT_TYPES = Object.freeze({ ...PROBE_OUTPUT_TYPES, transcript_text: ["text/plain"] });

export const LOCAL_RESULT_CHUNK_BYTES = 1024 * 1024;
export const LOCAL_RESULT_STORAGE_BYTES = 128 * 1024 * 1024;
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
export const localChunkSchema = z.object({
  upload_id: id, report_id: id, local_request_id: id, job_id: id,
  owner_sha256: hash, request_sha256: hash,
  capability_id: z.string().min(1).max(120), capability_version: z.string().min(1).max(120),
  artifact_id: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/),
  filename: z.string().min(1).max(120).regex(/^[^/\\\u0000-\u001f]+$/),
  role: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), content_type: z.string().max(80),
  file_bytes: z.number().int().min(1).max(64 * 1024 * 1024), file_sha256: hash,
  chunk_index: z.number().int().min(0).max(63), chunk_offset: z.number().int().min(0),
  chunk_bytes: z.number().int().min(1).max(LOCAL_RESULT_CHUNK_BYTES), chunk_sha256: hash,
}).strict();
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const canonical = (v) => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const fileKey = (binding, upload) => `glrf_${sha(`${binding._id}:${upload}`)}`;
function immutableFile(d) { const { chunk_index, chunk_offset, chunk_bytes, chunk_sha256, ...file } = d; return file; }

/** Private evidence storage only. Lifetime budget is never silently reset and
 * no old evidence is evicted to admit a new report. No filesystem extraction. */
export function createLocalResultChunkStore({ table, transaction, now = () => new Date() }) {
  async function validate(action) {
    const token = randomUUID(), key = "global-output-integrity-lock";
    await transaction(async session => {
      const rows = await table("capabilityLocalResultStorage"), old = await rows.findOne({ _id: key }, { session });
      if (old && (!Number.isSafeInteger(old.version) || old.version < 1 || !(old.until instanceof Date) || !Number.isFinite(+old.until))) throw fail("LOCAL_RESULT_STORAGE_INVALID", "结果校验状态异常，已保留原证据，请联系管理员", 503);
      if (old?.until > now()) throw fail("LOCAL_RESULT_PROCESSING_BUSY", "完整结果正在校验，请保留原报告后稍后原样重报", 409);
      const value = { token, until: new Date(+now() + 120000), version: (old?.version || 0) + 1 };
      if (!old) await rows.insertOne({ _id: key, ...value }, { session });
      else if ((await rows.updateOne({ _id: key, version: old.version }, { $set: value }, { session })).modifiedCount !== 1) throw fail("LOCAL_RESULT_PROCESSING_BUSY", "结果校验繁忙，请只重报原报告", 409);
    });
    try { return await action(); }
    finally { await transaction(async session => { await (await table("capabilityLocalResultStorage")).updateOne({ _id: key, token }, { $set: { until: new Date(0) }, $unset: { token: "" } }, { session }); }); }
  }
  async function reserve(bindingId, bytes, files, session, reports = 0) {
    if (!bytes && !files && !reports) return;
    const quota = await table("capabilityLocalResultStorage");
    const current = await quota.findOne({ _id: bindingId }, { session });
    if (current && ["bytes", "files", "reports", "version"].some(key => !Number.isSafeInteger(current[key]) || current[key] < (key === "version" ? 1 : 0))) throw fail("LOCAL_RESULT_STORAGE_INVALID", "结果存储账本异常，不会自动重建或清空，请保留原证据", 503);
    const used = current?.bytes || 0, count = current?.files || 0;
    if (used + bytes > LOCAL_RESULT_STORAGE_BYTES || count + files > 64 || (current?.reports || 0) + reports > 64 || files && current?.reports >= 64) throw fail("LOCAL_RESULT_STORAGE_FULL", "本绑定完整结果存储预算已满，请保留原文件并等待受审处理；不能换号重传或删除原失败", 507);
    if (!current) await quota.insertOne({ _id: bindingId, bytes, files, reports, version: 1, createdAt: now(), updatedAt: now() }, { session });
    else {
      const updated = await quota.updateOne({ _id: bindingId, version: current.version }, { $inc: { bytes, files, reports, version: 1 }, $set: { updatedAt: now() } }, { session });
      if (updated.modifiedCount !== 1) throw fail("LOCAL_RESULT_RETRY_ORIGINAL", "结果存储正在登记，请保留原编号和原文件后重报", 409);
    }
  }
  async function accept(binding, descriptor, bytes, session) {
    const bindingId = String(binding._id), key = fileKey(binding, descriptor.upload_id), file = immutableFile(descriptor), fingerprint = sha(canonical(file));
    const files = await table("capabilityLocalResultFiles"), chunks = await table("capabilityLocalResultChunks");
    let saved = await files.findOne({ _id: key }, { session });
    if (saved && (saved.fingerprint !== fingerprint || saved.computeGroupId !== normalizeComputeGroupId(binding.computeGroupId))) throw fail("LOCAL_RESULT_CHUNK_CONFLICT", "原文件的节点、分组、请求或完整清单已固定，不可改变", 409);
    const chunkId = `${key}:${descriptor.chunk_index}`, old = await chunks.findOne({ _id: chunkId }, { session });
    if (old) {
      if (old.sha256 !== descriptor.chunk_sha256 || old.bytes !== bytes.length || old.contentBase64 !== bytes.toString("base64")) throw fail("LOCAL_RESULT_CHUNK_CONFLICT", "同一分块只允许原字节幂等重报，不能覆盖", 409);
      return true;
    }
    if (saved?.status === "sealed") throw fail("LOCAL_RESULT_CHUNK_CONFLICT", "原文件已封存，不能增加分块", 409);
    if (!saved) {
      await reserve(bindingId, descriptor.file_bytes, 1, session);
      saved = { _id: key, bindingId, nodeId: binding.nodeId, computeGroupId: normalizeComputeGroupId(binding.computeGroupId),
        descriptor: file, fingerprint, status: "receiving", createdAt: now() };
      await files.insertOne(saved, { session });
    }
    await chunks.insertOne({ _id: chunkId, fileId: key, bindingId, index: descriptor.chunk_index, offset: descriptor.chunk_offset,
      bytes: bytes.length, sha256: descriptor.chunk_sha256, contentBase64: bytes.toString("base64"), receivedAt: now() }, { session });
    return false;
  }
  async function read(binding, input, output) {
    const key = fileKey(binding, output.upload_id), saved = await (await table("capabilityLocalResultFiles")).findOne({ _id: key });
    const d = saved?.descriptor;
    if (!d || saved.fingerprint !== sha(canonical(d)) || !["receiving", "sealed"].includes(saved.status) || saved.bindingId !== String(binding._id) || saved.nodeId !== binding.nodeId || saved.computeGroupId !== normalizeComputeGroupId(binding.computeGroupId)
      || d.report_id !== input.report_id || d.local_request_id !== input.local_request_id || d.job_id !== input.local_direct_source.job_id
      || d.owner_sha256 !== input.local_direct_source.owner_sha256 || d.request_sha256 !== input.local_direct_source.request_sha256
      || d.capability_id !== input.capability_id || d.capability_version !== input.capability_version
      || d.file_sha256 !== output.sha256 || d.file_bytes !== output.bytes || ["artifact_id", "filename", "role", "content_type"].some(k => d[k] !== output[k])) {
      throw fail("LOCAL_RESULT_FILE_SCOPE_MISMATCH", "完整原文件不属于当前节点、分组、原请求或输出清单", 403);
    }
    const rows = await (await table("capabilityLocalResultChunks")).find({ fileId: key }).sort({ index: 1 }).toArray();
    const count = Math.ceil(output.bytes / LOCAL_RESULT_CHUNK_BYTES);
    if (rows.length !== count) throw fail("LOCAL_RESULT_FILE_INCOMPLETE", "原文件分块尚未完整，请只补传缺失的原分块，不重跑模型", 409);
    const digest = createHash("sha256"), buffers = []; let total = 0;
    for (let index = 0; index < count; index++) {
      const row = rows[index], bytes = Buffer.from(row.contentBase64, "base64");
      const expected = Math.min(LOCAL_RESULT_CHUNK_BYTES, output.bytes - index * LOCAL_RESULT_CHUNK_BYTES);
      if (row.bindingId !== String(binding._id) || row.index !== index || row.offset !== index * LOCAL_RESULT_CHUNK_BYTES
        || row.bytes !== expected || bytes.length !== expected || bytes.toString("base64") !== row.contentBase64 || sha(bytes) !== row.sha256) throw fail("LOCAL_RESULT_CHUNK_INVALID", "原文件分块的顺序、位置、长度或摘要不一致", 409);
      digest.update(bytes); total += bytes.length; buffers.push(bytes);
    }
    if (total !== output.bytes || digest.digest("hex") !== output.sha256) throw fail("LOCAL_RESULT_OUTPUT_HASH_MISMATCH", "完整重组文件的长度或 SHA-256 不一致");
    return Buffer.concat(buffers, total);
  }
  async function seal(binding, input, session) {
    for (const output of input.outputs.filter(o => o.upload_id)) {
      const descriptor = { upload_id: output.upload_id, report_id: input.report_id, local_request_id: input.local_request_id, job_id: input.local_direct_source.job_id,
        owner_sha256: input.local_direct_source.owner_sha256, request_sha256: input.local_direct_source.request_sha256,
        capability_id: input.capability_id, capability_version: input.capability_version, artifact_id: output.artifact_id, filename: output.filename,
        role: output.role, content_type: output.content_type, file_bytes: output.bytes, file_sha256: output.sha256 };
      const updated = await (await table("capabilityLocalResultFiles")).updateOne({ _id: fileKey(binding, output.upload_id), bindingId: String(binding._id),
        computeGroupId: normalizeComputeGroupId(binding.computeGroupId), fingerprint: sha(canonical(descriptor)), status: { $in: ["receiving", "sealed"] } },
        { $set: { status: "sealed", sealedAt: now(), reportId: input.report_id } }, { session });
      if (updated.matchedCount !== 1) throw fail("LOCAL_RESULT_FILE_SCOPE_MISMATCH", "原文件状态在封存前发生变化，请保留原证据后原样重报", 409);
    }
    const inline = input.outputs.filter(o => o.content_base64);
    await reserve(String(binding._id), inline.reduce((sum, o) => sum + o.bytes, 0), inline.length, session, 1);
  }
  return { accept, read, seal, validate };
}

export function registerLocalResultChunkRoute(app, { requireBinding, transaction, limited, store, roles, parseJson }) {
  app.post("/api/v1/capability-verifications/local-results/chunks", async c => {
    c.header("Cache-Control", "private, no-store");
    try {
      const auth = await requireBinding(c); if (auth.error) return auth.error;
      const binding = auth.binding;
      if (!binding?._id || binding.status !== "active" || binding.revokedAt) throw fail("BINDING_REQUIRED", "节点绑定已失效", 401);
      if (!(await limited(`local-result-chunks:${binding._id}`, { limit: 300, windowMs: 60000 })).allowed) throw fail("RATE_LIMITED", "分块上报过于频繁，请保留原文件后重报", 429);
      const encoded = c.req.header("X-Gulong-Result-Descriptor") || "";
      if (!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded)) throw fail("LOCAL_RESULT_CHUNK_INVALID", "请提供规范的结果分块清单");
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") !== encoded) throw fail("LOCAL_RESULT_CHUNK_INVALID", "结果分块清单编码不正确");
      let d; try { d = localChunkSchema.parse(parseJson(decoded)); } catch { throw fail("LOCAL_RESULT_CHUNK_INVALID", "结果分块清单字段不正确"); }
      if (!roles[d.capability_id]?.includes(d.role) || !LOCAL_RESULT_OUTPUT_TYPES[d.role]?.includes(d.content_type)
        || d.chunk_offset !== d.chunk_index * LOCAL_RESULT_CHUNK_BYTES || d.chunk_offset >= d.file_bytes
        || d.chunk_bytes !== Math.min(LOCAL_RESULT_CHUNK_BYTES, d.file_bytes - d.chunk_offset)) throw fail("LOCAL_RESULT_CHUNK_INVALID", "分块能力、角色、位置或完整长度不正确");
      if ((c.req.header("content-type") || "").toLowerCase() !== "application/octet-stream") throw fail("LOCAL_RESULT_CHUNK_INVALID", "分块必须使用 application/octet-stream 原始字节");
      const reader = c.req.raw.body?.getReader(); if (!reader) throw fail("LOCAL_RESULT_CHUNK_INVALID", "分块原始字节不能为空");
      const parts = []; let length = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length;
        if (length > d.chunk_bytes) { await reader.cancel(); throw fail("LOCAL_RESULT_CHUNK_TOO_LARGE", "分块超出声明长度，未保存", 413); } parts.push(Buffer.from(part.value)); }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(parts, length);
      if (length !== d.chunk_bytes || sha(bytes) !== d.chunk_sha256) throw fail("LOCAL_RESULT_CHUNK_INVALID", "分块完整长度或 SHA-256 不一致，未保存");
      const repeated = await transaction(session => store.accept(binding, d, bytes, session));
      return c.json({ ok: true, upload_id: d.upload_id, chunk_index: d.chunk_index, received_bytes: bytes.length, idempotent: repeated,
        status: "stored-unreviewed", verified: false, grants_admission: false, task_dispatched: false }, repeated ? 200 : 201);
    } catch (error) {
      if (error.code === 11000) return c.json({ code: "LOCAL_RESULT_RETRY_ORIGINAL", message: "原分块正在登记，请只重报原分块" }, 409);
      return c.json({ code: error.status ? error.code : "LOCAL_RESULT_UNAVAILABLE", message: error.status ? error.message : "分块暂时无法保存，请保留原文件" }, error.status || 503);
    }
  });
  app.openAPIRegistry?.registerPath({ method: "post", path: "/api/v1/capability-verifications/local-results/chunks", tags: ["Local Result Intake"], security: [{ accountBinding: [] }],
    summary: "只写完整原结果分块；不创建任务、不授准入",
    description: "X-Gulong-Result-Descriptor 为文档严格清单的无填充base64url JSON；body为application/octet-stream原字节，每块1MiB（末块按剩余），单文件64MiB，本绑定全部结果存储128MiB/64文件固定总预算，不自动删除/换窗口重置。原binding/job/request/report/能力/wholefile长度SHA及chunk index/offset/长度SHA绑定；重复chunk只可同字节。完成后仅POST原local-results报告触发完整重组校验，无GET资源查询，无模型调用。详见docs/local-node-results.md。",
    request: { headers: z.object({ "X-Gulong-Result-Descriptor": z.string().max(8192) }), body: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } } },
    responses: { 201: { description: "原分块已私有保存，无准入" }, 200: { description: "同字节幂等分块" }, 400: { description: "清单或原字节无效" }, 401: { description: "绑定无效" }, 403: { description: "身份不符" }, 409: { description: "原分块冲突" }, 413: { description: "原分块超限" }, 429: { description: "收件限流" }, 503: { description: "存储失败" }, 507: { description: "固定完整证据预算已满；保留原件" } } });
}
