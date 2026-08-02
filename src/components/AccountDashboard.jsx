import {
  ArrowRight,
  Bell,
  Brain,
  Briefcase,
  Camera,
  ChatCircleText,
  CheckCircle,
  Clock,
  CreditCard,
  FloppyDisk,
  Gauge,
  Key,
  LockKey,
  PaperPlaneRight,
  Receipt,
  ShieldCheck,
  UploadSimple,
  UserCircle,
  Wallet,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, formatMoney } from "../api.js";
import { useConfirmDialog } from "./ConfirmDialog.jsx";
import { WorkerManagementPanel } from "./WorkerPages.jsx";

const dashboardMenu = [
  { id: "overview", label: "账户总览", icon: Gauge },
  { id: "brain", label: "第二大脑", icon: Brain },
  { id: "feedback", label: "我的反馈", icon: ChatCircleText },
  { id: "worker", label: "威客管理", icon: Briefcase },
  { id: "billing", label: "会员与充值", icon: CreditCard },
  { id: "profile", label: "个人资料", icon: UserCircle },
  { id: "minimax", label: "MiniMax 配置", icon: Key },
];

const statusText = {
  uploading: "正在上传",
  queued_for_analysis: "等待分析",
  analyzing: "正在分析",
  completed: "处理完成",
  failed: "处理失败",
  pending: "待支付",
  paid: "已支付",
  approved: "已通过",
  rejected: "已拒绝",
  open: "待处理",
  processing: "处理中",
  resolved: "已处理",
  closed: "已处理",
};

function EmptyPanel({ icon: Icon, title, text, action }) {
  return <div className="account-empty"><Icon size={34} weight="duotone" /><strong>{title}</strong><p>{text}</p>{action}</div>;
}

function BrainCard({ item }) {
  const done = item.status === "completed";
  const failed = item.status === "failed";
  return <article className={`account-brain-card ${done ? "done" : failed ? "failed" : ""}`}>
    <header><div className="account-file-icon"><Brain size={21} /></div><div><strong>{item.originalName}</strong><span>{new Date(item.createdAt).toLocaleString("zh-CN")} · {(item.size / 1024 / 1024).toFixed(1)} MB</span></div><em>{statusText[item.status] || item.status}</em></header>
    <div className="account-progress"><span style={{ width: `${item.progress}%` }} /></div>
    <div className="account-progress-meta"><span>处理进度</span><strong>{item.progress}%</strong></div>
    {item.result && <div className="account-result"><CheckCircle size={18} weight="fill" /><div><strong>分析结果</strong><p>{item.result}</p></div></div>}
    {item.feedback && <div className="account-result feedback"><ChatCircleText size={18} weight="fill" /><div><strong>古龙团队反馈</strong><p>{item.feedback}</p></div></div>}
    {!item.result && !item.feedback && <p className="account-waiting"><Clock size={16} /> 系统会在分析过程中持续更新这里，无需重复上传。</p>}
  </article>;
}

function FeedbackCard({ item }) {
  const status = item.status || "open";
  return <article className={`account-feedback-card ${status}`}>
    <header><div><span>反馈编号</span><strong>{item.id}</strong></div><em className={`status-pill ${status}`}>{statusText[status] || status}</em></header>
    <section><span>我的反馈</span><p>{item.message}</p></section>
    {item.screenshots?.length > 0 && <div className="account-feedback-screenshots">{item.screenshots.map((url, index) => <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer"><img src={url} alt={`反馈截图 ${index + 1}`} /></a>)}</div>}
    {(item.progress || item.response) && <div className="account-feedback-worklog"><strong>{status === "resolved" || status === "closed" ? "处理结果" : "当前处理进度"}</strong>{item.progress && <p>{item.progress}</p>}{item.response && <div><span>古龙团队回复</span><p>{item.response}</p></div>}</div>}
    {item.responseAttachments?.length > 0 && <div className="account-feedback-results">{item.responseAttachments.map((asset) => asset.kind === "video" ? <figure key={asset.id}><video controls preload="metadata" src={asset.url} /><figcaption>{asset.filename}</figcaption></figure> : <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><img src={asset.url} alt={asset.filename} /><span>{asset.filename}</span></a>)}</div>}
    {status === "open" && <p className="account-feedback-waiting"><Clock size={18} />反馈已进入待处理队列，我们会持续更新这里。</p>}
    <footer><time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time>{item.resolvedAt && <span>处理完成：{new Date(item.resolvedAt).toLocaleString("zh-CN")}</span>}</footer>
  </article>;
}

export function AccountDashboard({ user, openAuth, navigate, onUser }) {
  const confirmAction = useConfirmDialog();
  const [active, setActive] = useState(() => {
    const section = new URLSearchParams(window.location.search).get("section");
    return dashboardMenu.some((item) => item.id === section) ? section : "overview";
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [profile, setProfile] = useState({ displayName: "", username: "", bio: "", wechatId: "" });
  const [minimax, setMinimax] = useState({ apiKey: "" });
  const [busy, setBusy] = useState("");
  const [resubmission, setResubmission] = useState(null);

  async function load() {
    if (!user) { setLoading(false); return; }
    setLoading(true); setMessage("");
    try {
      const result = await apiFetch("/api/account/dashboard");
      setData(result);
      if (result.profile.role !== user.role || result.profile.edition?.key !== user.edition?.key) {
        onUser?.({ ...user, role: result.profile.role, edition: result.profile.edition });
      }
      setProfile({ displayName: result.profile.displayName || "", username: result.profile.username || "", bio: result.profile.bio || "", wechatId: result.profile.wechatId || "" });
      setMinimax({ apiKey: "" });
    } catch (error) { setMessage(error.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [user]);

  const activeUploads = useMemo(() => (data?.brainUploads || []).filter((item) => !["completed", "failed"].includes(item.status)).length, [data]);
  const completedUploads = useMemo(() => (data?.brainUploads || []).filter((item) => item.status === "completed").length, [data]);

  async function saveProfile(event) {
    event.preventDefault(); setBusy("profile"); setMessage("");
    try {
      const result = await apiFetch("/api/account/profile", { method: "PUT", body: JSON.stringify(profile) });
      onUser?.({ ...user, ...result.user });
      setData((current) => ({ ...current, profile: { ...current.profile, ...result.user } }));
      setMessage("个人资料已保存，网站右上角昵称已经同步更新。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function saveMiniMax(event) {
    event.preventDefault(); setBusy("minimax"); setMessage("");
    try {
      const result = await apiFetch("/api/account/integrations/minimax", { method: "PUT", body: JSON.stringify(minimax) });
      setData((current) => ({ ...current, minimax: result }));
      setMinimax((current) => ({ ...current, apiKey: "" }));
      setMessage("MiniMax 配置已加密保存，桌面端现在可以通过专用接口拉取。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function removeMiniMax() {
    if (!await confirmAction({
      tone: "danger",
      eyebrow: "DELETE MODEL CREDENTIAL",
      title: "删除 MiniMax 配置？",
      message: "删除后，网站将立即停止向桌面端提供这份模型配置。",
      note: "此操作不会删除你的 MiniMax 官方账号，但需要重新填写 API Key 才能恢复使用。",
      confirmLabel: "确认删除",
    })) return;
    await apiFetch("/api/account/integrations/minimax", { method: "DELETE" });
    setData((current) => ({ ...current, minimax: { configured: false, apiHost: "https://api.minimaxi.com/v1", model: "MiniMax-M3" } }));
    setMessage("MiniMax 配置已删除。");
  }

  async function uploadAvatar(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy("avatar"); setMessage("");
    try {
      const presigned = await apiFetch("/api/account/avatar/presign", { method: "POST", body: JSON.stringify({ filename: file.name, contentType: file.type, bytes: file.size }) });
      const upload = await fetch(presigned.uploadUrl, { method: "PUT", headers: presigned.requiredHeaders, body: file });
      if (!upload.ok) throw new Error("头像上传到腾讯云 COS 失败，请重试");
      const completed = await apiFetch(`/api/account/avatar/${presigned.uploadId}/complete`, { method: "POST", body: "{}" });
      setData((current) => ({ ...current, profile: { ...current.profile, avatar: completed.avatar } }));
      onUser?.({ ...user, avatar: completed.avatar });
      setMessage("头像已更新，并可通过桌面端资料接口自动同步。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function openNotification(notification) {
    setActive(notification.type?.startsWith("feedback_") ? "feedback" : notification.type?.startsWith("worker_") ? "worker" : notification.type === "administrator_role_granted" ? "overview" : "billing");
    if (!notification.readAt) {
      await apiFetch(`/api/account/notifications/${notification.id}/read`, { method: "POST", body: "{}" }).catch(() => {});
      setData((current) => ({ ...current, notifications: current.notifications.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item) }));
    }
  }

  async function resubmitOffline(event) {
    event.preventDefault();
    setBusy("resubmit"); setMessage("");
    try {
      await apiFetch(`/api/billing/offline-payments/${resubmission.order.id}/resubmit`, { method: "POST", body: JSON.stringify({ note: resubmission.note }) });
      setResubmission(null);
      await load();
      setActive("billing");
      setMessage("线下支付申请已重新提交，管理员会再次审核。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function cancelSubscription() {
    if (!await confirmAction({
      tone: "warning",
      eyebrow: "SUBSCRIPTION RENEWAL",
      title: "停止自动续订？",
      message: "当前会员权益会完整保留到本周期到期日，届时不再自动续费。",
      note: "你可以在到期前继续使用全部已开通的会员能力。",
      confirmLabel: "停止自动续订",
    })) return;
    try { await apiFetch("/api/billing/subscription/cancel", { method: "POST", body: "{}" }); setMessage("已关闭自动续订，本周期权益不受影响。"); await load(); }
    catch (error) { setMessage(error.message); }
  }

  if (!user) return <main id="main-content" className="account-gate section-shell"><LockKey size={42} weight="duotone" /><span>GULONG ACCOUNT</span><h1>登录你的古龙后台</h1><p>在一个地方查看第二大脑处理结果、会员、余额和模型配置。</p><button className="button primary" onClick={() => openAuth("login")}>登录继续</button></main>;
  if (loading) return <main id="main-content" className="account-loading section-shell"><span /><strong>正在装载你的古龙工作空间</strong></main>;

  const subscription = data?.subscription;
  const isMember = subscription?.status === "active";
  const accountRole = data?.profile.role || user.role || "user";
  const isAdmin = accountRole === "admin";
  const identityLabel = isAdmin ? "管理员" : isMember ? "订阅会员" : "普通用户";
  const editionName = data?.profile.edition?.name || user.edition?.name || "古龙版";
  const avatar = data?.profile.avatar || user.avatar || null;
  const unreadNotifications = (data?.notifications || []).filter((item) => !item.readAt);
  return <main id="main-content" className="account-page section-shell">
    <aside className="account-sidebar">
      <div className="account-identity"><div>{avatar ? <img src={avatar} alt="个人头像" /> : (data?.profile.displayName || data?.profile.username || "古").slice(0, 1).toUpperCase()}</div><span>MY GULONG</span><strong>{data?.profile.displayName || data?.profile.username || "古龙用户"}</strong><small>{data?.profile.email}</small><p className="account-identity-meta"><b>{editionName}</b><em className={isAdmin ? "admin" : ""}>{identityLabel}</em></p></div>
      <nav>{dashboardMenu.map((item) => { const Icon = item.icon; return <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => { setActive(item.id); setMessage(""); }}><Icon size={19} weight={active === item.id ? "fill" : "regular"} />{item.label}</button>; })}</nav>
      {isAdmin && <button className="account-admin-link" onClick={() => navigate("/admin")}><ShieldCheck size={20} /> 进入管理员后台 <ArrowRight size={17} /></button>}
    </aside>
    <section className="account-workspace">
      <header className="account-workspace-head"><div><span>PERSONAL CONSOLE</span><h1>{dashboardMenu.find((item) => item.id === active)?.label}</h1></div><button className="button small ghost" onClick={load}>刷新数据</button></header>
      {message && <div className={`account-message ${message.includes("已") || message.includes("现在") ? "success" : "error"}`}>{message}</div>}
      {unreadNotifications.length > 0 && <div className="account-notification-stack">{unreadNotifications.map((notification) => <button key={notification.id} onClick={() => openNotification(notification)}><Bell size={21} weight="fill" /><span><strong>{notification.title}</strong><small>{notification.message}{notification.reason ? ` 原因：${notification.reason}` : ""}</small></span><ArrowRight size={18} /></button>)}</div>}

      {active === "overview" && <>
        <div className="account-metric-grid"><article><Brain size={22} /><span>正在处理</span><strong>{activeUploads}</strong><small>第二大脑任务</small></article><article><CheckCircle size={22} /><span>完成分析</span><strong>{completedUploads}</strong><small>可查看结果与反馈</small></article><article><Wallet size={22} /><span>账户余额</span><strong>{formatMoney(data?.balanceFen || 0)}</strong><small>用于模型与工作流</small></article><article><ShieldCheck size={22} /><span>账号身份</span><strong>{identityLabel}</strong><small>{editionName}{isMember && subscription.currentPeriodEnd ? ` · 会员至 ${new Date(subscription.currentPeriodEnd).toLocaleDateString("zh-CN")}` : ""}</small></article></div>
        <div className="account-overview-grid"><section><header><div><span>SECOND BRAIN</span><h2>最近处理进度</h2></div><button onClick={() => setActive("brain")}>查看全部 <ArrowRight size={15} /></button></header>{data?.brainUploads?.length ? data.brainUploads.slice(0, 2).map((item) => <BrainCard item={item} key={item.id} />) : <EmptyPanel icon={Brain} title="还没有第二大脑记录" text="上传 ZIP 后，分析进度和团队反馈会显示在这里。" action={<button className="button small secondary" onClick={() => navigate("/upload")}><UploadSimple size={16} /> 上传知识</button>} />}</section><section className="account-quick"><span>QUICK ACTIONS</span><h2>下一步做什么？</h2><button onClick={() => navigate("/upload")}><Brain size={20} /><div><strong>把知识带回古龙</strong><small>上传第二大脑 ZIP</small></div><ArrowRight size={16} /></button><button onClick={() => navigate("/pricing")}><CreditCard size={20} /><div><strong>订阅会员</strong><small>按月或按年自动续订</small></div><ArrowRight size={16} /></button><button onClick={() => setActive("minimax")}><Key size={20} /><div><strong>配置 MiniMax</strong><small>让桌面端自动拉取</small></div><ArrowRight size={16} /></button></section></div>
      </>}

      {active === "brain" && <section className="account-module"><header><div><span>KNOWLEDGE RETURN</span><h2>“把你的知识带回古龙”处理记录</h2><p>从上传、排队、分析到完成，全流程状态与反馈都在这里。</p></div><button className="button primary" onClick={() => navigate("/upload")}><UploadSimple size={17} /> 上传新知识</button></header>{data?.brainUploads?.length ? <div className="account-brain-list">{data.brainUploads.map((item) => <BrainCard item={item} key={item.id} />)}</div> : <EmptyPanel icon={Brain} title="等待你的第一份知识" text="将第二大脑存储目录压缩为 ZIP，上传后我们会持续更新处理状态。" />}</section>}

      {active === "feedback" && <section className="account-module account-feedback-module"><header><div><span>MY FEEDBACK</span><h2>我的反馈</h2><p>查看你提交的问题、处理进度、团队回复以及图片和视频结果。</p></div><button className="button primary" onClick={() => navigate("/feedback")}><ChatCircleText size={18} />提交新反馈</button></header>{data?.feedback?.length ? <div className="account-feedback-list">{data.feedback.map((item) => <FeedbackCard item={item} key={item.id} />)}</div> : <EmptyPanel icon={ChatCircleText} title="还没有反馈记录" text="提交问题或建议后，处理状态和结果会在这里持续更新。" action={<button className="button small secondary" onClick={() => navigate("/feedback")}>去提交反馈</button>} />}</section>}

      {active === "worker" && <WorkerManagementPanel user={user} navigate={navigate} />}

      {active === "billing" && <section className="account-module">
        <header><div><span>MEMBERSHIP & WALLET</span><h2>会员、余额与订单</h2><p>线上支付即将开通，微信支付将优先上线；当前会员订阅可使用线下支付并等待管理员审核。</p></div></header>
        <div className="account-billing-grid"><article className={isMember || isAdmin ? "member active" : "member"}><ShieldCheck size={27} weight="duotone" /><span>当前身份 · {editionName}</span><h3>{identityLabel}</h3><p>{isAdmin ? "管理员拥有古龙官网全部后台权限，会员订阅状态不会覆盖管理员身份。" : isMember ? `会员权益有效至 ${new Date(subscription.currentPeriodEnd).toLocaleString("zh-CN")}` : "升级后解锁第二大脑、完整工作流和本地模型能力。"}</p><button className="button primary full" onClick={() => isAdmin ? navigate("/admin") : navigate("/pricing")}>{isAdmin ? "进入管理员后台" : isMember ? "查看会员方案" : "立即订阅会员"}</button>{!isAdmin && isMember && subscription.autoRenew && !subscription.cancelAtPeriodEnd && <button className="text-button" onClick={cancelSubscription}>关闭到期自动续订</button>}</article><article className="wallet"><Wallet size={27} weight="duotone" /><span>可用余额</span><h3>{formatMoney(data?.balanceFen || 0)}</h3><p>余额可用于后续按量调用模型、技能和工作流。</p><button className="button secondary full" onClick={() => navigate("/pricing#recharge")}><CreditCard size={17} /> 单次充值</button></article></div>
        <div className="account-order-list"><h3><Receipt size={20} /> 最近订单</h3>{data?.orders?.length ? data.orders.map((order) => <article className={order.status === "rejected" ? "rejected" : ""} key={`${order.provider}-${order.id}`}><div className="account-order-main"><div><strong>{order.kind === "recharge" ? "账户充值" : order.cycle === "year" ? "年度会员" : "月度会员"}<small>{order.orderNo}</small></strong></div><span>{order.provider === "wechat" ? "微信" : order.provider === "alipay" ? "支付宝" : "线下支付"}</span><strong>{formatMoney(order.amountFen)}</strong><em>{order.provider === "offline" && order.status === "pending" ? "待审核" : statusText[order.status] || order.status}</em><time>{new Date(order.createdAt).toLocaleDateString("zh-CN")}</time></div>{order.status === "rejected" && <div className="account-order-rejection"><WarningCircle size={22} weight="fill" /><div><strong>审核未通过</strong><p>{order.reviewReason || "管理员暂未填写原因，请联系客服确认。"}</p></div><button className="button small primary" onClick={() => setResubmission({ order, note: "" })}>调整后重新申请</button></div>}{order.status === "pending" && order.resubmissionNote && <div className="account-order-resubmitted"><CheckCircle size={18} /> 已重新提交：{order.resubmissionNote}</div>}</article>) : <EmptyPanel icon={Receipt} title="还没有订单" text="订阅或充值完成后，交易记录会显示在这里。" />}</div>
      </section>}

      {active === "profile" && <section className="account-module"><header><div><span>PROFILE</span><h2>个人基本信息</h2><p>昵称会显示在网站右上角；头像保存到腾讯云 COS，并可同步到古龙桌面端。</p></div></header><form className="account-form" onSubmit={saveProfile}><label className="account-avatar-uploader"><div className="account-avatar-preview">{avatar ? <img src={avatar} alt="个人头像预览" /> : (profile.displayName || profile.username || "古").slice(0, 1).toUpperCase()}<span><Camera size={20} /></span></div><strong>{busy === "avatar" ? "正在上传" : "更换头像"}</strong><small>JPG / PNG / WebP / GIF，最大 10MB</small><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy === "avatar"} onChange={uploadAvatar} /></label><div className="account-form-fields"><label><span>昵称</span><input required maxLength={64} value={profile.displayName} onChange={(event) => setProfile({ ...profile, displayName: event.target.value })} placeholder="你希望大家如何称呼你" /></label><label><span>用户名</span><input minLength={3} maxLength={32} value={profile.username} onChange={(event) => setProfile({ ...profile, username: event.target.value })} placeholder="用于账户识别" /></label><label><span>邮箱</span><input value={data?.profile.email || ""} disabled /><small>邮箱由 Chandler 账号中心维护，官网不会绕过统一身份修改。</small></label><label><span>微信号</span><input minLength={5} maxLength={64} value={profile.wechatId} onChange={(event) => setProfile({ ...profile, wechatId: event.target.value })} placeholder="发单或接单前必须填写" /><small>默认保密；任务另一方需支付 2 元并审核通过后才能查看。</small></label><label><span>个人简介</span><textarea maxLength={240} value={profile.bio} onChange={(event) => setProfile({ ...profile, bio: event.target.value })} placeholder="简单介绍你的工作与希望古龙帮助你的方向" /></label><button className="button primary" disabled={busy === "profile"}><FloppyDisk size={17} /> {busy === "profile" ? "正在保存" : "保存个人资料"}</button></div></form></section>}

      {active === "minimax" && <section className="account-module"><header><div><span>PRIVATE MODEL CREDENTIAL</span><h2>MiniMax 配置</h2><p>界面与桌面端保持一致；密钥经 AES-256-GCM 加密保存，网页永不回显明文。</p></div><span className={`integration-state ${data?.minimax.configured ? "ready" : ""}`}>{data?.minimax.configured ? <><CheckCircle size={16} weight="fill" /> 已配置</> : <><WarningCircle size={16} /> 未配置</>}</span></header><div className="minimax-layout"><form className="account-form compact minimax-key-card" onSubmit={saveMiniMax}><div className="minimax-card-title"><div><h3>MiniMax 订阅 Key</h3><p>配置自己的订阅 Key，保存后自动连接官方最新 MiniMax-M3。</p></div><span>MiniMax-M3</span></div><label><span>订阅 Key</span><input type="password" minLength={data?.minimax.configured ? 0 : 8} value={minimax.apiKey} onChange={(event) => setMinimax({ apiKey: event.target.value })} placeholder={data?.minimax.configured ? `${data.minimax.maskedKey}（留空表示不修改）` : "sk-cp..."} /></label><div className="account-form-actions"><button className="button primary" disabled={busy === "minimax"}><FloppyDisk size={17} /> {busy === "minimax" ? "加密保存中" : "保存并应用"}</button>{data?.minimax.configured && <button type="button" className="button ghost" onClick={removeMiniMax}>删除配置</button>}</div></form><aside className="desktop-config-card"><div><LockKey size={25} /><span>DESKTOP API</span></div><h3>让桌面端安全拉取</h3><p>在“开发者”页面创建 API Key，再使用 Bearer 认证请求下面的接口。接口只返回该 Key 所属用户自己的配置。</p><code>GET /api/v1/configuration/minimax</code><ul><li><CheckCircle size={15} /> 权限：configuration:read</li><li><CheckCircle size={15} /> 固定模型：MiniMax-M3</li><li><CheckCircle size={15} /> 响应：Cache-Control no-store</li></ul><button className="button secondary full" onClick={() => navigate("/developer")}><Key size={17} /> 创建桌面端 API Key</button></aside></div></section>}
    </section>
    {resubmission && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && busy !== "resubmit" && setResubmission(null)}><form className="account-resubmit-modal" onSubmit={resubmitOffline}><button className="modal-close" type="button" disabled={busy === "resubmit"} onClick={() => setResubmission(null)}><X size={19} /></button><span>RESUBMIT OFFLINE PAYMENT</span><h2>调整后重新申请</h2><p>管理员拒绝原因：<strong>{resubmission.order.reviewReason}</strong></p><label><span>本次调整说明</span><textarea required minLength={2} maxLength={500} value={resubmission.note} onChange={(event) => setResubmission({ ...resubmission, note: event.target.value })} placeholder="例如：已补发付款截图，并核对了付款金额与订单号。" /></label><div className="account-resubmit-actions"><button className="button secondary" type="button" disabled={busy === "resubmit"} onClick={() => setResubmission(null)}>取消</button><button className="button primary" disabled={busy === "resubmit"}><PaperPlaneRight size={18} /> {busy === "resubmit" ? "正在提交" : "保存并重新申请"}</button></div></form></div>}
  </main>;
}
