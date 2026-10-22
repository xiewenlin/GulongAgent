import { CheckCircle, Copy, DownloadSimple, EnvelopeOpen, QrCode, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

export function letterDateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  return match ? `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日` : "";
}

export function letterPaperStyle(color) {
  const background = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#FFF8F2";
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const light = luminance(background);
  const contrast = (hex) => { const other = luminance(hex); return (Math.max(light, other) + .05) / (Math.min(light, other) + .05); };
  const dark = contrast("#FFFFFF") > contrast("#000000");
  const ink = dark ? "#FFFFFF" : contrast("#282023") >= 4.5 ? "#282023" : "#000000";
  const readable = (preferred) => contrast(preferred) >= 4.5 ? preferred : ink;
  return { "--letter-paper": background, "--letter-ink": ink, "--letter-muted": readable(dark ? "#FFFFFF" : "#53454B"), "--letter-rule": dark ? "#ffffff24" : "#60374520", "--letter-accent": readable(dark ? "#FFE3ED" : "#7E2549") };
}

export function LetterOrnaments() {
  return <><div className="love-letter-corner love-letter-corner-top" aria-hidden="true"><span>❦</span><i>✧</i></div><div className="love-letter-corner love-letter-corner-bottom" aria-hidden="true"><span>❦</span><i>♡</i></div></>;
}

export function LoveLetterShare({ letter }) {
  const validId = /^[A-Za-z0-9_-]{43}$/.test(letter?.id || "");
  const url = validId ? new URL(`/love-letter/${encodeURIComponent(letter.id)}`, window.location.origin).href : "";
  const [qrImage, setQrImage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copying, setCopying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef(null);
  const alive = useRef(false);
  const copyLock = useRef(false);
  const filename = `写给${String(letter?.recipientName || "你").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "你"}的情书-分享二维码.png`;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setQrImage(""); setError(""); setNotice("");
    if (!url) { setError("分享链接暂时不可用，请关闭后重新打开这封信。"); return; }
    QRCode.toDataURL(url, { width: 1024, margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((image) => { if (!cancelled) setQrImage(image); })
      .catch(() => { if (!cancelled) setError("二维码暂时生成失败，可以重试或先复制链接。"); });
    return () => { cancelled = true; };
  }, [url, attempt]);

  async function copyLink() {
    if (copyLock.current || !url) return;
    copyLock.current = true; setCopying(true); setNotice("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("manual-copy");
      await navigator.clipboard.writeText(url);
      if (alive.current) setNotice("链接已复制，发送给收信人即可阅读完整情书。");
    } catch {
      if (!alive.current) return;
      inputRef.current?.focus(); inputRef.current?.select();
      let copied = false;
      try { copied = Boolean(document.execCommand?.("copy")); } catch { /* Keep the selected link available. */ }
      setNotice(copied ? "链接已复制，发送给收信人即可阅读完整情书。" : "已选中链接，请长按或按 Ctrl+C 复制。");
    } finally { copyLock.current = false; if (alive.current) setCopying(false); }
  }

  return <section className="love-letter-share" aria-label="情书分享">
    <div className="love-letter-share-seal" aria-hidden="true"><EnvelopeOpen size={30} weight="duotone" /></div>
    <h3>把这份心意，送到 TA 身边</h3>
    <p className="love-letter-share-to">写给 <strong>{letter.recipientName}</strong> · 来自 {letter.senderName}</p>
    <div className="love-letter-qr" aria-busy={!qrImage && !error}>
      {qrImage ? <img src={qrImage} width="1024" height="1024" alt={`写给${letter.recipientName}的情书二维码，扫码可阅读完整内容`} /> : error ? <div role="alert"><QrCode size={34} /><p>{error}</p>{url && <button type="button" onClick={() => setAttempt((value) => value + 1)}>重新生成二维码</button>}</div> : <div role="status"><SpinnerGap size={30} className="love-letter-spin" /><p>正在生成专属二维码…</p></div>}
    </div>
    <p className="love-letter-share-caption">扫一扫，打开只想对你说的话</p>
    <label className="love-letter-link-label">情书专属链接<input ref={inputRef} value={url} readOnly aria-label="情书专属分享链接" onFocus={(event) => event.target.select()} /></label>
    <div className="love-letter-share-actions"><button type="button" onClick={copyLink} disabled={copying || !url}>{copying ? <SpinnerGap size={18} className="love-letter-spin" /> : <Copy size={18} />}复制链接</button>{qrImage ? <a href={qrImage} download={filename}><DownloadSimple size={18} />保存二维码图片</a> : <button type="button" disabled><DownloadSimple size={18} />保存二维码图片</button>}</div>
    <p className="love-letter-share-help">手机可长按二维码保存图片。持有链接的人可阅读，请只分享给收信人。</p>
    {url && <a className="love-letter-read-link" href={url} target="_blank" rel="noopener noreferrer">打开情书，看看收信人的阅读效果 <EnvelopeOpen size={17} /></a>}
    {notice && <p className="love-letter-share-notice" role="status"><CheckCircle size={18} />{notice}</p>}
  </section>;
}
