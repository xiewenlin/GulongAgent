import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { createDigitalLiveRealtimeService, realtimeConfig, realtimeProviderFingerprint, DIGITAL_LIVE_PCM_MIME, DIGITAL_LIVE_REALTIME_ROOT as ROOT } from "../../server/digital-live-realtime.js";
import { createDigitalLiveMediaRelay } from "../../server/digital-live-media-relay.js";
import { registerDigitalLiveRealtimeRoutes } from "../../server/digital-live-realtime-routes.js";
import { hashOpaqueToken } from "../../server/security.js";
import { createDigitalLiveCandidateVerification } from "../../server/digital-live-verification.js";
import { WHISPER_AUDIO_FIXTURE } from "../../server/capability-probe-fixtures.js";

// In-memory proofs are deliberate test doubles. These tests make no model,
// GPU, COS or production account calls and do not grant real node admission.
const providers = { text_model: "qwen38-27b-uncensored-q4-k-m", tts_model: "qwen3-tts-0.6b-base",
  avatar_model: "musetalk-1.5-stream", character_id: "c01林晚晴", voice_id: "c01",
  character_image_sha256: "1".repeat(64), voice_audio_sha256: "2".repeat(64),
  mime_type: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' };
function fixture({ accepted = true, active = true, withAsr = false } = {}) {
  const tables = new Map(), owner = String(new ObjectId());
  const binding = { _id: new ObjectId(), userId: new ObjectId(), nodeId: "memory-only-realtime-node", status: "active", revokedAt: null, computeGroupId: null };
  const selectedProviders = withAsr ? { ...providers, asr_model: "paraformer-zh" } : providers;
  const getCollection = async (name) => { if (!tables.has(name)) tables.set(name, createCapabilityMemoryCollection()); return tables.get(name); };
  tables.set("nodeAccountBindings", createCapabilityMemoryCollection([binding]));
  let instant = Date.parse("2026-10-19T08:00:00Z"), group = null, approved = accepted, entitled = active, invalidated = [], proofOverrides = {};
  const options = { getCollection, now: () => new Date(instant), readGroup: async () => group,
    readEntitlement: async () => ({ active: entitled, capabilities: entitled ? ["digital_live.use"] : [] }),
    isOwnerActive: async () => true,
    lookupRealtimeProof: async (node, provider) => approved ? {
      source: "automatic", status: "active", capabilityId: "digital_live.realtime", capabilityVersion: "digital-live-realtime-v1",
      artifactSha256: node.artifactSha256,
      bindingId: node.bindingId, nodeId: node.nodeId, userId: node.executorUserId, computeGroupId: node.computeGroupId, testEvidenceSha256: "b".repeat(64),
      providerSha256: realtimeProviderFingerprint(provider),
      testedAt: new Date(instant - 1000), expiresAt: new Date(instant + 60_000),
      contractTests: { actual_provider: true, continuous_fmp4: true, played_drain: true, interrupt_generation: true, exclusive_gpu: true, ...(withAsr ? { realtime_asr: true } : {}) },
      ...proofOverrides,
    } : null, onInvalidate: (id) => invalidated.push(id) };
  const service = createDigitalLiveRealtimeService(options);
  const request = { client_product: "digital_live", client_request_id: "memory-realtime-original-key", providers: selectedProviders };
  const lease = randomBytes(32).toString("base64url");
  const report = () => service.report(binding, { capability_version: "digital-live-realtime-v1", transport: "http-fmp4-mse-v1",
    artifact_sha256: "a".repeat(64), providers: [selectedProviders], sharing_opt_in: true,
    resources: { gpu_state: "idle", gpu_observed_at: new Date(instant).toISOString(), current_task_remaining_seconds: 0, running_task_count: 0 } });
  const create = async () => { await report(); return service.create(owner, request, request.client_request_id); };
  const ready = async () => { const created = await create(); const task = await service.claim(binding, lease); return { id: created.session.id, task }; };
  const enqueue = (id, sequence = 1) => service.mutate(owner, id, "enqueue", { generation: 1, sequence, turn_id: `memory-turn-${sequence}`, text: `真实接口测试替身 ${sequence}` });
  const event = (id, event, generation = 1) => service.workerEvent(binding, id, lease, { generation, event, providers: selectedProviders });
  return { service, owner, binding, request, lease, getCollection, options, create, ready, enqueue, event, report, invalidated, providers: selectedProviders,
    advance: (ms) => { instant += ms; }, group: (g) => { group = g; }, approve: (v) => { approved = v; }, entitlement: (v) => { entitled = v; },
    proofOverride: (values) => { proofOverrides = values; } };
}
const rejects = (operation, code) => assert.rejects(operation, (error) => error.code === code);

test("production realtime contract remains non-dispatchable and async proofs cannot open it", async () => {
  const config = realtimeConfig(); assert.equal(config.dispatchable, false); assert.equal(config.status, "integration_required");
  assert.equal(config.acceptance, "adapter_required"); assert.equal(config.transport, "http-fmp4-mse-v1");
  assert.equal(config.remote_asr.dispatchable, false); assert.deepEqual(config.remote_asr.status_values, ["integration_required", "available"]);
  const f = fixture({ accepted: false });
  const reported = await f.report(); assert.equal(reported.dispatchable, false);
  await rejects(f.create(), "REALTIME_INTEGRATION_REQUIRED");
  assert.equal((await f.getCollection("digitalLiveRealtimeSessions")).rows.length, 0);
});
test("realtime admission requires membership, exact product and a full immutable provider pair", async () => {
  const f = fixture({ active: false }); await rejects(f.create(), "DIGITAL_LIVE_SUBSCRIPTION_REQUIRED");
  f.entitlement(true); await f.report();
  for (const request of [{ ...f.request, client_product: "worklucky" }, { ...f.request, providers: { ...providers, text_model: "Qwen3-1.7B" } },
    { ...f.request, providers: { ...providers, characterPath: "C:/private/character.png" } }]) await rejects(f.service.create(f.owner, request), "REALTIME_REQUEST_INVALID");
  await rejects(f.service.create(f.owner, f.request, "a-different-request"), "REALTIME_REQUEST_INVALID");
});
test("create, request recovery and concurrency are idempotent without wallet/commission writes", async () => {
  const f = fixture(); await f.report();
  const results = await Promise.all([f.service.create(f.owner, f.request), f.service.create(f.owner, f.request)]);
  assert.equal(results[0].session.id, results[1].session.id);
  assert.equal((await f.getCollection("digitalLiveRealtimeSessions")).rows.length, 1);
  const recovered = await f.service.byRequest(f.owner, f.request.client_request_id);
  assert.equal(recovered.id, results[0].session.id); assert.deepEqual(recovered.billing, { price_fen: 0, charge_status: "exempt", commission_fen: 0 });
  for (const name of ["wallets", "walletLedgers"]) assert.equal((await f.getCollection(name)).rows.length, 0);
  await rejects(f.service.create(f.owner, { ...f.request, providers: { ...providers, voice_id: "c02" } }), "REALTIME_IDEMPOTENCY_CONFLICT");
});
test("other accounts cannot query, expire, interrupt or read a private session", async () => {
  const f = fixture(), { id } = await f.ready(), stranger = String(new ObjectId()); f.advance(16_000);
  await rejects(f.service.get(stranger, id), "REALTIME_SESSION_NOT_FOUND");
  await rejects(f.service.mutate(stranger, id, "cancel"), "REALTIME_SESSION_NOT_FOUND");
  assert.equal((await f.getCollection("digitalLiveRealtimeSessions")).rows[0].state, "ready");
  assert.equal((await f.service.get(f.owner, id)).state, "expired");
});
test("node binding, provider proof, sharing choice and authoritative groups are rechecked", async () => {
  const f = fixture(), { id } = await f.ready();
  await rejects(f.service.workerState({ ...f.binding, _id: new ObjectId() }, id, f.lease), "REALTIME_SESSION_NOT_FOUND");
  await rejects(f.service.workerState(f.binding, id, "b".repeat(43)), "REALTIME_LEASE_INVALID");
  f.approve(false); await rejects(f.service.workerState(f.binding, id, f.lease), "REALTIME_INTEGRATION_REQUIRED");
  f.approve(true); f.group("new-group"); await rejects(f.service.workerState(f.binding, id, f.lease), "COMPUTE_GROUP_MISMATCH");
  assert.equal(f.invalidated.includes(id), true);
});
test("worker claim repeats only with the original lease and has no requester or wallet fields", async () => {
  const f = fixture(), { id, task } = await f.ready();
  assert.equal((await f.service.claim(f.binding, f.lease)).id, id);
  assert.equal(await f.service.claim(f.binding, "b".repeat(43)), null);
  const json = JSON.stringify(task); for (const field of ["ownerId", "requester", "bindingId", "wallet", "email", "workerTokenHash"]) assert.equal(json.includes(field), false);
});
test("enqueue deduplication survives played removal and bounded queue enforces backpressure", async () => {
  const f = fixture(), { id } = await f.ready();
  await f.enqueue(id); await f.enqueue(id); await f.enqueue(id, 2); await f.enqueue(id, 3);
  await rejects(f.enqueue(id, 4), "REALTIME_BACKPRESSURE");
  await rejects(f.service.mutate(f.owner, id, "enqueue", { generation: 1, sequence: 1, turn_id: "memory-turn-1", text: "changed" }), "REALTIME_SEQUENCE_CONFLICT");
  await f.service.mediaSent(id, 1, 1);
  await f.service.mutate(f.owner, id, "played", { generation: 1, sequence: 1, turn_id: "memory-turn-1" });
  await f.enqueue(id); assert.equal((await f.service.get(f.owner, id)).pending_sentences, 2);
});
test("drained requires both actual transfer completion and ordered played ACK, not upload or generation alone", async () => {
  const f = fixture(), { id } = await f.ready(); await f.enqueue(id);
  await rejects(f.event(id, "finished"), "REALTIME_NOT_DRAINABLE");
  await rejects(f.service.mutate(f.owner, id, "played", { generation: 1, sequence: 1, turn_id: "memory-turn-1" }), "REALTIME_PLAYED_OUT_OF_ORDER");
  await f.service.mediaSent(id, 1, 1); await f.event(id, "finished");
  assert.equal((await f.service.get(f.owner, id)).drained, false);
  await f.service.mutate(f.owner, id, "played", { generation: 1, sequence: 1, turn_id: "memory-turn-1" });
  assert.equal((await f.service.get(f.owner, id)).drained, true);
});
test("interrupt is generation-fenced, idempotent and never releases the GPU on the first ACK", async () => {
  const f = fixture(), { id } = await f.ready(); await f.enqueue(id);
  const operation = { generation: 1, request_id: "memory-interrupt-original" };
  assert.equal((await f.service.mutate(f.owner, id, "interrupt", operation)).generation, 2);
  assert.equal((await f.service.mutate(f.owner, id, "interrupt", operation)).generation, 2);
  await rejects(f.event(id, "finished", 1), "REALTIME_GENERATION_MISMATCH");
  await rejects(f.service.mediaSent(id, 1, 1), "REALTIME_GENERATION_MISMATCH");
  await f.event(id, "interrupted", 2); assert.equal((await f.service.get(f.owner, id)).drained, true);
  assert.equal((await f.getCollection("capabilityNodeSlots")).rows[0].leases.length, 1);
});
test("cancel tombstones stop delayed create, and a worker stopped ACK alone releases its exact slot", async () => {
  const f = fixture();
  const tombstone = await f.service.cancelByRequest(f.owner, f.request.client_request_id);
  assert.equal(tombstone.state, "cancelled"); assert.equal((await f.create()).session.state, "cancelled");
  const g = fixture(), { id } = await g.ready();
  const cancelled = await g.service.mutate(g.owner, id, "cancel"); assert.equal(cancelled.cancellation_pending, true);
  assert.equal((await g.getCollection("capabilityNodeSlots")).rows[0].leases.length, 1);
  await g.event(id, "stopped", cancelled.generation);
  assert.equal((await g.getCollection("capabilityNodeSlots")).rows[0].leases.length, 0);
});
test("client liveness, worker lease and membership cannot be resurrected by a late heartbeat", async () => {
  const f = fixture(), { id } = await f.ready(); f.advance(16_000);
  await rejects(f.event(id, "heartbeat"), "REALTIME_SESSION_ENDED");
  assert.equal((await f.service.get(f.owner, id)).state, "expired");
  const g = fixture(), { id: id2 } = await g.ready(); g.entitlement(false);
  await rejects(g.event(id2, "heartbeat"), "DIGITAL_LIVE_SUBSCRIPTION_REQUIRED");
  assert.equal((await g.service.get(g.owner, id2)).state, "cancelling");
});
test("media tickets are one-use, short, owner/product/generation/origin bound and stored only as hashes", async () => {
  const f = fixture(), { id } = await f.ready(); await f.enqueue(id);
  const body = { generation: 1, sequence: 1, origin: "https://www.sologle.com" };
  await rejects(f.service.ticket(f.owner, id, { ...body, origin: "https://evil.example" }), "REALTIME_ORIGIN_INVALID");
  const ticket = await f.service.ticket(f.owner, id, body);
  assert.equal(ticket.media_url.includes(ticket.ticket), false);
  assert.equal(JSON.stringify((await f.getCollection("digitalLiveRealtimeTickets")).rows).includes(ticket.ticket), false);
  await rejects(f.service.consumeTicket(id, 1, 1, ticket.ticket, "https://evil.example"), "REALTIME_MEDIA_TICKET_INVALID");
  assert.equal((await f.service.consumeTicket(id, 1, 1, ticket.ticket, body.origin)).sequence, 1);
  await rejects(f.service.consumeTicket(id, 1, 1, ticket.ticket, body.origin), "REALTIME_MEDIA_TICKET_INVALID");
});
test("old-generation and expired tickets never reopen media", async () => {
  const f = fixture(), { id } = await f.ready(); await f.enqueue(id);
  const ticket = await f.service.ticket(f.owner, id, { generation: 1, sequence: 1, origin: "https://www.sologle.com" });
  await f.service.mutate(f.owner, id, "interrupt", { generation: 1, request_id: "memory-interrupt-original" });
  await rejects(f.service.consumeTicket(id, 1, 1, ticket.ticket, "https://www.sologle.com"), "REALTIME_GENERATION_MISMATCH");
  f.advance(31_000); await rejects(f.service.consumeTicket(id, 1, 1, ticket.ticket, "https://www.sologle.com"), "REALTIME_MEDIA_TICKET_INVALID");
});

function box(type, data = Buffer.alloc(4)) { const b = Buffer.alloc(8 + data.length); b.writeUInt32BE(b.length); b.write(type, 4, 4, "ascii"); data.copy(b, 8); return b; }
const fmp4 = () => Buffer.concat([box("ftyp"), box("moov"), box("moof"), box("mdat", Buffer.alloc(16, 1))]);
const permit = { sessionId: "memory-session", generation: 1, sequence: 1, mimeType: providers.mime_type };
function bodyStream(bytes, chunk = 7) { return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.subarray(i, i + chunk)); c.close(); } }); }
test("fMP4 relay streams the exact original bytes across arbitrary boundaries without base64/files", async () => {
  const sent = [], relay = createDigitalLiveMediaRelay({ onSent: (...args) => sent.push(args) });
  const stream = relay.open(permit), bytes = fmp4();
  const read = new Response(stream).arrayBuffer(); const result = await relay.write(permit, bodyStream(bytes));
  assert.equal(result.bytes, bytes.length); assert.deepEqual(Buffer.from(await read), bytes);
  assert.deepEqual(sent[0].slice(0, 3), [permit.sessionId, 1, 1]);
  assert.deepEqual(sent[0][3], { bytes: bytes.length, sha256: result.sha256 }); assert.equal(relay.activeCount(), 0);
});
test("relay rejects missing readers, duplicate writes, foreign formats and incomplete MP4", async () => {
  const relay = createDigitalLiveMediaRelay(); await rejects(relay.write(permit, bodyStream(fmp4())), "REALTIME_MEDIA_READER_REQUIRED");
  for (const bytes of [Buffer.from("not an mp4 at all"), box("ftyp"), fmp4().subarray(0, 22)]) {
    const stream = relay.open(permit), read = new Response(stream).arrayBuffer().catch(() => null);
    await rejects(relay.write(permit, bodyStream(bytes)), "REALTIME_FMP4_INVALID"); await read;
  }
  assert.equal(relay.activeCount(), 0);
});
test("relay bounds total bytes/connection count and cancels only its own session", async () => {
  const failed = [], relay = createDigitalLiveMediaRelay({ maxStreams: 1, maxBytes: 32, onFailed: (id) => failed.push(id) });
  const stream = relay.open(permit); const read = new Response(stream).arrayBuffer().catch(() => null);
  assert.throws(() => relay.open({ ...permit, sessionId: "another-session" }), { code: "REALTIME_GATEWAY_BUSY" });
  relay.invalidate("not-owned-session"); assert.equal(relay.activeCount(), 1);
  await rejects(relay.write(permit, bodyStream(fmp4())), "REALTIME_MEDIA_LIMIT"); await read;
  assert.deepEqual(failed, [permit.sessionId]);
});
test("disconnect invalidates the exact media session; queued bytes do not imply played/drained", async () => {
  const failed = [], relay = createDigitalLiveMediaRelay({ onFailed: (id) => failed.push(id) });
  const stream = relay.open(permit); await stream.cancel();
  assert.equal(relay.activeCount(), 0); assert.deepEqual(failed, [permit.sessionId]);
});
test("HTTP routes expose reviewable schema but reject anonymous access and Vercel in-memory pairing", async () => {
  const app = new OpenAPIHono();
  registerDigitalLiveRealtimeRoutes(app, { authenticate: async (c) => ({ error: c.json({ code: "UNAUTHORIZED", message: "请先登录" }, 401) }),
    requireTrustedMutation: () => null, enforceRateLimit: async () => ({ allowed: true }), getCollection: async () => createCapabilityMemoryCollection() });
  assert.equal((await app.request(`${ROOT}/sessions`, { method: "POST" })).status, 401);
  assert.equal((await app.request(`${ROOT}/nodes/report`, { method: "POST" })).status, 401);
  assert.equal((await app.request(`${ROOT}/sessions/x/media/1/1`)).status, 421);
  const config = await (await app.request(`${ROOT}/config`)).json(); assert.equal(config.dispatchable, false);
  const document = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "memory", version: "1" } });
  assert.ok(document.paths[`${ROOT}/sessions/{id}/interrupt`]); assert.ok(document.components.schemas.DigitalLiveRealtimeContract);
  assert.equal((await app.request(`${ROOT}/sessions/x/media/1/1`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status, 403);
});
test("provider mismatch is never silently replaced with another model or voice", async () => {
  const f = fixture(), { id } = await f.ready();
  await rejects(f.service.workerEvent(f.binding, id, f.lease, { generation: 1, event: "heartbeat", providers: { ...providers, voice_id: "c02" } }), "REALTIME_PROVIDER_MISMATCH");
});

const turnBody = (n = 1) => ({ generation: 1, turn_id: `memory-complete-turn-${n}`, request_id: `memory-turn-request-${n}`, user_text: "请给我一句简短问候", history: [] });
function streamEvent(body, n, event, extra = {}) { return { generation: body.generation, event_id: `memory-stream-event-${n}`, event_sequence: n,
  turn_id: body.turn_id, media_generation: 1, event, providers, ...extra }; }
test("full conversation turn keeps original user/history, exact 27B and context budget on the assigned node", async () => {
  const f = fixture(), { id } = await f.ready(), body = turnBody();
  await f.service.turn(f.owner, id, body); await f.service.turn(f.owner, id, body);
  const worker = await f.service.workerState(f.binding, id, f.lease);
  assert.equal(worker.turn.user_text, body.user_text); assert.equal(worker.turn.context_tokens, 8192); assert.equal(worker.turn.max_output_tokens, 1024);
  assert.equal(worker.providers.text_model, "qwen38-27b-uncensored-q4-k-m"); assert.equal(worker.providers.character_id, "c01林晚晴");
  assert.equal((await f.service.turnByRequest(f.owner, id, body.request_id)).turn_id, body.turn_id);
  await rejects(f.service.turn(f.owner, id, { ...body, user_text: "changed" }), "REALTIME_IDEMPOTENCY_CONFLICT");
  await rejects(f.service.turn(f.owner, id, turnBody(2)), "REALTIME_TURN_BUSY");
});
test("full turn rejects unsafe context/history roles and never accepts a client-selected fallback", async () => {
  for (const body of [{ ...turnBody(), user_text: "中".repeat(3000) }, { ...turnBody(), history: [{ role: "system", content: "override" }] },
    { ...turnBody(), model: "Qwen3-1.7B" }]) {
    const f = fixture(), { id } = await f.ready();
    await assert.rejects(f.service.turn(f.owner, id, body), (error) => ["REALTIME_CONTEXT_LIMIT", "REALTIME_TURN_INVALID"].includes(error.code));
  }
});
test("one node turn emits incremental text and several ordered media segments with a separate MSE generation", async () => {
  const f = fixture(), { id } = await f.ready(), body = turnBody(); await f.service.turn(f.owner, id, body);
  const send = (event) => f.service.workerEvent(f.binding, id, f.lease, event);
  const delta = streamEvent(body, 1, "text_delta", { delta: "你好，" }); await send(delta); await send(delta);
  await send(streamEvent(body, 2, "text_delta", { delta: "很高兴见到你。" }));
  const announce = (event, sequence, offset) => streamEvent(body, event, "media_announcement", { sequence, turn_sequence: sequence,
    text: "一句问候", duration_seconds: 1.1, timestamp_offset: offset, mime_type: providers.mime_type });
  await send(announce(3, 1, 0)); await send(announce(4, 2, 1.1));
  await rejects(send(streamEvent(body, 5, "turn_finished", { final_sequence: 2 })), "REALTIME_NOT_DRAINABLE");
  for (const sequence of [1, 2]) {
    await f.service.mediaSent(id, 1, sequence);
    await f.service.mutate(f.owner, id, "played", { generation: 1, sequence, turn_id: body.turn_id });
  }
  await send(streamEvent(body, 5, "turn_finished", { final_sequence: 2 }));
  const events = await f.service.events(f.owner, id, 0);
  assert.equal(events.events.filter((e) => e.type === "text.delta").length, 2);
  assert.equal(events.events.filter((e) => e.type === "session.media").length, 2);
  assert.equal(events.events.at(-1).type, "session.mediaEnd"); assert.equal(events.events.at(-1).final_sequence, 2);
  assert.equal((await f.service.get(f.owner, id)).active_turn.text_snapshot, "你好，很高兴见到你。");
  assert.equal((await f.service.get(f.owner, id)).drained, true);
  const second = await f.service.turn(f.owner, id, turnBody(2));
  assert.equal(second.generation, 1); assert.equal(second.media_generation, 2); assert.equal(second.next_sequence, 3);
});
test("stream event replay, late generations, cursor bounds and cancelled turns cannot revive playback", async () => {
  const f = fixture(), { id } = await f.ready(), body = turnBody(); await f.service.turn(f.owner, id, body);
  const delta = streamEvent(body, 1, "text_delta", { delta: "hello" });
  await f.service.workerEvent(f.binding, id, f.lease, delta);
  await rejects(f.service.workerEvent(f.binding, id, f.lease, { ...delta, delta: "different" }), "REALTIME_IDEMPOTENCY_CONFLICT");
  await rejects(f.service.events(f.owner, id, 999), "REALTIME_CURSOR_INVALID");
  await f.service.mutate(f.owner, id, "cancel");
  await rejects(f.service.workerEvent(f.binding, id, f.lease, { ...delta, generation: 2, event_sequence: 2, event_id: "memory-stream-event-2" }), "REALTIME_SESSION_ENDED");
});
test("complete-turn media tickets bind turn, MSE generation and turn-local sequence", async () => {
  const f = fixture(), { id } = await f.ready(), body = turnBody(); await f.service.turn(f.owner, id, body);
  await f.service.workerEvent(f.binding, id, f.lease, streamEvent(body, 1, "media_announcement", {
    sequence: 1, turn_sequence: 1, text: "你好", duration_seconds: 1.1, timestamp_offset: 0, mime_type: providers.mime_type }));
  const request = { generation: 1, sequence: 1, origin: "https://www.sologle.com" };
  await rejects(f.service.ticket(f.owner, id, request), "REALTIME_TURN_MISMATCH");
  const ticket = await f.service.ticket(f.owner, id, { ...request, turn_id: body.turn_id, media_generation: 1, turn_sequence: 1 });
  assert.equal(ticket.turn_id, body.turn_id); assert.equal(ticket.media_generation, 1); assert.equal(ticket.duration_seconds, 1.1);
  assert.equal(ticket.timestamp_offset, 0); assert.equal(ticket.mime_type, providers.mime_type);
});
test("authenticated HTTP turn/events/ticket/stream handlers pair exact bytes and expose reader-ready before PUT", async () => {
  const f = fixture(), { id } = await f.ready(), body = turnBody(), app = new OpenAPIHono(), token = `gab_${"R".repeat(48)}`;
  await (await f.getCollection("nodeAccountBindings")).updateOne({ _id: f.binding._id }, { $set: { tokenHash: hashOpaqueToken(token, "h3-account-binding") } });
  await (await f.getCollection("users")).insertOne({ _id: f.binding.userId, status: "active" });
  registerDigitalLiveRealtimeRoutes(app, { service: f.service, getCollection: f.getCollection, mediaEnabled: () => true,
    authenticate: async () => ({ kind: "desktop-gulong-engine", user: { id: f.owner } }), requireTrustedMutation: () => null,
    enforceRateLimit: async () => ({ allowed: true }) });
  const post = (path, data, headers = {}) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
  assert.equal((await post(`${ROOT}/sessions/${id}/turns`, body)).status, 200);
  const nodeHeaders = { "X-Gulong-Account-Binding": token, "X-Gulong-Realtime-Lease": f.lease };
  assert.equal((await post(`${ROOT}/sessions/${id}/worker-events`, streamEvent(body, 1, "media_announcement", {
    sequence: 1, turn_sequence: 1, text: "你好", duration_seconds: 1.1, timestamp_offset: 0, mime_type: providers.mime_type }), nodeHeaders)).status, 200);
  const ticketResponse = await post(`${ROOT}/sessions/${id}/media-ticket`, { generation: 1, sequence: 1, turn_id: body.turn_id,
    media_generation: 1, turn_sequence: 1, origin: "https://www.sologle.com" });
  const ticket = await ticketResponse.json();
  const mediaPath = new URL(ticket.media_url).pathname;
  const response = await app.request(mediaPath, { headers: { Authorization: `DigitalLiveMedia ${ticket.ticket}`, Origin: "https://www.sologle.com" } });
  assert.equal(response.status, 200); const reading = response.arrayBuffer();
  const state = await (await app.request(`${ROOT}/sessions/${id}/worker-state`, { headers: nodeHeaders })).json();
  assert.equal(state.session.queue[0].media_reader_ready, true);
  const bytes = fmp4(), uploaded = await app.request(mediaPath, { method: "PUT", headers: { ...nodeHeaders, "Content-Type": providers.mime_type }, body: bytes });
  assert.equal(uploaded.status, 200); assert.deepEqual(Buffer.from(await reading), bytes);
  assert.equal((await post(`${ROOT}/nodes/claim`, { dry_run: true }, nodeHeaders)).status, 200);
});
test("authenticated provider catalog returns exact verified combinations, not inventory, guessed models or foreign proofs", async () => {
  const f = fixture({ accepted: false }); await f.report();
  assert.deepEqual((await f.service.catalog(f.owner)).providers, []);
  f.approve(true);
  const catalog = await f.service.catalog(f.owner, { character_id: "c01林晚晴", voice_id: "c01", character_image_sha256: providers.character_image_sha256 });
  assert.equal(catalog.providers.length, 1); assert.deepEqual(catalog.providers[0].providers, providers); assert.equal(catalog.dispatchable, true);
  assert.deepEqual((await f.service.catalog(f.owner, { character_id: "c01" })).providers, []);
  f.proofOverride({ bindingId: String(new ObjectId()) }); assert.deepEqual((await f.service.catalog(f.owner)).providers, []);
  await rejects(f.create(), "REALTIME_INTEGRATION_REQUIRED");
  f.proofOverride({}); f.group("different-group"); assert.deepEqual((await f.service.catalog(f.owner)).providers, []);
});
test("realtime admission does not race a leased legacy MiniMax H3 video task", async () => {
  const f = fixture(); await f.report();
  await (await f.getCollection("h3SharedTasks")).insertOne({ status: "processing", claimLeaseUntil: new Date("2026-10-19T08:01:00Z"),
    claimedByNode: { bindingId: f.binding._id } });
  await rejects(f.create(), "REALTIME_INTEGRATION_REQUIRED");
});
test("controlled interruption closes only the old stream without converting the new turn into a disconnect failure", async () => {
  const failed = [], relay = createDigitalLiveMediaRelay({ onFailed: (id) => failed.push(id) });
  const stream = relay.open(permit), read = new Response(stream).arrayBuffer().catch(() => null);
  relay.invalidate(permit.sessionId); await read;
  assert.equal(relay.activeCount(), 0); assert.deepEqual(failed, []);
});
test("bounded event cursors expire instead of accumulating an unlimited token history", async () => {
  const f = fixture(), { id } = await f.ready(), body = turnBody(); await f.service.turn(f.owner, id, body);
  for (let i = 1; i <= 130; i += 1) await f.service.workerEvent(f.binding, id, f.lease, streamEvent(body, i, "text_delta", { delta: "x" }));
  await rejects(f.service.events(f.owner, id, 0), "REALTIME_CURSOR_EXPIRED");
  const snapshot = await f.service.get(f.owner, id); assert.equal(snapshot.active_turn.text_snapshot.length, 130);
  assert.equal((await f.service.events(f.owner, id, 3)).events.length, 128);
});

const asrRequest = () => ({ generation: 1, request_id: "memory-asr-request-1", turn_id: "memory-asr-turn-1", utterance_id: "memory-utterance-1", history: [] });
test("remote ASR requires its own exact proved model and original utterance identity", async () => {
  const f = fixture(), { id } = await f.ready(); await rejects(f.service.beginAsr(f.owner, id, asrRequest()), "REALTIME_ASR_INTEGRATION_REQUIRED");
  const g = fixture({ withAsr: true }), { id: next } = await g.ready();
  await g.service.beginAsr(g.owner, next, asrRequest()); await g.service.beginAsr(g.owner, next, asrRequest());
  assert.equal((await g.service.workerState(g.binding, next, g.lease)).input_audio.model, "paraformer-zh");
  assert.equal((await g.service.asrByRequest(g.owner, next, asrRequest().request_id)).state, "awaiting_audio");
  await rejects(g.service.beginAsr(g.owner, next, { ...asrRequest(), history: [{ role: "user", content: "changed" }] }), "REALTIME_IDEMPOTENCY_CONFLICT");
});
test("ASR catalog admission is explicit and uses exact proved combinations, not the installed model name", async () => {
  const f = fixture({ withAsr: true }); await f.report();
  const open = await f.service.catalog(f.owner);
  assert.deepEqual(open.remote_asr, { status: "available", dispatchable: true });
  assert.equal(open.providers[0].asr_dispatchable, true); assert.equal(open.providers[0].proof.realtime_asr_verified, true);
  f.proofOverride({ contractTests: { actual_provider: true, continuous_fmp4: true, played_drain: true, interrupt_generation: true, exclusive_gpu: true } });
  const closed = await f.service.catalog(f.owner);
  assert.deepEqual(closed.remote_asr, { status: "integration_required", dispatchable: false }); assert.deepEqual(closed.providers, []);
});
test("authenticated new-session config derives ASR readiness from the exact real-proof catalog while anonymous stays closed", async () => {
  const f = fixture({ withAsr: true }); await f.report(); const app = new OpenAPIHono();
  registerDigitalLiveRealtimeRoutes(app, { service: f.service, getCollection: f.getCollection,
    authenticate: async () => ({ user: { id: f.owner } }), requireTrustedMutation: () => null, enforceRateLimit: async () => ({ allowed: true }) });
  const anonymous = await (await app.request(`${ROOT}/config`)).json(); assert.equal(anonymous.remote_asr.dispatchable, false);
  const ready = await (await app.request(`${ROOT}/config`, { headers: { Authorization: "Bearer memory-not-a-real-account" } })).json();
  assert.equal(ready.remote_asr.dispatchable, true); assert.equal(ready.remote_asr.status, "available");
  f.approve(false);
  const rejected = await (await app.request(`${ROOT}/config`, { headers: { Authorization: "Bearer memory-not-a-real-account" } })).json();
  assert.equal(rejected.remote_asr.dispatchable, false); assert.equal(rejected.remote_asr.status, "integration_required");
});
test("ASR input ticket is one-use, waits for node reader and forbids re-upload after input begins", async () => {
  const f = fixture({ withAsr: true }), { id } = await f.ready(), body = asrRequest(); await f.service.beginAsr(f.owner, id, body);
  const ticketBody = { generation: 1, utterance_id: body.utterance_id, origin: "https://www.sologle.com" };
  const ticket = await f.service.inputTicket(f.owner, id, ticketBody);
  await rejects(f.service.consumeInputTicket(id, 1, body.utterance_id, ticket.ticket, ticketBody.origin), "REALTIME_ASR_READER_REQUIRED");
  await f.service.audioReaderReady(id, 1, body.utterance_id);
  await f.service.consumeInputTicket(id, 1, body.utterance_id, ticket.ticket, ticketBody.origin);
  await rejects(f.service.inputTicket(f.owner, id, ticketBody), "REALTIME_ASR_INPUT_UNCERTAIN");
  await rejects(f.service.consumeInputTicket(id, 1, body.utterance_id, ticket.ticket, ticketBody.origin), "REALTIME_INPUT_TICKET_INVALID");
});
test("whole ASR digest binds partial/final to the same original turn and final never executes twice", async () => {
  const f = fixture({ withAsr: true }), { id } = await f.ready(), body = asrRequest(); await f.service.beginAsr(f.owner, id, body);
  await f.service.audioReaderReady(id, 1, body.utterance_id);
  const ticket = await f.service.inputTicket(f.owner, id, { generation: 1, utterance_id: body.utterance_id, origin: "https://www.sologle.com" });
  await f.service.consumeInputTicket(id, 1, body.utterance_id, ticket.ticket, "https://www.sologle.com");
  const base = { generation: 1, providers: f.providers, utterance_id: body.utterance_id, turn_id: body.turn_id, text: "你好" };
  await f.service.workerEvent(f.binding, id, f.lease, { ...base, event: "asr_partial", event_id: "memory-asr-event-1", event_sequence: 1 });
  const final = { ...base, event: "asr_final", event_id: "memory-asr-event-2", event_sequence: 2, input_sha256: "a".repeat(64), input_bytes: 3200 };
  await rejects(f.service.workerEvent(f.binding, id, f.lease, final), "REALTIME_ASR_INPUT_UNCERTAIN");
  await f.service.audioReceived(id, 1, body.utterance_id, { sha256: final.input_sha256, bytes: 3200 });
  await f.service.workerEvent(f.binding, id, f.lease, final); await f.service.workerEvent(f.binding, id, f.lease, final);
  const worker = await f.service.workerState(f.binding, id, f.lease);
  assert.equal(worker.turn.request_id, body.request_id); assert.equal(worker.turn.user_text, "你好"); assert.equal(worker.turn.context_tokens, 8192);
  const events = await f.service.events(f.owner, id, 0); assert.equal(events.events.filter((e) => e.type === "asr.final").length, 1);
  const finalEvent = events.events.find((e) => e.type === "asr.final");
  assert.equal(finalEvent.input_sha256, final.input_sha256); assert.equal(finalEvent.input_bytes, 3200);
  const snapshot = await f.service.get(f.owner, id);
  assert.equal(snapshot.active_asr.input_sha256, final.input_sha256); assert.equal(snapshot.active_asr.input_bytes, 3200);
  assert.equal(snapshot.active_asr.request_id, body.request_id); assert.equal(snapshot.active_asr.event_cursor_start, finalEvent.cursor);
});
test("PCM input relays original binary bytes/digest without storage or base64 and rejects incomplete samples", async () => {
  const received = [], relay = createDigitalLiveMediaRelay({ format: "pcm16", maxBytes: 640000, onSent: (...args) => received.push(args) });
  const permit = { sessionId: "memory-voice", generation: 1, sequence: "utterance-1", mimeType: DIGITAL_LIVE_PCM_MIME }, pcm = Buffer.alloc(3200, 4);
  const output = new Response(relay.open(permit)).arrayBuffer(), result = await relay.write(permit, bodyStream(pcm, 113));
  assert.deepEqual(Buffer.from(await output), pcm); assert.equal(result.sha256.length, 64); assert.equal(received[0][3].bytes, 3200);
  const badRead = new Response(relay.open(permit)).arrayBuffer().catch(() => null);
  await rejects(relay.write(permit, bodyStream(Buffer.alloc(3))), "REALTIME_PCM_INVALID"); await badRead;
});
test("ASR final after generation interruption cannot revive a transcript or dispatch a model turn", async () => {
  const f = fixture({ withAsr: true }), { id } = await f.ready(), body = asrRequest(); await f.service.beginAsr(f.owner, id, body);
  await f.service.mutate(f.owner, id, "interrupt", { generation: 1, request_id: "memory-asr-interrupt" });
  await rejects(f.service.audioReceived(id, 1, body.utterance_id, { bytes: 3200, sha256: "a".repeat(64) }), "REALTIME_GENERATION_MISMATCH");
  assert.equal((await f.service.get(f.owner, id)).active_turn, null);
});

async function candidateFixture(withAsr = false) {
  const f = fixture({ withAsr }); await f.report();
  await (await f.getCollection("users")).insertOne({ _id: f.binding.userId, status: "active" });
  let fixtureCalls = 0;
  const verification = createDigitalLiveCandidateVerification({ getCollection: f.getCollection, now: f.options.now,
    issueInputs: async () => { fixtureCalls += 1; return [{ fixture_id: WHISPER_AUDIO_FIXTURE.fixture_id, sha256: WHISPER_AUDIO_FIXTURE.sha256,
      download_url: "https://fixture.invalid/not-a-real-object" }]; } });
  const body = { request_id: "memory-candidate-original", lease_token: randomBytes(32).toString("base64url"),
    provider_sha256: realtimeProviderFingerprint(f.providers), mode: withAsr ? "asr" : "media", dry_run: false };
  return { ...f, verification, body, fixtureCalls: () => fixtureCalls };
}
const candidateClaims = (f) => ({ actual_provider_sha256: f.body.provider_sha256, completed_turns: 10,
  played_sequences: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ended: true, interrupt: { before_generation: 1, after_generation: 2, stopped_ms: 20 } });
test("candidate dry-run is authenticated reachability only and issues no challenge, budget or physical lease", async () => {
  const f = await candidateFixture(), result = await f.verification.next(f.binding, { dry_run: true });
  assert.equal(result.challenge, null); assert.equal(result.activated, false);
  for (const name of ["digitalLiveRealtimeVerifications", "capabilityNodeSlots", "capabilityVerificationBudgets"]) assert.equal((await f.getCollection(name)).rows.length, 0);
});
test("candidate challenge uses original request and caller-held secret, bounded prompts and shared exclusive slots", async () => {
  const f = await candidateFixture(), one = await f.verification.next(f.binding, f.body), repeat = await f.verification.next(f.binding, f.body);
  assert.equal(one.challenge.id, repeat.challenge.id); assert.equal(one.challenge.activated, false); assert.equal(one.challenge.probe.turns.length, 10);
  assert.equal(one.challenge.budget.max_output_tokens_per_turn, 32);
  const recovered = await f.verification.byRequest(f.binding, f.body.request_id, f.body.lease_token); assert.equal(recovered.id, one.challenge.id);
  await rejects(f.verification.get(f.binding, recovered.id, "z".repeat(43)), "REALTIME_VERIFICATION_LEASE_INVALID");
  assert.equal((await f.getCollection("capabilityNodeSlots")).rows[0].leases[0].exclusive, true);
  assert.equal(JSON.stringify(recovered).includes(f.body.lease_token), false);
  assert.equal((await f.getCollection("digitalLiveRealtimeVerifications")).rows[0].leaseTokenHash.length, 64);
});
test("client success claims without actual gateway media never become an active realtime proof", async () => {
  const f = await candidateFixture(), { challenge } = await f.verification.next(f.binding, f.body);
  const result = await f.verification.submit(f.binding, challenge.id, f.body.lease_token, candidateClaims(f));
  assert.equal(result.state, "awaiting_runtime_witness"); assert.equal(result.activated, false);
  assert.equal((await f.getCollection("capabilityAutoVerifications")).rows.length, 0);
  const repeated = await f.verification.submit(f.binding, challenge.id, f.body.lease_token, candidateClaims(f)); assert.equal(repeated.id, challenge.id);
  assert.equal((await f.getCollection("capabilityNodeSlots")).rows[0].leases.length, 1, "result is not stopped ACK");
  await f.verification.stopped(f.binding, challenge.id, f.body.lease_token, { owned_worker_stopped: true });
  assert.equal((await f.getCollection("capabilityNodeSlots")).rows[0].leases.length, 0);
});
test("ten actual bounded wire streams retain hashes only and still require real neural/playback validation", async () => {
  const f = await candidateFixture(), { challenge } = await f.verification.next(f.binding, f.body);
  for (let sequence = 1; sequence <= 10; sequence += 1) await f.verification.collect(f.binding, challenge.id, f.body.lease_token, sequence,
    bodyStream(fmp4()), providers.mime_type);
  await rejects(f.verification.collect(f.binding, challenge.id, f.body.lease_token, 1, bodyStream(fmp4()), providers.mime_type), "REALTIME_VERIFICATION_MEDIA_UNCERTAIN");
  const rows = (await f.getCollection("digitalLiveRealtimeVerificationMedia")).rows;
  assert.equal(rows.length, 10); assert.equal(rows.every((row) => row.state === "received" && row.bytes === fmp4().length && row.sha256.length === 64), true);
  assert.equal(rows.some((row) => "body" in row || "audio" in row || "base64" in row), false);
  const result = await f.verification.submit(f.binding, challenge.id, f.body.lease_token, candidateClaims(f));
  assert.equal(result.state, "adapter_required"); assert.equal(result.activated, false); assert.equal((await f.getCollection("capabilityAutoVerifications")).rows.length, 0);
});
test("candidate media and recovery reject foreign bindings, changed groups and expired leases", async () => {
  const f = await candidateFixture(), { challenge } = await f.verification.next(f.binding, f.body);
  await rejects(f.verification.get({ ...f.binding, _id: new ObjectId() }, challenge.id, f.body.lease_token), "REALTIME_VERIFICATION_NOT_FOUND");
  await rejects(f.verification.get({ ...f.binding, computeGroupId: "another" }, challenge.id, f.body.lease_token), "COMPUTE_GROUP_MISMATCH");
  f.advance(901000);
  await rejects(f.verification.collect(f.binding, challenge.id, f.body.lease_token, 1, bodyStream(fmp4()), providers.mime_type), "REALTIME_VERIFICATION_EXPIRED");
  assert.equal((await f.verification.get(f.binding, challenge.id, f.body.lease_token)).lease_valid, false);
});
test("candidate budgets remain two daily and share the existing total node verification budget", async () => {
  const f = await candidateFixture();
  for (let n = 1; n <= 2; n += 1) {
    const { challenge } = await f.verification.next(f.binding, { ...f.body, request_id: `memory-candidate-${n}` });
    await f.verification.stopped(f.binding, challenge.id, f.body.lease_token, { owned_worker_stopped: true });
  }
  await rejects(f.verification.next(f.binding, { ...f.body, request_id: "memory-candidate-3" }), "REALTIME_VERIFICATION_BUDGET_EXHAUSTED");
  assert.equal((await f.getCollection("capabilityVerificationBudgets")).rows[0].count, 2);
});
test("ASR candidate issues only the server-fixed full audio fixture and a transcript claim is never activation", async () => {
  const f = await candidateFixture(true), { challenge } = await f.verification.next(f.binding, f.body);
  assert.equal(f.fixtureCalls(), 1); assert.equal(challenge.probe.inputs[0].sha256, WHISPER_AUDIO_FIXTURE.sha256);
  const result = await f.verification.submit(f.binding, challenge.id, f.body.lease_token, { ...candidateClaims(f), completed_turns: 1,
    asr: { fixture_sha256: WHISPER_AUDIO_FIXTURE.sha256, transcript: "And so my fellow Americans, ask not what your country can do for you. Ask what you can do for your country." } });
  assert.equal(result.activated, false); assert.equal(result.state, "adapter_required");
  assert.equal((await f.getCollection("capabilityAutoVerifications")).rows.length, 0);
});
test("realtime candidates share the same four global automatic-probe slots across different nodes", async () => {
  const f = await candidateFixture();
  for (let n = 1; n <= 5; n += 1) {
    const binding = { ...f.binding, _id: new ObjectId(), userId: new ObjectId(), nodeId: `memory-global-${n}` };
    await (await f.getCollection("nodeAccountBindings")).insertOne(binding);
    await (await f.getCollection("users")).insertOne({ _id: binding.userId, status: "active" });
    await f.service.report(binding, { capability_version: "digital-live-realtime-v1", transport: "http-fmp4-mse-v1", artifact_sha256: "a".repeat(64),
      providers: [providers], sharing_opt_in: true, resources: { gpu_state: "idle", gpu_observed_at: f.options.now().toISOString(),
        current_task_remaining_seconds: 0, running_task_count: 0 } });
    const call = f.verification.next(binding, { ...f.body, request_id: `memory-global-probe-${n}` });
    if (n <= 4) assert.equal((await call).challenge.lease_valid, true); else await rejects(call, "REALTIME_VERIFICATION_GLOBAL_BUSY");
  }
  const locks = (await f.getCollection("capabilityVerificationLeases")).rows;
  assert.equal(locks.filter((row) => row._id.startsWith("global:") && row.leaseUntil > f.options.now()).length, 4);
});
test("HTTP PCM intake sends binary only to its bound reader and forwards final to the original turn once", async () => {
  const f = fixture({ withAsr: true }), { id } = await f.ready(), app = new OpenAPIHono(), body = asrRequest(), token = `gab_${"P".repeat(48)}`;
  await (await f.getCollection("nodeAccountBindings")).updateOne({ _id: f.binding._id }, { $set: { tokenHash: hashOpaqueToken(token, "h3-account-binding") } });
  await (await f.getCollection("users")).insertOne({ _id: f.binding.userId, status: "active" });
  registerDigitalLiveRealtimeRoutes(app, { service: f.service, getCollection: f.getCollection, mediaEnabled: () => true,
    authenticate: async () => ({ kind: "desktop-gulong-engine", user: { id: f.owner } }), requireTrustedMutation: () => null,
    enforceRateLimit: async () => ({ allowed: true }) });
  const post = (path, data, headers = {}) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
  assert.equal((await post(`${ROOT}/sessions/${id}/asr/utterances`, body)).status, 200);
  const nodeHeaders = { "X-Gulong-Account-Binding": token, "X-Gulong-Realtime-Lease": f.lease };
  const reading = await app.request(`${ROOT}/sessions/${id}/input-audio/1/${body.utterance_id}`, { headers: nodeHeaders });
  const input = reading.arrayBuffer();
  const ticket = await (await post(`${ROOT}/sessions/${id}/asr/input-ticket`, { generation: 1, utterance_id: body.utterance_id, origin: "https://www.sologle.com" })).json();
  const pcm = Buffer.alloc(3200, 9), uploaded = await app.request(new URL(ticket.input_url).pathname, { method: "PUT",
    headers: { Authorization: `DigitalLiveInput ${ticket.ticket}`, Origin: "https://www.sologle.com", "Content-Type": DIGITAL_LIVE_PCM_MIME }, body: pcm });
  assert.equal(uploaded.status, 200); assert.deepEqual(Buffer.from(await input), pcm); const digest = await uploaded.json();
  const callback = { generation: 1, event: "asr_final", event_sequence: 1, event_id: "memory-final-asr-event", providers: f.providers,
    turn_id: body.turn_id, utterance_id: body.utterance_id, text: "你好", input_sha256: digest.sha256, input_bytes: digest.bytes };
  assert.equal((await post(`${ROOT}/sessions/${id}/worker-events`, callback, nodeHeaders)).status, 200);
  const state = await (await app.request(`${ROOT}/sessions/${id}`)).json();
  assert.equal(state.session.active_turn.request_id, body.request_id); assert.equal(state.session.active_asr.input_sha256, digest.sha256);
});
test("legal coalesced PCM network reads are sliced rather than rejected as oversized producer frames", async () => {
  const pcm = Buffer.alloc(640000, 7), relay = createDigitalLiveMediaRelay({ format: "pcm16", maxBytes: 640000, maxChunkBytes: 64 * 1024 });
  const p = { ...permit, mimeType: DIGITAL_LIVE_PCM_MIME }, read = new Response(relay.open(p)).arrayBuffer();
  const result = await relay.write(p, bodyStream(pcm, pcm.length));
  assert.equal(result.bytes, pcm.length); assert.deepEqual(Buffer.from(await read), pcm);
});
test("fMP4 network coalescing preserves byte order and framing while internal slices stay bounded", async () => {
  const relay = createDigitalLiveMediaRelay({ maxChunkBytes: 16 }), bytes = fmp4(), read = new Response(relay.open(permit)).arrayBuffer();
  const result = await relay.write(permit, bodyStream(bytes, bytes.length));
  assert.equal(result.bytes, bytes.length); assert.deepEqual(Buffer.from(await read), bytes);
});
