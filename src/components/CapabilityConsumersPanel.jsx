import { ArrowClockwise, CheckCircle, MagnifyingGlass, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { apiFetch, localizeErrorMessage } from "../api.js";
import "./CapabilityConsumersPanel.css";
import { NodeComputeGroupSettings } from "./NodeComputeGroupSettings.jsx";
import { nodePresenceSnapshot, nodePresenceView } from "../shared-node-presence.js";

const ROOT = "/api/admin/capability-consumers";
const LABELS = { pending: "等待自动验收", queued: "等待自动验收", leased: "正在验收", verifying: "正在核验结果", active: "已通过", failed: "验收未通过", retry_wait: "等待自动重试", adapter_required: "等待节点适配", migration_deferred: "暂缓自动迁移", disabled: "未启用共享", invalidated: "等待重新验收", expired: "等待重新验收", revoked: "已停用" };
export function consumerBindingSearchParams(value) {
  const query = String(value || "").trim();
  return new URLSearchParams(query ? /^[a-fA-F0-9]{64}$/.test(query) ? { node_id: query } : { q: query } : {});
}
function displayTime(value) {
  const date = new Date(value || NaN);
  return Number.isFinite(+date) ? date.toLocaleString("zh-CN", { hour12: false }) : "—";
}
function NodePresence({ binding, now, unavailable }) {
  const view = nodePresenceView(binding, now, unavailable);
  return <span className={`cc-node-presence is-${view.status}`} title={`${view.label} · 最近心跳：${displayTime(binding.last_seen_at)}。在线不代表模型已通过验收或显卡空闲。`}><span className="cc-node-dot" aria-hidden="true" />{view.label}</span>;
}
export function CapabilityConsumersPanel() {
  const [query, setQuery] = useState("");
  const [bindings, setBindings] = useState([]), [selectedBinding, setSelectedBinding] = useState(null);
  const [records, setRecords] = useState([]), [loading, setLoading] = useState(false), [recordsLoading, setRecordsLoading] = useState(false);
  const [notice, setNotice] = useState(null), [accessDenied, setAccessDenied] = useState(false), [searchFailed, setSearchFailed] = useState(false);
  const [groupSaving, setGroupSaving] = useState(false);
  const [presenceError, setPresenceError] = useState(false), [presenceNow, setPresenceNow] = useState(() => performance.now());
  const mounted = useRef(false), bindingRequest = useRef(0), recordRequest = useRef(0);
  const selectedRef = useRef(null), groupSavingRef = useRef(false), activeQuery = useRef(""), bindingInFlight = useRef(0);
  useEffect(() => { selectedRef.current = selectedBinding; }, [selectedBinding]);
  function fail(error) {
    if (error.status === 401 || error.status === 403) {
      bindingRequest.current += 1; recordRequest.current += 1;
      selectedRef.current = null; groupSavingRef.current = false;
      setAccessDenied(true); setBindings([]); setSelectedBinding(null); setRecords([]); setLoading(false); setRecordsLoading(false); setGroupSaving(false);
    }
    setNotice(localizeErrorMessage(error, "共享节点状态暂时无法读取，请稍后重试。"));
  }
  async function loadBindings(value = query, { quiet = false } = {}) {
    if (groupSavingRef.current || quiet && bindingInFlight.current) return;
    const sequence = ++bindingRequest.current;
    bindingInFlight.current = sequence;
    if (!quiet) { activeQuery.current = value; setLoading(true); setSearchFailed(false); setNotice(null); }
    try {
      const params = consumerBindingSearchParams(value);
      const result = await apiFetch(`${ROOT}/bindings${params.size ? `?${params}` : ""}`, { cache: "no-store" });
      if (!mounted.current || sequence !== bindingRequest.current) return;
      const receivedAt = performance.now(), rows = nodePresenceSnapshot(result, receivedAt);
      setPresenceNow(receivedAt); setPresenceError(result.presence_unavailable === true);
      setBindings(rows); setAccessDenied(false); setSearchFailed(false);
      if (selectedRef.current) {
        const selected = rows.find(row => row.binding_id === selectedRef.current.binding_id);
        if (selected) { selectedRef.current = selected; setSelectedBinding(selected); }
        else { recordRequest.current += 1; selectedRef.current = null; setSelectedBinding(null); setRecords([]); setRecordsLoading(false); }
      }
    } catch (error) {
      if (!mounted.current || sequence !== bindingRequest.current) return;
      if (quiet) { setPresenceError(true); if (error.status === 401 || error.status === 403) fail(error); }
      else { recordRequest.current += 1; selectedRef.current = null; setBindings([]); setSelectedBinding(null); setRecords([]); setRecordsLoading(false); setSearchFailed(true); fail(error); }
    } finally { if (bindingInFlight.current === sequence) bindingInFlight.current = 0; if (mounted.current && sequence === bindingRequest.current) setLoading(false); }
  }
  async function loadRecords(binding) {
    if (!binding) return;
    const sequence = ++recordRequest.current;
    setRecordsLoading(true);
    try {
      const result = await apiFetch(`/api/admin/capability-verifications?${new URLSearchParams({ binding_id: binding.binding_id, limit: "100" })}`);
      if (!mounted.current || sequence !== recordRequest.current) return;
      setRecords(Array.isArray(result.verifications) ? result.verifications : []); setAccessDenied(false);
    } catch (error) { if (mounted.current && sequence === recordRequest.current) fail(error); }
    finally { if (mounted.current && sequence === recordRequest.current) setRecordsLoading(false); }
  }
  function chooseBinding(binding) { if (groupSaving) return; selectedRef.current = binding; setSelectedBinding(binding); setRecords([]); setNotice(null); loadRecords(binding); }
  function groupUpdated(result) {
    const update = (row) => row.binding_id === result.binding_id ? { ...row, compute_group_id: result.group_id } : row;
    setBindings((rows) => rows.map(update)); setSelectedBinding((row) => row ? update(row) : row);
    setRecords([]); loadRecords({ binding_id: result.binding_id });
  }
  function groupBusyChanged(value) {
    groupSavingRef.current = value;
    setGroupSaving(value);
    if (value) { bindingRequest.current += 1; setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; loadBindings("");
    return () => { mounted.current = false; bindingRequest.current += 1; recordRequest.current += 1; };
  }, []);
  useEffect(() => {
    if (accessDenied || groupSaving) return;
    const refresh = () => { if (!document.hidden) loadBindings(activeQuery.current, { quiet: true }); };
    const timer = setInterval(refresh, 15000);
    const tick = setInterval(() => { if (!document.hidden) setPresenceNow(performance.now()); }, 1000);
    const visible = () => { if (!document.hidden) { setPresenceNow(performance.now()); refresh(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); clearInterval(tick); document.removeEventListener("visibilitychange", visible); };
  }, [accessDenied, groupSaving]);
  useEffect(() => {
    if (!selectedBinding || accessDenied) return;
    const timer = setInterval(() => { if (!document.hidden) loadRecords({ binding_id: selectedBinding.binding_id }); }, 15000);
    return () => clearInterval(timer);
  }, [selectedBinding?.binding_id, accessDenied]);
  return <section className="admin-module capability-consumers-panel">
    <header className="admin-module-head"><div><span>SHARED MODEL VERIFICATION</span><h2>共享模型状态</h2><p>节点上报模型后自动排队验收，通过的模型自动开放共享派单，无需上传 JSON 或手工新增验收。</p></div><ShieldCheck size={38} weight="duotone" /></header>
    <div className="cc-notice" role="status"><ShieldCheck size={21} /><span>系统按节点、算力分组、模型及运行制品分别核验。未通过的模型自动退避重试，不影响已通过的模型；未安装、未开启共享或缺少执行适配的能力不会被标记为可用。</span></div>
    {notice && <div className="cc-notice error" role="alert"><WarningCircle size={21} /><span>{notice}</span></div>}
    <section className="cc-card"><header className="cc-section-heading"><span>01</span><div><h3>查看共享节点</h3><p>支持节点 ID 精确搜索及设备名称关键词搜索。</p></div></header>
      <form className="cc-search" onSubmit={(event) => { event.preventDefault(); loadBindings(); }}><label htmlFor="cc-node-query">节点 ID / 设备名称<input id="cc-node-query" maxLength={100} value={query} disabled={accessDenied || groupSaving} onChange={(event) => setQuery(event.target.value)} placeholder="输入节点名称或完整节点 ID" /></label><button className="button secondary" type="submit" disabled={loading || accessDenied || groupSaving}><MagnifyingGlass size={18} />{loading ? "正在搜索" : "搜索节点"}</button></form>
      <p className="cc-presence-hint">{presenceError ? "在线状态暂时无法更新，已显示为未知；节点选择和算力分组仍可查看。" : "状态每 15 秒更新 · 在线仅表示最近 3 分钟内收到心跳，不代表模型验收通过。"}</p>
      {accessDenied ? <p className="cc-empty">请重新登录管理员账号后返回此页面。</p> : loading ? <p className="cc-empty" role="status">正在读取节点绑定…</p> : searchFailed ? <p className="cc-empty" role="alert">节点查询失败，请根据上方提示重试；目前无法判断是否存在匹配节点。</p> : bindings.length ? <div className="cc-binding-list" role="listbox" aria-label="选择共享计算节点">{bindings.map((binding) => <button className={`cc-binding ${selectedBinding?.binding_id === binding.binding_id ? "selected" : ""}`} type="button" role="option" aria-selected={selectedBinding?.binding_id === binding.binding_id} disabled={groupSaving} key={binding.binding_id} onClick={() => chooseBinding(binding)}><span><span className="cc-node-title"><strong>{binding.node_name || "未命名节点"}</strong><NodePresence binding={binding} now={presenceNow} unavailable={presenceError} /></span><small>节点 ID</small><code>{binding.node_id}</code></span><CheckCircle size={21} weight={selectedBinding?.binding_id === binding.binding_id ? "fill" : "regular"} /></button>)}</div> : <p className="cc-empty">没有找到匹配节点。请确认设备已绑定官网账号，或更换关键词后重新搜索。</p>}
      {selectedBinding && <div className="cc-selected"><div><small>当前绑定编号</small><code>{selectedBinding.binding_id}</code></div><div><small>所属账户 ID</small><code>{selectedBinding.user_id || "未提供"}</code></div><div><small>算力分组 ID</small><code>{selectedBinding.compute_group_id || "未设置分组"}</code></div></div>}
      {selectedBinding && !accessDenied && <NodeComputeGroupSettings key={selectedBinding.binding_id} binding={selectedBinding} onUpdated={groupUpdated} onBusyChange={groupBusyChanged} onAccessDenied={fail} />}
    </section>
    <section className="cc-card"><header className="cc-record-heading"><div><h3>模型自动验收</h3><p>节点空闲时自动执行最小探测；结果验证通过后自动开放。此区域仅读取状态，不会重复创建探测任务。</p></div><button className="button secondary" type="button" disabled={!selectedBinding || recordsLoading || accessDenied} onClick={() => loadRecords(selectedBinding)}><ArrowClockwise size={18} />{recordsLoading ? "正在刷新" : "刷新状态"}</button></header>
      {!selectedBinding ? <p className="cc-empty">请先选择节点。</p> : !records.length ? <p className="cc-empty">{recordsLoading ? "正在读取模型状态…" : "尚无自动验收记录。节点需升级消费者并上报已安装的模型；已有有效验收不受影响。"}</p> : <div className="cc-record-list">{records.map((record) => <article className="cc-record" key={record.id}><header><div><strong>{(record.verified_model || record.model)?.id || record.model_id || record.capability_id}</strong><code>{record.capability_id} · {record.capability_version}</code></div><span className={`cc-status ${record.status === "active" ? "is-active" : record.status === "failed" ? "is-inactive" : ""}`}>{LABELS[record.status] || "等待核验"}</span></header><dl className="cc-record-grid"><div><dt>最近验收</dt><dd>{displayTime(record.tested_at || record.updated_at)}</dd></div><div><dt>有效期 / 下次重试</dt><dd>{displayTime(record.expires_at || record.next_attempt_at)}</dd></div><div><dt>模型维度 / 时长</dt><dd>{(record.verified_model || record.model)?.dimension ? `${(record.verified_model || record.model).dimension} 维` : (record.verified_model || record.model)?.max_duration_seconds ? `${(record.verified_model || record.model).max_duration_seconds} 秒` : "按模型合同"}</dd></div></dl>{record.error?.message && <p className="cc-muted">{record.error.message}</p>}</article>)}</div>}
    </section>
  </section>;
}
