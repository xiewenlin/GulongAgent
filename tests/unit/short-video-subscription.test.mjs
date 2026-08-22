import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ObjectId } from "mongodb";
import {
  SHORT_VIDEO_MONTHLY_PRICE_FEN,
  SHORT_VIDEO_PLAN_ID,
  SHORT_VIDEO_YEARLY_PRICE_FEN,
  expireShortVideoPackageAllowance,
  isActiveShortVideoSubscription,
  reserveShortVideoPackageAllowance,
  shortVideoPackageView,
  shortVideoSubscriptionCreditFen,
  shortVideoSubscriptionPriceFen,
} from "../../server/short-video-subscription.js";

test("短视频包月使用固定月年价并按实付 100% 赠送", () => {
  assert.equal(SHORT_VIDEO_PLAN_ID, "short_video_monthly");
  assert.equal(SHORT_VIDEO_MONTHLY_PRICE_FEN, 599_900);
  assert.equal(SHORT_VIDEO_YEARLY_PRICE_FEN, 5_999_900);
  assert.equal(shortVideoSubscriptionPriceFen("month"), 599_900);
  assert.equal(shortVideoSubscriptionPriceFen("year"), 5_999_900);
  assert.equal(shortVideoSubscriptionCreditFen(599_900), 1_199_800);
});

test("短视频包月只在有效期内开放 H3 无限生成", () => {
  const now = new Date("2026-08-22T08:00:00.000Z");
  const active = { plan: SHORT_VIDEO_PLAN_ID, currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z") };
  assert.equal(isActiveShortVideoSubscription(active, now), true);
  assert.deepEqual(shortVideoPackageView(active, { shortVideoPackageBalanceFen: 321_000 }, now), {
    active: true,
    unlimitedH3: true,
    packageBalanceFen: 321_000,
    packageExpiresAt: active.currentPeriodEnd,
    chargeMode: "deduct_until_exhausted_then_free",
  });
  assert.equal(isActiveShortVideoSubscription({ ...active, currentPeriodEnd: new Date("2026-08-21T00:00:00.000Z") }, now), false);
  assert.equal(isActiveShortVideoSubscription({ ...active, status: "cancelled" }, now), false);
});

test("H3 先扣完套餐余额，余额归零后继续零扣费且不透支", async () => {
  const ownerId = new ObjectId();
  const wallet = { _id: new ObjectId(), ownerId, balanceFen: 100, shortVideoPackageBalanceFen: 100, ledgerKeys: [], ledgerEntries: [] };
  const subscription = { _id: new ObjectId(), ownerId, plan: SHORT_VIDEO_PLAN_ID, currentPeriodStart: new Date(Date.now() - 60_000), currentPeriodEnd: new Date(Date.now() + 86_400_000) };
  const ledgers = new Map();
  const collections = {
    subscriptions: { findOne: async () => subscription },
    wallets: {
      findOne: async () => wallet,
      findOneAndUpdate: async (filter, update) => {
        if (wallet.balanceFen < filter.balanceFen.$gte || wallet.shortVideoPackageBalanceFen < filter.shortVideoPackageBalanceFen.$gte || wallet.ledgerKeys.includes(filter.ledgerKeys.$ne)) return null;
        wallet.balanceFen += update.$inc.balanceFen;
        wallet.shortVideoPackageBalanceFen += update.$inc.shortVideoPackageBalanceFen;
        wallet.ledgerKeys.push(...update.$push.ledgerKeys.$each);
        wallet.ledgerEntries.push(...update.$push.ledgerEntries.$each);
        return { ...wallet };
      },
    },
    h3WalletLedger: {
      findOne: async ({ ledgerKey }) => ledgers.get(ledgerKey) || null,
      updateOne: async ({ ledgerKey }, update) => {
        const current = ledgers.get(ledgerKey) || { ...update.$setOnInsert };
        Object.assign(current, update.$set || {});
        ledgers.set(ledgerKey, current);
        return { acknowledged: true };
      },
    },
  };
  const getCollection = async (name) => collections[name];
  const charged = await reserveShortVideoPackageAllowance({ getCollection, ownerId, amountFen: 205, ledgerKey: "h3:package:first", orderNo: "FIRST", taskId: new ObjectId() });
  assert.equal(charged.matched, true);
  assert.equal(charged.chargedFen, 100);
  assert.equal(wallet.balanceFen, 0);
  assert.equal(wallet.shortVideoPackageBalanceFen, 0);
  const free = await reserveShortVideoPackageAllowance({ getCollection, ownerId, amountFen: 205, ledgerKey: "h3:package:second", orderNo: "SECOND", taskId: new ObjectId() });
  assert.equal(free.matched, true);
  assert.equal(free.chargedFen, 0);
  assert.equal(ledgers.get("h3:package:second").kind, "h3_short_video_package_no_charge");
});

test("到期只清除套餐额度，保留用户另行充值的余额", async () => {
  const ownerId = new ObjectId();
  const subscription = { _id: new ObjectId(), ownerId, plan: SHORT_VIDEO_PLAN_ID, currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z") };
  const wallet = { _id: new ObjectId(), ownerId, balanceFen: 250, shortVideoPackageBalanceFen: 200 };
  const collections = {
    subscriptions: {
      findOne: async () => subscription,
      updateOne: async (_filter, update) => { Object.assign(subscription, update.$set); return { modifiedCount: 1 }; },
    },
    wallets: {
      findOne: async () => wallet,
      updateOne: async (_filter, update) => {
        wallet.balanceFen += update.$inc.balanceFen;
        Object.assign(wallet, update.$set);
        return { modifiedCount: 1 };
      },
    },
    walletCreditLedger: { updateOne: async () => ({ acknowledged: true }) },
  };
  const result = await expireShortVideoPackageAllowance({ getCollection: async (name) => collections[name], ownerId, subscription, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.deepEqual(result, { expired: true, clearedFen: 200 });
  assert.equal(wallet.balanceFen, 50);
  assert.equal(wallet.shortVideoPackageBalanceFen, 0);
  assert.equal(subscription.status, "expired");
});

test("定价与管理员界面公开短视频包月类型，桌面接口同步套餐状态", async () => {
  const [site, pricing, admin, server, pear, css, db] = await Promise.all([
    readFile(new URL("../../src/data/site.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/pearapi.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
  ]);
  assert.match(site, /id:\s*"short_video_monthly"/);
  assert.match(site, /monthlyFen:\s*599900/);
  assert.match(site, /yearlyFen:\s*5999900/);
  assert.match(pricing, /线下申请开通/);
  assert.match(admin, /短视频包月用户/);
  assert.match(server, /shortVideoPackage:\s*shortVideoPackageView\(subscription, wallet, now\)/);
  assert.match(pear, /expireShortVideoPackageAllowance\(\{ getCollection, ownerId, subscription, now \}\)/);
  assert.match(css, /\.pricing-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(db, /subscriptions_short_video_expiry/);
});
