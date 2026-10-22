import { CheckCircle, Copy, DownloadSimple, QrCode, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ApplicationDialog } from "./ConfirmDialog.jsx";

export function BirthdayShareDialog({ wall, onClose }) {
  const url = new URL(`/birthday-wall/${encodeURIComponent(wall.id)}`, window.location.origin).href;
  const [qrImage, setQrImage] = useState("");
  const [qrError, setQrError] = useState("");
  const [status, setStatus] = useState("");
  const [copying, setCopying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const input = useRef(null);
  const alive = useRef(false);
  const copyLock = useRef(false);
  const filename = `${String(wall.name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "专属"}的生日墙-分享二维码.png`;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setQrImage(""); setQrError("");
    QRCode.toDataURL(url, { width: 1024, margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((image) => { if (!cancelled) setQrImage(image); })
      .catch(() => { if (!cancelled) setQrError("二维码暂时生成失败，请重试或先复制链接分享。"); });
    return () => { cancelled = true; };
  }, [url, attempt]);

  async function copyLink() {
    if (copyLock.current) return;
    copyLock.current = true; setCopying(true); setStatus("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("manual-copy");
      await navigator.clipboard.writeText(url);
      if (alive.current) setStatus("链接已复制，发给朋友就能收集祝福啦！");
    } catch {
      if (!alive.current) return;
      input.current?.focus(); input.current?.select();
      let copied = false;
      try { copied = Boolean(document.execCommand?.("copy")); } catch { /* The selected link remains available for manual copy. */ }
      setStatus(copied ? "链接已复制，发给朋友就能收集祝福啦！" : "已选中链接，请长按或按 Ctrl+C 复制。");
    } finally {
      copyLock.current = false;
      if (alive.current) setCopying(false);
    }
  }

  return <ApplicationDialog title="分享生日墙" eyebrow="让祝福，从这里出发" description="扫码或打开链接，无需登录就能送上生日祝福。" onClose={onClose} className="birthday-share-dialog">
    <div className="birthday-share-card">
      <span className="birthday-share-confetti" aria-hidden="true">🎂 ✨ 💛</span>
      <h3>{wall.name}的生日墙</h3>
      <div className="birthday-share-qr" aria-busy={!qrImage && !qrError}>
        {qrImage ? <img src={qrImage} width="1024" height="1024" alt={`${wall.name}的生日墙分享二维码，扫码即可打开专属链接`} />
          : qrError ? <div role="alert"><QrCode size={38} /><p>{qrError}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重新生成二维码</button></div>
            : <div role="status"><SpinnerGap size={32} className="birthday-spin" /><p>正在生成分享二维码…</p></div>}
      </div>
      <p>扫一扫，把你的祝福贴上墙</p>
    </div>
    <label className="birthday-share-link">生日墙专属链接<input ref={input} readOnly value={url} onFocus={(event) => event.target.select()} aria-label="生日墙专属分享链接" /></label>
    <div className="birthday-share-actions">
      <button type="button" onClick={copyLink} disabled={copying}>{copying ? <SpinnerGap size={18} className="birthday-spin" /> : <Copy size={18} />}复制链接</button>
      {qrImage ? <a href={qrImage} download={filename}><DownloadSimple size={18} />保存二维码图片</a> : <button type="button" disabled><DownloadSimple size={18} />保存二维码图片</button>}
    </div>
    <p className="birthday-share-tip">手机也可以长按二维码，保存图片后分享给朋友。</p>
    {status && <p className="birthday-share-status" role="status"><CheckCircle size={17} />{status}</p>}
  </ApplicationDialog>;
}
