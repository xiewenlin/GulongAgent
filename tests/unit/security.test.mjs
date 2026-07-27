import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintIp,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  normalizeUsername,
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

test("mock payment URLs stay inside the application", () => {
  assert.equal(paymentCapabilities().mode, "mock");
  const url = new URL(createMockPaymentUrl("GL123", "wechat", "safe-token"), "https://example.test");
  assert.equal(url.origin, "https://example.test");
  assert.equal(url.pathname, "/payment/mock");
  assert.equal(url.searchParams.get("order"), "GL123");
  assert.equal(url.searchParams.get("provider"), "wechat");
  assert.equal(url.searchParams.get("token"), "safe-token");
});
