import test from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createWorkLuckyReleaseService, validateWorkLuckyPublishedRelease,
  WORKLUCKY_PUBLISHED_RELEASES, WORKLUCKY_PUBLISHED_ARTIFACTS, workLuckyReleaseUrl, workLuckyReleaseObjectKey } from "../../server/worklucky-releases.js";
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
const now = () => new Date("2026-10-26T00:00:00.000Z");
function fixture(releases = [], artifacts = []) {
  const calls = [];
  const releaseService = createWorkLuckyReleaseService({ releases, artifacts, now,
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

test("production catalog pins qualified 0.1.20 and retains the exact 0.1.19 release", async () => {
  assert.ok(Object.isFrozen(WORKLUCKY_PUBLISHED_RELEASES));
  assert.equal(WORKLUCKY_PUBLISHED_RELEASES.length, 2);
  const approved = validateWorkLuckyPublishedRelease(WORKLUCKY_PUBLISHED_RELEASES[0], now());
  assert.equal(approved.release.version, "0.1.20");
  const asset = approved.release.assets["windows-x64"].portable_zip;
  assert.equal(asset.bytes, 775539289);
  assert.equal(asset.sha256, "88e5584092f65a93dd40723754acb9a93f1f290503514f300ae78035deaaba50");
  assert.equal(asset.url, workLuckyReleaseUrl("0.1.20"));
  assert.equal(asset.signature_key_id, "worklucky-desktop-2026-01");
  const f = fixture(WORKLUCKY_PUBLISHED_RELEASES, WORKLUCKY_PUBLISHED_ARTIFACTS);
  const feed = await f.app.request("/api/v1/desktop/worklucky/updates");
  assert.equal(feed.status, 200);
  assert.deepEqual(await feed.json(), approved);
  // Feed is signed latest-release metadata. The shipped client compares its
  // own version and returns None for an equal/newer installed version.
  for (const current of ["0.1.19", "0.1.20", "0.1.21"]) {
    const query = `?platform=windows&arch=x64&package_type=portable_zip&knowledge_version=0.8.3&current_version=${current}`;
    assert.deepEqual(await (await f.app.request(`/api/v1/desktop/worklucky/updates${query}`)).json(), approved);
  }
  assert.equal((await f.app.request(asset.url)).status, 302);
  assert.deepEqual(f.calls, [{ key: workLuckyReleaseObjectKey("0.1.20"), options: { filename: asset.filename, expires: 900 } }]);
  const previous = validateWorkLuckyPublishedRelease(WORKLUCKY_PUBLISHED_RELEASES.find(row => row.release.version === "0.1.19"), now());
  assert.equal(previous.release.assets["windows-x64"].portable_zip.sha256, "dc1140c755f871c601bc14415a9bd1c46da3571bb89a6a7708db8eb26fd2fafd");
  assert.equal((await f.app.request(workLuckyReleaseUrl("0.1.19"))).status, 302);
  assert.equal((await (await f.app.request("/api/v1/desktop/worklucky/config")).json()).updates.latest_version, "0.1.20");
  // Publishing a program must not publish other versions or model admissions.
  assert.equal((await f.app.request(workLuckyReleaseUrl("0.1.18"))).status, 404);
  assert.equal(approved.grants_admission, undefined);
});

test("supplemental release files sign only exact reviewed filenames without changing signed updater shape", async () => {
  const f = fixture(WORKLUCKY_PUBLISHED_RELEASES, WORKLUCKY_PUBLISHED_ARTIFACTS);
  for (const file of WORKLUCKY_PUBLISHED_ARTIFACTS) {
    const reply = await f.app.request(`/api/v1/desktop/worklucky/releases/${file.version}/${file.filename}`);
    assert.equal(reply.status, 302); assert.match(reply.headers.get("cache-control"), /no-store/);
    assert.deepEqual(f.calls.at(-1), { key: workLuckyReleaseObjectKey(file.version, file.filename), options: { filename: file.filename, expires: 900 } });
  }
  const count = f.calls.length;
  for (const filename of ["other.exe", "WorkLucky-0.1.19-source.zip", "WorkLucky-0.1.20-launcher-provenance.json", "..%2Fsecret.env"]) {
    assert.equal((await f.app.request(`/api/v1/desktop/worklucky/releases/0.1.20/${filename}`)).status, 404);
  }
  assert.equal(f.calls.length, count);
  const feed = await (await f.app.request("/api/v1/desktop/worklucky/updates")).json();
  assert.deepEqual(Object.keys(feed.release.assets["windows-x64"]), ["portable_zip"]);
  assert.equal(feed.release.assets["windows-x64"].portable_zip.bytes, 775539289);
});

test("orphan, malformed or duplicate supplemental entries fail closed before any signing", async () => {
  for (const mutate of [file => { file.version = "0.1.21"; }, file => { file.filename = "../secret.env"; },
    file => { file.bytes = 0; }, file => { file.sha256 = "not-a-digest"; }]) {
    const files = structuredClone(WORKLUCKY_PUBLISHED_ARTIFACTS); mutate(files[0]);
    const f = fixture(WORKLUCKY_PUBLISHED_RELEASES, files);
    assert.equal((await f.app.request("/api/v1/desktop/worklucky/updates")).status, 503);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(WORKLUCKY_PUBLISHED_RELEASES, [WORKLUCKY_PUBLISHED_ARTIFACTS[0], WORKLUCKY_PUBLISHED_ARTIFACTS[0]]);
  assert.equal((await f.app.request("/api/v1/desktop/worklucky/updates")).status, 503);
  assert.deepEqual(f.calls, []);
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
    const service = createWorkLuckyReleaseService({ releases: [signed()], artifacts: [], now, downloadUrl: () => target });
    assert.throws(() => service.download("0.1.12", "WorkLucky-0.1.12-windows-x64-portable.zip"));
  }
});
