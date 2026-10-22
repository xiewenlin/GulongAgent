import { ArrowClockwise, EnvelopeOpen, Heart, LockKey, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api.js";
import { LetterOrnaments, letterDateLabel, letterPaperStyle } from "./LoveLetterShare.jsx";
import "./love-letter.css";

export function LoveLetterPage({ letterId }) {
  const [letter, setLetter] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [passwordSet, setPasswordSet] = useState(false);
  const [password, setPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const context = useRef(null);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "有一封情书，想让你亲启";
    const restored = ["robots", "referrer"].map((name) => {
      let meta = document.head.querySelector(`meta[name="${name}"]`);
      const original = meta?.getAttribute("content"); const existed = Boolean(meta);
      if (!meta) { meta = document.createElement("meta"); meta.name = name; document.head.appendChild(meta); }
      meta.content = name === "robots" ? "noindex, nofollow, noarchive" : "no-referrer";
      return () => { if (!existed) meta.remove(); else if (original === null) meta.removeAttribute("content"); else meta.content = original; };
    });
    return () => { document.title = previousTitle; restored.forEach((restore) => restore()); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const current = { controller, letterId, locked: false }; context.current = current;
    setLetter(null); setError(""); setLoading(true); setPasswordSet(false); setPassword(""); setUnlockError(""); setUnlocking(false);
    if (!/^[A-Za-z0-9_-]{43}$/.test(letterId || "")) { setError("这封情书的链接不完整，请向写信人确认链接。"); setLoading(false); return () => controller.abort(); }
    apiFetch(`/api/love-letters/${encodeURIComponent(letterId)}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.locked !== true || typeof result.passwordSet !== "boolean") throw new Error("这封情书暂时无法安全打开，请稍后重试。");
        setPasswordSet(result.passwordSet);
      }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [letterId, attempt]);
  const currentLetter = letter?.id === letterId ? letter : null;

  async function unlock(event) {
    event.preventDefault();
    const current = context.current;
    if (!current || current.letterId !== letterId || current.controller.signal.aborted || current.locked || !passwordSet || !password) return;
    current.locked = true; setUnlocking(true); setUnlockError("");
    try {
      const result = await apiFetch(`/api/love-letters/${encodeURIComponent(letterId)}/unlock`, { method: "POST", body: JSON.stringify({ password }), signal: current.controller.signal });
      if (context.current !== current || current.controller.signal.aborted) return;
      if (result.letter?.id !== letterId) throw new Error("情书内容暂时无法确认，请稍后重试。");
      setLetter(result.letter); setPassword("");
    } catch (reason) { if (context.current === current && !current.controller.signal.aborted) setUnlockError(reason.message || "暂时无法打开情书，请稍后重试。"); }
    finally { current.locked = false; if (context.current === current && !current.controller.signal.aborted) setUnlocking(false); }
  }

  return <main id="main-content" className="love-letter-reader">
    <div className="love-letter-reader-halo" aria-hidden="true" />
    <header className="love-letter-reader-heading"><div><EnvelopeOpen size={28} weight="duotone" /></div><p>有些心意，值得郑重写下</p><h1>给你的一封情书</h1><span>愿字里行间，都是你喜欢的温柔。</span></header>
    {loading ? <div className="love-letter-reader-state" role="status"><SpinnerGap size={30} className="love-letter-spin" /><p>正在轻轻打开这封信…</p></div> : error ? <div className="love-letter-reader-state love-letter-reader-error" role="alert"><EnvelopeOpen size={32} /><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}><ArrowClockwise size={18} />重新打开</button></div> : !currentLetter ? passwordSet ? <form className="love-letter-password-card love-letter-unlock" onSubmit={unlock}><div className="love-letter-password-seal" aria-hidden="true"><LockKey size={30} weight="duotone" /></div><h2>这封信，等你亲启</h2><p>请输入写信人告诉你的查看密码，解锁这份专属心意。</p><label>查看密码<input type="password" name="password" autoComplete="off" aria-label="情书查看密码" value={password} onChange={(event) => { setPassword(event.target.value); setUnlockError(""); }} maxLength={256} required disabled={unlocking} placeholder="输入查看密码" /></label>{unlockError && <p className="love-letter-error" role="alert">{unlockError}</p>}<button className="love-letter-submit" type="submit" disabled={unlocking || !password}>{unlocking ? <SpinnerGap size={19} className="love-letter-spin" /> : <EnvelopeOpen size={19} />}{unlocking ? "正在打开情书…" : "解锁并阅读情书"}</button><small>不知道密码？请向写信人询问。刷新页面后需要重新输入。</small></form> : <div className="love-letter-password-card love-letter-unlock"><div className="love-letter-password-seal" aria-hidden="true"><LockKey size={30} weight="duotone" /></div><h2>这封信还需要一把钥匙</h2><p>写信人尚未设置查看密码。请联系原写信人，在写情书窗口中为这封信补设密码后，再重新打开。</p><button className="love-letter-password-back" type="button" onClick={() => setAttempt((value) => value + 1)}><ArrowClockwise size={18} />重新检查</button></div> : <article className="love-letter-paper love-letter-paper-read" style={letterPaperStyle(currentLetter.backgroundColor)} aria-label={`来自${currentLetter.senderName}，写给${currentLetter.recipientName}的情书`}>
      <LetterOrnaments />
      <div className="love-letter-paper-heading"><Heart size={22} weight="duotone" /><span>一封只想写给你的信</span><i /></div>
      <p className="love-letter-read-recipient">亲爱的 <strong>{currentLetter.recipientName}</strong>：</p>
      <div className="love-letter-read-content">{currentLetter.body}</div>
      <footer className="love-letter-signature"><span>愿所有温柔，都与你有关。</span><p>来自 <strong>{currentLetter.senderName}</strong></p><time dateTime={currentLetter.date}>{letterDateLabel(currentLetter.date)}</time></footer>
      <div className="love-letter-paper-ending" aria-hidden="true"><i />♡<i /></div>
    </article>}
    <p className="love-letter-reader-footer"><Heart size={13} weight="fill" /> 把心意，藏在这一字一句里 <Heart size={13} weight="fill" /></p>
  </main>;
}
