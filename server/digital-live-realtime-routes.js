import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { hashOpaqueToken, fingerprintIp } from "./security.js";
import { createDigitalLiveRealtimeService, realtimeConfig, digitalLiveRealtimeSchemas, DIGITAL_LIVE_PCM_MIME, DIGITAL_LIVE_REALTIME_ROOT as ROOT } from "./digital-live-realtime.js";
import { createDigitalLiveMediaRelay } from "./digital-live-media-relay.js";
import { createDigitalLiveCandidateVerification, digitalLiveVerificationSchemas } from "./digital-live-verification.js";
import { createDigitalLiveWitnessService, digitalLiveWitnessSchemas, DIGITAL_LIVE_WITNESS_VERSION } from "./digital-live-witness.js";

let persistentMediaRuntime = false;
// Only the persistent Node entry point enables media pairing. Importing this
// module into Vercel/Sites does not enable an in-memory distributed relay.
export function enablePersistentDigitalLiveMediaRuntime() { persistentMediaRuntime = true; }
const sessionPath = `${ROOT}/sessions/:id`;
async function jsonBody(c) {
  const reader = c.req.raw.body?.getReader(); let bytes = 0; const chunks = [];
  if (!reader) return {};
  try {
    for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength;
      if (bytes > 32 * 1024) { await reader.cancel(); throw Object.assign(new Error("实时控制请求不能超过32KB"), { status: 413, code: "REALTIME_REQUEST_TOO_LARGE" }); }
      chunks.push(result.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error.code) throw error; throw Object.assign(new Error("实时控制请求必须是完整JSON"), { status: 400, code: "REALTIME_REQUEST_INVALID" }); }
  finally { reader.releaseLock(); }
}
export function registerDigitalLiveRealtimeRoutes(app, dependencies) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const rateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  let service;
  const relay = dependencies.relay || createDigitalLiveMediaRelay({
    onSent: (id, generation, sequence) => service.mediaSent(id, generation, sequence),
    onFailed: (id) => service.mediaFailed(id),
  });
  const audioRelay = dependencies.audioRelay || createDigitalLiveMediaRelay({ format: "pcm16", maxBytes: 640000, maxChunkBytes: 64 * 1024, timeoutMs: 25_000,
    onSent: (id, generation, utterance, metadata) => service.audioReceived(id, generation, utterance, metadata), onFailed: (id) => service.mediaFailed(id) });
  service = dependencies.service || createDigitalLiveRealtimeService({ getCollection, ...dependencies.serviceOptions,
    onInvalidate: (id) => { relay.invalidate(id); audioRelay.invalidate(id); } });
  const mediaEnabled = dependencies.mediaEnabled || (() => persistentMediaRuntime);
  const witness = dependencies.witness || createDigitalLiveWitnessService({ getCollection, ...dependencies.witnessOptions });
  const verification = dependencies.verification || createDigitalLiveCandidateVerification({ getCollection, witness, ...dependencies.verificationOptions });
  async function nodeAuth(c) {
    const raw = c.req.header("X-Gulong-Account-Binding") || "";
    if (!/^gab_[A-Za-z0-9_-]{40,196}$/.test(raw)) return { error: c.json({ code: "ACCOUNT_BINDING_REQUIRED", message: "请先在已激活的桌面节点绑定官网账号" }, 401) };
    const binding = await (await getCollection("nodeAccountBindings")).findOne({ tokenHash: hashOpaqueToken(raw, "h3-account-binding"), status: "active", revokedAt: null });
    if (!binding || !await (await getCollection("users")).findOne({ _id: binding.userId, status: "active" })) return { error: c.json({ code: "INVALID_ACCOUNT_BINDING", message: "节点绑定已失效，请停止本节点会话并重新绑定" }, 401) };
    return { binding };
  }
  function safe(handler, kind = "user", mutation = false) {
    return async (c) => {
      c.header("Cache-Control", "private, no-store, max-age=0");
      try {
        const ip = fingerprintIp(c.req.header("x-forwarded-for") || "local");
        const ipRate = await rateLimit(`digital-live-realtime:ip:${ip}`, { limit: 1800, windowMs: 60_000 });
        if (!ipRate.allowed) return c.json({ code: "REALTIME_RATE_LIMITED", message: "实时请求过于频繁，请稍后重试" }, 429);
        const auth = kind === "node" ? await nodeAuth(c) : kind === "ticket" ? {} : await dependencies.authenticate(c);
        if (auth?.error) return auth.error;
        if (kind === "user" && mutation) { const rejected = dependencies.requireTrustedMutation(c); if (rejected) return rejected; }
        const key = kind === "node" ? String(auth.binding._id) : kind === "user" ? String(auth.user.id) : ip;
        const limit = kind === "ticket" ? 120 : c.req.path.endsWith("/nodes/report") ? 12 : kind === "node" ? 600 : 240;
        const rate = await rateLimit(`digital-live-realtime:${kind}:${key}`, { limit, windowMs: 60_000 });
        if (!rate.allowed) return c.json({ code: "REALTIME_RATE_LIMITED", message: "实时请求过于频繁，请稍后重试" }, 429);
        return await handler(c, auth);
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 503 ? error.status : error.name === "ZodError" ? 400 : 503;
        return c.json({ code: typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : "REALTIME_UNAVAILABLE",
          message: error.status && /[\u3400-\u9fff]/.test(error.message || "") ? error.message : "实时会话暂时不可用，请检查原会话后重试" }, status);
      }
    };
  }
  const state = async (c, auth) => {
    const session = await service.workerState(auth.binding, c.req.param("id"), c.req.header("X-Gulong-Realtime-Lease"));
    return { ...session, queue: session.queue.map((item) => ({ ...item, media_reader_ready: mediaEnabled() && relay.hasReader({
      sessionId: session.id, generation: session.generation, sequence: item.sequence }) })) };
  };
  const gatewayGuard = (c) => !mediaEnabled() ? c.json({ code: "REALTIME_PERSISTENT_GATEWAY_REQUIRED", message: "媒体流只能连接会话返回的腾讯云常驻网关，本平台仅提供会话控制" }, 421) : null;
  app.get(`${ROOT}/config`, async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    const config = realtimeConfig();
    // Anonymous discovery is always unavailable. An authenticated new-session
    // config derives availability from that account's exact proved/grouped
    // provider rows; no permanent global false and no inventory-based unlock.
    if (!c.req.header("Authorization") && !c.req.header("Cookie")) return c.json(config);
    try {
      const auth = await dependencies.authenticate(c, { required: false });
      if (auth?.error) return auth.error;
      if (!auth?.user?.id) return c.json(config);
      const rate = await rateLimit(`digital-live-realtime:config:${auth.user.id}`, { limit: 60, windowMs: 60_000 });
      if (!rate.allowed) return c.json({ code: "REALTIME_RATE_LIMITED", message: "实时配置查询过于频繁，请稍后重试" }, 429);
      const catalog = await service.catalog(auth.user.id);
      return c.json({ ...config, status: catalog.dispatchable ? "available" : "integration_required", dispatchable: catalog.dispatchable,
        acceptance: catalog.acceptance, remote_asr: { ...config.remote_asr, ...catalog.remote_asr } });
    } catch (error) {
      if (error.code === "DIGITAL_LIVE_SUBSCRIPTION_REQUIRED") return c.json(config);
      return c.json({ code: "REALTIME_UNAVAILABLE", message: "实时目录暂不可用，请稍后重新查询" }, 503);
    }
  });
  app.get(`${ROOT}/providers`, safe(async (c, auth) => c.json(await service.catalog(auth.user.id, c.req.query()))));
  app.post(`${ROOT}/nodes/report`, safe(async (c, auth) => c.json(await service.report(auth.binding, await jsonBody(c))), "node"));
  app.post(`${ROOT}/nodes/claim`, safe(async (c, auth) => {
    const body = await jsonBody(c);
    if (body.dry_run === true) return c.json({ ok: true, service: "digital-live-realtime", queue: "reachable", session: null });
    return c.json({ session: await service.claim(auth.binding, body.lease_token) });
  }, "node"));
  const verificationLease = (c) => c.req.header("X-Gulong-Realtime-Verification-Lease");
  app.get(`${ROOT}/verifications/pending`, safe(async (c, auth) => c.json(await witness.pending(auth.user.id, c.req.query()))));
  app.post(`${ROOT}/verifications/next`, safe(async (c, auth) => c.json(await verification.next(auth.binding, await jsonBody(c))), "node"));
  app.get(`${ROOT}/verifications/by-request/:key`, safe(async (c, auth) => c.json(await verification.byRequest(auth.binding, c.req.param("key"), verificationLease(c))), "node"));
  app.get(`${ROOT}/verifications/:verificationId`, safe(async (c, auth) => c.json(await verification.get(auth.binding, c.req.param("verificationId"), verificationLease(c))), "node"));
  app.post(`${ROOT}/verifications/:verificationId/result`, safe(async (c, auth) => c.json(await verification.submit(auth.binding,
    c.req.param("verificationId"), verificationLease(c), await jsonBody(c))), "node"));
  app.post(`${ROOT}/verifications/:verificationId/stopped`, safe(async (c, auth) => c.json(await verification.stopped(auth.binding,
    c.req.param("verificationId"), verificationLease(c), await jsonBody(c))), "node"));
  app.put(`${ROOT}/verifications/:verificationId/media/:sequence`, safe(async (c, auth) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    return c.json(await verification.collect(auth.binding, c.req.param("verificationId"), verificationLease(c), Number(c.req.param("sequence")), c.req.raw.body, c.req.header("Content-Type")));
  }, "node"));
  app.put(`${ROOT}/verifications/:verificationId/interrupt-media`, safe(async (c, auth) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    return c.json(await verification.interruptMedia(auth.binding, c.req.param("verificationId"), verificationLease(c), c.req.raw.body, c.req.header("Content-Type")));
  }, "node"));
  const witnessRoot = `${ROOT}/verifications/:verificationId`;
  app.post(`${witnessRoot}/witness-tickets`, safe(async (c, auth) => c.json(await witness.issue(auth.user.id, c.req.param("verificationId"), await jsonBody(c))), "user", true));
  app.get(`${witnessRoot}/witness-state`, safe(async (c, auth) => c.json(await witness.state(auth.user.id, c.req.param("verificationId"), c.req.query("request_id")))));
  for (const path of [`${witnessRoot}/witness-media/:sequence`, `${witnessRoot}/witness-interrupt-media`, `${witnessRoot}/witness-report`]) app.options(path, (c) => {
    const origin = c.req.header("Origin");
    if (!["https://www.sologle.com", "https://sologle.com", "https://111.229.70.235", "http://tauri.localhost", "tauri://localhost"].includes(origin)) return c.body(null, 403);
    c.header("Access-Control-Allow-Origin", origin); c.header("Vary", "Origin"); c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type"); return c.body(null, 204);
  });
  const witnessToken = (c) => (c.req.header("Authorization") || "").replace(/^DigitalLiveWitness /, "");
  app.get(`${witnessRoot}/witness-media/:sequence`, safe(async (c) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    if (!/^(?:[1-9]|10)$/.test(c.req.param("sequence"))) return c.json({ code: "REALTIME_WITNESS_REQUEST_INVALID", message: "完整媒体序号必须为1至10" }, 400);
    const result = await witness.open(c.req.param("verificationId"), Number(c.req.param("sequence")), witnessToken(c), c.req.header("Origin") || "");
    return new Response(result.stream, { headers: { "Content-Type": result.mimeType, "Cache-Control": "private, no-store, no-transform",
      "Access-Control-Allow-Origin": c.req.header("Origin"), Vary: "Origin", "X-Accel-Buffering": "no" } });
  }, "ticket"));
  app.get(`${witnessRoot}/witness-interrupt-media`, safe(async (c) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    const result = await witness.open(c.req.param("verificationId"), 11, witnessToken(c), c.req.header("Origin") || "");
    return new Response(result.stream, { headers: { "Content-Type": result.mimeType, "Cache-Control": "private, no-store, no-transform",
      "Access-Control-Allow-Origin": c.req.header("Origin"), Vary: "Origin", "X-Accel-Buffering": "no" } });
  }, "ticket"));
  app.post(`${witnessRoot}/witness-report`, safe(async (c) => {
    const result = await witness.report(c.req.param("verificationId"), witnessToken(c), c.req.header("Origin") || "", await jsonBody(c));
    c.header("Access-Control-Allow-Origin", c.req.header("Origin")); c.header("Vary", "Origin"); return c.json(result);
  }, "ticket"));
  app.post(`${witnessRoot}/attestations`, safe(async (c) => {
    const body = await jsonBody(c);
    if (body.challenge_id !== c.req.param("verificationId")) return c.json({ code: "REALTIME_ATTESTATION_MISMATCH", message: "证明与请求路径不一致" }, 400);
    return c.json(await witness.attest(body));
  }, "ticket"));
  app.post(`${ROOT}/sessions`, safe(async (c, auth) => {
    const result = await service.create(auth.user.id, await jsonBody(c), c.req.header("Idempotency-Key"));
    return c.json(result, result.idempotent ? 200 : 201);
  }, "user", true));
  app.get(`${ROOT}/sessions/by-request/:key`, safe(async (c, auth) => c.json({ session: await service.byRequest(auth.user.id, c.req.param("key")) })));
  app.post(`${ROOT}/sessions/by-request/:key/cancel`, safe(async (c, auth) => c.json({ session: await service.cancelByRequest(auth.user.id, c.req.param("key")) }), "user", true));
  app.get(sessionPath, safe(async (c, auth) => c.json({ session: await service.get(auth.user.id, c.req.param("id")) })));
  app.post(`${sessionPath}/turns`, safe(async (c, auth) => c.json({ session: await service.turn(auth.user.id, c.req.param("id"), await jsonBody(c)) }), "user", true));
  app.get(`${sessionPath}/turns/by-request/:key`, safe(async (c, auth) => c.json({ turn: await service.turnByRequest(auth.user.id, c.req.param("id"), c.req.param("key")) })));
  app.get(`${sessionPath}/events`, safe(async (c, auth) => c.json(await service.events(auth.user.id, c.req.param("id"), Number(c.req.query("after") || 0)))));
  app.post(`${sessionPath}/asr/utterances`, safe(async (c, auth) => c.json({ session: await service.beginAsr(auth.user.id, c.req.param("id"), await jsonBody(c)) }), "user", true));
  app.get(`${sessionPath}/asr/by-request/:key`, safe(async (c, auth) => c.json(await service.asrByRequest(auth.user.id, c.req.param("id"), c.req.param("key")))));
  app.post(`${sessionPath}/asr/input-ticket`, safe(async (c, auth) => c.json(await service.inputTicket(auth.user.id, c.req.param("id"), await jsonBody(c))), "user", true));
  for (const action of ["played", "interrupt", "cancel", "heartbeat"]) app.post(`${sessionPath}/${action}`,
    safe(async (c, auth) => c.json({ session: await service.mutate(auth.user.id, c.req.param("id"), action, await jsonBody(c)) }), "user", true));
  app.post(`${sessionPath}/media-ticket`, safe(async (c, auth) => c.json(await service.ticket(auth.user.id, c.req.param("id"), await jsonBody(c))), "user", true));
  app.get(`${sessionPath}/worker-state`, safe(async (c, auth) => c.json({ session: await state(c, auth) }), "node"));
  app.post(`${sessionPath}/worker-events`, safe(async (c, auth) => c.json({ session: await service.workerEvent(auth.binding, c.req.param("id"),
    c.req.header("X-Gulong-Realtime-Lease"), await jsonBody(c)) }), "node"));
  const mediaPath = `${sessionPath}/media/:generation/:sequence`;
  app.options(mediaPath, (c) => {
    const origin = c.req.header("Origin");
    if (!["https://www.sologle.com", "https://sologle.com", "https://111.229.70.235", "http://tauri.localhost", "tauri://localhost"].includes(origin)) return c.body(null, 403);
    c.header("Access-Control-Allow-Origin", origin); c.header("Vary", "Origin"); c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization"); c.header("Access-Control-Max-Age", "60"); return c.body(null, 204);
  });
  app.get(mediaPath, safe(async (c) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    const secret = (c.req.header("Authorization") || "").replace(/^DigitalLiveMedia /, "");
    const permit = await service.consumeTicket(c.req.param("id"), Number(c.req.param("generation")), Number(c.req.param("sequence")), secret,
      c.req.header("Origin") || "");
    const stream = relay.open(permit);
    return new Response(stream, { headers: { "Content-Type": permit.mimeType, "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no", "Access-Control-Allow-Origin": permit.origin, "Vary": "Origin", "X-Content-Type-Options": "nosniff" } });
  }, "ticket"));
  app.put(mediaPath, safe(async (c, auth) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    const permit = await service.mediaPermit(auth.binding, c.req.param("id"), c.req.header("X-Gulong-Realtime-Lease"),
      Number(c.req.param("generation")), Number(c.req.param("sequence")));
    if (c.req.header("Content-Type") !== permit.mimeType) return c.json({ code: "REALTIME_MEDIA_INVALID", message: "媒体MIME与已验收模型组合不一致" }, 400);
    permit.validate = async () => {
      const current = await service.workerState(auth.binding, c.req.param("id"), c.req.header("X-Gulong-Realtime-Lease"));
      if (current.generation !== permit.generation || ["interrupting", "cancelling", "cancelled", "expired", "failed"].includes(current.state)) {
        throw Object.assign(new Error("原媒体代次已失效"), { code: "REALTIME_GENERATION_MISMATCH", status: 409 });
      }
    };
    return c.json(await relay.write(permit, c.req.raw.body, c.req.raw.signal));
  }, "node"));
  const audioPath = `${sessionPath}/input-audio/:generation/:utterance`;
  app.options(audioPath, (c) => {
    const origin = c.req.header("Origin");
    if (!["https://www.sologle.com", "https://sologle.com", "https://111.229.70.235", "http://tauri.localhost", "tauri://localhost"].includes(origin)) return c.body(null, 403);
    c.header("Access-Control-Allow-Origin", origin); c.header("Vary", "Origin"); c.header("Access-Control-Allow-Methods", "PUT, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type"); return c.body(null, 204);
  });
  app.get(audioPath, safe(async (c, auth) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    const id = c.req.param("id"), generation = Number(c.req.param("generation")), utterance = c.req.param("utterance");
    const permit = await service.audioReadPermit(auth.binding, id, c.req.header("X-Gulong-Realtime-Lease"), generation, utterance);
    permit.validate = async () => { const current = await service.workerState(auth.binding, id, c.req.header("X-Gulong-Realtime-Lease"));
      if (current.generation !== generation || current.input_audio?.utterance_id !== utterance) throw Object.assign(new Error("原语音代次已失效"), { code: "REALTIME_GENERATION_MISMATCH", status: 409 }); };
    const stream = audioRelay.open(permit);
    try { await service.audioReaderReady(id, generation, utterance); }
    catch (error) { audioRelay.invalidate(id); throw error; }
    return new Response(stream, { headers: { "Content-Type": DIGITAL_LIVE_PCM_MIME, "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" } });
  }, "node"));
  app.put(audioPath, safe(async (c) => {
    const rejected = gatewayGuard(c); if (rejected) return rejected;
    if (c.req.header("Content-Type") !== DIGITAL_LIVE_PCM_MIME) return c.json({ code: "REALTIME_PCM_INVALID", message: "仅支持16k单声道有符号小端PCM16" }, 400);
    const permit = await service.consumeInputTicket(c.req.param("id"), Number(c.req.param("generation")), c.req.param("utterance"),
      (c.req.header("Authorization") || "").replace(/^DigitalLiveInput /, ""), c.req.header("Origin") || "");
    const result = await audioRelay.write(permit, c.req.raw.body, c.req.raw.signal);
    c.header("Access-Control-Allow-Origin", c.req.header("Origin")); c.header("Vary", "Origin"); return c.json(result);
  }, "ticket"));
  const configSchema = z.object({ schema_version: z.literal("digital-live-realtime-v1"), status: z.enum(["integration_required", "available"]),
    dispatchable: z.boolean(), acceptance: z.enum(["adapter_required", "automatic_verified"]), transport: z.literal("http-fmp4-mse-v1") }).passthrough();
  app.openAPIRegistry?.register("DigitalLiveRealtimeContract", configSchema);
  app.openAPIRegistry?.register("DigitalLiveRealtimeProvider", digitalLiveRealtimeSchemas.providers);
  app.openAPIRegistry?.register("DigitalLiveRealtimeCreate", digitalLiveRealtimeSchemas.create);
  app.openAPIRegistry?.registerComponent("securitySchemes", "digitalLiveMediaTicket", { type: "apiKey", in: "header", name: "Authorization",
    description: "DigitalLiveMedia dlm_...，仅当前所有者/代次/句段/Origin，一次使用且最长30秒；不能放URL" });
  const generation = z.number().int().positive(), sequence = z.number().int().positive(), key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/);
  const bodies = {
    [`${ROOT}/nodes/report`]: digitalLiveRealtimeSchemas.report,
    [`${ROOT}/verifications/next`]: digitalLiveVerificationSchemas.next,
    [`${ROOT}/verifications/{verificationId}/result`]: digitalLiveVerificationSchemas.result,
    [`${ROOT}/verifications/{verificationId}/witness-tickets`]: digitalLiveWitnessSchemas.ticket,
    [`${ROOT}/verifications/{verificationId}/witness-report`]: digitalLiveWitnessSchemas.report,
    [`${ROOT}/verifications/{verificationId}/attestations`]: digitalLiveWitnessSchemas.attestation,
    [`${ROOT}/verifications/{verificationId}/stopped`]: z.object({ owned_worker_stopped: z.literal(true) }),
    [`${ROOT}/nodes/claim`]: z.object({ lease_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), dry_run: z.boolean().optional() }),
    [`${ROOT}/sessions`]: digitalLiveRealtimeSchemas.create,
    [`${ROOT}/sessions/{id}/turns`]: digitalLiveRealtimeSchemas.turn,
    [`${ROOT}/sessions/{id}/asr/utterances`]: digitalLiveRealtimeSchemas.asr,
    [`${ROOT}/sessions/{id}/asr/input-ticket`]: z.object({ generation, utterance_id: key, origin: z.string().max(100) }),
    [`${ROOT}/sessions/{id}/played`]: z.object({ generation, sequence, turn_id: key }),
    [`${ROOT}/sessions/{id}/interrupt`]: z.object({ generation, request_id: key }),
    [`${ROOT}/sessions/{id}/media-ticket`]: z.object({ generation, sequence, turn_id: key, media_generation: generation, turn_sequence: sequence,
      origin: z.enum(["https://www.sologle.com", "https://sologle.com", "https://111.229.70.235", "tauri://localhost", "http://tauri.localhost"]) }),
    [`${ROOT}/sessions/{id}/worker-events`]: z.object({ generation, event: z.enum(["heartbeat", "interrupted", "stopped", "text_delta", "media_announcement", "turn_finished", "asr_partial", "asr_final"]), providers: digitalLiveRealtimeSchemas.providers,
      event_id: key.optional(), event_sequence: sequence.optional(), turn_id: key.optional(), media_generation: generation.optional(),
      delta: z.string().max(4096).optional(), sequence: sequence.optional(), turn_sequence: sequence.optional(), text: z.string().max(2000).optional(),
      duration_seconds: z.number().positive().max(60).optional(), timestamp_offset: z.number().min(0).max(1800).optional(), mime_type: z.string().max(120).optional(),
      utterance_id: key.optional(), input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), input_bytes: z.number().int().positive().max(640000).optional(),
      final_sequence: sequence.optional() }),
  };
  for (const [method, path, summary] of [
    ["get", `${ROOT}/config`, "实时会话合同；不把候选节点或异步证明标为可派发"],
    ["get", `${ROOT}/providers`, "按本人权益/分组及完整角色ID/音色/摘要筛选真实已验证provider；未有验证器返回空数组"],
    ["post", `${ROOT}/nodes/report`, "使用绑定身份登记精确实时provider清单，仅候选"],
    ["post", `${ROOT}/nodes/claim`, "指定节点以原租约密钥幂等领取实时会话"],
    ["post", `${ROOT}/verifications/next`, "同节点原键领取有界候选真实挑战；与九项共享全站四槽/每日预算，dry_run无副作用"],
    ["get", `${ROOT}/verifications/pending`, "GGE本人、同组、未过期挑战只读发现；不新建验收/不签票/不扩展其他账号"],
    ["get", `${ROOT}/verifications/by-request/{key}`, "按原请求恢复候选挑战，严禁新键重跑"],
    ["get", `${ROOT}/verifications/{verificationId}`, "查询原挑战及网关实际媒体摘要；不是激活证明"],
    ["post", `${ROOT}/verifications/{verificationId}/result`, "有界声明与服务端字节证据分离验证；当前绝不写active证明"],
    ["post", `${ROOT}/verifications/{verificationId}/stopped`, "owned worker停止后幂等释放原物理租约"],
    ["post", `${ROOT}/verifications/{verificationId}/witness-tickets`, "GGE原账号领取60秒一次用途/nonce/制品绑定的播放器见证票据；不是注册或激活"],
    ["get", `${ROOT}/verifications/{verificationId}/witness-state`, "GGE原账号按原request_id恢复见证状态，不重发票据、不重跑模型"],
    ["get", `${ROOT}/verifications/{verificationId}/witness-media/{sequence}`, "腾讯网关一次DigitalLiveWitness header票据读取原验收媒体；不存完整MP4"],
    ["get", `${ROOT}/verifications/{verificationId}/witness-interrupt-media`, "独立在途打断探针，复用第五段输出不新增模型推理；不声称完整ended或完整摘要"],
    ["put", `${ROOT}/verifications/{verificationId}/interrupt-media`, "绑定节点复用已有第五段媒体供独立打断探针，最多4MiB/10秒且不可重复"],
    ["post", `${ROOT}/verifications/{verificationId}/witness-report`, "客户端完整播放测量与网关摘要核对，仍不等于受信模型/播放证明"],
    ["post", `${ROOT}/verifications/{verificationId}/attestations`, "独立运行时及播放器观察器Ed25519签名；源码登记公钥与制品，不接受自注册或手填active"],
    ["put", `${ROOT}/verifications/{verificationId}/media/{sequence}`, "腾讯网关完整流式收取并丢弃固定验收媒体，仅存服务端摘要"],
    ["post", `${ROOT}/sessions`, "同账户与产品原键创建零费用会话；无真实实时证明时503"],
    ["get", `${ROOT}/sessions/by-request/{key}`, "原键恢复会话；跨账户404"],
    ["post", `${ROOT}/sessions/by-request/{key}/cancel`, "原键取消及取消前建单墓碑"],
    ["get", `${ROOT}/sessions/{id}`, "查看本人实时会话及播放排空状态"],
    ["post", `${ROOT}/sessions/{id}/turns`, "用户原文创建完整节点对话轮次；固定27B、8192上下文，不要求客户端本地先跑LLM"],
    ["get", `${ROOT}/sessions/{id}/turns/by-request/{key}`, "原轮次请求键查询；未知结果不重复执行模型"],
    ["get", `${ROOT}/sessions/{id}/events`, "按after游标读取最多128条有界文字/媒体/结束事件，过期游标409后查原会话快照"],
    ["post", `${ROOT}/sessions/{id}/asr/utterances`, "有界远程PCM语句入口；要求独立真实ASR证明且按原语音/轮次键幂等"],
    ["get", `${ROOT}/sessions/{id}/asr/by-request/{key}`, "查询原语音上传/识别状态，未知不得重新录音或重传"],
    ["post", `${ROOT}/sessions/{id}/asr/input-ticket`, "签发同代次同语句一次输入票据，输入开始后不再签新票据"],
    ["get", `${ROOT}/sessions/{id}/input-audio/{generation}/{utterance}`, "绑定节点先建立PCM读取连接；不包含账号长期凭据/持久录音"],
    ["put", `${ROOT}/sessions/{id}/input-audio/{generation}/{utterance}`, "一次DigitalLiveInput header票据有界直通PCM，最多20秒/640000字节"],
    ...["played", "interrupt", "cancel", "heartbeat", "media-ticket", "worker-events"].map((action) => ["post", `${ROOT}/sessions/{id}/${action}`, `实时会话${action}，校验代次/归属/租约`]),
    ["get", `${ROOT}/sessions/{id}/worker-state`, "仅绑定执行节点查询有界句队列及打断状态；无用户隐私字段"],
    ["get", `${ROOT}/sessions/{id}/media/{generation}/{sequence}`, "腾讯常驻网关一次性header票据流式读取H264/AAC fMP4"],
    ["put", `${ROOT}/sessions/{id}/media/{generation}/{sequence}`, "指定节点带绑定与租约向腾讯网关流式写入媒体，禁止Vercel内存配对"],
  ]) app.openAPIRegistry?.registerPath({ method, path, tags: ["Digital Live Realtime"], summary,
    description: "digital-live-realtime-v1；现有digital_live.use权益，所有金额0分且无钱包/分佣；生产尚无实时验证器，候选清单不能派发。详见docs/digital-live-realtime-v1.md。节点worker-state每秒读取，客户端每5秒heartbeat，worker租约15秒，media独立30秒一次性header票据。仅腾讯常驻进程配对媒体流。",
    ...(path.endsWith("/verifications/pending") ? { request: { query: digitalLiveWitnessSchemas.discoveryQuery }, security: [{ gulongEngineDesktopBearer: [] }, { sessionCookie: [] }] }
      : bodies[path] ? { request: { body: { required: true, content: { "application/json": { schema: bodies[path] } } } } } : {}),
    ...(path.includes("/witness-") ? { security: path.endsWith("/witness-tickets") || path.endsWith("/witness-state")
      ? [{ gulongEngineDesktopBearer: [] }, { sessionCookie: [] }] : [{ digitalLiveWitnessTicket: [] }] }
      : method === "get" && path.includes("/media/") ? { security: [{ digitalLiveMediaTicket: [] }] } : {}),
    responses: { 200: { description: "按归属及代次返回会话状态/有界媒体流；不代表真实节点已验收",
      ...(path.endsWith("/verifications/pending") ? { content: { "application/json": { schema: digitalLiveWitnessSchemas.discovery } } } : {}) },
      401: { description: "身份或一次媒体票据无效" }, 403: { description: "无权益/分组不符/来源不符" },
      409: { description: "原键/代次/序号/物理租约冲突" }, 503: { description: "REALTIME_INTEGRATION_REQUIRED：无自动实测连续实时节点" } } });
  app.openAPIRegistry?.register("DigitalLivePlaybackWitness", digitalLiveWitnessSchemas.report);
  app.openAPIRegistry?.register("DigitalLiveWitnessDiscovery", digitalLiveWitnessSchemas.discovery);
  app.openAPIRegistry?.registerComponent("securitySchemes", "digitalLiveWitnessTicket", { type: "apiKey", in: "header", name: "Authorization",
    description: `${DIGITAL_LIVE_WITNESS_VERSION}；DigitalLiveWitness dlw_...，60秒一次且绑定用途/Origin/nonce，不放URL` });
  return { service, relay, audioRelay, verification, witness };
}
