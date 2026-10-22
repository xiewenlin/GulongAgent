import { ArrowClockwise, EnvelopeOpen, Heart, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { apiFetch } from "../api.js";
import { LetterOrnaments, letterDateLabel, letterPaperStyle } from "./LoveLetterShare.jsx";
import "./love-letter.css";

export function LoveLetterPage({ letterId }) {
  const [letter, setLetter] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
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
    setLetter(null); setError(""); setLoading(true);
    if (!/^[A-Za-z0-9_-]{43}$/.test(letterId || "")) { setError("这封情书的链接不完整，请向写信人确认链接。"); setLoading(false); return () => controller.abort(); }
    apiFetch(`/api/love-letters/${encodeURIComponent(letterId)}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.letter?.id !== letterId) throw new Error("这封情书暂时无法打开，请检查链接后重试。");
        setLetter(result.letter);
      }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [letterId, attempt]);
  const currentLetter = letter?.id === letterId ? letter : null;

  return <main id="main-content" className="love-letter-reader">
    <div className="love-letter-reader-halo" aria-hidden="true" />
    <header className="love-letter-reader-heading"><div><EnvelopeOpen size={28} weight="duotone" /></div><p>有些心意，值得郑重写下</p><h1>给你的一封情书</h1><span>愿字里行间，都是你喜欢的温柔。</span></header>
    {loading ? <div className="love-letter-reader-state" role="status"><SpinnerGap size={30} className="love-letter-spin" /><p>正在轻轻打开这封信…</p></div> : error || !currentLetter ? <div className="love-letter-reader-state love-letter-reader-error" role="alert"><EnvelopeOpen size={32} /><p>{error || "暂时没有找到这封情书。"}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}><ArrowClockwise size={18} />重新打开</button></div> : <article className="love-letter-paper love-letter-paper-read" style={letterPaperStyle(currentLetter.backgroundColor)} aria-label={`来自${currentLetter.senderName}，写给${currentLetter.recipientName}的情书`}>
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
