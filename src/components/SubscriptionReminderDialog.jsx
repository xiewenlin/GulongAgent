import { ArrowRight, CalendarCheck, ClockCountdown, ShieldCheck, X } from "@phosphor-icons/react";

export function SubscriptionReminderDialog({ lifecycle, onRenew, onClose }) {
  if (!lifecycle) return null;
  const expired = lifecycle.restricted || lifecycle.status === "expired";
  return (
    <div className="modal-backdrop renewal-modal-backdrop" role="presentation">
      <section className={`renewal-reminder-modal ${expired ? "expired" : "due"}`} role="dialog" aria-modal="true" aria-labelledby="renewal-reminder-title">
        {!expired && <button className="modal-close" type="button" aria-label="稍后提醒" onClick={onClose}><X size={20} /></button>}
        <div className="renewal-reminder-icon">{expired ? <ShieldCheck size={34} weight="duotone" /> : <ClockCountdown size={34} weight="duotone" />}</div>
        <span>{expired ? "SUBSCRIPTION EXPIRED" : "RENEWAL REMINDER"}</span>
        <h2 id="renewal-reminder-title">{expired ? "会员套餐已到期，请先续费" : `会员将在 ${lifecycle.daysRemaining} 天后到期`}</h2>
        <p>{expired ? "到期后会员专属能力已暂停。完成微信支付续费后，官网与桌面端会自动恢复并同步权益。" : "Chandler 当前不支持自动扣款。我们会在到期前 7 天内每天提醒一次，请使用微信手动续费，避免能力中断。"}</p>
        <div className="renewal-reminder-facts"><span><CalendarCheck size={20} /> 到期时间</span><strong>{lifecycle.currentPeriodEnd ? new Date(lifecycle.currentPeriodEnd).toLocaleString("zh-CN") : "待确认"}</strong></div>
        <button className="button primary full" type="button" onClick={onRenew}>立即微信续费 <ArrowRight size={18} /></button>
        {!expired && <button className="button ghost full" type="button" onClick={onClose}>今天稍后提醒我</button>}
        <small>微信在线支付为单次付款，不会自动扣款。</small>
      </section>
    </div>
  );
}
