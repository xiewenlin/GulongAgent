import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import app from "../../server/app.js";
import platform from "../../api/platform.js";
import {
  chandlerConfig,
  externalAuthFromResponse,
  isChandlerBootstrapAdmin,
  productEdition,
  productEditionFromChannel,
} from "../../server/chandler.js";
import { browserUploadCorsReady, browserUploadCorsRule, cosConfig, sanitizeFilename } from "../../server/cos.js";
import { readExternalAuth, readUserSecret, sealExternalAuth, sealUserSecret } from "../../server/security.js";
import { recoverExpiredDirectReleaseLock } from "../../server/release-lock.js";
import {
  OFFLINE_REVIEW_REJECTION_REASON,
  offlineReviewWechatMessage,
  parseOfflineReviewWechatAction,
} from "../../server/offline-review.js";

test("Chandler session tokens are encrypted and round-trip server-side", () => {
  const auth = externalAuthFromResponse({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    expires_in: 3600,
    user: { id: "user-1" },
  });
  const sealed = sealExternalAuth(auth);
  assert.equal(sealed.includes("access-secret"), false);
  assert.equal(sealed.includes("refresh-secret"), false);
  assert.deepEqual(readExternalAuth({ externalAuth: sealed }), auth);
});

test("user provider keys use purpose-bound encryption", () => {
  const sealed = sealUserSecret("minimax-secret-key", "minimax-api-key");
  assert.equal(sealed.includes("minimax-secret-key"), false);
  assert.equal(readUserSecret(sealed, "another-provider"), null);
  assert.equal(readUserSecret(sealed, "minimax-api-key"), "minimax-secret-key");
});

test("official Chandler and Chengdu COS defaults stay pinned", () => {
  assert.equal(chandlerConfig().baseUrl, "https://api.chandler.work");
  assert.equal(chandlerConfig().applicationId, "cm_89be865af1af48f4a83406f0cf1a472e");
  assert.equal(chandlerConfig().airosApplicationId, "cm_8b022909f72d4daab8379517271e9658");
  assert.equal(chandlerConfig().monthlyPriceFen, 29_800);
  assert.equal(chandlerConfig().yearlyPriceFen, 298_000);
  const cos = cosConfig();
  assert.equal(cos.bucket, "gulong-1259744534");
  assert.equal(cos.region, "ap-chengdu");
  assert.equal(cos.domain, "gulong-1259744534.cos.ap-chengdu.myqcloud.com");
  assert.equal(typeof cos.configured, "boolean");
});

test("desktop product editions and bootstrap administrator map to website identities", () => {
  assert.deepEqual(productEdition("gulong"), { key: "gulong", name: "古龙版" });
  assert.deepEqual(productEdition("Airos 永生花"), { key: "yongshenghua", name: "永生花版" });
  assert.deepEqual(productEditionFromChannel({ profileKey: "yongshenghua" }), { key: "yongshenghua", name: "永生花版" });
  assert.equal(isChandlerBootstrapAdmin({ email: "1186664388@qq.com" }), true);
  assert.equal(isChandlerBootstrapAdmin({ email: "member@example.com" }), false);
});

test("website body typography stays at 18px while the restored scaled product preview remains compact", async () => {
  const css = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const previewStart = css.indexOf(".product-toolbar {");
  const previewEnd = css.indexOf(".hero-product small { font-size: inherit; }", previewStart) + ".hero-product small { font-size: inherit; }".length;
  assert.ok(previewStart > 0 && previewEnd > previewStart);
  const previewCss = css.slice(previewStart, previewEnd);
  const previewSizes = [...previewCss.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].map((match) => Number(match[1])).filter((size) => size < 18);
  assert.deepEqual(previewSizes, [12, 10, 16, 7, 16, 8, 10, 7]);
  const bodyCss = `${css.slice(0, previewStart)}${css.slice(previewEnd)}`;
  const undersized = [...bodyCss.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)]
    .map((match) => Number(match[1]))
    .filter((size) => size < 18);
  assert.deepEqual(undersized, []);
  assert.match(css, /\.account-sidebar\s+nav\s+button[\s\S]*?font-size:\s*18px/);
});

test("COS object filenames cannot escape their assigned prefix", () => {
  assert.equal(sanitizeFilename("../第二大脑:2026?.zip"), "..-第二大脑-2026-.zip");
  assert.equal(sanitizeFilename("  "), "file.bin");
});

test("COS browser uploads allow both official domains without removing existing rules", () => {
  const origins = ["https://www.sologle.com", "https://sologle.com"];
  assert.equal(browserUploadCorsReady([], origins), false);
  const existing = [{ AllowedOrigins: ["https://example.com"], AllowedMethods: ["GET"], AllowedHeaders: ["*"] }];
  const merged = [...existing, browserUploadCorsRule(origins)];
  assert.equal(browserUploadCorsReady(merged, origins), true);
  assert.deepEqual(merged[0], existing[0]);
  assert.deepEqual(merged[1].AllowedMethod, ["PUT", "POST", "GET", "HEAD"]);
  assert.deepEqual(merged[1].AllowedHeader, ["*"]);
});

test("OpenAPI document includes Chandler admin, offline credentials, dated attachments and releases", async () => {
  const response = await app.request("http://localhost/api/openapi.json");
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.ok(document.paths["/api/auth/offline-credential"]);
  assert.ok(document.paths["/api/v1/brain/attachments/latest"]);
  assert.ok(document.paths["/api/releases/latest"]);
  assert.ok(document.paths["/api/v1/configuration/minimax"]);
  assert.ok(document.paths["/api/v1/account/profile"]);
  assert.ok(document.paths["/api/v1/pricing/subscriptions"]);
  assert.ok(document.paths["/api/admin/chandler/users"]);
  assert.ok(document.paths["/api/admin/chandler/users/{id}/status"]);
  assert.ok(document.paths["/api/admin/chandler/users/{id}/subscriptions"]);
  assert.ok(document.paths["/api/admin/chandler/catalog"]);
  assert.ok(document.paths["/api/admin/chandler/prices"]);
  assert.ok(document.paths["/api/admin/chandler/entitlement-requests"]);
  assert.ok(document.paths["/api/admin/analytics/dashboard"]);
  assert.ok(document.paths["/api/v1/admin/wechat-review/bind"]);
  assert.ok(document.paths["/api/v1/admin/wechat-review/claim"]);
  assert.ok(document.paths["/api/v1/admin/wechat-review/{eventId}/notified"]);
  assert.ok(document.paths["/api/v1/admin/wechat-review/{eventId}/action"]);
  assert.ok(document.paths["/api/v1/desktop/account/subscription"]);
  assert.ok(document.paths["/api/admin/release-channels/{id}/manual-upload"]);
  assert.ok(document.paths["/api/admin/release-uploads/{id}/complete"]);
  assert.ok(document.paths["/api/release-worker/releases/prepare"]);
  assert.ok(document.paths["/api/release-worker/releases/{publishId}/complete"]);
  assert.ok(document.paths["/api/release-worker/releases/{publishId}/fail"]);
  for (const path of [
    "/api/release-worker/releases/prepare",
    "/api/release-worker/releases/{publishId}/complete",
    "/api/release-worker/releases/{publishId}/fail",
  ]) {
    assert.equal(document.paths[path].post.deprecated, true);
    assert.ok(document.paths[path].post.responses["410"]);
  }
});

test("legacy direct release endpoints stay disabled even with an old worker key", async () => {
  const requests = [
    new Request("http://localhost/api/release-worker/releases/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", "x-release-worker-key": "legacy-worker-key" },
      body: JSON.stringify({ groupId: "legacy-channel", filename: "legacy.exe" }),
    }),
    new Request("http://localhost/api/release-worker/releases/507f1f77bcf86cd799439011/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-release-worker-key": "legacy-worker-key" },
      body: JSON.stringify({ receipt: { status: "released" } }),
    }),
    new Request("http://localhost/api/release-worker/releases/507f1f77bcf86cd799439011/fail", {
      method: "POST",
      headers: { "content-type": "application/json", "x-release-worker-key": "legacy-worker-key" },
      body: JSON.stringify({ error: "legacy failure" }),
    }),
  ];
  for (const request of requests) {
    const response = await app.request(request);
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, "DIRECT_RELEASE_DISABLED");
  }
});

test("expired legacy release locks are cleaned without removing the current latest release", async () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  const latestRelease = { objectKey: "releases/channel/current.exe", version: "3.0.0" };
  const channel = {
    _id: "channel-1",
    distributionStatus: "uploading",
    releasePublishId: "legacy-upload-1",
    releaseUpdatingAt: new Date("2026-07-29T10:00:00.000Z"),
    latestRelease,
  };
  const writes = [];
  const deleted = [];
  const result = await recoverExpiredDirectReleaseLock(channel, {
    now,
    deleteStoredObject: async (objectKey) => deleted.push(objectKey),
    uploads: {
      findOne: async () => ({
        _id: "legacy-upload-1",
        protocol: "trusted-worker-v1",
        status: "prepared",
        objectKey: "releases/channel/orphaned.exe",
        expiresAt: new Date("2026-07-29T11:00:00.000Z"),
      }),
      updateOne: async (...args) => { writes.push(["upload", ...args]); return { modifiedCount: 1 }; },
    },
    channels: {
      updateOne: async (...args) => { writes.push(["channel", ...args]); return { modifiedCount: 1 }; },
      findOne: async () => null,
    },
  });
  assert.equal(result.blocked, false);
  assert.equal(result.cleaned, true);
  assert.deepEqual(result.channel.latestRelease, latestRelease);
  assert.deepEqual(deleted, ["releases/channel/orphaned.exe"]);
  const channelUpdate = writes.find(([kind]) => kind === "channel")[2];
  assert.equal(channelUpdate.$set.distributionStatus, "failed");
  assert.equal(Object.hasOwn(channelUpdate.$set, "latestRelease"), false);
  assert.deepEqual(channelUpdate.$unset, { releasePublishId: "", releaseUpdatingAt: "" });
});

test("fresh legacy locks remain blocked and both administrator release paths invoke stale cleanup", async () => {
  let writeCount = 0;
  const result = await recoverExpiredDirectReleaseLock({
    _id: "channel-2",
    distributionStatus: "uploading",
    releasePublishId: "legacy-upload-2",
  }, {
    now: new Date("2026-07-29T12:00:00.000Z"),
    deleteStoredObject: async () => { throw new Error("must not delete"); },
    uploads: {
      findOne: async () => ({ _id: "legacy-upload-2", protocol: "trusted-worker-v1", status: "prepared", expiresAt: new Date("2026-07-29T13:00:00.000Z") }),
      updateOne: async () => { writeCount += 1; },
    },
    channels: {
      updateOne: async () => { writeCount += 1; },
      findOne: async () => null,
    },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.cleaned, false);
  assert.equal(writeCount, 0);

  const serverSource = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  const adminJobStart = serverSource.indexOf('app.post("/api/admin/release-jobs"');
  const manualStart = serverSource.indexOf("app.openapi(adminManualReleaseUploadRoute");
  const workerUploadStart = serverSource.indexOf('app.post("/api/release-worker/jobs/:id/upload"');
  assert.match(serverSource.slice(adminJobStart, manualStart), /releaseChannelAvailability\(channel\)/);
  assert.match(serverSource.slice(manualStart, serverSource.indexOf("app.openapi(adminCompleteManualReleaseUploadRoute", manualStart)), /releaseChannelAvailability\(channel\)/);
  assert.match(serverSource.slice(workerUploadStart, serverSource.indexOf('app.post("/api/release-worker/jobs/:id/complete"', workerUploadStart)), /releaseChannelAvailability\(channel\)/);
});

test("Vercel platform entry restores nested API paths", async () => {
  const response = await platform.fetch(new Request("https://example.test/api/platform?_platform_path=releases/latest"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { release: null });
});

test("Vercel consolidates nested account and configuration routes", async () => {
  const configuration = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));
  const sources = configuration.rewrites.map((rewrite) => rewrite.source);
  assert.ok(sources.includes("/api/account/:path*"));
  assert.ok(sources.includes("/api/v1/configuration/:path*"));
  assert.ok(sources.includes("/api/v1/account/:path*"));
  assert.ok(sources.includes("/api/v1/pricing/:path*"));
  assert.ok(sources.includes("/api/v1/admin/:path*"));
  assert.ok(sources.includes("/api/v1/desktop/:path*"));
  assert.ok(sources.includes("/api/billing/:path*"));
  assert.ok(sources.includes("/api/users/:id/avatar"));
  assert.ok(sources.includes("/api/admin/analytics/:path*"));
  assert.ok(sources.includes("/api/admin/partners"));
  assert.ok(sources.includes("/api/admin/partners/assets/presign"));
  assert.ok(sources.includes("/api/analytics/:path*"));
  assert.ok(sources.includes("/api/admin/release-channels/:id/manual-upload"));
  assert.ok(sources.includes("/api/admin/release-uploads/:id/complete"));
  assert.ok(sources.includes("/api/release-worker/:path*"));
});

test("administrator WeChat review menu accepts only explicit numeric actions", () => {
  assert.deepEqual(parseOfflineReviewWechatAction("1"), { action: "approve", reason: null });
  assert.deepEqual(parseOfflineReviewWechatAction("１"), { action: "approve", reason: null });
  assert.deepEqual(parseOfflineReviewWechatAction("２ 付款截图不清晰"), { action: "reject", reason: "付款截图不清晰" });
  assert.deepEqual(parseOfflineReviewWechatAction("2"), { action: "reject", reason: OFFLINE_REVIEW_REJECTION_REASON });
  assert.equal(parseOfflineReviewWechatAction("好的"), null);
  const message = offlineReviewWechatMessage({ orderNo: "GL20260729001", cycle: "year", amountFen: 298000, userEmail: "member@example.com" });
  assert.match(message, /GL20260729001/);
  assert.match(message, /1、审核通过/);
  assert.match(message, /2、审核拒绝/);
  assert.match(message, /仅当前已绑定的管理员微信会话/);
});

test("desktop WeChat review API validates Chandler administrators and a bound worker", async () => {
  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  assert.match(source, /authenticateDesktopChandler\(c, \{ admin: true \}\)/);
  assert.match(source, /identity\.role !== "admin"/);
  assert.match(source, /workerId, ownerId: auth\.user\._id, enabled: true, channel: "personal-wechat"/);
  assert.match(source, /enqueueOfflineReviewEvent\(\{ _id: result\.insertedId, orderNo \}, "new-order"\)/);
  assert.match(source, /enqueueOfflineReviewEvent\(order, "resubmission"\)/);
  assert.match(source, /subscription_valid_until_unix_ms: end\.getTime\(\)/);
  assert.match(source, /private, no-store, max-age=0/);

  for (const request of [
    new Request("http://localhost/api/v1/admin/wechat-review/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "gulong-desktop-unauthorized", channel: "personal-wechat" }),
    }),
    new Request("http://localhost/api/v1/admin/wechat-review/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "gulong-desktop-unauthorized" }),
    }),
    new Request("http://localhost/api/v1/desktop/account/subscription"),
  ]) {
    const response = await app.request(request);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "CHANDLER_SESSION_REQUIRED");
  }
});

test("download page explains both desktop editions", async () => {
  const source = await readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8");
  assert.match(source, /古龙基础版/);
  assert.match(source, /永生花定制版/);
  assert.match(source, /gulong-edition-icon\.png/);
  assert.match(source, /yongshenghua-edition-icon\.png/);
  assert.match(source, /\/api\/downloads\/\$\{editionKey\}\/download/);
});

test("admin subscriptions localize review state and keep the three-column detail layout readable", async () => {
  const [adminSource, css] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /label:\s*"订阅用户"/);
  assert.match(adminSource, /pending_review:\s*"待人工审核"/);
  assert.match(adminSource, /<h2>订阅用户<\/h2>/);
  assert.match(css, /\.admin-detail-panel\s*>\s*article\s*\{[^}]*grid-template-columns:\s*minmax\(132px,[^;]+minmax\(180px,[^;]+minmax\(230px,\s*auto\)/s);
  assert.match(css, /\.subscription-state\s*\{[^}]*white-space:\s*nowrap/s);
});

test("price publishing uses an in-product confirmation and a Chandler permission fallback", async () => {
  const [adminSource, serverSource] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /price-publish-modal/);
  assert.match(adminSource, /amountYuan/);
  assert.match(adminSource, /保存并立即同步/);
  assert.match(adminSource, /GET \/api\/v1\/pricing\/subscriptions/);
  assert.doesNotMatch(adminSource, /window\.confirm\(`发布目标价格/);
  assert.match(serverSource, /amountFen:\s*z\.number\(\)\.int\(\)/);
  assert.match(serverSource, /chandlerSyncStatus/);
  assert.match(serverSource, /price_source:\s*"website-local"/);
});

test("website pricing and desktop synchronization read the same MongoDB price version", async () => {
  const [serverSource, pricingPage] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /async function currentSubscriptionPricing/);
  assert.match(serverSource, /path:\s*"\/api\/v1\/pricing\/subscriptions"/);
  assert.match(serverSource, /Cache-Control",\s*"no-store, max-age=0"/);
  assert.match(serverSource, /monthlyFen:\s*pricing\.monthly\.amountFen/);
  assert.match(serverSource, /yearlyFen:\s*pricing\.yearly\.amountFen/);
  assert.match(pricingPage, /apiFetch\("\/api\/billing\/plans"\)/);
});

test("offline payment review separates pending work from reviewed history", async () => {
  const [adminSource, serverSource, css] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /className="offline-review-tabs"/);
  assert.match(adminSource, /label:\s*"订单处理"/);
  assert.match(adminSource, /<span>待审核<\/span>/);
  assert.match(adminSource, /<span>已审核<\/span>/);
  assert.match(adminSource, /status=\$\{tab\}/);
  assert.match(serverSource, /requestedStatus === "reviewed"/);
  assert.match(serverSource, /summary:\s*\{\s*pending:\s*pendingCount,\s*reviewed:\s*approvedCount \+ rejectedCount/);
  assert.match(css, /\.offline-review-tabs\s*\{/);
});

test("administrator release controls are explicit and legacy direct distribution stays unreachable", async () => {
  const [source, adminSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
  ]);
  assert.equal((source.match(/code: "DIRECT_RELEASE_DISABLED"/g) || []).length, 3);
  assert.match(source, /app\.post\("\/api\/admin\/release-jobs"/);
  assert.match(source, /app\.post\("\/api\/release-worker\/jobs\/:id\/upload"/);
  assert.match(adminSource, /手动上传/);
  assert.match(adminSource, /手动打包发布/);
  assert.match(adminSource, /本地构建不会自动上传腾讯云 COS/);
});
