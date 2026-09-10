import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  billingOrderResponse,
  billingReplayConflict,
  billingRequestFingerprint,
  billingRequestKey,
  reconcileBillingOrderRequest,
} from "../../server/app.js";

test("billing request keys accept headers and clientOrderNo with stable validation", () => {
  assert.equal(billingRequestKey("web:checkout:123", "ignored-client-key"), "web:checkout:123");
  assert.equal(billingRequestKey(null, "desktop-order-123"), "desktop-order-123");
  assert.equal(billingRequestKey(null, null), null);
  assert.equal(billingRequestKey("short", null), false);
  assert.equal(billingRequestKey("contains spaces", null), false);
});

test("billing fingerprints normalize irrelevant fields and bind material payment fields", () => {
  const base = { kind: "subscription", provider: "wechat", cycle: "month", subscriptionPlan: "member", amountFen: 2_980 };
  assert.equal(billingRequestFingerprint(base), billingRequestFingerprint({ ...base, taskId: "ignored" }));
  assert.notEqual(billingRequestFingerprint(base), billingRequestFingerprint({ ...base, cycle: "year" }));
  assert.notEqual(billingRequestFingerprint(base), billingRequestFingerprint({ ...base, provider: "offline" }));
  assert.equal(billingRequestFingerprint(base), billingRequestFingerprint({ ...base, amountFen: 3_980 }));
  const recharge = { kind: "recharge", provider: "wechat", cycle: null, subscriptionPlan: "member", amountFen: 50_000 };
  assert.notEqual(billingRequestFingerprint(recharge), billingRequestFingerprint({ ...recharge, amountFen: 60_000 }));
  const worker = { kind: "worker_task", provider: "wechat", cycle: null, subscriptionPlan: "member", amountFen: 10_000, taskId: "task-a" };
  assert.notEqual(billingRequestFingerprint(worker), billingRequestFingerprint({ ...worker, taskId: "task-b" }));
});

test("same key and fingerprint replays one online or offline order while changed payload conflicts", () => {
  const fingerprint = billingRequestFingerprint({ kind: "recharge", provider: "wechat", cycle: null, subscriptionPlan: "member", amountFen: 50_000 });
  const online = { orderNo: "GL-ONE", status: "pending", provider: "wechat", kind: "recharge", amountFen: 50_000, creditedFen: 55_000, requestFingerprint: fingerprint };
  assert.equal(billingReplayConflict(online, fingerprint), false);
  assert.equal(billingReplayConflict(online, `${fingerprint.slice(0, -1)}0`), true);
  assert.deepEqual(billingOrderResponse(online).orderNo, "GL-ONE");
  const offline = { ...online, _id: { toString: () => "offline-id" }, orderNo: "GL-OFFLINE", subscriptionPlan: "member", status: "pending" };
  const replay = billingOrderResponse(offline, { offline: true });
  assert.equal(replay.id, "offline-id");
  assert.equal(replay.orderNo, "GL-OFFLINE");
  assert.equal(replay.status, "pending_review");
  assert.equal(replay.idempotent, true);
});

test("billing route durably claims keyed orders before either remote create call", async () => {
  const source = await readFile(new URL("../../server/app.js", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('app.post("/api/billing/orders"'), source.indexOf("function paymentEffectState"));
  const offlineClaim = route.indexOf("result = await targetOrders.insertOne(offlineDocument)");
  const offlineRemote = route.indexOf("const mirrored = await createDirectPaymentOrder");
  const onlineClaim = route.indexOf("const inserted = await targetOrders.insertOne(reservation)");
  const onlineRemote = route.indexOf("result = await createSubscriptionCheckout");
  const globalClaim = route.indexOf("const inserted = await requests.insertOne(journal)");
  assert.ok(globalClaim > 0 && globalClaim < offlineClaim && globalClaim < onlineClaim);
  assert.ok(offlineClaim > 0 && offlineClaim < offlineRemote);
  assert.ok(onlineClaim > 0 && onlineClaim < onlineRemote);
  assert.match(route, /IDEMPOTENCY_KEY_CONFLICT/);
  assert.match(route, /billingRequestKey: requestKey/);
  assert.match(route, /billingJournal = await requests\.findOneAndUpdate/);
  assert.match(route, /orderNo, merchantOrderNo: orderNo/);
  const restoreMerchant = route.indexOf("orderNo = billingJournal.orderNo");
  assert.ok(restoreMerchant > globalClaim && restoreMerchant < onlineRemote);
  assert.match(route, /amountFen = billingJournal\.amountFen/);

  const dbSource = await readFile(new URL("../../server/db.js", import.meta.url), "utf8");
  assert.match(dbSource, /\{ ownerId: 1, billingRequestKey: 1 \}/);
  assert.match(dbSource, /uniq_payment_owner_billing_request/);
  assert.match(dbSource, /uniq_offline_payment_owner_billing_request/);
  assert.match(dbSource, /uniq_billing_order_request_owner_key/);
});

test("global journal makes a provider change conflict before a second collection or remote side effect", () => {
  const offline = billingRequestFingerprint({ kind: "subscription", provider: "offline", cycle: "month", subscriptionPlan: "member", amountFen: 2_980 });
  const wechat = billingRequestFingerprint({ kind: "subscription", provider: "wechat", cycle: "month", subscriptionPlan: "member", amountFen: 2_980 });
  const journal = { ownerId: "owner-1", requestKey: "same-key-123", requestFingerprint: offline, provider: "offline" };
  assert.equal(billingReplayConflict(journal, offline), false);
  assert.equal(billingReplayConflict(journal, wechat), true);
});

test("processing journal safely reconciles the original merchant order and becomes final", async () => {
  const journal = {
    _id: "journal-1", ownerId: "owner-1", requestKey: "recover-key-123", requestFingerprint: "fingerprint",
    orderNo: "MERCHANT-ONE", provider: "wechat", kind: "recharge", cycle: null, amountFen: 50_000,
    promotionBonusFen: 5_000, creditedFen: 55_000, status: "processing", createdAt: new Date("2026-09-01T00:00:00Z"),
  };
  let remoteReads = 0;
  let storedPayment = null;
  let journalStatus = journal.status;
  const collections = {
    payments: {
      async updateOne(_filter, update) { storedPayment = { ...(storedPayment || {}), ...update.$set }; return { modifiedCount: 1, upsertedCount: storedPayment ? 0 : 1 }; },
      async findOne() { return storedPayment; },
    },
    billingOrderRequests: {
      async updateOne(_filter, update) { journalStatus = update.$set.status; return { modifiedCount: 1 }; },
    },
  };
  const result = await reconcileBillingOrderRequest(journal, {
    collectionProvider: async (name) => collections[name],
    fetchRemoteOrder: async (orderNo) => { remoteReads += 1; assert.equal(orderNo, "MERCHANT-ONE"); return { platform_order_no: "PLATFORM-ONE", status: "pending", code_url: "weixin://wxpay/bizpayurl?pr=test" }; },
  });
  assert.equal(remoteReads, 1);
  assert.equal(storedPayment.merchantOrderNo, "MERCHANT-ONE");
  assert.equal(storedPayment.orderNo, "PLATFORM-ONE");
  assert.equal(journalStatus, "final");
  assert.equal(result.status, 200);
  assert.equal(result.response.orderNo, "PLATFORM-ONE");
  assert.match(result.response.qrCodeDataUrl, /^data:image\/png;base64,/);
});

test("subscription intent fingerprint survives authoritative price drift and journal keeps the first price", () => {
  const firstIntent = { kind: "subscription", provider: "wechat", cycle: "year", subscriptionPlan: "member", amountFen: 29_800 };
  const retriedIntent = { ...firstIntent, amountFen: 39_800 };
  assert.equal(billingRequestFingerprint(firstIntent), billingRequestFingerprint(retriedIntent));
  const journal = { requestFingerprint: billingRequestFingerprint(firstIntent), amountFen: 29_800, orderNo: "ORIGINAL-MERCHANT" };
  assert.equal(billingReplayConflict(journal, billingRequestFingerprint(retriedIntent)), false);
  assert.equal(journal.amountFen, 29_800);
  assert.equal(journal.orderNo, "ORIGINAL-MERCHANT");
});

test("uncertain processing result becomes retryable failed_unknown, never a permanent 202", async () => {
  const journal = { _id: "journal-2", ownerId: "owner-1", requestKey: "unknown-key-123", requestFingerprint: "fp", orderNo: "MERCHANT-TWO", provider: "wechat", kind: "recharge", amountFen: 100, status: "processing" };
  let writtenStatus = null;
  const result = await reconcileBillingOrderRequest(journal, {
    collectionProvider: async () => ({ async updateOne(_filter, update) { writtenStatus = update.$set.status; return { modifiedCount: 1 }; } }),
    fetchRemoteOrder: async () => { throw new Error("timeout"); },
  });
  assert.equal(writtenStatus, "failed_unknown");
  assert.equal(result.error.status, 503);
  assert.equal(result.error.code, "BILLING_ORDER_OUTCOME_UNKNOWN");
  assert.equal(result.error.orderNo, "MERCHANT-TWO");
  assert.equal(result.error.retryable, true);
});
