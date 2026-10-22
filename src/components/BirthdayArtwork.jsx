import { useEffect, useRef, useState } from "react";
import { MagicWand, SpinnerGap } from "@phosphor-icons/react";
import { apiFetch, createClientRequestId } from "../api.js";
import { useConfirmDialog } from "./ConfirmDialog.jsx";
import {
  BIRTHDAY_ARTWORK_PROMPT, BIRTHDAY_ARTWORK_REQUEST, BIRTHDAY_ARTWORK_TERMINAL, birthdayArtworkCanStartNew,
  birthdayArtworkDefiniteNoOrder, birthdayArtworkImage, birthdayArtworkNodeReady, birthdayArtworkPrice,
  birthdayArtworkStorageKey, readBirthdayArtworkRecord,
} from "../../shared/birthday-artwork.js";

const STATE_LABELS = { quoted: "等待确认绘图", submitting: "正在确认原订单", queued: "已排队，等待绘图", claimed: "绘图节点已接单", processing: "正在绘制生日背景", completed: "生日背景已生成，可随祝福一起高清导出", failed: "绘图未完成，订单已结束", cancelled: "绘图已取消", rejected: "余额不足，订单未扣款" };

export function BirthdayArtwork({ user, wallId, openAuth, onArtworkChange }) {
  const ownerId = String(user?.id || user?._id || "");
  const wallScope = String(wallId || "");
  const confirm = useConfirmDialog();
  const [record, setRecord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const session = useRef(null);
  const artworkCallback = useRef(onArtworkChange);
  artworkCallback.current = onArtworkChange;

  function active(context) { return session.current === context && !context.controller.signal.aborted; }
  async function call(context, path, body) {
    if (!active(context)) throw new Error("页面已关闭");
    const result = await apiFetch(path, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: context.controller.signal });
    if (!active(context)) throw new Error("页面已关闭");
    return result;
  }
  function save(context, next) {
    if (!active(context)) return false;
    try {
      const raw = JSON.stringify(next);
      window.localStorage.setItem(context.key, raw);
      if (window.localStorage.getItem(context.key) !== raw) throw new Error("保存失败");
    } catch {
      setStorageBlocked(true);
      throw new Error("浏览器无法保存订单恢复信息，请允许此网站存储后刷新。为避免重复扣费，本次不会继续提交新订单。");
    }
    context.record = next;
    setRecord(next);
    return true;
  }
  function consume(context, task) {
    if (!active(context)) return;
    if (!task?.id || !["queued", "claimed", "processing", ...BIRTHDAY_ARTWORK_TERMINAL].includes(task.status)) throw new Error("绘图订单状态暂时无法读取，请恢复原订单。");
    const next = { ...context.record, taskId: task.id, submitted: true, status: task.status };
    save(context, next);
    setMessage(STATE_LABELS[task.status]);
    if (task.status === "completed") artworkCallback.current?.(birthdayArtworkImage(task));
    if (task.error?.message) setMessage(task.error.message);
  }

  async function refresh(context) {
    if (!context.record?.taskId) return;
    const result = await call(context, `/api/codex-market/tasks/${context.record.taskId}`);
    consume(context, result.task);
  }

  useEffect(() => {
    const context = { ownerId, wallId: wallScope, key: birthdayArtworkStorageKey(ownerId, wallScope), controller: new AbortController(), record: null, locked: false };
    session.current = context;
    setBusy(false); setRecord(null); setError(""); setMessage(""); setStorageBlocked(false);
    artworkCallback.current?.(null);
    if (ownerId && wallScope) {
      try {
        context.record = readBirthdayArtworkRecord(window.localStorage.getItem(context.key), ownerId, wallScope);
        setRecord(context.record);
        if (context.record) setMessage(STATE_LABELS[context.record.status] || "有一笔待恢复的绘图请求");
        if (context.record?.taskId) {
          context.locked = true;
          setBusy(true);
          refresh(context).catch((reason) => { if (active(context)) setError(reason.message); }).finally(() => {
            context.locked = false;
            if (active(context)) setBusy(false);
          });
        }
      } catch (reason) { setStorageBlocked(true); setError(reason.message || "无法读取绘图恢复记录，请检查浏览器存储权限。"); }
    }
    const timer = window.setInterval(() => {
      if (!active(context) || context.locked || document.hidden || !context.record?.taskId || BIRTHDAY_ARTWORK_TERMINAL.has(context.record.status)) return;
      context.locked = true;
      refresh(context).then(() => { if (active(context)) setError(""); }).catch((reason) => { if (active(context)) setError(reason.message); }).finally(() => { context.locked = false; });
    }, 5000);
    return () => { context.controller.abort(); window.clearInterval(timer); };
  }, [ownerId, wallScope]);

  async function submit(context) {
    const current = context.record;
    // Durable intent precedes the mutation. A lost response can only replay
    // this exact quote/request pair, including after a browser reload.
    if (!current.submitted) save(context, { ...current, submitted: true, status: "submitting" });
    setMessage("正在提交绘图订单…");
    try {
      const result = await call(context, "/api/codex-market/tasks", { quoteId: current.quoteId, requestId: current.taskReq });
      consume(context, result.task);
    } catch (reason) {
      if (active(context) && reason.status === 402 && reason.code === "INSUFFICIENT_BALANCE") {
        save(context, { ...context.record, status: "rejected" });
        setMessage(STATE_LABELS.rejected);
      }
      if (active(context) && birthdayArtworkDefiniteNoOrder(reason)) {
        // The server definitively rejected this exact task before creation.
        // A new quotation is allowed only after another explicit user click.
        save(context, { ...context.record, submitted: false, status: null, quoteId: null, quoteReq: createClientRequestId(), taskReq: createClientRequestId() });
        setMessage("原报价已失效，订单未创建、未扣费。请重新点击绘图获取最新报价。");
      }
      throw reason;
    }
  }

  async function begin() {
    if (!wallScope) return;
    if (!ownerId) { openAuth?.(); return; }
    const context = session.current;
    if (!active(context) || context.locked || storageBlocked) return;
    context.locked = true; setBusy(true); setError("");
    try {
      if (context.record?.submitted && !BIRTHDAY_ARTWORK_TERMINAL.has(context.record.status)) {
        if (context.record.taskId) await refresh(context);
        else await submit(context);
        return;
      }
      const models = await call(context, "/api/codex-market/models");
      if (!birthdayArtworkNodeReady(models)) throw new Error("当前没有在线绘图节点，请稍后重试。本次未创建订单，也未扣费。");
      if (!context.record || birthdayArtworkCanStartNew(context.record)) {
        save(context, { version: 1, ownerId, wallId: wallScope, prompt: BIRTHDAY_ARTWORK_PROMPT, quoteReq: createClientRequestId(), taskReq: createClientRequestId(), quoteId: null, taskId: null, submitted: false, status: null });
      }
      let quote = await call(context, "/api/codex-market/quotes", { model: "longtu", requestId: context.record.quoteReq, request: BIRTHDAY_ARTWORK_REQUEST });
      if (new Date(quote.expiresAt).getTime() <= Date.now()) {
        // No task intent exists, so an expired quotation can be replaced.
        save(context, { ...context.record, quoteReq: createClientRequestId(), taskReq: createClientRequestId(), quoteId: null });
        quote = await call(context, "/api/codex-market/quotes", { model: "longtu", requestId: context.record.quoteReq, request: BIRTHDAY_ARTWORK_REQUEST });
      }
      const price = birthdayArtworkPrice(quote);
      save(context, { ...context.record, quoteId: quote.quoteId, status: "quoted" });
      if (!quote.affordable) throw new Error(`本次绘图需 ${price}，余额不足。尚未提交订单，请充值后再试。`);
      const accepted = await confirm({ tone: "positive", eyebrow: "生日画作", title: "生成专属生日背景", message: `通过古龙官网派单，使用 Codex 绘图。${price === "本次免费" ? "您的账号本次免扣费。" : `本次将从余额扣除 ${price}。`}`, detailLabel: "本次费用", detail: price, note: "只生成装饰画面，不发送任何人的祝福或姓名。祝福文字会在高清导出时清晰排版。", confirmLabel: "确认生成", cancelLabel: "暂不生成" });
      if (!accepted || !active(context)) return;
      if (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) throw new Error("报价已过期，尚未提交订单。请重新点击绘图获取最新报价。");
      await submit(context);
    } catch (reason) { if (active(context)) setError(reason.message); }
    finally { context.locked = false; if (active(context)) setBusy(false); }
  }

  async function cancel() {
    const context = session.current;
    if (!active(context) || context.locked || !context.record?.taskId) return;
    context.locked = true; setBusy(true); setError("");
    try {
      const accepted = await confirm({ title: "取消这次绘图？", eyebrow: "生日画作", message: "已扣除的订单费用会按原订单退回。", confirmLabel: "取消绘图", cancelLabel: "继续等待" });
      if (!accepted || !active(context)) return;
      try {
        const result = await call(context, `/api/codex-market/tasks/${context.record.taskId}/cancel`, {});
        consume(context, result.task);
      } catch (reason) { if (reason.code === "TASK_TERMINAL") await refresh(context); else throw reason; }
    } catch (reason) { if (active(context)) setError(reason.message); }
    finally { context.locked = false; if (active(context)) setBusy(false); }
  }

  async function viewOriginal() {
    const context = session.current;
    if (!active(context) || context.locked || !context.record?.taskId) return;
    context.locked = true; setBusy(true); setError("");
    try { await refresh(context); }
    catch (reason) { if (active(context)) setError(reason.message); }
    finally { context.locked = false; if (active(context)) setBusy(false); }
  }

  const waiting = record?.submitted && !BIRTHDAY_ARTWORK_TERMINAL.has(record.status);
  return <section className="birthday-artwork" aria-label="生日背景绘图">
    <div className="birthday-artwork-actions">
      <button type="button" className="button secondary" onClick={begin} disabled={busy || storageBlocked || !wallScope}>
        {busy ? <SpinnerGap size={18} className="agent-spin" /> : <MagicWand size={18} />}
        {!ownerId ? "登录并生成生日背景" : waiting ? "恢复 / 刷新绘图订单" : record?.status === "completed" ? "再画一张生日背景" : "Codex 绘制生日背景"}
      </button>
      {record?.taskId && !waiting && <button type="button" className="button secondary" onClick={viewOriginal} disabled={busy || storageBlocked}>查看原订单</button>}
      {waiting && record?.taskId && <button type="button" className="button secondary" onClick={cancel} disabled={busy || storageBlocked}>取消绘图</button>}
    </div>
    <div className="birthday-artwork-status" aria-live="polite">
      {message && <p>{message}</p>}
      {record?.taskId && <small>绘图订单：CM-{record.taskId}</small>}
      {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
