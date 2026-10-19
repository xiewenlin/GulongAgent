import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { copyObject, createPresignedDownloadUrl, createPresignedPutUrl, deleteObject, headObject, sanitizeFilename } from "./cos.js";
import { inspectFlacStream } from "./capability-flac.js";
import { validateProbeOutputDescriptor, validateProbeOutputSet } from "./capability-probe-outputs.js";
import { inspectProbeArchive } from "./capability-probe-archive.js";

const MAX_BYTES = 64 * 1024 * 1024;
const challengePattern = /^gcv_[a-f0-9-]{36}$/;
const fail = (message, code = "VERIFICATION_OUTPUT_INVALID", status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; }
function header(head, key) {
  return String(Object.entries(head.headers || head || {}).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || "");
}
function prefix(challenge, binding) {
  if (!challengePattern.test(challenge._id) || String(challenge.bindingId) !== String(binding._id)) fail("自动验收输出不属于当前节点");
  return `capability-verifications/${challenge._id}/`;
}

export function inspectVerificationBinary(bytes, contentType, { maskStats = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) fail("验收输出文件不完整");
  if (["application/json", "application/x-ndjson"].includes(contentType)) {
    if (bytes.length > 4 * 1024 * 1024) fail("逐帧结果超过自动验收安全预算");
    let text, result;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
      if (contentType === "application/json") result = JSON.parse(text);
      else {
        const lines = text.trimEnd().split("\n");
        if (!lines.length || lines.length > 4096 || lines.some((line) => !line.trim())) fail("逐帧记录必须是完整的非空JSONL");
        result = lines.map((line) => JSON.parse(line));
      }
    } catch { fail("自动验收结构化结果不是完整的UTF-8 JSON"); }
    const pending = [[result, 0]]; let nodes = 0;
    while (pending.length) {
      const [value, depth] = pending.pop();
      if (++nodes > 20000 || depth > 24) fail("自动验收结构化结果层级或节点数量超限");
      if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) fail("自动验收结构化结果含有非法字段");
        pending.push([item, depth + 1]);
      }
    }
    return contentType === "application/json" ? { json: result } : { jsonl: result };
  }
  if (contentType === "application/zip") return inspectProbeArchive(bytes, (png) => inspectVerificationBinary(png, "image/png", { maskStats: true }));
  if (bytes.length < 24) fail("验收输出文件不完整");
  if (contentType === "image/png") {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") fail("输出不是有效的 PNG 图像");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], color = bytes[25];
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
    if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || !width || !height || width * height > 4194304 || depth !== 8 || !channels || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) fail("自动验收 PNG 须为有效的非交错8位图像，且不超过2048平方像素");
    let offset = 8, hasImage = false, ended = false; const compressed = [];
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
      if (size > bytes.length - offset - 12) fail("PNG 图像数据被截断");
      if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) fail("PNG 图像完整性校验失败");
      if (type === "IDAT" && size > 0) { hasImage = true; compressed.push(bytes.subarray(offset + 8, offset + 8 + size)); }
      offset += size + 12;
      if (type === "IEND") { ended = size === 0 && offset === bytes.length; break; }
    }
    if (!hasImage || !ended) fail("PNG 图像缺少完整像素数据或结束标记");
    const rowBytes = width * channels + 1, expectedBytes = rowBytes * height;
    let pixels;
    try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes }); }
    catch { fail("PNG 像素数据无法完整解压"); }
    if (pixels.length !== expectedBytes) fail("PNG 像素数据长度不正确");
    for (let row = 0; row < height; row += 1) if (pixels[row * rowBytes] > 4) fail("PNG 像素过滤参数不正确");
    const metadata = { actualContentType: contentType, width, height };
    if (maskStats) {
      let previous = Buffer.alloc(width * channels), foreground = 0;
      const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
      for (let y = 0; y < height; y++) {
        const row = Buffer.alloc(width * channels), filter = pixels[y * rowBytes];
        for (let x = 0; x < row.length; x++) {
          const a = x >= channels ? row[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
          const prediction = filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0;
          row[x] = (pixels[y * rowBytes + 1 + x] + prediction) & 255;
        }
        for (let x = 0; x < width; x++) if (row[x * channels + ([4, 6].includes(color) ? channels - 1 : 0)] > 127) foreground++;
        previous = row;
      }
      metadata.foregroundRatio = foreground / (width * height);
    }
    return metadata;
  }
  if (contentType === "audio/wav") {
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) fail("WAV 音频数据不完整");
    let format, dataBytes = 0; const dataChunks = [];
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      if (start + size > bytes.length) fail("WAV 音频数据被截断");
      if (kind === "fmt " && size >= 16) format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
      if (kind === "data") { dataBytes += size; dataChunks.push({ start, size }); }
      offset = start + size + size % 2;
    }
    if (!format || ![1, 3].includes(format.encoding) || !dataBytes || format.channels < 1 || format.channels > 8 || format.sampleRate < 8000 || format.sampleRate > 192000
      || ![8, 16, 24, 32, 64].includes(format.bits) || format.blockAlign !== format.channels * format.bits / 8
      || format.byteRate !== format.sampleRate * format.blockAlign || dataBytes % format.blockAlign) fail("WAV 音频采样参数无效");
    if (format.encoding === 1 && format.bits > 32 || format.encoding === 3 && ![32, 64].includes(format.bits)) fail("WAV 音频采样编码无效");
    let nonSilent = false;
    const sampleBytes = format.bits / 8;
    for (const chunk of dataChunks) for (let offset = chunk.start; offset < chunk.start + chunk.size; offset += sampleBytes) {
      const value = format.encoding === 3 ? (format.bits === 32 ? bytes.readFloatLE(offset) : bytes.readDoubleLE(offset))
        : format.bits === 8 ? (bytes[offset] - 128) / 128 : bytes.readIntLE(offset, sampleBytes) / 2 ** (format.bits - 1);
      if (!Number.isFinite(value)) fail("WAV 音频包含无效采样值");
      if (Math.abs(value) > 0.0001) nonSilent = true;
    }
    return { actualContentType: contentType, channels: format.channels, sampleRate: format.sampleRate, durationSeconds: dataBytes / format.byteRate, nonSilent };
  }
  fail("自动验收暂不支持此输出文件格式");
}

/** Only short-lived probe objects, never user works. Credentials/URLs stay out of audit records. */
export function createCapabilityVerificationMedia({ getCollection, issueUploadUrl = createPresignedPutUrl,
  issueDownloadUrl = createPresignedDownloadUrl, inspectObject = headObject, publishObject = copyObject,
  removeObject = deleteObject, fetchObject = fetch, now = () => new Date() }) {
  async function issueProbeOutputUpload({ binding, challenge, output }) {
    const root = prefix(challenge, binding), instant = new Date(now());
    const filename = sanitizeFilename(output.filename, "probe.bin").replace(/\.{2,}/g, "-");
    const contentType = String(output.content_type || "").toLowerCase();
    const sha256 = String(output.sha256 || "").toLowerCase();
    validateProbeOutputDescriptor(challenge, output);
    if (!Number.isSafeInteger(output.bytes) || output.bytes < 1 || output.bytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) fail("验收输出的文件格式、角色、大小或摘要不符合当前探测合同", "VERIFICATION_OUTPUT_INVALID", 400);
    if (challenge.probeKind === "image" && output.bytes > 20 * 1024 * 1024 || challenge.probeKind === "tts" && output.bytes > 32 * 1024 * 1024) fail("验收文件超过本能力允许的大小", "VERIFICATION_OUTPUT_INVALID", 400);
    const collection = await getCollection("capabilityVerificationOutputs");
    const identityRole = challenge.probeOutputRules ? output.role : "primary_audio"; // Preserve outstanding legacy ticket identities.
    const outputId = createHash("sha256").update(`${challenge._id}:${challenge.leaseTokenHash}:${identityRole}`).digest("base64url");
    const objectKey = `${root}uploads/${outputId}-${filename}`;
    const expiresAt = new Date(Math.min(+new Date(challenge.leaseExpiresAt), +instant + 10 * 60_000));
    if (expiresAt <= instant) fail("自动验收执行租约已过期", "VERIFICATION_LEASE_EXPIRED");
    const record = { _id: outputId, challengeId: challenge._id, bindingId: String(binding._id), leaseTokenHash: challenge.leaseTokenHash,
      outputId, objectKey, filename, role: output.role, contentType, bytes: output.bytes, sha256, expiresAt, cleanupAt: new Date(+instant + 24 * 60 * 60_000), status: "issued", createdAt: instant };
    const existing = await collection.findOne({ _id: outputId });
    if (existing && ["filename", "contentType", "bytes", "sha256", "objectKey"].some((key) => existing[key] !== record[key])) fail("同一自动验收输出不能更改文件清单", "VERIFICATION_OUTPUT_CONFLICT");
    if (!existing) { try { await collection.insertOne(record); } catch (error) { if (error?.code !== 11000) throw error;
      const winner = await collection.findOne({ _id: outputId });
      if (!winner || ["filename", "contentType", "bytes", "sha256", "objectKey"].some((key) => winner[key] !== record[key])) fail("自动验收输出票据冲突");
    } }
    const headers = { "Content-Type": contentType, "x-cos-meta-sha256": sha256, "x-cos-meta-bytes": String(output.bytes), "x-cos-meta-verification-id": challenge._id, "x-cos-meta-binding-id": String(binding._id) };
    return { output_id: outputId, object_key: objectKey, url: issueUploadUrl(objectKey, { expires: Math.max(1, Math.floor((+expiresAt - +instant) / 1000)), headers }), method: "PUT", headers, expires_at: expiresAt.toISOString() };
  }
  async function verifyMediaOutputs({ binding, challenge, outputs }) {
    const root = prefix(challenge, binding), instant = new Date(now());
    if (!Array.isArray(outputs) || !outputs.length || outputs.length > 4 || outputs.some((item) => typeof item?.output_id !== "string")
      || new Set(outputs.map((item) => item.output_id)).size !== outputs.length) fail("请提交本次自动验收的不重复输出编号");
    const collection = await getCollection("capabilityVerificationOutputs");
    const records = await Promise.all(outputs.map((item) => collection.findOne({ _id: item.output_id, challengeId: challenge._id, bindingId: String(binding._id), leaseTokenHash: challenge.leaseTokenHash })));
    if (records.some((record) => !record || record.expiresAt <= instant || !record.objectKey.startsWith(`${root}uploads/`))) fail("自动验收输出票据已失效或不属于当前租约");
    validateProbeOutputSet(challenge, records);
    const verified = [];
    for (const record of records) {
      const head = await inspectObject(record.objectKey);
      if (Number(header(head, "content-length")) !== record.bytes || header(head, "x-cos-meta-sha256").toLowerCase() !== record.sha256
        || header(head, "x-cos-meta-verification-id") !== challenge._id || header(head, "x-cos-meta-binding-id") !== String(binding._id)
        || header(head, "x-cos-meta-bytes") !== String(record.bytes) || !header(head, "etag")) fail("自动验收文件大小、摘要或归属不匹配");
      // PUT remains usable until expiry. Verify an immutable conditional copy so
      // a late overwrite cannot change what was actually tested.
      const copyKey = `${root}verified/${record.outputId}.bin`;
      await collection.updateOne({ _id: record._id }, { $set: { copyKey, status: "verifying", updatedAt: instant } });
      await publishObject(record.objectKey, copyKey, { sourceETag: header(head, "etag") });
      const response = await fetchObject(issueDownloadUrl(copyKey, { expires: 120 }), { signal: AbortSignal.timeout(60_000), redirect: "error" });
      if (!response.ok || !response.body) fail("自动验收文件暂时无法读取，请稍后重试", "VERIFICATION_OUTPUT_UNAVAILABLE", 503);
      let metadata;
      if (["audio/flac", "audio/x-flac"].includes(record.contentType)) {
        const audio = await inspectFlacStream(response.body, { expectedBytes: record.bytes, expectedSha256: record.sha256, maxBytes: MAX_BYTES });
        metadata = { durationSeconds: audio.durationSeconds, sampleRate: audio.sampleRate, channels: audio.channels };
      } else {
        const buffer = Buffer.allocUnsafe(record.bytes), hash = createHash("sha256"); let count = 0;
        for await (const chunk of response.body) {
          if (count + chunk.byteLength > record.bytes) fail("验收文件实际大小超过声明");
          buffer.set(chunk, count); count += chunk.byteLength; hash.update(chunk);
        }
        if (count !== record.bytes || hash.digest("hex") !== record.sha256) fail("验收文件实际内容与大小或摘要不一致");
        metadata = inspectVerificationBinary(buffer, record.contentType);
      }
      await collection.updateOne({ _id: record._id, copyKey }, { $set: { status: "verified", verifiedAt: instant } });
      verified.push({ outputId: record.outputId, role: record.role, filename: record.filename, contentType: record.contentType,
        bytes: record.bytes, sha256: record.sha256, objectKey: copyKey, ...metadata });
    }
    return verified;
  }
  async function cleanup({ limit = 30 } = {}) {
    const instant = new Date(now()), collection = await getCollection("capabilityVerificationOutputs");
    const rows = await collection.find({ cleanupAt: { $lte: instant }, status: { $ne: "deleted" } }).sort({ cleanupAt: 1 }).limit(Math.max(1, Math.min(50, limit))).toArray();
    const result = { examined: rows.length, deleted: 0, retry: 0 };
    for (const row of rows) {
      const root = challengePattern.test(row.challengeId) ? `capability-verifications/${row.challengeId}/` : null;
      const keys = [row.objectKey, row.copyKey].filter(Boolean);
      if (!root || keys.some((key) => !key.startsWith(root) || key.includes("..") || key.includes("\\"))) { result.retry += 1; continue; }
      try { for (const key of keys) await removeObject(key); await collection.updateOne({ _id: row._id }, { $set: { status: "deleted", deletedAt: instant } }); result.deleted += 1; }
      catch { await collection.updateOne({ _id: row._id }, { $set: { cleanupAt: new Date(+instant + 10 * 60_000), cleanupError: "VERIFICATION_OUTPUT_CLEANUP_RETRY" } }); result.retry += 1; }
    }
    return result;
  }
  return { issueProbeOutputUpload, verifyMediaOutputs, cleanup };
}
