import { ArrowClockwise, ArrowLeft, ArrowRight, CalendarBlank, CheckCircle, EnvelopeSimple, Eye, FloppyDisk, LockKey, MagnifyingGlass, PencilSimple, SpinnerGap, Trash, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api.js";
import { ApplicationDialog, useConfirmDialog } from "./ConfirmDialog.jsx";
import "./admin-birthday-records.css";

const TYPES = [{ id: "walls", label: "生日墙记录", icon: CalendarBlank }, { id: "letters", label: "情书记录", icon: EnvelopeSimple }];
const PAGE_SIZE = 20;
const displayDate = (value) => {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
};
const recordName = (type, item) => type === "walls" ? `${item.name || "未命名"}的生日墙` : `${item.senderName || "未署名"} → ${item.recipientName || "未填写收件人"}`;
const recordPath = (type, id) => `/api/admin/birthday-records/${type}/${encodeURIComponent(id)}`;

function RecordDetail({ selected, onClose, onUpdated }) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const saveRequest = useRef(null);
  const saveLock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; saveRequest.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setRecord(null); setError("");
    apiFetch(recordPath(selected.type, selected.item.id), { signal: controller.signal, cache: "no-store" })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.type !== selected.type || result.record?.id !== selected.item.id) throw new Error("记录详情与所选内容不一致，请重试。");
        setRecord(result.record);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason.message || "暂时无法读取详情，请稍后重试。"); });
    return () => controller.abort();
  }, [selected.type, selected.item.id, attempt]);
  const isWall = selected.type === "walls";
  function edit() {
    setDraft({ revision: Number.isInteger(record.revision) ? record.revision : 0, senderName: record.senderName || "", recipientName: record.recipientName || "", body: record.body || "", backgroundColor: /^#[0-9a-f]{6}$/i.test(record.backgroundColor || "") ? record.backgroundColor : "#FFF8F2" });
    setSaveError(""); setConflict(false); setNotice("");
  }
  async function save(event) {
    event.preventDefault();
    if (!draft || saveLock.current || conflict) return;
    saveLock.current = true; setSaving(true); setSaveError("");
    const controller = new AbortController(); saveRequest.current = controller;
    try {
      const result = await apiFetch(recordPath("letters", selected.item.id), { method: "PATCH", body: JSON.stringify(draft), signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      if (!result.ok || result.record?.id !== selected.item.id) throw new Error("修改结果暂时无法确认，请重新读取记录后核实。");
      setRecord(result.record); setDraft(null); setNotice("情书已更新，原分享链接和阅读密码保持不变。"); onUpdated();
    } catch (reason) {
      if (controller.signal.aborted || !mounted.current) return;
      if (reason.code === "RECORD_CHANGED") { setConflict(true); setSaveError("这封情书已被其他管理员修改。请重新读取最新版本后再编辑，避免覆盖其他人的修改。"); }
      else setSaveError(reason.message || "修改失败，已保留当前内容，请稍后重试。");
    } finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  }

  return <ApplicationDialog title={isWall ? "生日墙详情" : draft ? "修改情书" : "情书详情"} eyebrow="历史记录" description={recordName(selected.type, record || selected.item)} onClose={onClose} busy={saving} className="admin-birthday-detail">
    {error ? <div className="admin-birthday-state" role="alert"><WarningCircle size={30} /><p>{error}</p><button className="button secondary" type="button" onClick={() => setAttempt((value) => value + 1)}><ArrowClockwise size={17} />重新读取</button></div> : !record ? <div className="admin-birthday-state" role="status"><SpinnerGap size={30} className="admin-birthday-spin" /><p>正在读取完整记录…</p></div> : <>
      <dl className="admin-birthday-detail-meta"><div><dt>创建时间</dt><dd>{displayDate(record.createdAt)}</dd></div>{isWall ? <><div><dt>祝福数量</dt><dd>{record.noteCount ?? record.notes?.length ?? 0} 份</dd></div><div><dt>创建用户 ID</dt><dd>{record.ownerId || "—"}</dd></div></> : <><div><dt>信件日期</dt><dd>{record.date || "—"}</dd></div><div><dt>分享保护</dt><dd>{record.passwordSet ? "已设置阅读密码" : "待写信人补设密码（已锁定）"}</dd></div></>}<div className="admin-birthday-record-id"><dt>记录编号</dt><dd>{record.id}</dd></div></dl>
      {notice && <div className="admin-birthday-notice success" role="status"><CheckCircle size={19} /><span>{notice}</span></div>}
      {isWall ? <section className="admin-birthday-notes" aria-label="完整生日祝福"><h3>全部生日祝福</h3>{record.notes?.length ? record.notes.map((note) => <article key={note.id}><header><strong>{note.name || "匿名朋友"}</strong><time dateTime={note.createdAt}>{displayDate(note.createdAt)}</time></header><p>{note.message}</p>{Array.isArray(note.emojis) && note.emojis.length > 0 && <span aria-label="祝福表情">{note.emojis.join(" ")}</span>}</article>) : <p className="admin-birthday-empty-notes">这面生日墙尚未收到祝福。</p>}</section> : draft ? <form className="admin-birthday-edit" onSubmit={save}>
        <div className="admin-birthday-edit-names"><label>写信人<input name="senderName" maxLength={60} required value={draft.senderName} disabled={saving} onChange={(event) => setDraft({ ...draft, senderName: event.target.value })} /></label><label>收件人<input name="recipientName" maxLength={60} required value={draft.recipientName} disabled={saving} onChange={(event) => setDraft({ ...draft, recipientName: event.target.value })} /></label></div>
        <label className="admin-birthday-edit-color">信纸背景颜色<div><input type="color" aria-label="信纸背景颜色" value={draft.backgroundColor} disabled={saving} onChange={(event) => setDraft({ ...draft, backgroundColor: event.target.value })} /><span>{draft.backgroundColor.toUpperCase()}</span></div></label>
        <label>情书正文<textarea name="body" required maxLength={20000} value={draft.body} disabled={saving} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={14} /><small>{draft.body.length.toLocaleString("zh-CN")} / 20,000 字；保留原信件日期、分享链接和阅读密码。</small></label>
        {saveError && <div className="admin-birthday-notice error" role="alert"><WarningCircle size={19} /><span>{saveError}</span></div>}
        {conflict && <div className="admin-birthday-conflict"><p>重新读取会清除本次未保存的修改，请先自行复制需要保留的文字。</p><button className="button secondary" type="button" disabled={saving} onClick={() => { setDraft(null); setConflict(false); setSaveError(""); setAttempt((value) => value + 1); }}><ArrowClockwise size={17} />重新读取最新版本</button></div>}
        <div className="admin-birthday-detail-footer"><button className="button secondary" type="button" disabled={saving} onClick={() => { setDraft(null); setSaveError(""); setConflict(false); }}>取消修改</button><button className="button primary" type="submit" disabled={saving || conflict || !draft.senderName.trim() || !draft.recipientName.trim() || !draft.body.trim()}>{saving ? <SpinnerGap size={17} className="admin-birthday-spin" /> : <FloppyDisk size={17} />}{saving ? "正在保存…" : "保存修改"}</button></div>
      </form> : <article className="admin-birthday-letter" aria-label="情书完整内容"><header><span>写给</span><h3>{record.recipientName}</h3></header><div className="admin-birthday-letter-body">{record.body}</div><footer><span>来自 {record.senderName}</span><time>{record.date}</time></footer></article>}
      {!draft && <div className="admin-birthday-detail-footer">{!isWall && <button className="button primary" type="button" onClick={edit}><PencilSimple size={17} />修改情书</button>}<button className="button secondary" type="button" onClick={onClose}>关闭详情</button></div>}
    </>}
  </ApplicationDialog>;
}

export function AdminBirthdayRecords() {
  const confirmAction = useConfirmDialog();
  const [filters, setFilters] = useState({ type: "walls", q: "", page: 1 });
  const [keyword, setKeyword] = useState("");
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState("");
  const [selected, setSelected] = useState(null);
  const alive = useRef(false);
  const deleteLock = useRef(false);
  const isWall = filters.type === "walls";
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const locked = Boolean(removing);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setItems([]); setTotal(0);
    const query = new URLSearchParams({ type: filters.type, q: filters.q, page: String(filters.page), pageSize: String(PAGE_SIZE) });
    apiFetch(`/api/admin/birthday-records?${query}`, { signal: controller.signal, cache: "no-store" })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.type !== filters.type || !Array.isArray(result.items)) throw new Error("记录列表暂时无法识别，请刷新后重试。");
        const nextTotal = Math.max(0, Number(result.total) || 0);
        const lastPage = Math.max(1, Math.ceil(nextTotal / PAGE_SIZE));
        if (filters.page > lastPage) { setFilters((current) => ({ ...current, page: lastPage })); return; }
        setItems(result.items); setTotal(nextTotal);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason.message || "暂时无法读取记录，请稍后重试。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, revision]);

  function selectType(type) {
    if (locked || type === filters.type) return;
    setKeyword(""); setNotice(""); setSelected(null); setFilters({ type, q: "", page: 1 });
  }
  function search(event) {
    event.preventDefault();
    if (locked) return;
    setNotice(""); setFilters((current) => ({ ...current, q: keyword.trim(), page: 1 }));
  }
  async function remove(item) {
    if (deleteLock.current) return;
    deleteLock.current = true; setRemoving(item.id); setError(""); setNotice("");
    const type = filters.type;
    try {
      const confirmed = await confirmAction({ tone: "danger", eyebrow: "永久删除", title: type === "walls" ? "删除这面生日墙及全部祝福？" : "删除这封情书？", message: type === "walls" ? "生日墙及其中所有生日祝福将被永久删除，原分享链接立即失效，无法恢复。" : "情书正文、署名和分享内容将被永久删除，原分享链接立即失效，无法恢复。", detail: recordName(type, item), detailLabel: "删除对象", confirmLabel: "确认永久删除", cancelLabel: "保留记录", note: "此操作不会删除关联的付费订单，也不会变更用户余额。" });
      if (!confirmed || !alive.current) return;
      const result = await apiFetch(recordPath(type, item.id), { method: "DELETE" });
      if (!alive.current) return;
      if (!result.ok) throw new Error("删除结果暂时无法确认，请刷新列表后重试。");
      setNotice(result.removed ? "记录已永久删除，原分享链接已失效。" : "记录此前已删除，原分享链接已失效。");
      if (items.length === 1 && filters.page > 1) setFilters((current) => ({ ...current, page: current.page - 1 }));
      else setRevision((value) => value + 1);
    } catch (reason) { if (alive.current) setError(reason.message || "删除失败，请稍后重试。"); }
    finally { deleteLock.current = false; if (alive.current) setRemoving(""); }
  }

  return <section className="admin-module admin-birthday-records">
    <header className="admin-module-head"><div><span>历史内容管理</span><h2>生日墙</h2><p>查看生日墙与情书历史记录，最新创建的记录显示在最上方。</p></div><button className="button secondary" type="button" disabled={loading || locked} onClick={() => setRevision((value) => value + 1)}><ArrowClockwise size={17} />刷新</button></header>
    <div className="admin-birthday-tabs" role="tablist" aria-label="记录类型">{TYPES.map(({ id, label, icon: Icon }) => <button key={id} id={`birthday-record-tab-${id}`} type="button" role="tab" aria-selected={filters.type === id} aria-controls="birthday-records-panel" disabled={locked} className={filters.type === id ? "active" : ""} onClick={() => selectType(id)}><Icon size={19} />{label}</button>)}</div>
    <div id="birthday-records-panel" role="tabpanel" aria-labelledby={`birthday-record-tab-${filters.type}`}>
      <form className="admin-birthday-search" onSubmit={search}><label htmlFor="birthday-records-keyword"><span>关键词搜索</span><div><MagnifyingGlass size={19} /><input id="birthday-records-keyword" value={keyword} maxLength={100} disabled={locked} onChange={(event) => setKeyword(event.target.value)} placeholder={isWall ? "搜索姓名 / 编号" : "搜索写信人、收件人、情书内容或记录编号"} /></div></label><div className="admin-birthday-search-actions">{(keyword || filters.q) && <button className="button secondary" type="button" disabled={locked || loading} onClick={() => { setKeyword(""); setNotice(""); setFilters((current) => ({ ...current, q: "", page: 1 })); }}>清除</button>}<button className="button primary" type="submit" disabled={locked || loading}><MagnifyingGlass size={18} />搜索</button></div></form>
      {notice && <div className="admin-birthday-notice success" role="status"><CheckCircle size={19} /><span>{notice}</span></div>}
      {error && <div className="admin-birthday-notice error" role="alert"><WarningCircle size={19} /><span>{error}</span><button type="button" disabled={locked || loading} onClick={() => setRevision((value) => value + 1)}>重新读取</button></div>}
      <div className="admin-birthday-summary"><span>{loading ? "正在读取记录…" : <>共 <strong>{total.toLocaleString("zh-CN")}</strong> 条记录</>}</span><span>按创建时间倒序 · 每页 {PAGE_SIZE} 条</span></div>
      {loading ? <div className="admin-birthday-state" role="status"><SpinnerGap size={30} className="admin-birthday-spin" /><p>正在读取{isWall ? "生日墙" : "情书"}记录…</p></div> : items.length ? <div className={`admin-birthday-list ${filters.type}`}><div className="admin-birthday-list-head"><span>{isWall ? "生日墙 / 记录编号" : "写信人 / 收件人"}</span><span>{isWall ? "祝福数量" : "正文 / 分享保护"}</span><span>创建时间</span><span>操作</span></div>{items.map((item) => <article key={item.id} className="admin-birthday-row"><div className="admin-birthday-record-title"><strong>{recordName(filters.type, item)}</strong><small>{item.id}</small></div><div className="admin-birthday-record-count"><span className="admin-birthday-cell-label">{isWall ? "祝福数量" : "正文 / 分享保护"}</span><strong>{isWall ? `${item.noteCount || 0} 份祝福` : `${Number(item.characterCount || 0).toLocaleString("zh-CN")} 字`}</strong>{!isWall && <small><LockKey size={13} />{item.passwordSet ? "已设阅读密码" : "待写信人补设密码（已锁定）"}</small>}</div><div className="admin-birthday-record-time"><span className="admin-birthday-cell-label">创建时间</span><time dateTime={item.createdAt}>{displayDate(item.createdAt)}</time>{!isWall && item.date && <small>信件日期 {item.date}</small>}</div><div className="admin-birthday-row-actions"><button className="button small secondary" type="button" disabled={locked} onClick={() => setSelected({ type: filters.type, item })}><Eye size={16} />查看</button><button className="button small danger" type="button" disabled={locked} onClick={() => remove(item)}>{removing === item.id ? <SpinnerGap size={16} className="admin-birthday-spin" /> : <Trash size={16} />}删除</button></div></article>)}</div> : !error && <div className="admin-birthday-state"><EnvelopeSimple size={33} weight="duotone" /><h3>{filters.q ? "没有匹配的记录" : `暂无${isWall ? "生日墙" : "情书"}记录`}</h3><p>{filters.q ? "请调整关键词后重新搜索。" : "用户创建的内容会显示在这里。"}</p></div>}
      <nav className="admin-birthday-pagination" aria-label="历史记录分页"><span>第 {filters.page} / {totalPages} 页</span><div><button className="button secondary" type="button" disabled={loading || locked || filters.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}><ArrowLeft size={17} />上一页</button><button className="button secondary" type="button" disabled={loading || locked || filters.page >= totalPages} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>下一页<ArrowRight size={17} /></button></div></nav>
    </div>
    {selected && <RecordDetail key={`${selected.type}:${selected.item.id}`} selected={selected} onClose={() => setSelected(null)} onUpdated={() => setRevision((value) => value + 1)} />}
  </section>;
}
