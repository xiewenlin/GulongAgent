import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarBlank, CheckCircle, MagnifyingGlass, Plus, ShieldCheck, UsersThree } from "@phosphor-icons/react";
import { ApplicationDialog } from "./ConfirmDialog.jsx";
import { editorProducts, subscriptionChanges } from "../subscriptions.js";
import { apiFetch, localizeErrorMessage } from "../api.js";

const statuses={active:"生效中",scheduled:"尚未生效",expired:"已到期",inactive:"未开通",cancelled:"已撤销",pending_review:"待审核"};
async function readComputeGroupCatalog(query="",isCurrent=()=>true) {
  const groups=[],seenCursors=new Set();let cursor=null;
  do {
    const params=new URLSearchParams({q:query,limit:"200"});
    if(cursor)params.set("cursor",cursor);
    const page=await apiFetch(`/api/admin/compute-groups?${params}`);
    groups.push(...(page.groups||[]));cursor=page.nextCursor||null;
    if(cursor&&seenCursors.has(cursor))throw new Error("分组列表分页异常，请重新读取。");
    if(cursor)seenCursors.add(cursor);
  } while(cursor&&groups.length<5000&&isCurrent());
  return {groups:groups.slice(0,5000),limited:Boolean(cursor)};
}
export function UserSubscriptionDialog({user,products,subscriptions=[],meta={},loading=false,error="",onRetry,onSave,onClose}) {
  const [saving,setSaving]=useState(false);
  const [groupSaving,setGroupSaving]=useState(false);
  const baseline=useMemo(()=>editorProducts({products,subscriptions,user}),[products,subscriptions,user]);
  const userId=user.website_user_id||user.id;
  // The form mounts after the authoritative response; failed loads never enable editing.
  return <ApplicationDialog title="订阅与有效期设置" eyebrow="INDEPENDENT PRODUCT SUBSCRIPTIONS" description={`${user.display_name||user.displayName||user.email||user.id} · 各产品独立开通，可同时拥有多个订阅。`} onClose={onClose} busy={saving||groupSaving}>
    {loading?<p className="subscription-loading" role="status">正在读取用户的独立产品权益…</p>:error?<div className="subscription-load-error" role="alert"><p>{error}</p><button className="button secondary" onClick={onRetry}>重新读取订阅</button></div>:<><MemberComputeGroupPanel key={userId} userId={userId} externalBusy={saving} onBusyChange={setGroupSaving}/><SubscriptionProductForm key={JSON.stringify(baseline)} baseline={baseline} subscriptions={subscriptions} meta={meta} onSave={onSave} onClose={onClose} onBusyChange={setSaving} externalBusy={groupSaving}/></>}
  </ApplicationDialog>;
}
function MemberComputeGroupPanel({userId,externalBusy,onBusyChange}) {
  const [groups,setGroups]=useState([]),[membership,setMembership]=useState(null),[selectedId,setSelectedId]=useState(""),[selectionSnapshot,setSelectionSnapshot]=useState(null);
  const [catalogLimited,setCatalogLimited]=useState(false);
  const [query,setQuery]=useState(""),[newName,setNewName]=useState(""),[busy,setBusy]=useState("load"),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const request=useRef(0),mounted=useRef(true);
  const path=`/api/admin/users/${encodeURIComponent(userId)}/compute-group`;
  const currentId=membership?.computeGroupId||"";
  const options=useMemo(()=>{
    const list=[...groups];
    if(currentId&&!list.some(group=>group.id===currentId))list.unshift(membership.computeGroup||{id:currentId,name:"当前用户分组"});
    if(selectionSnapshot?.id===selectedId&&!list.some(group=>group.id===selectedId))list.push(selectionSnapshot);
    return list;
  },[groups,currentId,membership,selectedId,selectionSnapshot]);
  const chosen=options.find(group=>group.id===selectedId);
  const eligible=membership?.eligible===true;
  const locked=Boolean(busy)||externalBusy;
  const changed=selectedId!==currentId;
  const canSave=changed&&(eligible||selectedId==="")&&!locked;

  async function load() {
    const ticket=++request.current;setBusy("load");setError("");setNotice("");
    try {
      const [result,catalog]=await Promise.all([apiFetch(path),readComputeGroupCatalog("",()=>mounted.current&&ticket===request.current)]);
      if(!mounted.current||ticket!==request.current)return;
      setMembership(result);setSelectedId(result.computeGroupId||"");setSelectionSnapshot(result.computeGroup||null);setGroups(catalog.groups);setCatalogLimited(catalog.limited);
    } catch(reason) {if(mounted.current&&ticket===request.current)setError(localizeErrorMessage(reason,"用户分组暂时无法读取，请重试。"));}
    finally {if(mounted.current&&ticket===request.current)setBusy("");}
  }
  useEffect(()=>{mounted.current=true;load();return()=>{mounted.current=false;request.current++;};},[userId]);

  async function search(event) {
    event.preventDefault();if(locked)return;
    const ticket=++request.current;setBusy("search");setError("");
    try {
      const result=await readComputeGroupCatalog(query.trim(),()=>mounted.current&&ticket===request.current);
      if(mounted.current&&ticket===request.current){setGroups(result.groups);setCatalogLimited(result.limited);}
    } catch(reason) {if(mounted.current&&ticket===request.current)setError(localizeErrorMessage(reason,"分组搜索失败，请重试。"));}
    finally {if(mounted.current&&ticket===request.current)setBusy("");}
  }
  async function create(event) {
    event.preventDefault();if(locked||!eligible)return;
    const name=newName.trim();if(!name){setError("请填写用户分组名称。");return;}
    setBusy("create");onBusyChange(true);setError("");setNotice("");
    try {
      const result=await apiFetch("/api/admin/compute-groups",{method:"POST",body:JSON.stringify({name})});
      if(!mounted.current)return;
      if(!result.group?.id)throw new Error("分组创建结果不完整，请重新读取后确认。");
      setGroups(old=>[result.group,...old.filter(group=>group.id!==result.group.id)]);setSelectedId(result.group.id);setSelectionSnapshot(result.group);setNewName("");setNotice("用户分组已创建，请点击“保存用户分组”完成分配。");
    } catch(reason) {if(mounted.current)setError(localizeErrorMessage(reason,"分组创建失败，请稍后重试。"));}
    finally {if(mounted.current)setBusy("");onBusyChange(false);}
  }
  async function saveGroup() {
    if(!canSave)return;
    setBusy("save");onBusyChange(true);setError("");setNotice("");
    try {
      const result=await apiFetch(path,{method:"PUT",body:JSON.stringify({groupId:selectedId||null})});
      if(!mounted.current)return;
      setMembership(result);setSelectedId(result.computeGroupId||"");setSelectionSnapshot(result.computeGroup||null);setNotice(result.computeGroupId?"用户分组已保存，该用户仅能调用同分组的共享算力节点。":"用户分组已清除，该用户可调用未设置分组的共享算力节点。");
    } catch(reason) {if(mounted.current)setError(localizeErrorMessage(reason,"用户分组未保存，请重试。"));}
    finally {if(mounted.current)setBusy("");onBusyChange(false);}
  }
  return <section className="member-compute-group" aria-labelledby="member-compute-group-title">
    <header><div className="member-compute-group-heading"><UsersThree size={25}/><div><h3 id="member-compute-group-title">共享算力用户分组</h3><p>为古龙引擎包月用户分配专属节点分组。分组与产品订阅分别保存。</p></div></div><span className={`status-pill ${currentId?"active":"inactive"}`}>{currentId?"已分配分组":"未设置分组"}</span></header>
    {busy==="load"?<p className="member-compute-group-loading" role="status">正在读取用户分组…</p>:!membership?<div className="member-compute-group-message error" role="alert"><span>{error||"用户分组暂时无法读取。"}</span><button type="button" className="button small secondary" disabled={externalBusy} onClick={load}>重新读取</button></div>:<>
      {!eligible&&<p className="member-compute-group-note">此用户尚未配置古龙引擎包月产品。请先开通并保存该产品订阅，再重新打开详情分配分组。</p>}
      <div className="member-compute-group-current"><span>当前分组</span><strong>{membership.computeGroup?.name||(currentId?"已分配用户分组":"未设置分组")}</strong><span>用户分组 ID</span><code>{currentId||"未分配"}</code></div>
      <div className="member-compute-group-controls">
        <form className="member-compute-group-search" onSubmit={search}><label htmlFor="member-compute-group-query">按名称搜索分组</label><div><input id="member-compute-group-query" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="输入分组名称关键词" disabled={locked}/><button type="submit" className="button secondary" disabled={locked}><MagnifyingGlass size={17}/>{busy==="search"?"搜索中":"搜索"}</button></div></form>
        <form className="member-compute-group-create" onSubmit={create}><label htmlFor="member-compute-group-name">新建用户分组</label><div><input id="member-compute-group-name" value={newName} onChange={event=>setNewName(event.target.value)} placeholder="填写新分组名称" maxLength={80} disabled={locked||!eligible}/><button type="submit" className="button secondary" disabled={locked||!eligible||!newName.trim()}><Plus size={17}/>{busy==="create"?"创建中":"新建分组"}</button></div></form>
      </div>
      <div className="member-compute-group-assignment"><label htmlFor="member-compute-group-select">分配用户分组<select id="member-compute-group-select" value={selectedId} onChange={event=>{setSelectedId(event.target.value);setSelectionSnapshot(options.find(group=>group.id===event.target.value)||null);setError("");setNotice("");}} disabled={locked||(!eligible&&!currentId)}><option value="">不设置分组</option>{options.map(group=><option key={group.id} value={group.id} disabled={!eligible}>{group.name}</option>)}</select></label><div className="member-compute-group-selected"><span>将保存的用户分组 ID</span><code>{chosen?.id||selectedId||"未分配"}</code></div><button type="button" className="button primary" onClick={saveGroup} disabled={!canSave}><CheckCircle size={18}/>{busy==="save"?"正在保存":"保存用户分组"}</button></div>
      {!groups.length&&<p className="member-compute-group-note">{query?"没有找到匹配分组，可调整关键词或新建分组。":"暂无用户分组，先新建分组，再分配给用户。"}</p>}
      {catalogLimited&&<p className="member-compute-group-note">分组较多，当前显示前 5000 个，请输入名称关键词定位其他分组。</p>}
      <p className="member-compute-group-rule"><ShieldCheck size={18}/><span>用户与节点的分组 ID 必须一致；未设置分组的用户只能使用未设置分组的节点。</span></p>
      {error&&<p className="member-compute-group-message error" role="alert">{error}</p>}
      {notice&&<p className="member-compute-group-message success" role="status">{notice}</p>}
    </>}
  </section>;
}
function SubscriptionProductForm({baseline,subscriptions,meta,onSave,onClose,onBusyChange,externalBusy=false}) {
  const [rows,setRows]=useState(()=>baseline.map(row=>({...row}))),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const modified=rows.filter((row,index)=>row.enabled!==baseline[index].enabled||(row.enabled&&(row.currentPeriodStart!==baseline[index].currentPeriodStart||row.currentPeriodEnd!==baseline[index].currentPeriodEnd))).length;
  const update=(id,patch)=>{setError("");setRows(old=>old.map(row=>row.id===id?{...row,...patch}:row));};
  async function save(event) {
    event.preventDefault();if(busy||externalBusy)return;
    let products;try{products=subscriptionChanges(rows,baseline);}catch(reason){setError(reason.message);return;}
    if(!products.length)return;
    setBusy(true);onBusyChange(true);setError("");
    try{await onSave(products);onClose();}catch(reason){setError(reason.message||"订阅未保存，请稍后重试。");}finally{setBusy(false);onBusyChange(false);}
  }
  return <form className="subscription-product-form" onSubmit={save}>
    <div className="subscription-product-intro"><ShieldCheck size={24}/><div><strong>独立权益，独立时间</strong><p>勾选代表授权此产品；取消勾选并保存会撤销该项。只有实际修改的产品会提交，其他订阅与历史日期保持不变。</p></div></div>
    {meta.permissionLimited&&<p className="subscription-sync-note">部分 Chandler 数据暂未同步；当前可编辑的是官网独立产品权益。</p>}
    <fieldset className="subscription-product-grid" disabled={busy||externalBusy}><legend className="visually-hidden">选择订阅产品与独立有效期</legend>{rows.map(row=><article key={row.id} className={`subscription-product-card ${row.enabled?"enabled":""}`}>
      <header><label className="subscription-product-toggle"><input type="checkbox" checked={row.enabled} onChange={event=>update(row.id,{enabled:event.target.checked})}/><span><strong>{row.name}</strong><small>{row.description||"该产品单独记录授权与有效期。"}</small></span></label><span className={`status-pill ${row.status}`}>{statuses[row.status]||row.status}</span></header>
      <div className="subscription-product-dates"><label><span>生效时间</span><input aria-label={`${row.name}生效时间`} type="datetime-local" required={row.enabled} disabled={!row.enabled} value={row.currentPeriodStart} onChange={event=>update(row.id,{currentPeriodStart:event.target.value})}/></label><label><span>到期时间</span><input aria-label={`${row.name}到期时间`} type="datetime-local" required={row.enabled} disabled={!row.enabled} value={row.currentPeriodEnd} onChange={event=>update(row.id,{currentPeriodEnd:event.target.value})}/></label></div>
      {!row.enabled&&baseline.find(item=>item.id===row.id)?.enabled&&<p className="subscription-revoke-note">保存后仅撤销此产品，保留已有历史时间。</p>}
      <p className="subscription-product-footnote">{row.enabled?row.hasExisting?"已载入当前设置，修改后保存才会生效。":"尚未保存，开通时间以保存成功结果为准。":"未授权；已有到期记录不会因取消勾选而删除。"}</p>
    </article>)}</fieldset>
    {subscriptions.length>0&&<details className="subscription-history"><summary>历史订阅与审核记录（{subscriptions.length} 条）</summary>{subscriptions.map((item,index)=><article key={item.id||index}><strong>{item.sku_name||item.product_name||item.plan||"订阅记录"}</strong><span>{statuses[item.status]||item.status||"未知状态"}</span><time>{item.current_period_end||item.valid_until?new Date(item.current_period_end||item.valid_until).toLocaleString("zh-CN"):"到期时间未返回"}</time></article>)}</details>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <footer className="subscription-product-actions"><span><CheckCircle size={18}/>本次修改 {modified} 个产品</span><div><button type="button" className="button secondary" disabled={busy||externalBusy} onClick={onClose}>暂不修改</button><button className="button primary" disabled={busy||externalBusy||modified===0}><CalendarBlank size={18}/>{busy?"正在保存":"保存独立订阅设置"}</button></div></footer>
  </form>;
}
