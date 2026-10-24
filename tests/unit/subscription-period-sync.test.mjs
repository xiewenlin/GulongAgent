import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";
import { synchronizeChandlerSubscriptionPeriod } from "../../server/subscription-period-sync.js";
import { buildProductPeriodPatch, gulongEngineEntitlement } from "../../server/english-coach-products.js";

// Synthetic records only: no files, credentials, live membership or HTTP.
const plan = "gulong_engine_monthly", now = new Date("2026-10-24T03:00:00Z");
const oldPeriod = { plan, enabled: true, currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"), status: "expired", provider: "chandler", cycle: "month" };
const newPeriod = { ...oldPeriod, currentPeriodStart: new Date("2026-10-01T00:00:00Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00Z"), status: "active" };
function fixture(initial = true) {
  const ownerId = new ObjectId(), row = { _id: new ObjectId(), ownerId, plan, ...oldPeriod, updatedAt: new Date("2026-10-23T00:00:00Z"), products: { [plan]: { ...oldPeriod } } };
  const rows = createCapabilityMemoryCollection(initial ? [row] : []);
  return { ownerId, rows, sync: (period = oldPeriod) => synchronizeChandlerSubscriptionPeriod({ ownerId, period, attributes: { synthetic: true }, applicationId: "test-app", now,
    getCollection: async name => { assert.equal(name, "subscriptions"); return rows; } }) };
}
async function adminSave(f, enabled = true) {
  const before = await f.rows.findOne({ ownerId: f.ownerId });
  const patch = buildProductPeriodPatch(before, [{ id: plan, enabled, currentPeriodStart: newPeriod.currentPeriodStart, currentPeriodEnd: newPeriod.currentPeriodEnd }],
    { provider: "admin", manualPeriodOverride: true, periodSource: "admin" }, now);
  await f.rows.updateOne({ _id: before._id }, { $set: { ...patch, updatedAt: now } });
}

test("independent admin extension survives stale remote synchronization and remains the account read authority", async () => {
  const f = fixture(); await adminSave(f);
  const before = await f.rows.findOne({ ownerId: f.ownerId });
  assert.equal(before.manualPeriodOverride, undefined, "product edit need not change the legacy root flag");
  assert.equal(gulongEngineEntitlement(before, now).active, true);
  assert.equal(await f.sync(), false);
  const after = await f.rows.findOne({ ownerId: f.ownerId });
  assert.deepEqual(after, before);
  const e = gulongEngineEntitlement(after, now); assert.equal(+e.expires_at, +newPeriod.currentPeriodEnd);
  assert.ok(e.capabilities.includes("digital_live.use"));
});

test("an explicit admin revocation cannot be revived by remote active dates", async () => {
  const f = fixture(); await adminSave(f, false);
  assert.equal(await f.sync(newPeriod), false);
  const e = gulongEngineEntitlement(await f.rows.findOne({ ownerId: f.ownerId }), now);
  assert.equal(e.active, false); assert.deepEqual(e.capabilities, []);
});

test("legacy top-level overrides remain protected while unrelated unprotected products can synchronize", async () => {
  const legacy = fixture(); legacy.rows.rows[0].manualPeriodOverride = true;
  assert.equal(await legacy.sync(newPeriod), false);
  const f = fixture(); await adminSave(f);
  assert.equal(await f.sync({ ...newPeriod, plan: "english_coach_monthly" }), true);
  const after = await f.rows.findOne({ ownerId: f.ownerId });
  assert.equal(after.products[plan].manualPeriodOverride, true);
  assert.equal(+after.products[plan].currentPeriodEnd, +newPeriod.currentPeriodEnd);
  assert.ok(after.products.english_coach_monthly);
});

test("a concurrent admin save fences stale synchronization even when timestamps coincide", async () => {
  const f = fixture(), update = f.rows.updateOne;
  f.rows.updateOne = async (filter, change, options) => {
    f.rows.updateOne = update;
    // Retain the old timestamp to prove the explicit product flag fence, not
    // timestamp luck, prevents this race.
    const stamp = f.rows.rows[0].updatedAt; await adminSave(f); f.rows.rows[0].updatedAt = stamp;
    return update(filter, change, options);
  };
  assert.equal(await f.sync(), false);
  assert.equal(gulongEngineEntitlement(await f.rows.findOne({ ownerId: f.ownerId }), now).active, true);
});

test("any concurrent subscription change aborts stale write rather than upserting or overwriting", async () => {
  const f = fixture(), update = f.rows.updateOne;
  f.rows.updateOne = async (filter, change, options) => {
    assert.equal(options?.upsert, undefined);
    f.rows.rows[0].updatedAt = new Date(+now + 1);
    return update(filter, change, options);
  };
  assert.equal(await f.sync(newPeriod), false);
  assert.equal(+f.rows.rows[0].products[plan].currentPeriodEnd, +oldPeriod.currentPeriodEnd);
});

test("first remote import inserts normally but cannot overwrite a concurrent new admin subscription", async () => {
  const fresh = fixture(false); assert.equal(await fresh.sync(newPeriod), true);
  assert.equal(gulongEngineEntitlement(fresh.rows.rows[0], now).active, true);
  const race = fixture(false), update = race.rows.updateOne;
  race.rows.updateOne = async (filter, change, options) => {
    assert.deepEqual(Object.keys(change), ["$setOnInsert"]);
    race.rows.rows.push({ _id: new ObjectId(), ownerId: race.ownerId, products: { [plan]: { ...newPeriod, manualPeriodOverride: true } } });
    return update(filter, change, options);
  };
  assert.equal(await race.sync(), false); assert.equal(race.rows.rows.length, 1);
  assert.equal(gulongEngineEntitlement(race.rows.rows[0], now).active, true);
});

test("unprotected existing product imports still work, with no fallback to a longer unrelated expiry", async () => {
  const f = fixture(); assert.equal(await f.sync(newPeriod), true);
  assert.equal(gulongEngineEntitlement(f.rows.rows[0], now).active, true);
  assert.equal(await f.sync(oldPeriod), true);
  f.rows.rows[0].currentPeriodEnd = new Date("2030-01-01T00:00:00Z");
  assert.equal(gulongEngineEntitlement(f.rows.rows[0], now).active, false);
});
