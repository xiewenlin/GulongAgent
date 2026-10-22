import test from "node:test";
import assert from "node:assert/strict";
import {
  BIRTHDAY_ARTWORK_PROMPT, birthdayArtworkCanStartNew, birthdayArtworkImage,
  birthdayArtworkDefiniteNoOrder, birthdayArtworkNodeReady, birthdayArtworkPrice, birthdayArtworkStorageKey,
  readBirthdayArtworkRecord,
} from "../../shared/birthday-artwork.js";

const pending = {
  version: 1, ownerId: "owner-1", wallId: "wall-1", prompt: BIRTHDAY_ARTWORK_PROMPT,
  quoteReq: "quote-request-001", taskReq: "task-request-001",
  quoteId: "507f1f77bcf86cd799439011", taskId: null, submitted: true, status: "submitting",
};

test("birthday artwork recovery retains original uncertain-submit identifiers and never allows a fresh order", () => {
  const recovered = readBirthdayArtworkRecord(JSON.stringify(pending), "owner-1", "wall-1");
  assert.deepEqual(recovered, pending);
  assert.equal(birthdayArtworkCanStartNew(recovered), false);
  for (const status of [null, "quoted", "submitting", "queued", "claimed", "processing"]) {
    assert.equal(birthdayArtworkCanStartNew({ ...pending, status }), false);
  }
  for (const status of ["completed", "failed", "cancelled", "rejected"]) {
    assert.equal(birthdayArtworkCanStartNew({ ...pending, status }), true);
  }
});

test("birthday artwork recovery is account-and-wall-scoped, rejects corruption and never retains images or tokens", () => {
  const value = readBirthdayArtworkRecord(JSON.stringify({ ...pending, image: "data:image/png;base64,abc", token: "secret" }), "owner-1", "wall-1");
  assert.equal(value.image, undefined);
  assert.equal(value.token, undefined);
  assert.throws(() => readBirthdayArtworkRecord(JSON.stringify(pending), "owner-2", "wall-1"));
  assert.throws(() => readBirthdayArtworkRecord(JSON.stringify(pending), "owner-1", "wall-2"));
  assert.throws(() => readBirthdayArtworkRecord(JSON.stringify(pending), "owner-1", ""));
  assert.throws(() => readBirthdayArtworkRecord("{broken", "owner-1", "wall-1"));
  assert.throws(() => readBirthdayArtworkRecord(JSON.stringify({ ...pending, quoteId: null }), "owner-1", "wall-1"));
  assert.throws(() => readBirthdayArtworkRecord(JSON.stringify({ ...pending, prompt: "some private blessing" }), "owner-1", "wall-1"));
  assert.notEqual(birthdayArtworkStorageKey("owner-1", "wall-1"), birthdayArtworkStorageKey("owner-2", "wall-1"));
  assert.notEqual(birthdayArtworkStorageKey("owner-1", "wall-1"), birthdayArtworkStorageKey("owner-1", "wall-2"));
});

test("birthday artwork renews a quote only on exact server no-order rejections", () => {
  for (const code of ["QUOTE_EXPIRED", "QUOTE_AUTHORIZATION_CHANGED"]) assert.equal(birthdayArtworkDefiniteNoOrder({ status: 409, code }), true);
  for (const error of [
    { status: 409, code: "QUOTE_ALREADY_USED" }, { status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" },
    { status: 500, code: "QUOTE_EXPIRED" }, { status: 0, code: "NETWORK_ERROR" }, { status: 503, code: "CODEX_MARKET_ERROR" },
  ]) assert.equal(birthdayArtworkDefiniteNoOrder(error), false);
});

test("birthday artwork requires a ready compatible node, not the marketplace's broad available flag", () => {
  const models = (status, count, available = true) => ({ models: [{ id: "longtu", available, availability: { status, compatibleNodeCount: count } }] });
  assert.equal(birthdayArtworkNodeReady(models("offline", 0)), false);
  assert.equal(birthdayArtworkNodeReady(models("ready", 0)), false);
  assert.equal(birthdayArtworkNodeReady(models("ready", 1, false)), false);
  assert.equal(birthdayArtworkNodeReady(models("ready", 1)), true);
});

test("birthday artwork prices use authoritative integer milliyuan, never rounded legacy fen", () => {
  assert.equal(birthdayArtworkPrice({ chargedMilliYuan: 182, chargedFen: 19 }), "¥0.182");
  assert.equal(birthdayArtworkPrice({ chargedMilliYuan: 0, chargedFen: 19 }), "本次免费");
  assert.equal(birthdayArtworkPrice({ chargedMilliYuan: 1200 }), "¥1.2");
  for (const amount of [-1, 0.1, "182", null, undefined, NaN]) assert.throws(() => birthdayArtworkPrice({ chargedMilliYuan: amount }));
});

test("birthday artwork only accepts bounded embedded completed image results", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(birthdayArtworkImage({ status: "completed", result: { images: [{ dataUrl }] } }), dataUrl);
  assert.equal(birthdayArtworkImage({ status: "queued" }), null);
  for (const value of ["https://untrusted.example/image.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64," + "A".repeat(3_400_000)]) {
    assert.throws(() => birthdayArtworkImage({ status: "completed", result: { images: [{ dataUrl: value }] } }));
  }
});
