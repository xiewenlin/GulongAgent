import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintIp,
  hashOpaqueToken,
  hashPassword,
  issueShortDramaSsoToken,
  normalizeEmail,
  normalizeUsername,
  shouldUseSecureSessionCookie,
  verifyPassword,
} from "../../server/security.js";
import { createMockPaymentUrl, paymentCapabilities } from "../../server/payments.js";

test("passwords are salted and verified without storing plaintext", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes("correct horse battery staple"), false);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
});

test("account identifiers normalize consistently", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
  assert.equal(normalizeUsername("  GuLong_01 "), "gulong_01");
});

test("opaque tokens and IPs are one-way deterministic fingerprints", () => {
  assert.equal(hashOpaqueToken("token-a"), hashOpaqueToken("token-a"));
  assert.notEqual(hashOpaqueToken("token-a"), hashOpaqueToken("token-b"));
  assert.equal(fingerprintIp("203.0.113.9"), fingerprintIp("203.0.113.9"));
  assert.equal(fingerprintIp("203.0.113.9").length, 24);
});

test("session cookies follow the externally visible protocol with an explicit override", () => {
  const context = (url, forwardedProtocol = "") => ({ req: { url, header: (name) => name === "x-forwarded-proto" ? forwardedProtocol : "" } });
  assert.equal(shouldUseSecureSessionCookie(context("http://111.229.70.235/api/auth/login", "http")), false);
  assert.equal(shouldUseSecureSessionCookie(context("http://127.0.0.1:8787/api/auth/login", "https")), true);
  assert.equal(shouldUseSecureSessionCookie(context("https://sologle.com/api/auth/login")), true);
  assert.equal(shouldUseSecureSessionCookie(context("http://111.229.70.235/api/auth/login"), "true"), true);
  assert.equal(shouldUseSecureSessionCookie(context("https://sologle.com/api/auth/login"), "false"), false);
});

test("short-drama SSO assertions are short-lived and carry the Gulong identity", () => {
  const token = issueShortDramaSsoToken({
    id: "user-123",
    username: "gulong_user",
    email: "user@example.com",
    displayName: "古龙用户",
    role: "user",
  });
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
  assert.equal(payload.iss, "https://sologle.com");
  assert.equal(payload.aud, "gulong-short-drama");
  assert.equal(payload.sub, "user-123");
  assert.equal(payload.name, "古龙用户");
  assert.equal(payload.exp - payload.iat, 120);
  assert.match(payload.jti, /^[A-Za-z0-9_-]+$/);
});

test("mock payment URLs stay inside the application", () => {
  assert.equal(paymentCapabilities().mode, "mock");
  const url = new URL(createMockPaymentUrl("GL123", "wechat", "safe-token"), "https://example.test");
  assert.equal(url.origin, "https://example.test");
  assert.equal(url.pathname, "/payment/mock");
  assert.equal(url.searchParams.get("order"), "GL123");
  assert.equal(url.searchParams.get("provider"), "wechat");
  assert.equal(url.searchParams.get("token"), "safe-token");
});
