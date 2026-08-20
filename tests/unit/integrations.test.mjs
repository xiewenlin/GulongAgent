import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import app from "../../server/app.js";
import platform from "../../api/platform.js";
import {
  bindChandlerPhone,
  chandlerConfig,
  createDirectPaymentOrder,
  createPartnerPriceVersion,
  deleteChandlerIdentity,
  externalAuthFromResponse,
  forgotPasswordWithChandler,
  forgotPasswordWithChandlerPhone,
  getChandlerAuthCapabilities,
  isChandlerBootstrapAdmin,
  listAllPartnerClientUsers,
  listChandlerIdentities,
  listPartnerSubscriptionPlans,
  loginWithChandlerOtp,
  productEdition,
  productEditionFromChannel,
  refreshChandlerLogin,
  registerWithChandler,
  resetPasswordWithChandler,
  resetPasswordWithChandlerPhone,
  resolveWebsiteLoginEmail,
  sendChandlerVerificationEmail,
  sendLoginOtpWithChandler,
  verifyChandlerEmail,
  verifyChandlerIdentity,
  verifyChandlerWebhook,
  websiteUsernameIdentity,
  websiteUsernameOwnerFilter,
} from "../../server/chandler.js";
import { browserUploadCorsReady, browserUploadCorsRule, cosConfig, sanitizeFilename } from "../../server/cos.js";
import { readExternalAuth, readUserSecret, sealExternalAuth, sealUserSecret } from "../../server/security.js";
import { recoverExpiredDirectReleaseLock } from "../../server/release-lock.js";
import {
  OFFLINE_REVIEW_REJECTION_REASON,
  chandlerOrderItems,
  normalizeChandlerOfflineOrder,
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

test("website login normalizes e-mail identifiers and resolves registered usernames before Chandler login", async () => {
  assert.equal(await resolveWebsiteLoginEmail("  Member@Example.COM  "), "member@example.com");
  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  const chandlerSource = await readFile(new URL("../../server/chandler.js", import.meta.url), "utf8");
  assert.match(source, /const loginEmail = await resolveWebsiteLoginEmail\(input\.identifier\)/);
  assert.match(source, /loginWithChandler\(loginEmail, input\.password\)/);
  assert.match(chandlerSource, /usernameLookupHash: identity\.lookupHash/);
  assert.match(chandlerSource, /usernameNormalized: identity\.legacyNormalized/);
  assert.match(chandlerSource, /chandlerRequest\("\/v1\/oauth\/token"/);
  assert.match(chandlerSource, /grant_type: "refresh_token"/);
  assert.match(chandlerSource, /\[404, 405\]\.includes\(error\.status\)/);
  assert.match(chandlerSource, /auth\.invalid_credentials/);
});

test("website registration accepts arbitrary username aliases without sending them to Chandler", async () => {
  const alias = websiteUsernameIdentity("  施 富 ✨ / 古龙（测试）  ");
  assert.equal(alias.username, "施 富 ✨ / 古龙（测试）");
  assert.equal(alias.lookupHash.length, 64);
  assert.deepEqual(websiteUsernameOwnerFilter(alias.username).$or[0], { usernameLookupHash: alias.lookupHash });

  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options = {}) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: { access_token: "access", user: { id: "user-1", email: "member@example.com" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await registerWithChandler({ email: "member@example.com", password: "任意密码", displayName: "施富" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(Object.hasOwn(body, "username"), false);
  assert.equal(body.email, "member@example.com");
});

test("Chandler login refresh uses the v3.3 form-encoded OAuth contract", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options = {}) => {
    call = { url: String(url), method: options.method, headers: options.headers, body: new URLSearchParams(options.body) };
    return new Response(JSON.stringify({ data: { access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await refreshChandlerLogin("current-refresh");
    assert.equal(result.access_token, "next-access");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(call.url, "https://api.chandler.work/v1/oauth/token");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(call.body.get("grant_type"), "refresh_token");
  assert.equal(call.body.get("refresh_token"), "current-refresh");
});

test("Chandler password recovery sends mail and resets with the one-time token", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: { status: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await forgotPasswordWithChandler(" Member@Example.com ");
    await resetPasswordWithChandler(" reset-token-123 ", "New-Strong-Pass456!");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0].url, "https://api.chandler.work/v1/auth/forgot-password");
  assert.deepEqual(calls[0].body, { email: "member@example.com" });
  assert.equal(calls[1].url, "https://api.chandler.work/v1/auth/reset-password");
  assert.deepEqual(calls[1].body, { token: "reset-token-123", new_password: "New-Strong-Pass456!" });
});

test("Chandler v3.6 OTP, phone recovery and account identities follow the official contracts", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || "GET",
      authorization: options.headers?.Authorization,
      body: options.body ? JSON.parse(options.body) : null,
    });
    const path = new URL(url).pathname;
    const data = path === "/v1/auth/capabilities" ? { sms_otp_enabled: true }
      : path === "/v1/auth/otp/login" ? { access_token: "otp-access", refresh_token: "otp-refresh", user: { id: "user-otp", email: "member@example.com" } }
        : path === "/v1/me/identities" && (options.method || "GET") === "GET" ? { identities: [{ id: "identity-phone", provider: "phone", value: "+8613800000000", verified: false }] }
          : path === "/v1/me/identities" ? { identity: { id: "identity-phone", provider: "phone", value: "+8613800000000", verified: false } }
            : { status: "accepted" };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await getChandlerAuthCapabilities();
    await sendLoginOtpWithChandler("member@example.com", "email");
    await loginWithChandlerOtp("+8613800000000", "phone", "123456");
    await forgotPasswordWithChandlerPhone("+8613800000000");
    await resetPasswordWithChandlerPhone("+8613800000000", "654321", "New-Pass-2026!");
    await listChandlerIdentities("user-access");
    await bindChandlerPhone("user-access", { phone: "+8613800000000", currentPassword: "Current-Pass" });
    await verifyChandlerIdentity("user-access", "identity-phone", "123456");
    await deleteChandlerIdentity("user-access", "identity-phone");
    await sendChandlerVerificationEmail("user-access");
    await verifyChandlerEmail("email-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.chandler.work/v1/auth/capabilities",
    "https://api.chandler.work/v1/auth/otp/send",
    "https://api.chandler.work/v1/auth/otp/login",
    "https://api.chandler.work/v1/auth/phone/forgot-password",
    "https://api.chandler.work/v1/auth/phone/reset-password",
    "https://api.chandler.work/v1/me/identities",
    "https://api.chandler.work/v1/me/identities",
    "https://api.chandler.work/v1/me/identities/identity-phone/verify",
    "https://api.chandler.work/v1/me/identities/identity-phone",
    "https://api.chandler.work/v1/auth/send-verification-email",
    "https://api.chandler.work/v1/auth/verify-email",
  ]);
  assert.deepEqual(calls[1].body, { target: "member@example.com", target_type: "email" });
  assert.deepEqual(calls[2].body, { target: "+8613800000000", target_type: "phone", code: "123456", device_type: "web" });
  assert.deepEqual(calls[4].body, { phone: "+8613800000000", code: "654321", new_password: "New-Pass-2026!" });
  assert.equal(calls[5].authorization, "Bearer user-access");
  assert.deepEqual(calls[6].body, { provider: "phone", value: "+8613800000000", current_password: "Current-Pass" });
  assert.deepEqual(calls[7].body, { code: "123456" });
  assert.equal(calls[8].method, "DELETE");
  assert.deepEqual(calls[10].body, { token: "email-token" });
});

test("website authentication exposes email-only registration and rate-limited Chandler v3.6 security flows", async () => {
  const [serverSource, modalSource, dashboardSource, securitySource, vercel, specResponse] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountModal.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountSecurityPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
    app.request(new Request("http://localhost/api/openapi.json")),
  ]);
  const spec = await specResponse.json();
  for (const path of [
    "/api/auth/capabilities",
    "/api/auth/otp/send",
    "/api/auth/otp/login",
    "/api/auth/phone/forgot-password",
    "/api/auth/phone/reset-password",
    "/api/account/security",
    "/api/account/security/email/send-verification",
    "/api/account/security/email/verify",
    "/api/account/security/phone/bind",
    "/api/account/security/identities/{identityId}/verify",
    "/api/account/security/identities/{identityId}",
  ]) assert.ok(spec.paths[path], `OpenAPI missing ${path}`);
  assert.match(serverSource, /auth-otp-send-ip/);
  assert.match(serverSource, /auth-otp-send-target/);
  assert.match(serverSource, /phone-bind-target/);
  assert.match(serverSource, /phoneRegistrationEnabled: false/);
  assert.match(modalSource, /仅支持邮箱注册/);
  assert.match(modalSource, /setCooldown\(60\)/);
  assert.match(modalSource, /秒后可重发/);
  assert.match(dashboardSource, /id: "security", label: "账号安全"/);
  assert.match(securitySource, /手机号仅用于已注册账号/);
  assert.match(securitySource, /useConfirmDialog/);
  assert.match(vercel, /\/api\/auth\/:path\*/);
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

test("Chandler v3.3 splits service order credentials from user prepay and keeps Webhook HMAC constant-time", async () => {
  const originalFetch = globalThis.fetch;
  const previousApiKey = process.env.GulongAgent;
  const previousHmacKey = process.env.CHANDLER_WEBHOOK_HMAC_KEY;
  const calls = [];
  process.env.GulongAgent = "server-api-key-test";
  process.env.CHANDLER_WEBHOOK_HMAC_KEY = "a".repeat(64);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    const data = String(url).endsWith("/prepay")
      ? { code_url: "weixin://pay/test" }
      : { platform_order_no: "ord-v33", amount: 8800 };
    return new Response(JSON.stringify({ data }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    await createDirectPaymentOrder("payer-access-token", { merchantOrderNo: "merchant-v33", channel: "wechat", amountFen: 8800, subject: "订阅", source: "test", partnerData: {} });
    const rawBody = Buffer.from('{"platform_order_no":"ord-v33"}', "utf8");
    const signature = createHmac("sha256", "a".repeat(64)).update(rawBody).digest("hex");
    assert.equal(verifyChandlerWebhook(rawBody, signature), true);
    assert.equal(verifyChandlerWebhook(rawBody, "0".repeat(64)), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiKey === undefined) delete process.env.GulongAgent; else process.env.GulongAgent = previousApiKey;
    if (previousHmacKey === undefined) delete process.env.CHANDLER_WEBHOOK_HMAC_KEY; else process.env.CHANDLER_WEBHOOK_HMAC_KEY = previousHmacKey;
  }
  assert.equal(calls[0].headers.Authorization, "Apikey server-api-key-test");
  assert.equal(calls[0].headers["Idempotency-Key"], "merchant-v33");
  assert.equal(calls[0].body.channel, "wechat");
  assert.equal(calls[1].headers.Authorization, "Bearer payer-access-token");
  assert.equal(calls[1].headers["Idempotency-Key"], "prepay-merchant-v33");
});

test("desktop Chandler partner operations stay behind the official website proxy", async () => {
  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  assert.match(source, /desktopChandlerCatalogRoute/);
  assert.match(source, /desktopChandlerPublishPriceRoute/);
  assert.match(source, /desktopChandlerCheckoutRoute/);
  assert.match(source, /desktopChandlerOrderStatusRoute/);
  assert.match(source, /authenticateDesktopChandler\(c, \{ admin: true \}\)/);
  assert.match(source, /findOne\(\{ orderNo, ownerId: auth\.user\._id \}\)/);
  assert.doesNotMatch(source, /process\.env\.GulongAgent[^\n]*return c\.json/);
});

test("Chandler v3.3 wrappers keep SKU compatibility while publishing once-only prices", async () => {
  const originalFetch = globalThis.fetch;
  const previousApiKey = process.env.GulongAgent;
  const calls = [];
  process.env.GulongAgent = "server-api-key-test";
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
    if (previousApiKey === undefined) delete process.env.GulongAgent; else process.env.GulongAgent = previousApiKey;
  }
  const priceCall = calls.find((call) => call.url.endsWith("/skus/sku-month/prices"));
  assert.equal(priceCall.method, "POST");
  assert.equal(priceCall.body.amount, 3600);
  assert.equal(priceCall.body.billing_interval, "once");
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

test("primary navigation keeps short drama embedded and restores Worker immediately after it", async () => {
  const source = await readFile(new URL("../../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /\{ label: "工作流", href: "\/workflows" \}/);
  assert.match(source, /const SHORT_DRAMA_ROUTE = "\/short-drama"/);
  assert.match(source, /\{ label: "短剧", href: SHORT_DRAMA_ROUTE \}/);
  assert.match(source, /\{ label: "短剧", href: SHORT_DRAMA_ROUTE \},\s*\{ label: "威客", href: "\/worker" \}/);
  assert.match(source, /navigate\(SHORT_DRAMA_ROUTE\)\}>短剧/);
  assert.match(source, /navigate\("\/worker"\)\}>威客/);
  assert.match(source, /<ShortDramaPage user=\{user\} authResolved=\{authResolved\} openAuth=\{openAuth\}/);
});

test("short-drama authentication waits for the official session before opening login", async () => {
  const [appSource, workflowSource] = await Promise.all([
    readFile(new URL("../../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WorkflowPages.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /const \[authResolved, setAuthResolved\] = useState\(false\)/);
  assert.match(appSource, /\.finally\(\(\) => setAuthResolved\(true\)\)/);
  assert.match(appSource, /<ShortDramaPage user=\{user\} authResolved=\{authResolved\} openAuth=\{openAuth\}/);
  assert.match(workflowSource, /if \(authResolved\) openAuth\(mode\)/);
  assert.match(workflowSource, /else pendingAuthModeRef\.current = mode/);
  assert.match(workflowSource, /if \(!authResolved \|\| queryAuthHandledRef\.current\) return/);
});

test("the primary navigation omits the complaint entry while the feedback page stays reachable", async () => {
  const source = await readFile(new URL("../../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\{ label: "吐槽", href: "\/feedback" \}/);
  assert.match(source, /pathname === "\/feedback"\) page = <FeedbackPage/);
  assert.doesNotMatch(source, /className="mobile-feedback"/);
});

test("email verification-code password recovery is wired end to end", async () => {
  const [modalSource, serverSource, css] = await Promise.all([
    readFile(new URL("../../src/components/AccountModal.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(modalSource, /忘记密码？/);
  assert.match(modalSource, /\/api\/auth\/forgot-password/);
  assert.match(modalSource, /\/api\/auth\/reset-password/);
  assert.match(modalSource, /autoComplete="one-time-code"/);
  assert.match(modalSource, /两次输入的新密码不一致/);
  assert.match(modalSource, /const RESET_MIN_PASSWORD_LENGTH = 8/);
  assert.match(modalSource, /function PasswordVisibilityButton/);
  assert.match(modalSource, /event\.preventDefault\(\)/);
  assert.match(modalSource, /event\.stopPropagation\(\)/);
  assert.match(modalSource, /className="account-password-field"/);
  assert.doesNotMatch(modalSource, /<label><span className="account-label-row"/);
  assert.doesNotMatch(modalSource, /minLength=\{10\}|至少 10 位/);
  assert.match(modalSource, /minLength=\{1\}/);
  assert.match(modalSource, /官网不预先限制字符类型/);
  assert.match(serverSource, /password: z\.string\(\)\.min\(1\)\.max\(255\)/);
  assert.match(serverSource, /newPassword: z\.string\(\)\.min\(8\)\.max\(255\)/);
  assert.match(serverSource, /password-forgot-email:/);
  assert.match(serverSource, /password-reset-code:/);
  assert.match(serverSource, /deleteMany\(\{ userId: user\._id \}\)/);
  assert.match(serverSource, /Cache-Control", "no-store, max-age=0/);
  assert.match(css, /\.reset-code-actions\s*\{/);
  assert.match(css, /\.account-label-row\s*\{/);
});

test("registration accepts unrestricted usernames, keeps errors Chinese, and pricing imports every rendered icon", async () => {
  const [modalSource, apiSource, platformSource, chandlerSource] = await Promise.all([
    readFile(new URL("../../src/components/AccountModal.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/api.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/chandler.js", import.meta.url), "utf8"),
  ]);
  const response = await app.request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ username: "  任意 用户名 ✨ / !@#$%^&*()  ", email: "not-an-email", password: "x" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "VALIDATION_ERROR",
    message: "请输入有效的邮箱地址",
    requestId: response.headers.get("x-request-id"),
  });
  assert.match(modalSource, /const optionalText = \(value\) => value\.trim\(\) \|\| undefined/);
  assert.match(modalSource, /可输入中文、空格、符号或任意字符/);
  assert.doesNotMatch(modalSource, /name="username"[^>]+(?:minLength|maxLength|pattern)=/);
  assert.match(apiSource, /payload\.error\?\.message/);
  assert.match(apiSource, /localizeErrorMessage\(candidate\)/);
  assert.match(chandlerSource, /auth\.weak_password/);
  const openapi = await app.request("http://localhost/api/openapi.json").then((result) => result.json());
  const usernameSchema = openapi.paths["/api/auth/register"].post.requestBody.content["application/json"].schema.properties.username;
  assert.equal(usernameSchema.type, "string");
  assert.equal(usernameSchema.minLength, undefined);
  assert.equal(usernameSchema.maxLength, undefined);
  assert.equal(usernameSchema.pattern, undefined);
  const iconImports = platformSource.slice(0, platformSource.indexOf('} from "@phosphor-icons\/react"'));
  assert.match(iconImports, /\bCoins\b/);
});

test("system workflows remain deleted and Worker online escrow uses the server-side task budget", async () => {
  const [serverSource, workerSource, adminSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WorkerPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /getCollection\("publicWorkflowTombstones"\)/);
  assert.match(serverSource, /if \(deleted\) return/);
  assert.match(serverSource, /deletedSystemKey: workflow\.systemKey \|\| null/);
  assert.match(adminSource, /type="button" className="button small danger"[^>]+onClick=\{\(\) => remove\(workflow\)\}/);
  assert.match(serverSource, /body\.kind === "worker_task"/);
  assert.match(serverSource, /amountFen = kind === "worker_task"\s*\? Number\(workerTask\.budgetFen\)/);
  assert.match(serverSource, /source: "gulong-web-worker-task"/);
  assert.match(serverSource, /paymentStatus: "pending_online"/);
  assert.match(serverSource, /notifyWorkerTaskReady\(task, \{ online: true \}\)/);
  assert.match(workerSource, /kind: "worker_task", provider: "wechat", taskId: payment\.task\.id/);
  assert.match(workerSource, /微信在线支付/);
  assert.match(workerSource, /本次为一次性付款，不会自动续费或自动扣款/);
});

test("activation management prioritizes unused codes and exposes encrypted copyable plaintext to administrators", async () => {
  const [serverSource, adminSource, cssSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /\$eq: \["\$status", "unused"\][^\n]+then: 0/);
  assert.match(serverSource, /\$eq: \["\$status", "used"\][^\n]+then: 2/);
  assert.match(serverSource, /codeEncrypted: sealUserSecret\(code, "activation-code"\)/);
  assert.match(serverSource, /readUserSecret\(item\.codeEncrypted, "activation-code"\)/);
  assert.match(adminSource, /navigator\.clipboard\?\.writeText/);
  assert.match(adminSource, /copyCode\(item\)/);
  assert.match(adminSource, /\/api\/admin\/activation-codes\/\$\{item\.id\}\/reissue/);
  assert.match(adminSource, /<Copy size=\{16\} \/>\{busy === item\.id \? "复制中" : "复制"\}/);
  assert.match(cssSource, /\.activation-table \.activation-code-value/);
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
  assert.match(source, /onClick=\{\(\) => setCustomContactOpen\(true\)\}>联系定制/);
  assert.match(source, /新建订单/);
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
  assert.ok(document.paths["/api/auth/forgot-password"]?.post);
  assert.ok(document.paths["/api/auth/reset-password"]?.post);
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
  assert.ok(document.paths["/api/v1/desktop/offline-payments"]);
  assert.ok(document.paths["/api/v1/admin/offline-payments"]);
  assert.ok(document.paths["/api/v1/admin/offline-payments/{orderId}/approve"]);
  assert.ok(document.paths["/api/v1/desktop/account/subscription"]);
  assert.ok(document.paths["/api/v1/desktop/chandler/catalog"]);
  assert.ok(document.paths["/api/v1/desktop/chandler/prices"]);
  assert.ok(document.paths["/api/v1/desktop/chandler/checkout"]);
  assert.ok(document.paths["/api/v1/desktop/chandler/orders/{orderNo}"]);
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

  const downloadsResponse = await platform.fetch(new Request("https://example.test/api/platform?_platform_path=downloads"));
  assert.equal(downloadsResponse.status, 200);
  assert.equal(downloadsResponse.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.deepEqual((await downloadsResponse.json()).editions, []);

  const trailingSlashResponse = await platform.fetch(new Request("https://example.test/api/platform?_platform_path=releases/latest/"));
  assert.equal(trailingSlashResponse.status, 200);
  assert.deepEqual(await trailingSlashResponse.json(), { release: null });
});

test("administrator routes survive Chandler refresh changes and Vercel wildcard slashes", async () => {
  const [serverSource, chandlerSource, platformSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/chandler.js", import.meta.url), "utf8"),
    readFile(new URL("../../api/platform.js", import.meta.url), "utf8"),
  ]);
  assert.match(chandlerSource, /refreshChandlerLogin\(auth\.refreshToken\)/);
  assert.match(chandlerSource, /const accessRefreshPromises = new Map\(\)/);
  assert.match(chandlerSource, /currentSession = await sessions\.findOne/);
  assert.match(serverSource, /const locallyVerifiedAdmin = auth\.user\.role === "admin"/);
  assert.match(serverSource, /if \(!locallyVerifiedAdmin\) throw error/);
  assert.match(serverSource, /app\.get\("\/api\/admin\/worker-payments"/);
  assert.match(serverSource, /app\.get\("\/api\/admin\/worker-contact-payments"/);
  assert.match(platformSource, /path\.replace\(\/\\\/\+\$\/, ""\)/);
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
  assert.ok(sources.includes("/api/downloads"));
  assert.ok(sources.includes("/api/downloads/:path*"));
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

test("desktop Chandler offline orders normalize into the website review queue", () => {
  const items = chandlerOrderItems({ orders: [{
    platform_order_no: "ord_desktop_1",
    partner_data: {
      application_key: "gulong",
      payment_method: "offline",
      review_status: "pending",
      plan_kind: "yearly",
      amount_fen: 298000,
      user_id: "chandler-user-1",
      user_email: "member@example.com",
      submitted_at_unix_ms: 1785542400000,
    },
  }] });
  assert.equal(items.length, 1);
  assert.deepEqual(normalizeChandlerOfflineOrder(items[0], { id: "cm_gulong", editionKey: "gulong" }), {
    orderNo: "ord_desktop_1",
    chandlerUserId: "chandler-user-1",
    userEmail: "member@example.com",
    cycle: "year",
    amountFen: 298000,
    reviewStatus: "pending",
    partnerData: items[0].partner_data,
    applicationId: "cm_gulong",
    applicationKey: "gulong",
    editionKey: "gulong",
    editionName: "古龙版",
    createdAt: new Date(1785542400000),
  });
  assert.equal(normalizeChandlerOfflineOrder({ platform_order_no: "ord_online", partner_data: { payment_method: "wechat" } }), null);
});

test("desktop WeChat review API validates Chandler administrators and a bound worker", async () => {
  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  assert.match(source, /desktopCreateOfflinePaymentRoute/);
  assert.match(source, /syncChandlerOfflinePayments\(auth\.accessToken\)/);
  assert.match(source, /authenticateDesktopChandler\(c, \{ admin: true \}\)/);
  assert.match(source, /identity\.role !== "admin"/);
  assert.match(source, /workerId, ownerId: auth\.user\._id, enabled: true, channel: "personal-wechat"/);
  assert.match(source, /enqueueOfflineReviewEvent\(\{ _id: result\.insertedId, orderNo \}, "new-order"\)/);
  assert.match(source, /enqueueOfflineReviewEvent\(order, "resubmission"\)/);
  assert.match(source, /subscription_valid_until_unix_ms: end\.getTime\(\)/);
  assert.match(source, /private, no-store, max-age=0/);

  for (const request of [
    new Request("http://localhost/api/v1/desktop/offline-payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientOrderNo: "offline_local_gulong_test_1", applicationKey: "gulong", themeName: "上古神龙", releaseChannel: "古龙版", planKind: "monthly", expectedAmountFen: 29800 }),
    }),
    new Request("http://localhost/api/v1/admin/offline-payments"),
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
  const [source, adminSource] = await Promise.all([
    readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /古龙基础版/);
  assert.match(source, /MiniMax H3 极速视频版/);
  assert.match(source, /PromptEngine、Z-Image 与 ComfyUI/);
  assert.doesNotMatch(source, /永生花定制版/);
  assert.match(source, /gulong-edition-icon\.png/);
  assert.match(source, /yongshenghua-edition-icon\.png/);
  assert.match(adminSource, /return "MiniMax H3 极速视频版"/);
  assert.match(source, /\/api\/downloads\/\$\{editionKey\}\/download/);
  assert.match(source, /\/api\/platform\?_platform_path=downloads/);
  assert.match(source, /\/api\/releases\/\$\{encodeURIComponent\(channelId\)\}\/download/);
  assert.doesNotMatch(source, /备用下载通道|ALTERNATIVE DOWNLOAD|飞书下载|夸克网盘|百度网盘/);
  assert.doesNotMatch(source, /download-providers|download-provider/);
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
  assert.match(adminSource, /选择用户分组或发行渠道/);
  assert.match(adminSource, /params\.set\("channelId", channelId\)/);
  assert.match(serverSource, /async function releaseChannelUserFilter/);
  assert.match(serverSource, /channel\?\.isDefault/);
  assert.doesNotMatch(adminSource, /Chandler 管理接口未向当前账号开放/);
});

test("administrator subscription periods are authoritative across website and desktop clients", async () => {
  const [serverSource, dbSource, adminSource, accountSource] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /manualPeriodOverride:\s*true/);
  assert.match(serverSource, /subscriptionPeriodState\(subscription\.currentPeriodStart, subscription\.currentPeriodEnd, now\)/);
  assert.match(serverSource, /subscription_source:\s*"website_admin_period"/);
  assert.match(serverSource, /subscriptionPeriodAudits/);
  assert.match(serverSource, /type:\s*"subscription_period_updated"|"subscription_period_updated"/);
  assert.doesNotMatch(serverSource, /safeDate\(subscription\.currentPeriodEnd\)/);
  assert.match(dbSource, /subscription_period_audits_by_user/);
  assert.match(serverSource, /account_type: user\.role === "admin" \? "administrator" : isMember \? "subscription_member" : "standard_user"/);
  assert.match(serverSource, /membership_status: membershipStatus/);
  assert.match(adminSource, /user\.is_member \? "订阅会员" : "普通用户"/);
  assert.match(adminSource, /Promise\.all\(\[inspect\(user\), load\(\)\]\)/);
  assert.match(accountSource, /isMember \? "订阅会员" : "普通用户"/);
});

test("Chandler v3.2 pricing uses application-level price versions before the local mirror", async () => {
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

test("online payment exposes WeChat only and uses manual renewal lifecycle controls", async () => {
  const [serverSource, pricingPage, accountPage] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /ONLINE_PAYMENT_AVAILABILITY/);
  assert.match(serverSource, /online:\s*true/);
  assert.match(serverSource, /priorityProvider:\s*"wechat"/);
  assert.match(serverSource, /wechat:\s*true/);
  assert.match(serverSource, /paymentAvailability:\s*ONLINE_PAYMENT_AVAILABILITY/);
  assert.doesNotMatch(pricingPage, /online-payment-status-card/);
  assert.doesNotMatch(pricingPage, /微信手动续费/);
  assert.doesNotMatch(pricingPage, /当前不自动扣款/);
  assert.match(pricingPage, /paymentMode === "offline"/);
  assert.match(pricingPage, /人工审核到账/);
  assert.doesNotMatch(pricingPage, /支付宝/);
  assert.match(serverSource, /RENEWAL_REMINDER_DAYS = 7/);
  assert.match(serverSource, /subscription_renewal_due/);
  assert.match(accountPage, /会员与充值/);
});

test("order management separates online and offline orders with multidimensional filters", async () => {
  const [adminSource, serverSource, css, dbSource] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /label:\s*"订单管理"/);
  assert.match(adminSource, /<h2>订单管理<\/h2>/);
  assert.match(adminSource, /线上支付/);
  assert.match(adminSource, /线下支付/);
  assert.match(adminSource, /className="offline-review-tabs"/);
  assert.match(adminSource, /<span>待审核<\/span>/);
  assert.match(adminSource, /<span>已审核<\/span>/);
  assert.match(adminSource, /关键词模糊搜索/);
  assert.match(adminSource, /用户分组 \/ 发行渠道/);
  assert.match(adminSource, /古龙版（默认）/);
  assert.doesNotMatch(adminSource, /未分配发行渠道|"未分配"/);
  assert.doesNotMatch(adminSource, /<option value="unassigned"/);
  assert.match(adminSource, /type="date"/);
  assert.match(adminSource, /nextMode === "online" \? "payments" : "offline-payments"/);
  assert.match(adminSource, /setInterval\(\(\) => load\(null, "offline", "pending", filters, true\), 15_000\)/);
  assert.match(serverSource, /app\.get\("\/api\/admin\/payments"/);
  assert.match(serverSource, /async function adminOrderBaseFilter/);
  assert.match(serverSource, /"providerTransactionId"/);
  assert.match(serverSource, /isDefault:\s*Boolean\(channel\.isDefault\)/);
  assert.match(serverSource, /name:\s*"古龙版",\s*groupId:\s*null,\s*isDefault:\s*true/);
  assert.match(serverSource, /requestedStatus === "reviewed"/);
  assert.match(serverSource, /summary:\s*\{\s*pending:\s*pendingCount,\s*reviewed:\s*approvedCount \+ rejectedCount/);
  assert.match(css, /\.offline-review-tabs\s*\{/);
  assert.match(css, /\.payment-mode-tabs\s*\{/);
  assert.match(css, /\.order-filter-panel\s*\{/);
  assert.match(css, /grid-template-areas:\s*"keyword keyword channel channel"\s*"from to actions actions"/);
  assert.match(dbSource, /payments_by_owner_and_date/);
  assert.match(dbSource, /offline_payments_by_owner_and_date/);
});

test("desktop management console can reuse a validated Chandler administrator bearer", async () => {
  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  assert.match(source, /async function requireAdmin\(c\)[\s\S]*authenticateDesktopChandler\(c, \{ admin: true \}\)/);
  assert.match(source, /kind:\s*"desktop-chandler"/);
  assert.match(source, /auth\.user\.authProvider === "chandler" && auth\.kind !== "desktop-chandler"/);
  assert.match(source, /async function getAdminChandlerAccessToken\(auth\)[\s\S]*auth\?\.kind === "desktop-chandler"[\s\S]*auth\.desktop\.accessToken/);
  assert.match(source, /getAdminChandlerAccessToken\(auth\)/);
  assert.match(source, /authorization\.startsWith\("Bearer "\) && authorization\.slice\(7\)\.trim\(\)/);
});

test("administrator feedback records are newest-first and support fuzzy keyword search", async () => {
  const [adminSource, serverSource, css] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /\{ id: "worker", label: "威客审核", icon: Briefcase \},\s*\{ id: "feedback", label: "用户反馈", icon: ChatCircleText \}/);
  assert.match(adminSource, /active === "feedback" && <FeedbackManager \/>/);
  assert.match(adminSource, /\/api\/admin\/feedback\?\$\{params\}/);
  assert.match(adminSource, /搜索反馈内容、昵称、用户名、邮箱、编号或状态/);
  assert.match(serverSource, /app\.get\("\/api\/admin\/feedback"/);
  assert.match(serverSource, /requireAdmin\(c\)/);
  assert.match(serverSource, /feedback\.find\(filter\)\.sort\(\{ createdAt: -1, _id: -1 \}\)/);
  assert.match(serverSource, /\["displayName", "username", "email", "emailNormalized"\]/);
  assert.match(serverSource, /\{ message: regex \}/);
  assert.match(css, /\.admin-feedback-list\s*\{/);
  assert.match(css, /\.feedback-admin-filter\s*\{/);
});

test("feedback processing has three states, COS result attachments, deletion and a user-visible worklog", async () => {
  const [adminSource, accountSource, serverSource, css, dbSource, vercel] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
    readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /\[\["open", "待处理"\], \["processing", "处理中"\], \["resolved", "已处理"\]\]/);
  assert.match(adminSource, /保存为处理中/);
  assert.match(adminSource, /标记已处理并通知用户/);
  assert.match(adminSource, /title: "永久删除这条用户反馈？"/);
  assert.match(adminSource, /confirmLabel: "永久删除反馈"/);
  assert.match(adminSource, /video\/mp4,video\/webm,video\/quicktime/);
  assert.match(serverSource, /app\.post\("\/api\/admin\/feedback\/:id\/assets\/presign"/);
  assert.match(serverSource, /app\.post\("\/api\/admin\/feedback\/:id\/assets\/:uploadId\/complete"/);
  assert.match(serverSource, /app\.put\("\/api\/admin\/feedback\/:id"/);
  assert.match(serverSource, /app\.delete\("\/api\/admin\/feedback\/:id"/);
  assert.match(serverSource, /notifyUser\(current\.ownerId, "feedback_resolved"/);
  assert.match(serverSource, /responseAttachments/);
  assert.match(accountSource, /\{ id: "feedback", label: "我的反馈", icon: ChatCircleText \}/);
  assert.match(accountSource, /active === "feedback"/);
  assert.match(accountSource, /notification\.type\?\.startsWith\("feedback_"\)/);
  assert.match(css, /\.feedback-status-tabs\s*\{/);
  assert.match(css, /\.account-feedback-card\s*\{/);
  assert.match(dbSource, /feedback_response_uploads/);
  assert.match(vercel, /admin\/feedback\/:id\/assets\/:uploadId\/complete/);
  assert.match(vercel, /admin\/feedback\/:id\/assets\/presign/);
  assert.match(vercel, /feedback\/:id\/assets\/:assetId/);
});

test("all consequential actions use the shared themed confirmation dialog", async () => {
  const [mainSource, dialogSource, adminSource, accountSource, workerSource, css, agentInstructions] = await Promise.all([
    readFile(new URL("../../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/ConfirmDialog.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WorkerPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../AGENTS.md", import.meta.url), "utf8"),
  ]);
  assert.match(mainSource, /<ConfirmDialogProvider>/);
  assert.match(dialogSource, /role="alertdialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /cancelButtonRef\.current\?\.focus/);
  assert.match(css, /\.app-confirm-dialog\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(agentInstructions, /Never use browser-native `alert`, `confirm`, or `prompt` dialogs/);
  for (const source of [adminSource, accountSource, workerSource]) {
    assert.doesNotMatch(source, /window\.(alert|confirm|prompt)\s*\(/);
  }
  assert.equal((adminSource.match(/useConfirmDialog\(\)/g) || []).length, 8);
  assert.equal((accountSource.match(/useConfirmDialog\(\)/g) || []).length, 1);
  assert.equal((workerSource.match(/useConfirmDialog\(\)/g) || []).length, 1);
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
