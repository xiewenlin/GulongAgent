import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { createCapabilitySlotCoordinator } from "./capability-slots.js";
import { normalizeGpuLoadReport } from "./shared-node-scheduler.js";
import { computeGroupsMatch } from "./compute-groups.js";
import { realtimeProviderFingerprint } from "./digital-live-realtime.js";
import { createDigitalLiveMediaRelay } from "./digital-live-media-relay.js";
import { WHISPER_AUDIO_FIXTURE, CAPABILITY_PROBE_FIXTURES } from "./capability-probe-fixtures.js";
import { createProbeFixtureIssuer } from "./capability-probe-inputs.js";

export const DIGITAL_LIVE_VERIFICATION_VERSION = "digital-live-candidate-verification-v1";
const RECORDS = "digitalLiveRealtimeVerifications", MEDIA = "digitalLiveRealtimeVerificationMedia";
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/, SECRET = /^[A-Za-z0-9_-]{43}$/, HASH = /^[a-f0-9]{64}$/;
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const unwrap = (value) => value && Object.hasOwn(value, "value") ? value.value : value;
const requestSchema = z.object({ request_id: z.string().regex(KEY), lease_token: z.string().regex(SECRET), provider_sha256: z.string().regex(HASH),
  mode: z.enum(["media", "asr"]), dry_run: z.boolean().default(false) }).strict();
const resultSchema = z.object({ actual_provider_sha256: z.string().regex(HASH), completed_turns: z.number().int().min(0).max(10),
  played_sequences: z.array(z.number().int().min(1).max(10)).max(10).default([]), ended: z.boolean().default(false),
  interrupt: z.object({ before_generation: z.number().int().positive(), after_generation: z.number().int().positive(), stopped_ms: z.number().min(0).max(60000) }).strict().optional(),
  asr: z.object({ fixture_sha256: z.string().regex(HASH), transcript: z.string().max(4000) }).strict().optional(),
}).strict();
export const digitalLiveVerificationSchemas = Object.freeze({ next: z.union([requestSchema, z.object({ dry_run: z.literal(true) }).strict()]), result: resultSchema });
function demand(value, code, message, status = 409) { if (!value) throw Object.assign(new Error(message), { code, status }); }

/** Server observations are distinct from authenticated but untrusted claims.
 * A media hash, frontend ACK claim or a correct transcript is insufficient to
 * prove neural rendering/playback. Never manufacture an active model proof. */
export function validateDigitalLiveCandidateEvidence({ record, claims, observed }) {
  if (claims.actual_provider_sha256 !== record.providerSha256) return { state: "failed", code: "REALTIME_PROVIDER_MISMATCH" };
  if (record.mode === "asr") {
    if (claims.asr?.fixture_sha256 !== WHISPER_AUDIO_FIXTURE.sha256
      || !/my fellow americans/i.test(claims.asr?.transcript || "")
      || !/ask not what your country can do for you/i.test(claims.asr?.transcript || "")
      || !/ask what you can do for your country/i.test(claims.asr?.transcript || "") || claims.completed_turns !== 1) {
      return { state: "failed", code: "REALTIME_ASR_FIXTURE_MISMATCH" };
    }
  } else if (observed.length !== 10 || observed.some((item) => item.state !== "received" || item.source !== "gateway_stream"
    || !HASH.test(item.sha256 || "") || !(item.bytes > 0)) || claims.completed_turns !== 10) {
    return { state: "awaiting_runtime_witness", code: "REALTIME_STREAM_WITNESS_REQUIRED" };
  }
  if (record.mode === "media" && (!claims.ended || claims.played_sequences.join(",") !== "1,2,3,4,5,6,7,8,9,10"
    || !claims.interrupt || claims.interrupt.after_generation <= claims.interrupt.before_generation || claims.interrupt.stopped_ms > 5000)) {
    return { state: "failed", code: "REALTIME_CONTROL_WITNESS_INVALID" };
  }
  // The node runtime/independent playback witness integration is not delivered
  // yet. Even plausible real wire bytes are never converted to admission.
  return { state: "adapter_required", code: "REALTIME_NEURAL_AND_PLAYBACK_VALIDATOR_REQUIRED" };
}

export function createDigitalLiveCandidateVerification({ getCollection, now = () => new Date(),
  slots = createCapabilitySlotCoordinator({ getCollection }), issueInputs = createProbeFixtureIssuer({ fixtures: CAPABILITY_PROBE_FIXTURES }),
  validator = validateDigitalLiveCandidateEvidence } = {}) {
  const clock = () => new Date(now()), collection = (name) => getCollection(name);
  const identity = (r) => ({ bindingId: r.bindingId, nodeId: r.nodeId, userId: r.userId, capabilityId: "digital_live.realtime_verification", claimId: r.id, taskId: r.id });
  async function lock(key, record) {
    const table = await collection("capabilityVerificationLeases");
    try { await table.updateOne({ _id: key }, { $setOnInsert: { leaseUntil: new Date(0) } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    return Boolean(unwrap(await table.findOneAndUpdate({ _id: key, leaseUntil: { $lte: clock() } }, { $set: {
      challengeId: record.id, bindingId: record.bindingId, leaseUntil: record.leaseExpiresAt } }, { returnDocument: "after" })));
  }
  async function release(record) {
    await slots.release({ ...identity(record), now: clock() });
    await (await collection("capabilityVerificationLeases")).updateMany({ challengeId: record.id, bindingId: record.bindingId },
      { $set: { leaseUntil: clock() } });
  }
  async function owned(binding, id, secret, { expired = false } = {}) {
    const record = await (await collection(RECORDS)).findOne({ id, bindingId: String(binding._id), nodeId: binding.nodeId, userId: String(binding.userId) });
    demand(record, "REALTIME_VERIFICATION_NOT_FOUND", "当前节点没有该实时验收请求", 404);
    demand(SECRET.test(secret || "") && sha(secret) === record.leaseTokenHash, "REALTIME_VERIFICATION_LEASE_INVALID", "实时验收租约无效", 401);
    demand(computeGroupsMatch(record.computeGroupId, binding.computeGroupId), "COMPUTE_GROUP_MISMATCH", "验收节点分组已变化", 403);
    const live = await (await collection("nodeAccountBindings")).findOne({ _id: binding._id, status: "active", revokedAt: null, tokenHash: binding.tokenHash });
    demand(live && live.nodeId === record.nodeId && String(live.userId) === record.userId && computeGroupsMatch(live.computeGroupId, record.computeGroupId)
      && await (await collection("users")).findOne({ _id: binding.userId, status: "active" }),
      "REALTIME_VERIFICATION_BINDING_CHANGED", "验收账号或绑定已变化，请停止本次owned worker", 403);
    if (!expired) {
      demand(record.leaseExpiresAt > clock() && !record.stoppedAt, "REALTIME_VERIFICATION_EXPIRED", "实时验收已过期或停止，禁止重跑或继续上传");
      const snapshot = await slots.snapshot({ bindingId: record.bindingId, now: clock() });
      demand(snapshot.available && snapshot.leases.some((item) => item.taskId === record.id && item.claimId === record.id && item.exclusive),
        "REALTIME_VERIFICATION_EXPIRED", "原实时验收物理租约已失效");
    }
    return record;
  }
  async function view(record, binding, { withInputs = false } = {}) {
    const media = await (await collection(MEDIA)).find({ challengeId: record.id }).sort({ sequence: 1 }).limit(10).toArray();
    return { protocol: DIGITAL_LIVE_VERIFICATION_VERSION, id: record.id, request_id: record.requestId, state: record.state,
      mode: record.mode, activated: false, dispatchable: false, providers: record.providers, provider_sha256: record.providerSha256,
      lease_expires_at: record.leaseExpiresAt, lease_valid: record.state === "issued" && record.leaseExpiresAt > clock() && !record.stoppedAt,
      owned_worker_stopped: Boolean(record.stoppedAt),
      budget: { max_model_inferences: record.mode === "media" ? 10 : 1, max_turns: record.mode === "media" ? 10 : 1,
        max_total_audio_seconds: record.mode === "media" ? 60 : 12, max_output_tokens_per_turn: 32, max_media_bytes: 16 * 1024 * 1024 },
      probe: record.mode === "media" ? { turns: record.turns, interrupt_after_turn: 5, expected_model: record.providers.text_model,
        context_tokens: 8192, media_transport: "http-fmp4-mse-v1", required_independent_playback_witness: true }
        : { task: "transcribe", expected_model: record.providers.asr_model, full_source_required: true,
          inputs: withInputs && record.state === "issued" && record.leaseExpiresAt > clock()
            ? await issueInputs({ binding, challenge: { bindingId: record.bindingId, nodeId: record.nodeId, probeInputs: [WHISPER_AUDIO_FIXTURE], leaseExpiresAt: record.leaseExpiresAt } }) : [] },
      media: media.map(({ sequence, state, bytes, sha256 }) => ({ sequence, state, bytes: bytes || null, sha256: sha256 || null })),
      reason_code: record.reasonCode || null };
  }
  async function budget(name, id, maximum) {
    const table = await collection(name);
    try { await table.updateOne({ _id: id }, { $setOnInsert: { count: 0, createdAt: clock() } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    return Boolean(unwrap(await table.findOneAndUpdate({ _id: id, count: { $lt: maximum } }, { $inc: { count: 1 }, $set: { updatedAt: clock() } }, { returnDocument: "after" })));
  }
  async function next(binding, raw) {
    if (raw?.dry_run === true) return { ok: true, queue: "reachable", challenge: null, activated: false };
    const parsed = requestSchema.safeParse(raw);
    demand(parsed.success, "REALTIME_VERIFICATION_REQUEST_INVALID", "请先持久保存原验收请求编号、随机租约和真实provider摘要", 400);
    const body = parsed.data, table = await collection(RECORDS), requestId = sha(`${binding._id}:${body.request_id}`);
    const old = await table.findOne({ _id: requestId });
    if (old) {
      const record = await owned(binding, old.id, body.lease_token, { expired: true });
      demand(record.providerSha256 === body.provider_sha256 && record.mode === body.mode, "REALTIME_VERIFICATION_IDEMPOTENCY_CONFLICT", "原验收请求已对应其他模型或模式");
      return { ok: true, idempotent: true, challenge: await view(record, binding, { withInputs: true }) };
    }
    const node = await (await collection("digitalLiveRealtimeNodes")).findOne({ _id: String(binding._id), sharingOptIn: true,
      reportedAt: { $gte: new Date(+clock() - 30_000) } });
    demand(node && node.nodeId === binding.nodeId && node.executorUserId === String(binding.userId)
      && computeGroupsMatch(node.computeGroupId, binding.computeGroupId), "REALTIME_VERIFICATION_INVENTORY_REQUIRED", "请先上报当前节点真实且选择共享的实时库存");
    const provider = node.providers.find((item) => realtimeProviderFingerprint(item) === body.provider_sha256);
    demand(provider && (body.mode !== "asr" || provider.asr_model), "REALTIME_VERIFICATION_PROVIDER_REQUIRED", "当前节点没有该精确实时或ASR组合");
    const load = normalizeGpuLoadReport(node.resources, clock()), snapshot = await slots.snapshot({ bindingId: binding._id, now: clock() });
    const h3 = await (await collection("h3SharedTasks")).findOne({ status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $gt: clock() },
      $or: [{ "claimedByNode.bindingId": binding._id }, { "assignedNode.bindingId": binding._id }] });
    demand(!h3 && snapshot.available && !snapshot.activeCount && load.gpu_state === "idle" && load.current_task_remaining_seconds === 0
      && node.resources.running_task_count === 0, "REALTIME_VERIFICATION_NODE_BUSY", "节点不是新鲜明确空闲状态，不能抢占现有任务");
    const id = `dlv_${randomUUID()}`, nonce = randomBytes(8).toString("hex"), instant = clock();
    const record = { _id: requestId, id, requestId: body.request_id, bindingId: String(binding._id), nodeId: binding.nodeId,
      userId: String(binding.userId), computeGroupId: node.computeGroupId, mode: body.mode, providerSha256: body.provider_sha256,
      providers: provider, artifactSha256: node.artifactSha256, leaseTokenHash: sha(body.lease_token), state: "preparing", revision: 0,
      turns: Array.from({ length: 10 }, (_, i) => ({ turn_id: `probe-${nonce}-${i + 1}`, prompt: `Reply only: Verification ${nonce} turn ${i + 1}.`, expected_text: `Verification ${nonce} turn ${i + 1}.` })),
      leaseExpiresAt: new Date(+instant + 15 * 60_000), purgeAt: new Date(+instant + 7 * 86400_000), createdAt: instant, updatedAt: instant };
    try { await table.insertOne(record); } catch (error) { if (error.code !== 11000) throw error; return next(binding, raw); }
    try {
      const day = instant.toISOString().slice(0, 10), budgetId = `${binding._id}:${day}`;
      demand(await budget("digitalLiveRealtimeVerificationBudgets", budgetId, 2) && await budget("capabilityVerificationBudgets", budgetId, 16),
        "REALTIME_VERIFICATION_BUDGET_EXHAUSTED", "实时验收每日最多两次，并受节点总验收预算限制", 429);
      demand(await lock(`binding:${binding._id}`, record), "REALTIME_VERIFICATION_NODE_BUSY", "节点已有自动验收请求");
      let globalLocked = false;
      for (let i = 0; i < 4; i += 1) if (await lock(`global:${i}`, record)) { globalLocked = true; break; }
      demand(globalLocked, "REALTIME_VERIFICATION_GLOBAL_BUSY", "全站自动验收并发已满，请保留原请求稍后查询", 429);
      demand(await slots.reserve({ ...identity(record), exclusive: true, maxConcurrentTasks: 1, capabilityMaxConcurrent: 1,
        estimatedSeconds: 900, expiresAt: record.leaseExpiresAt, now: instant }), "REALTIME_VERIFICATION_NODE_BUSY", "节点已被其他任务预约");
      await table.updateOne({ _id: record._id, state: "preparing" }, { $set: { state: "issued", updatedAt: clock() } });
      return { ok: true, idempotent: false, challenge: await view({ ...record, state: "issued" }, binding, { withInputs: true }) };
    } catch (error) {
      await table.updateOne({ _id: record._id }, { $set: { state: "failed", reasonCode: error.code || "REALTIME_VERIFICATION_UNAVAILABLE", updatedAt: clock() } });
      await release(record); throw error;
    }
  }
  async function get(binding, id, secret) { return view(await owned(binding, id, secret, { expired: true }), binding, { withInputs: true }); }
  async function byRequest(binding, key, secret) {
    demand(KEY.test(key), "REALTIME_VERIFICATION_REQUEST_INVALID", "验收请求编号格式不正确", 400);
    const r = await (await collection(RECORDS)).findOne({ _id: sha(`${binding._id}:${key}`), bindingId: String(binding._id) });
    demand(r, "REALTIME_VERIFICATION_NOT_FOUND", "原实时验收请求不存在", 404); return get(binding, r.id, secret);
  }
  async function collect(binding, id, secret, sequence, stream, contentType) {
    const record = await owned(binding, id, secret);
    demand(record.state === "issued" && record.mode === "media" && Number.isInteger(sequence) && sequence >= 1 && sequence <= 10,
      "REALTIME_VERIFICATION_MEDIA_INVALID", "只能上传本次固定十轮验收的原媒体编号", 400);
    demand(contentType === record.providers.mime_type, "REALTIME_VERIFICATION_MEDIA_INVALID", "原验收媒体MIME不匹配", 400);
    const table = await collection(MEDIA), key = `${id}:${sequence}`, existing = await table.findOne({ _id: key });
    demand(!existing, "REALTIME_VERIFICATION_MEDIA_UNCERTAIN", "原媒体已收取或状态不确定，请查询原验收，不要重复上传或重跑模型");
    try { await table.insertOne({ _id: key, challengeId: id, sequence, state: "receiving", source: "gateway_stream", createdAt: clock(), purgeAt: record.purgeAt }); }
    catch (error) { if (error.code !== 11000) throw error; demand(false, "REALTIME_VERIFICATION_MEDIA_UNCERTAIN", "原媒体正在收取，请查询原验收"); }
    const relay = createDigitalLiveMediaRelay({ maxStreams: 1, onSent: async (_, __, ___, metadata) => {
      await table.updateOne({ _id: key, state: "receiving" }, { $set: { ...metadata, state: "received", receivedAt: clock() } });
    } });
    const permit = { sessionId: id, generation: 1, sequence, mimeType: record.providers.mime_type,
      validate: () => owned(binding, id, secret) };
    const reader = relay.open(permit).getReader();
    const draining = (async () => { try { while (!(await reader.read()).done) { /* discard, never retain full media */ } } finally { reader.releaseLock(); } })();
    try { const result = await relay.write(permit, stream); await draining; return result; }
    catch (error) { await draining.catch(() => {}); await table.updateOne({ _id: key }, { $set: { state: "failed", updatedAt: clock() } }); throw error; }
  }
  async function submit(binding, id, secret, raw) {
    const record = await owned(binding, id, secret), parsed = resultSchema.safeParse(raw);
    demand(parsed.success, "REALTIME_VERIFICATION_RESULT_INVALID", "验收结果必须是有界模型、播放、打断和ASR声明，不能包含路径或原始媒体", 400);
    const claimsHash = sha(parsed.data), table = await collection(RECORDS);
    if (record.claimsHash) { demand(record.claimsHash === claimsHash, "REALTIME_VERIFICATION_IDEMPOTENCY_CONFLICT", "原验收结果已对应其他内容"); return get(binding, id, secret); }
    const observed = await (await collection(MEDIA)).find({ challengeId: id }).sort({ sequence: 1 }).limit(10).toArray();
    const result = await validator({ record, claims: parsed.data, observed });
    // Even injected validators cannot activate production from this candidate
    // endpoint. Real neural + playback witness ownership is a separate gate.
    const state = ["failed", "awaiting_runtime_witness", "adapter_required"].includes(result.state) ? result.state : "adapter_required";
    const saved = await table.updateOne({ _id: record._id, claimsHash: { $exists: false } }, { $set: {
      state, claims: parsed.data, claimsHash, reasonCode: result.code || "REALTIME_VALIDATOR_REQUIRED", updatedAt: clock() } });
    demand(saved.modifiedCount === 1, "REALTIME_VERIFICATION_STATE_CONFLICT", "验收结果已更新，请查询原请求");
    return get(binding, id, secret);
  }
  async function stopped(binding, id, secret, body) {
    const record = await owned(binding, id, secret, { expired: true });
    demand(body?.owned_worker_stopped === true, "REALTIME_VERIFICATION_STOP_REQUIRED", "必须先确认本次owned worker已真实结束");
    const pending = await (await collection(MEDIA)).findOne({ challengeId: id, state: "receiving" });
    demand(!pending || record.leaseExpiresAt <= clock(), "REALTIME_VERIFICATION_TRANSFER_ACTIVE", "原验收仍在传输，不能释放物理租约");
    if (pending) await (await collection(MEDIA)).updateMany({ challengeId: id, state: "receiving" }, { $set: { state: "failed_expired", updatedAt: clock() } });
    await release(record);
    await (await collection(RECORDS)).updateOne({ _id: record._id }, { $set: { stoppedAt: clock(), updatedAt: clock() } });
    return get(binding, id, secret);
  }
  return { next, get, byRequest, collect, submit, stopped };
}
