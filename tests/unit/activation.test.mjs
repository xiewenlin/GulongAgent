import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import app, {
  activationReceiptPayload,
  activationSigningPrivateKey,
  signActivationReceipt,
} from "../../server/app.js";

test("activation receipts use the installer's canonical field order and verify with RSA-SHA256", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const encoded = Buffer.from(privatePem).toString("base64");
  const record = {
    _id: { toString: () => "66c000000000000000000001" },
    product: "minimax-h3-universal",
    deviceId: "a".repeat(64),
    macHint: "A1B2C3",
    activatedAt: new Date("2026-08-18T03:04:05.000Z"),
  };
  const payload = activationReceiptPayload(record);
  assert.deepEqual(Object.keys(payload), ["version", "licenseId", "product", "deviceId", "macHint", "activatedAt", "perpetual"]);
  const signingKey = activationSigningPrivateKey(encoded);
  const signed = signActivationReceipt(payload, signingKey);
  assert.equal(signed.algorithm, "RS256");
  assert.equal(verify(
    "RSA-SHA256",
    Buffer.from(JSON.stringify(payload)),
    createPublicKey(privateKey),
    Buffer.from(signed.signature, "base64"),
  ), true);
});

test("activation signing refuses missing, malformed, or undersized private keys", () => {
  assert.throws(() => activationSigningPrivateKey(""), /授权签名密钥尚未配置/);
  assert.throws(() => activationSigningPrivateKey("not-base64"), /授权签名密钥格式无效/);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encoded = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  assert.throws(() => activationSigningPrivateKey(encoded), /授权签名密钥格式无效/);
});

test("public redeem validation is uncached and documented without bearer authentication", async () => {
  const response = await app.request("http://localhost/api/licenses/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "bad-code", deviceId: "bad-device" }),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal((await response.json()).code, "INVALID_ACTIVATION_CODE");

  const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  const route = document.paths["/api/licenses/redeem"]?.post;
  assert.ok(route);
  assert.deepEqual(route.security, []);
  assert.ok(route.responses[200]);
  assert.ok(route.responses[409]);
  assert.ok(route.responses[503]);
});
