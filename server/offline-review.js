export const OFFLINE_REVIEW_REJECTION_REASON = "管理员通过微信端拒绝了本次申请，请核对付款金额和支付截图后重新提交";

export function offlineReviewWechatMessage(order) {
  const amount = `¥${(Number(order.amountFen || 0) / 100).toFixed(2)}`;
  const shortVideo = order.subscriptionPlan === "short_video_monthly" || order.partnerData?.subscription_plan === "short_video_monthly";
  const bonusFen = shortVideo ? 0 : Number(order.promotionBonusFen || order.partnerData?.promotion_bonus_fen || 0);
  const cycle = order.kind === "recharge" ? "账户余额充值" : shortVideo ? `短视频包月 · ${order.cycle === "year" ? "年度" : "月度"}` : order.cycle === "year" ? "年度会员" : "月度会员";
  const lines = [
    "【古龙官网 · 新的线下支付待审核订单】",
    `订单号：${order.orderNo}`,
    `用户：${order.userEmail || order.ownerId || "未提供"}`,
    `套餐：${cycle}`,
    `金额：${amount}`,
  ];
  if (bonusFen > 0) lines.push(`赠送余额：¥${(bonusFen / 100).toFixed(2)}（审核通过后自动入账）`);
  if (order.previousReviewReason) lines.push(`上次拒绝：${order.previousReviewReason}`);
  if (order.resubmissionNote) lines.push(`用户调整：${order.resubmissionNote}`);
  lines.push("", "请直接回复：", "1、审核通过", "2、审核拒绝", "也可以回复“2 拒绝原因”把具体原因同步给用户。", "", "仅当前已绑定的管理员微信会话可以执行本订单操作。");
  return lines.join("\n");
}

export function parseOfflineReviewWechatAction(text) {
  const normalized = String(text || "").trim().replace(/^([１２])/, (value) => value === "１" ? "1" : "2");
  const match = normalized.match(/^([12])(?:[、.．:\s-]+([\s\S]*))?$/);
  if (!match) return null;
  return match[1] === "1"
    ? { action: "approve", reason: null }
    : { action: "reject", reason: String(match[2] || OFFLINE_REVIEW_REJECTION_REASON).trim().slice(0, 500) };
}

function chandlerOrderRoot(value) {
  return value?.order && typeof value.order === "object" ? value.order : value;
}

export function chandlerOrderItems(payload) {
  const root = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  for (const key of ["orders", "items", "results"]) {
    if (Array.isArray(root?.[key])) return root[key];
  }
  return Array.isArray(root) ? root : [];
}

export function normalizeChandlerOfflineOrder(value, application = {}) {
  const order = chandlerOrderRoot(value);
  const partner = order?.partner_data;
  if (!partner || typeof partner !== "object" || Array.isArray(partner) || partner.payment_method !== "offline") return null;
  const reviewStatus = String(partner.review_status || "pending").trim().toLowerCase();
  const planKind = String(partner.plan_kind || "").trim().toLowerCase();
  const subscriptionPlan = partner.subscription_plan === "short_video_monthly" || planKind === "short_video_monthly" ? "short_video_monthly" : "member";
  const amountFen = Number(partner.amount_fen ?? order.amount ?? order.amount_fen);
  const orderNo = String(order.platform_order_no || order.order_no || "").trim();
  const chandlerUserId = String(partner.chandler_user_id || partner.user_id || order.user_id || "").trim();
  const userEmail = String(partner.user_email || order.user_email || "").trim().toLowerCase();
  if (!orderNo || !chandlerUserId || !userEmail.includes("@") || !["monthly", "yearly", "month", "year", "short_video_monthly"].includes(planKind)) return null;
  if (!Number.isSafeInteger(amountFen) || amountFen < 100 || amountFen > 10_000_000) return null;
  const submittedUnixMs = Number(partner.submitted_at_unix_ms || (/^\d{10,16}$/.test(String(partner.submitted_at || "")) ? partner.submitted_at : 0));
  const submittedDate = submittedUnixMs > 0 ? new Date(submittedUnixMs) : new Date(partner.submitted_at || order.created_at || Date.now());
  return {
    orderNo,
    chandlerUserId,
    userEmail,
    cycle: partner.billing_interval === "year" || planKind === "yearly" || planKind === "year" ? "year" : "month",
    subscriptionPlan,
    amountFen,
    reviewStatus,
    partnerData: partner,
    applicationId: String(application.id || ""),
    applicationKey: String(partner.application_key || application.key || "gulong"),
    editionKey: application.editionKey === "yongshenghua" ? "yongshenghua" : "gulong",
    editionName: application.editionKey === "yongshenghua" ? "永生花版" : "古龙版",
    createdAt: Number.isNaN(submittedDate.getTime()) ? new Date() : submittedDate,
  };
}
