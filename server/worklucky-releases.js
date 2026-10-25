import { createPublicKey, verify } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { WORKLUCKY_ORIGIN, WORKLUCKY_ROOT, workLuckyUpdates } from "./worklucky-product.js";

export const WORKLUCKY_UPDATE_ALGORITHM = "worklucky-ed25519-sha256-v1";
const KEY_ID = "worklucky-desktop-2026-01";
// Public key already embedded in the released WorkLucky client. Never accept a
// publisher-supplied key or copy the signing private key into this service.
const PUBLIC_KEY = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([
  Buffer.from("302a300506032b6570032100", "hex"),
  Buffer.from("+Gye3bWarR49hJdvllBGmD+Dslwnw24WpRltf401Vxs=", "base64"),
]) });
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const filenameFor = version => `WorkLucky-${version}-windows-x64-portable.zip`;
export const workLuckyReleasePath = version => `${WORKLUCKY_ROOT}/releases/${version}/${filenameFor(version)}`;
export const workLuckyReleaseUrl = version => `${WORKLUCKY_ORIGIN}${workLuckyReleasePath(version)}`;
export const workLuckyReleaseObjectKey = (version, filename = filenameFor(version)) => `releases/worklucky/${version}/${filename}`;

export const workLuckyPublishedManifestSchema = z.object({
  product_id: z.literal("worklucky"), product: z.literal("worklucky").optional(),
  status: z.literal("update_available"), published: z.literal(true).optional(),
  release: z.object({
    release_id: z.string().max(100), version: z.string().regex(VERSION),
    release_notes: z.string().max(16000), publishedAt: z.iso.datetime(),
    min_compatible_knowledge_version: z.string().regex(VERSION),
    knowledge_version_range: z.string().min(1).max(120),
    assets: z.object({ "windows-x64": z.object({ portable_zip: z.object({
      filename: z.string().max(120), bytes: z.number().int().positive().max(2 * 1024 ** 3),
      url: z.string().max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
      signature_algorithm: z.literal(WORKLUCKY_UPDATE_ALGORITHM), signature_key_id: z.literal(KEY_ID),
    }).strict() }).strict() }).strict(),
  }).strict(),
}).strict();

// Reviewed releases only. Retained 0.1.19 qualification receipt SHA256:
// 48845a78a0245de5a65aa27453e1d2c5b100c6e3bf581a1741b14fab23054f71.
// The immutable COS object was independently streamed and fully SHA256-checked
// before enabling this entry. This does not grant model/shared admission.
// No HTTP/admin/env toggle can publish another candidate.
export const WORKLUCKY_PUBLISHED_RELEASES = Object.freeze([{
  product_id: "worklucky", status: "update_available", release: {
    release_id: "worklucky-0.1.20", version: "0.1.20",
    release_notes: "新增数字人团队协作、成员交接、任务看板与技能工具；支持中英文，升级保留账号、聊天和团队数据。",
    publishedAt: "2026-10-25T18:15:08.424Z", min_compatible_knowledge_version: "0.8.3",
    knowledge_version_range: ">=0.8.3, <0.9.0", assets: { "windows-x64": { portable_zip: {
      filename: "WorkLucky-0.1.20-windows-x64-portable.zip", bytes: 775539289,
      url: "https://www.sologle.com/api/v1/desktop/worklucky/releases/0.1.20/WorkLucky-0.1.20-windows-x64-portable.zip",
      sha256: "88e5584092f65a93dd40723754acb9a93f1f290503514f300ae78035deaaba50",
      signature: "879zPAfk6uMr6v88jRFVcXo8cJKFdr7nYmTNZ+Ot1uXJtu1x6jbiBEl1RCgMdZ97idy/yUAAH8ZZjHbnJpy5DQ==",
      signature_algorithm: WORKLUCKY_UPDATE_ALGORITHM, signature_key_id: KEY_ID,
    } } },
  },
}, {
  product_id: "worklucky", status: "update_available", release: {
    release_id: "worklucky-0.1.19", version: "0.1.19",
    release_notes: "新增文档树与原文定位检索，修复默认模型失联错误；保留账号、聊天与知识库数据。",
    publishedAt: "2026-10-25T09:39:33.713Z", min_compatible_knowledge_version: "0.8.3",
    knowledge_version_range: ">=0.8.3, <0.9.0", assets: { "windows-x64": { portable_zip: {
      filename: "WorkLucky-0.1.19-windows-x64-portable.zip", bytes: 124997007,
      url: "https://www.sologle.com/api/v1/desktop/worklucky/releases/0.1.19/WorkLucky-0.1.19-windows-x64-portable.zip",
      sha256: "dc1140c755f871c601bc14415a9bd1c46da3571bb89a6a7708db8eb26fd2fafd",
      signature: "pvb8EoOzl1zGcdqjVnmzpG2YcpluzMZOziVQ6kGe7ij8Afb2Wng7/nlWrhOUcYuEFBhgzz7Sd3zKw7i+nUlxBw==",
      signature_algorithm: WORKLUCKY_UPDATE_ALGORITHM, signature_key_id: KEY_ID,
    } } },
  },
}]);

// Supplemental downloads are reviewed independently of the client-pinned ZIP
// manifest. Never add arbitrary filenames/objects to the updater's signed shape.
// 0.1.20 qualification: fac55ed3a311abf8511b85160c330143532857edd246cdcd6dd52fa352eb6140.
export const WORKLUCKY_PUBLISHED_ARTIFACTS = Object.freeze([
  { version: "0.1.20", filename: "WorkLucky-0.1.20-windows-x64-portable.exe", bytes: 495075328,
    sha256: "fa63688c0bd4c1d430f0191076e75ef07f75980cae7463439eb5d7e79a52d2a6" },
  { version: "0.1.20", filename: "WorkLucky-0.1.20-source.zip", bytes: 129277274,
    sha256: "10c3bc74ea697c4e49c36e0cf82af69decc2ac7bf12c19fa582b1f1cafba1a85" },
  { version: "0.1.20", filename: "WorkLucky-0.1.20-update-manifest.json", bytes: 1094,
    sha256: "0a0bce55b0718d09e8dacc4a201c86cdd21d525c2da90c1e9b97638ec40a3f89" },
]);
const artifactSchema = z.object({ version: z.string().regex(VERSION), filename: z.string().max(120),
  bytes: z.number().int().positive().max(2 * 1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

const invalid = () => Object.assign(new Error("WorkLucky 发布清单尚未通过完整校验"), {
  code: "WORKLUCKY_RELEASE_INVALID", status: 503,
});
export function validateWorkLuckyPublishedRelease(value, now = new Date()) {
  const parsed = workLuckyPublishedManifestSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const manifest = parsed.data, release = manifest.release;
  const asset = release.assets["windows-x64"].portable_zip;
  if (!Number.isFinite(+new Date(now))) throw invalid();
  if (release.release_id !== `worklucky-${release.version}`
    || asset.filename !== filenameFor(release.version) || asset.url !== workLuckyReleaseUrl(release.version)
    || +new Date(release.publishedAt) > +new Date(now)) throw invalid();
  const signature = Buffer.from(asset.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== asset.signature
    || !verify(null, Buffer.from(asset.sha256, "hex"), PUBLIC_KEY, signature)) throw invalid();
  return { ...manifest, product: "worklucky" };
}

const compare = (a, b) => {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return bb[i] - aa[i];
  return 0;
};
export function createWorkLuckyReleaseService({ releases = WORKLUCKY_PUBLISHED_RELEASES,
  artifacts = WORKLUCKY_PUBLISHED_ARTIFACTS, downloadUrl, now = () => new Date() } = {}) {
  function approved() {
    if (!Array.isArray(releases) || releases.length > 128) throw invalid();
    const rows = releases.map(row => validateWorkLuckyPublishedRelease(row, now()));
    if (new Set(rows.map(row => row.release.version)).size !== rows.length) throw invalid();
    if (!Array.isArray(artifacts) || artifacts.length > 384) throw invalid();
    const files = artifacts.map(value => {
      const parsed = artifactSchema.safeParse(value);
      if (!parsed.success) throw invalid();
      const file = parsed.data;
      if (!rows.some(row => row.release.version === file.version)
        || !["windows-x64-portable.exe", "source.zip", "update-manifest.json"].some(suffix => file.filename === `WorkLucky-${file.version}-${suffix}`)
        || (file.filename.endsWith(".json") && file.bytes > 2 * 1024 ** 2)) throw invalid();
      return file;
    });
    if (new Set(files.map(file => `${file.version}/${file.filename}`)).size !== files.length) throw invalid();
    return { releases: rows.sort((a, b) => compare(a.release.version, b.release.version)), files };
  }
  return {
    updates() { return approved().releases[0] || workLuckyUpdates(); },
    download(version, filename) {
      if (!VERSION.test(version)) return null;
      const catalog = approved();
      const manifest = catalog.releases.find(row => row.release.version === version);
      if (!manifest) return null;
      if (filename !== filenameFor(version) && !catalog.files.some(file => file.version === version && file.filename === filename)) return null;
      if (typeof downloadUrl !== "function") throw invalid();
      const target = downloadUrl(workLuckyReleaseObjectKey(version, filename), { filename, expires: 900 });
      let url; try { url = new URL(target); } catch { throw invalid(); }
      if (url.protocol !== "https:" || !url.hostname.endsWith(".myqcloud.com")
        || url.username || url.password || url.port || url.hash) throw invalid();
      return url.href;
    },
  };
}
