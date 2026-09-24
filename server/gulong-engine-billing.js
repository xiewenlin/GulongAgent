import { getCollection } from "./db.js";
import { creditMonthlySubscriptionBalance } from "./pearapi.js";

export const GULONG_ENGINE_WALLET_SOURCE = "offline_gulong_engine_subscription";

export async function creditGulongEngineSubscriptionBalance({ ownerId, orderNo, amountFen, collectionProvider = getCollection }) {
  if (!ownerId || !String(orderNo || "").trim() || !Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw new Error("古龙引擎包月订单缺少有效的账户、订单号或实付金额");
  }
  return creditMonthlySubscriptionBalance({
    ownerId,
    amountFen,
    source: GULONG_ENGINE_WALLET_SOURCE,
    sourceId: orderNo,
    kind: "gulong_engine_subscription",
    collectionProvider,
  });
}

export async function reconcileApprovedGulongEngineOrders({ collectionProvider = getCollection, apply = false }) {
  const orders = await collectionProvider("offlinePayments");
  const wallets = await collectionProvider("wallets");
  const summary = { eligible: 0, missing: 0, applied: 0, alreadyApplied: 0, invalid: 0 };
  const cursor = orders.find({ status: "approved", subscriptionPlan: "gulong_engine_monthly" });
  for await (const order of cursor) {
    summary.eligible += 1;
    if (!order.ownerId || !String(order.orderNo || "").trim() || !Number.isSafeInteger(order.amountFen) || order.amountFen <= 0) {
      summary.invalid += 1;
      continue;
    }
    const creditKey = `${GULONG_ENGINE_WALLET_SOURCE}:${order.orderNo}`;
    const exists = await wallets.findOne({ ownerId: order.ownerId, "credits.key": creditKey }, { projection: { _id: 1 } });
    if (exists) summary.alreadyApplied += 1;
    else summary.missing += 1;
    if (!apply) continue;
    const result = await creditGulongEngineSubscriptionBalance({ ownerId: order.ownerId, orderNo: order.orderNo, amountFen: order.amountFen, collectionProvider });
    if (result.applied) summary.applied += 1;
    if (order.creditedFen !== order.amountFen || order.partnerData?.wallet_credit_fen !== order.amountFen) {
      await orders.updateOne({ _id: order._id, status: "approved", subscriptionPlan: "gulong_engine_monthly" }, {
        $set: { creditedFen: order.amountFen, "partnerData.wallet_credit_fen": order.amountFen, updatedAt: new Date() },
      });
    }
  }
  return summary;
}
