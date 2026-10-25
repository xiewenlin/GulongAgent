import test from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createWorkLuckyReleaseService, validateWorkLuckyPublishedRelease,
  WORKLUCKY_PUBLISHED_RELEASES, workLuckyReleaseUrl, workLuckyReleaseObjectKey } from "../../server/worklucky-releases.js";
import { registerWorkLuckyDesktopRoutes } from "../../server/worklucky-desktop.js";

// Existing public signing evidence, not a new signed executable or file fixture.
// The server never receives the private key; all tests stay in memory.
const signed = (version = "0.1.12") => ({ product_id: "worklucky", status: "update_available", release: {
  release_id: `worklucky-${version}`, version, release_notes: "维护更新；不开放音乐或资产门禁",
  publishedAt: "2026-10-01T00:00:00.000Z", min_compatible_knowledge_version: "0.8.3",
  knowledge_version_range: ">=0.8.3, <0.9.0", assets: { "windows-x64": { portable_zip: {
    filename: `WorkLucky-${version}-windows-x64-portable.zip`, bytes: 125059358,
    url: workLuckyReleaseUrl(version), sha256: "2b41b286d6f6ffc68ca1578276ff19c63fd1574619a98c3a2124fb934914de45",
    signature: "H+7WTFs+/8D5Rnf6Ze3nMSGpFNjNYIXu5aWOHa/2LDmWsVScSu08NjDuiUD9vAENIN/3GCr45ZA8eZHbKND+Cg==",
    signature_algorithm: "worklucky-ed25519-sha256-v1", signature_key_id: "worklucky-desktop-2026-01",
  } } },
} });
const now = () => new Date("2026-10-25T12:00:00.000Z");
function fixture(releases = []) {
  const calls = [];
  const releaseService = createWorkLuckyReleaseService({ releases, now,
    downloadUrl: (key, options) => { calls.push({ key, options }); return "https://test.cos.ap-chengdu.myqcloud.com/verified?temporary=1"; } });
  const app = new OpenAPIHono();
  app.onError((error, c) => c.json({ code: error.code, message: error.message }, error.status || 500));
  registerWorkLuckyDesktopRoutes(app, { createAuth: () => ({ register() {} }),
    readEntitlement: async () => { throw Error("No account access in release routes"); }, monthlyPriceFen: 99900, releaseService });
  return { app, calls, releaseService };
}

test("empty reviewed catalog cannot publish a candidate through request metadata", async () => {
  const f = fixture();
  const response = await f.app.request("/api/v1/desktop/worklucky/updates?platform=windows&arch=x64&package_type=portable_zip");
  assert.equal(response.status, 200); assert.equal((await response.json()).status, "no_update");
  const download = await f.app.request(workLuckyReleaseUrl("0.1.19"));
  assert.equal(download.status, 404); assert.equal((await download.json()).code, "RELEASE_NOT_FOUND");
  assert.match(download.headers.get("Cache-Control"), /no-store/); assert.deepEqual(f.calls, []);
});

test("production catalog pins the qualified 0.1.19 archive and original client signature", async () => {
  assert.ok(Object.isFrozen(WORKLUCKY_PUBLISHED_RELEASES));
  assert.equal(WORKLUCKY_PUBLISHED_RELEASES.length, 1);
  const approved = validateWorkLuckyPublishedRelease(WORKLUCKY_PUBLISHED_RELEASES[0], now());
  assert.equal(approved.release.version, "0.1.19");
  const asset = approved.release.assets["windows-x64"].portable_zip;
  assert.equal(asset.bytes, 124997007);
  assert.equal(asset.sha256, "dc1140c755f871c601bc14415a9bd1c46da3571bb89a6a7708db8eb26fd2fafd");
  assert.equal(asset.url, workLuckyReleaseUrl("0.1.19"));
  assert.equal(asset.signature_key_id, "worklucky-desktop-2026-01");
  const f = fixture(WORKLUCKY_PUBLISHED_RELEASES);
  const feed = await f.app.request("/api/v1/desktop/worklucky/updates");
  assert.equal(feed.status, 200);
  assert.deepEqual(await feed.json(), approved);
  assert.equal((await f.app.request(asset.url)).status, 302);
  assert.deepEqual(f.calls, [{ key: workLuckyReleaseObjectKey("0.1.19"), options: { filename: asset.filename, expires: 900 } }]);
  // Publishing a program must not publish other versions or model admissions.
  assert.equal((await f.app.request(workLuckyReleaseUrl("0.1.18"))).status, 404);
  assert.equal(approved.grants_admission, undefined);
});

test("existing client key verifies the signature over the raw ZIP digest", () => {
  const manifest = validateWorkLuckyPublishedRelease(signed(), now());
  assert.equal(manifest.product, "worklucky");
  assert.equal(manifest.release.assets["windows-x64"].portable_zip.signature, signed().release.assets["windows-x64"].portable_zip.signature);
});

test("unpublished, malformed, unknown-key and tampered manifests cannot become updates", () => {
  const mutations = [
    m => { m.status = "unpublished_example"; }, m => { m.published = false; },
    m => { m.release.assets["windows-x64"].portable_zip.sha256 = "0".repeat(64); },
    m => { m.release.assets["windows-x64"].portable_zip.signature = "A".repeat(86) + "=="; },
    m => { m.release.assets["windows-x64"].portable_zip.signature_key_id = "request-key"; },
    m => { m.release.assets["windows-x64"].portable_zip.signature_algorithm = "none"; },
    m => { m.release.assets["windows-x64"].portable_zip.bytes = 0; },
    m => { m.release.assets["windows-x64"].portable_zip.bytes = 2 * 1024 ** 3 + 1; },
    m => { m.release.assets["windows-x64"].portable_zip.url = "https://untrusted.example/release.zip"; },
    m => { m.release.assets["windows-x64"].portable_zip.url = workLuckyReleaseUrl("0.1.12") + "?token=not-allowed"; },
    m => { m.release.assets["windows-x64"].portable_zip.filename = "../release.zip"; },
    m => { m.release.publishedAt = "2027-01-01T00:00:00.000Z"; },
    m => { m.release.version = "0.1.19"; }, m => { m.grants_admission = true; },
  ];
  for (const mutate of mutations) {
    const manifest = signed(); mutate(manifest);
    assert.throws(() => validateWorkLuckyPublishedRelease(manifest, now()), e => e.code === "WORKLUCKY_RELEASE_INVALID");
  }
});

test("fixed version download signs only its own COS key and keeps public metadata immutable", async () => {
  const f = fixture([signed()]);
  const response = await f.app.request(workLuckyReleaseUrl("0.1.12"));
  assert.equal(response.status, 302); assert.match(response.headers.get("Location"), /^https:\/\/test\.cos\./);
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  assert.deepEqual(f.calls, [{ key: workLuckyReleaseObjectKey("0.1.12"), options: { filename: "WorkLucky-0.1.12-windows-x64-portable.zip", expires: 900 } }]);
  const feed = await (await f.app.request("/api/v1/desktop/worklucky/updates")).json();
  assert.equal(feed.status, "update_available"); assert.equal(feed.release.version, "0.1.12");
  assert.equal(feed.release.assets["windows-x64"].portable_zip.url, workLuckyReleaseUrl("0.1.12"));
  assert.equal(JSON.stringify(feed).includes("temporary=1"), false);
});

test("latest selection is numeric; another version/filename never falls back to latest", async () => {
  const f = fixture([signed("0.1.9"), signed("0.1.12")]);
  assert.equal(f.releaseService.updates().release.version, "0.1.12");
  for (const url of [workLuckyReleaseUrl("0.1.19"), "/api/v1/desktop/worklucky/releases/0.1.12/other.zip",
    "/api/v1/desktop/worklucky/releases/0.1.12/WorkLucky-0.1.9-windows-x64-portable.zip"]) {
    assert.equal((await f.app.request(url)).status, 404);
  }
  assert.deepEqual(f.calls, []);
});

test("invalid configured catalog fails as unavailable, not a false no_update", async () => {
  const bad = signed(); bad.release.assets["windows-x64"].portable_zip.signature_key_id = "bad";
  const f = fixture([bad]);
  const response = await f.app.request("/api/v1/desktop/worklucky/updates");
  assert.equal(response.status, 503); assert.equal((await response.json()).code, "WORKLUCKY_RELEASE_INVALID");
  assert.deepEqual(f.calls, []);
  assert.throws(() => fixture([signed(), signed()]).releaseService.updates());
});

test("asset signing cannot redirect the updater to HTTP, credentials or an unapproved host", () => {
  for (const target of ["http://test.myqcloud.com/a", "https://evil.example/a", "https://user:password@test.myqcloud.com/a", "https://test.myqcloud.com:444/a"]) {
    const service = createWorkLuckyReleaseService({ releases: [signed()], now, downloadUrl: () => target });
    assert.throws(() => service.download("0.1.12", "WorkLucky-0.1.12-windows-x64-portable.zip"));
  }
});
