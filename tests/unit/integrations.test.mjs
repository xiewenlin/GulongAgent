import assert from "node:assert/strict";
import test from "node:test";
import app from "../../server/app.js";
import platform from "../../api/platform.js";
import { chandlerConfig, externalAuthFromResponse } from "../../server/chandler.js";
import { cosConfig, sanitizeFilename } from "../../server/cos.js";
import { readExternalAuth, sealExternalAuth } from "../../server/security.js";

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

test("official Chandler and Chengdu COS defaults stay pinned", () => {
  assert.equal(chandlerConfig().baseUrl, "https://api.chandler.work");
  assert.equal(chandlerConfig().monthlyPriceFen, 29_800);
  assert.equal(chandlerConfig().yearlyPriceFen, 298_000);
  const cos = cosConfig();
  assert.equal(cos.bucket, "gulong-1259744534");
  assert.equal(cos.region, "ap-chengdu");
  assert.equal(cos.domain, "gulong-1259744534.cos.ap-chengdu.myqcloud.com");
  assert.equal(typeof cos.configured, "boolean");
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
  assert.ok(document.paths["/api/admin/chandler/users"]);
  assert.ok(document.paths["/api/admin/chandler/users/{id}/status"]);
  assert.ok(document.paths["/api/admin/chandler/users/{id}/subscriptions"]);
  assert.ok(document.paths["/api/admin/chandler/catalog"]);
  assert.ok(document.paths["/api/admin/chandler/prices"]);
  assert.ok(document.paths["/api/admin/chandler/entitlement-requests"]);
});

test("Vercel platform entry restores nested API paths", async () => {
  const response = await platform.fetch(new Request("https://example.test/api/platform?_platform_path=releases/latest"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { release: null });
});
