export const OFFLINE_REVIEW_REJECTION_REASON = "管理员通过微信端拒绝了本次申请，请核对付款金额和支付截图后重新提交";

export function offlineReviewWechatMessage(order) {
  const amount = `¥${(Number(order.amountFen || 0) / 100).toFixed(2)}`;
  const cycle = order.cycle === "year" ? "年度会员" : "月度会员";
  const lines = [
    "【古龙官网 · 新的线下支付待审核订单】",
    `订单号：${order.orderNo}`,
    `用户：${order.userEmail || order.ownerId || "未提供"}`,
    `套餐：${cycle}`,
    `金额：${amount}`,
  ];
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
