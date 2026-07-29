import {
  ArrowRight,
  Brain,
  ChatCircleText,
  CheckCircle,
  Clock,
  CreditCard,
  FloppyDisk,
  Gauge,
  Key,
  LockKey,
  Receipt,
  ShieldCheck,
  UploadSimple,
  UserCircle,
  Wallet,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, formatMoney } from "../api.js";

const dashboardMenu = [
  { id: "overview", label: "账户总览", icon: Gauge },
  { id: "brain", label: "第二大脑", icon: Brain },
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
  resolved: "已回复",
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

export function AccountDashboard({ user, openAuth, navigate, onUser }) {
  const [active, setActive] = useState("overview");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [profile, setProfile] = useState({ displayName: "", username: "", bio: "" });
  const [minimax, setMinimax] = useState({ apiKey: "", apiHost: "https://api.minimax.chat/v1", model: "MiniMax-M2.1" });
  const [busy, setBusy] = useState("");

  async function load() {
    if (!user) { setLoading(false); return; }
    setLoading(true); setMessage("");
    try {
      const result = await apiFetch("/api/account/dashboard");
      setData(result);
      setProfile({ displayName: result.profile.displayName || "", username: result.profile.username || "", bio: result.profile.bio || "" });
      setMinimax({ apiKey: "", apiHost: result.minimax.apiHost || "https://api.minimax.chat/v1", model: result.minimax.model || "MiniMax-M2.1" });
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
    if (!window.confirm("确定删除已保存的 MiniMax 配置吗？桌面端将无法继续拉取。")) return;
    await apiFetch("/api/account/integrations/minimax", { method: "DELETE" });
    setData((current) => ({ ...current, minimax: { configured: false, apiHost: "https://api.minimax.chat/v1", model: "MiniMax-M2.1" } }));
    setMessage("MiniMax 配置已删除。");
  }

  async function cancelSubscription() {
    if (!window.confirm("本周期结束后停止自动续订？当前会员权益会保留到到期日。")) return;
    try { await apiFetch("/api/billing/subscription/cancel", { method: "POST", body: "{}" }); setMessage("已关闭自动续订，本周期权益不受影响。"); await load(); }
    catch (error) { setMessage(error.message); }
  }

  if (!user) return <main id="main-content" className="account-gate section-shell"><LockKey size={42} weight="duotone" /><span>GULONG ACCOUNT</span><h1>登录你的古龙后台</h1><p>在一个地方查看第二大脑处理结果、会员、余额和模型配置。</p><button className="button primary" onClick={() => openAuth("login")}>登录继续</button></main>;
  if (loading) return <main id="main-content" className="account-loading section-shell"><span /><strong>正在装载你的古龙工作空间</strong></main>;

  const subscription = data?.subscription;
  const isMember = subscription?.status === "active";
  return <main id="main-content" className="account-page section-shell">
    <aside className="account-sidebar">
      <div className="account-identity"><div>{(data?.profile.displayName || data?.profile.username || "古").slice(0, 1).toUpperCase()}</div><span>MY GULONG</span><strong>{data?.profile.displayName || data?.profile.username || "古龙用户"}</strong><small>{data?.profile.email}</small></div>
      <nav>{dashboardMenu.map((item) => { const Icon = item.icon; return <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => { setActive(item.id); setMessage(""); }}><Icon size={19} weight={active === item.id ? "fill" : "regular"} />{item.label}</button>; })}</nav>
      {user.role === "admin" && <button className="account-admin-link" onClick={() => navigate("/admin")}><ShieldCheck size={18} /> 进入管理员后台 <ArrowRight size={15} /></button>}
    </aside>
    <section className="account-workspace">
      <header className="account-workspace-head"><div><span>PERSONAL CONSOLE</span><h1>{dashboardMenu.find((item) => item.id === active)?.label}</h1></div><button className="button small ghost" onClick={load}>刷新数据</button></header>
      {message && <div className={`account-message ${message.includes("已") || message.includes("现在") ? "success" : "error"}`}>{message}</div>}

      {active === "overview" && <>
        <div className="account-metric-grid"><article><Brain size={22} /><span>正在处理</span><strong>{activeUploads}</strong><small>第二大脑任务</small></article><article><CheckCircle size={22} /><span>完成分析</span><strong>{completedUploads}</strong><small>可查看结果与反馈</small></article><article><Wallet size={22} /><span>账户余额</span><strong>{formatMoney(data?.balanceFen || 0)}</strong><small>用于模型与工作流</small></article><article><ShieldCheck size={22} /><span>会员状态</span><strong>{isMember ? "会员" : "普通用户"}</strong><small>{isMember && subscription.currentPeriodEnd ? `至 ${new Date(subscription.currentPeriodEnd).toLocaleDateString("zh-CN")}` : "可随时升级"}</small></article></div>
        <div className="account-overview-grid"><section><header><div><span>SECOND BRAIN</span><h2>最近处理进度</h2></div><button onClick={() => setActive("brain")}>查看全部 <ArrowRight size={15} /></button></header>{data?.brainUploads?.length ? data.brainUploads.slice(0, 2).map((item) => <BrainCard item={item} key={item.id} />) : <EmptyPanel icon={Brain} title="还没有第二大脑记录" text="上传 ZIP 后，分析进度和团队反馈会显示在这里。" action={<button className="button small secondary" onClick={() => navigate("/upload")}><UploadSimple size={16} /> 上传知识</button>} />}</section><section className="account-quick"><span>QUICK ACTIONS</span><h2>下一步做什么？</h2><button onClick={() => navigate("/upload")}><Brain size={20} /><div><strong>把知识带回古龙</strong><small>上传第二大脑 ZIP</small></div><ArrowRight size={16} /></button><button onClick={() => navigate("/pricing")}><CreditCard size={20} /><div><strong>订阅会员</strong><small>按月或按年自动续订</small></div><ArrowRight size={16} /></button><button onClick={() => setActive("minimax")}><Key size={20} /><div><strong>配置 MiniMax</strong><small>让桌面端自动拉取</small></div><ArrowRight size={16} /></button></section></div>
      </>}

      {active === "brain" && <section className="account-module"><header><div><span>KNOWLEDGE RETURN</span><h2>“把你的知识带回古龙”处理记录</h2><p>从上传、排队、分析到完成，全流程状态与反馈都在这里。</p></div><button className="button primary" onClick={() => navigate("/upload")}><UploadSimple size={17} /> 上传新知识</button></header>{data?.brainUploads?.length ? <div className="account-brain-list">{data.brainUploads.map((item) => <BrainCard item={item} key={item.id} />)}</div> : <EmptyPanel icon={Brain} title="等待你的第一份知识" text="将第二大脑存储目录压缩为 ZIP，上传后我们会持续更新处理状态。" />}</section>}

      {active === "billing" && <section className="account-module"><header><div><span>MEMBERSHIP & WALLET</span><h2>会员、余额与订单</h2><p>支持微信、支付宝充值，以及按月或按年自动续订。</p></div></header><div className="account-billing-grid"><article className={isMember ? "member active" : "member"}><ShieldCheck size={27} weight="duotone" /><span>当前身份</span><h3>{isMember ? "古龙会员" : "普通用户"}</h3><p>{isMember ? `权益有效至 ${new Date(subscription.currentPeriodEnd).toLocaleString("zh-CN")}` : "升级后解锁第二大脑、完整工作流和本地模型能力。"}</p><button className="button primary full" onClick={() => navigate("/pricing")}>{isMember ? "查看会员方案" : "立即订阅会员"}</button>{isMember && subscription.autoRenew && !subscription.cancelAtPeriodEnd && <button className="text-button" onClick={cancelSubscription}>关闭到期自动续订</button>}</article><article className="wallet"><Wallet size={27} weight="duotone" /><span>可用余额</span><h3>{formatMoney(data?.balanceFen || 0)}</h3><p>余额可用于后续按量调用模型、技能和工作流。</p><button className="button secondary full" onClick={() => navigate("/pricing#recharge")}><CreditCard size={17} /> 单次充值</button></article></div><div className="account-order-list"><h3><Receipt size={20} /> 最近订单</h3>{data?.orders?.length ? data.orders.map((order) => <article key={`${order.provider}-${order.id}`}><div><strong>{order.kind === "recharge" ? "账户充值" : order.cycle === "year" ? "年度会员" : "月度会员"}<small>{order.orderNo}</small></strong></div><span>{order.provider === "wechat" ? "微信" : order.provider === "alipay" ? "支付宝" : "线下支付"}</span><strong>{formatMoney(order.amountFen)}</strong><em>{statusText[order.status] || order.status}</em><time>{new Date(order.createdAt).toLocaleDateString("zh-CN")}</time></article>) : <EmptyPanel icon={Receipt} title="还没有订单" text="订阅或充值完成后，交易记录会显示在这里。" />}</div></section>}

      {active === "profile" && <section className="account-module"><header><div><span>PROFILE</span><h2>个人基本信息</h2><p>昵称会显示在网站右上角；邮箱由 Chandler 统一账号管理。</p></div></header><form className="account-form" onSubmit={saveProfile}><div className="account-avatar-preview">{(profile.displayName || profile.username || "古").slice(0, 1).toUpperCase()}</div><div className="account-form-fields"><label><span>昵称</span><input required maxLength={64} value={profile.displayName} onChange={(event) => setProfile({ ...profile, displayName: event.target.value })} placeholder="你希望大家如何称呼你" /></label><label><span>用户名</span><input minLength={3} maxLength={32} value={profile.username} onChange={(event) => setProfile({ ...profile, username: event.target.value })} placeholder="用于账户识别" /></label><label><span>邮箱</span><input value={data?.profile.email || ""} disabled /><small>邮箱由 Chandler 账号中心维护，官网不会绕过统一身份修改。</small></label><label><span>个人简介</span><textarea maxLength={240} value={profile.bio} onChange={(event) => setProfile({ ...profile, bio: event.target.value })} placeholder="简单介绍你的工作与希望古龙帮助你的方向" /></label><button className="button primary" disabled={busy === "profile"}><FloppyDisk size={17} /> {busy === "profile" ? "正在保存" : "保存个人资料"}</button></div></form></section>}

      {active === "minimax" && <section className="account-module"><header><div><span>PRIVATE MODEL CREDENTIAL</span><h2>MiniMax API Key</h2><p>密钥经 AES-256-GCM 加密保存；网页永不回显明文。</p></div><span className={`integration-state ${data?.minimax.configured ? "ready" : ""}`}>{data?.minimax.configured ? <><CheckCircle size={16} weight="fill" /> 已配置</> : <><WarningCircle size={16} /> 未配置</>}</span></header><div className="minimax-layout"><form className="account-form compact" onSubmit={saveMiniMax}><label><span>MiniMax API Key</span><input type="password" minLength={data?.minimax.configured ? 0 : 8} value={minimax.apiKey} onChange={(event) => setMinimax({ ...minimax, apiKey: event.target.value })} placeholder={data?.minimax.configured ? `${data.minimax.maskedKey}（留空表示不修改）` : "输入你的 MiniMax API Key"} /></label><label><span>API Host</span><input type="url" required value={minimax.apiHost} onChange={(event) => setMinimax({ ...minimax, apiHost: event.target.value })} /></label><label><span>默认模型</span><input required maxLength={100} value={minimax.model} onChange={(event) => setMinimax({ ...minimax, model: event.target.value })} /></label><div className="account-form-actions"><button className="button primary" disabled={busy === "minimax"}><FloppyDisk size={17} /> {busy === "minimax" ? "加密保存中" : "保存配置"}</button>{data?.minimax.configured && <button type="button" className="button ghost" onClick={removeMiniMax}>删除配置</button>}</div></form><aside className="desktop-config-card"><div><LockKey size={25} /><span>DESKTOP API</span></div><h3>让桌面端安全拉取</h3><p>在“开发者”页面创建 API Key，再使用 Bearer 认证请求下面的接口。接口只返回该 Key 所属用户自己的配置。</p><code>GET /api/v1/configuration/minimax</code><ul><li><CheckCircle size={15} /> 权限：configuration:read</li><li><CheckCircle size={15} /> 响应：Cache-Control no-store</li><li><CheckCircle size={15} /> 不支持管理员跨用户读取</li></ul><button className="button secondary full" onClick={() => navigate("/developer")}><Key size={17} /> 创建桌面端 API Key</button></aside></div></section>}
    </section>
  </main>;
}
