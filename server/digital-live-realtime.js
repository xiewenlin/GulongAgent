import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { readGulongEngineEntitlement } from "./english-coach-products.js";
import { getUserComputeGroupId, computeGroupsMatch } from "./compute-groups.js";
import { createCapabilitySlotCoordinator } from "./capability-slots.js";
import { normalizeGpuLoadReport } from "./shared-node-scheduler.js";
import { DIGITAL_LIVE_TEXT_MODEL } from "./digital-live-product.js";

export const DIGITAL_LIVE_REALTIME_ROOT = "/api/v1/digital-live/realtime";
export const DIGITAL_LIVE_REALTIME_VERSION = "digital-live-realtime-v1";
export const DIGITAL_LIVE_MEDIA_TRANSPORT = "http-fmp4-mse-v1";
export const DIGITAL_LIVE_GATEWAY_ORIGIN = "https://111.229.70.235";
export const DIGITAL_LIVE_REALTIME_ACCEPTANCE = "adapter_required";
const SESSIONS = "digitalLiveRealtimeSessions", NODES = "digitalLiveRealtimeNodes", TICKETS = "digitalLiveRealtimeTickets";
const LEASE_MS = 15_000, MAX_SESSION_MS = 30 * 60_000;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,119}$/;
const HASH = /^[a-f0-9]{64}$/;
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const freshSecret = () => randomBytes(32).toString("base64url");
const group = (value) => value == null || value === "" ? null : String(value);
const unwrap = (value) => value && Object.hasOwn(value, "value") ? value.value : value;
const terminal = (value) => ["cancelled", "expired", "failed"].includes(value);
function demand(condition, code, message, status = 409) { if (!condition) throw Object.assign(new Error(message), { code, status }); }
const providerSchema = z.object({
  text_model: z.literal(DIGITAL_LIVE_TEXT_MODEL), tts_model: z.string().regex(ID), avatar_model: z.string().regex(ID),
  character_id: z.string().regex(/^[\p{L}\p{N}_. -]{1,80}$/u).refine((value) => value.trim() === value), voice_id: z.string().regex(ID),
  character_image_sha256: z.string().regex(HASH), voice_audio_sha256: z.string().regex(HASH),
  asr_model: z.string().regex(ID).optional(),
  mime_type: z.string().max(120).regex(/^video\/mp4; codecs="avc1\.[A-Fa-f0-9]{6}, ?mp4a\.40\.2"$/),
}).strict();
const startSchema = z.object({ client_product: z.literal("digital_live"), client_request_id: z.string().regex(KEY),
  providers: providerSchema }).strict();
const turnSchema = z.object({ generation: z.number().int().positive(), request_id: z.string().regex(KEY), turn_id: z.string().regex(KEY),
  user_text: z.string().min(1).max(4000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }).strict()).max(16).default([]),
}).strict();
const asrSchema = turnSchema.omit({ user_text: true }).extend({ utterance_id: z.string().regex(KEY) });
export const DIGITAL_LIVE_PCM_MIME = "audio/pcm; rate=16000; channels=1; format=s16le";
const reportSchema = z.object({ capability_version: z.literal(DIGITAL_LIVE_REALTIME_VERSION),
  transport: z.literal(DIGITAL_LIVE_MEDIA_TRANSPORT), artifact_sha256: z.string().regex(HASH),
  providers: z.array(providerSchema).min(1).max(36), sharing_opt_in: z.boolean(), resources: z.record(z.string(), z.unknown()),
}).strict();
export const digitalLiveRealtimeSchemas = Object.freeze({ providers: providerSchema, create: startSchema, report: reportSchema, turn: turnSchema, asr: asrSchema });
export const realtimeProviderFingerprint = (provider) => digest(providerSchema.parse(provider));
const origins = new Set(["https://www.sologle.com", "https://sologle.com", DIGITAL_LIVE_GATEWAY_ORIGIN, "tauri://localhost", "http://tauri.localhost"]);
export function realtimeSessionId(ownerId, requestKey) { return `dls_${digest(`digital_live:${ownerId}:${requestKey}`).slice(0, 40)}`; }
export function realtimeConfig() {
  return { schema_version: DIGITAL_LIVE_REALTIME_VERSION, product: "digital_live", status: "integration_required", dispatchable: false,
    acceptance: DIGITAL_LIVE_REALTIME_ACCEPTANCE, transport: DIGITAL_LIVE_MEDIA_TRANSPORT, gateway_origin: DIGITAL_LIVE_GATEWAY_ORIGIN,
    create_url: `${DIGITAL_LIVE_REALTIME_ROOT}/sessions`, node_report_url: `${DIGITAL_LIVE_REALTIME_ROOT}/nodes/report`,
    catalog_url: `${DIGITAL_LIVE_REALTIME_ROOT}/providers`,
    media_credentials: "one_use_30_second_header_ticket", worker_lease_seconds: 15, client_heartbeat_seconds: 5,
    max_session_seconds: 1800, max_pending_sentences: 3, billing: { price_fen: 0, wallet_charge: false, commission: false },
    remote_asr: { status: "integration_required", dispatchable: false, status_values: ["integration_required", "available"],
      availability_source: "authenticated_exact_provider_catalog", create_path: "/sessions/{id}/asr/utterances", input_transport: "bounded-pcm16-mono-16k-v1",
      max_utterance_seconds: 20, max_input_bytes: 640000, content_type: DIGITAL_LIVE_PCM_MIME, persistence: "digest_only_no_audio", requires_separate_real_asr_proof: true },
    reason: "会话控制与有界媒体网关已实现；连续实时节点验证器及真实节点尚未验收，暂不开放派发" };
}

/** This service never turns inventory into approval. The production lookup is
 * deliberately absent until a real streaming verifier/consumer is delivered.
 * Async nine-capability proofs are not realtime proofs and cannot be reused. */
export function createDigitalLiveRealtimeService({ getCollection = databaseCollection, now = () => new Date(),
  readEntitlement = (id, instant) => readGulongEngineEntitlement(id, instant, getCollection),
  isOwnerActive = async (id) => ObjectId.isValid(id) && Boolean(await (await getCollection("users")).findOne({ _id: new ObjectId(id), status: "active" })),
  readGroup = (id) => getUserComputeGroupId(id, getCollection), slots = createCapabilitySlotCoordinator({ getCollection }),
  lookupRealtimeProof = async () => null, onInvalidate = () => {}, gatewayOrigin = DIGITAL_LIVE_GATEWAY_ORIGIN } = {}) {
  const collection = (name) => getCollection(name);
  const clock = () => new Date(now());
  const fence = (s) => ({ bindingId: s.bindingId, nodeId: s.nodeId, userId: s.executorUserId,
    capabilityId: "digital_live.realtime", claimId: s._id, taskId: s._id });
  const providerHash = realtimeProviderFingerprint;
  async function entitled(ownerId) {
    const e = await readEntitlement(ownerId, clock());
    demand(await isOwnerActive(ownerId) && e?.active === true && e.capabilities?.includes("digital_live.use"), "DIGITAL_LIVE_SUBSCRIPTION_REQUIRED", "数字直播需要有效账号及古龙引擎包月权益", 403);
  }
  async function proofFor(node, provider) {
    const proof = await lookupRealtimeProof(node, provider, clock());
    return proof?.source === "automatic" && proof.status === "active"
      && proof.capabilityId === "digital_live.realtime" && proof.capabilityVersion === DIGITAL_LIVE_REALTIME_VERSION
      && proof.artifactSha256 === node.artifactSha256 && proof.providerSha256 === providerHash(provider)
      && proof.bindingId === node.bindingId && proof.nodeId === node.nodeId && proof.userId === node.executorUserId
      && computeGroupsMatch(proof.computeGroupId, node.computeGroupId) && HASH.test(proof.testEvidenceSha256 || "")
      && new Date(proof.testedAt) <= clock() && new Date(proof.expiresAt) > clock()
      && new Date(proof.expiresAt) - new Date(proof.testedAt) <= 7 * 86400_000
      && ["actual_provider", "continuous_fmp4", "played_drain", "interrupt_generation", "exclusive_gpu"].every((key) => proof.contractTests?.[key] === true)
      && (!provider.asr_model || proof.contractTests?.realtime_asr === true)
      ? proof : null;
  }
  async function liveBinding(s) {
    const b = await (await collection("nodeAccountBindings")).findOne({ _id: s.bindingObjectId, status: "active", revokedAt: null });
    demand(b && b.nodeId === s.nodeId && String(b.userId) === s.executorUserId && computeGroupsMatch(b.computeGroupId, s.computeGroupId)
      && await isOwnerActive(s.executorUserId),
      "REALTIME_NODE_UNAVAILABLE", "实时节点绑定或分组已变化，请结束本会话", 409);
    return b;
  }
  async function currentNodePermit(s) {
    await liveBinding(s);
    const node = await (await collection(NODES)).findOne({ _id: s.bindingId });
    demand(node?.sharingOptIn === true && node.artifactSha256 === s.artifactSha256 && await proofFor(node, s.providers),
      "REALTIME_INTEGRATION_REQUIRED", "实时模型证明或共享授权已变化，请停止本会话", 503);
    const snapshot = await slots.snapshot({ bindingId: s.bindingId, now: clock() });
    demand(snapshot.available && snapshot.leases.some((lease) => lease.claimId === s._id && lease.taskId === s._id && lease.exclusive === true),
      "REALTIME_LEASE_EXPIRED", "实时物理执行租约已失效，请停止本会话");
  }
  async function patch(s, values) {
    const saved = unwrap(await (await collection(SESSIONS)).findOneAndUpdate({ _id: s._id, revision: s.revision },
      { $set: { ...values, updatedAt: clock() }, $inc: { revision: 1 } }, { returnDocument: "after" }));
    demand(saved, "REALTIME_STATE_CONFLICT", "会话状态已更新，请按原会话查询后重试");
    return saved;
  }
  async function invalidate(s, reason, status = "cancelling") {
    if (terminal(s.state) || s.state === "cancelling") return s;
    const saved = await patch(s, { state: status, generation: s.generation + 1, queue: [], cancelReason: reason, nodeFinished: false });
    onInvalidate(saved._id);
    // Do not release an active GPU lease on a client cancellation ACK. Only
    // the fenced worker's stopped ACK, or natural lease expiry, releases it.
    return saved;
  }
  async function read(id) {
    let s = await (await collection(SESSIONS)).findOne({ _id: id, clientProduct: "digital_live" });
    demand(s, "REALTIME_SESSION_NOT_FOUND", "实时会话不存在", 404);
    if (!terminal(s.state) && (new Date(s.expiresAt) <= clock() || new Date(s.workerLeaseUntil) <= clock()
      || new Date(s.clientSeenAt) < new Date(+clock() - LEASE_MS))) s = await invalidate(s, "lease_expired", "expired");
    return s;
  }
  async function owned(ownerId, id, { allowTerminal = false } = {}) {
    // Check owner before read() can expire/mutate a session belonging to another account.
    demand(await (await collection(SESSIONS)).findOne({ _id: id, ownerId: String(ownerId), clientProduct: "digital_live" }),
      "REALTIME_SESSION_NOT_FOUND", "实时会话不存在", 404);
    let s = await read(id);
    try {
      await entitled(ownerId);
      demand(computeGroupsMatch(await readGroup(ownerId), s.computeGroupId), "COMPUTE_GROUP_MISMATCH", "用户算力分组已变化，请结束本会话", 403);
    } catch (error) {
      s = await invalidate(s, "authorization_changed");
      if (!allowTerminal) throw error;
    }
    if (!allowTerminal) demand(!terminal(s.state) && s.state !== "cancelling", "REALTIME_SESSION_ENDED", "实时会话已结束，请查询原会话状态");
    return s;
  }
  function view(s) {
    return { id: s._id, client_product: "digital_live", client_request_id: s.clientRequestId, state: s.state, generation: s.generation,
      transport: DIGITAL_LIVE_MEDIA_TRANSPORT, gateway_origin: gatewayOrigin, providers: s.providers || null,
      worker_lease_expires_at: s.workerLeaseUntil, expires_at: s.expiresAt,
      pending_sentences: s.queue?.length || 0, next_sequence: (s.lastSequence || 0) + 1,
      played_sequence: s.playedSequence || 0, drained: s.nodeFinished === true && !s.queue?.length && s.state === "idle",
      media_generation: s.mediaGeneration || 0, event_cursor: s.eventCursor || 0,
      active_turn: s.activeTurn ? { turn_id: s.activeTurn.turn_id, request_id: s.activeTurn.request_id, media_generation: s.activeTurn.media_generation,
        state: s.activeTurn.state, text_snapshot: s.activeTurn.assistant_text || "", context_tokens: 8192 } : null,
      active_asr: s.activeAsr ? { utterance_id: s.activeAsr.utterance_id, request_id: s.activeAsr.request_id, turn_id: s.activeAsr.turn_id,
        state: s.activeAsr.state, reader_ready: Boolean(s.activeAsr.readerReadyAt), partial_text: s.activeAsr.partial_text || "",
        final_text: s.activeAsr.final_text || "", input_received: Boolean(s.activeAsr.input), input_sha256: s.activeAsr.input?.sha256 || null,
        input_bytes: s.activeAsr.input?.bytes || null, generation: s.activeAsr.generation, media_generation: s.activeAsr.media_generation || null,
        event_cursor_start: s.activeAsr.turnEventCursor || s.activeAsr.startEventCursor, model: s.providers.asr_model } : null,
      cancellation_pending: s.state === "cancelling", cancel_reason: s.cancelReason || null,
      billing: { price_fen: 0, charge_status: "exempt", commission_fen: 0 } };
  }
  async function report(binding, raw) {
    const p = reportSchema.safeParse(raw);
    demand(p.success, "REALTIME_REPORT_INVALID", "实时节点清单格式不正确；请上报精确模型、音色、角色、版本和制品摘要", 400);
    const body = p.data, resources = normalizeGpuLoadReport(body.resources, clock());
    demand(Number.isSafeInteger(body.resources.running_task_count) && body.resources.running_task_count >= 0,
      "REALTIME_REPORT_INVALID", "请上报实际运行任务数", 400);
    const providers = body.providers.map((provider) => providerSchema.parse(provider));
    demand(new Set(providers.map(providerHash)).size === providers.length, "REALTIME_REPORT_INVALID", "实时模型与角色组合不能重复", 400);
    await (await collection(NODES)).updateOne({ _id: String(binding._id) }, { $set: {
      bindingId: String(binding._id), bindingObjectId: binding._id, nodeId: binding.nodeId, executorUserId: String(binding.userId),
      computeGroupId: group(binding.computeGroupId), capabilityVersion: body.capability_version, artifactSha256: body.artifact_sha256,
      sharingOptIn: body.sharing_opt_in, providers, resources: { ...resources, running_task_count: body.resources.running_task_count }, reportedAt: clock(),
    } }, { upsert: true });
    return { ok: true, inventory_recorded: true, dispatchable: false, acceptance: DIGITAL_LIVE_REALTIME_ACCEPTANCE };
  }
  async function catalog(ownerId, filters = {}) {
    await entitled(ownerId);
    const filterSchema = providerSchema.pick({ character_id: true, voice_id: true, character_image_sha256: true, voice_audio_sha256: true }).partial();
    const parsed = filterSchema.safeParse(filters);
    demand(parsed.success, "REALTIME_PROVIDER_FILTER_INVALID", "角色、音色或素材摘要筛选格式不正确", 400);
    const computeGroupId = group(await readGroup(ownerId)), profiles = new Map();
    const candidates = await (await collection(NODES)).find({ computeGroupId, sharingOptIn: true,
      reportedAt: { $gte: new Date(+clock() - 30_000) } }).limit(64).toArray();
    for (const node of candidates) {
      const b = await (await collection("nodeAccountBindings")).findOne({ _id: node.bindingObjectId, status: "active", revokedAt: null });
      if (!b || b.nodeId !== node.nodeId || String(b.userId) !== node.executorUserId || !computeGroupsMatch(b.computeGroupId, computeGroupId)) continue;
      const snapshot = await slots.snapshot({ bindingId: node.bindingId, now: clock() }), load = normalizeGpuLoadReport(node.resources, clock());
      const h3Busy = await (await collection("h3SharedTasks")).findOne({ status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $gt: clock() },
        $or: [{ "claimedByNode.bindingId": node.bindingObjectId }, { "assignedNode.bindingId": node.bindingObjectId }, { "executedByNode.bindingId": node.bindingObjectId }] });
      const idle = !h3Busy && snapshot.available && snapshot.activeCount === 0 && load.gpu_state === "idle" && load.current_task_remaining_seconds === 0 && node.resources.running_task_count === 0;
      for (const provider of node.providers) {
        if (Object.entries(parsed.data).some(([key, value]) => provider[key] !== value)) continue;
        const proof = await proofFor(node, provider); if (!proof) continue;
        const key = digest({ provider, artifact: node.artifactSha256 });
        const previous = profiles.get(key);
        profiles.set(key, { providers: provider, capability_version: DIGITAL_LIVE_REALTIME_VERSION, artifact_sha256: node.artifactSha256,
          proof: { source: "automatic", tested_at: proof.testedAt, expires_at: proof.expiresAt, test_evidence_sha256: proof.testEvidenceSha256,
            realtime_asr_verified: Boolean(provider.asr_model && proof.contractTests?.realtime_asr === true) },
          availability: { verified_node_count: (previous?.availability.verified_node_count || 0) + 1,
            free_slot_count: (previous?.availability.free_slot_count || 0) + (idle ? 1 : 0) },
          dispatchable: idle || previous?.dispatchable === true,
          asr_dispatchable: Boolean(provider.asr_model && proof.contractTests?.realtime_asr === true && (idle || previous?.asr_dispatchable)) });
      }
    }
    const providers = [...profiles.values()];
    const asrReady = providers.some((row) => row.asr_dispatchable);
    return { schema_version: DIGITAL_LIVE_REALTIME_VERSION, product: "digital_live", providers,
      remote_asr: { status: asrReady ? "available" : "integration_required", dispatchable: asrReady },
      dispatchable: providers.some((row) => row.dispatchable), acceptance: providers.length ? "automatic_verified" : DIGITAL_LIVE_REALTIME_ACCEPTANCE,
      billing: { price_fen: 0, wallet_charge: false, commission: false }, checked_at: clock() };
  }
  async function create(ownerId, raw, headerKey) {
    const p = startSchema.safeParse(raw);
    demand(p.success && (!headerKey || headerKey === p.data.client_request_id), "REALTIME_REQUEST_INVALID", "请提供数字直播产品、原始请求编号及完整模型角色组合，幂等键必须一致", 400);
    await entitled(ownerId);
    const body = p.data, id = realtimeSessionId(ownerId, body.client_request_id), requestHash = digest(body);
    const existing = await (await collection(SESSIONS)).findOne({ _id: id, ownerId: String(ownerId) });
    if (existing) {
      demand(existing.requestHash === requestHash || existing.tombstone, "REALTIME_IDEMPOTENCY_CONFLICT", "原请求编号已用于其他会话参数");
      return { session: view(await owned(ownerId, id, { allowTerminal: true })), idempotent: true };
    }
    const computeGroupId = group(await readGroup(ownerId));
    const nodes = await (await collection(NODES)).find({ sharingOptIn: true, computeGroupId, reportedAt: { $gte: new Date(+clock() - 30_000) } }).sort({ reportedAt: -1, _id: 1 }).limit(64).toArray();
    let selected;
    for (const node of nodes) {
      const load = normalizeGpuLoadReport(node.resources, clock());
      if (load.gpu_state !== "idle" || load.current_task_remaining_seconds !== 0 || node.resources.running_task_count !== 0
        || !node.providers.some((provider) => providerHash(provider) === providerHash(body.providers))) continue;
      const b = await (await collection("nodeAccountBindings")).findOne({ _id: node.bindingObjectId, status: "active", revokedAt: null });
      if (!b || b.nodeId !== node.nodeId || String(b.userId) !== node.executorUserId || !computeGroupsMatch(b.computeGroupId, computeGroupId)) continue;
      if (!(await proofFor(node, body.providers))) continue;
      const h3Busy = await (await collection("h3SharedTasks")).findOne({ status: { $in: ["claimed", "processing"] }, claimLeaseUntil: { $gt: clock() },
        $or: [{ "claimedByNode.bindingId": node.bindingObjectId }, { "assignedNode.bindingId": node.bindingObjectId }, { "executedByNode.bindingId": node.bindingObjectId }] });
      if (h3Busy) continue;
      const snapshot = await slots.snapshot({ bindingId: node.bindingId, now: clock() });
      if (snapshot.available && snapshot.activeCount === 0) { selected = node; break; }
    }
    demand(selected, "REALTIME_INTEGRATION_REQUIRED", "当前没有同分组且通过连续实时验收的空闲节点；异步能力证明不能用于直播", 503);
    const instant = clock();
    const s = { _id: id, ownerId: String(ownerId), clientProduct: "digital_live", clientRequestId: body.client_request_id, requestHash,
      providers: body.providers, computeGroupId, bindingId: selected.bindingId, bindingObjectId: selected.bindingObjectId,
      nodeId: selected.nodeId, executorUserId: selected.executorUserId, artifactSha256: selected.artifactSha256,
      revision: 0, state: "allocating", generation: 1, mediaGeneration: 0, lastSequence: 0, playedSequence: 0, queue: [], sentenceKeys: [], nodeFinished: false,
      turnKeys: [], asrKeys: [], eventCursor: 0, nodeEventSequence: 0, eventKeys: [], events: [], activeTurn: null, activeAsr: null,
      clientSeenAt: instant, workerLeaseUntil: new Date(+instant + LEASE_MS), expiresAt: new Date(+instant + MAX_SESSION_MS),
      purgeAt: new Date(+instant + 7 * 86400_000), createdAt: instant, updatedAt: instant };
    try { await (await collection(SESSIONS)).insertOne(s); }
    catch (error) { if (error.code !== 11000) throw error; return create(ownerId, raw, headerKey); }
    const lease = await slots.reserve({ ...fence(s), exclusive: true, maxConcurrentTasks: 1, capabilityMaxConcurrent: 1,
      estimatedSeconds: 1800, now: instant, expiresAt: s.workerLeaseUntil });
    if (!lease) { await invalidate(s, "node_busy", "failed"); demand(false, "REALTIME_NODE_BUSY", "实时节点已被其他任务预约，请选择其他节点", 503); }
    try {
      await liveBinding(s);
      demand(await proofFor(selected, body.providers), "REALTIME_INTEGRATION_REQUIRED", "实时证明已变化，未启动模型", 503);
      demand(computeGroupsMatch(await readGroup(ownerId), computeGroupId), "COMPUTE_GROUP_MISMATCH", "用户分组已变化，未启动模型", 403);
      return { session: view(await patch(s, { state: "accepted" })), idempotent: false };
    } catch (error) { await slots.release({ ...fence(s), now: clock() }); await invalidate(s, "admission_changed", "failed").catch(() => {}); throw error; }
  }
  async function get(ownerId, id) { return view(await owned(ownerId, id, { allowTerminal: true })); }
  function eventPatch(s, event, values = {}) {
    const cursor = (s.eventCursor || 0) + 1;
    return { ...values, eventCursor: cursor, events: [...(s.events || []), { ...event, cursor, session_id: s._id,
      generation: s.generation, emitted_at: clock().toISOString() }].slice(-128) };
  }
  async function turn(ownerId, id, raw) {
    const parsed = turnSchema.safeParse(raw);
    demand(parsed.success, "REALTIME_TURN_INVALID", "请提供原轮次请求编号、用户文本和有限对话历史", 400);
    const body = parsed.data, s = await owned(ownerId, id), hash = digest(body);
    await currentNodePermit(s);
    demand(body.generation === s.generation, "REALTIME_GENERATION_MISMATCH", "会话代次已变化，请查询原会话");
    const previous = (s.turnKeys || []).find((item) => item.turn_id === body.turn_id || item.request_id === body.request_id);
    if (previous) { demand(previous.hash === hash, "REALTIME_IDEMPOTENCY_CONFLICT", "原轮次编号已对应不同输入"); return view(s); }
    demand(["ready", "idle"].includes(s.state) && !s.queue.length && (!s.activeTurn || s.activeTurn.state === "finished"),
      "REALTIME_TURN_BUSY", "上一轮尚未完成真实播放，请等待排空或明确打断", 429);
    demand((s.turnKeys || []).length < 128, "REALTIME_SESSION_LIMIT", "本会话轮数已达上限，请创建新会话", 429);
    demand(Buffer.byteLength(body.user_text) + body.history.reduce((sum, item) => sum + Buffer.byteLength(item.content) + 32, 0) <= 6144,
      "REALTIME_CONTEXT_LIMIT", "当前输入与历史超过8192上下文的安全预算，请缩短文本或历史", 413);
    const activeTurn = { ...body, media_generation: (s.mediaGeneration || 0) + 1, context_tokens: 8192, max_output_tokens: 1024,
      state: "generating", assistant_text: "", media_count: 0, last_timestamp_offset: -1 };
    return view(await patch(s, eventPatch(s, { type: "turn.accepted", turn_id: body.turn_id, media_generation: activeTurn.media_generation },
      { activeTurn, mediaGeneration: activeTurn.media_generation, nodeFinished: false, state: "rendering",
        turnKeys: [...(s.turnKeys || []), { turn_id: body.turn_id, request_id: body.request_id, generation: s.generation,
          media_generation: activeTurn.media_generation, hash }] })));
  }
  async function turnByRequest(ownerId, id, key) {
    demand(KEY.test(key), "REALTIME_REQUEST_INVALID", "轮次请求编号格式不正确", 400);
    const s = await owned(ownerId, id, { allowTerminal: true }), record = (s.turnKeys || []).find((item) => item.request_id === key);
    demand(record, "REALTIME_TURN_NOT_FOUND", "原轮次请求不存在", 404);
    const active = s.activeTurn?.request_id === key ? s.activeTurn : null;
    return { request_id: key, turn_id: record.turn_id, generation: record.generation, media_generation: record.media_generation,
      state: active?.state || (record.generation !== s.generation ? "interrupted" : "superseded"),
      text_snapshot: active?.assistant_text || "", session_state: s.state };
  }
  async function events(ownerId, id, after = 0) {
    const s = await owned(ownerId, id, { allowTerminal: true });
    demand(Number.isSafeInteger(after) && after >= 0 && after <= (s.eventCursor || 0), "REALTIME_CURSOR_INVALID", "事件游标格式不正确", 400);
    demand(!s.events?.length || after >= s.events[0].cursor - 1, "REALTIME_CURSOR_EXPIRED", "事件游标已过期，请查询原会话的当前代次与文本快照");
    return { session_id: id, generation: s.generation, media_generation: s.mediaGeneration || 0,
      events: (s.events || []).filter((item) => item.cursor > after), next_cursor: s.eventCursor || 0 };
  }
  async function beginAsr(ownerId, id, raw) {
    const parsed = asrSchema.safeParse(raw);
    demand(parsed.success, "REALTIME_ASR_REQUEST_INVALID", "请提供原语音请求编号、轮次、语句编号和有限历史", 400);
    const s = await owned(ownerId, id), body = parsed.data, hash = digest(body);
    demand(s.providers.asr_model, "REALTIME_ASR_INTEGRATION_REQUIRED", "所选实时组合尚未通过远程语音识别验收", 503);
    await currentNodePermit(s);
    demand(body.generation === s.generation, "REALTIME_GENERATION_MISMATCH", "语音输入代次已变化");
    const previous = (s.asrKeys || []).find((item) => item.request_id === body.request_id || item.utterance_id === body.utterance_id);
    if (previous) { demand(previous.hash === hash, "REALTIME_IDEMPOTENCY_CONFLICT", "原语音请求已对应其他参数"); return view(s); }
    demand(["idle", "ready"].includes(s.state) && !s.queue.length && (!s.activeTurn || s.activeTurn.state === "finished"),
      "REALTIME_TURN_BUSY", "请等待上一轮真实播放结束或明确打断", 429);
    demand((s.asrKeys || []).length < 128 && (s.turnKeys || []).length < 128 && !(s.turnKeys || []).some((item) => item.request_id === body.request_id || item.turn_id === body.turn_id),
      "REALTIME_IDEMPOTENCY_CONFLICT", "语音轮次编号已使用或达到会话上限");
    demand(body.history.reduce((sum, item) => sum + Buffer.byteLength(item.content) + 32, 0) <= 4096,
      "REALTIME_CONTEXT_LIMIT", "语音对话历史超过安全预算，请缩短历史", 413);
    const activeAsr = { ...body, state: "awaiting_audio", startEventCursor: (s.eventCursor || 0) + 1,
      readerReadyAt: null, inputStartedAt: null, input: null, partial_text: "", final_text: "" };
    return view(await patch(s, eventPatch(s, { type: "asr.accepted", utterance_id: body.utterance_id, turn_id: body.turn_id },
      { state: "listening", activeAsr, nodeFinished: false, asrKeys: [...(s.asrKeys || []), { request_id: body.request_id, utterance_id: body.utterance_id, hash }] })));
  }
  async function asrByRequest(ownerId, id, key) {
    demand(KEY.test(key), "REALTIME_REQUEST_INVALID", "语音请求编号格式不正确", 400);
    const s = await owned(ownerId, id, { allowTerminal: true }), record = (s.asrKeys || []).find((item) => item.request_id === key);
    demand(record, "REALTIME_ASR_NOT_FOUND", "原语音请求不存在", 404);
    return { request_id: key, utterance_id: record.utterance_id,
      state: s.activeAsr?.request_id === key ? s.activeAsr.state : "superseded", session: view(s) };
  }
  async function inputTicket(ownerId, id, body) {
    const s = await owned(ownerId, id), a = s.activeAsr;
    demand(a && a.state === "awaiting_audio" && !a.inputStartedAt && body.generation === s.generation && body.utterance_id === a.utterance_id,
      "REALTIME_ASR_INPUT_UNCERTAIN", "语音输入已开始或不属于当前语句；请先查原状态，不要重传");
    demand(origins.has(body.origin), "REALTIME_ORIGIN_INVALID", "语音输入来源未被允许", 403);
    const secret = `dli_${freshSecret()}`, expiresAt = new Date(Math.min(+clock() + 30_000, +new Date(s.workerLeaseUntil)));
    await (await collection(TICKETS)).insertOne({ _id: digest(secret), purpose: "input_audio", sessionId: id, ownerId: String(ownerId),
      generation: s.generation, utteranceId: a.utterance_id, origin: body.origin, expiresAt, usedAt: null });
    await patch(s, { activeAsr: { ...a, ticketHash: digest(secret) } });
    return { ticket: secret, expires_at: expiresAt, method: "PUT", authorization_scheme: "DigitalLiveInput", generation: s.generation,
      utterance_id: a.utterance_id, content_type: DIGITAL_LIVE_PCM_MIME, max_bytes: 640000, sample_rate: 16000, channels: 1, format: "s16le",
      input_url: `${gatewayOrigin}${DIGITAL_LIVE_REALTIME_ROOT}/sessions/${id}/input-audio/${s.generation}/${a.utterance_id}` };
  }
  async function consumeInputTicket(id, generation, utterance, secret, origin) {
    demand(/^dli_[A-Za-z0-9_-]{43}$/.test(secret || ""), "REALTIME_INPUT_TICKET_INVALID", "语音输入票据无效", 401);
    const tickets = await collection(TICKETS), record = await tickets.findOne({ _id: digest(secret), purpose: "input_audio", sessionId: id,
      generation, utteranceId: utterance, origin, usedAt: null, expiresAt: { $gt: clock() } });
    demand(record, "REALTIME_INPUT_TICKET_INVALID", "语音输入票据已使用、到期或来源不匹配", 401);
    const s = await owned(record.ownerId, id), a = s.activeAsr;
    await currentNodePermit(s);
    demand(s.generation === generation && a?.utterance_id === utterance && !a.inputStartedAt && a.state === "awaiting_audio"
      && a.ticketHash === digest(secret) && a.readerReadyAt, "REALTIME_ASR_READER_REQUIRED", "节点尚未准备读取，或原语音输入已开始；请查询原状态");
    const claimed = await tickets.updateOne({ _id: record._id, usedAt: null, expiresAt: { $gt: clock() } }, { $set: { usedAt: clock() } });
    demand(claimed.modifiedCount === 1, "REALTIME_INPUT_TICKET_INVALID", "语音输入票据已使用", 401);
    await patch(s, { activeAsr: { ...a, state: "receiving", inputStartedAt: clock() } });
    return { sessionId: id, generation, sequence: utterance, mimeType: DIGITAL_LIVE_PCM_MIME };
  }
  async function audioReadPermit(binding, id, secret, generation, utterance) {
    const s = await worker(binding, id, secret), a = s.activeAsr;
    demand(s.state === "listening" && s.generation === generation && a?.utterance_id === utterance && !a.input,
      "REALTIME_ASR_INPUT_UNCERTAIN", "原语音输入已结束或代次不符");
    return { sessionId: id, generation, sequence: utterance, mimeType: DIGITAL_LIVE_PCM_MIME };
  }
  async function audioReaderReady(id, generation, utterance) {
    const s = await read(id);
    demand(s.generation === generation && s.activeAsr?.utterance_id === utterance && s.state === "listening", "REALTIME_GENERATION_MISMATCH", "语音输入代次已变化");
    await patch(s, { activeAsr: { ...s.activeAsr, readerReadyAt: clock() } });
  }
  async function audioReceived(id, generation, utterance, metadata) {
    demand(Number.isSafeInteger(metadata.bytes) && metadata.bytes > 0 && metadata.bytes <= 640000 && metadata.bytes % 2 === 0 && HASH.test(metadata.sha256),
      "REALTIME_PCM_INVALID", "语音输入大小或摘要不符合PCM16安全上限", 400);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const s = await read(id), a = s.activeAsr;
      demand(s.generation === generation && a?.utterance_id === utterance && s.state === "listening", "REALTIME_GENERATION_MISMATCH", "旧语音输入已失效");
      if (a.input) { demand(a.input.bytes === metadata.bytes && a.input.sha256 === metadata.sha256, "REALTIME_ASR_INPUT_UNCERTAIN", "原语音输入已对应其他内容"); return; }
      try { await patch(s, { activeAsr: { ...a, state: "recognizing", input: metadata } }); return; }
      catch (error) { if (error.code !== "REALTIME_STATE_CONFLICT" || attempt === 3) throw error; }
    }
  }
  async function byRequest(ownerId, key) { demand(KEY.test(key), "REALTIME_REQUEST_INVALID", "请求编号格式不正确", 400); return get(ownerId, realtimeSessionId(ownerId, key)); }
  async function cancelByRequest(ownerId, key) {
    demand(KEY.test(key), "REALTIME_REQUEST_INVALID", "请求编号格式不正确", 400);
    const id = realtimeSessionId(ownerId, key), instant = clock();
    try { await (await collection(SESSIONS)).insertOne({ _id: id, ownerId: String(ownerId), clientProduct: "digital_live", clientRequestId: key,
      tombstone: true, state: "cancelled", generation: 1, queue: [], revision: 0, cancelReason: "user_cancelled", createdAt: instant,
      workerLeaseUntil: instant, clientSeenAt: instant, expiresAt: instant, purgeAt: new Date(+instant + 7 * 86400_000), computeGroupId: group(await readGroup(ownerId)) }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const s = await owned(ownerId, id, { allowTerminal: true }); return view(await invalidate(s, "user_cancelled"));
  }
  async function mutate(ownerId, id, action, body = {}) {
    const s = await owned(ownerId, id, { allowTerminal: action === "cancel" });
    if (action === "cancel") return view(await invalidate(s, "user_cancelled"));
    if (action === "heartbeat") return view(await patch(s, { clientSeenAt: clock() }));
    if (action === "interrupt") {
      demand(KEY.test(body.request_id || ""), "REALTIME_REQUEST_INVALID", "打断操作需要稳定请求编号", 400);
      if (s.lastInterruptKey === body.request_id) {
        demand(s.lastInterruptGeneration === body.generation, "REALTIME_IDEMPOTENCY_CONFLICT", "原打断编号不能用于其他代次"); return view(s);
      }
      demand(body.generation === s.generation, "REALTIME_GENERATION_MISMATCH", "会话已切换代次，请丢弃旧媒体并重新查询");
      const next = await patch(s, { generation: s.generation + 1, state: "interrupting", queue: [], lastSequence: 0, playedSequence: 0,
        sentenceKeys: [], activeTurn: null, activeAsr: null, mediaGeneration: (s.mediaGeneration || 0) + 1,
        lastInterruptKey: body.request_id, lastInterruptGeneration: body.generation, nodeFinished: false }); onInvalidate(id); return view(next);
    }
    demand(body.generation === s.generation, "REALTIME_GENERATION_MISMATCH", "会话已切换代次，请丢弃旧媒体并重新查询");
    demand(["ready", "rendering", "draining", "idle"].includes(s.state), "REALTIME_NOT_READY", "节点尚未就绪或正在打断，请稍后重试");
    if (action === "enqueue") {
      demand(KEY.test(body.turn_id || "") && Number.isSafeInteger(body.sequence) && typeof body.text === "string" && body.text.trim()
        && body.text.length <= 2000, "REALTIME_REQUEST_INVALID", "句段需要有效轮次、序号与最多2000字文本", 400);
      const previous = (s.sentenceKeys || []).find((item) => item.turn_id === body.turn_id || item.sequence === body.sequence);
      if (previous) { demand(previous.turn_id === body.turn_id && previous.sequence === body.sequence && previous.text_sha256 === digest(body.text),
        "REALTIME_SEQUENCE_CONFLICT", "原句段编号已对应其他内容"); return view(s); }
      demand(body.sequence === s.lastSequence + 1, "REALTIME_SEQUENCE_CONFLICT", "句段序号必须连续递增");
      demand(s.queue.length < 3, "REALTIME_BACKPRESSURE", "待播放句段已满，请等待真实播放确认后再发送", 429);
      demand((s.sentenceKeys || []).length < 256, "REALTIME_SESSION_LIMIT", "本会话句段已达安全上限，请结束后创建新会话", 429);
      return view(await patch(s, { queue: [...s.queue, { turn_id: body.turn_id, sequence: body.sequence, text: body.text, state: "queued" }],
        sentenceKeys: [...(s.sentenceKeys || []), { turn_id: body.turn_id, sequence: body.sequence, text_sha256: digest(body.text) }],
        lastSequence: body.sequence, state: "rendering", nodeFinished: false }));
    }
    demand(action === "played" && Number.isSafeInteger(body.sequence), "REALTIME_REQUEST_INVALID", "播放确认格式不正确", 400);
    if (body.sequence <= s.playedSequence) return view(s);
    const item = s.queue[0];
    demand(item && item.sequence === body.sequence && item.turn_id === body.turn_id && item.state === "sent",
      "REALTIME_PLAYED_OUT_OF_ORDER", "只能确认已完整传输且按顺序实际播放的句段");
    const queue = s.queue.slice(1);
    return view(await patch(s, { queue, playedSequence: body.sequence, state: !queue.length && s.nodeFinished ? "idle" : s.state }));
  }
  async function worker(binding, id, secret, { allowEnded = false } = {}) {
    demand(await (await collection(SESSIONS)).findOne({ _id: id, bindingId: String(binding._id), nodeId: binding.nodeId,
      executorUserId: String(binding.userId) }), "REALTIME_SESSION_NOT_FOUND", "当前节点没有该实时会话", 404);
    const s = await read(id);
    if (!allowEnded) demand(!terminal(s.state), "REALTIME_SESSION_ENDED", "实时会话已到期，必须停止本会话作业");
    demand(s.bindingId === String(binding._id) && s.nodeId === binding.nodeId && s.executorUserId === String(binding.userId),
      "REALTIME_NODE_MISMATCH", "当前节点不是指定实时执行节点", 403);
    demand(typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret) && digest(secret) === s.workerTokenHash,
      "REALTIME_LEASE_INVALID", "实时执行租约无效", 401);
    await liveBinding(s);
    if (!allowEnded) {
      try { await entitled(s.ownerId);
        demand(computeGroupsMatch(await readGroup(s.ownerId), s.computeGroupId), "COMPUTE_GROUP_MISMATCH", "实时会话分组已变化", 403);
      } catch (error) { await invalidate(s, "authorization_changed"); throw error; }
      await currentNodePermit(s);
    }
    return s;
  }
  function workerView(s) { return { id: s._id, generation: s.generation, state: s.state, providers: s.providers,
    transport: DIGITAL_LIVE_MEDIA_TRANSPORT, worker_lease_expires_at: s.workerLeaseUntil, expires_at: s.expiresAt,
    media_generation: s.mediaGeneration || 0, last_event_sequence: s.nodeEventSequence || 0,
    input_audio: s.activeAsr ? { utterance_id: s.activeAsr.utterance_id, request_id: s.activeAsr.request_id, turn_id: s.activeAsr.turn_id,
      state: s.activeAsr.state, model: s.providers.asr_model, content_type: DIGITAL_LIVE_PCM_MIME, max_bytes: 640000,
      input: s.activeAsr.input, read_path: `${DIGITAL_LIVE_REALTIME_ROOT}/sessions/${s._id}/input-audio/${s.generation}/${s.activeAsr.utterance_id}` } : null,
    turn: s.activeTurn ? { turn_id: s.activeTurn.turn_id, request_id: s.activeTurn.request_id, user_text: s.activeTurn.user_text,
      history: s.activeTurn.history, context_tokens: 8192, max_output_tokens: 1024, media_generation: s.activeTurn.media_generation, state: s.activeTurn.state } : null,
    queue: s.queue.map(({ turn_id, sequence, text, state, media_generation, turn_sequence, duration_seconds, timestamp_offset }) =>
      ({ turn_id, sequence, text, state, media_generation, turn_sequence, duration_seconds, timestamp_offset })) }; }
  async function claim(binding, secret) {
    demand(typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret), "REALTIME_LEASE_INVALID", "请先在节点持久保存43位随机租约令牌", 400);
    const sessions = await collection(SESSIONS), tokenHash = digest(secret);
    let s = await sessions.findOne({ bindingId: String(binding._id), workerTokenHash: tokenHash });
    if (s) return workerView(await worker(binding, s._id, secret));
    s = await sessions.findOne({ bindingId: String(binding._id), state: "accepted", workerLeaseUntil: { $gt: clock() } });
    if (!s) return null;
    await liveBinding(s); await entitled(s.ownerId);
    demand(computeGroupsMatch(await readGroup(s.ownerId), s.computeGroupId), "COMPUTE_GROUP_MISMATCH", "会话用户分组已变化", 403);
    const node = await (await collection(NODES)).findOne({ _id: s.bindingId });
    demand(node && node.artifactSha256 === s.artifactSha256 && await proofFor(node, s.providers), "REALTIME_INTEGRATION_REQUIRED", "连续实时证明不完整，禁止启动模型", 503);
    s = await patch(s, { state: "ready", workerTokenHash: tokenHash });
    return workerView(s);
  }
  async function workerState(binding, id, secret) { return workerView(await worker(binding, id, secret)); }
  async function workerEvent(binding, id, secret, body) {
    const s = await worker(binding, id, secret, { allowEnded: body.event === "stopped" });
    demand(body.generation === s.generation, "REALTIME_GENERATION_MISMATCH", "旧代次事件不能恢复会话");
    demand(JSON.stringify(providerSchema.parse(body.providers)) === JSON.stringify(s.providers), "REALTIME_PROVIDER_MISMATCH", "必须回传实际使用的精确模型、角色和音色；禁止小模型替代");
    if (["text_delta", "media_announcement", "turn_finished", "asr_partial", "asr_final"].includes(body.event)) {
      demand(!terminal(s.state) && !["cancelling", "interrupting"].includes(s.state), "REALTIME_SESSION_ENDED", "会话已停止接收流式事件");
      demand(KEY.test(body.event_id || "") && Number.isSafeInteger(body.event_sequence) && body.event_sequence > 0,
        "REALTIME_EVENT_INVALID", "流式事件须使用持久原事件编号与连续事件序号", 400);
      const hash = digest(body), old = (s.eventKeys || []).find((item) => item.id === body.event_id || item.sequence === body.event_sequence);
      if (old) { demand(old.hash === hash, "REALTIME_IDEMPOTENCY_CONFLICT", "原流式事件编号已对应其他内容"); return workerView(s); }
      demand(body.event_sequence === (s.nodeEventSequence || 0) + 1, "REALTIME_EVENT_SEQUENCE_CONFLICT", "节点事件序号必须按原会话连续递增");
      const current = s.activeTurn, audio = s.activeAsr, asr = body.event.startsWith("asr_");
      if (!asr) demand(current?.turn_id === body.turn_id && current.state === "generating" && body.media_generation === current.media_generation,
        "REALTIME_TURN_MISMATCH", "流式事件不是当前生成轮次或媒体代次");
      const values = { nodeEventSequence: body.event_sequence,
        eventKeys: [...(s.eventKeys || []), { id: body.event_id, sequence: body.event_sequence, hash }].slice(-128) };
      let event;
      if (asr) {
        demand(s.state === "listening" && audio?.utterance_id === body.utterance_id && audio.turn_id === body.turn_id && audio.inputStartedAt
          && s.providers.asr_model && typeof body.text === "string" && body.text.trim() && body.text.length <= 2000,
          "REALTIME_ASR_EVENT_INVALID", "语音事件必须对应当前语句、轮次和实际ASR模型", 400);
        if (body.event === "asr_partial") {
          values.activeAsr = { ...audio, partial_text: body.text };
          event = { type: "asr.partial", utterance_id: audio.utterance_id, turn_id: audio.turn_id, text: body.text, model: s.providers.asr_model };
        } else {
          demand(audio.input && audio.input.sha256 === body.input_sha256 && audio.input.bytes === body.input_bytes,
            "REALTIME_ASR_INPUT_UNCERTAIN", "完整ASR结果必须对应网关已收齐的同一份语音输入");
          demand(Buffer.byteLength(body.text) + audio.history.reduce((sum, item) => sum + Buffer.byteLength(item.content) + 32, 0) <= 6144,
            "REALTIME_CONTEXT_LIMIT", "识别结果及历史超过对话预算，未启动LLM", 413);
          const turnBody = { generation: s.generation, request_id: audio.request_id, turn_id: audio.turn_id, user_text: body.text, history: audio.history };
          values.activeTurn = { ...turnBody, media_generation: (s.mediaGeneration || 0) + 1, context_tokens: 8192, max_output_tokens: 1024,
            state: "generating", assistant_text: "", media_count: 0, last_timestamp_offset: -1 };
          values.activeAsr = { ...audio, state: "final", final_text: body.text, partial_text: "", media_generation: values.activeTurn.media_generation,
            turnEventCursor: (s.eventCursor || 0) + 1 };
          values.mediaGeneration = values.activeTurn.media_generation; values.state = "rendering"; values.nodeFinished = false;
          values.turnKeys = [...(s.turnKeys || []), { request_id: audio.request_id, turn_id: audio.turn_id, generation: s.generation,
            media_generation: values.mediaGeneration, hash: digest(turnBody) }];
          event = { type: "asr.final", utterance_id: audio.utterance_id, turn_id: audio.turn_id, request_id: audio.request_id,
            text: body.text, model: s.providers.asr_model, media_generation: values.mediaGeneration,
            input_sha256: audio.input.sha256, input_bytes: audio.input.bytes, event_cursor_start: (s.eventCursor || 0) + 1 };
        }
      } else if (body.event === "text_delta") {
        demand(typeof body.delta === "string" && body.delta.length > 0 && Buffer.byteLength(body.delta) <= 4096
          && Buffer.byteLength(current.assistant_text + body.delta) <= 16 * 1024, "REALTIME_TEXT_LIMIT", "文字增量或整轮文本超过安全上限", 413);
        values.activeTurn = { ...current, assistant_text: current.assistant_text + body.delta };
        event = { type: "text.delta", turn_id: body.turn_id, media_generation: current.media_generation, delta: body.delta, model: s.providers.text_model };
      } else if (body.event === "media_announcement") {
        demand(s.queue.length < 3, "REALTIME_BACKPRESSURE", "已有三句等待播放，请等待实际播放确认", 429);
        demand(body.sequence === s.lastSequence + 1 && body.turn_sequence === current.media_count + 1
          && typeof body.text === "string" && body.text.trim() && body.text.length <= 2000
          && Number.isFinite(body.duration_seconds) && body.duration_seconds > 0 && body.duration_seconds <= 60
          && Number.isFinite(body.timestamp_offset) && body.timestamp_offset >= 0 && body.timestamp_offset < 1800
          && body.timestamp_offset >= current.last_timestamp_offset && body.mime_type === s.providers.mime_type,
          "REALTIME_MEDIA_ANNOUNCEMENT_INVALID", "媒体序号、句段、编码时长或时间轴不符合当前轮次", 400);
        values.queue = [...s.queue, { turn_id: body.turn_id, sequence: body.sequence, turn_sequence: body.turn_sequence, text: body.text,
          state: "queued", media_generation: current.media_generation, duration_seconds: body.duration_seconds, timestamp_offset: body.timestamp_offset }];
        values.lastSequence = body.sequence;
        values.activeTurn = { ...current, media_count: current.media_count + 1, last_timestamp_offset: body.timestamp_offset };
        event = { type: "session.media", turn_id: body.turn_id, generation: s.generation, media_generation: current.media_generation,
          sequence: body.sequence, turn_sequence: body.turn_sequence, duration_seconds: body.duration_seconds,
          timestamp_offset: body.timestamp_offset, mime_type: body.mime_type,
          media_ticket_url: `${DIGITAL_LIVE_REALTIME_ROOT}/sessions/${id}/media-ticket` };
      } else {
        demand(body.final_sequence === s.lastSequence && current.media_count > 0 && s.queue.every((item) => item.state === "sent"),
          "REALTIME_NOT_DRAINABLE", "当前轮次媒体尚未全部完整发送或最终序号不符");
        values.activeTurn = { ...current, state: "finished" }; values.nodeFinished = true; values.state = s.queue.length ? "draining" : "idle";
        event = { type: "session.mediaEnd", turn_id: body.turn_id, media_generation: current.media_generation,
          final_sequence: body.final_sequence, final_turn_sequence: current.media_count };
      }
      return workerView(await patch(s, eventPatch(s, event, values)));
    }
    if (body.event === "stopped") {
      demand(terminal(s.state) || s.state === "cancelling", "REALTIME_STOP_NOT_REQUESTED", "会话尚未请求停止");
      const next = terminal(s.state) ? s : await patch(s, { state: "cancelled" });
      await slots.release({ ...fence(s), now: clock() }); return workerView(next);
    }
    demand(!terminal(s.state) && s.state !== "cancelling", "REALTIME_SESSION_ENDED", "实时会话已结束，不能续租");
    if (body.event === "interrupted") {
      demand(s.state === "interrupting", "REALTIME_STATE_CONFLICT", "会话没有待确认的打断");
      return workerView(await patch(s, { state: "idle", nodeFinished: true }));
    }
    if (body.event === "finished") {
      demand(!s.activeTurn, "REALTIME_EVENT_INVALID", "完整对话轮次必须提交turn_finished及最终媒体序号", 400);
      demand(s.queue.every((item) => item.state === "sent"), "REALTIME_NOT_DRAINABLE", "仍有未完整传输的媒体，不能确认生成结束");
      return workerView(await patch(s, { nodeFinished: true, state: s.queue.length ? "draining" : "idle" }));
    }
    demand(body.event === "heartbeat", "REALTIME_REQUEST_INVALID", "不支持的实时节点事件", 400);
    const until = new Date(Math.min(+clock() + LEASE_MS, +new Date(s.expiresAt)));
    demand(await slots.renew({ ...fence(s), now: clock(), expiresAt: until }), "REALTIME_LEASE_EXPIRED", "物理执行租约已失效，不得继续运行");
    return workerView(await patch(s, { workerLeaseUntil: until }));
  }
  async function ticket(ownerId, id, body) {
    const s = await owned(ownerId, id);
    demand(body.generation === s.generation && Number.isSafeInteger(body.sequence) && s.queue.some((item) => item.sequence === body.sequence),
      "REALTIME_SEQUENCE_CONFLICT", "媒体票据必须对应当前代次的已入队句段");
    const media = s.queue.find((item) => item.sequence === body.sequence);
    if (s.activeTurn) demand(body.turn_id === media.turn_id && body.media_generation === media.media_generation && body.turn_sequence === media.turn_sequence,
      "REALTIME_TURN_MISMATCH", "媒体票据必须携带原轮次、媒体代次与轮内序号");
    demand(origins.has(body.origin), "REALTIME_ORIGIN_INVALID", "媒体来源未被允许", 403);
    const secret = `dlm_${freshSecret()}`, expiresAt = new Date(Math.min(+clock() + 30_000, +new Date(s.workerLeaseUntil)));
    await (await collection(TICKETS)).insertOne({ _id: digest(secret), sessionId: id, ownerId: String(ownerId), product: "digital_live",
      generation: s.generation, sequence: body.sequence, origin: body.origin, expiresAt, usedAt: null });
    return { ticket: secret, expires_at: expiresAt, method: "GET", authorization_scheme: "DigitalLiveMedia",
      turn_id: media.turn_id, media_generation: media.media_generation || 0, sequence: media.sequence, turn_sequence: media.turn_sequence || 1,
      duration_seconds: media.duration_seconds || null, timestamp_offset: media.timestamp_offset || 0, mime_type: s.providers.mime_type,
      media_url: `${gatewayOrigin}${DIGITAL_LIVE_REALTIME_ROOT}/sessions/${id}/media/${s.generation}/${body.sequence}`, transport: DIGITAL_LIVE_MEDIA_TRANSPORT };
  }
  async function consumeTicket(id, generation, sequence, secret, origin) {
    demand(/^dlm_[A-Za-z0-9_-]{43}$/.test(secret || ""), "REALTIME_MEDIA_TICKET_INVALID", "媒体票据无效", 401);
    const tickets = await collection(TICKETS), record = await tickets.findOne({ _id: digest(secret), sessionId: id, product: "digital_live",
      generation, sequence, origin, usedAt: null, expiresAt: { $gt: clock() } });
    demand(record, "REALTIME_MEDIA_TICKET_INVALID", "媒体票据已使用、到期或来源不匹配", 401);
    const s = await owned(record.ownerId, id); await currentNodePermit(s);
    demand(s.generation === generation && s.queue.some((item) => item.sequence === sequence), "REALTIME_GENERATION_MISMATCH", "旧代次媒体已失效");
    const claimed = await tickets.updateOne({ _id: record._id, usedAt: null, expiresAt: { $gt: clock() } }, { $set: { usedAt: clock() } });
    demand(claimed.modifiedCount === 1, "REALTIME_MEDIA_TICKET_INVALID", "媒体票据已被使用", 401);
    return { sessionId: id, generation, sequence, mimeType: s.providers.mime_type, origin };
  }
  async function mediaPermit(binding, id, secret, generation, sequence) {
    const s = await worker(binding, id, secret);
    demand(s.generation === generation && s.state === "rendering" && s.queue.some((item) => item.sequence === sequence && item.state === "queued"),
      "REALTIME_SEQUENCE_CONFLICT", "媒体只能写入当前正在渲染的原句段");
    return { sessionId: id, generation, sequence, mimeType: s.providers.mime_type };
  }
  async function mediaSent(id, generation, sequence) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const s = await read(id);
      demand(s.generation === generation && !terminal(s.state), "REALTIME_GENERATION_MISMATCH", "旧代次媒体不能确认发送");
      const item = s.queue.find((item) => item.sequence === sequence);
      if (item?.state === "sent") return;
      demand(item?.state === "queued", "REALTIME_SEQUENCE_CONFLICT", "句段已经发送或失效");
      try { await patch(s, { queue: s.queue.map((item) => item.sequence === sequence ? { ...item, state: "sent" } : item) }); return; }
      catch (error) { if (error.code !== "REALTIME_STATE_CONFLICT" || attempt === 3) throw error; }
    }
  }
  async function mediaFailed(id) { const s = await read(id); return invalidate(s, "media_disconnected", "cancelling"); }
  return { report, catalog, create, get, turn, turnByRequest, events, beginAsr, asrByRequest, inputTicket, consumeInputTicket, audioReadPermit, audioReaderReady, audioReceived,
    byRequest, cancelByRequest, mutate, claim, workerState, workerEvent, ticket, consumeTicket, mediaPermit, mediaSent, mediaFailed };
}
