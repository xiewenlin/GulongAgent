import { ArrowClockwise, ArrowDown, ArrowRight, CheckCircle, Confetti, DownloadSimple, Heart, PencilSimple, Plus, QrCode, Sparkle, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { apiFetch, createClientRequestId } from "../api.js";
import { birthdayNoteColor, exportBirthdayWall } from "../birthday-wall-export.js";
import { ApplicationDialog } from "./ConfirmDialog.jsx";
import { BirthdayArtwork } from "./BirthdayArtwork.jsx";
import { BirthdayShareDialog } from "./BirthdayShareDialog.jsx";
import { LoveLetterComposer } from "./LoveLetterComposer.jsx";
import "./birthday-wall.css";

const DRAFT_KEY = "gulong-birthday-wall-draft-v2";
const ZERO_STATS = { total: 0, participants: 0, today: 0 };
function readDraft(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || "null") || {}; } catch { return {}; }
}
function saveDraft(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The in-memory draft remains available. */ } }
function noteEmojis(value) { return Array.isArray(value) ? value.join(" ") : value || "🎂 ✨ 💛"; }
function readableDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : "刚刚";
}

export function BirthdayWallPage({ user, openAuth, wallId = "", onOpenWall }) {
  const ownerId = String(user?.id || user?._id || "");
  const [wall, setWall] = useState(null);
  const [walls, setWalls] = useState([]);
  const [notes, setNotes] = useState([]);
  const [stats, setStats] = useState(ZERO_STATS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [createDraft, setCreateDraft] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [createError, setCreateError] = useState("");
  const [notice, setNotice] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [letterOpen, setLetterOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [artwork, setArtwork] = useState(null);
  const session = useRef(null);
  const promptRef = useRef(null);
  const createRef = useRef(null);
  const name = draft.name || "";
  const message = draft.message || "";
  const sameSession = session.current?.wallId === wallId && session.current?.ownerId === ownerId;
  const readyWall = sameSession && wall?.id === wallId ? wall : null;
  const visibleWalls = sameSession ? walls : [];

  function active(context) { return session.current === context && !context.controller.signal.aborted; }
  async function refresh(context = session.current, { quiet = false } = {}) {
    if (!context || !active(context)) return;
    if (context.fetching) {
      context.refreshQueued = true;
      context.refreshQueuedQuiet = context.refreshQueuedQuiet && quiet;
      return;
    }
    context.fetching = true;
    const readEpoch = context.mutationEpoch;
    if (!quiet) setLoading(true);
    try {
      if (context.wallId) {
        const result = await apiFetch(`/api/birthday-walls/${encodeURIComponent(context.wallId)}`, { signal: context.controller.signal });
        if (!active(context) || context.mutationEpoch !== readEpoch) return;
        if (result.wall?.id !== context.wallId) throw new Error("生日墙信息不匹配，请重新打开分享链接");
        setWall(result.wall); setNotes(result.notes || []); setStats(result.stats || ZERO_STATS);
      } else if (context.ownerId) {
        const result = await apiFetch("/api/birthday-walls/mine", { signal: context.controller.signal });
        if (!active(context) || context.mutationEpoch !== readEpoch) return;
        setWalls(result.walls || []);
      }
      if (active(context) && context.mutationEpoch === readEpoch) setLoadError("");
    } catch (error) { if (active(context) && context.mutationEpoch === readEpoch && !quiet) setLoadError(error.message); }
    finally {
      context.fetching = false;
      if (active(context)) {
        if (context.refreshQueued) {
          const queuedQuiet = context.refreshQueuedQuiet;
          context.refreshQueued = false; context.refreshQueuedQuiet = true;
          void refresh(context, { quiet: queuedQuiet });
        } else setLoading(false);
      }
    }
  }

  useEffect(() => {
    const context = { wallId, ownerId, controller: new AbortController(), fetching: false, mutationEpoch: 0, refreshQueued: false, refreshQueuedQuiet: true, createLocked: false, noteLocked: false, draftKey: `${DRAFT_KEY}:notes:${wallId}`, createKey: `${DRAFT_KEY}:create:${ownerId}` };
    session.current = context;
    setWall(null); setWalls([]); setNotes([]); setStats(ZERO_STATS); setArtwork(null);
    setComposerOpen(false); setDraft(readDraft(context.draftKey)); setCreateDraft(readDraft(context.createKey));
    setLoading(true); setLoadError(""); setSubmitError(""); setCreateError(""); setNotice(""); setShareOpen(false); setLetterOpen(false);
    setSubmitting(false); setCreating(false); setExporting(false);
    refresh(context);
    const timer = wallId ? window.setInterval(() => { if (!document.hidden) refresh(context, { quiet: true }); }, 30_000) : null;
    return () => { context.controller.abort(); if (timer) window.clearInterval(timer); };
  }, [wallId, ownerId]);

  useEffect(() => {
    const oldTitle = document.title;
    document.title = readyWall ? `${readyWall.name}的生日墙 · 把祝福珍藏` : "生日墙 · 创建你的专属祝福墙";
    return () => { document.title = oldTitle; };
  }, [readyWall?.name]);

  useEffect(() => {
    if (!composerOpen) return;
    const timer = window.setTimeout(() => promptRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [composerOpen]);

  function openWall(url) {
    if (onOpenWall) onOpenWall(url);
    else window.location.assign(url);
  }
  function openComposer() {
    setLetterOpen(false);
    if (!wallId) {
      if (!ownerId) openAuth?.("login");
      else { createRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); createRef.current?.focus(); }
      return;
    }
    if (readyWall && !loading && !loadError) { setShareOpen(false); setComposerOpen(true); setSubmitError(""); }
  }
  function changeDraft(patch) {
    const next = { ...draft, ...patch, clientRequestId: null };
    setDraft(next); saveDraft(session.current.draftKey, next); setSubmitError("");
  }
  function changeCreateName(value) {
    const next = { name: value, clientRequestId: null };
    setCreateDraft(next); saveDraft(session.current.createKey, next); setCreateError("");
  }

  async function createWall(event) {
    event.preventDefault();
    const context = session.current;
    if (!context?.ownerId) { openAuth?.("login"); return; }
    if (!active(context) || context.createLocked || creating || !createDraft.name?.trim()) return;
    context.createLocked = true;
    const payload = { name: createDraft.name.trim(), clientRequestId: createDraft.clientRequestId || createClientRequestId() };
    setCreateDraft(payload); saveDraft(context.createKey, payload); setCreating(true); setCreateError("");
    try {
      const result = await apiFetch("/api/birthday-walls", { method: "POST", body: JSON.stringify(payload), signal: context.controller.signal });
      if (!active(context)) return;
      context.mutationEpoch += 1;
      if (!result.wall?.id || result.url !== `/birthday-wall/${encodeURIComponent(result.wall.id)}`) throw new Error("生日墙已提交，请刷新“我的生日墙”查看原记录");
      setCreateDraft({}); saveDraft(context.createKey, {}); openWall(result.url);
    } catch (error) { if (active(context)) setCreateError(error.message); }
    finally { context.createLocked = false; if (active(context)) setCreating(false); }
  }

  async function submit(event) {
    event.preventDefault();
    const context = session.current;
    if (!context?.wallId || !active(context) || !readyWall || context.noteLocked || submitting || !message.trim()) return;
    context.noteLocked = true;
    const payload = { name: name.trim(), message: message.trim(), clientRequestId: draft.clientRequestId || createClientRequestId() };
    setDraft(payload); saveDraft(context.draftKey, payload); setSubmitting(true); setSubmitError("");
    try {
      const result = await apiFetch(`/api/birthday-walls/${encodeURIComponent(context.wallId)}/notes`, { method: "POST", body: JSON.stringify(payload), signal: context.controller.signal });
      if (!active(context)) return;
      // A GET begun before this successful write must not erase its local result.
      context.mutationEpoch += 1;
      if (result.note) setNotes((current) => [...current.filter((item) => item.id !== result.note.id), result.note]);
      setDraft({ name: payload.name, message: "" }); saveDraft(context.draftKey, { name: payload.name, message: "" });
      setComposerOpen(false); setNotice("祝福已贴上生日墙，心意收到啦！ 🎉");
      await refresh(context, { quiet: true });
    } catch (error) { if (active(context)) setSubmitError(error.message); }
    finally { context.noteLocked = false; if (active(context)) setSubmitting(false); }
  }

  function shareWall() {
    if (!readyWall) return;
    setComposerOpen(false); setLetterOpen(false); setShareOpen(true);
  }

  function openLetter() { setComposerOpen(false); setShareOpen(false); setLetterOpen(true); }

  async function exportWall() {
    const context = session.current;
    if (exporting || loading || loadError || !readyWall) return;
    setExporting(true); setNotice("");
    try {
      const result = await exportBirthdayWall({ notes, stats, artwork, wallName: readyWall.name });
      if (!active(context)) return;
      setNotice(result.format === "svg"
        ? `已保存全部 ${result.count} 份祝福。内容较多，已导出完整 SVG 矢量长图，放大不失真。`
        : `已保存 ${result.width} × ${result.height} 超清图片，完整包含 ${result.count} 份祝福。`);
    } catch (error) { if (active(context)) setNotice(error.message); }
    finally { if (active(context)) setExporting(false); }
  }

  return <main className="birthday-wall" id="main-content">
    <div className="birthday-ambient" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
    <section className="birthday-statistics" aria-label="生日墙数据统计">
      <div><strong>{wallId && (loading || !readyWall) ? "—" : (wallId ? stats.total : 0).toLocaleString("zh-CN")}</strong><span>份暖心祝福</span></div>
    </section>
    <header className={`birthday-hero ${readyWall ? "birthday-hero-personal" : ""}`}>
      <div className="birthday-hero-kicker"><span /><Heart size={15} weight="fill" /> 每一个你，都值得被祝福 <span /></div>
      <h1>{readyWall ? <><span className="birthday-honoree">{readyWall.name}</span><span className="birthday-personal-title">的生日墙</span></> : <>生日<span>墙</span></>}<Sparkle size={34} weight="duotone" aria-hidden="true" /></h1>
      <p>{wallId ? <>把想说的话，变成一张小小的便签。<br />愿这一墙的温柔，陪你走进新的一岁。</> : <>输入寿星的名字，开启一面专属生日墙。<br />把链接发给朋友，让祝福从四面八方而来。</>}</p>
      {wallId && <div className="birthday-hero-actions"><button className="birthday-write-button" type="button" onClick={openComposer} disabled={!readyWall || loading || Boolean(loadError)}><PencilSimple size={18} /> 写下我的祝福 <Heart size={17} weight="fill" /></button><button className="birthday-share-button" type="button" onClick={shareWall} disabled={!readyWall} aria-haspopup="dialog"><QrCode size={18} /> 分享生日墙</button></div>}
      <div className="birthday-hero-doodle left" aria-hidden="true">✧<span>🎈</span>✦</div><div className="birthday-hero-doodle right" aria-hidden="true">✦<span>🎂</span>✧</div>
    </header>
    <div className="birthday-content">
      {notice && <div className="birthday-notice" role="status"><CheckCircle size={19} /><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
      {!wallId ? <>
        <section className="birthday-create-card" aria-labelledby="birthday-create-heading">
          <div className="birthday-create-icon" aria-hidden="true">🎂</div><h2 id="birthday-create-heading">为 TA 留一面生日墙</h2><p>每一面新墙都是空白的，等待专属于寿星的祝福。</p>
          {ownerId ? <form onSubmit={createWall}><label htmlFor="birthday-honoree-name">寿星姓名<input id="birthday-honoree-name" ref={createRef} value={sameSession ? createDraft.name || "" : ""} onChange={(event) => changeCreateName(event.target.value)} maxLength={40} placeholder="输入寿星的名字" required disabled={creating || !sameSession} autoComplete="off" /></label>{createError && <p className="birthday-submit-error" role="alert">{createError}</p>}<button type="submit" disabled={creating || !sameSession || !createDraft.name?.trim()}>{creating ? <SpinnerGap size={18} className="birthday-spin" /> : <Plus size={18} />}{creating ? "正在创建专属生日墙…" : "创建专属生日墙"}</button></form> : <button type="button" onClick={() => openAuth?.("login")}><Heart size={18} /> 登录并创建生日墙</button>}
          <small>专属链接 · 好友免登录送祝福 · 一键高清留念</small>
        </section>
        {ownerId && <section className="birthday-my-walls" aria-labelledby="birthday-mine-title"><header><h2 id="birthday-mine-title">我的生日墙</h2><button type="button" disabled={loading} onClick={() => refresh()} aria-label="刷新我的生日墙"><ArrowClockwise size={18} /></button></header>{loadError ? <p role="alert" className="birthday-submit-error">{loadError}</p> : loading || !sameSession ? <p>正在打开你的生日墙…</p> : visibleWalls.length ? <div>{visibleWalls.map((item) => <button type="button" key={item.id} onClick={() => openWall(`/birthday-wall/${encodeURIComponent(item.id)}`)}><span aria-hidden="true">🎈</span><span><strong>{item.name}的生日墙</strong><small>创建于 {readableDate(item.createdAt)}</small></span><ArrowRight size={18} /></button>)}</div> : <p>还没有生日墙，写下名字，创建第一面吧。</p>}</section>}
      </> : <>
        {readyWall && <BirthdayArtwork key={`${wallId}:${ownerId}`} user={user} openAuth={openAuth} wallId={wallId} wallName={readyWall.name} onArtworkChange={setArtwork} />}
        {artwork && readyWall && <div className="birthday-artwork-banner"><img src={artwork} alt="Codex 为生日墙绘制的专属生日画面" /><span><Sparkle size={15} /> 专属生日画面 · 将随祝福一起导出</span></div>}
        <section className="birthday-notes-section" aria-labelledby="birthday-notes-heading">
          <div className="birthday-wall-toolbar"><div><h2 id="birthday-notes-heading"><Confetti size={24} weight="duotone" /> 心意在这里相遇</h2><p>每一张便签，都是一份独一无二的祝福。</p></div><div className="birthday-export-actions"><button type="button" onClick={exportWall} disabled={exporting || loading || Boolean(loadError) || !readyWall}>{exporting ? <SpinnerGap className="birthday-spin" size={18} /> : <DownloadSimple size={18} />}{exporting ? "正在制作超清图片…" : "导出超清图片"}</button><small>4K 起 · 保留全部祝福 · 可放大阅读</small></div></div>
          {loadError ? <div className="birthday-empty birthday-load-error" role="alert"><p>{loadError}</p><button type="button" onClick={() => refresh()}><ArrowClockwise size={18} /> 重新加载生日墙</button></div>
            : loading || !readyWall ? <div className="birthday-empty" role="status"><SpinnerGap size={32} className="birthday-spin" /><p>正在收集大家的心意…</p></div>
              : notes.length === 0 ? <div className="birthday-empty"><div className="birthday-empty-cards" aria-hidden="true"><i>💛</i><i>🎂</i><i>✨</i></div><h3>第一份祝福，等你写下</h3><p>这是一面全新的生日墙，把专属链接分享给朋友吧。</p><button type="button" onClick={openComposer}>送出第一份祝福 <ArrowDown size={17} /></button></div>
                : <div className="birthday-note-grid">{notes.map((note, index) => <article className="birthday-note" key={note.id} style={{ "--note-color": birthdayNoteColor(note.color, index), "--note-rotation": `${[-1.2, 0.8, -0.5, 1.1, -0.8, 0.4][index % 6]}deg` }}><span className="birthday-note-tape" aria-hidden="true" /><div className="birthday-note-emoji" aria-hidden="true">{noteEmojis(note.emojis)}</div><p>{note.message}</p><footer><span><Heart size={14} weight="fill" /> {note.name || "一位祝福你的朋友"}</span><time dateTime={note.createdAt}>{readableDate(note.createdAt)}</time></footer></article>)}</div>}
        </section>
      </>}
      <footer className="birthday-page-footer"><span>✧</span> 岁岁常欢愉，年年皆胜意 <span>✧</span></footer>
    </div>
    {shareOpen && readyWall && <BirthdayShareDialog key={`${wallId}:${ownerId}`} wall={readyWall} onClose={() => setShareOpen(false)} />}
    <div className="birthday-orb-dock"><button className="birthday-magic-orb" type="button" aria-label={wallId ? "打开七彩魔法球，写下生日祝福" : "创建专属生日墙"} aria-haspopup={wallId ? "dialog" : undefined} aria-expanded={wallId ? composerOpen : undefined} onClick={openComposer}><span className="birthday-orb-sphere"><Sparkle size={34} weight="fill" /><i /><i /><i /></span><span className="birthday-orb-label">{wallId ? "写祝福" : "创建生日墙"}</span></button><button className="love-letter-orb" type="button" aria-label="打开红心水晶球，写情书" aria-haspopup="dialog" aria-expanded={letterOpen} onClick={openLetter}><span className="love-letter-orb-sphere" aria-hidden="true"><span>💓</span><i /><i /></span><span className="birthday-orb-label">写情书</span></button></div>
    {letterOpen && <LoveLetterComposer key={`${wallId}:${ownerId}`} draftScope={`${ownerId || "guest"}:${wallId || "home"}`} onClose={() => setLetterOpen(false)} />}
    {composerOpen && readyWall && <ApplicationDialog title="送出你的生日祝福" eyebrow="一份心意，一张便签" description={`为 ${readyWall.name} 写下真心话，魔法球会为你配上表情和专属颜色。`} onClose={() => setComposerOpen(false)} busy={submitting} className="birthday-composer"><form className="birthday-wish-form" onSubmit={submit}><label htmlFor="birthday-name">你的名字 <small>（可不填）</small><input id="birthday-name" name="name" maxLength={40} value={name} onChange={(event) => changeDraft({ name: event.target.value })} placeholder="留个名字，让祝福更亲切" autoComplete="nickname" disabled={submitting} /></label><label htmlFor="birthday-message">想对 TA 说的话 <textarea id="birthday-message" ref={promptRef} name="message" value={message} onChange={(event) => changeDraft({ message: event.target.value })} placeholder="生日快乐！愿你新的一岁，心里有光，眼里有笑……" maxLength={500} rows={7} required disabled={submitting} /></label><div className="birthday-composer-hint"><span>🎂 ✨ 🎉 💛 自动装点你的心意</span><span>{message.length} / 500</span></div><p className="birthday-public-note">提交后，祝福和昵称会公开显示在这面墙上。</p>{submitError && <p className="birthday-submit-error" role="alert">{submitError}</p>}<button className="birthday-submit" type="submit" disabled={submitting || !message.trim()}>{submitting ? <SpinnerGap className="birthday-spin" size={20} /> : <Sparkle size={20} weight="fill" />}{submitting ? "正在贴上祝福…" : "把祝福贴上墙"}</button></form></ApplicationDialog>}
  </main>;
}
