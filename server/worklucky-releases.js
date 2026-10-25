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
export const workLuckyReleaseObjectKey = version => `releases/worklucky/${version}/${filenameFor(version)}`;

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

// Deliberately empty. Add a final signed manifest through reviewed source only,
// after the unchanged COS object, package acceptance and Data upgrade are
// verified. No HTTP/admin/env toggle can publish an unverified candidate.
export const WORKLUCKY_PUBLISHED_RELEASES = Object.freeze([]);

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
  downloadUrl, now = () => new Date() } = {}) {
  function approved() {
    if (!Array.isArray(releases) || releases.length > 128) throw invalid();
    const rows = releases.map(row => validateWorkLuckyPublishedRelease(row, now()));
    if (new Set(rows.map(row => row.release.version)).size !== rows.length) throw invalid();
    return rows.sort((a, b) => compare(a.release.version, b.release.version));
  }
  return {
    updates() { return approved()[0] || workLuckyUpdates(); },
    download(version, filename) {
      if (!VERSION.test(version) || filename !== filenameFor(version)) return null;
      const manifest = approved().find(row => row.release.version === version);
      if (!manifest) return null;
      if (typeof downloadUrl !== "function") throw invalid();
      const target = downloadUrl(workLuckyReleaseObjectKey(version), { filename, expires: 900 });
      let url; try { url = new URL(target); } catch { throw invalid(); }
      if (url.protocol !== "https:" || !url.hostname.endsWith(".myqcloud.com")
        || url.username || url.password || url.port || url.hash) throw invalid();
      return url.href;
    },
  };
}
