import { createHash } from "node:crypto";
import { createPresignedDownloadUrl, headObject, putObject } from "./cos.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const ROLES = new Set(["reference_image", "source_image", "source_video", "media", "reference_audio"]);
const MIME = new Set(["image/png", "image/jpeg", "video/mp4", "audio/flac", "audio/wav"]);
const FIELDS = ["fixture_id", "role", "filename", "content_type", "bytes", "sha256"];
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
function fail(message, code = "VERIFICATION_INPUT_INVALID") { throw Object.assign(new Error(message), { code, status: 503 }); }

// These descriptors originate in server adapter code, never a report/request
// body. Persist only this immutable projection, never a signed download URL.
export function normalizeProbeInputs(inputs = []) {
  if (!Array.isArray(inputs) || inputs.length > 3) fail("自动验收输入最多三份固定夹具");
  const normalized = inputs.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !ID.test(item.fixture_id || "")
      || !ROLES.has(item.role) || !MIME.has(item.content_type) || !HASH.test(item.sha256 || "")
      || typeof item.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(item.filename)
      || item.filename.includes("..") || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 4 * 1024 * 1024
      || Object.keys(item).some((key) => !FIELDS.includes(key))) fail("自动验收夹具的来源标识、格式、大小或摘要不正确");
    return Object.fromEntries(FIELDS.map((key) => [key, item[key]]));
  });
  if (new Set(normalized.map((item) => item.fixture_id)).size !== normalized.length
    || normalized.reduce((sum, item) => sum + item.bytes, 0) > MAX_INPUT_BYTES) fail("自动验收夹具重复或超过八兆安全预算");
  return normalized;
}

export function validateProbeInputTickets(inputs, tickets, leaseExpiresAt, instant = new Date()) {
  const expected = normalizeProbeInputs(inputs);
  if (!Array.isArray(tickets) || tickets.length !== expected.length) fail("验收输入下载票据未完整签发", "VERIFICATION_INPUT_UNAVAILABLE");
  return expected.map((item, index) => {
    const ticket = tickets[index]; let url;
    try { url = new URL(ticket?.download_url); } catch { fail("验收输入下载票据地址不正确"); }
    const expiry = new Date(ticket?.expires_at);
    if (FIELDS.some((key) => ticket?.[key] !== item[key]) || url.protocol !== "https:" || url.username || url.password || url.hash
      || !Number.isFinite(+expiry) || expiry <= instant || expiry > new Date(leaseExpiresAt) || +expiry > +instant + 5 * 60_000)
      fail("验收输入下载票据与本次固定夹具或租约不一致");
    return { ...item, download_url: url.href, expires_at: expiry.toISOString() };
  });
}

/** Registered source fixtures only; never arbitrary object keys, URLs, user
 * uploads or client-provided bytes. Deployment fixtures are permanent source
 * assets, not user works or disposable test output. */
export function createProbeFixtureIssuer({ fixtures = [], readObject = headObject, writeObject = putObject,
  signDownload = createPresignedDownloadUrl, now = () => new Date() } = {}) {
  const registry = new Map(); const preparing = new Map();
  for (const fixture of fixtures) {
    const descriptor = normalizeProbeInputs([fixture.descriptor])[0];
    if (registry.has(descriptor.fixture_id) || typeof fixture.read !== "function") fail("服务器夹具登记重复或缺少固定内容来源");
    registry.set(descriptor.fixture_id, { descriptor, read: fixture.read });
  }
  async function prepare(input) {
    const fixture = registry.get(input.fixture_id);
    if (!fixture || FIELDS.some((key) => fixture.descriptor[key] !== input[key])) fail("该能力缺少已登记的真实测试夹具", "VERIFICATION_FIXTURE_REQUIRED");
    const key = `capability-probe-fixtures/v1/${input.sha256}/${input.filename}`;
    if (!preparing.has(key)) {
      const flight = (async () => {
        const bytes = await fixture.read();
        if (!Buffer.isBuffer(bytes) || bytes.length !== input.bytes
          || createHash("sha256").update(bytes).digest("hex") !== input.sha256) fail("部署中的验收夹具内容与固定摘要不一致", "VERIFICATION_FIXTURE_MISMATCH");
        let object;
        try { object = await readObject(key); }
        catch (error) { if (error?.statusCode !== 404 && error?.status !== 404 && error?.code !== "NoSuchKey") throw error; }
        const length = object && Object.entries(object.headers || object).find(([name]) => name.toLowerCase() === "content-length")?.[1];
        if (object && Number(length) !== input.bytes) fail("固定夹具对象大小不匹配，禁止覆盖未知对象", "VERIFICATION_FIXTURE_MISMATCH");
        if (!object) await writeObject(key, bytes, input.content_type);
        return key;
      })();
      preparing.set(key, flight);
      const clear = () => { if (preparing.get(key) === flight) preparing.delete(key); };
      flight.then(clear, clear);
    }
    return preparing.get(key);
  }
  return async ({ binding, challenge }) => {
    if (!binding || String(challenge.bindingId) !== String(binding._id) || challenge.nodeId !== binding.nodeId)
      fail("验收夹具不属于当前绑定节点");
    const inputs = normalizeProbeInputs(challenge.probeInputs);
    if (+new Date(challenge.leaseExpiresAt) <= +new Date(now())) fail("验收租约已过期，不能签发输入下载票据", "VERIFICATION_LEASE_EXPIRED");
    const keys = await Promise.all(inputs.map(prepare));
    // Storage preparation can take time. Recheck before signing, so the actual
    // GET grant never extends beyond the original execution lease.
    const instant = new Date(now());
    const expiry = new Date(Math.min(+new Date(challenge.leaseExpiresAt), +instant + 5 * 60_000));
    if (!Number.isFinite(+expiry) || expiry <= instant) fail("验收租约已过期，不能签发输入下载票据", "VERIFICATION_LEASE_EXPIRED");
    return inputs.map((input, index) => {
      const key = keys[index];
      return { ...input, download_url: signDownload(key, { expires: Math.max(1, Math.floor((+expiry - +instant) / 1000)), filename: input.filename }), expires_at: expiry.toISOString() };
    });
  };
}
