import { ArrowLeft, ArrowClockwise, EnvelopeSimple, Heart, LockKey, Palette, PaperPlaneTilt, PencilSimple, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { apiFetch, createClientRequestId } from "../api.js";
import { ApplicationDialog } from "./ConfirmDialog.jsx";
import { LetterOrnaments, letterDateLabel, letterPaperStyle, LoveLetterShare } from "./LoveLetterShare.jsx";
import "./love-letter.css";

const COLORS = [{ name: "奶油信笺", value: "#FFF8F2" }, { name: "玫瑰心语", value: "#FCE8EE" }, { name: "薰衣草", value: "#F0EAF8" }, { name: "晴空来信", value: "#EAF3FA" }, { name: "薄荷约定", value: "#EAF4ED" }, { name: "暖杏时光", value: "#FFF0DC" }];
const EMPTY = { senderName: "", recipientName: "", body: "", backgroundColor: COLORS[0].value };
function store(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The editor remains usable in memory. */ } }
function restore(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!value || typeof value !== "object") return EMPTY;
    const draft = { ...EMPTY };
    for (const field of ["senderName", "recipientName", "body"]) if (typeof value[field] === "string") draft[field] = value[field].slice(0, field === "body" ? 20000 : 60);
    if (/^#[0-9a-f]{6}$/i.test(value.backgroundColor || "")) draft.backgroundColor = value.backgroundColor;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.clientRequestId || "")) draft.clientRequestId = value.clientRequestId;
    if (/^[A-Za-z0-9_-]{43}$/.test(value.saved?.id || "")) draft.saved = value.saved;
    return draft;
  } catch { return EMPTY; }
}
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export function LoveLetterComposer({ draftScope = "guest", onClose }) {
  const draftKey = `gulong-love-letter-draft-v1:${draftScope}`;
  const [draft, setDraft] = useState(() => restore(draftKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState(today);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [savedStatus, setSavedStatus] = useState("checking");
  const [checkAttempt, setCheckAttempt] = useState(0);
  const alive = useRef(false);
  const lock = useRef(false);
  const request = useRef(null);
  const editor = useRef(null);
  const saved = draft.saved;
  const isReady = draft.senderName.trim() && draft.recipientName.trim() && draft.body.trim();

  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setDate(today()), 60_000);
    return () => { alive.current = false; request.current?.abort(); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!saved?.id) return;
    const controller = new AbortController();
    setSavedStatus("checking"); setError("");
    apiFetch(`/api/love-letters/${encodeURIComponent(saved.id)}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.locked !== true || typeof result.passwordSet !== "boolean") throw new Error("暂时无法确认情书的密码保护状态，请稍后重试。");
      setSavedStatus(result.passwordSet ? "protected" : "unprotected");
      if (result.passwordSet) setDraft((current) => { const next = { ...current, saved: { ...current.saved, passwordProtected: true } }; store(draftKey, next); return next; });
    }).catch((reason) => { if (!controller.signal.aborted) { setSavedStatus("error"); setError(reason.message); } });
    return () => controller.abort();
  }, [saved?.id, checkAttempt, draftKey]);
  useEffect(() => {
    const field = editor.current;
    if (!field) return;
    const fit = () => { field.style.height = "auto"; field.style.height = `${Math.max(270, field.scrollHeight)}px`; };
    fit();
    let width = field.clientWidth;
    const onResize = () => { if (field.clientWidth !== width) { width = field.clientWidth; fit(); } };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    observer?.observe(field);
    window.addEventListener("resize", onResize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", onResize); };
  }, [draft.body, Boolean(saved), passwordOpen]);

  function change(patch) {
    if (busy) return;
    setDraft((current) => { const next = { ...current, ...patch, clientRequestId: undefined, saved: undefined }; store(draftKey, next); return next; });
    setError("");
  }
  function beginPassword(event) {
    event.preventDefault();
    if (lock.current || busy || !isReady) return;
    setPassword(""); setConfirmation(""); setError(""); setPasswordOpen(true);
  }
  function returnToLetter() { if (busy) return; setPassword(""); setConfirmation(""); setError(""); setPasswordOpen(false); }
  async function submit(event) {
    event.preventDefault();
    if (lock.current || busy || (!saved && !isReady)) return;
    const passwordLength = [...password].length;
    if (passwordLength < 6 || passwordLength > 128) { setError("请设置 6–128 个字符的查看密码，可以使用任意字符。"); return; }
    if (password !== confirmation) { setError("两次输入的查看密码不一致，请重新确认。"); return; }
    lock.current = true; setBusy(true); setError("");
    const controller = new AbortController(); request.current = controller;
    const payload = { clientRequestId: draft.clientRequestId || createClientRequestId(), senderName: draft.senderName.trim(), recipientName: draft.recipientName.trim(), body: draft.body.trim(), backgroundColor: draft.backgroundColor };
    if (!saved) { setDraft(payload); store(draftKey, payload); }
    try {
      await apiFetch("/api/love-letters/session", { signal: controller.signal });
      if (saved) {
        await apiFetch(`/api/love-letters/${encodeURIComponent(saved.id)}/password`, { method: "POST", body: JSON.stringify({ password }), signal: controller.signal });
        if (!alive.current || controller.signal.aborted) return;
        const next = { ...draft, saved: { ...saved, passwordProtected: true } };
        setDraft(next); store(draftKey, next); setSavedStatus("protected"); setPassword(""); setConfirmation(""); setPasswordOpen(false);
        return;
      }
      const result = await apiFetch("/api/love-letters", { method: "POST", body: JSON.stringify({ ...payload, viewingPassword: password }), signal: controller.signal });
      if (!alive.current || controller.signal.aborted) return;
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.letter?.id || "") || result.url !== `/love-letter/${result.letter.id}`) throw new Error("情书已提交，分享结果暂时无法确认，请使用原内容再次提交以找回链接。");
      const next = { ...payload, saved: { ...result.letter, passwordProtected: true } };
      setDraft(next); store(draftKey, next); setPassword(""); setConfirmation(""); setPasswordOpen(false); setSavedStatus("protected");
    } catch (reason) {
      if (!alive.current || controller.signal.aborted) return;
      if (saved && reason.code === "LOVE_LETTER_PASSWORD_ALREADY_SET") {
        // A previous successful password write may have lost its response. Verify
        // protection again; never replace the original password on this path.
        setPassword(""); setConfirmation(""); setPasswordOpen(false); setSavedStatus("checking");
        setCheckAttempt((value) => value + 1);
      } else setError(reason.message || "情书暂时未能提交，请保留原内容后重试。");
    }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function writeAnother() {
    const next = { ...EMPTY, senderName: draft.senderName, backgroundColor: draft.backgroundColor };
    setDraft(next); store(draftKey, next); setError(""); setDate(today()); setPassword(""); setConfirmation(""); setPasswordOpen(false);
  }

  const passwordStage = passwordOpen || (saved && savedStatus === "unprotected");
  return <ApplicationDialog title={passwordStage ? "设置情书查看密码" : saved ? "情书已写好" : "写一封情书"} eyebrow="把心里的话，郑重写给你" description={passwordStage ? "为这份心意加一把锁，只让知道密码的人读到。" : saved ? "心意已珍藏，分享给那个特别的人。" : "一张信纸，一份认真，只为那个特别的人。"} onClose={onClose} busy={busy} className="love-letter-composer">
    {passwordStage ? <form className="love-letter-password-card" onSubmit={submit}><div className="love-letter-password-seal" aria-hidden="true"><LockKey size={30} weight="duotone" /></div><h3>{saved ? "为这封情书补上查看密码" : "这封信，只想让 TA 亲启"}</h3><p>{saved ? "这封旧情书还没有设置密码，设置完成后才能继续分享。" : "收信人扫描二维码或打开链接后，需要输入正确密码才能阅读。"}</p><label>查看密码<input type="password" name="viewingPassword" aria-label="设置查看密码" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} maxLength={256} required disabled={busy} placeholder="输入 6–128 个字符" /></label><label>再次确认密码<input type="password" name="confirmViewingPassword" aria-label="确认查看密码" autoComplete="new-password" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setError(""); }} maxLength={256} required disabled={busy} placeholder="再输入一次查看密码" /></label><div className="love-letter-password-note"><Heart size={17} weight="fill" /><span>请记住密码，并通过其他方式单独告诉收信人。二维码和分享链接中不会包含密码。</span></div>{error && <p className="love-letter-error" role="alert">{error}</p>}<button className="love-letter-submit" type="submit" disabled={busy || !password || !confirmation}>{busy ? <SpinnerGap size={19} className="love-letter-spin" /> : <LockKey size={19} />}{busy ? "正在保护这份心意…" : saved ? "设置密码并生成分享二维码" : "确认密码并提交情书"}</button>{!saved && <button className="love-letter-password-back" type="button" disabled={busy} onClick={returnToLetter}><ArrowLeft size={16} />返回修改情书</button>}</form>
      : saved ? <div className="love-letter-sent">{savedStatus === "protected" ? <LoveLetterShare key={saved.id} letter={{ ...saved, passwordProtected: true }} /> : <div className="love-letter-password-card" role={savedStatus === "error" ? "alert" : "status"}>{savedStatus === "error" ? <><LockKey size={30} /><p>{error}</p><button className="love-letter-password-back" type="button" onClick={() => setCheckAttempt((value) => value + 1)}><ArrowClockwise size={18} />重新检查密码保护</button></> : <><SpinnerGap size={30} className="love-letter-spin" /><p>正在确认情书的密码保护…</p></>}</div>}<button type="button" className="love-letter-another" onClick={writeAnother}><PencilSimple size={18} />再写一封情书</button></div> : <form className="love-letter-form" onSubmit={beginPassword}>
      <div className="love-letter-customize"><span><Palette size={19} /> 信纸颜色</span><div className="love-letter-palette" role="group" aria-label="选择信纸背景颜色">{COLORS.map((color) => <button key={color.value} type="button" aria-label={color.name} aria-pressed={draft.backgroundColor.toUpperCase() === color.value} title={color.name} style={{ backgroundColor: color.value }} disabled={busy} onClick={() => change({ backgroundColor: color.value })}>{draft.backgroundColor.toUpperCase() === color.value && <Heart size={14} weight="fill" />}</button>)}</div><label className="love-letter-color-input"><input type="color" aria-label="自定义信纸背景颜色" value={draft.backgroundColor} onChange={(event) => change({ backgroundColor: event.target.value })} disabled={busy} /><span>自定义</span></label></div>
      <article className="love-letter-paper love-letter-paper-editor" style={letterPaperStyle(draft.backgroundColor)}>
        <LetterOrnaments />
        <div className="love-letter-paper-heading"><EnvelopeSimple size={24} weight="duotone" /><span>一封只想写给你的信</span><i /></div>
        <label className="love-letter-recipient"><span>亲爱的</span><input aria-label="收件人" name="recipientName" value={draft.recipientName} onChange={(event) => change({ recipientName: event.target.value })} placeholder="收件人的名字" maxLength={60} required disabled={busy} autoComplete="off" /><span>：</span></label>
        <label className="love-letter-content-label"><span className="visually-hidden">情书正文</span><textarea ref={editor} aria-label="情书正文" name="body" value={draft.body} onChange={(event) => change({ body: event.target.value })} placeholder={"有些话，想慢慢写给你……\n\n从第一次相遇，到每一个平凡的日常，\n谢谢你，让我的世界变得温柔而明亮。"} maxLength={20000} required disabled={busy} /></label>
        <div className="love-letter-signature"><span>愿所有温柔，都与你有关。</span><label><span>来自</span><input aria-label="写信人" name="senderName" value={draft.senderName} onChange={(event) => change({ senderName: event.target.value })} placeholder="你的名字" maxLength={60} required disabled={busy} autoComplete="nickname" /></label><time dateTime={date}>{letterDateLabel(date)}</time></div>
        <div className="love-letter-paper-ending" aria-hidden="true"><i />♡<i /></div>
      </article>
      <div className="love-letter-compose-footer"><div><p>提交时设置查看密码，收信人输入正确密码后才能阅读。</p><span>草稿保留在当前浏览器标签页 · {draft.body.length.toLocaleString("zh-CN")} / 20,000 字</span></div><button className="love-letter-submit" type="submit" disabled={busy || !isReady}>{busy ? <SpinnerGap size={19} className="love-letter-spin" /> : <PaperPlaneTilt size={19} weight="fill" />}{busy ? "正在封存这份心意…" : "提交并设置查看密码"}</button></div>
      {error && <p className="love-letter-error" role="alert">{error}</p>}
    </form>}
  </ApplicationDialog>;
}
