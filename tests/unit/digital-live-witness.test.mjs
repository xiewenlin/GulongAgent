import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { ObjectId } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { createDigitalLiveCandidateVerification } from "../../server/digital-live-verification.js";
import { realtimeProviderFingerprint } from "../../server/digital-live-realtime.js";
import { registerDigitalLiveRealtimeRoutes } from "../../server/digital-live-realtime-routes.js";
import { createDigitalLiveWitnessService, evaluateDigitalLiveWitness, createDigitalLiveRealtimeProofLookup,
  canonicalWitnessJson, witnessSha256, DIGITAL_LIVE_WITNESS_VERSION, DIGITAL_LIVE_ATTESTATION_VERSION,
  DIGITAL_LIVE_WITNESS_REGISTRY } from "../../server/digital-live-witness.js";

// Synthetic in-memory cryptographic/HTTP tests only. No real observer identity,
// GPU/model, production token, account, disk fixture or admission is created.
const providers = { text_model: "qwen38-27b-uncensored-q4-k-m", tts_model: "qwen3-tts-0.6b-base", avatar_model: "musetalk-1.5-stream",
  character_id: "c01林晚晴", voice_id: "c01", character_image_sha256: "1".repeat(64), voice_audio_sha256: "2".repeat(64),
  mime_type: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' };
const box = (type, data = Buffer.alloc(0)) => { const b = Buffer.alloc(8 + data.length); b.writeUInt32BE(b.length); b.write(type, 4); data.copy(b, 8); return b; };
const media = Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov"), box("moof"), box("mdat", Buffer.alloc(100, 9))]);
const stream = (bytes) => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const fails = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const makeRegistry = () => {
  const keys = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  return { keys, registry: { consumers: [{ artifact_sha256: "c".repeat(64), not_before: "2026-10-19T00:00:00Z", expires_at: "2026-10-21T00:00:00Z" }],
    observers: ["runtime", "playback"].map((role, i) => ({ role, key_id: `test-only-${role}`, artifact_sha256: `${i + 4}`.repeat(64),
      public_key_spki: keys[i].publicKey.export({ type: "spki", format: "pem" }), not_before: "2026-10-19T00:00:00Z", expires_at: "2026-10-21T00:00:00Z" })) } };
};
async function fixture({ registered = false } = {}) {
  let instant = Date.parse("2026-10-19T08:00:00Z"), active = true, group = null;
  const ownerId = new ObjectId(), binding = { _id: new ObjectId(), userId: ownerId, nodeId: "memory-only-witness-node", computeGroupId: null, status: "active", revokedAt: null };
  const tables = new Map(), getCollection = async (n) => { if (!tables.has(n)) tables.set(n, createCapabilityMemoryCollection()); return tables.get(n); };
  const testRegistry = makeRegistry(), now = () => new Date(instant);
  await (await getCollection("users")).insertOne({ _id: ownerId, status: "active" });
  await (await getCollection("nodeAccountBindings")).insertOne(binding);
  await (await getCollection("digitalLiveRealtimeNodes")).insertOne({ _id: String(binding._id), bindingId: String(binding._id), executorUserId: String(ownerId),
    nodeId: binding.nodeId, computeGroupId: null, artifactSha256: "a".repeat(64), sharingOptIn: true, reportedAt: now(), providers: [providers],
    resources: { gpu_state: "idle", gpu_observed_at: now().toISOString(), current_task_remaining_seconds: 0, running_task_count: 0 } });
  const witness = createDigitalLiveWitnessService({ getCollection, now, registry: registered ? testRegistry.registry : DIGITAL_LIVE_WITNESS_REGISTRY,
    readEntitlement: async () => ({ active, capabilities: active ? ["digital_live.use"] : [] }), readGroup: async () => group, isOwnerActive: async () => true });
  const verification = createDigitalLiveCandidateVerification({ getCollection, now, witness });
  const lease = randomBytes(32).toString("base64url"), { challenge } = await verification.next(binding,
    { request_id: "test-witness-original-key", lease_token: lease, provider_sha256: realtimeProviderFingerprint(providers), mode: "media" });
  const body = (purpose = "media", sequence = 1) => ({ request_id: `test-witness-${purpose}-${sequence}`, consumer_artifact_sha256: "c".repeat(64), purpose,
    ...(purpose === "media" ? { sequence } : {}), origin: "tauri://localhost" });
  return { getCollection, binding, owner: String(ownerId), witness, verification, challenge, lease, body, now, ...testRegistry,
    advance: (ms) => { instant += ms; }, setActive: (value) => { active = value; }, setGroup: (value) => { group = value; } };
}
function report(f) {
  return { protocol: DIGITAL_LIVE_WITNESS_VERSION, challenge_id: f.challenge.id, nonce: f.challenge.nonce,
    provider_sha256: realtimeProviderFingerprint(providers), node_artifact_sha256: "a".repeat(64), consumer_artifact_sha256: "c".repeat(64),
    observations: f.challenge.probe.turns.map((t, i) => ({ sequence: i + 1, turn_id: t.turn_id, generation: i < 5 ? 1 : 2,
      media_generation: i + 1, turn_sequence: 1, sha256: createHash("sha256").update(media).digest("hex"), bytes: media.length, first_body_ms: 10,
      first_presented_ms: 20, first_playing_ms: 25, ended_ms: 1100, played_start_seconds: 0, played_end_seconds: 1,
      presented_frames: 15, total_frames: 15, dropped_frames: 0, ended: true })),
    interrupt: { probe_id: `probe-${f.challenge.nonce}-interrupt`, source_sequence: 5, from_generation: 1, to_generation: 2, local_mute_ms: 2, fetch_abort_ms: 3 } };
}
async function complete(f) {
  for (let sequence = 1; sequence <= 10; sequence++) {
    const ticket = await f.witness.issue(f.owner, f.challenge.id, f.body("media", sequence));
    const opened = await f.witness.open(f.challenge.id, sequence, ticket.ticket, "tauri://localhost");
    const received = new Response(opened.stream).arrayBuffer();
    await f.verification.collect(f.binding, f.challenge.id, f.lease, sequence, stream(media), providers.mime_type);
    assert.deepEqual(Buffer.from(await received), media);
  }
  const ticket = await f.witness.issue(f.owner, f.challenge.id, f.body("interrupt_media"));
  const opened = await f.witness.open(f.challenge.id, 11, ticket.ticket, "tauri://localhost"), reader = opened.stream.getReader();
  const body = new ReadableStream({ start(c) { c.enqueue(media.subarray(0, media.length - 64)); } });
  const writing = f.verification.interruptMedia(f.binding, f.challenge.id, f.lease, body, providers.mime_type);
  assert.equal((await reader.read()).done, false);
  await new Promise((r) => setImmediate(r)); // ensure the actual first writer block was acknowledged
  await reader.cancel();
  assert.equal((await writing).interrupted, true);
  const candidate = { actual_provider_sha256: realtimeProviderFingerprint(providers), completed_turns: 10,
    played_sequences: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ended: true, interrupt: { before_generation: 1, after_generation: 2, stopped_ms: 3 } };
  await f.verification.submit(f.binding, f.challenge.id, f.lease, candidate);
  const reportTicket = await f.witness.issue(f.owner, f.challenge.id, f.body("report"));
  const admission = await f.witness.report(f.challenge.id, reportTicket.ticket, "tauri://localhost", report(f));
  return { admission, reportTicket };
}
async function snapshot(f) {
  return { record: await (await f.getCollection("digitalLiveRealtimeVerifications")).findOne({ id: f.challenge.id }), report: report(f),
    observed: await (await f.getCollection("digitalLiveRealtimeVerificationMedia")).find({ challengeId: f.challenge.id, sequence: { $lte: 10 } }).sort({ sequence: 1 }).toArray(),
    interrupted: await (await f.getCollection("digitalLiveRealtimeWitnessMedia")).findOne({ _id: `${f.challenge.id}:11` }), registry: f.registry, now: f.now() };
}
function attestation(f, s, role) {
  const i = role === "runtime" ? 0 : 1;
  const body = { protocol: DIGITAL_LIVE_ATTESTATION_VERSION, role, key_id: f.registry.observers[i].key_id,
    observer_artifact_sha256: f.registry.observers[i].artifact_sha256, challenge_id: f.challenge.id, nonce: f.challenge.nonce,
    provider_sha256: realtimeProviderFingerprint(providers), node_artifact_sha256: "a".repeat(64), consumer_artifact_sha256: "c".repeat(64),
    wire_sha256: witnessSha256({ complete: s.observed.map(({ sequence, sha256, bytes }) => ({ sequence, sha256, bytes })),
      interrupted: { sequence: 11, bytes: s.interrupted.bytes, sha256: s.interrupted.sha256,
        writing_when_cancelled: s.interrupted.writing_when_cancelled, code: s.interrupted.code } }),
    report_sha256: witnessSha256(s.report), observed_at: f.now().toISOString(), expires_at: new Date(+f.now() + 60000).toISOString(),
    payload: role === "runtime" ? { actual_text_model: providers.text_model, actual_tts_model: providers.tts_model, actual_avatar_model: providers.avatar_model,
      turns: f.challenge.probe.turns.map((t) => ({ turn_id: t.turn_id, text_sha256: witnessSha256(t.expected_text) })),
      max_av_skew_ms: 12, exclusive_gpu: true, owned_worker_stopped: true }
      : { decoded_streams: 10, end_of_stream_verified: true, interrupted_generation_verified: true } };
  return { ...body, signature: sign(null, Buffer.from(canonicalWitnessJson(body)), f.keys[i].privateKey).toString("base64url") };
}

test("witness ticket is short, opaque-hash-only and original-key recovery never reissues a secret", async () => {
  const f = await fixture(), body = f.body(), one = await f.witness.issue(f.owner, f.challenge.id, body);
  assert.match(one.ticket, /^dlw_[A-Za-z0-9_-]{43}$/); assert.equal(one.consumer_registration, "unregistered");
  assert.equal(+one.expires_at - +f.now(), 60000);
  const row = (await f.getCollection("digitalLiveRealtimeWitnessTickets")).rows[0];
  assert.equal(JSON.stringify(row).includes(one.ticket), false);
  assert.equal((await f.witness.issue(f.owner, f.challenge.id, body)).ticket, undefined);
  assert.equal((await f.witness.state(f.owner, f.challenge.id, body.request_id)).consumed, false);
  await fails(f.witness.issue(f.owner, f.challenge.id, { ...body, sequence: 2 }), "REALTIME_WITNESS_IDEMPOTENCY_CONFLICT");
  await fails(f.witness.issue(f.owner, f.challenge.id, { ...body, request_id: "different-original-key" }), "REALTIME_WITNESS_TICKET_ALREADY_ISSUED");
});
test("witness ticket creation rejects foreign account, missing entitlement, group bypass and hostile origin", async () => {
  const f = await fixture();
  await fails(f.witness.issue(String(new ObjectId()), f.challenge.id, f.body()), "REALTIME_WITNESS_NOT_FOUND");
  f.setActive(false); await fails(f.witness.issue(f.owner, f.challenge.id, f.body()), "DIGITAL_LIVE_SUBSCRIPTION_REQUIRED");
  f.setActive(true); f.setGroup("foreign"); await fails(f.witness.issue(f.owner, f.challenge.id, f.body()), "COMPUTE_GROUP_MISMATCH");
  f.setGroup(null); await fails(f.witness.issue(f.owner, f.challenge.id, { ...f.body(), origin: "https://evil.invalid" }), "REALTIME_WITNESS_REQUEST_INVALID");
});
test("witness media tickets are purpose/sequence/Origin-bound, one-use and expire", async () => {
  const f = await fixture(), ticket = await f.witness.issue(f.owner, f.challenge.id, f.body());
  await fails(f.witness.open(f.challenge.id, 2, ticket.ticket, "tauri://localhost"), "REALTIME_WITNESS_TICKET_INVALID");
  await fails(f.witness.open(f.challenge.id, 1, ticket.ticket, "https://www.sologle.com"), "REALTIME_WITNESS_TICKET_INVALID");
  const first = await f.witness.open(f.challenge.id, 1, ticket.ticket, "tauri://localhost");
  await fails(f.witness.open(f.challenge.id, 1, ticket.ticket, "tauri://localhost"), "REALTIME_WITNESS_TICKET_INVALID");
  await first.stream.cancel();
  const second = await f.witness.issue(f.owner, f.challenge.id, f.body("media", 2)); f.advance(60001);
  await fails(f.witness.open(f.challenge.id, 2, second.ticket, "tauri://localhost"), "REALTIME_WITNESS_TICKET_INVALID");
});
test("binding or exact provider artifact changes invalidate a previously issued witness ticket", async () => {
  const f = await fixture(), t = await f.witness.issue(f.owner, f.challenge.id, f.body());
  await (await f.getCollection("digitalLiveRealtimeNodes")).updateOne({ _id: String(f.binding._id) }, { $set: { artifactSha256: "f".repeat(64) } });
  await fails(f.witness.open(f.challenge.id, 1, t.ticket, "tauri://localhost"), "REALTIME_WITNESS_BINDING_CHANGED");
});
test("ten complete streams and a separately aborted active fetch retain hashes, not full media or approval", async () => {
  const f = await fixture(), { admission } = await complete(f);
  assert.equal(admission.activated, false); assert.equal(admission.code, "REALTIME_WITNESS_CONSUMER_UNREGISTERED");
  const rows = (await f.getCollection("digitalLiveRealtimeWitnessMedia")).rows;
  assert.equal(rows.filter((r) => r.state === "delivered").length, 10);
  assert.equal(rows.find((r) => r.sequence === 11).writing_when_cancelled, true);
  assert.equal(JSON.stringify(rows).includes('"body"'), false);
  assert.equal((await f.getCollection("digitalLiveRealtimeProofs")).rows.length, 0);
  const status = await f.witness.state(f.owner, f.challenge.id, f.body("report").request_id);
  assert.equal(status.report_received, true); assert.equal(status.gateway_interrupt.state, "interrupted"); assert.equal(status.wire_sha256.length, 64);
});
test("an abort before an active writer is not an in-flight interruption", async () => {
  const f = await fixture(), t = await f.witness.issue(f.owner, f.challenge.id, f.body("interrupt_media"));
  const opened = await f.witness.open(f.challenge.id, 11, t.ticket, "tauri://localhost"); await opened.stream.cancel();
  await new Promise((r) => setImmediate(r));
  const row = await (await f.getCollection("digitalLiveRealtimeWitnessMedia")).findOne({ _id: `${f.challenge.id}:11` });
  assert.equal(row.writing_when_cancelled, false); assert.equal(row.bytes, 0);
});
test("registered consumers still cannot activate from client reports without two independent signed observers", async () => {
  const f = await fixture({ registered: true }); await complete(f); const s = await snapshot(f);
  assert.equal(evaluateDigitalLiveWitness({ ...s, attestations: [] }).code, "REALTIME_INDEPENDENT_WITNESS_REQUIRED");
  assert.equal(evaluateDigitalLiveWitness({ ...s, attestations: [attestation(f, s, "runtime")] }).admitted, false);
});
test("valid test-only signatures activate only after exact worker stopped; lookup revalidates the full chain", async () => {
  const f = await fixture({ registered: true }); await complete(f); let s = await snapshot(f);
  const envelopes = [attestation(f, s, "runtime"), attestation(f, s, "playback")];
  await f.witness.attest(envelopes[0]); const partial = await f.witness.attest(envelopes[1]);
  assert.equal(partial.activated, false); assert.equal(partial.code, "REALTIME_OWNED_WORKER_STOP_REQUIRED");
  await f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true });
  assert.equal((await f.getCollection("digitalLiveRealtimeProofs")).rows.length, 1);
  const node = await (await f.getCollection("digitalLiveRealtimeNodes")).findOne({ _id: String(f.binding._id) });
  const lookup = createDigitalLiveRealtimeProofLookup({ getCollection: f.getCollection, registry: f.registry });
  assert.equal((await lookup(node, providers, f.now())).contractTests.realtime_asr, false);
  assert.equal(await createDigitalLiveRealtimeProofLookup({ getCollection: f.getCollection })(node, providers, f.now()), null,
    "production registry is empty even if an in-memory DB has an active-shaped row");
  const changed = structuredClone(f.registry); changed.observers[0].revoked = true;
  assert.equal(await createDigitalLiveRealtimeProofLookup({ getCollection: f.getCollection, registry: changed })(node, providers, f.now()), null);
});
test("nonce, full-wire SHA, exact model and independent signing identities cannot be substituted", async () => {
  const f = await fixture({ registered: true }); await complete(f); await f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true });
  const s = await snapshot(f), envelopes = [attestation(f, s, "runtime"), attestation(f, s, "playback")];
  assert.equal(evaluateDigitalLiveWitness({ ...s, attestations: envelopes }).admitted, true);
  for (const mutation of [
    (a) => { a[0].nonce = "0".repeat(16); }, (a) => { a[1].wire_sha256 = "0".repeat(64); },
    (a) => { a[0].payload.actual_text_model = "qwen3-1.7b"; }, (a) => { a[0].signature = "a".repeat(86); },
  ]) { const altered = structuredClone(envelopes); mutation(altered); assert.equal(evaluateDigitalLiveWitness({ ...s, attestations: altered }).admitted, false); }
  const badReport = structuredClone(s.report); badReport.observations[4].ended = false;
  assert.equal(evaluateDigitalLiveWitness({ ...s, report: badReport, attestations: envelopes }).admitted, false);
  assert.equal(evaluateDigitalLiveWitness({ ...s, interrupted: { ...s.interrupted, bytes: 0 }, attestations: envelopes }).admitted, false);
});
test("unregistered signed envelopes are rejected before challenge existence is looked up", async () => {
  const f = await fixture(); await complete(f); const s = await snapshot(f), a = attestation(f, s, "runtime");
  await fails(f.witness.attest(a), "REALTIME_ATTESTATION_UNTRUSTED");
  assert.equal((await f.getCollection("digitalLiveRealtimeAttestations")).rows.length, 0);
});
test("concurrent same-key issuance returns only one secret and a single durable purpose slot", async () => {
  const f = await fixture();
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.witness.issue(f.owner, f.challenge.id, f.body())));
  assert.equal(replies.filter((r) => r.ticket).length, 1);
  assert.equal((await f.getCollection("digitalLiveRealtimeWitnessTickets")).rows.length, 1);
  f.advance(60001);
  assert.equal((await f.witness.state(f.owner, f.challenge.id, f.body().request_id)).consumed, false, "expiry is not receipt deletion");
});
test("same-key lost report recovery is read-only and never offers a second GET or upload token", async () => {
  const f = await fixture(); await complete(f); const body = f.body("report");
  const recovered = await f.witness.issue(f.owner, f.challenge.id, body);
  assert.equal(recovered.consumed, true); assert.equal(recovered.ticket, undefined);
  const state = await f.witness.state(f.owner, f.challenge.id, body.request_id);
  assert.equal(state.report_received, true);
  await fails(f.witness.state(String(new ObjectId()), f.challenge.id, body.request_id), "REALTIME_WITNESS_NOT_FOUND");
});
test("schema refuses invented hardware release, AV-skew fields and incomplete fifth-stream ended claims", async () => {
  const f = await fixture(); await complete(f); const s = await snapshot(f);
  const body = { ...s.report, physical_gpu_released: true };
  assert.equal(evaluateDigitalLiveWitness({ ...s, report: body, attestations: [] }).admitted, false);
  const source = structuredClone(s.report); source.observations[4].bytes -= 1;
  assert.equal(evaluateDigitalLiveWitness({ ...s, report: source, attestations: [] }).code, "REALTIME_WITNESS_MEDIA_MISMATCH");
  assert.equal(evaluateDigitalLiveWitness({ ...s, interrupted: { ...s.interrupted, bytes: s.observed[4].bytes }, attestations: [] }).code,
    "REALTIME_INFLIGHT_INTERRUPT_REQUIRED", "complete fetch followed by abort is not in-flight evidence");
});
test("runtime and playback cannot share the same signing identity even under different IDs or PEM formatting", async () => {
  const f = await fixture({ registered: true }); await complete(f); await f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true });
  f.keys[1] = f.keys[0]; f.registry.observers[1].public_key_spki = `\n${f.registry.observers[0].public_key_spki}\n`;
  const s = await snapshot(f), envelopes = [attestation(f, s, "runtime"), attestation(f, s, "playback")];
  assert.equal(evaluateDigitalLiveWitness({ ...s, attestations: envelopes }).code, "REALTIME_INDEPENDENT_IDENTITIES_REQUIRED");
});
test("attestation retries are idempotent, conflicts reject and expired envelopes never enter the proof chain", async () => {
  const f = await fixture({ registered: true }); await complete(f); const s = await snapshot(f), a = attestation(f, s, "runtime");
  await Promise.all([f.witness.attest(a), f.witness.attest(a)]);
  assert.equal((await f.getCollection("digitalLiveRealtimeAttestations")).rows.length, 1);
  const altered = { ...a, expires_at: new Date(+f.now() + 120000).toISOString() };
  const { signature, ...unsigned } = altered; altered.signature = sign(null, Buffer.from(canonicalWitnessJson(unsigned)), f.keys[0].privateKey).toString("base64url");
  await fails(f.witness.attest(altered), "REALTIME_ATTESTATION_CONFLICT");
  f.advance(60001); await fails(f.witness.attest(a), "REALTIME_ATTESTATION_EXPIRED");
});
test("stopped ACK cannot release a challenge while its independent witness reader remains connected", async () => {
  const f = await fixture(), t = await f.witness.issue(f.owner, f.challenge.id, f.body());
  const opened = await f.witness.open(f.challenge.id, 1, t.ticket, "tauri://localhost");
  await fails(f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true }), "REALTIME_VERIFICATION_TRANSFER_ACTIVE");
  await opened.stream.cancel();
  await f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true });
});
test("stopped retries preserve the original timestamp and expired original witness receipts stay queryable without activation writes", async () => {
  const f = await fixture(); await complete(f);
  await f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true });
  const first = (await snapshot(f)).record.stoppedAt; f.advance(901000);
  await f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true });
  assert.equal(+(await snapshot(f)).record.stoppedAt, +first);
  const state = await f.witness.state(f.owner, f.challenge.id, f.body("report").request_id);
  assert.equal(state.report_received, true); assert.equal(state.admission.activated, false);
  assert.equal((await f.getCollection("digitalLiveRealtimeProofs")).rows.length, 0);
});
test("HTTP witness schema is exposed but unauthenticated tickets and Vercel media pairing are denied", async () => {
  const f = await fixture(), app = new OpenAPIHono();
  registerDigitalLiveRealtimeRoutes(app, { getCollection: f.getCollection, witness: f.witness, verification: f.verification,
    mediaEnabled: () => false, enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async (c) => c.req.header("Authorization") === "Bearer memory-only-test" ? { user: { id: f.owner } }
      : { error: c.json({ code: "AUTH_REQUIRED" }, 401) }, requireTrustedMutation: () => null });
  const root = `/api/v1/digital-live/realtime/verifications/${f.challenge.id}`;
  assert.equal((await app.request(`${root}/witness-tickets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f.body()) })).status, 401);
  const ticketResponse = await app.request(`${root}/witness-tickets`, { method: "POST", headers: { Authorization: "Bearer memory-only-test", "Content-Type": "application/json" }, body: JSON.stringify(f.body()) });
  assert.equal(ticketResponse.status, 200); const ticket = await ticketResponse.json();
  assert.equal((await app.request(`${root}/witness-media/1`, { headers: { Authorization: `DigitalLiveWitness ${ticket.ticket}`, Origin: "tauri://localhost" } })).status, 421);
  const doc = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "memory only", version: "1" } });
  assert.ok(doc.paths["/api/v1/digital-live/realtime/verifications/{verificationId}/witness-report"]);
  assert.ok(doc.components.schemas.DigitalLivePlaybackWitness);
});
test("GGE discovery finds only its own current-group challenge without budget, ticket, slot or admission writes", async () => {
  const f = await fixture(), query = { consumer_artifact_sha256: "c".repeat(64) };
  const tables = ["digitalLiveRealtimeVerifications", "capabilityVerificationBudgets", "capabilityNodeSlots", "digitalLiveRealtimeWitnessTickets", "digitalLiveRealtimeProofs"];
  const before = await Promise.all(tables.map(async (name) => JSON.stringify((await f.getCollection(name)).rows)));
  const result = await f.witness.pending(f.owner, query);
  assert.equal(result.status, "challenges_available"); assert.equal(result.challenges.length, 1);
  assert.equal(result.challenges[0].id, f.challenge.id); assert.equal(result.challenges[0].nonce, f.challenge.nonce);
  assert.equal(result.challenges[0].witness_phase, "not_started"); assert.equal(result.registrations.consumer, "unregistered");
  assert.equal(result.registrations.runtime_observer_count + result.registrations.playback_observer_count, 0);
  assert.equal(JSON.stringify(result).includes(f.lease), false); assert.equal(JSON.stringify(result).includes(String(f.binding._id)), false);
  assert.equal(JSON.stringify(result).includes(f.owner), false);
  assert.deepEqual(await Promise.all(tables.map(async (name) => JSON.stringify((await f.getCollection(name)).rows))), before);
  assert.equal((await f.witness.pending(String(new ObjectId()), query)).challenges.length, 0);
  f.setGroup("wrong-group"); assert.equal((await f.witness.pending(f.owner, query)).challenges.length, 0);
});
test("discovery excludes expired, stopped, changed-artifact and un-witnessed already-discarded streams", async () => {
  const query = { consumer_artifact_sha256: "c".repeat(64) };
  for (const mutation of [
    async (f) => f.advance(900001),
    async (f) => f.verification.stopped(f.binding, f.challenge.id, f.lease, { owned_worker_stopped: true }),
    async (f) => (await f.getCollection("digitalLiveRealtimeNodes")).updateOne({ _id: String(f.binding._id) }, { $set: { artifactSha256: "f".repeat(64) } }),
    async (f) => f.verification.collect(f.binding, f.challenge.id, f.lease, 1, stream(media), providers.mime_type),
  ]) { const f = await fixture(); await mutation(f); assert.equal((await f.witness.pending(f.owner, query)).status, "waiting_for_node_challenge"); }
});
test("discovery preserves the original consumer and exposes only non-secret request recovery metadata", async () => {
  const f = await fixture(); await f.witness.issue(f.owner, f.challenge.id, f.body());
  const result = await f.witness.pending(f.owner, { consumer_artifact_sha256: "c".repeat(64) });
  assert.equal(result.challenges[0].witness_phase, "resume_only");
  assert.deepEqual(Object.keys(result.challenges[0].pending_requests[0]).sort(), ["consumed", "expires_at", "purpose", "request_id", "sequence"]);
  assert.equal(result.challenges[0].pending_requests[0].request_id, f.body().request_id);
  assert.equal((await f.witness.pending(f.owner, { consumer_artifact_sha256: "d".repeat(64) })).challenges.length, 0);
  await fails(f.witness.pending(f.owner, { consumer_artifact_sha256: "c".repeat(64), user_id: "foreign" }), "REALTIME_WITNESS_REQUEST_INVALID");
  f.setActive(false); await fails(f.witness.pending(f.owner, { consumer_artifact_sha256: "c".repeat(64) }), "DIGITAL_LIVE_SUBSCRIPTION_REQUIRED");
});
test("discovery has a typed OpenAPI schema and HTTP route is GGE-protected, not the node credential endpoint", async () => {
  const f = await fixture(), app = new OpenAPIHono(), path = "/api/v1/digital-live/realtime/verifications/pending";
  registerDigitalLiveRealtimeRoutes(app, { getCollection: f.getCollection, witness: f.witness, enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async (c) => c.req.header("Authorization") === "Bearer memory-only-test" ? { user: { id: f.owner } }
      : { error: c.json({ code: "AUTH_REQUIRED" }, 401) }, requireTrustedMutation: () => null });
  assert.equal((await app.request(`${path}?consumer_artifact_sha256=${"c".repeat(64)}`)).status, 401);
  const result = await app.request(`${path}?consumer_artifact_sha256=${"c".repeat(64)}`, { headers: { Authorization: "Bearer memory-only-test" } });
  assert.equal(result.status, 200); assert.match(result.headers.get("Cache-Control"), /no-store/);
  assert.equal((await result.json()).challenges[0].id, f.challenge.id);
  const doc = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "memory only", version: "1" } });
  assert.ok(doc.paths[path].get.parameters.some((p) => p.name === "consumer_artifact_sha256" && p.required));
  assert.ok(doc.components.schemas.DigitalLiveWitnessDiscovery);
});
