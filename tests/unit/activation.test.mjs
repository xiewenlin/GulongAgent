import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import app, {
  HARDWARE_COMPONENT_WEIGHTS,
  activationHardwareBindingAction,
  activationReceiptPayload,
  activationSearchConditions,
  activationSigningPrivateKey,
  parseActivationHardwareBindingV2,
  persistActivationHardwareBindingV2,
  signActivationReceipt,
} from "../../server/app.js";

function hardwareV2(overrides = {}) {
  return {
    fingerprintVersion: "h3-hw-v2",
    hardwareHash: "1".repeat(64),
    hardwareEvidenceHash: "2".repeat(64),
    fingerprintConfidence: "high",
    hardwareScore: 54,
    bindingScore: 78,
    identityComponents: ["gpu", "systemUuid", "baseboardSerial"],
    hardwareComponentDigests: {
      gpu: "3".repeat(64),
      systemUuid: "4".repeat(64),
      baseboardSerial: "5".repeat(64),
    },
    ...overrides,
  };
}

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

test("weighted hardware fingerprint v2 accepts only fixed digest categories and exact weights", () => {
  assert.deepEqual(HARDWARE_COMPONENT_WEIGHTS, {
    systemUuid: 30,
    baseboardSerial: 22,
    baseboardModel: 8,
    biosSerial: 12,
    chassisSerial: 8,
    tpm: 5,
    cpu: 5,
    systemDisk: 4,
    gpu: 2,
    physicalMacs: 2,
    systemModel: 1,
    oemStrings: 1,
  });
  const parsed = parseActivationHardwareBindingV2({
    code: "H3-ABCDE-FGHJK-MNPQR-STUVW",
    deviceId: "a".repeat(64),
    ...hardwareV2(),
  });
  assert.deepEqual(parsed.identityComponents, ["systemUuid", "baseboardSerial", "gpu"]);
  assert.deepEqual(Object.keys(parsed.hardwareComponentDigests), parsed.identityComponents);
  assert.equal(parsed.hardwareScore, 54);
  assert.doesNotMatch(JSON.stringify(parsed), /SERIAL-RAW|AA:BB:CC/);

  assert.throws(
    () => parseActivationHardwareBindingV2({ ...hardwareV2(), baseboardSerialRaw: "SERIAL-RAW" }),
    (error) => error.code === "RAW_HARDWARE_EVIDENCE_REJECTED" && error.status === 400,
  );
  assert.throws(
    () => parseActivationHardwareBindingV2({ code: "H3-ABCDE-FGHJK-MNPQR-STUVW", deviceId: "a".repeat(64), systemUuid: "RAW-SMBIOS-VALUE" }),
    (error) => error.code === "RAW_HARDWARE_EVIDENCE_REJECTED" && error.status === 400,
  );
  assert.throws(
    () => parseActivationHardwareBindingV2(hardwareV2({ hardwareScore: 100 })),
    (error) => error.code === "INVALID_HARDWARE_FINGERPRINT" && error.status === 400,
  );
  assert.throws(
    () => parseActivationHardwareBindingV2(hardwareV2({ hardwareComponentDigests: { systemUuid: "raw-value" } })),
    (error) => error.code === "INVALID_HARDWARE_FINGERPRINT" && error.status === 400,
  );
});

test("legacy activation adds v2 once without changing activatedAt and rejects another motherboard", async () => {
  const activatedAt = new Date("2026-08-18T03:04:05.000Z");
  let stored = {
    _id: "license-1",
    status: "used",
    product: "minimax-h3-universal",
    deviceId: "a".repeat(64),
    activatedAt,
  };
  let updateCount = 0;
  const collection = {
    async findOneAndUpdate(filter, update) {
      assert.equal(filter.deviceId, stored.deviceId);
      assert.deepEqual(filter["hardwareBindingV2.hardwareHash"], { $exists: false });
      updateCount += 1;
      stored = { ...stored, ...update.$set };
      return stored;
    },
    async findOne() { return stored; },
  };
  const incoming = parseActivationHardwareBindingV2(hardwareV2());
  assert.equal(activationHardwareBindingAction(stored, incoming), "bind");
  const first = await persistActivationHardwareBindingV2(collection, stored, incoming, new Date("2026-08-27T00:00:00.000Z"));
  assert.equal(updateCount, 1);
  assert.equal(first.activatedAt, activatedAt);
  assert.equal(first.hardwareBindingV2.hardwareHash, incoming.hardwareHash);
  assert.equal(activationHardwareBindingAction(first, incoming), "unchanged");
  const repeated = await persistActivationHardwareBindingV2(collection, first, incoming);
  assert.equal(repeated, first);
  assert.equal(updateCount, 1);

  const otherMotherboard = { ...incoming, hardwareHash: "9".repeat(64) };
  assert.equal(activationHardwareBindingAction(first, otherMotherboard), "mismatch");
  await assert.rejects(
    persistActivationHardwareBindingV2(collection, first, otherMotherboard),
    (error) => error.code === "HARDWARE_FINGERPRINT_MISMATCH" && error.status === 409,
  );
  assert.equal(updateCount, 1);
});

test("redeem rejects raw v2 hardware evidence before database access", async () => {
  const response = await app.request("http://localhost/api/licenses/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "H3-ABCDE-FGHJK-MNPQR-STUVW",
      deviceId: "a".repeat(64),
      ...hardwareV2(),
      systemUuid: "RAW-SMBIOS-VALUE",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "RAW_HARDWARE_EVIDENCE_REJECTED");
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
  const contract = JSON.stringify(route);
  assert.match(contract, /fingerprintVersion/);
  assert.match(contract, /hardwareComponentDigests/);
  assert.match(contract, /h3-hw-v2/);
  assert.match(contract, /hardwareHash/);
});

test("administrator activation copy stays enabled and can reissue unreadable unused legacy codes", async () => {
  const [adminSource, serverSource] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /disabled=\{Boolean\(busy\)\} onClick=\{\(\) => copyCode\(item\)\}/);
  assert.match(adminSource, /\/api\/admin\/activation-codes\/\$\{item\.id\}\/reissue/);
  assert.match(adminSource, /document\.execCommand\("copy"\)/);
  assert.match(serverSource, /\/api\/admin\/activation-codes\/:id\/reissue/);
  assert.match(serverSource, /status !== "unused"/);
  assert.match(serverSource, /codeEncrypted: sealUserSecret\(code, "activation-code"\)/);
});

test("administrator activation search safely matches device, MAC tail and node name", async () => {
  assert.deepEqual(activationSearchConditions(""), []);
  const nodeConditions = activationSearchConditions("剪辑节点.*");
  assert.equal(nodeConditions.length, 2);
  assert.equal(nodeConditions[0].deviceName.$regex, "剪辑节点\\.\\*");
  assert.equal(nodeConditions[1]["nodeBindings.nodeName"].$regex, "剪辑节点\\.\\*");

  const macConditions = activationSearchConditions("A1:B2:C3");
  assert.equal(macConditions.length, 3);
  assert.equal(macConditions[2].macHint.$regex, "A1B2C3");

  const [adminSource, serverSource, cssSource] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /params\.set\("q", normalizedKeyword\)/);
  assert.match(adminSource, /设备名、MAC 尾号后 6 位或节点名称/);
  assert.match(adminSource, /<span>节点名称<\/span>/);
  assert.match(adminSource, /item\.nodeName \|\| "未设置节点名称"/);
  assert.match(serverSource, /from: "nodeAccountBindings"/);
  assert.match(serverSource, /nodeName: item\.nodeBindings\?\.\[0\]\?\.nodeName/);
  assert.match(cssSource, /\.activation-search\s*\{/);

  const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  const route = document.paths["/api/admin/activation-codes"]?.get;
  assert.ok(route);
  assert.match(JSON.stringify(route), /MAC 尾号后六位/);
  assert.match(JSON.stringify(route), /"q"/);
});

test("unused activation code TXT export is documented and never succeeds without administrator authentication", async () => {
  const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  const route = document.paths["/api/admin/activation-codes/export-unused"]?.post;
  assert.ok(route);
  assert.ok(route.responses[200]?.content?.["text/plain"]);
  assert.ok(route.responses[401]);
  assert.ok(route.responses[403]);
  assert.ok(route.responses[404]);

  const response = await app.request("http://localhost/api/admin/activation-codes/export-unused", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: "{}",
  });
  assert.ok([401, 503].includes(response.status));
  assert.ok(["UNAUTHORIZED", "CONFIG_REQUIRED"].includes((await response.json()).code));
});
