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
import { cosConfig, sanitizeFilename } from "../../server/cos.js";
import { readExternalAuth, readUserSecret, sealExternalAuth, sealUserSecret } from "../../server/security.js";

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

test("website typography keeps all declared font sizes at or above 18px", async () => {
  const css = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const undersized = [...css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)]
    .map((match) => Number(match[1]))
    .filter((size) => size < 18);
  assert.deepEqual(undersized, []);
  assert.match(css, /\.account-sidebar\s+nav\s+button[\s\S]*?font-size:\s*18px/);
});

test("COS object filenames cannot escape their assigned prefix", () => {
  assert.equal(sanitizeFilename("../第二大脑:2026?.zip"), "..-第二大脑-2026-.zip");
  assert.equal(sanitizeFilename("  "), "file.bin");
});

test("OpenAPI document includes Chandler admin, offline credentials, dated attachments and releases", async () => {
  const response = await app.request("http://localhost/api/openapi.json");
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.ok(document.paths["/api/auth/offline-credential"]);
  assert.ok(document.paths["/api/v1/brain/attachments/latest"]);
  assert.ok(document.paths["/api/releases/latest"]);
  assert.ok(document.paths["/api/v1/configuration/minimax"]);
  assert.ok(document.paths["/api/admin/chandler/users"]);
  assert.ok(document.paths["/api/admin/chandler/users/{id}/status"]);
  assert.ok(document.paths["/api/admin/chandler/users/{id}/subscriptions"]);
  assert.ok(document.paths["/api/admin/chandler/catalog"]);
  assert.ok(document.paths["/api/admin/chandler/prices"]);
  assert.ok(document.paths["/api/admin/chandler/entitlement-requests"]);
  assert.ok(document.paths["/api/admin/analytics/dashboard"]);
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
  assert.ok(sources.includes("/api/admin/analytics/:path*"));
  assert.ok(sources.includes("/api/analytics/:path*"));
});
