import { useMemo, useState } from "react";
import { CalendarBlank, CheckCircle, ShieldCheck } from "@phosphor-icons/react";
import { ApplicationDialog } from "./ConfirmDialog.jsx";
import { editorProducts, subscriptionChanges } from "../subscriptions.js";

const statuses={active:"生效中",scheduled:"尚未生效",expired:"已到期",inactive:"未开通",cancelled:"已撤销",pending_review:"待审核"};
export function UserSubscriptionDialog({user,products,subscriptions=[],meta={},loading=false,error="",onRetry,onSave,onClose}) {
  const [saving,setSaving]=useState(false);
  const baseline=useMemo(()=>editorProducts({products,subscriptions,user}),[products,subscriptions,user]);
  // The form mounts after the authoritative response; failed loads never enable editing.
  return <ApplicationDialog title="订阅与有效期设置" eyebrow="INDEPENDENT PRODUCT SUBSCRIPTIONS" description={`${user.display_name||user.displayName||user.email||user.id} · 各产品独立开通，可同时拥有多个订阅。`} onClose={onClose} busy={saving}>
    {loading?<p className="subscription-loading" role="status">正在读取用户的独立产品权益…</p>:error?<div className="subscription-load-error" role="alert"><p>{error}</p><button className="button secondary" onClick={onRetry}>重新读取订阅</button></div>:<SubscriptionProductForm key={JSON.stringify(baseline)} baseline={baseline} subscriptions={subscriptions} meta={meta} onSave={onSave} onClose={onClose} onBusyChange={setSaving}/>}
  </ApplicationDialog>;
}
function SubscriptionProductForm({baseline,subscriptions,meta,onSave,onClose,onBusyChange}) {
  const [rows,setRows]=useState(()=>baseline.map(row=>({...row}))),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const modified=rows.filter((row,index)=>row.enabled!==baseline[index].enabled||(row.enabled&&(row.currentPeriodStart!==baseline[index].currentPeriodStart||row.currentPeriodEnd!==baseline[index].currentPeriodEnd))).length;
  const update=(id,patch)=>{setError("");setRows(old=>old.map(row=>row.id===id?{...row,...patch}:row));};
  async function save(event) {
    event.preventDefault();if(busy)return;
    let products;try{products=subscriptionChanges(rows,baseline);}catch(reason){setError(reason.message);return;}
    if(!products.length)return;
    setBusy(true);onBusyChange(true);setError("");
    try{await onSave(products);onClose();}catch(reason){setError(reason.message||"订阅未保存，请稍后重试。");}finally{setBusy(false);onBusyChange(false);}
  }
  return <form className="subscription-product-form" onSubmit={save}>
    <div className="subscription-product-intro"><ShieldCheck size={24}/><div><strong>独立权益，独立时间</strong><p>勾选代表授权此产品；取消勾选并保存会撤销该项。只有实际修改的产品会提交，其他订阅与历史日期保持不变。</p></div></div>
    {meta.permissionLimited&&<p className="subscription-sync-note">部分 Chandler 数据暂未同步；当前可编辑的是官网独立产品权益。</p>}
    <fieldset className="subscription-product-grid" disabled={busy}><legend className="visually-hidden">选择订阅产品与独立有效期</legend>{rows.map(row=><article key={row.id} className={`subscription-product-card ${row.enabled?"enabled":""}`}>
      <header><label className="subscription-product-toggle"><input type="checkbox" checked={row.enabled} onChange={event=>update(row.id,{enabled:event.target.checked})}/><span><strong>{row.name}</strong><small>{row.description||"该产品单独记录授权与有效期。"}</small></span></label><span className={`status-pill ${row.status}`}>{statuses[row.status]||row.status}</span></header>
      <div className="subscription-product-dates"><label><span>生效时间</span><input aria-label={`${row.name}生效时间`} type="datetime-local" required={row.enabled} disabled={!row.enabled} value={row.currentPeriodStart} onChange={event=>update(row.id,{currentPeriodStart:event.target.value})}/></label><label><span>到期时间</span><input aria-label={`${row.name}到期时间`} type="datetime-local" required={row.enabled} disabled={!row.enabled} value={row.currentPeriodEnd} onChange={event=>update(row.id,{currentPeriodEnd:event.target.value})}/></label></div>
      {!row.enabled&&baseline.find(item=>item.id===row.id)?.enabled&&<p className="subscription-revoke-note">保存后仅撤销此产品，保留已有历史时间。</p>}
      <p className="subscription-product-footnote">{row.enabled?row.hasExisting?"已载入当前设置，修改后保存才会生效。":"尚未保存，开通时间以保存成功结果为准。":"未授权；已有到期记录不会因取消勾选而删除。"}</p>
    </article>)}</fieldset>
    {subscriptions.length>0&&<details className="subscription-history"><summary>历史订阅与审核记录（{subscriptions.length} 条）</summary>{subscriptions.map((item,index)=><article key={item.id||index}><strong>{item.sku_name||item.product_name||item.plan||"订阅记录"}</strong><span>{statuses[item.status]||item.status||"未知状态"}</span><time>{item.current_period_end||item.valid_until?new Date(item.current_period_end||item.valid_until).toLocaleString("zh-CN"):"到期时间未返回"}</time></article>)}</details>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <footer className="subscription-product-actions"><span><CheckCircle size={18}/>本次修改 {modified} 个产品</span><div><button type="button" className="button secondary" disabled={busy} onClick={onClose}>暂不修改</button><button className="button primary" disabled={busy||modified===0}><CalendarBlank size={18}/>{busy?"正在保存":"保存独立订阅设置"}</button></div></footer>
  </form>;
}
