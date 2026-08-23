import {
  ArrowRight,
  Bell,
  Briefcase,
  CheckCircle,
  Clock,
  Coins,
  CreditCard,
  File,
  HandCoins,
  LockKey,
  MagnifyingGlass,
  PaperPlaneRight,
  Paperclip,
  ShieldCheck,
  Sparkle,
  UploadSimple,
  UserPlus,
  UsersThree,
  Wallet,
  WechatLogo,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, formatMoney, localizedFetch } from "../api.js";
import { useConfirmDialog } from "./ConfirmDialog.jsx";

const taskStatus = {
  awaiting_payment: "待付款",
  pending_payment_review: "付款待审核",
  payment_rejected: "付款审核未通过",
  open: "等待接单",
  in_progress: "已被接单 · 正在处理中",
  submitted: "等待发布者验收",
  accepted: "已完成结算",
  cancelled: "已取消",
};

function formatDeadline(value) {
  return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function FilePicker({ label, files, onFiles }) {
  return <label className="worker-file-picker"><span><Paperclip size={21} />{label}</span><strong>{files.length ? `${files.length} 个文件` : "选择图片或附件"}</strong><input type="file" multiple accept="image/*,.pdf,.zip,.7z,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv" onChange={(event) => onFiles(Array.from(event.target.files || []).slice(0, 10))} />{files.length > 0 && <small>{files.map((file) => file.name).join("、")}</small>}</label>;
}

async function uploadTaskFiles(taskId, section, files) {
  for (const file of files) {
    const ticket = await apiFetch(`/api/worker/tasks/${taskId}/assets/presign`, {
      method: "POST",
      body: JSON.stringify({ section, filename: file.name, contentType: file.type || "application/octet-stream", bytes: file.size }),
    });
    const response = await localizedFetch(ticket.uploadUrl, { method: "PUT", headers: ticket.requiredHeaders, body: file });
    if (!response.ok) throw new Error(`附件“${file.name}”上传失败，请重试`);
    await apiFetch(`/api/worker/tasks/${taskId}/assets/${ticket.uploadId}/complete`, { method: "POST", body: "{}" });
  }
}

function WechatGate({ onSaved, onClose }) {
  const [wechatId, setWechatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await apiFetch("/api/account/wechat", { method: "PUT", body: JSON.stringify({ wechatId }) }); onSaved(result.wechatId); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><form className="worker-wechat-modal" onSubmit={save}><button className="modal-close" type="button" onClick={onClose}><X size={20} /></button><div className="worker-modal-icon"><WechatLogo size={30} weight="fill" /></div><span>CONTACT REQUIRED</span><h2>先填写你的微信号</h2><p>发布需求或接单前必须填写。普通用户需支付 2 元并通过人工审核后查看对方微信；管理员作为接单人时可直接查看发单人微信。</p><label><span>微信号</span><input autoFocus required minLength={5} maxLength={64} value={wechatId} onChange={(event) => setWechatId(event.target.value)} placeholder="请输入你的微信号" /></label>{error && <div className="form-error">{error}</div>}<button className="button primary full" disabled={busy}><ShieldCheck size={19} />{busy ? "正在安全保存" : "保存并继续"}</button></form></div>;
}

function WorkerPaymentDialog({ payment, onPayment, onClose, onPaid }) {
  const [mode, setMode] = useState(payment.kind === "contact" ? "offline" : "online");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(payment.status || "pending");

  useEffect(() => {
    if (payment.stage !== "online" || !payment.orderNo || status === "paid") return undefined;
    let cancelled = false;
    let announced = false;
    const refresh = async () => {
      try {
        const result = await apiFetch(`/api/billing/payments/${encodeURIComponent(payment.orderNo)}/status`);
        if (cancelled) return;
        const nextStatus = result.status || "pending";
        setStatus(nextStatus);
        if (nextStatus === "paid" && !announced) {
          announced = true;
          onPaid?.();
        }
      } catch { /* 下一轮继续查询，不打断用户扫码。 */ }
    };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [payment.stage, payment.orderNo, status, onPaid]);

  async function startOnline() {
    setBusy(true); setError("");
    try {
      const result = await apiFetch("/api/billing/orders", {
        method: "POST",
        body: JSON.stringify({ kind: "worker_task", provider: "wechat", taskId: payment.task.id }),
      });
      onPayment({ ...payment, ...result, stage: "online", status: result.status || "pending" });
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }

  async function confirmOffline() {
    setBusy(true); setError("");
    try {
      const result = payment.kind === "contact"
        ? await apiFetch(`/api/worker/contact-orders/${payment.order.id}/payment-submit`, { method: "POST", body: "{}" })
        : await apiFetch(`/api/worker/tasks/${payment.task.id}/payment-submit`, { method: "POST", body: "{}" });
      onPayment({ ...payment, stage: "submitted", order: result.order || { orderNo: result.orderNo, amountFen: payment.amountFen } });
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  if (payment.stage === "submitted" || payment.stage === "pending") return <div className="modal-backdrop"><section className="payment-modal offline-payment-modal worker-payment-modal"><button className="modal-close" onClick={onClose}><X size={20} /></button><div className="payment-logo"><Bell size={30} weight="fill" /></div><span className="payment-eyebrow">PAYMENT SUBMITTED</span><h2>已提交，等待管理员审核</h2><p>订单 <strong>{payment.order?.orderNo}</strong> 已进入审核队列。审核结果会在网站右上角和用户后台同步提醒。</p><div className="form-success">待审核 · {formatMoney(payment.amountFen)}</div><p className="offline-payment-urgent">请尽快添加客服微信并发送支付截图，以加速审核进度。</p><img className="payment-qr service-qr" src="/assets/customer-service-wechat-20260823.jpg" alt="古龙客服微信二维码" /><button className="button primary full" onClick={onClose}>我知道了</button></section></div>;
  if (payment.stage === "online" && status === "paid") return <div className="modal-backdrop"><section className="payment-modal payment-success-modal worker-payment-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose}><X size={20} /></button><div className="payment-logo"><CheckCircle size={30} weight="fill" /></div><span className="payment-eyebrow">PAYMENT SUCCEEDED</span><h2>任务预算支付成功</h2><p>微信支付已到账，任务已自动进入对应接单队列，无需等待人工审核。</p><div className="form-success">已支付 · {formatMoney(payment.amountFen)}</div><button className="button primary full" onClick={onClose}>查看任务状态</button></section></div>;
  if (payment.stage === "online") return <div className="modal-backdrop"><section className="payment-modal worker-payment-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose}><X size={20} /></button><div className="payment-logo"><WechatLogo size={30} weight="fill" /></div><span className="payment-eyebrow">WECHAT PAY</span><h2>微信支付任务预算</h2><p>订单 <strong>{payment.orderNo}</strong> 已安全创建。扫码支付成功后，任务会自动进入接单队列。</p>{payment.qrCodeDataUrl && <img className="payment-qr" src={payment.qrCodeDataUrl} alt="威客任务微信支付二维码" />}{payment.paymentUrl && !payment.qrCodeDataUrl && <a className="button primary full" href={payment.paymentUrl} target="_blank" rel="noreferrer">打开微信支付 <ArrowRight size={18} /></a>}<div className="offline-payment-summary"><span>{payment.task?.title || "威客任务预算"}</span><strong>{formatMoney(payment.amountFen)}</strong></div><div className="payment-polling"><span /><strong>正在确认支付结果</strong></div><small>本次为一次性付款，不会自动续费或自动扣款。</small></section></div>;

  const onlinePaymentPending = payment.task?.paymentStatus === "pending_online";
  return <div className="modal-backdrop"><section className={`payment-modal worker-payment-modal ${mode === "offline" ? "offline-payment-modal" : ""}`} role="dialog" aria-modal="true"><button className="modal-close" disabled={busy} onClick={onClose}><X size={20} /></button><div className="payment-logo">{mode === "online" ? <WechatLogo size={30} weight="fill" /> : <Wallet size={30} />}</div><span className="payment-eyebrow">WORKER ESCROW</span><h2>{payment.kind === "contact" ? "支付 2 元解锁联系方式" : "支付任务预算"}</h2><p>{payment.kind === "contact" ? "审核通过后，只向你显示本任务另一方的微信号。" : "微信支付到账后立即发布任务；也可选择线下支付并等待管理员确认。验收后系统按 80% / 20% 结算。"}</p>{payment.kind === "task" && <div className="payment-mode-tabs" role="tablist" aria-label="威客任务支付方式"><button type="button" role="tab" aria-selected={mode === "online"} className={mode === "online" ? "active" : ""} onClick={() => setMode("online")}><WechatLogo size={20} weight="fill" />微信在线支付</button><button type="button" role="tab" aria-selected={mode === "offline"} className={mode === "offline" ? "active" : ""} disabled={onlinePaymentPending} onClick={() => setMode("offline")}><ShieldCheck size={20} />线下支付</button></div>}{mode === "offline" && <img className="payment-qr enterprise-qr" src="/assets/enterprise-payment-qr.jpg" alt="古龙企业微信收款码" />}<div className="offline-payment-summary"><span>{payment.kind === "contact" ? "联系方式查看服务" : payment.task?.title || "威客任务预算"}</span><strong>{formatMoney(payment.amountFen)}</strong></div>{onlinePaymentPending && <div className="form-success">该任务已有待支付微信订单，请继续在线支付。</div>}{error && <div className="form-error">{error}</div>}<div className="payment-dialog-actions"><button className="button secondary" disabled={busy} onClick={onClose}>稍后支付</button><button className="button primary" disabled={busy} onClick={mode === "online" ? startOnline : confirmOffline}>{busy ? "正在处理" : mode === "online" ? <><CreditCard size={18} />创建微信订单</> : "我已支付"}</button></div></section></div>;
}

function AssetLinks({ task, section }) {
  const assets = (task.assets || []).filter((asset) => asset.section === section);
  if (!assets.length) return null;
  return <div className="worker-asset-list">{assets.map((asset) => <a key={asset.id} href={asset.downloadPath} target="_blank" rel="noreferrer"><File size={19} /><span>{asset.filename}</span><small>{(asset.bytes / 1024 / 1024).toFixed(1)} MB</small></a>)}</div>;
}

function AssignmentSelector({ value, onChange }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (value.type !== "user" || query.trim().length < 2) { setResults([]); setLoading(false); setError(""); return undefined; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const result = await apiFetch(`/api/worker/assignees?q=${encodeURIComponent(query.trim())}`);
        if (!cancelled) setResults(result.users || []);
      } catch (reason) { if (!cancelled) setError(reason.message); }
      finally { if (!cancelled) setLoading(false); }
    }, 320);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, value.type]);

  function chooseType(type) {
    setQuery(""); setResults([]); setError("");
    onChange({ type, user: null });
  }

  return <fieldset className="worker-assignment-selector"><legend>指定接单方式</legend><p>选择任务审核通过后由谁看到并接单。发布后不可修改。</p><div className="worker-assignment-options" role="radiogroup" aria-label="接单方式"><button type="button" className={value.type === "open" ? "active" : ""} aria-pressed={value.type === "open"} onClick={() => chooseType("open")}><Sparkle size={23} /><strong>公开接单</strong><span>所有符合条件的用户都能看到</span></button><button type="button" className={value.type === "user" ? "active" : ""} aria-pressed={value.type === "user"} onClick={() => chooseType("user")}><UserPlus size={23} /><strong>指定用户</strong><span>按昵称或邮箱搜索并邀请</span></button><button type="button" className={value.type === "platform_team" ? "active" : ""} aria-pressed={value.type === "platform_team"} onClick={() => chooseType("platform_team")}><UsersThree size={23} /><strong>平台团队</strong><span>仅管理员可见并统一接单</span></button></div>{value.type === "user" && <div className="worker-assignee-search"><label><span>搜索指定用户</span><div><MagnifyingGlass size={20} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入昵称或邮箱关键词，至少 2 个字符" /></div></label>{value.user && <div className="worker-selected-assignee"><CheckCircle size={22} weight="fill" /><div><strong>{value.user.displayName}</strong><span>{value.user.email || "未公开邮箱"}</span></div><button type="button" onClick={() => onChange({ type: "user", user: null })}>重新选择</button></div>}{loading && <p className="worker-assignee-hint">正在搜索用户……</p>}{error && <p className="worker-inline-error">{error}</p>}{!loading && query.trim().length >= 2 && !results.length && !error && <p className="worker-assignee-hint">没有找到匹配用户，请尝试昵称或邮箱的其他部分。</p>}{results.length > 0 && <div className="worker-assignee-results">{results.map((candidate) => <button type="button" key={candidate.id} className={value.user?.id === candidate.id ? "selected" : ""} onClick={() => onChange({ type: "user", user: candidate })}><span className="worker-assignee-avatar">{candidate.avatar ? <img src={candidate.avatar} alt="" /> : (candidate.displayName || "U").slice(0, 1)}</span><div><strong>{candidate.displayName}</strong><span>{candidate.email || "未公开邮箱"}{candidate.role === "admin" ? " · 管理员" : ""}</span></div><CheckCircle size={21} /></button>)}</div>}</div>}{value.type === "platform_team" && <div className="worker-platform-team-note"><ShieldCheck size={23} weight="fill" /><p>付款审核通过后，系统会提醒管理员团队；只有管理员账号能够看到并接下这项任务。</p></div>}</fieldset>;
}

function ContactAction({ task, onPayment, currentUser }) {
  const [contact, setContact] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const administratorContractor = currentUser?.role === "admin" && task.contractor?.id === currentUser?.id;
  async function load() {
    setBusy(true); setError("");
    try {
      const result = await apiFetch(`/api/worker/tasks/${task.id}/contact`);
      if (result.contact) setContact(result.contact);
      else if (result.status === "admin_access") setError("发单人尚未填写微信号，请联系平台处理。");
      else if (result.status === "pending") onPayment({ kind: "contact", stage: "pending", amountFen: 200, order: result.order, task });
      else {
        const created = await apiFetch(`/api/worker/tasks/${task.id}/contact-orders`, { method: "POST", body: "{}" });
        onPayment({ kind: "contact", stage: created.order.status === "pending" ? "pending" : "cashier", amountFen: 200, order: created.order, task });
      }
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (administratorContractor) load(); }, [administratorContractor, task.id]);
  if (!task.contractor) return null;
  return <div className="worker-contact-action">{contact ? <div className="worker-contact-revealed"><WechatLogo size={22} weight="fill" /><span>{contact.displayName}</span><strong>{contact.wechatId}</strong></div> : <button className="button small secondary" disabled={busy} onClick={load}>{administratorContractor ? <ShieldCheck size={18} /> : <WechatLogo size={18} />}{busy ? "正在读取" : administratorContractor ? "直接查看发单人微信" : "支付 2 元查看对方微信"}</button>}{error && <small className="worker-inline-error">{error}</small>}</div>;
}

function TaskCard({ task, mode, currentUser, onRefresh, onPayment, onNeedWechat }) {
  const confirmAction = useConfirmDialog();
  const [progress, setProgress] = useState(task.progress || 5);
  const [note, setNote] = useState(task.progressNote || "");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [deliveryFiles, setDeliveryFiles] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const isOwn = task.publisher?.id === currentUser?.id;
  async function claim() {
    setBusy("claim"); setError("");
    try { await apiFetch(`/api/worker/tasks/${task.id}/claim`, { method: "POST", body: "{}" }); await onRefresh(); }
    catch (reason) { if (reason.code === "WECHAT_REQUIRED") onNeedWechat(); else setError(reason.message); }
    finally { setBusy(""); }
  }
  async function updateProgress(event) {
    event.preventDefault(); setBusy("progress"); setError("");
    try { await apiFetch(`/api/worker/tasks/${task.id}/progress`, { method: "PATCH", body: JSON.stringify({ progress: Number(progress), note }) }); await onRefresh(); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }
  async function submitDelivery(event) {
    event.preventDefault(); setBusy("submit"); setError("");
    try { await uploadTaskFiles(task.id, "delivery", deliveryFiles); await apiFetch(`/api/worker/tasks/${task.id}/submit`, { method: "POST", body: JSON.stringify({ deliveryNote }) }); await onRefresh(); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }
  async function accept() {
    if (!await confirmAction({
      tone: "positive",
      eyebrow: "ACCEPT DELIVERY",
      title: "确认验收任务成果？",
      message: "验收后任务会立即完成结算，接单者获得预算的 80%，平台收取 20% 服务费。",
      detail: task.title,
      detailLabel: "任务",
      note: "请确认交付内容符合要求；结算完成后不可撤销。",
      confirmLabel: "验收并完成结算",
    })) return;
    setBusy("accept"); setError("");
    try { await apiFetch(`/api/worker/tasks/${task.id}/accept`, { method: "POST", body: "{}" }); await onRefresh(); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(""); }
  }
  return <article className={`worker-task-card ${task.status}`}><header><div><span className="worker-task-status">{taskStatus[task.status] || task.status}</span><h3>{task.title}</h3></div><strong>{formatMoney(task.budgetFen)}</strong></header><div className="worker-task-meta"><span><Clock size={19} />截止 {formatDeadline(task.deadline)}</span><span><ShieldCheck size={19} />接单者得 {formatMoney(task.contractorIncomeFen)}</span><span className={`worker-assignment-badge ${task.assignment?.type || "open"}`}><UsersThree size={19} />{task.assignment?.label || "公开接单"}</span></div><div className="worker-task-brief"><section><span>输入 · 任务说明</span><p>{task.inputDescription}</p><AssetLinks task={task} section="input" /></section><section><span>输出 · 预期结果</span><p>{task.outputDescription}</p>{task.exampleDescription && <blockquote>成品案例：{task.exampleDescription}</blockquote>}<AssetLinks task={task} section="output" /></section></div>{task.contractor && <div className="worker-person-row"><span>接单者</span><strong>{task.contractor.displayName}</strong><em>{task.progress}%</em></div>}{task.status === "in_progress" && <div className="worker-progress"><span style={{ width: `${task.progress}%` }} /></div>}{task.progressNote && <p className="worker-progress-note">进度说明：{task.progressNote}</p>}{task.deliveryNote && <div className="worker-delivery"><strong>交付说明</strong><p>{task.deliveryNote}</p><AssetLinks task={task} section="delivery" /></div>}{mode === "market" && task.status === "open" && <button className="button primary full" disabled={isOwn || busy === "claim"} onClick={claim}>{isOwn ? "这是我发布的任务" : busy === "claim" ? "正在接单" : "立即接单赚钱"}<ArrowRight size={19} /></button>}{mode === "published" && ["awaiting_payment", "payment_rejected"].includes(task.status) && <button className="button primary full" onClick={() => onPayment({ kind: "task", stage: "cashier", amountFen: task.budgetFen, task })}>{task.status === "payment_rejected" ? "调整后重新付款" : task.paymentStatus === "pending_online" ? "继续微信支付" : "支付任务预算"}</button>}{mode === "published" && task.status === "submitted" && <button className="button primary full" disabled={busy === "accept"} onClick={accept}><CheckCircle size={20} weight="fill" />{busy === "accept" ? "正在结算" : "验收通过并完成结算"}</button>}{mode === "claimed" && task.status === "in_progress" && <><form className="worker-progress-form" onSubmit={updateProgress}><label><span>任务进度</span><input type="range" min="5" max="99" value={progress} onChange={(event) => setProgress(event.target.value)} /><strong>{progress}%</strong></label><label><span>文字说明</span><textarea required minLength={2} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="说明已完成内容、当前阶段与下一步" /></label><button className="button secondary" disabled={busy === "progress"}>{busy === "progress" ? "正在保存" : "更新进度与说明"}</button></form><form className="worker-delivery-form" onSubmit={submitDelivery}><label><span>最终交付说明</span><textarea required minLength={10} maxLength={10000} value={deliveryNote} onChange={(event) => setDeliveryNote(event.target.value)} placeholder="说明交付内容、使用方法和验收要点" /></label><FilePicker label="交付图片与附件" files={deliveryFiles} onFiles={setDeliveryFiles} /><button className="button primary" disabled={busy === "submit"}><PaperPlaneRight size={19} />{busy === "submit" ? "正在提交" : "完成任务并提交验收"}</button></form></>}{["published", "claimed"].includes(mode) && <ContactAction task={task} onPayment={onPayment} currentUser={currentUser} />}{error && <div className="form-error">{error}</div>}</article>;
}

function TaskList({ view, mode, user, onPayment, onNeedWechat, refreshToken = 0 }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    if (!user) { setTasks([]); setLoading(false); return; }
    setLoading(true); setError("");
    try { const result = await apiFetch(`/api/worker/tasks?view=${view}`); setTasks(result.tasks || []); }
    catch (reason) { setError(reason.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [user?.id, view, refreshToken]);
  if (!user) return <div className="worker-empty"><LockKey size={36} /><h3>登录后继续</h3><p>登录古龙账号后即可查看真实任务、发布需求或接单赚钱。</p></div>;
  if (loading) return <div className="worker-empty"><span className="worker-loader" /><h3>正在读取真实任务</h3></div>;
  if (error) return <div className="form-error">{error}</div>;
  if (!tasks.length) return <div className="worker-empty"><Briefcase size={38} /><h3>{mode === "published" ? "还没有发布任务" : mode === "claimed" ? "还没有接单记录" : "暂时没有可接任务"}</h3><p>{mode === "market" ? "新任务审核通过后会第一时间出现在这里。" : "从威客页面开始你的第一笔任务协作。"}</p></div>;
  return <div className="worker-task-list">{tasks.map((task) => <TaskCard key={task.id} task={task} mode={mode} currentUser={user} onRefresh={load} onPayment={onPayment} onNeedWechat={onNeedWechat} />)}</div>;
}

export function WorkerManagementPanel({ user, navigate }) {
  const [tab, setTab] = useState("published");
  const [payment, setPayment] = useState(null);
  const [wechatGate, setWechatGate] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  return <section className="account-module worker-account-module"><header><div><span>GULONG WORKER MARKET</span><h2>威客管理</h2><p>发布任务内容不可修改；接单任务可持续更新进度、文字说明与最终交付。</p></div><button className="button primary" onClick={() => navigate("/worker?tab=publish")}>发布新需求</button></header><div className="worker-account-tabs" role="tablist"><button className={tab === "published" ? "active" : ""} onClick={() => setTab("published")}>我发布的任务</button><button className={tab === "claimed" ? "active" : ""} onClick={() => setTab("claimed")}>我接单的任务</button></div><TaskList view={tab} mode={tab} user={user} onPayment={setPayment} onNeedWechat={() => setWechatGate(true)} refreshToken={refreshToken} />{payment && <WorkerPaymentDialog payment={payment} onPayment={setPayment} onPaid={() => setRefreshToken((value) => value + 1)} onClose={() => setPayment(null)} />}{wechatGate && <WechatGate onSaved={() => setWechatGate(false)} onClose={() => setWechatGate(false)} />}</section>;
}

export function WorkerPage({ user, openAuth, navigate }) {
  const initialTab = new URLSearchParams(window.location.search).get("tab") === "earn" ? "earn" : "publish";
  const [tab, setTab] = useState(initialTab);
  const [wechatReady, setWechatReady] = useState(false);
  const [wechatGate, setWechatGate] = useState(false);
  const [inputFiles, setInputFiles] = useState([]);
  const [outputFiles, setOutputFiles] = useState([]);
  const [form, setForm] = useState({ inputDescription: "", outputDescription: "", exampleDescription: "", deadline: "", budgetYuan: "" });
  const [assignment, setAssignment] = useState({ type: "open", user: null });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [payment, setPayment] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    if (!user) return setWechatReady(false);
    apiFetch("/api/account/worker-profile").then((result) => setWechatReady(result.ready)).catch(() => setWechatReady(false));
  }, [user?.id]);
  const minimumDeadline = useMemo(() => { const date = new Date(Date.now() + 2 * 60 * 60_000); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }, []);
  function switchTab(next) { setTab(next); window.history.replaceState({}, "", `/worker?tab=${next}`); }
  async function publish(event) {
    event.preventDefault();
    if (!user) return openAuth("login");
    if (!wechatReady) return setWechatGate(true);
    if (assignment.type === "user" && !assignment.user) return setMessage("请先搜索并选择一位指定接单用户。");
    setBusy(true); setMessage("");
    let createdTask = null;
    try {
      const result = await apiFetch("/api/worker/tasks", { method: "POST", body: JSON.stringify({ ...form, budgetFen: Math.round(Number(form.budgetYuan) * 100), deadline: new Date(form.deadline).toISOString(), assignmentType: assignment.type, assigneeUserId: assignment.user?.id || undefined }) });
      createdTask = result.task;
      await uploadTaskFiles(result.task.id, "input", inputFiles);
      await uploadTaskFiles(result.task.id, "output", outputFiles);
      setForm({ inputDescription: "", outputDescription: "", exampleDescription: "", deadline: "", budgetYuan: "" }); setAssignment({ type: "open", user: null }); setInputFiles([]); setOutputFiles([]);
      setPayment({ kind: "task", stage: "cashier", amountFen: result.task.budgetFen, task: result.task });
      setRefreshToken((value) => value + 1);
    } catch (reason) { if (createdTask) await apiFetch(`/api/worker/tasks/${createdTask.id}/draft`, { method: "DELETE" }).catch(() => {}); if (reason.code === "WECHAT_REQUIRED") setWechatGate(true); else setMessage(reason.message); }
    finally { setBusy(false); }
  }
  return <main id="main-content" className="worker-page"><section className="worker-hero section-shell"><div><span><Sparkle size={18} weight="fill" />GULONG WORKER MARKET</span><h1>系统自动接单，<em>AI 攻城狮军团</em><br />帮你快速搞定</h1><p>把难题交给真正会做的人与智能体团队，清晰托管、持续追踪、超预期交付。任何用户既可以发布任务，也可以接单赚钱。</p><div><button className="button primary" onClick={() => switchTab("publish")}><PaperPlaneRight size={20} />发布需求</button><button className="button secondary" onClick={() => switchTab("earn")}><HandCoins size={20} />接单赚钱</button></div></div><aside><div><strong>80%</strong><span>验收后接单者收入</span></div><div><strong>20%</strong><span>平台托管服务费</span></div><div><strong>60%</strong><span>复用工作流双方分佣</span></div><small>复用收益按扣除成本、税后的纯利润计算：发布者 30% + 接单者 30%，平台 40%。</small></aside></section><section className="worker-shell section-shell"><nav className="worker-secondary-nav"><button className={tab === "publish" ? "active" : ""} onClick={() => switchTab("publish")}><PaperPlaneRight size={21} /><span>发布需求</span><small>托管预算，等待专业交付</small></button><button className={tab === "earn" ? "active" : ""} onClick={() => switchTab("earn")}><Coins size={21} /><span>接单赚钱</span><small>认领任务，更新进度并结算</small></button></nav>{tab === "publish" ? <div className="worker-publish-layout"><form className="worker-publish-form" onSubmit={publish}><div className="worker-form-heading"><span>01 · INPUT</span><h2>任务需要解决什么？</h2><p>说明背景、目标、已有资料和限制条件。发布后内容锁定，不支持修改。</p></div><label><span>输入 · 任务说明</span><textarea required minLength={10} maxLength={10000} value={form.inputDescription} onChange={(event) => setForm({ ...form, inputDescription: event.target.value })} placeholder="例如：需要分析现有客服对话，找出最常见的 10 类问题并设计自动回复工作流……" /></label><FilePicker label="输入图片与附件" files={inputFiles} onFiles={setInputFiles} /><div className="worker-form-heading output"><span>02 · OUTPUT</span><h2>什么结果才算完成？</h2><p>描述预期结果与可参考的成品案例，让接单者按同一标准交付。</p></div><label><span>输出 · 预期结果说明</span><textarea required minLength={10} maxLength={10000} value={form.outputDescription} onChange={(event) => setForm({ ...form, outputDescription: event.target.value })} placeholder="例如：交付分类报告、流程图、可导入古龙的工作流文件和使用说明……" /></label><label><span>成品案例</span><textarea maxLength={5000} value={form.exampleDescription} onChange={(event) => setForm({ ...form, exampleDescription: event.target.value })} placeholder="可选：描述你喜欢的参考效果、格式或质量标准" /></label><FilePicker label="案例图片与附件" files={outputFiles} onFiles={setOutputFiles} /><AssignmentSelector value={assignment} onChange={setAssignment} /><div className="worker-form-row"><label><span>截止时间</span><input required type="datetime-local" min={minimumDeadline} value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} /></label><label><span>预算价格（元）</span><input required type="number" min="1" max="50000" step="0.01" value={form.budgetYuan} onChange={(event) => setForm({ ...form, budgetYuan: event.target.value })} placeholder="例如 800" /></label></div>{message && <div className="form-error">{message}</div>}<button className="button primary full" disabled={busy}><ShieldCheck size={20} />{busy ? "正在创建并上传附件" : "发布并支付任务预算"}</button></form><aside className="worker-publish-guide"><span>ESCROW FLOW</span><h3>每一步都清楚，每一分钱都有状态</h3>{[["1", "提交并付款", "微信在线支付到账后自动发布，也可选择线下支付审核。"], ["2", "匹配接单", "按公开接单、指定用户或平台团队进入对应任务池。"], ["3", "进度可见", "接单者持续更新进度与文字说明。"], ["4", "验收结算", "验收后 80% 给接单者，平台服务费 20%。"], ["5", "沉淀工作流", "重复任务自动形成可复用工作流并参与利润分佣。"]].map(([n, title, text]) => <article key={n}><strong>{n}</strong><div><h4>{title}</h4><p>{text}</p></div></article>)}<div className="worker-privacy-note"><LockKey size={23} /><p>普通用户双方微信号默认保密，查看对方微信需支付 2 元并通过审核；管理员作为接单人时可直接查看发单人微信。</p></div></aside></div> : <TaskList view="market" mode="market" user={user} onPayment={setPayment} onNeedWechat={() => setWechatGate(true)} refreshToken={refreshToken} />}</section>{!user && <section className="worker-login-callout section-shell"><LockKey size={32} /><div><h2>登录后加入威客市场</h2><p>统一古龙账号即可发布需求、接单、查看进度和接收结算提醒。</p></div><button className="button primary" onClick={() => openAuth("login")}>登录继续</button></section>}{payment && <WorkerPaymentDialog payment={payment} onPayment={(next) => { setPayment(next); setRefreshToken((value) => value + 1); }} onPaid={() => setRefreshToken((value) => value + 1)} onClose={() => setPayment(null)} />}{wechatGate && <WechatGate onSaved={() => { setWechatReady(true); setWechatGate(false); }} onClose={() => setWechatGate(false)} />}</main>;
}
