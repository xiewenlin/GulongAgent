import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { applyPaidPaymentEffect, paymentEffectState } from "../../server/app.js";

function payment(overrides = {}) {
  return {
    _id: new ObjectId(),
    ownerId: new ObjectId(),
    orderNo: "PAY-RECOVER-1",
    status: "paid",
    effectStatus: "pending",
    kind: "subscription",
    cycle: "month",
    provider: "wechat",
    amountFen: 2_980,
    ...overrides,
  };
}

test("legacy paid orders without an effect marker are assumed applied", async () => {
  const legacy = payment({ effectStatus: undefined });
  let collectionCalls = 0;
  assert.equal(paymentEffectState(legacy), "legacy_assumed_applied");
  const result = await applyPaidPaymentEffect(legacy, { collectionProvider: async () => { collectionCalls += 1; throw new Error("must not run"); } });
  assert.deepEqual(result, { applied: false, reason: "already_applied" });
  assert.equal(collectionCalls, 0);
});

test("a failed paid subscription effect resumes without extending the same order twice", async () => {
  const order = payment();
  const subscription = {
    ownerId: order.ownerId,
    currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    appliedPaymentOrderNos: [],
  };
  const paymentUpdates = [];
  let subscriptionWrites = 0;
  const collections = {
    payments: {
      async findOneAndUpdate(_filter, update) {
        Object.assign(order, update.$set);
        paymentUpdates.push(update);
        return { ...order };
      },
      async updateOne(_filter, update) {
        paymentUpdates.push(update);
        if (update.$set?.effectStatus) order.effectStatus = update.$set.effectStatus;
        return { modifiedCount: 1 };
      },
    },
    subscriptions: {
      async findOne() { return subscription; },
      async updateOne(_filter, update) {
        subscriptionWrites += 1;
        Object.assign(subscription, update.$set);
        if (!subscription.appliedPaymentOrderNos.includes(order.orderNo)) subscription.appliedPaymentOrderNos.push(order.orderNo);
        return { modifiedCount: 1 };
      },
    },
  };
  const collectionProvider = async (name) => collections[name];
  let credits = 0;
  const creditBalance = async () => {
    credits += 1;
    if (credits === 1) throw new Error("wallet temporarily unavailable");
    return { applied: true };
  };

  await assert.rejects(
    applyPaidPaymentEffect(order, { collectionProvider, creditBalance, notifyOnce: async () => {}, now: new Date("2026-09-01T00:00:00.000Z") }),
    /wallet temporarily unavailable/,
  );
  assert.equal(order.effectStatus, "failed");
  assert.equal(subscription.currentPeriodEnd.toISOString(), "2026-11-01T00:00:00.000Z");

  const resumed = await applyPaidPaymentEffect(order, { collectionProvider, creditBalance, notifyOnce: async () => {}, now: new Date("2026-09-01T00:01:00.000Z") });
  assert.deepEqual(resumed, { applied: true });
  assert.equal(subscriptionWrites, 1);
  assert.equal(subscription.currentPeriodEnd.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(credits, 2);
  assert.equal(order.effectStatus, "applied");
  assert.ok(paymentUpdates.some((update) => update.$set?.effectStatus === "failed"));
  assert.ok(paymentUpdates.some((update) => update.$set?.effectStatus === "applied"));
});

test("replayed recharge effects rely on the wallet credit key and finish safely", async () => {
  const order = payment({ kind: "recharge", orderNo: "PAY-RECHARGE-1" });
  const creditedKeys = new Set();
  let balanceFen = 0;
  const payments = {
    async findOneAndUpdate(_filter, update) { Object.assign(order, update.$set); return { ...order }; },
    async updateOne(_filter, update) { order.effectStatus = update.$set?.effectStatus || order.effectStatus; return { modifiedCount: 1 }; },
  };
  const creditBalance = async ({ sourceId, amountFen }) => {
    if (!creditedKeys.has(sourceId)) { creditedKeys.add(sourceId); balanceFen += amountFen; }
    return { applied: true };
  };
  const options = { collectionProvider: async () => payments, creditBalance };
  await applyPaidPaymentEffect(order, options);
  order.effectStatus = "failed";
  await applyPaidPaymentEffect(order, options);
  assert.equal(balanceFen, order.amountFen);
  assert.deepEqual([...creditedKeys], [order.orderNo]);
});

test("concurrent paid callbacks grant one effect lease and only one extends the subscription", async () => {
  const order = payment({ orderNo: "PAY-CONCURRENT-1" });
  const subscription = { ownerId: order.ownerId, currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"), appliedPaymentOrderNos: [] };
  let leaseClaimed = false;
  let subscriptionWrites = 0;
  let releaseCredit;
  const creditGate = new Promise((resolve) => { releaseCredit = resolve; });
  const payments = {
    async findOneAndUpdate(_filter, update) {
      if (leaseClaimed) return null;
      leaseClaimed = true;
      Object.assign(order, update.$set);
      return { ...order };
    },
    async updateOne() { return { modifiedCount: 1 }; },
  };
  const subscriptions = {
    async findOne() { return subscription; },
    async updateOne(_filter, update) {
      subscriptionWrites += 1;
      Object.assign(subscription, update.$set);
      subscription.appliedPaymentOrderNos.push(order.orderNo);
      return { modifiedCount: 1 };
    },
  };
  const options = {
    collectionProvider: async (name) => name === "payments" ? payments : subscriptions,
    creditBalance: async () => { await creditGate; return { applied: true }; },
    notifyOnce: async () => {},
    now: new Date("2026-09-15T00:00:00Z"),
  };
  const first = applyPaidPaymentEffect({ ...order }, options);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await applyPaidPaymentEffect({ ...order, effectStatus: "applying" }, options);
  assert.deepEqual(second, { applied: false, reason: "in_progress" });
  releaseCredit();
  assert.deepEqual(await first, { applied: true });
  assert.equal(subscriptionWrites, 1);
  assert.equal(subscription.currentPeriodEnd.toISOString(), "2026-11-01T00:00:00.000Z");
});
