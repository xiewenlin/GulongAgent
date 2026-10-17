import { createHash } from "node:crypto";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
const MAX_METADATA_BLOCKS = 128;

function invalid(message, code = "FLAC_INVALID", status = 409) {
  throw Object.assign(new Error(message), { code, status });
}

function streamInfo(bytes) {
  const minimumBlockSize = bytes.readUInt16BE(0);
  const maximumBlockSize = bytes.readUInt16BE(2);
  const minimumFrameSize = bytes.readUIntBE(4, 3);
  const maximumFrameSize = bytes.readUIntBE(7, 3);
  const packed = bytes.readBigUInt64BE(10);
  const sampleRate = Number(packed >> 44n);
  const channels = Number((packed >> 41n) & 7n) + 1;
  const bitsPerSample = Number((packed >> 36n) & 31n) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);
  // RFC 9639 section 8.2. These are the stream's own binary fields, not
  // consumer-supplied JSON or COS x-cos-meta-* duration values.
  if (minimumBlockSize < 16 || maximumBlockSize < minimumBlockSize) invalid("FLAC 的采样块长度无效", "FLAC_STREAMINFO_INVALID");
  if (minimumFrameSize && maximumFrameSize && minimumFrameSize > maximumFrameSize) invalid("FLAC 的音频帧长度范围无效", "FLAC_STREAMINFO_INVALID");
  if (sampleRate < 1 || sampleRate > 1048575 || channels < 1 || channels > 8 || bitsPerSample < 4 || bitsPerSample > 32) invalid("FLAC 的采样率、声道数或采样位深无效", "FLAC_STREAMINFO_INVALID");
  if (!totalSamples) invalid("FLAC 未记录完整音频采样总数，无法验证实际时长", "FLAC_DURATION_UNKNOWN");
  const durationSeconds = totalSamples / sampleRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) invalid("FLAC 音频时长无效", "FLAC_STREAMINFO_INVALID");
  return { sampleRate, channels, bitsPerSample, totalSamples, durationSeconds };
}

function checkFirstFrame(prefix, info) {
  if (prefix[0] !== 0xff || (prefix[1] & 0xfe) !== 0xf8) invalid("FLAC 缺少有效的音频帧同步头", "FLAC_FRAME_INVALID");
  const blockCode = prefix[2] >> 4;
  const rateCode = prefix[2] & 15;
  const channelCode = prefix[3] >> 4;
  const depthCode = (prefix[3] >> 1) & 7;
  if (!blockCode || rateCode === 15 || channelCode > 10 || depthCode === 3 || (prefix[3] & 1)) invalid("FLAC 音频帧头使用了无效的保留字段", "FLAC_FRAME_INVALID");
  const channels = channelCode < 8 ? channelCode + 1 : 2;
  if (channels !== info.channels) invalid("FLAC 音频帧声道数与完整音频头不一致", "FLAC_FRAME_INVALID");
  const depth = { 1: 8, 2: 12, 4: 16, 5: 20, 6: 24, 7: 32 }[depthCode];
  if (depth && depth !== info.bitsPerSample) invalid("FLAC 音频帧位深与完整音频头不一致", "FLAC_FRAME_INVALID");
  const sampleRate = { 1: 88200, 2: 176400, 3: 192000, 4: 8000, 5: 16000, 6: 22050, 7: 24000, 8: 32000, 9: 44100, 10: 48000, 11: 96000 }[rateCode];
  if (sampleRate && sampleRate !== info.sampleRate) invalid("FLAC 音频帧采样率与完整音频头不一致", "FLAC_FRAME_INVALID");
}

/**
 * Inspect the actual private-object byte stream with bounded memory. This
 * validates container/header structure, hashes every byte and obtains duration
 * from native STREAMINFO. It is deliberately not a full PCM decoder/MD5 check:
 * trusted consumer acceptance + whole-audio ASR remain mandatory independently.
 * No complete audio buffer or caller-provided duration is ever used.
 */
export async function inspectFlacStream(stream, {
  maxBytes = DEFAULT_MAX_BYTES, maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES, expectedBytes, expectedSha256,
} = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") invalid("音频校验仅接受异步字节流", "FLAC_STREAM_REQUIRED", 400);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 50 || !Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 42 || maxHeaderBytes > 16 * 1024 * 1024) invalid("音频字节或头部校验上限配置无效", "FLAC_LIMIT_INVALID", 400);
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maxBytes)) invalid("待验证的音频字节数无效或超出上限", "FLAC_EXPECTED_BYTES_INVALID", 400);
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(expectedSha256))) invalid("待验证的音频 SHA-256 格式无效", "FLAC_EXPECTED_HASH_INVALID", 400);

  const digest = createHash("sha256");
  const magic = Buffer.alloc(4);
  const metadataHeader = Buffer.alloc(4);
  const information = Buffer.alloc(34);
  const framePrefix = Buffer.alloc(6);
  let bytes = 0, headerBytes = 0, magicOffset = 0, metadataOffset = 0, blockCount = 0;
  let blockLength = 0, blockOffset = 0, blockType = -1, lastBlock = false, info = null;
  let frameBytes = 0, frameOffset = 0, state = "magic";

  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) invalid("音频流包含非字节数据，无法验证完整文件", "FLAC_STREAM_INVALID", 400);
      if (!chunk.byteLength) continue;
      if (chunk.byteLength > maxBytes - bytes) invalid("音频文件超过允许的校验大小，已停止读取", "FLAC_SIZE_LIMIT_EXCEEDED", 413);
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      bytes += data.length;
      digest.update(data);
      let offset = 0;
      while (offset < data.length) {
        if (state === "magic") {
          const length = Math.min(4 - magicOffset, data.length - offset);
          data.copy(magic, magicOffset, offset, offset + length);
          magicOffset += length; offset += length; headerBytes += length;
          if (magicOffset < 4) continue;
          if (magic.toString("ascii") !== "fLaC") invalid("实际音频不是原生 FLAC 文件，不能仅修改扩展名或 MIME 类型", "FLAC_MAGIC_INVALID");
          state = "metadata_header";
        } else if (state === "metadata_header") {
          const length = Math.min(4 - metadataOffset, data.length - offset);
          data.copy(metadataHeader, metadataOffset, offset, offset + length);
          metadataOffset += length; offset += length; headerBytes += length;
          if (headerBytes > maxHeaderBytes) invalid("FLAC 元数据头超过安全上限", "FLAC_HEADER_LIMIT_EXCEEDED", 413);
          if (metadataOffset < 4) continue;
          blockCount += 1;
          if (blockCount > MAX_METADATA_BLOCKS) invalid("FLAC 元数据块数量超过安全上限", "FLAC_HEADER_LIMIT_EXCEEDED", 413);
          blockType = metadataHeader[0] & 127;
          lastBlock = (metadataHeader[0] & 128) !== 0;
          blockLength = metadataHeader.readUIntBE(1, 3);
          blockOffset = 0; metadataOffset = 0;
          if ((blockCount === 1 && (blockType !== 0 || blockLength !== 34)) || (blockCount > 1 && blockType === 0) || blockType === 127) invalid("FLAC 必须以唯一且长度为 34 字节的 STREAMINFO 音频头开始", "FLAC_STREAMINFO_INVALID");
          if (headerBytes + blockLength > maxHeaderBytes) invalid("FLAC 元数据声明长度超过安全上限", "FLAC_HEADER_LIMIT_EXCEEDED", 413);
          state = "metadata_payload";
          if (!blockLength) state = lastBlock ? "frames" : "metadata_header";
        } else if (state === "metadata_payload") {
          const length = Math.min(blockLength - blockOffset, data.length - offset);
          if (blockType === 0) data.copy(information, blockOffset, offset, offset + length);
          blockOffset += length; offset += length; headerBytes += length;
          if (blockOffset < blockLength) continue;
          if (blockType === 0) info = streamInfo(information);
          state = lastBlock ? "frames" : "metadata_header";
        } else {
          const available = data.length - offset;
          frameBytes += available;
          if (frameOffset < framePrefix.length) {
            const length = Math.min(framePrefix.length - frameOffset, available);
            data.copy(framePrefix, frameOffset, offset, offset + length);
            frameOffset += length;
            if (frameOffset === framePrefix.length) checkFirstFrame(framePrefix, info);
          }
          offset = data.length;
        }
      }
    }
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("FLAC_")) throw error;
    invalid("音频文件暂时无法完整读取，请稍后使用原事件重试", "FLAC_STREAM_UNAVAILABLE", 503);
  }
  if (state !== "frames" || !info || frameOffset < framePrefix.length || frameBytes < 8) invalid("FLAC 文件已截断或缺少完整音频帧，请重新上传完整文件", "FLAC_TRUNCATED");
  const sha256 = digest.digest("hex");
  if (expectedBytes !== undefined && bytes !== expectedBytes) invalid("FLAC 实际完整文件字节数与上传回执不一致", "FLAC_BYTES_MISMATCH");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) invalid("FLAC 实际完整文件 SHA-256 与上传回执不一致", "FLAC_HASH_MISMATCH");
  return { bytes, sha256, ...info, contentType: "audio/flac" };
}
