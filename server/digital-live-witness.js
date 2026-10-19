import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { readGulongEngineEntitlement } from "./english-coach-products.js";
import { getUserComputeGroupId, computeGroupsMatch } from "./compute-groups.js";
import { createDigitalLiveMediaRelay } from "./digital-live-media-relay.js";

export const DIGITAL_LIVE_WITNESS_VERSION = "digital-live-playback-witness-v1";
export const DIGITAL_LIVE_ATTESTATION_VERSION = "digital-live-independent-attestation-v1";
// Release-reviewed public identities only. No enrollment HTTP route, private
// keys, environment switch or administrator-entered "passed" record exists.
// Empty until genuinely independent observers and a measured consumer ship.
export const DIGITAL_LIVE_WITNESS_REGISTRY = Object.freeze({ consumers: Object.freeze([]), observers: Object.freeze([]) });
const ROOT = "/api/v1/digital-live/realtime", ORIGIN = "https://111.229.70.235";
const RECORDS = "digitalLiveRealtimeVerifications", MEDIA = "digitalLiveRealtimeVerificationMedia";
const TICKETS = "digitalLiveRealtimeWitnessTickets", REPORTS = "digitalLiveRealtimeWitnessReports";
const READERS = "digitalLiveRealtimeWitnessMedia", ATTESTATIONS = "digitalLiveRealtimeAttestations", PROOFS = "digitalLiveRealtimeProofs";
const HASH = /^[a-f0-9]{64}$/, KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/;
const ORIGINS = ["https://www.sologle.com", "https://sologle.com", ORIGIN, "http://tauri.localhost", "tauri://localhost"];
export const canonicalWitnessJson = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const witnessSha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : canonicalWitnessJson(value)).digest("hex");
const unwrap = (value) => value && Object.hasOwn(value, "value") ? value.value : value;
function demand(value, code, message, status = 409) { if (!value) throw Object.assign(new Error(message), { code, status }); }
const hash = z.string().regex(HASH), ordinal = z.number().int().min(1).max(10), ms = z.number().finite().min(0).max(900000);
const ticketSchema = z.object({ request_id: z.string().regex(KEY), consumer_artifact_sha256: hash, purpose: z.enum(["media", "interrupt_media", "report"]),
  sequence: ordinal.optional(), origin: z.enum(ORIGINS) }).strict().refine((b) => b.purpose === "media" ? b.sequence != null : b.sequence == null);
const observation = z.object({ sequence: ordinal, turn_id: z.string().regex(KEY), generation: z.number().int().min(1).max(2),
  media_generation: ordinal, turn_sequence: z.literal(1), sha256: hash, bytes: z.number().int().positive().max(16 * 1024 * 1024),
  first_body_ms: ms, first_presented_ms: ms, first_playing_ms: ms, ended_ms: ms,
  played_start_seconds: z.number().finite().min(0).max(60), played_end_seconds: z.number().finite().positive().max(60),
  presented_frames: z.number().int().positive().max(100000), total_frames: z.number().int().positive().max(100000),
  dropped_frames: z.number().int().min(0).max(100000), ended: z.literal(true) }).strict();
const reportSchema = z.object({ protocol: z.literal(DIGITAL_LIVE_WITNESS_VERSION), challenge_id: z.string().regex(/^dlv_[a-z0-9-]{36}$/),
  nonce: z.string().regex(/^[a-f0-9]{16}$/), provider_sha256: hash, node_artifact_sha256: hash, consumer_artifact_sha256: hash,
  observations: z.array(observation).length(10), interrupt: z.object({ probe_id: z.string().regex(KEY), source_sequence: z.literal(5),
    from_generation: z.literal(1), to_generation: z.literal(2),
    local_mute_ms: z.number().finite().min(0).max(5000), fetch_abort_ms: z.number().finite().min(0).max(5000) }).strict() }).strict();
const runtimePayload = z.object({ actual_text_model: z.literal("qwen38-27b-uncensored-q4-k-m"), actual_tts_model: z.string().max(120),
  actual_avatar_model: z.string().max(120), turns: z.array(z.object({ turn_id: z.string().regex(KEY), text_sha256: hash }).strict()).length(10),
  max_av_skew_ms: z.number().finite().min(0).max(150), exclusive_gpu: z.literal(true), owned_worker_stopped: z.literal(true) }).strict();
const playbackPayload = z.object({ decoded_streams: z.literal(10), end_of_stream_verified: z.literal(true),
  interrupted_generation_verified: z.literal(true) }).strict();
const attestationSchema = z.object({ protocol: z.literal(DIGITAL_LIVE_ATTESTATION_VERSION), role: z.enum(["runtime", "playback"]), observer_artifact_sha256: hash,
  key_id: z.string().regex(KEY), challenge_id: z.string().regex(/^dlv_[a-z0-9-]{36}$/), nonce: z.string().regex(/^[a-f0-9]{16}$/),
  provider_sha256: hash, node_artifact_sha256: hash, consumer_artifact_sha256: hash, wire_sha256: hash, report_sha256: hash,
  observed_at: z.string().datetime(), expires_at: z.string().datetime(), payload: z.union([runtimePayload, playbackPayload]),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict().refine((b) => (b.role === "runtime" ? runtimePayload : playbackPayload).safeParse(b.payload).success);
export const digitalLiveWitnessSchemas = Object.freeze({ ticket: ticketSchema, report: reportSchema, attestation: attestationSchema });
const registered = (entries, identity, now) => entries.find((entry) => identity(entry) && entry.revoked !== true
  && new Date(entry.not_before) <= now && new Date(entry.expires_at) > now);
function signatureIdentity(envelope, registry, instant) {
  const observer = registered(registry.observers, (o) => o.key_id === envelope.key_id && o.role === envelope.role
    && o.artifact_sha256 === envelope.observer_artifact_sha256, instant);
  if (!observer) return null;
  try {
    const key = createPublicKey(observer.public_key_spki);
    const { signature, ...unsigned } = envelope;
    return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(canonicalWitnessJson(unsigned)), key, Buffer.from(signature, "base64url"))
      ? { ...observer, keyFingerprint: witnessSha256(key.export({ type: "spki", format: "der" }).toString("base64")) } : null;
  } catch { return null; }
}
const wireDigest = (rows, interrupted) => witnessSha256({ complete: rows.map(({ sequence, sha256, bytes }) => ({ sequence, sha256, bytes })),
  interrupted: { sequence: 11, bytes: interrupted?.bytes, sha256: interrupted?.sha256, writing_when_cancelled: interrupted?.writing_when_cancelled,
    code: interrupted?.code } });
function matchingReport(record, report, rows) {
  return report.challenge_id === record.id && report.nonce === record.nonce && report.provider_sha256 === record.providerSha256
    && report.node_artifact_sha256 === record.artifactSha256 && rows.length === 10
    && report.observations.reduce((total, o) => total + o.played_end_seconds - o.played_start_seconds, 0) <= 60
    && report.observations.every((o, i) => {
      const wire = rows[i];
      return o.sequence === i + 1 && o.turn_id === record.turns[i].turn_id && o.generation === (i < 5 ? 1 : 2)
        && o.media_generation === i + 1 && wire.sequence === i + 1 && wire.state === "received" && wire.source === "gateway_stream"
        && wire.sha256 === o.sha256 && wire.bytes === o.bytes && o.first_body_ms <= o.first_presented_ms
        && o.first_body_ms <= o.first_playing_ms && Math.max(o.first_presented_ms, o.first_playing_ms) < o.ended_ms
        && o.played_end_seconds > o.played_start_seconds && o.dropped_frames <= o.total_frames && o.presented_frames <= o.total_frames;
    });
}
function matchingAttestation(record, report, rows, interrupted, a) {
  if (a.challenge_id !== record.id || a.nonce !== record.nonce || a.provider_sha256 !== record.providerSha256
    || a.node_artifact_sha256 !== record.artifactSha256 || a.consumer_artifact_sha256 !== report.consumer_artifact_sha256
    || a.wire_sha256 !== wireDigest(rows, interrupted) || a.report_sha256 !== witnessSha256(report)) return false;
  return a.role !== "runtime" || (a.payload.actual_tts_model === record.providers.tts_model && a.payload.actual_avatar_model === record.providers.avatar_model
    && a.payload.turns.every((turn, i) => turn.turn_id === record.turns[i].turn_id && turn.text_sha256 === witnessSha256(record.turns[i].expected_text)));
}

/** Pure, fail-closed admission calculation. Test keys are supplied only by
 * in-memory tests; production always uses the release-reviewed registry. */
export function evaluateDigitalLiveWitness({ record, report, observed, interrupted, attestations, registry = DIGITAL_LIVE_WITNESS_REGISTRY, now = new Date() }) {
  const missing = (code) => ({ admitted: false, code });
  if (record.mode !== "media" || !record.nonce || !record.claimsHash || record.state !== "adapter_required") return missing("REALTIME_CANDIDATE_REQUIRED");
  if (!reportSchema.safeParse(report).success || !matchingReport(record, report, observed)) return missing("REALTIME_WITNESS_MEDIA_MISMATCH");
  if (report.interrupt.probe_id !== `probe-${record.nonce}-interrupt` || interrupted?.state !== "interrupted"
    || interrupted.code !== "REALTIME_MEDIA_DISCONNECTED" || interrupted.writing_when_cancelled !== true
    || !(interrupted.bytes > 0 && interrupted.bytes < observed[4].bytes) || !HASH.test(interrupted.sha256 || "")) return missing("REALTIME_INFLIGHT_INTERRUPT_REQUIRED");
  const consumer = registered(registry.consumers, (c) => c.artifact_sha256 === report.consumer_artifact_sha256, now);
  if (!consumer) return missing("REALTIME_WITNESS_CONSUMER_UNREGISTERED");
  const accepted = [];
  for (const role of ["runtime", "playback"]) {
    const a = attestations.find((item) => item.role === role);
    if (!attestationSchema.safeParse(a).success || !matchingAttestation(record, report, observed, interrupted, a)) return missing("REALTIME_INDEPENDENT_WITNESS_REQUIRED");
    const observer = signatureIdentity(a, registry, now);
    const measured = new Date(a.observed_at), expires = new Date(a.expires_at);
    if (!observer || measured < record.createdAt || measured > record.leaseExpiresAt || measured > now
      || expires <= measured || expires - measured > 300000) return missing("REALTIME_INDEPENDENT_WITNESS_INVALID");
    accepted.push({ envelope: a, observer });
  }
  if (accepted[0].observer.keyFingerprint === accepted[1].observer.keyFingerprint) return missing("REALTIME_INDEPENDENT_IDENTITIES_REQUIRED");
  if (!record.stoppedAt) return missing("REALTIME_OWNED_WORKER_STOP_REQUIRED");
  const expiry = new Date(Math.min(+new Date(record.stoppedAt) + 86400000, +new Date(consumer.expires_at),
    ...accepted.map((a) => +new Date(a.observer.expires_at))));
  if (expiry <= now) return missing("REALTIME_WITNESS_EXPIRED");
  return { admitted: true, expiresAt: expiry, evidenceSha256: witnessSha256({ report, wire_sha256: wireDigest(observed, interrupted),
    attestations: [...attestations].sort((a, b) => a.role < b.role ? -1 : 1) }) };
}

export function createDigitalLiveWitnessService({ getCollection, now = () => new Date(), registry = DIGITAL_LIVE_WITNESS_REGISTRY,
  readEntitlement = (id, instant) => readGulongEngineEntitlement(id, instant, getCollection),
  readGroup = (id) => getUserComputeGroupId(id, getCollection),
  isOwnerActive = async (id) => ObjectId.isValid(id) && Boolean(await (await getCollection("users")).findOne({ _id: new ObjectId(id), status: "active" })) } = {}) {
  const clock = () => new Date(now()), table = (name) => getCollection(name);
  const relay = createDigitalLiveMediaRelay({ maxStreams: 4, onSent: async (id, _, sequence, metadata) => {
    await (await table(READERS)).updateOne({ _id: `${id}:${sequence}`, state: "connected" }, { $set: { state: "delivered", ...metadata, deliveredAt: clock() } });
  }, onFailed: async (id, _, sequence, metadata) => { await (await table(READERS)).updateOne({ _id: `${id}:${sequence}`, state: "connected" },
    { $set: { state: sequence === 11 && metadata.code === "REALTIME_MEDIA_DISCONNECTED" ? "interrupted" : "failed", ...metadata, updatedAt: clock() } }); } });
  async function current(record, { allowStopped = false, allowExpired = false } = {}) {
    demand(record && record.mode === "media" && record.nonce && (allowExpired || record.leaseExpiresAt > clock()) && (allowExpired || record.state !== "failed")
      && (allowStopped || !record.stoppedAt), "REALTIME_WITNESS_CHALLENGE_UNAVAILABLE", "原实时验收不存在、已失效或不支持播放器见证", 404);
    const binding = await (await table("nodeAccountBindings")).findOne({ _id: record.bindingObjectId || new ObjectId(record.bindingId), status: "active", revokedAt: null });
    const node = await (await table("digitalLiveRealtimeNodes")).findOne({ _id: record.bindingId, sharingOptIn: true });
    demand(binding && String(binding.userId) === record.userId && binding.nodeId === record.nodeId && computeGroupsMatch(binding.computeGroupId, record.computeGroupId)
      && node?.artifactSha256 === record.artifactSha256 && node.nodeId === record.nodeId && computeGroupsMatch(node.computeGroupId, record.computeGroupId)
      && node.providers?.some((p) => witnessSha256(p) === record.providerSha256)
      && await isOwnerActive(record.userId), "REALTIME_WITNESS_BINDING_CHANGED", "验收节点绑定、模型制品或分组已变化", 403);
  }
  async function owner(ownerId, id, options) {
    // Check the requesting account first; never mutate or enumerate another user's challenge.
    const record = await (await table(RECORDS)).findOne({ id, userId: String(ownerId) });
    demand(record, "REALTIME_WITNESS_NOT_FOUND", "当前账号没有该实时验收", 404);
    const entitlement = await readEntitlement(ownerId, clock());
    demand(await isOwnerActive(ownerId) && entitlement?.active === true && entitlement.capabilities?.includes("digital_live.use"),
      "DIGITAL_LIVE_SUBSCRIPTION_REQUIRED", "需要当前账号有效的古龙引擎包月数字直播权益", 403);
    demand(computeGroupsMatch(await readGroup(ownerId), record.computeGroupId), "COMPUTE_GROUP_MISMATCH", "用户与验收节点分组不一致", 403);
    await current(record, options); return record;
  }
  async function issue(ownerId, id, raw) {
    const parsed = ticketSchema.safeParse(raw);
    demand(parsed.success, "REALTIME_WITNESS_REQUEST_INVALID", "见证票据必须指定原请求、真实消费者制品摘要、用途和可信来源", 400);
    const body = parsed.data, record = await owner(ownerId, id, { allowStopped: body.purpose === "report" });
    const key = witnessSha256(`${ownerId}:${id}:${body.request_id}`), tickets = await table(TICKETS), old = await tickets.findOne({ _id: key });
    const fingerprint = witnessSha256(body);
    if (old) {
      demand(old.fingerprint === fingerprint, "REALTIME_WITNESS_IDEMPOTENCY_CONFLICT", "原见证请求已绑定其他用途或参数");
      return { protocol: DIGITAL_LIVE_WITNESS_VERSION, idempotent: true, ticket_recoverable: false, consumed: Boolean(old.consumedAt), expires_at: old.expiresAt };
    }
    const witnessId = witnessSha256(`${id}:${ownerId}:${body.consumer_artifact_sha256}`);
    // Exactly one purpose/sequence slot per consumer: retries cannot accumulate tickets.
    const slot = `${witnessId}:${body.purpose}:${body.sequence || 0}`, token = `dlw_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Math.min(+clock() + 60000, +record.leaseExpiresAt));
    const row = { _id: key, slot, witnessId, ownerId: String(ownerId), challengeId: id, fingerprint, tokenHash: witnessSha256(token),
      ...body, expiresAt, purgeAt: record.purgeAt, createdAt: clock() };
    const occupied = await tickets.findOne({ slot });
    demand(!occupied, "REALTIME_WITNESS_TICKET_ALREADY_ISSUED", "原用途票据已签发，请查询原请求，不要用新键重复读取或重跑");
    try { await tickets.insertOne(row); } catch (error) { if (error.code !== 11000) throw error; return issue(ownerId, id, raw); }
    return { protocol: DIGITAL_LIVE_WITNESS_VERSION, idempotent: false, ticket: token, header: "Authorization: DigitalLiveWitness <ticket>",
      expires_at: expiresAt, witness_id: witnessId, consumer_registration: registered(registry.consumers,
        (c) => c.artifact_sha256 === body.consumer_artifact_sha256, clock()) ? "registered" : "unregistered",
      challenge: { id, nonce: record.nonce, provider_sha256: record.providerSha256, node_artifact_sha256: record.artifactSha256,
        providers: record.providers, turns: record.turns },
      interrupt_probe: { id: `probe-${record.nonce}-interrupt`, source_sequence: 5, generation: 1, after_generation: 2,
        max_extra_model_inferences: 0, max_bytes: 4 * 1024 * 1024, max_seconds: 10,
        source_retention: "challenge_ram_only_clear_on_terminal_or_lease_expiry", pace_bytes_per_second_max: 524288,
        hold_final_real_bytes: 64, hold_tail_ms: 5000, requires_presented_frame_and_active_fetch: true,
        rule: "reuse_existing_sequence_5_output_abort_active_fetch_and_playback_no_ended_or_full_hash_claim" },
      url: `${ORIGIN}${ROOT}/verifications/${id}/${body.purpose === "media" ? `witness-media/${body.sequence}`
        : body.purpose === "interrupt_media" ? "witness-interrupt-media" : "witness-report"}` };
  }
  async function consume(id, token, origin, purpose, sequence) {
    demand(/^dlw_[A-Za-z0-9_-]{43}$/.test(token || "") && ORIGINS.includes(origin), "REALTIME_WITNESS_TICKET_INVALID", "见证票据或来源无效", 401);
    const tickets = await table(TICKETS), row = await tickets.findOne({ challengeId: id, tokenHash: witnessSha256(token), purpose, origin,
      ...(sequence ? { sequence } : {}), expiresAt: { $gt: clock() }, consumedAt: { $exists: false } });
    demand(row, "REALTIME_WITNESS_TICKET_INVALID", "见证票据已使用、过期或不匹配", 401);
    const record = await owner(row.ownerId, id, { allowStopped: purpose === "report" });
    const used = await tickets.updateOne({ _id: row._id, consumedAt: { $exists: false } }, { $set: { consumedAt: clock() } });
    demand(used.modifiedCount === 1, "REALTIME_WITNESS_TICKET_INVALID", "见证票据已被使用", 401);
    return { row, record };
  }
  async function open(id, sequence, token, origin) {
    const { row, record } = await consume(id, token, origin, sequence === 11 ? "interrupt_media" : "media", sequence === 11 ? null : sequence);
    demand(!await (await table(MEDIA)).findOne({ challengeId: id, sequence }), "REALTIME_WITNESS_MEDIA_UNAVAILABLE", "原媒体已开始或结束，不能重跑或重放");
    const permit = { sessionId: id, generation: 1, sequence, mimeType: record.providers.mime_type,
      ...(sequence === 11 ? { timeoutMs: 10000 } : {}), validate: () => owner(row.ownerId, id) };
    const stream = relay.open(permit);
    try { await (await table(READERS)).insertOne({ _id: `${id}:${sequence}`, challengeId: id, sequence, witnessId: row.witnessId,
      state: "connected", connectedAt: clock(), purgeAt: record.purgeAt }); }
    catch (error) { relay.invalidate(id); throw error; }
    return { stream, mimeType: permit.mimeType };
  }
  async function report(id, token, origin, raw) {
    const { row, record } = await consume(id, token, origin, "report"), parsed = reportSchema.safeParse(raw);
    demand(parsed.success && parsed.data.consumer_artifact_sha256 === row.consumer_artifact_sha256,
      "REALTIME_WITNESS_REPORT_INVALID", "播放器测量字段不完整或制品摘要不匹配", 400);
    const observed = await (await table(MEDIA)).find({ challengeId: id }).sort({ sequence: 1 }).limit(10).toArray();
    const readers = await (await table(READERS)).find({ challengeId: id, witnessId: row.witnessId, state: "delivered" }).sort({ sequence: 1 }).limit(10).toArray();
    demand(matchingReport(record, parsed.data, observed) && readers.length === 10 && readers.every((reader, i) => reader.sequence === i + 1
      && reader.sha256 === observed[i].sha256 && reader.bytes === observed[i].bytes), "REALTIME_WITNESS_MEDIA_MISMATCH", "测量未对应本次网关实际传输的全部十轮媒体");
    await (await table(REPORTS)).insertOne({ _id: row.witnessId, challengeId: id, report: parsed.data, reportSha256: witnessSha256(parsed.data),
      source: "untrusted_client_measurements", createdAt: clock(), purgeAt: record.purgeAt });
    return reconcile(id);
  }
  async function state(ownerId, id, requestId) {
    const record = await owner(ownerId, id, { allowStopped: true, allowExpired: true });
    demand(KEY.test(requestId || ""), "REALTIME_WITNESS_REQUEST_INVALID", "请使用原见证请求编号查询", 400);
    const ticket = await (await table(TICKETS)).findOne({ _id: witnessSha256(`${ownerId}:${id}:${requestId}`) });
    demand(ticket, "REALTIME_WITNESS_NOT_FOUND", "原见证请求不存在", 404);
    const report = await (await table(REPORTS)).findOne({ _id: ticket.witnessId });
    const interrupted = await (await table(READERS)).findOne({ _id: `${id}:11`, witnessId: ticket.witnessId });
    const observed = await (await table(MEDIA)).find({ challengeId: id }).sort({ sequence: 1 }).limit(10).toArray();
    return { protocol: DIGITAL_LIVE_WITNESS_VERSION, challenge_id: record.id, request_id: requestId, purpose: ticket.purpose,
      sequence: ticket.sequence || null, consumed: Boolean(ticket.consumedAt), expires_at: ticket.expiresAt,
      report_received: Boolean(report), report_sha256: report?.reportSha256 || null,
      gateway_media: observed.map(({ sequence, bytes, sha256, state }) => ({ sequence, bytes: bytes || 0, sha256: sha256 || null, state })),
      gateway_interrupt: interrupted ? { state: interrupted.state, bytes: interrupted.bytes || 0, sha256: interrupted.sha256 || null,
        code: interrupted.code || null, writing_when_cancelled: Boolean(interrupted.writing_when_cancelled) } : null,
      wire_sha256: interrupted ? wireDigest(observed, interrupted) : null, admission: await reconcile(id, { writeProof: false }) };
  }
  async function attest(raw) {
    const parsed = attestationSchema.safeParse(raw);
    demand(parsed.success, "REALTIME_ATTESTATION_INVALID", "独立观察器证明格式不正确", 400);
    const body = parsed.data, instant = clock();
    // Signature/registry validation precedes challenge lookup to avoid enumeration.
    demand(signatureIdentity(body, registry, instant), "REALTIME_ATTESTATION_UNTRUSTED", "独立观察器尚未登记、已撤销或签名无效", 401);
    demand(new Date(body.expires_at) > instant && new Date(body.observed_at) <= instant
      && new Date(body.expires_at) - new Date(body.observed_at) <= 300000, "REALTIME_ATTESTATION_EXPIRED", "独立证明已过期或时间范围不正确");
    const record = await (await table(RECORDS)).findOne({ id: body.challenge_id }); await current(record, { allowStopped: true });
    const reports = await (await table(REPORTS)).find({ challengeId: record.id }).limit(36).toArray();
    const found = reports.find((r) => r.reportSha256 === body.report_sha256);
    const observed = await (await table(MEDIA)).find({ challengeId: record.id }).sort({ sequence: 1 }).limit(10).toArray();
    const interrupted = await (await table(READERS)).findOne({ _id: `${record.id}:11` });
    demand(found && matchingAttestation(record, found.report, observed, interrupted, body), "REALTIME_ATTESTATION_MISMATCH", "独立证明与原挑战、模型或实际媒体不一致");
    const attestations = await table(ATTESTATIONS), key = `${record.id}:${body.role}`, old = await attestations.findOne({ _id: key });
    if (old) demand(witnessSha256(old.envelope) === witnessSha256(body), "REALTIME_ATTESTATION_CONFLICT", "原观察器证明已对应其他内容");
    else {
      try { await attestations.insertOne({ _id: key, challengeId: record.id, envelope: body, createdAt: instant, purgeAt: record.purgeAt }); }
      catch (error) {
        if (error.code !== 11000) throw error;
        const concurrent = await attestations.findOne({ _id: key });
        demand(concurrent && witnessSha256(concurrent.envelope) === witnessSha256(body), "REALTIME_ATTESTATION_CONFLICT", "原观察器证明已对应其他内容");
      }
    }
    return reconcile(record.id);
  }
  async function reconcile(id, { writeProof = true } = {}) {
    const record = await (await table(RECORDS)).findOne({ id });
    const reports = await (await table(REPORTS)).find({ challengeId: id }).limit(1).toArray();
    if (!record || !reports.length) return { activated: false, dispatchable: false, code: "REALTIME_PLAYBACK_WITNESS_REQUIRED" };
    const observed = await (await table(MEDIA)).find({ challengeId: id }).sort({ sequence: 1 }).limit(10).toArray();
    const interrupted = await (await table(READERS)).findOne({ _id: `${id}:11` });
    const envelopes = (await (await table(ATTESTATIONS)).find({ challengeId: id }).sort({ _id: 1 }).limit(2).toArray()).map((r) => r.envelope);
    const result = evaluateDigitalLiveWitness({ record, report: reports[0].report, observed, interrupted, attestations: envelopes, registry, now: clock() });
    if (!result.admitted) return { activated: false, dispatchable: false, code: result.code };
    await current(record, { allowStopped: true, allowExpired: !writeProof });
    const proof = { _id: witnessSha256(`${record.bindingId}:${record.providerSha256}:${record.artifactSha256}`),
      source: "automatic", status: "active", admissionVersion: DIGITAL_LIVE_WITNESS_VERSION,
      capabilityId: "digital_live.realtime", capabilityVersion: "digital-live-realtime-v1", bindingId: record.bindingId,
      nodeId: record.nodeId, userId: record.userId, computeGroupId: record.computeGroupId, artifactSha256: record.artifactSha256,
      providerSha256: record.providerSha256, testEvidenceSha256: result.evidenceSha256, challengeId: id,
      testedAt: record.stoppedAt, expiresAt: result.expiresAt, purgeAt: new Date(+result.expiresAt + 86400000),
      contractTests: { actual_provider: true, continuous_fmp4: true, played_drain: true, interrupt_generation: true, exclusive_gpu: true, realtime_asr: false } };
    // A late old callback cannot overwrite a newer accepted challenge.
    const proofs = await table(PROOFS), previous = await proofs.findOne({ _id: proof._id });
    if (!writeProof) return { activated: Boolean(previous?.status === "active" && previous.challengeId === id
      && previous.testEvidenceSha256 === result.evidenceSha256 && previous.expiresAt > clock()),
      dispatchable: Boolean(previous?.status === "active" && previous.challengeId === id && previous.testEvidenceSha256 === result.evidenceSha256
        && previous.expiresAt > clock() && !record.providers.asr_model), code: "REALTIME_WITNESS_READ_ONLY_STATUS", realtime_asr: false };
    if (!previous) { try { await proofs.insertOne(proof); } catch (error) { if (error.code !== 11000) throw error; } }
    else if (previous.testedAt <= proof.testedAt) {
      const { _id, ...values } = proof; await proofs.updateOne({ _id, challengeId: previous.challengeId }, { $set: values });
    }
    return { activated: true, dispatchable: !record.providers.asr_model, proof_expires_at: result.expiresAt, realtime_asr: false };
  }
  return { issue, open, report, state, attest, reconcile,
    async writeInterrupt(record, stream) {
      demand(stream?.getReader, "REALTIME_WITNESS_MEDIA_INVALID", "打断探针必须提供有界二进制流", 400);
      demand(relay.hasReader({ sessionId: record.id, generation: 1, sequence: 11 }), "REALTIME_WITNESS_READER_REQUIRED", "请先连接原打断探针的见证读取端");
      demand(!await (await table(MEDIA)).findOne({ _id: `${record.id}:11` }), "REALTIME_WITNESS_MEDIA_UNAVAILABLE", "原打断探针已开始，不允许重传或重跑");
      const source = await (await table(MEDIA)).findOne({ _id: `${record.id}:5`, state: "received" });
      demand(source?.bytes > 64 && source.bytes <= 4 * 1024 * 1024, "REALTIME_INTERRUPT_SOURCE_LIMIT", "第五段完整源须大于64字节且不超过4MiB，超出时本探针失败，不截断冒充");
      await (await table(MEDIA)).insertOne({ _id: `${record.id}:11`, challengeId: record.id, sequence: 11, state: "interrupt_probe", source_sequence: 5, purgeAt: record.purgeAt });
      let bytes = 0; const reader = stream.getReader(), started = +clock();
      const bounded = new ReadableStream({ async pull(controller) {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes > 4 * 1024 * 1024 || +clock() - started > 10000) {
          const error = Object.assign(new Error("打断探针超过4MiB/10秒限制"), { code: "REALTIME_INTERRUPT_LIMIT", status: 413 });
          await reader.cancel().catch(() => {}); controller.error(error); return;
        }
        controller.enqueue(next.value);
      }, cancel: (reason) => reader.cancel(reason) });
      try {
        await relay.write({ sessionId: record.id, generation: 1, sequence: 11, mimeType: record.providers.mime_type,
          validate: () => current(record) }, bounded);
        return { ok: false, code: "REALTIME_INTERRUPT_NOT_OBSERVED", message: "探针完整结束而没有在途打断，不能视为通过" };
      } catch (error) {
        const observed = await (await table(READERS)).findOne({ _id: `${record.id}:11` });
        if (error.code === "REALTIME_MEDIA_DISCONNECTED" && observed?.state === "interrupted") return { ok: true, interrupted: true, prefix_only: true };
        throw error;
      } finally { reader.releaseLock(); }
    },
    mediaReaderReady: (id, sequence) => relay.hasReader({ sessionId: id, generation: 1, sequence }),
    mediaWrite: (permit, body) => relay.write(permit, body),
    status: async (id) => ({ protocol: DIGITAL_LIVE_WITNESS_VERSION, media_ready_sequences: (await (await table(READERS)).find({ challengeId: id, state: "connected" }).limit(10).toArray())
      .filter((r) => relay.hasReader({ sessionId: id, generation: 1, sequence: r.sequence })).map((r) => r.sequence) }) };
}

/** Persisted active rows are insufficient alone: recompute the complete
 * release-registered signature and media chain at every admission lookup. */
export function createDigitalLiveRealtimeProofLookup({ getCollection, registry = DIGITAL_LIVE_WITNESS_REGISTRY }) {
  return async (node, provider, instant) => {
    if (!registry.consumers.length || registry.observers.length < 2) return null;
    const proof = await (await getCollection(PROOFS)).findOne({ bindingId: node.bindingId, artifactSha256: node.artifactSha256,
      status: "active", expiresAt: { $gt: instant }, providerSha256: witnessSha256(provider), admissionVersion: DIGITAL_LIVE_WITNESS_VERSION });
    if (!proof) return null;
    const record = await (await getCollection(RECORDS)).findOne({ id: proof.challengeId });
    const report = await (await getCollection(REPORTS)).findOne({ challengeId: proof.challengeId });
    if (!record || !report || record.providerSha256 !== proof.providerSha256 || record.bindingId !== node.bindingId || record.nodeId !== node.nodeId || record.userId !== node.executorUserId
      || !computeGroupsMatch(record.computeGroupId, node.computeGroupId) || record.artifactSha256 !== node.artifactSha256) return null;
    const observed = await (await getCollection(MEDIA)).find({ challengeId: record.id }).sort({ sequence: 1 }).limit(10).toArray();
    const interrupted = await (await getCollection(READERS)).findOne({ _id: `${record.id}:11` });
    const attestations = (await (await getCollection(ATTESTATIONS)).find({ challengeId: record.id }).sort({ _id: 1 }).limit(2).toArray()).map((r) => r.envelope);
    const result = evaluateDigitalLiveWitness({ record, report: report.report, observed, interrupted, attestations, registry, now: instant });
    return result.admitted && result.evidenceSha256 === proof.testEvidenceSha256 && result.expiresAt >= proof.expiresAt ? proof : null;
  };
}
