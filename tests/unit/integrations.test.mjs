import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import app from "../../server/app.js";
import platform from "../../api/platform.js";
import {
  chandlerConfig,
  createDirectPaymentOrder,
  createPartnerPriceVersion,
  externalAuthFromResponse,
  isChandlerBootstrapAdmin,
  listAllPartnerClientUsers,
  listPartnerSubscriptionPlans,
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
import {
  canBypassWorkerContactPayment,
  canClaimWorkerTask,
  workerAssignmentInput,
  workerTaskFinancials,
  workerTaskFingerprint,
  workerWorkflowRevenue,
} from "../../server/worker-market.js";

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

test("Chandler v2.2 wrappers use application SKU prices and authoritative sku_id orders", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || "GET", body });
    if (String(url).endsWith("/skus") && (options.method || "GET") === "GET") {
      return new Response(JSON.stringify({ data: { skus: [{ id: "sku-month", code: "vip_month", name: "VIP 月卡", status: "active", active_price: { id: "price-1", amount: 3000, currency: "CNY", billing_interval: "month", interval_count: 1, status: "active", effective_at: "2026-07-30T00:00:00Z", expires_at: null } }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/skus/sku-month/prices")) {
      return new Response(JSON.stringify({ data: { id: "price-2", sku_id: "sku-month", ...body, effective_at: body.effective_at } }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/v1/pay/orders")) {
      return new Response(JSON.stringify({ data: { platform_order_no: "ord-1", amount: 3000 } }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected Chandler request: ${url}`);
  };
  try {
    const plans = await listPartnerSubscriptionPlans("access-token");
    assert.equal(plans[0].priceId, "price-1");
    await createPartnerPriceVersion("access-token", { skuId: "sku-month", amountFen: 3600, billingInterval: "month", effectiveAt: "2026-08-01T00:00:00Z" });
    await createDirectPaymentOrder("access-token", { merchantOrderNo: "merchant-1", channel: "wechat", skuId: "sku-month", subject: "VIP 月卡", source: "test", partnerData: {}, prepay: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const priceCall = calls.find((call) => call.url.endsWith("/skus/sku-month/prices"));
  assert.equal(priceCall.method, "POST");
  assert.equal(priceCall.body.amount, 3600);
  const orderCall = calls.find((call) => call.url.endsWith("/v1/pay/orders"));
  assert.equal(orderCall.body.sku_id, "sku-month");
  assert.equal("amount" in orderCall.body, false);
  assert.equal("currency" in orderCall.body, false);
});

test("Chandler application user synchronization follows the partner-scoped paginated API", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(url);
    calls.push(requestUrl);
    const page = Number(requestUrl.searchParams.get("page"));
    return new Response(JSON.stringify({
      data: {
        items: [{
          user_id: `user-${page}`,
          email: `member-${page}@example.com`,
          display_name: `用户 ${page}`,
          status: "active",
          attributes: { subscription_valid_until: `2027-0${page}-01T00:00:00.000Z` },
        }],
        meta: { total: 2, page, limit: 1 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await listAllPartnerClientUsers("access-token", "cm-partner-app", { limit: 1 });
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map((item) => item.user_id), ["user-1", "user-2"]);
    assert.equal(result.meta.pages, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, "/v1/me/oauth/clients/cm-partner-app/users");
  assert.equal(calls[0].searchParams.get("page"), "1");
  assert.equal(calls[1].searchParams.get("page"), "2");
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

test("worker market settlement and reusable workflow revenue rules are deterministic", () => {
  assert.deepEqual(workerTaskFinancials(1001), {
    budgetFen: 1001,
    contractorIncomeFen: 800,
    platformServiceFeeFen: 201,
    contractorShareBps: 8000,
    platformShareBps: 2000,
  });
  assert.deepEqual(workerWorkflowRevenue({ grossFen: 10000, costFen: 1500, taxFen: 500 }), {
    grossFen: 10000,
    costFen: 1500,
    taxFen: 500,
    netProfitFen: 8000,
    publisherShareFen: 2400,
    contractorShareFen: 2400,
    platformShareFen: 3200,
    rule: { base: "net_after_cost_and_tax", publisherShareBps: 3000, contractorShareBps: 3000, platformShareBps: 4000 },
  });
  assert.equal(workerTaskFingerprint("  分析客服对话  ", "交付 报告"), workerTaskFingerprint("分析客服对话", "交付   报告"));
});

test("only an administrator acting as the contractor bypasses the WeChat contact payment", () => {
  assert.equal(canBypassWorkerContactPayment({ role: "admin", isContractor: true }), true);
  assert.equal(canBypassWorkerContactPayment({ role: "admin", isContractor: false }), false);
  assert.equal(canBypassWorkerContactPayment({ role: "user", isContractor: true }), false);
});

test("worker task assignment validates each mode and enforces its claim boundary", () => {
  assert.deepEqual(workerAssignmentInput({}), { type: "open", assigneeUserId: null });
  assert.equal(workerAssignmentInput({ assignmentType: "user" }), null);
  assert.deepEqual(workerAssignmentInput({ assignmentType: "user", assigneeUserId: "user-2" }), { type: "user", assigneeUserId: "user-2" });
  assert.deepEqual(workerAssignmentInput({ assignmentType: "platform_team", assigneeUserId: "ignored" }), { type: "platform_team", assigneeUserId: null });
  assert.equal(workerAssignmentInput({ assignmentType: "unknown" }), null);

  assert.equal(canClaimWorkerTask({ assignmentType: "open" }, { id: "user-1", role: "user" }), true);
  assert.equal(canClaimWorkerTask({ assignmentType: "user", designatedAssigneeId: "user-2" }, { id: "user-2", role: "user" }), true);
  assert.equal(canClaimWorkerTask({ assignmentType: "user", designatedAssigneeId: "user-2" }, { id: "user-3", role: "admin" }), false);
  assert.equal(canClaimWorkerTask({ assignmentType: "platform_team" }, { id: "user-2", role: "user" }), false);
  assert.equal(canClaimWorkerTask({ assignmentType: "platform_team" }, { id: "admin-1", role: "admin" }), true);
});

test("worker assignment search, visibility, notifications and publishing controls stay wired together", async () => {
  const [appSource, workerPageSource, adminPageSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WorkerPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /path: "\/api\/worker\/assignees"/);
  assert.match(appSource, /\["displayName", "username", "email", "emailNormalized"\]/);
  assert.match(appSource, /assignmentType: "user", designatedAssigneeId: ownerId/);
  assert.match(appSource, /auth\.user\.role === "admin" \? \[\{ assignmentType: "platform_team" \}\]/);
  assert.match(appSource, /worker_task_designated/);
  assert.match(appSource, /worker_platform_task_ready/);
  assert.match(workerPageSource, /指定用户/);
  assert.match(workerPageSource, /平台团队/);
  assert.match(workerPageSource, /\/api\/worker\/assignees\?q=/);
  assert.match(workerPageSource, /assigneeUserId/);
  assert.match(adminPageSource, /item\.assignment\?\.label/);
});

test("the primary Worker navigation is a direct link without a dropdown", async () => {
  const source = await readFile(new URL("../../src/App.jsx", import.meta.url), "utf8");
  const workerEntry = source.match(/\{ label: "威客"[^\n]+/u)?.[0] || "";
  assert.match(workerEntry, /href: "\/worker\?tab=publish"/);
  assert.doesNotMatch(workerEntry, /children/);
});

test("deep customization opens the supplied WeChat QR dialog without requiring login", async () => {
  const [source, qrImage] = await Promise.all([
    readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../public/assets/deep-customization-wechat.jpg", import.meta.url)),
  ]);
  assert.ok(qrImage.byteLength > 10_000);
  assert.match(source, /function CustomizationContactDialog/);
  assert.match(source, /deep-customization-wechat\.jpg/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.target === event\.currentTarget && onClose\(\)/);
  const startPaymentSource = source.slice(source.indexOf("async function startPayment"), source.indexOf("trackAnalyticsEvent", source.indexOf("async function startPayment")));
  assert.ok(startPaymentSource.indexOf('if (plan.id === "custom")') < startPaymentSource.indexOf('if (!user) return openAuth("login")'));
});

test("worker market protects WeChat contacts and preserves promoted administrator roles", async () => {
  const [appSource, workerPageSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WorkerPages.jsx", import.meta.url), "utf8"),
  ]);
  const chandlerSource = await readFile(new URL("../../server/chandler.js", import.meta.url), "utf8");
  assert.match(appSource, /WECHAT_REQUIRED/);
  assert.match(appSource, /amountFen:\s*200/);
  assert.match(appSource, /order\?\.status === "approved"/);
  assert.match(appSource, /roleOverride:\s*"admin"/);
  assert.match(appSource, /accessType:\s*"administrator_contractor_bypass"/);
  assert.match(appSource, /paymentRequired:\s*!administratorBypass/);
  assert.match(workerPageSource, /直接查看发单人微信/);
  assert.match(workerPageSource, /if \(administratorContractor\) load\(\)/);
  assert.match(chandlerSource, /canonical\?\.roleOverride \|\| identity\?\.role/);
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

test("partner edits delete replaced COS images before issuing the next browser upload", async () => {
  const serverSource = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  const routeStart = serverSource.indexOf('app.post("/api/admin/partners/:id/assets/replace"');
  const routeEnd = serverSource.indexOf('app.post("/api/admin/partners"', routeStart);
  const replacementRoute = serverSource.slice(routeStart, routeEnd);
  assert.ok(routeStart > 0);
  assert.ok(replacementRoute.indexOf("await deleteObject(previousObjectKey)") < replacementRoute.indexOf("partnerAssetUploadTicket(input)"));
  assert.match(replacementRoute, /\[assetField\]: null/);
  assert.match(serverSource, /PARTNER_ASSET_REPLACE_REQUIRED/);

  const adminSource = await readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8");
  assert.match(adminSource, /修改 \$\{editing\.name\}/);
  assert.match(adminSource, /当前 Logo/);
  assert.match(adminSource, /\/assets\/replace/);
  assert.match(adminSource, /保存修改并同步品牌神经网络/);
});

test("partner hologram uses explicit controls without hover-to-pause messaging", async () => {
  const source = await readFile(new URL("../../src/components/PartnerNetwork.jsx", import.meta.url), "utf8");
  assert.match(source, /复位视角/);
  assert.match(source, /全息预览/);
  assert.match(source, /createPortal\(networkStage, document\.body\)/);
  assert.doesNotMatch(source, /onMouseEnter=.*setPaused/);
  assert.doesNotMatch(source, /已暂停，方便选择节点|partner-network-note/);
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
  assert.ok(document.paths["/api/admin/chandler/skus"]);
  assert.ok(document.paths["/api/admin/chandler/skus/{skuId}/prices"]);
  assert.ok(document.paths["/api/admin/chandler/skus/{skuId}/status"]);
  assert.ok(document.paths["/api/admin/chandler/entitlement-requests"]);
  assert.ok(document.paths["/api/admin/analytics/dashboard"]);
  assert.ok(document.paths["/api/admin/users/{id}/role"]);
  assert.ok(document.paths["/api/admin/users/{id}/subscription-period"]);
  assert.ok(document.paths["/api/worker/assignees"]?.get);
  assert.ok(document.paths["/api/worker/tasks"]?.get);
  assert.ok(document.paths["/api/worker/tasks"]?.post);
  assert.ok(document.paths["/api/worker/tasks/{id}/payment-submit"]);
  assert.ok(document.paths["/api/worker/tasks/{id}/claim"]);
  assert.ok(document.paths["/api/worker/tasks/{id}/progress"]);
  assert.ok(document.paths["/api/worker/tasks/{id}/submit"]);
  assert.ok(document.paths["/api/worker/tasks/{id}/accept"]);
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
  assert.ok(sources.includes("/api/admin/partners/:id/assets/replace"));
  assert.ok(sources.includes("/api/analytics/:path*"));
  assert.ok(sources.includes("/api/admin/release-channels/:id/manual-upload"));
  assert.ok(sources.includes("/api/admin/release-uploads/:id/complete"));
  assert.ok(sources.includes("/api/release-worker/:path*"));
  assert.ok(sources.includes("/api/worker/:path*"));
  assert.ok(sources.includes("/api/admin/users/:path*"));
  assert.ok(sources.includes("/api/admin/worker-payments/:path*"));
  assert.ok(sources.includes("/api/admin/worker-contact-payments/:path*"));
  assert.ok(sources.includes("/api/admin/worker-workflows/:path*"));
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
  assert.match(adminSource, /修改有效期/);
  assert.match(adminSource, /<span>生效时间<\/span>/);
  assert.match(adminSource, /<span>到期时间<\/span>/);
  assert.match(css, /\.admin-detail-panel\s*>\s*article\s*\{[^}]*grid-template-columns:\s*minmax\(132px,[^;]+minmax\(180px,[^;]+minmax\(230px,\s*auto\)/s);
  assert.match(css, /\.subscription-state\s*\{[^}]*white-space:\s*nowrap/s);
});

test("admin subscription directory uses Chandler application scope and explicit capabilities", async () => {
  const [serverSource, adminSource, chandlerSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/chandler.js", import.meta.url), "utf8"),
  ]);
  const listStart = serverSource.indexOf("app.openapi(adminListChandlerUsersRoute");
  const listEnd = serverSource.indexOf("app.openapi(adminSetWebsiteRoleRoute", listStart);
  const subscriptionsStart = serverSource.indexOf("app.openapi(adminChandlerUserSubscriptionsRoute");
  const subscriptionsEnd = serverSource.indexOf("app.openapi(adminChandlerCatalogRoute", subscriptionsStart);
  const listHandler = serverSource.slice(listStart, listEnd);
  const subscriptionsHandler = serverSource.slice(subscriptionsStart, subscriptionsEnd);
  assert.match(chandlerSource, /\/v1\/me\/oauth\/clients\/\$\{encodeURIComponent\(applicationId\)\}\/users\?page=/);
  assert.match(listHandler, /synchronizeChandlerApplicationUsers/);
  assert.doesNotMatch(listHandler, /\/v1\/admin\/users\?/);
  assert.match(subscriptionsHandler, /getPartnerClientUserAttributes/);
  assert.doesNotMatch(subscriptionsHandler, /\/v1\/admin\/users\/.*\/subscriptions/);
  assert.match(serverSource, /existing\?\.manualPeriodOverride/);
  assert.match(serverSource, /globalUserStatus:\s*false/);
  assert.match(serverSource, /globalEntitlementApproval:\s*false/);
  assert.match(adminSource, /官网 \+ Chandler 应用/);
  assert.match(adminSource, /meta\.capabilities\?\.globalUserStatus === true/);
  assert.match(adminSource, /meta\.capabilities\?\.globalEntitlementApproval === true/);
  assert.doesNotMatch(adminSource, /Chandler 管理接口未向当前账号开放/);
});

test("administrator subscription periods are authoritative across website and desktop clients", async () => {
  const [serverSource, dbSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /manualPeriodOverride:\s*true/);
  assert.match(serverSource, /subscriptionPeriodState\(subscription\.currentPeriodStart, subscription\.currentPeriodEnd, now\)/);
  assert.match(serverSource, /subscription_source:\s*"website_admin_period"/);
  assert.match(serverSource, /subscriptionPeriodAudits/);
  assert.match(serverSource, /type:\s*"subscription_period_updated"|"subscription_period_updated"/);
  assert.doesNotMatch(serverSource, /safeDate\(subscription\.currentPeriodEnd\)/);
  assert.match(dbSource, /subscription_period_audits_by_user/);
});

test("Chandler v2.2 pricing uses application-level price versions before the local mirror", async () => {
  const [adminSource, serverSource, chandlerSource] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/chandler.js", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /price-publish-modal/);
  assert.match(adminSource, /amountYuan/);
  assert.match(adminSource, /发布远程价格版本/);
  assert.match(adminSource, /价格生效时间/);
  assert.match(adminSource, /版本记录/);
  assert.match(adminSource, /GET \/api\/v1\/pricing\/subscriptions/);
  assert.match(serverSource, /amountFen:\s*z\.number\(\)\.int\(\)/);
  assert.match(serverSource, /createPartnerPriceVersion\(accessToken/);
  assert.match(serverSource, /persistChandlerPriceVersion\(\{ plan, price: chandlerPrice/);
  assert.doesNotMatch(serverSource, /chandlerRequest\("\/v1\/admin\/prices"/);
  assert.match(chandlerSource, /\/v1\/me\/oauth\/clients\/\$\{encodeURIComponent\(applicationId\)\}\/skus\/\$\{encodeURIComponent\(skuId\)\}\/prices/);
  assert.match(chandlerSource, /\.\.\.\(skuId \? \{ sku_id: skuId \} : \{ amount: amountFen, currency: "CNY" \}\)/);
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
