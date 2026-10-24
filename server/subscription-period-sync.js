import { getCollection as databaseCollection } from "./db.js";
import { SUBSCRIPTION_PRODUCT_IDS, productSubscription, buildProductPeriodPatch } from "./english-coach-products.js";

// A product edited by the website administrator remains authoritative even
// when the legacy top-level subscription was never manually edited.
export async function synchronizeChandlerSubscriptionPeriod({ ownerId, period, attributes, applicationId,
  getCollection = databaseCollection, now = new Date() }) {
  if (!period) return false;
  const subscriptions = await getCollection("subscriptions");
  const existing = await subscriptions.findOne({ ownerId });
  const knownProduct = SUBSCRIPTION_PRODUCT_IDS.includes(period.plan);
  if (existing?.manualPeriodOverride
    || knownProduct && productSubscription(existing, period.plan)?.manualPeriodOverride) return false;
  const fields = {
    ...period,
    ...(knownProduct ? buildProductPeriodPatch(existing, [{ id: period.plan, enabled: true,
      currentPeriodStart: period.currentPeriodStart, currentPeriodEnd: period.currentPeriodEnd }],
    { provider: "chandler", cycle: period.cycle }, now) : {}),
    chandlerApplicationId: applicationId, chandlerAttributes: attributes,
    chandlerSynchronizedAt: now, updatedAt: now,
  };
  if (!existing) {
    // Insert-only upsert: a record created by an administrator after the read
    // matches ownerId but is never modified. Do not assume a unique-owner index
    // that older deployments may not have, or apply a schema migration here.
    const inserted = await subscriptions.updateOne({ ownerId },
      { $setOnInsert: { ownerId, ...fields, createdAt: now } }, { upsert: true });
    return inserted.upsertedCount === 1;
  }
  const filter = { _id: existing._id, ownerId,
    updatedAt: existing.updatedAt || { $exists: false }, manualPeriodOverride: { $in: [null, false] },
    ...(knownProduct ? { [`products.${period.plan}.manualPeriodOverride`]: { $in: [null, false] } } : {}),
  };
  const updated = await subscriptions.updateOne(filter, {
    $set: fields,
    ...(period.plan === "short_video_monthly" ? { $unset: { allowanceExpiredAt: "", allowanceClearedFen: "" } } : {}),
  });
  // A concurrent edit wins. Never retry by unconditionally overwriting it.
  return updated.matchedCount === 1;
}
