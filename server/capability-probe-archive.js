import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
const fail = () => { throw Object.assign(new Error("验收蒙版归档存在路径、格式、完整性或解压预算问题"), { code: "VERIFICATION_ARCHIVE_INVALID", status: 409 }); };
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }

// Parse only bounded stored/deflated ZIPs in memory. Never extract paths, follow
// links, execute files, or trust a central-directory size without actual inflate.
export function inspectProbeArchive(bytes, inspectPng) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 32 * 1024 * 1024 || typeof inspectPng !== "function") fail();
  let end = bytes.length - 22, foundEnd = false;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) { foundEnd = true; break; }
  if (!foundEnd) fail();
  const count = bytes.readUInt16LE(end + 10), centralBytes = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
    || count < 1 || count > 128 || central + centralBytes !== end) fail();
  const entries = []; const names = new Set(); const intervals = []; let offset = central, inflated = 0, pixels = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameBytes = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameBytes + extra + comment > end || !nameBytes || nameBytes > 240 || (flags & ~(8 | 2048))
      || ![0, 8].includes(method) || size > 4 * 1024 * 1024 || inflated + size > 32 * 1024 * 1024
      || ![0, 0x8000, 0x4000].includes(bytes.readUInt32LE(offset + 38) >>> 16 & 0xf000) || bytes.readUInt16LE(offset + 34)) fail();
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameBytes);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,239}$/.test(name) || name.split("/").some((part) => [".", ".."].includes(part)) || names.has(name)) fail();
    names.add(name);
    if (local + 30 > central || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) fail();
    const localNameBytes = bytes.readUInt16LE(local + 26), start = local + 30 + localNameBytes + bytes.readUInt16LE(local + 28);
    let recordEnd = start + compressed;
    if (flags & 8) {
      const descriptor = recordEnd + (recordEnd + 4 <= central && bytes.readUInt32LE(recordEnd) === 0x08074b50 ? 4 : 0);
      if (descriptor + 12 > central || bytes.readUInt32LE(descriptor) !== crc || bytes.readUInt32LE(descriptor + 4) !== compressed
        || bytes.readUInt32LE(descriptor + 8) !== size) fail();
      recordEnd = descriptor + 12;
    }
    if (recordEnd > central || localNameBytes !== nameBytes || bytes.toString("utf8", local + 30, local + 30 + localNameBytes) !== name
      || intervals.some(([a, b]) => local < b && recordEnd > a)) fail();
    intervals.push([local, recordEnd]);
    const packed = bytes.subarray(start, start + compressed); let content;
    try { content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) }); } catch { fail(); }
    if (content.length !== size || crc32(content) !== crc) fail();
    inflated += size;
    if (name.endsWith("/")) { if (size) fail(); }
    else if (name.endsWith(".png")) {
      if (content.length < 24) fail();
      const width = content.readUInt32BE(16), height = content.readUInt32BE(20);
      if (!width || !height || width > 1024 || height > 1024 || pixels + width * height > 16 * 1024 * 1024) fail();
      pixels += width * height;
      const image = inspectPng(content);
      entries.push({ name, bytes: size, sha256: createHash("sha256").update(content).digest("hex"), ...image });
    } else if (name === "README.txt" && size <= 4096) entries.push({ name, bytes: size });
    else fail();
    offset += 46 + nameBytes + extra + comment;
  }
  if (offset !== end || !entries.some((entry) => entry.name.endsWith(".png"))) fail();
  return { archiveEntries: entries, uncompressedBytes: inflated };
}
