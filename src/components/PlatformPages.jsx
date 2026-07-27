import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle,
  CloudArrowDown,
  CloudArrowUp,
  Code,
  Copy,
  CreditCard,
  DownloadSimple,
  FileZip,
  Images,
  Key,
  LockKey,
  PaperPlaneTilt,
  Plus,
  ShieldCheck,
  Trash,
  UploadSimple,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, formatMoney } from "../api.js";
import { plans } from "../data/site.js";

function PageIntro({ eyebrow, title, description, actions }) {
  return (
    <section className="page-intro section-shell">
      <div><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-intro-actions">{actions}</div>}
    </section>
  );
}

function EmptyConfig({ children }) {
  return <div className="empty-config"><ShieldCheck size={22} /><span>{children}</span></div>;
}

export function DownloadPage() {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/downloads")
      .then((result) => setLinks(result.links || []))
      .catch(() => setLinks([]))
      .finally(() => setLoading(false));
  }, []);

  const providers = [
    { id: "feishu", name: "飞书下载", text: "适合企业团队与国内高速下载", accent: "jade" },
    { id: "quark", name: "夸克网盘", text: "移动端与桌面端均可便捷保存", accent: "gold" },
    { id: "baidu", name: "百度网盘", text: "覆盖广泛，支持提取码与断点续传", accent: "blue" },
  ];

  return (
    <main id="main-content">
      <PageIntro eyebrow="WINDOWS DESKTOP" title="下载古龙桌面版" description="完整离线安装，优先使用内置 Node、Git 与能力包；联网时仅在需要时修复组件。" />
      <section className="download-layout section-shell">
        <article className="download-primary">
          <div className="download-mark"><img src="/assets/gulong-dragon.png" alt="古龙" /></div>
          <div><span>Windows 10 / 11 · x64</span><h2>古龙 Gulong Agent Engine</h2><p>本地优先运行，内置插件、技能、工作流与恢复机制。下载后即可安装，无需额外配置开发环境。</p></div>
          <div className="release-meta"><span>最新稳定版</span><strong>v0.17.2</strong><small>完整离线安装包</small></div>
        </article>
        <div className="download-providers">
          {providers.map((provider) => {
            const link = links.find((item) => item.id === provider.id);
            return (
              <article key={provider.id} className={`download-provider ${provider.accent}`}>
                <div className="provider-icon"><CloudArrowDown size={25} /></div>
                <div><h3>{provider.name}</h3><p>{provider.text}</p>{link?.code && <small>提取码：{link.code}</small>}</div>
                {link?.url ? <a className="button small secondary" href={link.url} target="_blank" rel="noreferrer">开始下载 <ArrowRight size={15} /></a> : <button className="button small ghost" disabled>{loading ? "正在读取" : "链接准备中"}</button>}
              </article>
            );
          })}
        </div>
        <div className="download-note"><ShieldCheck size={22} /><div><strong>安装包安全说明</strong><p>下载后请核对官网公布的版本与 SHA-256。正式发行前需配置 Windows 代码签名证书，避免“未知发布者”提示。</p></div></div>
      </section>
    </main>
  );
}

export function DeveloperPage({ user, openAuth }) {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState("我的第一个应用");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [freshKey, setFreshKey] = useState(null);

  async function loadKeys() {
    if (!user) return setKeys([]);
    try {
      const result = await apiFetch("/api/developer/keys");
      setKeys(result.keys || []);
    } catch (reason) {
      setError(reason.message);
    }
  }

  useEffect(() => { loadKeys(); }, [user]);

  async function createKey(event) {
    event.preventDefault();
    if (!user) return openAuth("login");
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch("/api/developer/keys", {
        method: "POST",
        body: JSON.stringify({ name, scopes: ["tasks:read", "tasks:write", "workflows:read"] }),
      });
      setFreshKey(result.apiKey);
      setName("");
      await loadKeys();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(id) {
    await apiFetch(`/api/developer/keys/${id}`, { method: "DELETE" });
    await loadKeys();
  }

  const code = `curl -X POST https://your-domain.com/api/v1/tasks \\\n+  -H "Authorization: Bearer gla_live_..." \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"prompt":"分析这份需求并生成执行计划"}'`;

  return (
    <main id="main-content">
      <PageIntro
        eyebrow="GULONG OPEN PLATFORM"
        title="把古龙引擎接入你的产品"
        description="用一套安全、可审计的 API 调用任务执行、第二大脑与工作流能力。每位开发者都能生成独立 API Key。"
        actions={<><a className="button secondary" href="/api/docs" target="_blank" rel="noreferrer"><BookOpen size={18} /> 在线接口文档</a><a className="button primary" href="#api-keys"><Key size={18} /> 获取 API Key</a></>}
      />

      <section className="developer-hero section-shell">
        <div className="api-flow">
          {["Task", "Router", "Skills", "Memory", "Result"].map((item, index) => (
            <div key={item}><span>{index + 1}</span><strong>{item}</strong>{index < 4 && <ArrowRight size={18} />}</div>
          ))}
        </div>
        <div className="code-panel">
          <div className="code-panel-head"><span><i className="red" /><i className="yellow" /><i className="green" /></span><strong>创建第一个任务</strong><button type="button" onClick={() => navigator.clipboard?.writeText(code)}><Copy size={15} /> 复制</button></div>
          <pre>{code}</pre>
          <div className="code-response"><span>201 Created</span><code>{`{ "id": "task_...", "status": "queued" }`}</code></div>
        </div>
      </section>

      <section className="api-key-section section-shell" id="api-keys">
        <div className="section-heading"><span>DEVELOPER CONSOLE</span><h2>你的 API Key</h2><p>Key 只在创建时完整显示一次；服务端仅保存不可逆哈希。</p></div>
        {!user ? (
          <div className="login-gate"><LockKey size={32} /><h3>登录后创建 API Key</h3><p>使用用户名或邮箱登录，创建独立密钥并按应用管理权限。</p><button className="button primary" onClick={() => openAuth("login")}>登录开放平台</button></div>
        ) : (
          <div className="key-console">
            <form onSubmit={createKey} className="key-create"><label><span>Key 名称</span><input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={40} placeholder="例如：官网生产环境" /></label><button className="button primary" type="submit" disabled={busy}><Plus size={17} /> {busy ? "正在创建" : "创建 API Key"}</button></form>
            {error && <div className="form-error">{error}</div>}
            <div className="key-list">
              {keys.length === 0 && <EmptyConfig>还没有 API Key，先为你的第一个应用创建一个。</EmptyConfig>}
              {keys.map((item) => (
                <article key={item.id}><div className="key-badge"><Key size={18} /></div><div><strong>{item.name}</strong><code>{item.prefix}••••••••••</code><small>{(item.scopes || []).join(" · ")}</small></div><button type="button" aria-label={`撤销 ${item.name}`} onClick={() => revokeKey(item.id)}><Trash size={17} /></button></article>
              ))}
            </div>
          </div>
        )}
      </section>

      {freshKey && (
        <div className="modal-backdrop">
          <section className="secret-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={() => setFreshKey(null)}><X size={19} /></button><CheckCircle className="success-icon" size={34} weight="fill" /><h2>API Key 已创建</h2><p>这是唯一一次完整显示，请立即复制并保存到安全的密钥管理器。</p><div className="secret-value"><code>{freshKey.key}</code><button onClick={() => navigator.clipboard?.writeText(freshKey.key)}><Copy size={18} /></button></div><button className="button primary full" onClick={() => setFreshKey(null)}>我已安全保存</button></section>
        </div>
      )}
    </main>
  );
}

export function PricingPage({ user, openAuth, navigate }) {
  const [cycle, setCycle] = useState("month");
  const [provider, setProvider] = useState("wechat");
  const [autoRenew, setAutoRenew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [payment, setPayment] = useState(null);

  async function startPayment(plan) {
    if (!user) return openAuth("login");
    if (plan.id === "free") return navigate("/download");
    if (plan.id === "custom") return navigate("/feedback");
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch("/api/billing/orders", {
        method: "POST",
        body: JSON.stringify({ kind: "subscription", cycle, provider, autoRenew }),
      });
      if (result.paymentUrl?.startsWith("/")) navigate(result.paymentUrl);
      else setPayment(result);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content">
      <PageIntro eyebrow="SIMPLE PRICING" title="把成本花在真正困难的任务上" description="普通能力永久免费；会员解锁第二大脑、多端消息、本地模型与完整创作流水线。" />
      <section className="pricing-controls section-shell">
        <div className="cycle-switch"><button className={cycle === "month" ? "active" : ""} onClick={() => setCycle("month")}>按月订阅</button><button className={cycle === "year" ? "active" : ""} onClick={() => setCycle("year")}>按年订阅 <span>省 ¥1,377</span></button></div>
        <div className="provider-switch"><span>支付方式</span><button className={provider === "wechat" ? "active" : ""} onClick={() => setProvider("wechat")}>微信支付</button><button className={provider === "alipay" ? "active" : ""} onClick={() => setProvider("alipay")}>支付宝</button></div>
      </section>
      <section className="pricing-grid section-shell">
        {plans.map((plan) => (
          <article key={plan.id} className={plan.featured ? "featured" : ""}>
            {plan.featured && <span className="plan-ribbon">推荐</span>}
            <small>{plan.eyebrow}</small><h2>{plan.name}</h2>
            <div className="plan-price">{plan.pricing || formatMoney(cycle === "year" ? plan.yearlyFen : plan.monthlyFen)}{!plan.pricing && <em>/{cycle === "year" ? "年" : "月"}</em>}</div>
            {plan.subpricing && <p className="plan-subprice">{plan.subpricing}</p>}
            <ul>{plan.features.map((feature) => <li key={feature}><Check size={17} weight="bold" /> {feature}</li>)}</ul>
            {plan.id === "member" && <label className="auto-renew"><input type="checkbox" checked={autoRenew} onChange={(event) => setAutoRenew(event.target.checked)} /><span><strong>到期自动续订</strong><small>可随时取消；实际扣款需完成支付渠道签约。</small></span></label>}
            <button className={`button full ${plan.featured ? "primary" : "secondary"}`} disabled={busy} onClick={() => startPayment(plan)}>{plan.id === "free" ? "免费下载" : plan.id === "custom" ? "联系定制" : "立即开通"}</button>
          </article>
        ))}
      </section>
      {error && <div className="page-error section-shell">{error}</div>}
      <section className="recharge-callout section-shell"><div className="wallet-orb"><Wallet size={28} /></div><div><h3>单次充值</h3><p>不订阅也可以按需充值余额，后续用于按量调用模型与工作流。</p></div><button className="button secondary" onClick={() => user ? setPayment({ recharge: true }) : openAuth("login")}><CreditCard size={18} /> 充值余额</button></section>
      {payment && !payment.recharge && <PaymentDialog payment={payment} provider={provider} onClose={() => setPayment(null)} />}
      {payment?.recharge && <RechargeDialog provider={provider} onClose={() => setPayment(null)} navigate={navigate} />}
    </main>
  );
}

function PaymentDialog({ payment, provider, onClose }) {
  return (
    <div className="modal-backdrop"><section className="payment-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose}><X size={19} /></button><div className="payment-logo"><CreditCard size={28} /></div><h2>{provider === "wechat" ? "微信支付" : "支付宝"}</h2><p>订单 {payment.orderNo} 已创建。请在新的支付窗口完成付款。</p><a className="button primary full" href={payment.paymentUrl} target="_blank" rel="noreferrer">打开支付页面 <ArrowRight size={17} /></a><small>支付完成后，会员权益会由签名验证通过的异步通知自动生效。</small></section></div>
  );
}

function RechargeDialog({ provider, onClose, navigate }) {
  const [amount, setAmount] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await apiFetch("/api/billing/orders", { method: "POST", body: JSON.stringify({ kind: "recharge", provider, amountFen: Math.round(amount * 100) }) });
      if (result.paymentUrl?.startsWith("/")) navigate(result.paymentUrl);
      else window.open(result.paymentUrl, "_blank", "noopener,noreferrer");
      onClose();
    } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section className="payment-modal"><button className="modal-close" onClick={onClose}><X size={19} /></button><div className="payment-logo"><Wallet size={28} /></div><h2>充值余额</h2><form onSubmit={submit}><label><span>充值金额（元）</span><input type="number" min="1" max="50000" value={amount} onChange={(event) => setAmount(Number(event.target.value))} /></label>{error && <div className="form-error">{error}</div>}<button className="button primary full" disabled={busy}>{busy ? "正在创建订单" : `充值 ${formatMoney(amount * 100)}`}</button></form></section></div>;
}

export function BrainUploadPage({ user, openAuth }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");

  async function uploadFile(event) {
    event.preventDefault();
    if (!user) return openAuth("login");
    if (!file) return setMessage("请选择 ZIP 文件");
    setBusy(true); setMessage(""); setProgress(5);
    try {
      const { upload } = await import("@vercel/blob/client");
      await upload(`second-brain/${user.id}/${file.name}`, file, {
        access: "public",
        handleUploadUrl: "/api/uploads/token",
        clientPayload: JSON.stringify({ kind: "brain" }),
        multipart: true,
        onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage)),
      });
      setMessage("上传完成，已进入自动分析队列。后续版本会基于对话记录定位问题、挖掘需求并生成升级建议。");
      setFile(null);
    } catch (reason) {
      setMessage(reason.message);
    } finally { setBusy(false); }
  }

  return (
    <main id="main-content">
      <PageIntro eyebrow="SECOND BRAIN" title="把你的知识带回古龙" description="上传 ZIP 格式的“第二大脑”存储目录。文件进入隔离存储后，系统会排队分析问题、需求与可复用经验。" />
      <section className="upload-grid section-shell">
        <form className="upload-card" onSubmit={uploadFile}>
          <div className="upload-drop"><FileZip size={42} /><h2>上传第二大脑 ZIP</h2><p>支持分片直传，单个文件最大 500 MB；仅账号本人可查看处理记录。</p><label className="button secondary"><UploadSimple size={18} /> 选择 ZIP<input type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={(event) => setFile(event.target.files?.[0] || null)} hidden /></label>{file && <div className="file-chip"><FileZip size={17} /><span>{file.name}</span><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></div>}</div>
          {busy && <div className="upload-progress"><span style={{ width: `${progress}%` }} /><em>{progress}%</em></div>}
          {message && <div className={message.startsWith("上传完成") ? "form-success" : "form-error"}>{message}</div>}
          <button className="button primary full" type="submit" disabled={busy || !file}><CloudArrowUp size={18} /> {busy ? "正在安全上传" : "开始上传并排队分析"}</button>
        </form>
        <aside className="upload-explainer">
          <h2>文件会经历什么？</h2>
          {[["01", "安全接收", "浏览器直传文件存储，MongoDB 仅记录索引、状态与所有权。"], ["02", "结构扫描", "识别会话、笔记、素材和索引，不执行压缩包中的程序。"], ["03", "问题与需求挖掘", "聚类错误、重复操作与未满足需求，形成可审阅报告。"], ["04", "升级建议", "生成产品优化与工作流迭代建议，未经确认不会自动发布。"]].map(([n, title, text]) => <article key={n}><span>{n}</span><div><strong>{title}</strong><p>{text}</p></div></article>)}
        </aside>
      </section>
    </main>
  );
}

export function FeedbackPage({ user }) {
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const previews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);

  useEffect(() => () => previews.forEach((item) => URL.revokeObjectURL(item.url)), [previews]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setResult("");
    try {
      let screenshots = [];
      if (files.length) {
        if (!user) throw new Error("上传截图前请先登录；也可以移除截图后匿名提交文字反馈。");
        const { upload } = await import("@vercel/blob/client");
        screenshots = await Promise.all(files.map(async (file) => {
          const blob = await upload(`feedback/${user.id}/${file.name}`, file, { access: "public", handleUploadUrl: "/api/uploads/token", clientPayload: JSON.stringify({ kind: "feedback" }) });
          return blob.url;
        }));
      }
      const response = await apiFetch("/api/feedback", { method: "POST", body: JSON.stringify({ message, screenshots }) });
      setResult(`反馈已提交，编号：${response.id}`); setMessage(""); setFiles([]);
    } catch (reason) { setResult(reason.message); } finally { setBusy(false); }
  }

  return (
    <main id="main-content">
      <PageIntro eyebrow="FEEDBACK" title="告诉我们哪里还不够好" description="描述你遇到的问题、期待的功能或使用场景，并附上最多 9 张截图。我们会把反馈转化为可跟踪的产品改进项。" />
      <section className="feedback-layout section-shell">
        <form className="feedback-form" onSubmit={submit}>
          <label><span>问题或建议</span><textarea required minLength={5} maxLength={5000} rows={8} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="请尽量说明：你想完成什么、实际发生了什么、期望结果是什么。" /><small>{message.length} / 5000</small></label>
          <div className="screenshot-area"><div><Images size={24} /><strong>上传截图</strong><small>PNG / JPG / WebP，最多 9 张，每张不超过 15 MB</small></div><label className="button secondary small"><Plus size={16} /> 添加截图<input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => setFiles(Array.from(event.target.files || []).slice(0, 9))} /></label></div>
          {previews.length > 0 && <div className="screenshot-grid">{previews.map((item, index) => <figure key={item.url}><img src={item.url} alt={`问题截图 ${index + 1}`} /><button type="button" onClick={() => setFiles(files.filter((_, candidate) => candidate !== index))}><X size={15} /></button></figure>)}</div>}
          {result && <div className={result.startsWith("反馈已提交") ? "form-success" : "form-error"}>{result}</div>}
          <button className="button primary" disabled={busy}><PaperPlaneTilt size={18} /> {busy ? "正在提交" : "提交反馈"}</button>
        </form>
        <aside className="feedback-values"><h2>我们重点关注</h2><article><strong>可靠性</strong><p>任务是否卡住、结果是否误报、恢复点是否真的有效。</p></article><article><strong>生产速度</strong><p>哪些步骤重复、哪些等待不透明、怎样更快形成交付结果。</p></article><article><strong>新需求</strong><p>你希望古龙接入的渠道、模型、工具或行业工作流。</p></article></aside>
      </section>
    </main>
  );
}

export function MockPaymentPage({ user, navigate }) {
  const params = new URLSearchParams(window.location.search);
  const orderNo = params.get("order");
  const token = params.get("token");
  const [state, setState] = useState("ready");
  async function complete() {
    setState("busy");
    try { await apiFetch("/api/billing/mock/complete", { method: "POST", body: JSON.stringify({ orderNo, token }) }); setState("done"); }
    catch { setState("error"); }
  }
  return <main id="main-content" className="mock-payment-page"><section><div className="payment-logo"><CreditCard size={30} /></div><span>安全沙箱</span><h1>模拟支付确认</h1><p>此页面不会产生真实扣款，用于在商户密钥配置前验证完整订阅流程。</p><dl><div><dt>订单号</dt><dd>{orderNo || "无效订单"}</dd></div><div><dt>当前账号</dt><dd>{user?.email || user?.username || "未登录"}</dd></div></dl>{state === "done" ? <><div className="form-success">支付成功，权益已写入 MongoDB。</div><button className="button primary full" onClick={() => navigate("/pricing")}>返回订阅中心</button></> : <button className="button primary full" disabled={!orderNo || !token || state === "busy"} onClick={complete}>{state === "busy" ? "正在确认" : "确认模拟付款"}</button>}{state === "error" && <div className="form-error">确认失败，请检查登录状态、订单令牌和数据库配置。</div>}</section></main>;
}
