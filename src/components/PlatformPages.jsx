import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle,
  CloudArrowUp,
  Clock,
  Code,
  Coins,
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
import { apiFetch, formatMoney, trackAnalyticsEvent } from "../api.js";
import { plans as sitePlans } from "../data/site.js";

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

function CustomizationContactDialog({ onClose }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="custom-contact-modal" role="dialog" aria-modal="true" aria-labelledby="custom-contact-title">
        <button className="modal-close" type="button" aria-label="关闭联系定制窗口" autoFocus onClick={onClose}><X size={20} /></button>
        <span className="custom-contact-kicker">DEEP CUSTOMIZATION</span>
        <h2 id="custom-contact-title">微信沟通深度定制</h2>
        <p>扫描二维码添加施富，发送你的业务目标与期望结果，我们会一起梳理适合的智能体与自动化方案。</p>
        <figure className="custom-contact-qr-shell">
          <img src="/assets/deep-customization-wechat.jpg" alt="深度定制联系人施富的微信二维码" />
          <figcaption>打开微信扫一扫，添加好友后备注“古龙深度定制”</figcaption>
        </figure>
        <button className="button primary full" type="button" onClick={onClose}>我已保存二维码</button>
      </section>
    </div>
  );
}

export function DownloadPage() {
  const [releases, setReleases] = useState({});
  const [loading, setLoading] = useState(true);
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState("");

  useEffect(() => {
    apiFetch("/api/downloads")
      .catch(() => apiFetch("/api/platform?_platform_path=downloads"))
      .then((result) => {
        setReleases(Object.fromEntries((result.editions || []).map((item) => [item.editionKey, item])));
      })
      .catch(() => setReleases({}))
      .finally(() => setLoading(false));
  }, []);

  const editions = [
    {
      key: "gulong",
      eyebrow: "GULONG ESSENTIAL",
      name: "古龙基础版",
      tagline: "通用、稳定、开箱即用",
      description: "面向个人用户、独立开发者与小型团队的标准版本。第一次接触古龙，直接选择这一版即可。",
      suitable: "适合希望快速拥有 AI 团队，并使用官方标准能力与持续更新的用户。",
      features: ["完整智能体引擎与任务工作流", "第二大脑、技能与插件能力", "本地优先的数据与模型配置"],
      icon: "/assets/gulong-edition-icon.png",
    },
    {
      key: "yongshenghua",
      eyebrow: "IMMORTAL FLOWER CUSTOM",
      name: "永生花定制版",
      tagline: "专属品牌、独立渠道、定制体验",
      description: "面向永生花既有用户、品牌合作方与需要专属外观、权限策略和发行节奏的组织。",
      suitable: "适合已通过永生花端注册，或需要品牌化部署与专属发行渠道的用户。",
      features: ["继承古龙基础版核心引擎", "永生花品牌界面与专属配置", "独立权限分组与版本发行通道"],
      icon: "/assets/yongshenghua-edition-icon.png",
    },
  ];

  async function downloadRelease(editionKey) {
    if (!releases[editionKey]?.channelId) return;
    trackAnalyticsEvent("DOWNLOAD_CLICK", { edition: editionKey });
    setDownloadError("");
    setDownloading(editionKey);
    try {
      let result;
      try {
        result = await apiFetch(`/api/downloads/${editionKey}/download`);
      } catch (primaryError) {
        const channelId = releases[editionKey]?.channelId;
        if (!channelId) throw primaryError;
        result = await apiFetch(`/api/releases/${encodeURIComponent(channelId)}/download`);
      }
      window.location.assign(result.url);
    } catch (error) {
      setDownloadError(error.message);
    } finally {
      setDownloading("");
    }
  }

  return (
    <main id="main-content">
      <PageIntro eyebrow="WINDOWS DESKTOP" title="选择适合你的古龙桌面版" description="两个版本共享可靠的古龙智能体核心。基础版适合绝大多数用户；永生花定制版为特定品牌、账号体系与发行渠道提供专属体验。" />
      <section className="download-layout section-shell">
        <div className="edition-choice-intro"><span>一分钟选对版本</span><strong>第一次使用选基础版；已有永生花账号或需要专属品牌体验，选定制版。</strong></div>
        <div className="download-edition-grid">
          {editions.map((edition) => {
            const release = releases[edition.key];
            const isCustom = edition.key === "yongshenghua";
            return <article key={edition.key} className={`download-edition-card ${isCustom ? "custom" : "essential"}`}>
              <header>
                <div className={`download-edition-mark ${isCustom ? "flower" : ""}`}><img src={edition.icon} alt={`${edition.name}圆形图标`} /></div>
                <div><span>{edition.eyebrow}</span><h2>{edition.name}</h2><strong>{edition.tagline}</strong></div>
              </header>
              <p className="edition-description">{edition.description}</p>
              <div className="edition-suitable"><span>更适合</span><p>{edition.suitable}</p></div>
              <ul>{edition.features.map((feature) => <li key={feature}><CheckCircle size={20} weight="fill" /> {feature}</li>)}</ul>
              <div className="edition-release">
                <div><span>Windows 10 / 11 · x64</span><strong>{release?.version ? `v${release.version.replace(/^v/i, "")}` : loading ? "正在读取版本" : "版本准备中"}</strong><small>{release?.filename || "完整离线安装包"}</small></div>
                <button className={`button full ${isCustom ? "secondary" : "primary"}`} type="button" disabled={!release || downloading === edition.key} onClick={() => downloadRelease(edition.key)}><DownloadSimple size={19} /> {downloading === edition.key ? "正在获取安全链接" : release ? `下载${edition.name}` : "安装包准备中"}</button>
              </div>
              {release && <div className="edition-integrity"><span>SHA-256</span><code title={release.sha256}>{release.sha256 || "发布后公布"}</code><small>{release.bytes ? `${(release.bytes / 1024 / 1024).toFixed(1)} MB` : ""} · {release.signatureStatus || "签名状态待确认"}</small></div>}
            </article>;
          })}
        </div>
        <div className="edition-decision-guide"><div><span>01</span><p><strong>个人首次使用</strong>选择古龙基础版，配置更直接，官方默认能力完整。</p></div><div><span>02</span><p><strong>已有永生花账号</strong>选择永生花定制版，登录后匹配对应品牌与权限。</p></div><div><span>03</span><p><strong>团队品牌化部署</strong>选择永生花定制版，使用独立发行节奏与定制配置。</p></div></div>
        {downloadError && <div className="form-error">{downloadError}</div>}
        <div className="download-note"><ShieldCheck size={22} /><div><strong>安装包安全说明</strong><p>两个版本分别读取所属发行渠道的唯一最新版。直接下载链接为腾讯云 COS 的 15 分钟限时签名地址；下载后可核对页面公布的版本号、文件大小与 SHA-256。</p></div></div>
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
        body: JSON.stringify({ name, scopes: ["tasks:read", "tasks:write", "workflows:read", "configuration:read", "profile:read"] }),
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
        description="用一套安全、可审计的 API 调用任务执行、第二大脑、工作流与个人模型配置。每位开发者都能生成独立 API Key。"
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
  const [paymentMode, setPaymentMode] = useState("online");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [payment, setPayment] = useState(null);
  const [membership, setMembership] = useState(null);
  const [pricingPlans, setPricingPlans] = useState(sitePlans);
  const [customContactOpen, setCustomContactOpen] = useState(false);
  const [customOrderOpen, setCustomOrderOpen] = useState(false);
  const [walletPromotion, setWalletPromotion] = useState({ subscriptionBonusRate: 0.1, rechargeBonusRate: 0.1, rechargeThresholdFen: 50_000 });
  const [paymentAvailability, setPaymentAvailability] = useState({
    notice: "微信在线支付已开通；到期前 7 天起每天提醒手动续费。",
    priorityProvider: "wechat",
    channels: { wechat: { message: "扫码完成单次付款，到账后自动同步权益。" } },
  });

  useEffect(() => {
    apiFetch("/api/billing/plans")
      .then((result) => {
        const liveMember = (result.plans || []).find((item) => item.id === "member");
        if (liveMember) setPricingPlans(sitePlans.map((item) => item.id === "member" ? { ...item, monthlyFen: liveMember.monthlyFen, yearlyFen: liveMember.yearlyFen } : item));
        if (result.providers?.availability) setPaymentAvailability(result.providers.availability);
        if (result.walletPromotion) setWalletPromotion(result.walletPromotion);
      })
      .catch(() => setPricingPlans(sitePlans));
  }, []);

  useEffect(() => {
    if (!user) { setMembership(null); return; }
    apiFetch("/api/billing/subscription")
      .then((result) => setMembership(result.subscription || null))
      .catch(() => setMembership(null));
  }, [user?.id]);

  const memberPlan = pricingPlans.find((item) => item.id === "member");
  const monthlyUpgrade = cycle === "year"
    && membership?.status === "active"
    && membership?.cycle === "month"
    && new Date(membership.currentPeriodEnd).getTime() > Date.now();
  const upgradeCreditFen = monthlyUpgrade ? memberPlan.monthlyFen : 0;
  const memberPayableFen = cycle === "year" ? Math.max(monthlyUpgrade ? 100 : 0, memberPlan.yearlyFen - upgradeCreditFen) : memberPlan.monthlyFen;
  const yearlySavingsFen = Math.max(0, memberPlan.monthlyFen * 12 - memberPlan.yearlyFen);
  const memberBonusFen = Math.floor(memberPayableFen * walletPromotion.subscriptionBonusRate);

  async function startPayment(plan) {
    if (!user) return openAuth("login");
    if (plan.id === "free") return navigate("/download");
    if (plan.id === "custom") { setCustomContactOpen(true); return; }
    trackAnalyticsEvent("CHECKOUT_START", { path: "/pricing" });
    if (paymentMode === "offline") {
      setPayment({ mode: "offline-cashier", cycle, amountFen: plan.id === "member" ? memberPayableFen : cycle === "year" ? plan.yearlyFen : plan.monthlyFen, bonusFen: plan.id === "member" ? memberBonusFen : 0, creditedFen: plan.id === "member" ? memberPayableFen + memberBonusFen : 0, upgradeCreditFen, planName: plan.name });
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch("/api/billing/orders", {
        method: "POST",
        body: JSON.stringify({ kind: "subscription", cycle, provider: "wechat", autoRenew: false }),
      });
      setPayment(result);
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
        <div className="cycle-switch"><button className={cycle === "month" ? "active" : ""} onClick={() => setCycle("month")}>按月订阅</button><button className={cycle === "year" ? "active" : ""} onClick={() => setCycle("year")}>按年订阅 {yearlySavingsFen > 0 && <span>省 {formatMoney(yearlySavingsFen)}</span>}</button></div>
        <div className="payment-method-control"><div className="provider-switch"><button className={paymentMode === "online" ? "active" : ""} onClick={() => setPaymentMode("online")}>线上支付</button><button className={paymentMode === "offline" ? "active" : ""} onClick={() => setPaymentMode("offline")}>线下支付</button></div></div>
      </section>
      <section className="pricing-grid section-shell">
        {pricingPlans.map((plan) => (
          <article key={plan.id} className={plan.featured ? "featured" : ""}>
            {plan.featured && <span className="plan-ribbon">推荐</span>}
            <small>{plan.eyebrow}</small><h2>{plan.name}</h2>
            <div className="plan-price">{plan.pricing || formatMoney(plan.id === "member" ? memberPayableFen : cycle === "year" ? plan.yearlyFen : plan.monthlyFen)}{!plan.pricing && <em>/{cycle === "year" ? "年" : "月"}</em>}</div>
            {plan.id === "member" && monthlyUpgrade && <div className="upgrade-credit"><CheckCircle size={19} weight="fill" /><div><strong>月度会员升级抵扣 {formatMoney(upgradeCreditFen)}</strong><span>年度原价 {formatMoney(plan.yearlyFen)}，本次只需补足剩余费用。</span></div></div>}
            {plan.id === "member" && <div className="wallet-promotion-note"><Coins size={20} weight="duotone" /><span><strong>订阅即送 10% 创作余额</strong><small>本次实付 {formatMoney(memberPayableFen)}，到账余额 {formatMoney(memberPayableFen + memberBonusFen)}，其中赠送 {formatMoney(memberBonusFen)}。</small></span></div>}
            {plan.subpricing && <p className="plan-subprice">{plan.subpricing}</p>}
            <ul>{plan.features.map((feature) => <li key={feature}><Check size={17} weight="bold" /> {feature}</li>)}</ul>
            {plan.id === "member" && paymentMode === "offline" && <div className="manual-renew-note"><Clock size={20} /><span><strong>人工审核到账</strong><small>付款后提交审核，确认到账后同步官网与桌面端。</small></span></div>}
            {plan.id === "custom" ? <div className="custom-plan-actions"><button className="button secondary full" disabled={busy} onClick={() => setCustomContactOpen(true)}>联系定制</button><button className="button primary full" disabled={busy} onClick={() => user ? setCustomOrderOpen(true) : openAuth("login")}><Plus size={18} />新建订单</button></div> : <button className={`button full ${plan.featured ? "primary" : "secondary"}`} disabled={busy} onClick={() => startPayment(plan)}>{plan.id === "free" ? "免费下载" : busy ? "正在创建微信订单" : monthlyUpgrade ? "补差价升级年度会员" : paymentMode === "online" ? "微信支付开通" : "线下申请开通"}</button>}
          </article>
        ))}
      </section>
      {error && <div className="page-error section-shell">{error}</div>}
      <section className="recharge-callout section-shell" id="recharge"><div className="wallet-orb"><Wallet size={28} /></div><div><h3>单次充值</h3><p>实付满 {formatMoney(walletPromotion.rechargeThresholdFen)} 额外赠送 10% 余额；未满 500 元按实付金额到账。</p></div><button className="button secondary" onClick={() => user ? setPayment({ recharge: true }) : openAuth("login")}><CreditCard size={18} /> 微信充值</button></section>
      {customContactOpen && <CustomizationContactDialog onClose={() => setCustomContactOpen(false)} />}
      {customOrderOpen && <CustomOrderDialog onClose={() => setCustomOrderOpen(false)} onCreated={(result) => { setCustomOrderOpen(false); setPayment(result); }} />}
      {payment && !payment.recharge && <PaymentDialog payment={payment} provider="wechat" availability={paymentAvailability} onPayment={setPayment} onClose={() => setPayment(null)} />}
      {payment?.recharge && <RechargeDialog provider="wechat" onClose={() => setPayment(null)} navigate={navigate} onCreated={(result) => setPayment(result)} />}
    </main>
  );
}

function PaymentDialog({ payment, provider, availability, onPayment, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(payment.status || "pending");

  useEffect(() => {
    if (payment.mode !== "chandler" || !payment.orderNo || status === "paid") return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await apiFetch(`/api/billing/payments/${encodeURIComponent(payment.orderNo)}/status`);
        if (!cancelled) setStatus(result.status || "pending");
      } catch { /* Polling resumes on the next interval. */ }
    };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [payment.mode, payment.orderNo, status]);
  async function confirmOffline() {
    setBusy(true); setError("");
    try {
      const result = await apiFetch("/api/billing/orders", { method: "POST", body: JSON.stringify({ kind: "subscription", cycle: payment.cycle, provider: "offline", autoRenew: false }) });
      onPayment(result);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  if (payment.mode === "offline-cashier") {
    return <div className="modal-backdrop"><section className="payment-modal offline-payment-modal" role="dialog" aria-modal="true"><button className="modal-close" disabled={busy} onClick={onClose}><X size={19} /></button><div className="payment-logo"><ShieldCheck size={28} /></div><span className="payment-eyebrow">OFFLINE PAYMENT</span><h2>扫码支付后提交人工审核</h2><p>请扫描企业收款码完成付款。付款后点击“我已支付”，系统会创建待审核订单。</p><img className="payment-qr enterprise-qr" src="/assets/enterprise-payment-qr.jpg" alt="古龙企业微信收款码" /><div className="offline-payment-summary"><span>{payment.cycle === "year" ? "年度会员" : "月度会员"}</span><strong>{formatMoney(payment.amountFen)}</strong></div>{payment.bonusFen > 0 && <p className="payment-bonus-note"><Coins size={19} />到账后额外赠送 {formatMoney(payment.bonusFen)}，可用余额合计 {formatMoney(payment.creditedFen)}</p>}{payment.upgradeCreditFen > 0 && <p className="offline-upgrade-note">已按月度会员升级规则抵扣 {formatMoney(payment.upgradeCreditFen)}</p>}{error && <div className="form-error">{error}</div>}<div className="payment-dialog-actions"><button className="button secondary" disabled={busy} onClick={onClose}>返回套餐</button><button className="button primary" disabled={busy} onClick={confirmOffline}>{busy ? "正在提交" : "我已支付"}</button></div></section></div>;
  }
  if (payment.mode === "offline") {
    return <div className="modal-backdrop"><section className="payment-modal offline-payment-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose}><X size={19} /></button><div className="payment-logo"><ShieldCheck size={28} /></div><span className="payment-eyebrow">PAYMENT SUBMITTED</span><h2>已提交，等待管理员审核</h2><p>订单 <strong>{payment.orderNo}</strong> 已进入审核队列。到账确认后，会员权益会同步到古龙官网与桌面端。</p><div className="form-success">待审核 · {formatMoney(payment.amountFen)}</div><p className="offline-payment-urgent">请尽快添加客服微信，发送支付截图，以加速审核进度。</p><img className="payment-qr service-qr" src="/assets/customer-service-wechat.jpg" alt="古龙客服微信二维码" /><small>扫码添加古龙客服，并发送本订单的支付截图。</small><button className="button primary full" onClick={onClose}>我知道了</button></section></div>;
  }
  if (status === "paid") {
    return <div className="modal-backdrop"><section className="payment-modal payment-success-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose}><X size={19} /></button><div className="payment-logo"><CheckCircle size={30} weight="fill" /></div><span className="payment-eyebrow">PAYMENT SUCCEEDED</span><h2>微信支付成功</h2><p>订单 <strong>{payment.orderNo}</strong> 已到账。会员权益、充值余额或定制订单状态已经写入官网，并同步提供给桌面端。</p><div className="form-success">已支付 · {formatMoney(payment.amountFen)}{payment.bonusFen > 0 ? ` · 赠送 ${formatMoney(payment.bonusFen)}` : ""}</div><button className="button primary full" onClick={onClose}>完成</button></section></div>;
  }
  return (
    <div className="modal-backdrop"><section className="payment-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose}><X size={19} /></button><div className="payment-logo"><CreditCard size={28} /></div><span className="payment-eyebrow">WECHAT PAY</span><h2>微信支付</h2><p>订单 {payment.orderNo} 已由 Chandler 安全创建。{payment.qrCodeDataUrl ? "请使用微信扫码完成付款。" : "请在微信支付页面完成付款。"}</p>{payment.qrCodeDataUrl && <img className="payment-qr" src={payment.qrCodeDataUrl} alt="微信支付二维码" />}{payment.paymentUrl && !payment.qrCodeDataUrl && <a className="button primary full" href={payment.paymentUrl} target="_blank" rel="noreferrer">打开微信支付 <ArrowRight size={17} /></a>}<div className="payment-polling"><span /><strong>正在安全确认支付结果</strong></div><small>本次为单次微信付款，不会自动扣款；支付成功后自动同步官网与桌面端。</small></section></div>
  );
}

function CustomOrderDialog({ onClose, onCreated }) {
  const [amount, setAmount] = useState(1000);
  const [subject, setSubject] = useState("古龙深度定制服务订单");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await apiFetch("/api/billing/orders", { method: "POST", body: JSON.stringify({ kind: "custom", provider: "wechat", amountFen: Math.round(Number(amount) * 100), subject }) });
      onCreated(result);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section className="payment-modal custom-order-modal" role="dialog" aria-modal="true" aria-labelledby="custom-order-title"><button className="modal-close" disabled={busy} onClick={onClose}><X size={19} /></button><div className="payment-logo"><Wallet size={28} /></div><span className="payment-eyebrow">CUSTOM SERVICE ORDER</span><h2 id="custom-order-title">新建深度定制订单</h2><p>与团队确认服务内容和金额后，在这里创建微信收款订单。支付成功会生成可追踪的线上订单记录。</p><form onSubmit={submit}><label><span>订单说明</span><input required minLength={2} maxLength={80} value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label><span>自定义金额（元）</span><input type="number" min="1" max="100000" step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} /></label>{error && <div className="form-error">{error}</div>}<button className="button primary full" disabled={busy}>{busy ? "正在创建微信订单" : `创建订单并支付 ${formatMoney(Math.round(Number(amount || 0) * 100))}`}</button></form><small>仅支持微信支付；请核对金额后再扫码付款。</small></section></div>;
}

function RechargeDialog({ provider, onClose, navigate, onCreated }) {
  const [amount, setAmount] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await apiFetch("/api/billing/orders", { method: "POST", body: JSON.stringify({ kind: "recharge", provider: provider === "offline" ? "wechat" : provider, amountFen: Math.round(amount * 100) }) });
      onCreated(result);
    } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }
  const amountFen = Math.round(Number(amount || 0) * 100);
  const bonusFen = amountFen >= 50_000 ? Math.floor(amountFen * 0.1) : 0;
  return <div className="modal-backdrop"><section className="payment-modal"><button className="modal-close" onClick={onClose}><X size={19} /></button><div className="payment-logo"><Wallet size={28} /></div><h2>充值余额</h2><form onSubmit={submit}><label><span>充值金额（元）</span><input type="number" min="1" max="50000" step="0.01" value={amount} onChange={(event) => setAmount(Number(event.target.value))} /></label><div className={`recharge-bonus-preview ${bonusFen ? "active" : ""}`}><Coins size={21} weight="duotone" /><span><strong>{bonusFen ? `额外赠送 ${formatMoney(bonusFen)}` : "满 500 元赠送 10%"}</strong><small>{bonusFen ? `本次预计到账 ${formatMoney(amountFen + bonusFen)}` : "当前金额按实付金额到账"}</small></span></div>{error && <div className="form-error">{error}</div>}<button className="button primary full" disabled={busy}>{busy ? "正在创建订单" : `充值 ${formatMoney(amountFen)}`}</button></form></section></div>;
}

export function BrainUploadPanel({ user, openAuth, embedded = false }) {
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
      const ticket = await apiFetch("/api/brain/uploads/presign", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type || "application/zip" }),
      });
      await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", ticket.uploadUrl, true);
        Object.entries(ticket.requiredHeaders || {}).forEach(([name, value]) => request.setRequestHeader(name, value));
        request.upload.onprogress = (progressEvent) => {
          if (progressEvent.lengthComputable) setProgress(Math.max(5, Math.round((progressEvent.loaded / progressEvent.total) * 96)));
        };
        request.onerror = () => reject(new Error("上传到腾讯云 COS 失败，请检查网络和存储桶跨域配置"));
        request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`腾讯云 COS 返回 ${request.status}`));
        request.send(file);
      });
      await apiFetch(`/api/brain/uploads/${ticket.uploadId}/complete`, { method: "POST", body: "{}" });
      setProgress(100);
      setMessage("上传完成，已进入自动分析队列。后续版本会基于对话记录定位问题、挖掘需求并生成升级建议。");
      setFile(null);
    } catch (reason) {
      setMessage(reason.message);
    } finally { setBusy(false); }
  }

  return (
      <section className={`upload-grid ${embedded ? "embedded" : "section-shell"}`}>
        <form className="upload-card" onSubmit={uploadFile}>
          <div className="upload-drop"><FileZip size={42} /><h2>上传第二大脑 ZIP</h2><p>浏览器直传腾讯云 COS，单个文件最大 2 GB；下载地址短时签名，仅授权账号和管理员可获取。</p><label className="button secondary"><UploadSimple size={18} /> 选择 ZIP<input type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={(event) => setFile(event.target.files?.[0] || null)} hidden /></label>{file && <div className="file-chip"><FileZip size={17} /><span>{file.name}</span><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></div>}</div>
          {busy && <div className="upload-progress"><span style={{ width: `${progress}%` }} /><em>{progress}%</em></div>}
          {message && <div className={message.startsWith("上传完成") ? "form-success" : "form-error"}>{message}</div>}
          <button className="button primary full" type="submit" disabled={busy || !file}><CloudArrowUp size={18} /> {busy ? "正在安全上传" : "开始上传并排队分析"}</button>
        </form>
        <aside className="upload-explainer">
          <h2>文件会经历什么？</h2>
          {[["01", "COS 安全接收", "浏览器通过限时签名直传成都地域 COS，MongoDB 只保存索引、状态与所有权。"], ["02", "结构扫描", "识别会话、笔记、素材和索引，不执行压缩包中的程序。"], ["03", "问题与需求挖掘", "聚类错误、重复操作与未满足需求，形成可审阅报告。"], ["04", "升级建议", "生成产品优化与工作流迭代建议，未经确认不会自动发布。"]].map(([n, title, text]) => <article key={n}><span>{n}</span><div><strong>{title}</strong><p>{text}</p></div></article>)}
        </aside>
      </section>
  );
}

export function BrainUploadPage({ user, openAuth }) {
  return (
    <main id="main-content">
      <PageIntro eyebrow="SECOND BRAIN" title="把你的知识带回古龙" description="上传 ZIP 格式的“第二大脑”存储目录。文件进入隔离存储后，系统会排队分析问题、需求与可复用经验。" />
      <BrainUploadPanel user={user} openAuth={openAuth} />
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
      setResult(`反馈已提交，编号：${response.id}。登录用户可在用户后台“我的反馈”查看处理进度和结果。`); setMessage(""); setFiles([]);
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
