import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  CalendarBlank,
  ChartLineUp,
  CheckCircle,
  CloudArrowDown,
  CloudArrowUp,
  Cube,
  CurrencyCny,
  DownloadSimple,
  FileZip,
  FloppyDisk,
  GearSix,
  Handshake,
  ImageSquare,
  LockKey,
  MagnifyingGlass,
  Package,
  Plus,
  RocketLaunch,
  ShieldCheck,
  Trash,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, formatMoney } from "../api.js";
import { AdminDashboard } from "./AdminDashboard.jsx";

const menu = [
  { id: "dashboard", label: "数据看板", icon: ChartLineUp },
  { id: "users", label: "订阅用户", icon: UsersThree },
  { id: "prices", label: "订阅价格", icon: Cube },
  { id: "partners", label: "合作伙伴", icon: Handshake },
  { id: "brain", label: "第二大脑", icon: FileZip },
  { id: "versions", label: "版本管理", icon: Package },
  { id: "payments", label: "订单处理", icon: ShieldCheck },
];

const subscriptionStatusLabels = {
  active: "生效中",
  pending: "待处理",
  pending_review: "待人工审核",
  approved: "已通过",
  canceled: "已取消",
  cancelled: "已取消",
  expired: "已到期",
  rejected: "已拒绝",
};

function AdminNotice({ children, tone = "info" }) {
  return <div className={`admin-notice ${tone}`}><ShieldCheck size={18} /> <span>{children}</span></div>;
}

function EmptyState({ icon: Icon = Cube, title, text }) {
  return <div className="admin-empty"><Icon size={34} weight="duotone" /><strong>{title}</strong><p>{text}</p></div>;
}

function ChandlerUserManager() {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState([]);
  const [meta, setMeta] = useState({});
  const [selected, setSelected] = useState(null);
  const [subscriptions, setSubscriptions] = useState([]);
  const [subscriptionMeta, setSubscriptionMeta] = useState({});
  const [grant, setGrant] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load(event) {
    event?.preventDefault();
    setBusy("search"); setMessage("");
    try {
      const result = await apiFetch(`/api/admin/chandler/users?q=${encodeURIComponent(query)}&limit=50`);
      setUsers(result.users || []); setMeta(result.meta || {});
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  useEffect(() => { load(); }, []);

  async function inspect(user) {
    setSelected(user); setSubscriptions([]); setSubscriptionMeta({}); setMessage("");
    try {
      const result = await apiFetch(`/api/admin/chandler/users/${encodeURIComponent(user.id)}/subscriptions`);
      setSubscriptions(result.subscriptions || []); setSubscriptionMeta(result.meta || {});
    } catch (error) { setMessage(error.message); }
  }

  async function changeStatus(user) {
    const status = user.status === "disabled" ? "active" : "disabled";
    if (!window.confirm(`${status === "disabled" ? "冻结" : "启用"} ${user.email || user.display_name || user.id}？`)) return;
    setBusy(user.id); setMessage("");
    try {
      await apiFetch(`/api/admin/chandler/users/${encodeURIComponent(user.id)}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      setMessage(status === "disabled" ? "账号已冻结。" : "账号已恢复使用。");
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function requestGrant(event) {
    event.preventDefault(); setBusy("grant"); setMessage("");
    try {
      await apiFetch("/api/admin/chandler/entitlement-requests", {
        method: "POST",
        body: JSON.stringify({
          userId: grant.user.id,
          entitlementCode: grant.entitlementCode,
          validUntil: new Date(grant.validUntil).toISOString(),
          reason: grant.reason,
        }),
      });
      setGrant(null); setMessage("权益变更已进入 Chandler 双人审批队列；申请人不能自行批准。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>CHANDLER IDENTITY CONTROL</span><h2>订阅用户</h2><p>搜索 Chandler 真实用户、冻结或恢复账号、查看订阅，并发起权益双人审批。</p></div><div className="storage-badge"><ShieldCheck size={18} /><span>数据来源</span><strong>{meta.permissionLimited ? "官网同步用户" : "Chandler OpenAPI"}</strong></div></header>
    <form className="admin-filterbar" onSubmit={load}><label><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮箱、昵称、手机号" /></label><button className="button secondary" disabled={busy === "search"}><MagnifyingGlass size={16} /> {busy === "search" ? "搜索中" : "搜索"}</button><span>共 {meta.total ?? users.length} 个结果</span></form>
    {message && <AdminNotice tone={message.includes("已") ? "success" : "error"}>{message}</AdminNotice>}
    {meta.permissionLimited && <AdminNotice>Chandler 管理接口未向当前账号开放，已自动切换为官网同步用户与本地订阅视图；查看、搜索和线下审核可继续使用，全局冻结与权益审批需 Chandler 授权。</AdminNotice>}
    {users.length ? <div className="chandler-user-list">{users.map((user) => <article key={user.id}><div className="chandler-user-avatar">{(user.display_name || user.email || "U").slice(0, 1).toUpperCase()}</div><div><strong>{user.display_name || "未设置昵称"}</strong><span>{user.email || user.phone || user.id}</span><small>{user.edition_name ? `${user.edition_name} · ` : ""}{user.id}</small></div><span className={`status-pill ${user.status || "active"}`}>{user.status === "disabled" ? "已冻结" : user.status === "deleted" ? "已删除" : "正常"}</span><div className="admin-row-actions"><button className="button small ghost" onClick={() => inspect(user)}>订阅详情</button>{!meta.permissionLimited && user.status !== "deleted" && <button className="button small secondary" disabled={busy === user.id} onClick={() => changeStatus(user)}>{user.status === "disabled" ? "恢复" : "冻结"}</button>}{!meta.permissionLimited && <button className="button small primary" onClick={() => setGrant({ user, entitlementCode: "gulong.member", validUntil: new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 16), reason: "管理员根据线下合同申请开通古龙会员权益" })}>申请权益</button>}</div></article>)}</div> : <EmptyState icon={UsersThree} title="没有匹配用户" text="尝试使用邮箱、昵称或手机号的一部分重新搜索。" />}
    {selected && <div className="admin-detail-panel"><header><div><span>SUBSCRIPTIONS</span><h3>{selected.display_name || selected.email || selected.id} 的订阅</h3></div><button className="icon-danger" onClick={() => setSelected(null)}><X size={17} /></button></header>{subscriptionMeta.permissionLimited && <AdminNotice>当前显示官网订阅与线下支付审核记录。</AdminNotice>}{subscriptions.length ? subscriptions.map((subscription, index) => <article key={subscription.id || index}><strong className={`subscription-state ${subscription.status || "unknown"}`}>{subscriptionStatusLabels[subscription.status] || subscription.status || "未知状态"}</strong><span>{subscription.sku_name || subscription.sku_id || subscription.product_name || "订阅套餐"}</span><time>有效至 {subscription.current_period_end ? new Date(subscription.current_period_end).toLocaleString("zh-CN") : subscription.valid_until ? new Date(subscription.valid_until).toLocaleString("zh-CN") : subscription.status === "pending_review" ? "等待审核" : "未返回"}</time></article>) : <p>该用户当前没有订阅记录。</p>}</div>}
    {grant && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setGrant(null)}><form className="admin-form-modal" onSubmit={requestGrant}><button className="modal-close" type="button" onClick={() => setGrant(null)}><X size={18} /></button><span>DUAL APPROVAL</span><h2>申请订阅权益</h2><p>目标用户：{grant.user.email || grant.user.id}</p><div className="admin-form-grid"><label><span>权益代码</span><input required value={grant.entitlementCode} onChange={(event) => setGrant({ ...grant, entitlementCode: event.target.value })} /></label><label><span>有效期至</span><input required type="datetime-local" value={grant.validUntil} onChange={(event) => setGrant({ ...grant, validUntil: event.target.value })} /></label><label className="span-2"><span>申请原因</span><textarea required minLength={2} maxLength={1024} value={grant.reason} onChange={(event) => setGrant({ ...grant, reason: event.target.value })} /></label></div><AdminNotice>申请将进入 Chandler 双人审批，申请人不能审批自己的请求。</AdminNotice><button className="button primary full" disabled={busy === "grant"}>{busy === "grant" ? "提交中" : "提交审批"}</button></form></div>}
  </section>;
}

function ChandlerPriceManager() {
  const [plans, setPlans] = useState([]);
  const [targets, setTargets] = useState({ month: 0, year: 0 });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [publishing, setPublishing] = useState(null);
  async function load() {
    setMessage("");
    try { const result = await apiFetch("/api/admin/chandler/catalog"); setPlans(result.plans || []); setTargets(result.targetPrices || {}); }
    catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);
  function openPublish(plan) {
    const yearly = `${plan.skuType} ${plan.billingInterval}`.toLowerCase().includes("year");
    setPublishing({ plan, yearly, target: yearly ? targets.year : targets.month, effectiveAt: new Date(Date.now() + 5 * 60_000).toISOString().slice(0, 16) });
  }
  async function publish(event) {
    event.preventDefault();
    const { plan, effectiveAt } = publishing;
    setBusy(plan.skuId); setMessage("");
    try {
      const result = await apiFetch("/api/admin/chandler/prices", { method: "POST", body: JSON.stringify({ skuId: plan.skuId, effectiveAt: new Date(effectiveAt).toISOString() }) });
      setPublishing(null);
      await load();
      setMessage(result.permissionFallback ? "Chandler 未开放价格权限，已自动由古龙官网价格覆盖层发布；结算接口将读取新价格。" : "新价格版本已发布到 Chandler，将按设定时间生效。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  return <section className="admin-module"><header className="admin-module-head"><div><span>IMMUTABLE PRICE VERSIONS</span><h2>订阅价格</h2><p>读取 Chandler 实时目录；若 Chandler 未开放价格权限，古龙官网会自动接管价格覆盖与结算。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} /> 刷新实时价格</button></header>{message && <AdminNotice tone={message.includes("已") || message.includes("接管") ? "success" : "error"}>{message}</AdminNotice>}<div className="price-admin-grid">{plans.map((plan) => { const yearly = `${plan.skuType} ${plan.billingInterval}`.toLowerCase().includes("year"); const target = yearly ? targets.year : targets.month; const scheduled = plan.scheduledPriceFen === target; const matches = plan.amountFen === target; return <article key={plan.skuId}><span>{yearly ? "YEARLY" : "MONTHLY"}</span><h3>{plan.productName}</h3><p>{plan.skuName}</p><div><strong>{formatMoney(plan.amountFen)}</strong><small>{plan.priceSource === "website-local" ? "官网覆盖价格" : "Chandler 实时价格"}</small></div><div><strong>{formatMoney(target)}</strong><small>官网目标价格</small></div><span className={`price-sync-state ${matches ? "ready" : scheduled ? "scheduled" : "pending"}`}>{matches ? "已同步" : scheduled ? `已排期 · ${new Date(plan.scheduledEffectiveAt).toLocaleString("zh-CN")}` : "需要发布新版本"}</span><button className="button primary full" disabled={matches || scheduled || busy === plan.skuId} onClick={() => openPublish(plan)}>{busy === plan.skuId ? "发布中" : matches ? "无需更新" : scheduled ? "等待生效" : "发布目标价格"}</button></article>; })}</div>{!plans.length && <EmptyState title="没有可用订阅套餐" text="请先在 Chandler 建立并上架月度、年度订阅 SKU。" />}{publishing && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setPublishing(null)}><form className="admin-form-modal price-publish-modal" onSubmit={publish}><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setPublishing(null)}><X size={18} /></button><header className="price-publish-head"><div className="price-publish-icon"><CurrencyCny size={30} weight="duotone" /></div><div><span>IMMUTABLE PRICE VERSION</span><h2>发布目标价格</h2><p>{publishing.plan.productName} · {publishing.plan.skuName}</p></div></header><div className="price-compare"><article><span>当前价格</span><strong>{formatMoney(publishing.plan.amountFen)}</strong><small>{publishing.plan.priceSource === "website-local" ? "古龙官网覆盖层" : "Chandler 当前版本"}</small></article><ArrowRight size={25} /><article className="target"><span>发布后价格</span><strong>{formatMoney(publishing.target)}</strong><small>{publishing.yearly ? "按年订阅" : "按月订阅"}</small></article></div><label className="price-effective-field"><span><CalendarBlank size={19} /> 生效时间</span><input required type="datetime-local" min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)} value={publishing.effectiveAt} onChange={(event) => setPublishing({ ...publishing, effectiveAt: event.target.value })} /><small>建议至少预留 5 分钟，避免用户在价格切换瞬间创建旧订单。</small></label><div className="price-publish-impact"><ShieldCheck size={23} weight="duotone" /><div><strong>安全发布说明</strong><p>价格版本不可直接覆盖历史金额。Chandler 有权限时同步发布；无权限时自动写入官网不可变价格版本，官网下单与结算会使用同一生效价格。</p></div></div><div className="price-publish-actions"><button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => setPublishing(null)}>取消</button><button className="button primary" disabled={Boolean(busy)}><RocketLaunch size={18} /> {busy ? "正在发布" : `确认发布 ${formatMoney(publishing.target)}`}</button></div></form></div>}</section>;
}

function PartnerManager() {
  const [partners, setPartners] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const emptyForm = { name: "", industry: "", websiteUrl: "https://", logoMode: "upload", logoUrl: "", logoFile: null, promotionFile: null, nodeAction: "website", sort: 100, enabled: true };
  const [form, setForm] = useState(emptyForm);
  const [state, setState] = useState({ busy: false, message: "" });

  async function load() {
    try { setPartners((await apiFetch("/api/admin/partners")).partners || []); }
    catch (error) { setState({ busy: false, message: error.message }); }
  }
  useEffect(() => { load(); }, []);

  async function uploadAsset(file, kind) {
    const ticket = await apiFetch("/api/admin/partners/assets/presign", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type, kind }),
    });
    const response = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.requiredHeaders || {}, body: file });
    if (!response.ok) throw new Error(`腾讯云 COS 上传失败（${response.status}）`);
    return ticket.objectKey;
  }

  async function create(event) {
    event.preventDefault();
    setState({ busy: true, message: "" });
    try {
      if (form.logoMode === "upload" && !form.logoFile) throw new Error("请选择企业 Logo 图片");
      if (form.nodeAction === "promotion" && !form.promotionFile) throw new Error("选择“宣传图片”跳转时，请上传宣传图片");
      const [logoObjectKey, promotionObjectKey] = await Promise.all([
        form.logoMode === "upload" ? uploadAsset(form.logoFile, "logo") : null,
        form.promotionFile ? uploadAsset(form.promotionFile, "promotion") : null,
      ]);
      const { logoFile, promotionFile, ...payload } = form;
      await apiFetch("/api/admin/partners", { method: "POST", body: JSON.stringify({ ...payload, logoObjectKey, promotionObjectKey }) });
      setForm(emptyForm);
      setFormOpen(false);
      setState({ busy: false, message: "合作伙伴已创建，行业已自动分类，首页品牌神经网络会自动更新。" });
      await load();
    } catch (error) { setState({ busy: false, message: error.message }); }
  }

  async function remove(id) {
    if (!window.confirm("确定删除这个合作伙伴吗？首页会立即停止展示。")) return;
    await apiFetch(`/api/admin/partners/${id}`, { method: "DELETE" });
    await load();
  }

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>PARTNER ECOSYSTEM</span><h2>合作伙伴管理</h2><p>上传企业 Logo、官网与宣传图片；系统根据企业行业自动归类，并同步到首页品牌神经网络。</p></div><button className="button primary" onClick={() => setFormOpen(true)}><Plus size={17} /> 新建合作伙伴</button></header>
    {state.message && <AdminNotice tone={state.message.startsWith("合作伙伴已") ? "success" : "error"}>{state.message}</AdminNotice>}
    {partners.length ? <div className="admin-partner-grid">{partners.map((partner) => <article key={partner.id}><div className="admin-logo-frame"><img src={partner.logoPreviewUrl} alt={`${partner.name} Logo`} /></div><div><strong>{partner.name}</strong><a href={partner.websiteUrl} target="_blank" rel="noreferrer">{new URL(partner.websiteUrl).hostname} <ArrowSquareOut size={13} /></a><small>{partner.industryName || "其他行业"} · {partner.logoMode === "upload" ? "COS Logo" : partner.logoMode === "generated" ? "自动 Logo" : "外部 Logo"} · 排序 {partner.sort}</small>{partner.promotionPreviewUrl && <a className="partner-promo-link" href={partner.promotionPreviewUrl} target="_blank" rel="noreferrer"><ImageSquare size={16} /> 查看宣传图片</a>}</div><button className="icon-danger" onClick={() => remove(partner.id)} aria-label={`删除 ${partner.name}`}><Trash size={17} /></button></article>)}</div> : <EmptyState icon={Handshake} title="还没有合作伙伴" text="创建第一家伙伴后，首页会自动出现品牌神经网络。" />}
    {formOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !state.busy && setFormOpen(false)}><form className="admin-form-modal partner-form-modal" onSubmit={create}><button className="modal-close" type="button" disabled={state.busy} onClick={() => setFormOpen(false)}><X size={18} /></button><span>NEW PARTNER</span><h2>新建合作伙伴</h2><div className="admin-form-grid"><label><span>企业名称</span><input required minLength={2} maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：中科智能" /></label><label><span>企业所属行业</span><input required maxLength={80} value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })} placeholder="例如：人工智能软件" /></label><label className="span-2"><span>官网网址</span><input required type="url" value={form.websiteUrl} onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })} placeholder="https://example.com" /></label><label><span>Logo 方式</span><select value={form.logoMode} onChange={(event) => setForm({ ...form, logoMode: event.target.value })}><option value="upload">上传企业 Logo（推荐）</option><option value="generated">根据名称自动生成</option><option value="url">使用 HTTPS 图片链接</option></select></label>{form.logoMode === "upload" && <label><span>企业 Logo 图片</span><input required type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setForm({ ...form, logoFile: event.target.files?.[0] || null })} /></label>}{form.logoMode === "url" && <label><span>Logo 图片链接</span><input required type="url" value={form.logoUrl} onChange={(event) => setForm({ ...form, logoUrl: event.target.value })} placeholder="https://example.com/logo.png" /></label>}<label><span>宣传图片（可选）</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setForm({ ...form, promotionFile: event.target.files?.[0] || null })} /></label><label><span>点击 Logo 后</span><select value={form.nodeAction} onChange={(event) => setForm({ ...form, nodeAction: event.target.value })}><option value="website">新标签页打开官网</option><option value="promotion">弹窗放大宣传图片</option></select></label><label><span>首页排序</span><input type="number" value={form.sort} onChange={(event) => setForm({ ...form, sort: Number(event.target.value) })} /></label></div><div className="logo-generation-hint"><ImageSquare size={25} /><div><strong>行业自动分类</strong><p>系统会根据“企业所属行业”和企业名称归入科技、金融、教育、医疗、商业、工业、文化等网络簇；首页节点会自动进入对应行业轨道。</p></div></div><button className="button primary full" disabled={state.busy}>{state.busy ? "正在上传到 COS 并创建" : "创建伙伴并加入品牌神经网络"}</button></form></div>}
  </section>;
}

function BrainAttachmentManager() {
  const today = new Date().toISOString().slice(0, 10);
  const [filters, setFilters] = useState({ keyword: "", from: today, to: today });
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, page: 1, pages: 0 });
  const [message, setMessage] = useState("");
  const [processing, setProcessing] = useState(null);

  async function load(page = 1) {
    setMessage("");
    try {
      const query = new URLSearchParams({ ...filters, page: String(page), limit: "30" });
      const result = await apiFetch(`/api/admin/brain-attachments?${query}`);
      setItems(result.items || []); setPagination(result.pagination || {});
    } catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);

  async function download(item) {
    try {
      const result = await apiFetch(`/api/admin/brain-attachments/${item.id}/download`);
      window.location.assign(result.url);
    } catch (error) { setMessage(error.message); }
  }

  async function saveProcessing(event) {
    event.preventDefault();
    try {
      await apiFetch(`/api/admin/brain-attachments/${processing.id}`, { method: "PUT", body: JSON.stringify(processing) });
      setProcessing(null); setMessage("处理进度与反馈已保存，用户后台会立即显示最新结果。"); await load();
    } catch (error) { setMessage(error.message); }
  }

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>TENCENT COS ARCHIVE</span><h2>第二大脑附件</h2><p>按文件名模糊搜索、按北京时间日期筛选，并生成 15 分钟有效的私有下载地址。</p></div><div className="storage-badge"><CloudArrowDown size={18} /><span>成都 COS</span><strong>gulong-1259744534</strong></div></header>
    <form className="admin-filterbar" onSubmit={(event) => { event.preventDefault(); load(1); }}><label><MagnifyingGlass size={17} /><input value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} placeholder="搜索文件名关键词" /></label><label><CalendarBlank size={17} /><input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label><span>至</span><label><CalendarBlank size={17} /><input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label><button className="button secondary"><MagnifyingGlass size={16} /> 搜索</button></form>
    {message && <AdminNotice tone={message.startsWith("处理进度") ? "success" : "error"}>{message}</AdminNotice>}
    {items.length ? <div className="admin-table brain-attachment-table"><div className="admin-table-head"><span>附件</span><span>提交用户</span><span>提交时间</span><span>状态</span><span>操作</span></div>{items.map((item) => <article key={item.id}><div className="file-cell"><FileZip size={21} /><div><strong title={item.originalName}>{item.originalName}</strong><small>{(item.size / 1024 / 1024).toFixed(1)} MB</small></div></div><div><strong title={item.owner?.displayName || item.owner?.username || "未命名用户"}>{item.owner?.displayName || item.owner?.username || "未命名用户"}</strong><small title={item.owner?.email || "—"}>{item.owner?.email || "—"}</small></div><time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time><span className="status-pill ready">{item.status === "queued_for_analysis" ? `待分析 · ${item.progress}%` : item.status === "analyzing" ? `分析中 · ${item.progress}%` : item.status === "completed" ? "已完成" : item.status === "failed" ? "失败" : item.status}</span><div className="admin-table-actions"><button className="button small ghost" onClick={() => setProcessing({ id: item.id, status: item.status === "uploading" ? "queued_for_analysis" : item.status, progress: item.progress || 0, result: item.result || "", feedback: item.feedback || "" })}><GearSix size={15} /> 处理</button><button className="button small secondary" onClick={() => download(item)}><DownloadSimple size={15} /> 下载</button></div></article>)}</div> : <EmptyState icon={FileZip} title="当前筛选范围没有附件" text="调整关键词或日期后重新搜索。" />}
    <footer className="admin-module-footer"><span>共 {pagination.total || 0} 个附件</span><code>GET /api/v1/brain/attachments/latest?date={today}</code><button className="button small ghost" disabled={(pagination.page || 1) >= (pagination.pages || 1)} onClick={() => load((pagination.page || 1) + 1)}>下一页</button></footer>
    {processing && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setProcessing(null)}><form className="admin-form-modal" onSubmit={saveProcessing}><button className="modal-close" type="button" onClick={() => setProcessing(null)}><X size={18} /></button><span>ANALYSIS FEEDBACK</span><h2>更新处理进度与结果</h2><div className="admin-form-grid"><label><span>处理状态</span><select value={processing.status} onChange={(event) => setProcessing({ ...processing, status: event.target.value })}><option value="queued_for_analysis">等待分析</option><option value="analyzing">正在分析</option><option value="completed">处理完成</option><option value="failed">处理失败</option></select></label><label><span>处理进度（0–100）</span><input type="number" min="0" max="100" required value={processing.progress} onChange={(event) => setProcessing({ ...processing, progress: Number(event.target.value) })} /></label><label className="span-2"><span>分析结果</span><textarea maxLength={20000} value={processing.result} onChange={(event) => setProcessing({ ...processing, result: event.target.value })} placeholder="说明发现的问题、需求洞察、可执行改进建议……" /></label><label className="span-2"><span>给用户的反馈</span><textarea maxLength={5000} value={processing.feedback} onChange={(event) => setProcessing({ ...processing, feedback: event.target.value })} placeholder="这段内容会直接显示在用户后台。" /></label></div><AdminNotice>保存后，提交用户会在“用户后台 → 第二大脑”立即看到最新进度、分析结果和反馈。</AdminNotice><button className="button primary full">保存并反馈用户</button></form></div>}
  </section>;
}

function VersionManager() {
  const [keyword, setKeyword] = useState("");
  const [channels, setChannels] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [manualUpload, setManualUpload] = useState(null);

  async function load() {
    try {
      const result = await apiFetch(`/api/admin/release-channels?keyword=${encodeURIComponent(keyword)}`);
      setChannels(result.channels || []); setJobs(result.jobs || []);
    } catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);
  const filtered = useMemo(() => channels.filter((channel) => !keyword || channel.name.toLowerCase().includes(keyword.toLowerCase())), [channels, keyword]);

  async function release(channel) {
    setMessage("");
    try {
      const result = await apiFetch("/api/admin/release-jobs", { method: "POST", body: JSON.stringify({ channelId: channel.id }) });
      setMessage(`${result.channelName} 已进入发行队列；Windows 工作器会自动调用既有版本发布工作流。`);
      await load();
    } catch (error) { setMessage(error.message); }
  }

  async function uploadRelease(event) {
    event.preventDefault();
    if (!manualUpload?.file) return;
    setManualUpload((current) => ({ ...current, busy: true, error: "", progress: 2 }));
    try {
      const { channel, file, version } = manualUpload;
      const ticket = await apiFetch(`/api/admin/release-channels/${channel.id}/manual-upload`, {
        method: "POST",
        body: JSON.stringify({ filename: file.name, bytes: file.size, version }),
      });
      await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", ticket.uploadUrl, true);
        Object.entries(ticket.requiredHeaders || {}).forEach(([name, value]) => request.setRequestHeader(name, value));
        request.upload.onprogress = (progressEvent) => {
          if (progressEvent.lengthComputable) setManualUpload((current) => ({ ...current, progress: Math.max(2, Math.round((progressEvent.loaded / progressEvent.total) * 96)) }));
        };
        request.onerror = () => reject(new Error("上传到腾讯云 COS 失败，请检查网络和 COS 跨域配置"));
        request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`腾讯云 COS 返回 ${request.status}`));
        request.send(file);
      });
      await apiFetch(`/api/admin/release-uploads/${ticket.uploadId}/complete`, { method: "POST", body: "{}" });
      setMessage(`${channel.name} 的 v${version} 已上传并切换为最新版本。`);
      setManualUpload(null);
      await load();
    } catch (error) {
      setManualUpload((current) => ({ ...current, busy: false, error: error.message, progress: 0 }));
    }
  }

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>RELEASE CONTROL PLANE</span><h2>版本管理</h2><p>每个“主题访问权限”用户分组对应一个发行渠道；每个渠道只保留一个最新安装包。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} /> 刷新状态</button></header>
    <AdminNotice>发版按钮只创建一个渠道任务。Windows 发行工作器会调用会话 019f91fb… 产出的安全脚本，完成测试、品牌事务、NSIS 打包、SHA-256 与 COS 上传。</AdminNotice>
    {message && <AdminNotice tone={message.includes("进入发行队列") || message.includes("已上传并切换") ? "success" : "error"}>{message}</AdminNotice>}
    <div className="release-picker"><button className="release-picker-trigger" onClick={() => setOpen(!open)}><div><span>选择用户分组 / 发行渠道</span><strong>{channels.length ? `${channels.length} 个可用渠道` : "等待工作器同步分组"}</strong></div><MagnifyingGlass size={19} /></button>{open && <div className="release-picker-menu"><label><MagnifyingGlass size={16} /><input autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入用户分组关键词" /></label><div>{filtered.map((channel) => <article key={channel.id}><div><strong>{channel.name}</strong><small>允许主题：{(channel.themeNames || []).join("、")}</small>{channel.latestRelease && <span>当前 v{channel.latestRelease.version} · {new Date(channel.latestRelease.publishedAt).toLocaleString("zh-CN")}</span>}</div><div className="release-channel-actions"><button className="button small secondary" onClick={() => setManualUpload({ channel, version: channel.latestRelease?.version || "1.0.0", file: null, busy: false, error: "", progress: 0 })}><CloudArrowUp size={15} /> 上传</button><button className="button small primary" onClick={() => release(channel)}><RocketLaunch size={15} /> 发版</button></div></article>)}{!filtered.length && <p className="release-picker-empty">没有匹配的用户分组。请先运行发行工作器同步桌面端权限文件。</p>}</div></div>}</div>
    <div className="release-job-list"><h3>最近发版任务</h3>{jobs.length ? jobs.map((job) => <article key={job.id}><div className={`job-status ${job.status}`}><span /><strong>{job.status === "queued" ? "排队" : job.status === "building" ? "构建中" : job.status === "uploading" ? "上传中" : job.status === "completed" ? "已发布" : "失败"}</strong></div><div><strong>{job.channelName}</strong><small>{job.version ? `v${job.version}` : "等待生成版本号"} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small></div>{job.error && <p>{job.error}</p>}</article>) : <EmptyState icon={RocketLaunch} title="还没有发版任务" text="从上方用户分组列表选择一个渠道开始发版。" />}</div>
    {manualUpload && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !manualUpload.busy && setManualUpload(null)}><form className="admin-form-modal release-upload-modal" onSubmit={uploadRelease}><button className="modal-close" type="button" disabled={manualUpload.busy} onClick={() => setManualUpload(null)}><X size={18} /></button><span>MANUAL COS RELEASE</span><h2>上传新版本</h2><p>发行渠道：<strong>{manualUpload.channel.name}</strong></p><div className="admin-form-grid"><label><span>版本号</span><input required maxLength={40} value={manualUpload.version} onChange={(event) => setManualUpload({ ...manualUpload, version: event.target.value })} placeholder="例如 1.6.0" /></label><label><span>Windows 安装包</span><input required type="file" accept=".exe,.msix,.msixbundle,.zip,application/octet-stream" onChange={(event) => setManualUpload({ ...manualUpload, file: event.target.files?.[0] || null })} /></label></div><AdminNotice>文件将从浏览器直传成都 COS。新文件校验成功后才替换线上版本，随后清理该渠道旧安装包。</AdminNotice>{manualUpload.busy && <div className="upload-progress"><span style={{ width: `${manualUpload.progress}%` }} /><em>{manualUpload.progress}%</em></div>}{manualUpload.error && <div className="form-error">{manualUpload.error}</div>}<button className="button primary full" disabled={manualUpload.busy || !manualUpload.file}><CloudArrowUp size={18} /> {manualUpload.busy ? "正在上传并校验" : "上传并设为最新版"}</button></form></div>}
  </section>;
}

function OfflinePaymentManager() {
  const [orders, setOrders] = useState([]);
  const [activeTab, setActiveTab] = useState("pending");
  const [summary, setSummary] = useState({ pending: 0, reviewed: 0, approved: 0, rejected: 0 });
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState(null);
  const [busy, setBusy] = useState("");
  async function load(tab = activeTab) {
    try {
      const result = await apiFetch(`/api/admin/offline-payments?status=${tab}`);
      setOrders(result.orders || []);
      setSummary(result.summary || { pending: 0, reviewed: 0, approved: 0, rejected: 0 });
    } catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(activeTab); }, [activeTab]);
  async function approve(order) {
    if (!window.confirm(`确认 ${order.userEmail || order.orderNo} 已到账并开通会员吗？`)) return;
    setBusy(order.id);
    try { await apiFetch(`/api/admin/offline-payments/${order.id}/approve`, { method: "POST", body: "{}" }); setMessage("已确认到账，权益已写入官网并尝试同步 Chandler。"); await load("pending"); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  async function reject(event) {
    event.preventDefault();
    setBusy(rejecting.order.id); setMessage("");
    try {
      await apiFetch(`/api/admin/offline-payments/${rejecting.order.id}/reject`, { method: "POST", body: JSON.stringify({ reason: rejecting.reason }) });
      setRejecting(null); setMessage("已拒绝该申请，用户后台已收到原因与重新申请入口。"); await load("pending");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  return <section className="admin-module"><header className="admin-module-head"><div><span>CHANDLER OFFLINE REVIEW</span><h2>线下支付审核</h2><p>订单先持久化到 MongoDB，再镜像到 Chandler；通过或拒绝都会给用户发送站内消息。</p></div><button className="button secondary" onClick={() => load(activeTab)}><ArrowClockwise size={17} /> 刷新</button></header>{message && <AdminNotice tone={message.startsWith("已") ? "success" : "error"}>{message}</AdminNotice>}<div className="offline-review-tabs" role="tablist" aria-label="线下支付审核状态"><button type="button" role="tab" aria-selected={activeTab === "pending"} className={activeTab === "pending" ? "active" : ""} onClick={() => { setMessage(""); setActiveTab("pending"); }}><span>待审核</span><strong>{summary.pending}</strong></button><button type="button" role="tab" aria-selected={activeTab === "reviewed"} className={activeTab === "reviewed" ? "active" : ""} onClick={() => { setMessage(""); setActiveTab("reviewed"); }}><span>已审核</span><strong>{summary.reviewed}</strong></button></div>{orders.length ? <div className="offline-order-grid">{orders.map((order) => <article key={order.id}><header><div><span>{order.cycle === "year" ? "年度会员" : "月度会员"}</span><strong>{formatMoney(order.amountFen)}</strong></div><span className={`status-pill ${order.status}`}>{order.status === "pending" ? "待审核" : order.status === "approved" ? "已通过" : "已拒绝"}</span></header><dl><div><dt>订单号</dt><dd>{order.orderNo}</dd></div><div><dt>用户</dt><dd>{order.userEmail || order.ownerId}</dd></div><div><dt>{activeTab === "reviewed" ? "审核时间" : "提交时间"}</dt><dd>{new Date(activeTab === "reviewed" ? order.reviewedAt || order.updatedAt || order.createdAt : order.createdAt).toLocaleString("zh-CN")}</dd></div><div><dt>Chandler</dt><dd>{order.chandlerOrderNo || "等待镜像"}</dd></div></dl>{order.previousReviewReason && <div className="offline-review-history"><strong>上次拒绝：</strong>{order.previousReviewReason}<br /><strong>用户调整：</strong>{order.resubmissionNote || "未填写"}</div>}{order.reviewReason && <div className="offline-review-history rejected"><strong>拒绝原因：</strong>{order.reviewReason}</div>}{order.status === "pending" && <div className="offline-review-actions"><button className="button primary" disabled={busy === order.id} onClick={() => approve(order)}><CheckCircle size={17} /> 确认到账并通过</button><button className="button danger" disabled={busy === order.id} onClick={() => setRejecting({ order, reason: "" })}><X size={17} /> 拒绝通过</button></div>}</article>)}</div> : <EmptyState icon={ShieldCheck} title={activeTab === "pending" ? "当前没有待审核申请" : "还没有已审核记录"} text={activeTab === "pending" ? "新的线下支付申请会优先显示在这里。" : "已通过和已拒绝的申请会统一保留在这里。"} />}{rejecting && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setRejecting(null)}><form className="admin-form-modal offline-reject-modal" onSubmit={reject}><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setRejecting(null)}><X size={18} /></button><span>REJECT OFFLINE PAYMENT</span><h2>拒绝通过</h2><p>订单：<strong>{rejecting.order.orderNo}</strong></p><label><span>拒绝原因</span><textarea required minLength={2} maxLength={500} autoFocus value={rejecting.reason} onChange={(event) => setRejecting({ ...rejecting, reason: event.target.value })} placeholder="请清楚说明金额、付款截图或订单信息中需要用户调整的内容。" /></label><div className="offline-reject-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => setRejecting(null)}>取消</button><button className="button danger" disabled={Boolean(busy)}><FloppyDisk size={17} /> {busy ? "正在保存" : "保存拒绝原因"}</button></div></form></div>}</section>;
}

export function AdminPage({ user, openAuth }) {
  const [active, setActive] = useState("dashboard");
  if (!user) return <main id="main-content" className="admin-gate section-shell"><LockKey size={38} /><h1>登录管理员账号</h1><p>管理员后台已接入 Chandler 统一身份，只接受 Chandler 返回的管理员角色。</p><button className="button primary" onClick={() => openAuth("login")}>登录继续</button></main>;
  if (user.role !== "admin") return <main id="main-content" className="admin-gate section-shell"><ShieldCheck size={38} /><h1>当前账号没有后台权限</h1><p>请让 Chandler 平台管理员授予此账号管理员角色后重新登录。</p></main>;
  return <main id="main-content" className="admin-page"><aside className="admin-sidebar"><div><span>GULONG CONSOLE</span><h1>管理员后台</h1><p>{user.displayName || user.username || user.email}</p></div><nav>{menu.map((item) => { const Icon = item.icon; return <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}><Icon size={19} weight={active === item.id ? "fill" : "regular"} /> {item.label}</button>; })}</nav><footer><UsersThree size={18} /><span>Chandler 统一账号</span></footer></aside><div className="admin-content">{active === "dashboard" && <AdminDashboard />}{active === "users" && <ChandlerUserManager />}{active === "prices" && <ChandlerPriceManager />}{active === "partners" && <PartnerManager />}{active === "brain" && <BrainAttachmentManager />}{active === "versions" && <VersionManager />}{active === "payments" && <OfflinePaymentManager />}</div></main>;
}
