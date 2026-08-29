import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import app, {
  ACTIVATION_PRODUCT_DEFAULT,
  ACTIVATION_PRODUCT_SUPER_VIDEO,
  HARDWARE_COMPONENT_WEIGHTS,
  assertLegacyActivationRecoveryEligible,
  activationHardwareBindingAction,
  activationProductsCompatible,
  activationReceiptPayload,
  activationSearchConditions,
  activationSigningPrivateKey,
  parseActivationHardwareBindingV2,
  parseLegacyActivationRecovery,
  persistActivationHardwareBindingV2,
  recoverLegacyActivationHardwareV2,
  signActivationReceipt,
} from "../../server/app.js";
import { readActivationCodeSecret, sealActivationCodeSecret, sealUserSecret } from "../../server/security.js";

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

test("legacy OS reinstall recovery requires explicit mode, strong anchors, and matching historical MAC", () => {
  assert.equal(parseLegacyActivationRecovery({}), null);
  assert.deepEqual(parseLegacyActivationRecovery({ legacyRecovery: { mode: "os_reinstall" } }), { mode: "os_reinstall" });
  assert.throws(
    () => parseLegacyActivationRecovery({ legacyRecovery: { mode: "replace_hardware" } }),
    (error) => error.code === "INVALID_LEGACY_RECOVERY_REQUEST" && error.status === 400,
  );

  const record = {
    status: "used",
    deviceId: "a".repeat(64),
    macHint: "A1:B2:C3",
  };
  const strongBinding = parseActivationHardwareBindingV2(hardwareV2());
  assert.deepEqual(
    assertLegacyActivationRecoveryEligible(record, strongBinding, "AA-A1-B2-C3"),
    { primaryScore: 52, historicalMacTail: "A1B2C3", incomingMacTail: "A1B2C3" },
  );
  assert.throws(
    () => assertLegacyActivationRecoveryEligible(record, strongBinding, "D4E5F6"),
    (error) => error.code === "LEGACY_RECOVERY_MAC_MISMATCH" && error.status === 409,
  );
  assert.throws(
    () => assertLegacyActivationRecoveryEligible(record, { ...strongBinding, fingerprintConfidence: "medium" }, "A1B2C3"),
    (error) => error.code === "LEGACY_RECOVERY_EVIDENCE_INSUFFICIENT" && error.status === 409,
  );
  assert.throws(
    () => assertLegacyActivationRecoveryEligible({ ...record, hardwareBindingV2: strongBinding }, strongBinding, "A1B2C3"),
    (error) => error.code === "LEGACY_RECOVERY_NOT_APPLICABLE" && error.status === 409,
  );
});

test("legacy OS reinstall recovery raises thresholds without historical MAC", () => {
  const insufficient = parseActivationHardwareBindingV2(hardwareV2());
  assert.throws(
    () => assertLegacyActivationRecoveryEligible({ status: "used", deviceId: "a".repeat(64) }, insufficient, "A1B2C3"),
    (error) => error.code === "LEGACY_RECOVERY_EVIDENCE_INSUFFICIENT" && error.status === 409,
  );
  const stronger = parseActivationHardwareBindingV2(hardwareV2({
    hardwareScore: 64,
    bindingScore: 85,
    identityComponents: ["systemUuid", "baseboardSerial", "biosSerial"],
    hardwareComponentDigests: {
      systemUuid: "4".repeat(64),
      baseboardSerial: "5".repeat(64),
      biosSerial: "6".repeat(64),
    },
  }));
  assert.deepEqual(
    assertLegacyActivationRecoveryEligible({ status: "used", deviceId: "a".repeat(64) }, stronger, "A1B2C3"),
    { primaryScore: 64, historicalMacTail: "", incomingMacTail: "A1B2C3" },
  );
});

test("legacy OS reinstall recovery atomically binds v2 once without changing activation time", async () => {
  const activatedAt = new Date("2026-08-18T03:04:05.000Z");
  let stored = {
    _id: "license-recovery",
    codeHash: "code-hash",
    status: "used",
    product: ACTIVATION_PRODUCT_DEFAULT,
    deviceId: "a".repeat(64),
    deviceName: "OLD-PC",
    macHint: "A1B2C3",
    activatedAt,
  };
  let writes = 0;
  const collection = {
    async findOneAndUpdate(filter, update) {
      assert.equal(filter.deviceId, "a".repeat(64));
      assert.equal(filter.codeHash, "code-hash");
      assert.deepEqual(filter["hardwareBindingV2.hardwareHash"], { $exists: false });
      assert.equal(Object.hasOwn(update.$set, "activatedAt"), false);
      assert.equal(Object.hasOwn(update, "$inc"), false);
      writes += 1;
      stored = { ...stored, ...update.$set };
      return stored;
    },
    async findOne() { return stored; },
  };
  const incoming = parseActivationHardwareBindingV2(hardwareV2());
  const first = await recoverLegacyActivationHardwareV2(collection, stored, {
    deviceId: "b".repeat(64),
    deviceName: "REINSTALLED-PC",
    macHint: "A1B2C3",
    incomingBinding: incoming,
    now: new Date("2026-08-30T00:00:00.000Z"),
  });
  assert.equal(first.recovered, true);
  assert.equal(writes, 1);
  assert.equal(first.record.activatedAt, activatedAt);
  assert.equal(first.record.deviceId, "b".repeat(64));
  assert.equal(first.record.hardwareBindingV2.hardwareHash, incoming.hardwareHash);
  assert.equal(first.record.legacyRecovery.mode, "os_reinstall");
  assert.notEqual(first.record.legacyRecovery.previousDeviceIdHash, "a".repeat(64));
});

test("hardware parser rejects raw evidence while redeem prioritizes product mismatch", async () => {
  assert.throws(
    () => parseActivationHardwareBindingV2({
      code: "H3-ABCDE-FGHJK-MNPQR-STUVW",
      product: ACTIVATION_PRODUCT_DEFAULT,
      deviceId: "a".repeat(64),
      ...hardwareV2(),
      systemUuid: "RAW-SMBIOS-VALUE",
    }),
    (error) => error.code === "RAW_HARDWARE_EVIDENCE_REJECTED" && error.status === 400,
  );
  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  const routeSource = source.slice(source.indexOf('app.post("/api/licenses/redeem"'), source.indexOf('app.get("/api/admin/activation-codes"'));
  assert.ok(routeSource.indexOf("ACTIVATION_PRODUCT_MISMATCH") < routeSource.indexOf("parseActivationHardwareBindingV2(body)"));
});

test("public redeem validation is uncached and documented without bearer authentication", async () => {
  const response = await app.request("http://localhost/api/licenses/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "bad-code", deviceId: "bad-device" }),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(await response.json(), { code: "INVALID_ACTIVATION_CODE", message: "激活码格式不正确" });

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
  assert.match(contract, /minimax-h3-ultra-video/);
  assert.match(contract, /minimax-h3-super-video/);
  assert.match(contract, /legacyRecovery/);
  assert.match(contract, /os_reinstall/);
  assert.match(contract, /LEGACY_LICENSE_RECOVERED/);
});

test("independent video products reject cross-product activation before hardware validation", async () => {
  assert.equal(activationProductsCompatible(ACTIVATION_PRODUCT_DEFAULT, ACTIVATION_PRODUCT_DEFAULT), true);
  assert.equal(activationProductsCompatible(ACTIVATION_PRODUCT_SUPER_VIDEO, ACTIVATION_PRODUCT_SUPER_VIDEO), true);
  assert.equal(activationProductsCompatible("minimax-h3-universal", ACTIVATION_PRODUCT_DEFAULT), true);
  assert.equal(activationProductsCompatible(ACTIVATION_PRODUCT_DEFAULT, ACTIVATION_PRODUCT_SUPER_VIDEO), false);
  assert.equal(activationProductsCompatible(ACTIVATION_PRODUCT_SUPER_VIDEO, ACTIVATION_PRODUCT_DEFAULT), false);

  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  const routeSource = source.slice(source.indexOf('app.post("/api/licenses/redeem"'), source.indexOf('app.get("/api/admin/activation-codes"'));
  assert.ok(routeSource.indexOf("ACTIVATION_PRODUCT_MISMATCH") < routeSource.indexOf("parseActivationHardwareBindingV2(body)"));
  assert.match(routeSource, /两款产品的授权彼此独立，激活码不能混用；请购买/);
  assert.match(routeSource, /的新激活码后重试/);
});

test("activation-code encryption has a dedicated cross-deployment key and legacy fallback", () => {
  const previousDedicated = process.env.ACTIVATION_CODE_ENCRYPTION_KEY;
  const previousSession = process.env.SESSION_SECRET;
  try {
    process.env.ACTIVATION_CODE_ENCRYPTION_KEY = "activation-key-shared-by-both-production-targets";
    process.env.SESSION_SECRET = "legacy-session-key-for-test";
    const sealed = sealActivationCodeSecret("H3-ABCDE-FGHJK-MNPQR-STUVW");
    assert.equal(readActivationCodeSecret(sealed), "H3-ABCDE-FGHJK-MNPQR-STUVW");

    const legacySealed = sealUserSecret("H3-BCDEF-GHJKM-NPQRS-TUVWX", "activation-code");
    delete process.env.ACTIVATION_CODE_ENCRYPTION_KEY;
    assert.equal(readActivationCodeSecret(legacySealed), "H3-BCDEF-GHJKM-NPQRS-TUVWX");
  } finally {
    if (previousDedicated === undefined) delete process.env.ACTIVATION_CODE_ENCRYPTION_KEY;
    else process.env.ACTIVATION_CODE_ENCRYPTION_KEY = previousDedicated;
    if (previousSession === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSession;
  }
});

test("administrator activation copy stays enabled for used codes and rotates unreadable bound codes only after confirmation", async () => {
  const [adminSource, serverSource] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /disabled=\{Boolean\(busy\)\} onClick=\{\(\) => copyCode\(item\)\}/);
  assert.match(adminSource, /\/api\/admin\/activation-codes\/\$\{item\.id\}\/copy/);
  assert.match(adminSource, /ACTIVATION_BOUND_CODE_ROTATION_REQUIRED/);
  assert.match(adminSource, /\/api\/admin\/activation-codes\/\$\{item\.id\}\/rotate-bound-code/);
  assert.match(adminSource, /确认换发并复制/);
  assert.match(adminSource, /document\.execCommand\("copy"\)/);
  assert.match(serverSource, /\/api\/admin\/activation-codes\/:id\/copy/);
  assert.match(serverSource, /action: "admin_activation_code_copied"/);
  assert.match(serverSource, /ACTIVATION_BOUND_CODE_ROTATION_REQUIRED/);
  assert.match(serverSource, /\/api\/admin\/activation-codes\/:id\/rotate-bound-code/);
  assert.match(serverSource, /\{ _id: existing\._id, status: "used", deviceId: existing\.deviceId, codeHash: existing\.codeHash \}/);
  assert.match(serverSource, /codeEncrypted: sealActivationCodeSecret\(replacement\)/);
});

test("activation management keeps full codes and copy actions on one line", async () => {
  const [adminSource, cssSource] = await Promise.all([
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(adminSource, /ACTIVATION_PRODUCT_OPTIONS/);
  assert.match(adminSource, /MiniMax H3 超清视频/);
  assert.match(adminSource, /越狱视频-MiniMax H3 超能视频/);
  assert.match(cssSource, /grid-template-columns: minmax\(350px, 1\.5fr\)/);
  assert.match(cssSource, /\.activation-row-actions \{[^}]+flex-wrap: nowrap/);
  assert.match(cssSource, /\.activation-row-actions \.button \{[^}]+white-space: nowrap/);
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
