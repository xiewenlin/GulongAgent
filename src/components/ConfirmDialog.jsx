import { CheckCircle, ShieldWarning, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

const ConfirmDialogContext = createContext(null);

const DEFAULT_DIALOG = {
  tone: "warning",
  eyebrow: "PLEASE CONFIRM",
  title: "确认执行这个操作？",
  message: "请确认信息无误后继续。",
  confirmLabel: "确认继续",
  cancelLabel: "暂不操作",
};

function DialogIcon({ tone }) {
  if (tone === "danger") return <Trash size={28} weight="duotone" />;
  if (tone === "positive") return <CheckCircle size={28} weight="duotone" />;
  if (tone === "secure") return <ShieldWarning size={28} weight="duotone" />;
  return <WarningCircle size={28} weight="duotone" />;
}

export function ConfirmDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolverRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();

  const close = useCallback((accepted) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    resolve?.(accepted);
  }, []);

  const confirm = useCallback((options = {}) => new Promise((resolve) => {
    resolverRef.current?.(false);
    resolverRef.current = resolve;
    setDialog({ ...DEFAULT_DIALOG, ...options });
  }), []);

  useEffect(() => {
    if (!dialog) return undefined;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === "Escape") close(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [close, dialog]);

  useEffect(() => () => resolverRef.current?.(false), []);

  return <ConfirmDialogContext.Provider value={confirm}>
    {children}
    {dialog && <div className="modal-backdrop app-confirm-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close(false)}>
      <section className={`app-confirm-dialog ${dialog.tone}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <button className="modal-close" type="button" aria-label="关闭确认窗口" onClick={() => close(false)}><X size={20} /></button>
        <div className="app-confirm-heading">
          <div className="app-confirm-icon"><DialogIcon tone={dialog.tone} /></div>
          <div><span>{dialog.eyebrow}</span><h2 id={titleId}>{dialog.title}</h2></div>
        </div>
        <p id={descriptionId}>{dialog.message}</p>
        {dialog.detail && <div className="app-confirm-detail"><span>{dialog.detailLabel || "操作对象"}</span><strong>{dialog.detail}</strong></div>}
        {dialog.note && <div className="app-confirm-note"><WarningCircle size={20} weight="fill" /><span>{dialog.note}</span></div>}
        <div className="app-confirm-actions">
          <button ref={cancelButtonRef} className="button secondary" type="button" onClick={() => close(false)}>{dialog.cancelLabel}</button>
          <button className={`button ${dialog.tone === "danger" ? "danger" : "primary"}`} type="button" onClick={() => close(true)}>{dialog.confirmLabel}</button>
        </div>
      </section>
    </div>}
  </ConfirmDialogContext.Provider>;
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext);
  if (!confirm) throw new Error("useConfirmDialog 必须在 ConfirmDialogProvider 内使用");
  return confirm;
}
