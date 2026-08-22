export const SHORT_VIDEO_PLAN_ID = "short_video_monthly";
export const SHORT_VIDEO_PLAN_NAME = "短视频包月";
export const SHORT_VIDEO_MONTHLY_PRICE_FEN = 599_900;
export const SHORT_VIDEO_YEARLY_PRICE_FEN = 5_999_900;

function safeFen(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function sameOwner(left, right) {
  return (left?.toString?.() || String(left || "")) === (right?.toString?.() || String(right || ""));
}

export function shortVideoSubscriptionPriceFen(cycle) {
  return cycle === "year" ? SHORT_VIDEO_YEARLY_PRICE_FEN : SHORT_VIDEO_MONTHLY_PRICE_FEN;
}

export function shortVideoSubscriptionCreditFen(amountFen) {
  return safeFen(amountFen) * 2;
}

export function isActiveShortVideoSubscription(subscription, now = new Date()) {
  if (subscription?.plan !== SHORT_VIDEO_PLAN_ID) return false;
  if (["cancelled", "canceled", "expired"].includes(String(subscription.status || "").toLowerCase())) return false;
  const start = subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : null;
  const end = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  return Boolean(
    end
    && !Number.isNaN(end.getTime())
    && end > now
    && (!start || (!Number.isNaN(start.getTime()) && start <= now)),
  );
}

export function shortVideoPackageView(subscription, wallet, now = new Date()) {
  const active = isActiveShortVideoSubscription(subscription, now);
  return {
    active,
    unlimitedH3: active,
    packageBalanceFen: active ? safeFen(wallet?.shortVideoPackageBalanceFen) : 0,
    packageExpiresAt: subscription?.plan === SHORT_VIDEO_PLAN_ID && subscription.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd)
      : null,
    chargeMode: "deduct_until_exhausted_then_free",
  };
}

export async function creditShortVideoSubscriptionBalance({
  getCollection,
  ownerId,
  amountFen,
  source,
  sourceId,
  expiresAt,
}) {
  const paidFen = safeFen(amountFen);
  const creditedFen = shortVideoSubscriptionCreditFen(paidFen);
  const expiry = new Date(expiresAt);
  if (!ownerId || !sourceId || !creditedFen || Number.isNaN(expiry.getTime())) {
    return { applied: false, reason: "invalid", paidFen, bonusFen: paidFen, creditedFen };
  }
  const key = `${source}:${sourceId}`;
  const now = new Date();
  const wallets = await getCollection("wallets");
  const ledgers = await getCollection("walletCreditLedger");
  const credit = { key, kind: "short_video_subscription", amountFen: creditedFen, paidFen, bonusFen: paidFen, expiresAt: expiry, createdAt: now };
  await ledgers.updateOne(
    { creditKey: key },
    { $setOnInsert: { creditKey: key, ownerId, source, sourceId, kind: "short_video_subscription", amountFen: creditedFen, paidFen, bonusFen: paidFen, expiresAt: expiry, status: "pending", createdAt: now }, $set: { updatedAt: now } },
    { upsert: true },
  );
  const ledger = await ledgers.findOne({ creditKey: key });
  if (!ledger || !sameOwner(ledger.ownerId, ownerId) || safeFen(ledger.amountFen) !== creditedFen || ledger.kind !== "short_video_subscription") {
    throw Object.assign(new Error("短视频包月额度流水内容冲突"), { code: "SHORT_VIDEO_CREDIT_CONFLICT", status: 409 });
  }
  const existing = await wallets.findOne({ ownerId });
  if (existing?.credits?.some((item) => item.key === key)) {
    await ledgers.updateOne({ creditKey: key }, { $set: { status: "settled", settledAt: ledger.settledAt || now, updatedAt: now } });
    return { applied: false, reason: "already_applied", paidFen, bonusFen: paidFen, creditedFen };
  }
  const update = {
    $inc: { balanceFen: creditedFen, shortVideoPackageBalanceFen: creditedFen },
    $push: { credits: credit },
    $set: { shortVideoPackageExpiresAt: expiry, shortVideoPackagePlan: SHORT_VIDEO_PLAN_ID, updatedAt: now },
  };
  let applied = false;
  if (existing) {
    const changed = await wallets.updateOne({ _id: existing._id, "credits.key": { $ne: key } }, update);
    applied = Boolean(changed.modifiedCount);
  } else {
    try {
      const inserted = await wallets.insertOne({ ownerId, balanceFen: creditedFen, shortVideoPackageBalanceFen: creditedFen, shortVideoPackageExpiresAt: expiry, shortVideoPackagePlan: SHORT_VIDEO_PLAN_ID, credits: [credit], createdAt: now, updatedAt: now });
      applied = Boolean(inserted.insertedId);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const changed = await wallets.updateOne({ ownerId, "credits.key": { $ne: key } }, update);
      applied = Boolean(changed.modifiedCount);
    }
  }
  const confirmed = applied || await wallets.findOne({ ownerId, "credits.key": key }, { projection: { _id: 1 } });
  if (!confirmed) throw Object.assign(new Error("短视频包月额度入账状态冲突"), { code: "SHORT_VIDEO_WALLET_CONFLICT", status: 409 });
  await ledgers.updateOne({ creditKey: key }, { $set: { status: "settled", settledAt: now, updatedAt: now } });
  return { applied, paidFen, bonusFen: paidFen, creditedFen };
}

export async function expireShortVideoPackageAllowance({ getCollection, ownerId, subscription = null, now = new Date(), force = false }) {
  const subscriptions = await getCollection("subscriptions");
  const currentSubscription = subscription || await subscriptions.findOne({ ownerId });
  if (!currentSubscription || currentSubscription.plan !== SHORT_VIDEO_PLAN_ID) return { expired: false, clearedFen: 0 };
  if (!force && currentSubscription.allowanceExpiredAt) return { expired: true, clearedFen: safeFen(currentSubscription.allowanceClearedFen) };
  const expiresAt = currentSubscription.currentPeriodEnd ? new Date(currentSubscription.currentPeriodEnd) : null;
  if (!force && (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt > now)) return { expired: false, clearedFen: 0 };
  const wallets = await getCollection("wallets");
  let clearedFen = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wallet = await wallets.findOne({ ownerId });
    const packageFen = safeFen(wallet?.shortVideoPackageBalanceFen);
    if (!packageFen) break;
    const balanceFen = safeFen(wallet?.balanceFen);
    const removableFen = Math.min(packageFen, balanceFen);
    const changed = await wallets.updateOne(
      { _id: wallet._id, shortVideoPackageBalanceFen: packageFen, balanceFen },
      { $inc: { balanceFen: -removableFen }, $set: { shortVideoPackageBalanceFen: 0, shortVideoPackageExpiredAt: now, updatedAt: now } },
    );
    if (changed.modifiedCount) { clearedFen = removableFen; break; }
  }
  const expiryKey = `short_video_expiry:${currentSubscription._id}:${expiresAt?.getTime?.() || "manual"}`;
  await (await getCollection("walletCreditLedger")).updateOne(
    { creditKey: expiryKey },
    { $setOnInsert: { creditKey: expiryKey, ownerId, source: "short_video_expiry", sourceId: currentSubscription._id?.toString?.() || "subscription", kind: "short_video_package_expiry", amountFen: -clearedFen, expiresAt, status: "settled", createdAt: now }, $set: { clearedFen, settledAt: now, updatedAt: now } },
    { upsert: true },
  );
  await subscriptions.updateOne(
    { _id: currentSubscription._id },
    { $set: { allowanceExpiredAt: now, allowanceClearedFen: clearedFen, ...(force ? {} : { status: "expired", autoRenew: false, statusEvaluatedAt: now }), updatedAt: now } },
  );
  return { expired: true, clearedFen };
}

export async function reserveShortVideoPackageAllowance({ getCollection, ownerId, amountFen, ledgerKey, orderNo, taskId, now = new Date() }) {
  const subscription = await (await getCollection("subscriptions")).findOne({ ownerId });
  if (!isActiveShortVideoSubscription(subscription, now)) {
    if (subscription?.plan === SHORT_VIDEO_PLAN_ID) await expireShortVideoPackageAllowance({ getCollection, ownerId, subscription, now });
    return { matched: false };
  }
  const wallets = await getCollection("wallets");
  const ledgers = await getCollection("h3WalletLedger");
  const existingLedger = await ledgers.findOne({ ledgerKey });
  if (existingLedger) {
    const chargedFen = Math.max(0, -Number(existingLedger.amountFen || 0));
    const wallet = await wallets.findOne({ ownerId });
    return { matched: true, chargedFen, wallet, idempotent: true, subscription };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wallet = await wallets.findOne({ ownerId });
    const packageFen = safeFen(wallet?.shortVideoPackageBalanceFen);
    if (!packageFen) {
      await ledgers.updateOne(
        { ledgerKey },
        { $setOnInsert: { ledgerKey, ownerId, taskId, orderNo, kind: "h3_short_video_package_no_charge", amountFen: 0, status: "not_charged", reason: "package_allowance_exhausted", createdAt: now }, $set: { updatedAt: now } },
        { upsert: true },
      );
      return { matched: true, chargedFen: 0, wallet, subscription };
    }
    const chargedFen = Math.min(packageFen, safeFen(amountFen));
    const entry = { key: ledgerKey, kind: "h3_short_video_package_reservation", amountFen: -chargedFen, orderNo, taskId, createdAt: now };
    const updated = await wallets.findOneAndUpdate(
      { ownerId, balanceFen: { $gte: chargedFen }, shortVideoPackageBalanceFen: { $gte: chargedFen }, ledgerKeys: { $ne: ledgerKey } },
      { $inc: { balanceFen: -chargedFen, shortVideoPackageBalanceFen: -chargedFen }, $push: { ledgerKeys: { $each: [ledgerKey], $slice: -600 }, ledgerEntries: { $each: [entry], $slice: -600 } }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!updated) continue;
    await ledgers.updateOne(
      { ledgerKey },
      { $setOnInsert: { ledgerKey, ownerId, taskId, orderNo, kind: "h3_short_video_package_reservation", amountFen: -chargedFen, status: "reserved", createdAt: now }, $set: { updatedAt: now } },
      { upsert: true },
    );
    return { matched: true, chargedFen, wallet: updated, subscription };
  }
  throw Object.assign(new Error("短视频包月额度并发扣减失败，请重试"), { code: "SHORT_VIDEO_ALLOWANCE_CONFLICT", status: 409 });
}

export async function refundShortVideoPackageAllowance({ getCollection, task, amountFen, ledgerKey, now = new Date() }) {
  const refundFen = safeFen(amountFen);
  if (!refundFen) return { applied: false, amountFen: 0 };
  const subscriptions = await getCollection("subscriptions");
  const subscription = await subscriptions.findOne({ ownerId: task.requesterUserId });
  if (!isActiveShortVideoSubscription(subscription, now)) return { applied: false, amountFen: 0, reason: "expired" };
  const wallets = await getCollection("wallets");
  const entry = { key: ledgerKey, kind: "h3_short_video_package_refund", amountFen: refundFen, orderNo: task.orderNo, taskId: task._id, createdAt: now };
  const wallet = await wallets.findOneAndUpdate(
    { ownerId: task.requesterUserId, ledgerKeys: { $ne: ledgerKey } },
    { $inc: { balanceFen: refundFen, shortVideoPackageBalanceFen: refundFen }, $push: { ledgerKeys: { $each: [ledgerKey], $slice: -600 }, ledgerEntries: { $each: [entry], $slice: -600 } }, $set: { shortVideoPackageExpiresAt: subscription.currentPeriodEnd, updatedAt: now } },
    { returnDocument: "after" },
  );
  return { applied: Boolean(wallet), wallet, amountFen: wallet ? refundFen : 0 };
}
