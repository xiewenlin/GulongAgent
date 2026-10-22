import { EnvelopeSimple, Heart, Palette, PaperPlaneTilt, PencilSimple, SpinnerGap } from "@phosphor-icons/react";
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
  }, [draft.body, saved]);

  function change(patch) {
    if (busy) return;
    setDraft((current) => { const next = { ...current, ...patch, clientRequestId: undefined, saved: undefined }; store(draftKey, next); return next; });
    setError("");
  }
  async function submit(event) {
    event.preventDefault();
    if (lock.current || busy || !isReady) return;
    lock.current = true; setBusy(true); setError("");
    const controller = new AbortController(); request.current = controller;
    const payload = { clientRequestId: draft.clientRequestId || createClientRequestId(), senderName: draft.senderName.trim(), recipientName: draft.recipientName.trim(), body: draft.body.trim(), backgroundColor: draft.backgroundColor };
    setDraft(payload); store(draftKey, payload);
    try {
      await apiFetch("/api/love-letters/session", { signal: controller.signal });
      const result = await apiFetch("/api/love-letters", { method: "POST", body: JSON.stringify(payload), signal: controller.signal });
      if (!alive.current || controller.signal.aborted) return;
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.letter?.id || "") || result.url !== `/love-letter/${result.letter.id}`) throw new Error("情书已提交，分享结果暂时无法确认，请使用原内容再次提交以找回链接。");
      const next = { ...payload, saved: result.letter };
      setDraft(next); store(draftKey, next);
    } catch (reason) { if (alive.current && !controller.signal.aborted) setError(reason.message || "情书暂时未能提交，请保留原内容后重试。"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function writeAnother() {
    const next = { ...EMPTY, senderName: draft.senderName, backgroundColor: draft.backgroundColor };
    setDraft(next); store(draftKey, next); setError(""); setDate(today());
  }

  return <ApplicationDialog title={saved ? "情书已写好" : "写一封情书"} eyebrow="把心里的话，郑重写给你" description={saved ? "心意已珍藏，分享给那个特别的人。" : "一张信纸，一份认真，只为那个特别的人。"} onClose={onClose} busy={busy} className="love-letter-composer">
    {saved ? <div className="love-letter-sent"><LoveLetterShare key={saved.id} letter={saved} /><button type="button" className="love-letter-another" onClick={writeAnother}><PencilSimple size={18} />再写一封情书</button></div> : <form className="love-letter-form" onSubmit={submit}>
      <div className="love-letter-customize"><span><Palette size={19} /> 信纸颜色</span><div className="love-letter-palette" role="group" aria-label="选择信纸背景颜色">{COLORS.map((color) => <button key={color.value} type="button" aria-label={color.name} aria-pressed={draft.backgroundColor.toUpperCase() === color.value} title={color.name} style={{ backgroundColor: color.value }} disabled={busy} onClick={() => change({ backgroundColor: color.value })}>{draft.backgroundColor.toUpperCase() === color.value && <Heart size={14} weight="fill" />}</button>)}</div><label className="love-letter-color-input"><input type="color" aria-label="自定义信纸背景颜色" value={draft.backgroundColor} onChange={(event) => change({ backgroundColor: event.target.value })} disabled={busy} /><span>自定义</span></label></div>
      <article className="love-letter-paper love-letter-paper-editor" style={letterPaperStyle(draft.backgroundColor)}>
        <LetterOrnaments />
        <div className="love-letter-paper-heading"><EnvelopeSimple size={24} weight="duotone" /><span>一封只想写给你的信</span><i /></div>
        <label className="love-letter-recipient"><span>亲爱的</span><input aria-label="收件人" name="recipientName" value={draft.recipientName} onChange={(event) => change({ recipientName: event.target.value })} placeholder="收件人的名字" maxLength={60} required disabled={busy} autoComplete="off" /><span>：</span></label>
        <label className="love-letter-content-label"><span className="visually-hidden">情书正文</span><textarea ref={editor} aria-label="情书正文" name="body" value={draft.body} onChange={(event) => change({ body: event.target.value })} placeholder={"有些话，想慢慢写给你……\n\n从第一次相遇，到每一个平凡的日常，\n谢谢你，让我的世界变得温柔而明亮。"} maxLength={20000} required disabled={busy} /></label>
        <div className="love-letter-signature"><span>愿所有温柔，都与你有关。</span><label><span>来自</span><input aria-label="写信人" name="senderName" value={draft.senderName} onChange={(event) => change({ senderName: event.target.value })} placeholder="你的名字" maxLength={60} required disabled={busy} autoComplete="nickname" /></label><time dateTime={date}>{letterDateLabel(date)}</time></div>
        <div className="love-letter-paper-ending" aria-hidden="true"><i />♡<i /></div>
      </article>
      <div className="love-letter-compose-footer"><div><p>持有链接的人可阅读，请只分享给收信人。</p><span>草稿保留在当前浏览器标签页 · {draft.body.length.toLocaleString("zh-CN")} / 20,000 字</span></div><button className="love-letter-submit" type="submit" disabled={busy || !isReady}>{busy ? <SpinnerGap size={19} className="love-letter-spin" /> : <PaperPlaneTilt size={19} weight="fill" />}{busy ? "正在封存这份心意…" : "提交并生成分享二维码"}</button></div>
      {error && <p className="love-letter-error" role="alert">{error}</p>}
    </form>}
  </ApplicationDialog>;
}
