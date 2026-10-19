import { createHash } from "node:crypto";

/** A bounded, single-process byte relay. No model, COS object, complete MP4 or
 * base64 buffer is created here. Consumers must connect to the same persistent
 * Tencent process. A deployment/disconnect cancels only the owning session. */
export function createDigitalLiveMediaRelay({ maxStreams = 8, maxBytes = 16 * 1024 * 1024, maxChunkBytes = 256 * 1024,
  timeoutMs = 60_000, writeTimeoutMs = 5000, format = "fmp4", onSent = async () => {}, onFailed = async () => {} } = {}) {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new TypeError("Invalid bounded relay chunk size");
  const streams = new Map();
  const keyOf = (p) => `${p.sessionId}:${p.generation}:${p.sequence}`;
  const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
  function framingInspector() {
    let header = new Uint8Array(0), remaining = 0, boxes = 0, moov = false, moof = false, mdat = false;
    return { push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining) { const n = Math.min(remaining, chunk.length - offset); remaining -= n; offset += n; continue; }
        const n = Math.min(8 - header.length, chunk.length - offset), next = new Uint8Array(header.length + n);
        next.set(header); next.set(chunk.subarray(offset, offset + n), header.length); header = next; offset += n;
        if (header.length < 8) continue;
        const size = new DataView(header.buffer).getUint32(0), type = new TextDecoder().decode(header.subarray(4));
        if (size < 8 || size > maxBytes || !["ftyp", "moov", "moof", "mdat", "free", "sidx", "styp", "mfra", "skip"].includes(type)
          || (!boxes && type !== "ftyp") || (type === "moof" && !moov) || (type === "mdat" && !moof)) {
          throw error("REALTIME_FMP4_INVALID", "媒体不是有界的初始化片段加 fMP4 moof/mdat 流", 400);
        }
        if (type === "moov") moov = true;
        if (type === "moof") moof = true;
        if (type === "mdat" && size > 8) mdat = true;
        boxes += 1; remaining = size - 8; header = new Uint8Array(0);
      }
    }, finish() {
      if (remaining || header.length || !moov || !moof || !mdat) throw error("REALTIME_FMP4_INVALID", "媒体片段不完整，不能确认发送完成", 400);
    } };
  }
  function close(entry, cause, notifyFailure = true) {
    if (entry.closed) return;
    entry.closed = true; clearTimeout(entry.timer); clearInterval(entry.validationTimer); streams.delete(entry.key);
    if (cause) {
      entry.writer.abort(cause).catch(() => {});
      entry.inputReader?.cancel(cause).catch(() => {});
      if (notifyFailure) Promise.resolve(onFailed(entry.sessionId)).catch(() => {});
    }
  }
  function open(permit) {
    const key = keyOf(permit);
    if (streams.has(key)) throw error("REALTIME_MEDIA_ALREADY_CONNECTED", "原句段媒体连接已存在");
    if (streams.size >= maxStreams) throw error("REALTIME_GATEWAY_BUSY", "媒体网关连接已满，请稍后重试", 503);
    const pipe = new TransformStream(undefined, new ByteLengthQueuingStrategy({ highWaterMark: maxChunkBytes }),
      new ByteLengthQueuingStrategy({ highWaterMark: maxChunkBytes }));
    const entry = { ...permit, key, writer: pipe.writable.getWriter(), writing: false, closed: false };
    entry.timer = setTimeout(() => close(entry, error("REALTIME_MEDIA_TIMEOUT", "媒体连接超时")), timeoutMs); entry.timer.unref?.();
    streams.set(key, entry);
    // Wrap cancel: a browser disconnect must terminate its session and writer.
    const reader = pipe.readable.getReader();
    return new ReadableStream({ async pull(controller) {
      try { const result = await reader.read(); if (result.done) controller.close(); else controller.enqueue(result.value); }
      catch (cause) { controller.error(cause); }
    }, async cancel() { close(entry, error("REALTIME_MEDIA_DISCONNECTED", "媒体连接已断开")); await reader.cancel().catch(() => {}); } },
    new ByteLengthQueuingStrategy({ highWaterMark: maxChunkBytes }));
  }
  async function write(permit, body, signal) {
    const entry = streams.get(keyOf(permit));
    if (!entry || entry.closed) throw error("REALTIME_MEDIA_READER_REQUIRED", "请先使用短期票据建立媒体读取连接");
    if (entry.writing) throw error("REALTIME_MEDIA_ALREADY_WRITING", "原句段媒体正在传输，不能重复上传");
    if (!body || permit.mimeType !== entry.mimeType) throw error("REALTIME_MEDIA_INVALID", "媒体格式不匹配", 400);
    entry.writing = true;
    const validate = permit.validate || entry.validate;
    if (validate) {
      entry.validationTimer = setInterval(() => {
        if (entry.validating || entry.closed) return;
        entry.validating = true;
        Promise.resolve(validate()).catch((cause) => close(entry, cause)).finally(() => { entry.validating = false; });
      }, 2000); entry.validationTimer.unref?.();
    }
    let bytes = 0, header = new Uint8Array(0), checked = format === "pcm16";
    const framing = format === "pcm16" ? null : framingInspector(), hash = createHash("sha256");
    const reader = body.getReader();
    entry.inputReader = reader;
    const abort = () => close(entry, error("REALTIME_MEDIA_DISCONNECTED", "媒体上传连接已断开"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted || entry.closed) throw error("REALTIME_MEDIA_DISCONNECTED", "媒体传输已取消");
        const result = await reader.read(); if (result.done) break;
        const wire = result.value; bytes += wire?.byteLength || 0;
        if (!(wire instanceof Uint8Array) || bytes > maxBytes) throw error("REALTIME_MEDIA_LIMIT", "媒体总大小超过安全上限", 413);
        // HTTP/read chunk boundaries are not producer frame boundaries. Split
        // legitimate coalesced network reads into bounded processing slices.
        for (let offset = 0; offset < wire.byteLength; offset += maxChunkBytes) {
          const chunk = wire.subarray(offset, offset + maxChunkBytes);
          hash.update(chunk); framing?.push(chunk);
          if (!checked) {
            const next = new Uint8Array(header.length + chunk.length); next.set(header); next.set(chunk, header.length); header = next;
            if (header.length < 12) continue;
            const type = new TextDecoder().decode(header.subarray(4, 8));
            if (type !== "ftyp") throw error("REALTIME_FMP4_INVALID", "每句媒体必须从独立的 fMP4 初始化片段开始", 400);
            checked = true;
          }
          let timeout;
          try { await Promise.race([entry.writer.write(header.length ? header : chunk), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(error("REALTIME_BACKPRESSURE_TIMEOUT", "客户端未及时读取媒体，已取消本会话")), writeTimeoutMs);
            timeout.unref?.();
          })]); } finally { clearTimeout(timeout); }
          header = new Uint8Array(0);
        }
      }
      if (!checked || !bytes) throw error("REALTIME_FMP4_INVALID", "媒体初始化片段不完整", 400);
      framing?.finish();
      if (format === "pcm16" && bytes % 2) throw error("REALTIME_PCM_INVALID", "PCM16输入必须是完整的16位采样", 400);
      const sha256 = hash.digest("hex");
      await onSent(entry.sessionId, entry.generation, entry.sequence, { bytes, sha256 });
      await entry.writer.close(); close(entry); return { ok: true, bytes, sha256 };
    } catch (cause) { close(entry, cause); await reader.cancel().catch(() => {}); throw cause; }
    finally { signal?.removeEventListener("abort", abort); entry.inputReader = null; reader.releaseLock(); }
  }
  function invalidate(sessionId) { for (const entry of [...streams.values()]) if (entry.sessionId === sessionId) close(entry, error("REALTIME_MEDIA_CANCELLED", "会话已打断或取消"), false); }
  return { open, write, invalidate, hasReader: (permit) => streams.has(keyOf(permit)), activeCount: () => streams.size };
}
