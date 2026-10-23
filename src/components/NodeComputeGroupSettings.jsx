import { ArrowClockwise, CheckCircle, FloppyDisk, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { apiFetch, localizeErrorMessage } from "../api.js";
import { useConfirmDialog } from "./ConfirmDialog.jsx";

export function NodeComputeGroupSettings({ binding, onUpdated, onBusyChange, onAccessDenied }) {
  const confirm = useConfirmDialog();
  const [current, setCurrent] = useState(null), [chosen, setChosen] = useState(null);
  const [groups, setGroups] = useState([]), [nextCursor, setNextCursor] = useState(null);
  const [keyword, setKeyword] = useState(""), [filter, setFilter] = useState({ q: "", cursor: "" });
  const [loading, setLoading] = useState(true), [groupsLoading, setGroupsLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [groupError, setGroupError] = useState(""), [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0), [listAttempt, setListAttempt] = useState(0);
  const mounted = useRef(false), saveLock = useRef(false);
  const path = `/api/admin/nodes/${encodeURIComponent(binding.binding_id)}/compute-group`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function showError(reason, list = false) {
    (list ? setGroupError : setError)(localizeErrorMessage(reason, "算力分组暂时无法读取，请稍后重试。"));
    if (reason.status === 401 || reason.status === 403) onAccessDenied(reason);
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setCurrent(null); setError("");
    apiFetch(path, { signal: controller.signal, cache: "no-store" }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok || result.binding_id !== binding.binding_id || result.node_id !== binding.node_id) throw new Error("节点分组与所选节点不一致，请重新读取。");
      setCurrent(result); setChosen(result.group); setNotice("");
    }).catch((reason) => { if (!controller.signal.aborted) showError(reason); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => {
    const controller = new AbortController();
    setGroupsLoading(true); setGroupError(""); setNextCursor(null);
    if (!filter.cursor) setGroups([]);
    const params = new URLSearchParams({ q: filter.q, limit: "100", ...(filter.cursor ? { cursor: filter.cursor } : {}) });
    apiFetch(`/api/admin/compute-groups?${params}`, { signal: controller.signal, cache: "no-store" }).then((result) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(result.groups)) throw new Error("分组列表暂时无法识别，请重新加载。");
      setGroups((previous) => [...new Map([...(filter.cursor ? previous : []), ...result.groups].map((group) => [group.id, group])).values()]);
      setNextCursor(result.nextCursor || null);
    }).catch((reason) => { if (!controller.signal.aborted) showError(reason, true); })
      .finally(() => { if (!controller.signal.aborted) setGroupsLoading(false); });
    return () => controller.abort();
  }, [filter, listAttempt]);
  const chosenId = chosen?.id || null;
  async function save() {
    if (!current || saveLock.current || chosenId === current.group_id) return;
    saveLock.current = true; setSaving(true); onBusyChange(true); setError(""); setNotice("");
    try {
      const accepted = await confirm({ title: "确认修改节点算力分组？", eyebrow: "共享节点权限", message: "修改后，该节点只接受相同算力分组的用户任务；未分组节点只接受未分组用户。已有验收不会被手动标记为通过。", detailLabel: "节点与目标分组", detail: `${binding.node_name || binding.node_id} → ${chosen?.name || "未设置分组"}${chosenId ? `（${chosenId}）` : ""}`, confirmLabel: "确认保存", cancelLabel: "暂不修改" });
      if (!accepted || !mounted.current) return;
      const result = await apiFetch(path, { method: "PUT", body: JSON.stringify({ group_id: chosenId, expected_group_id: current.group_id }) });
      if (!mounted.current) return;
      if (!result.ok || result.binding_id !== binding.binding_id || result.node_id !== binding.node_id || result.group_id !== chosenId) throw new Error("保存结果暂时无法确认，请重新读取当前分组。");
      setCurrent(result); setChosen(result.group); setNotice("节点算力分组已保存。后续派单以官网分组为准，不会自动开放未通过验收的模型。");
      onUpdated(result);
    } catch (reason) { if (mounted.current) showError(reason); }
    finally { saveLock.current = false; if (mounted.current) { setSaving(false); onBusyChange(false); } }
  }
  return <section className="cc-group-settings" aria-label="节点算力分组设置">
    <header className="cc-record-heading"><div><h3>设置算力分组</h3><p>选择已创建的分组。分组与发行渠道无关，未分组仅匹配未分组。</p></div><button className="button secondary" type="button" disabled={loading || saving} onClick={() => setAttempt((value) => value + 1)}><ArrowClockwise size={17} />重新读取</button></header>
    {error && <div className="cc-notice error" role="alert"><WarningCircle size={19} /><span>{error}</span></div>}
    {notice && <div className="cc-notice success" role="status"><CheckCircle size={19} /><span>{notice}</span></div>}
    <div className="cc-group-current">{loading ? "正在读取当前分组…" : current ? <><span>当前分组：<strong>{current.group?.name || (current.group_id ? "原分组已不可用" : "未设置分组")}</strong></span><code>{current.group_id || "未分配分组 ID"}</code></> : "当前分组读取失败，重新读取成功后才能保存。"}</div>
    <form className="cc-search" onSubmit={(event) => { event.preventDefault(); if (!saving) setFilter({ q: keyword.trim(), cursor: "" }); }}><label htmlFor="cc-group-query">按名称搜索算力分组<input id="cc-group-query" value={keyword} maxLength={100} disabled={saving} onChange={(event) => setKeyword(event.target.value)} placeholder="输入分组名称关键词，留空显示全部" /></label><button className="button secondary" type="submit" disabled={saving || groupsLoading}><MagnifyingGlass size={17} />搜索分组</button>{(filter.q || keyword) && <button className="button secondary" type="button" disabled={saving || groupsLoading} onClick={() => { setKeyword(""); setFilter({ q: "", cursor: "" }); }}>显示全部</button>}</form>
    {groupError && <div className="cc-notice error" role="alert"><WarningCircle size={19} /><span>{groupError}</span><button className="button secondary" type="button" disabled={saving || groupsLoading} onClick={() => setListAttempt((value) => value + 1)}>重试列表</button></div>}
    <div className="cc-group-list" role="listbox" aria-label="选择算力分组" aria-busy={groupsLoading}>
      <button className={`cc-binding ${!chosenId ? "selected" : ""}`} role="option" aria-selected={!chosenId} type="button" disabled={saving || !current} onClick={() => setChosen(null)}><span><strong>未设置分组</strong><small>仅服务未分组用户</small></span><CheckCircle size={20} weight={!chosenId ? "fill" : "regular"} /></button>
      {groups.map((group) => <button key={group.id} className={`cc-binding ${chosenId === group.id ? "selected" : ""}`} role="option" aria-selected={chosenId === group.id} type="button" disabled={saving || !current} onClick={() => setChosen(group)}><span><strong>{group.name}</strong><code>{group.id}</code></span><CheckCircle size={20} weight={chosenId === group.id ? "fill" : "regular"} /></button>)}
    </div>
    {groupsLoading ? <p className="cc-muted" role="status">正在读取分组列表…</p> : !groups.length && !groupError && <p className="cc-muted">{filter.q ? "没有匹配的分组，请更换关键词或显示全部。" : "暂无算力分组，请先在订阅用户详情中新建。"}</p>}
    {nextCursor && <button className="button secondary cc-group-more" type="button" disabled={saving || groupsLoading} onClick={() => setFilter((value) => ({ ...value, cursor: nextCursor }))}>加载更多分组（已显示 {groups.length} 个）</button>}
    <footer className="cc-group-footer"><div><span>将保存：<strong>{chosen?.name || (current?.group_id && !current.group ? "请先选择有效分组" : "未设置分组")}</strong></span><code>{chosenId || "未分配分组 ID"}</code></div><button className="button primary" type="button" disabled={saving || loading || !current || chosenId === current.group_id} onClick={save}><FloppyDisk size={18} />{saving ? "正在保存…" : "保存算力分组"}</button></footer>
    <p className="cc-muted">节点有运行中任务或自动验收时不能切换分组；修改分组不会更改用户会员、余额或模型验收结论。</p>
  </section>;
}
