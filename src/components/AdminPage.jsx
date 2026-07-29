import {
  ArrowClockwise,
  ArrowSquareOut,
  CalendarBlank,
  CheckCircle,
  CloudArrowDown,
  Cube,
  DownloadSimple,
  FileZip,
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

const menu = [
  { id: "users", label: "用户与订阅", icon: UsersThree },
  { id: "prices", label: "订阅价格", icon: Cube },
  { id: "partners", label: "合作伙伴", icon: Handshake },
  { id: "brain", label: "第二大脑", icon: FileZip },
  { id: "versions", label: "版本管理", icon: Package },
  { id: "payments", label: "线下支付", icon: ShieldCheck },
];

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
    setSelected(user); setSubscriptions([]); setMessage("");
    try {
      const result = await apiFetch(`/api/admin/chandler/users/${encodeURIComponent(user.id)}/subscriptions`);
      setSubscriptions(result.subscriptions || []);
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
    <header className="admin-module-head"><div><span>CHANDLER IDENTITY CONTROL</span><h2>用户与订阅</h2><p>搜索 Chandler 真实用户、冻结或恢复账号、查看订阅，并发起权益双人审批。</p></div><div className="storage-badge"><ShieldCheck size={18} /><span>数据来源</span><strong>Chandler OpenAPI</strong></div></header>
    <form className="admin-filterbar" onSubmit={load}><label><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮箱、昵称、手机号" /></label><button className="button secondary" disabled={busy === "search"}><MagnifyingGlass size={16} /> {busy === "search" ? "搜索中" : "搜索"}</button><span>共 {meta.total ?? users.length} 个结果</span></form>
    {message && <AdminNotice tone={message.includes("已") ? "success" : "error"}>{message}</AdminNotice>}
    {users.length ? <div className="chandler-user-list">{users.map((user) => <article key={user.id}><div className="chandler-user-avatar">{(user.display_name || user.email || "U").slice(0, 1).toUpperCase()}</div><div><strong>{user.display_name || "未设置昵称"}</strong><span>{user.email || user.phone || user.id}</span><small>{user.id}</small></div><span className={`status-pill ${user.status || "active"}`}>{user.status === "disabled" ? "已冻结" : user.status === "deleted" ? "已删除" : "正常"}</span><div className="admin-row-actions"><button className="button small ghost" onClick={() => inspect(user)}>订阅详情</button>{user.status !== "deleted" && <button className="button small secondary" disabled={busy === user.id} onClick={() => changeStatus(user)}>{user.status === "disabled" ? "恢复" : "冻结"}</button>}<button className="button small primary" onClick={() => setGrant({ user, entitlementCode: "gulong.member", validUntil: new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 16), reason: "管理员根据线下合同申请开通古龙会员权益" })}>申请权益</button></div></article>)}</div> : <EmptyState icon={UsersThree} title="没有匹配用户" text="尝试使用邮箱、昵称或手机号的一部分重新搜索。" />}
    {selected && <div className="admin-detail-panel"><header><div><span>SUBSCRIPTIONS</span><h3>{selected.display_name || selected.email || selected.id} 的订阅</h3></div><button className="icon-danger" onClick={() => setSelected(null)}><X size={17} /></button></header>{subscriptions.length ? subscriptions.map((subscription, index) => <article key={subscription.id || index}><strong>{subscription.status || "unknown"}</strong><span>{subscription.sku_name || subscription.sku_id || subscription.product_name || "订阅套餐"}</span><time>有效至 {subscription.current_period_end ? new Date(subscription.current_period_end).toLocaleString("zh-CN") : subscription.valid_until ? new Date(subscription.valid_until).toLocaleString("zh-CN") : "未返回"}</time></article>) : <p>该用户当前没有订阅记录。</p>}</div>}
    {grant && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setGrant(null)}><form className="admin-form-modal" onSubmit={requestGrant}><button className="modal-close" type="button" onClick={() => setGrant(null)}><X size={18} /></button><span>DUAL APPROVAL</span><h2>申请订阅权益</h2><p>目标用户：{grant.user.email || grant.user.id}</p><div className="admin-form-grid"><label><span>权益代码</span><input required value={grant.entitlementCode} onChange={(event) => setGrant({ ...grant, entitlementCode: event.target.value })} /></label><label><span>有效期至</span><input required type="datetime-local" value={grant.validUntil} onChange={(event) => setGrant({ ...grant, validUntil: event.target.value })} /></label><label className="span-2"><span>申请原因</span><textarea required minLength={2} maxLength={1024} value={grant.reason} onChange={(event) => setGrant({ ...grant, reason: event.target.value })} /></label></div><AdminNotice>申请将进入 Chandler 双人审批，申请人不能审批自己的请求。</AdminNotice><button className="button primary full" disabled={busy === "grant"}>{busy === "grant" ? "提交中" : "提交审批"}</button></form></div>}
  </section>;
}

function ChandlerPriceManager() {
  const [plans, setPlans] = useState([]);
  const [targets, setTargets] = useState({ month: 0, year: 0 });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  async function load() {
    setMessage("");
    try { const result = await apiFetch("/api/admin/chandler/catalog"); setPlans(result.plans || []); setTargets(result.targetPrices || {}); }
    catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);
  async function publish(plan) {
    const yearly = `${plan.skuType} ${plan.billingInterval}`.toLowerCase().includes("year");
    const target = yearly ? targets.year : targets.month;
    if (!window.confirm(`为 ${plan.skuName || plan.skuId} 发布新价格 ${formatMoney(target)}？旧版本会由 Chandler 自动替代。`)) return;
    setBusy(plan.skuId); setMessage("");
    try {
      await apiFetch("/api/admin/chandler/prices", { method: "POST", body: JSON.stringify({ skuId: plan.skuId, effectiveAt: new Date(Date.now() + 60_000).toISOString() }) });
      setMessage("新价格版本已发布，将在约一分钟后生效。"); await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  return <section className="admin-module"><header className="admin-module-head"><div><span>IMMUTABLE PRICE VERSIONS</span><h2>订阅价格</h2><p>读取 Chandler 实时目录；发布时由官网固定目标价格推导金额，避免前端篡改。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} /> 刷新实时价格</button></header>{message && <AdminNotice tone={message.includes("已发布") ? "success" : "error"}>{message}</AdminNotice>}<div className="price-admin-grid">{plans.map((plan) => { const yearly = `${plan.skuType} ${plan.billingInterval}`.toLowerCase().includes("year"); const target = yearly ? targets.year : targets.month; const matches = plan.amountFen === target; return <article key={plan.skuId}><span>{yearly ? "YEARLY" : "MONTHLY"}</span><h3>{plan.productName}</h3><p>{plan.skuName}</p><div><strong>{formatMoney(plan.amountFen)}</strong><small>当前实时价格</small></div><div><strong>{formatMoney(target)}</strong><small>官网目标价格</small></div><span className={`price-sync-state ${matches ? "ready" : "pending"}`}>{matches ? "已同步" : "需要发布新版本"}</span><button className="button primary full" disabled={matches || busy === plan.skuId} onClick={() => publish(plan)}>{busy === plan.skuId ? "发布中" : matches ? "无需更新" : "发布目标价格"}</button></article>; })}</div>{!plans.length && <EmptyState title="没有可用订阅套餐" text="请先在 Chandler 建立并上架月度、年度订阅 SKU。" />}</section>;
}

function PartnerManager() {
  const [partners, setPartners] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ name: "", websiteUrl: "https://", logoMode: "generated", logoUrl: "", sort: 100, enabled: true });
  const [state, setState] = useState({ busy: false, message: "" });

  async function load() {
    try { setPartners((await apiFetch("/api/admin/partners")).partners || []); }
    catch (error) { setState({ busy: false, message: error.message }); }
  }
  useEffect(() => { load(); }, []);

  async function create(event) {
    event.preventDefault();
    setState({ busy: true, message: "" });
    try {
      await apiFetch("/api/admin/partners", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", websiteUrl: "https://", logoMode: "generated", logoUrl: "", sort: 100, enabled: true });
      setFormOpen(false);
      setState({ busy: false, message: "合作伙伴已创建，首页模块会自动更新。" });
      await load();
    } catch (error) { setState({ busy: false, message: error.message }); }
  }

  async function remove(id) {
    if (!window.confirm("确定删除这个合作伙伴吗？首页会立即停止展示。")) return;
    await apiFetch(`/api/admin/partners/${id}`, { method: "DELETE" });
    await load();
  }

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>PARTNER ECOSYSTEM</span><h2>合作伙伴管理</h2><p>生成品牌 Logo、绑定官网域名，并自动展示到首页“他们都在用古龙智能引擎”。</p></div><button className="button primary" onClick={() => setFormOpen(true)}><Plus size={17} /> 新建合作伙伴</button></header>
    {state.message && <AdminNotice tone={state.message.startsWith("合作伙伴已") ? "success" : "error"}>{state.message}</AdminNotice>}
    {partners.length ? <div className="admin-partner-grid">{partners.map((partner) => <article key={partner.id}><div className="admin-logo-frame"><img src={partner.logoPreviewUrl} alt={`${partner.name} Logo`} /></div><div><strong>{partner.name}</strong><a href={partner.websiteUrl} target="_blank" rel="noreferrer">{new URL(partner.websiteUrl).hostname} <ArrowSquareOut size={13} /></a><small>{partner.logoMode === "generated" ? "官网自动生成 Logo" : "使用外部 Logo"} · 排序 {partner.sort}</small></div><button className="icon-danger" onClick={() => remove(partner.id)} aria-label={`删除 ${partner.name}`}><Trash size={17} /></button></article>)}</div> : <EmptyState icon={Handshake} title="还没有合作伙伴" text="创建第一家伙伴后，首页会自动出现品牌展示模块。" />}
    {formOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setFormOpen(false)}><form className="admin-form-modal" onSubmit={create}><button className="modal-close" type="button" onClick={() => setFormOpen(false)}><X size={18} /></button><span>NEW PARTNER</span><h2>新建合作伙伴</h2><div className="admin-form-grid"><label><span>合作伙伴名称</span><input required minLength={2} maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：中科智能" /></label><label><span>官网域名链接</span><input required type="url" value={form.websiteUrl} onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })} placeholder="https://example.com" /></label><label><span>Logo 方式</span><select value={form.logoMode} onChange={(event) => setForm({ ...form, logoMode: event.target.value })}><option value="generated">根据名称自动生成</option><option value="url">使用 HTTPS 图片链接</option></select></label>{form.logoMode === "url" && <label><span>Logo 图片链接</span><input required type="url" value={form.logoUrl} onChange={(event) => setForm({ ...form, logoUrl: event.target.value })} placeholder="https://example.com/logo.png" /></label>}<label><span>首页排序</span><input type="number" value={form.sort} onChange={(event) => setForm({ ...form, sort: Number(event.target.value) })} /></label></div><div className="logo-generation-hint"><ImageSquare size={25} /><div><strong>自动生成规则</strong><p>使用品牌名称、东方玉瓷留白和古龙主题色生成响应式 SVG，可直接用于首页浅色背景。</p></div></div><button className="button primary full" disabled={state.busy}>{state.busy ? "正在创建" : "生成 Logo 并创建伙伴"}</button></form></div>}
  </section>;
}

function BrainAttachmentManager() {
  const today = new Date().toISOString().slice(0, 10);
  const [filters, setFilters] = useState({ keyword: "", from: today, to: today });
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, page: 1, pages: 0 });
  const [message, setMessage] = useState("");

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

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>TENCENT COS ARCHIVE</span><h2>第二大脑附件</h2><p>按文件名模糊搜索、按北京时间日期筛选，并生成 15 分钟有效的私有下载地址。</p></div><div className="storage-badge"><CloudArrowDown size={18} /><span>成都 COS</span><strong>gulong-1259744534</strong></div></header>
    <form className="admin-filterbar" onSubmit={(event) => { event.preventDefault(); load(1); }}><label><MagnifyingGlass size={17} /><input value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} placeholder="搜索文件名关键词" /></label><label><CalendarBlank size={17} /><input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label><span>至</span><label><CalendarBlank size={17} /><input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label><button className="button secondary"><MagnifyingGlass size={16} /> 搜索</button></form>
    {message && <AdminNotice tone="error">{message}</AdminNotice>}
    {items.length ? <div className="admin-table"><div className="admin-table-head"><span>附件</span><span>提交用户</span><span>提交时间</span><span>状态</span><span>操作</span></div>{items.map((item) => <article key={item.id}><div className="file-cell"><FileZip size={21} /><div><strong>{item.originalName}</strong><small>{(item.size / 1024 / 1024).toFixed(1)} MB</small></div></div><div><strong>{item.owner?.displayName || item.owner?.username || "未命名用户"}</strong><small>{item.owner?.email || "—"}</small></div><time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time><span className="status-pill ready">{item.status === "queued_for_analysis" ? "待分析" : item.status}</span><button className="button small secondary" onClick={() => download(item)}><DownloadSimple size={15} /> 下载</button></article>)}</div> : <EmptyState icon={FileZip} title="当前筛选范围没有附件" text="调整关键词或日期后重新搜索。" />}
    <footer className="admin-module-footer"><span>共 {pagination.total || 0} 个附件</span><code>GET /api/v1/brain/attachments/latest?date={today}</code><button className="button small ghost" disabled={(pagination.page || 1) >= (pagination.pages || 1)} onClick={() => load((pagination.page || 1) + 1)}>下一页</button></footer>
  </section>;
}

function VersionManager() {
  const [keyword, setKeyword] = useState("");
  const [channels, setChannels] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState("");

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

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>RELEASE CONTROL PLANE</span><h2>版本管理</h2><p>每个“主题访问权限”用户分组对应一个发行渠道；每个渠道只保留一个最新安装包。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} /> 刷新状态</button></header>
    <AdminNotice>发版按钮只创建一个渠道任务。Windows 发行工作器会调用会话 019f91fb… 产出的安全脚本，完成测试、品牌事务、NSIS 打包、SHA-256 与 COS 上传。</AdminNotice>
    {message && <AdminNotice tone={message.includes("进入发行队列") ? "success" : "error"}>{message}</AdminNotice>}
    <div className="release-picker"><button className="release-picker-trigger" onClick={() => setOpen(!open)}><div><span>选择用户分组 / 发行渠道</span><strong>{channels.length ? `${channels.length} 个可用渠道` : "等待工作器同步分组"}</strong></div><MagnifyingGlass size={19} /></button>{open && <div className="release-picker-menu"><label><MagnifyingGlass size={16} /><input autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入用户分组关键词" /></label><div>{filtered.map((channel) => <article key={channel.id}><div><strong>{channel.name}</strong><small>允许主题：{(channel.themeNames || []).join("、")}</small>{channel.latestRelease && <span>当前 v{channel.latestRelease.version} · {new Date(channel.latestRelease.publishedAt).toLocaleString("zh-CN")}</span>}</div><button className="button small primary" onClick={() => release(channel)}><RocketLaunch size={15} /> 发版</button></article>)}{!filtered.length && <p className="release-picker-empty">没有匹配的用户分组。请先运行发行工作器同步桌面端权限文件。</p>}</div></div>}</div>
    <div className="release-job-list"><h3>最近发版任务</h3>{jobs.length ? jobs.map((job) => <article key={job.id}><div className={`job-status ${job.status}`}><span /><strong>{job.status === "queued" ? "排队" : job.status === "building" ? "构建中" : job.status === "uploading" ? "上传中" : job.status === "completed" ? "已发布" : "失败"}</strong></div><div><strong>{job.channelName}</strong><small>{job.version ? `v${job.version}` : "等待生成版本号"} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small></div>{job.error && <p>{job.error}</p>}</article>) : <EmptyState icon={RocketLaunch} title="还没有发版任务" text="从上方用户分组列表选择一个渠道开始发版。" />}</div>
  </section>;
}

function OfflinePaymentManager() {
  const [orders, setOrders] = useState([]);
  const [message, setMessage] = useState("");
  async function load() { try { setOrders((await apiFetch("/api/admin/offline-payments")).orders || []); } catch (error) { setMessage(error.message); } }
  useEffect(() => { load(); }, []);
  async function approve(order) {
    if (!window.confirm(`确认 ${order.userEmail || order.orderNo} 已到账并开通会员吗？`)) return;
    try { await apiFetch(`/api/admin/offline-payments/${order.id}/approve`, { method: "POST", body: "{}" }); setMessage("已确认到账，权益已写入官网并尝试同步 Chandler。"); await load(); }
    catch (error) { setMessage(error.message); }
  }
  return <section className="admin-module"><header className="admin-module-head"><div><span>CHANDLER OFFLINE REVIEW</span><h2>线下支付审核</h2><p>订单先持久化到 MongoDB，再镜像到 Chandler；确认到账后同步订阅有效期与用户扩展属性。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} /> 刷新</button></header>{message && <AdminNotice tone={message.startsWith("已确认") ? "success" : "error"}>{message}</AdminNotice>}{orders.length ? <div className="offline-order-grid">{orders.map((order) => <article key={order.id}><header><div><span>{order.cycle === "year" ? "年度会员" : "月度会员"}</span><strong>{formatMoney(order.amountFen)}</strong></div><span className={`status-pill ${order.status}`}>{order.status === "pending" ? "待审核" : order.status === "approved" ? "已通过" : "已拒绝"}</span></header><dl><div><dt>订单号</dt><dd>{order.orderNo}</dd></div><div><dt>用户</dt><dd>{order.userEmail || order.ownerId}</dd></div><div><dt>提交时间</dt><dd>{new Date(order.createdAt).toLocaleString("zh-CN")}</dd></div><div><dt>Chandler</dt><dd>{order.chandlerOrderNo || "等待镜像"}</dd></div></dl>{order.status === "pending" && <button className="button primary full" onClick={() => approve(order)}><CheckCircle size={17} /> 确认到账并通过</button>}</article>)}</div> : <EmptyState icon={ShieldCheck} title="没有线下支付申请" text="用户在定价页选择“线下支付”后，申请会显示在这里。" />}</section>;
}

export function AdminPage({ user, openAuth }) {
  const [active, setActive] = useState("users");
  if (!user) return <main id="main-content" className="admin-gate section-shell"><LockKey size={38} /><h1>登录管理员账号</h1><p>管理员后台已接入 Chandler 统一身份，只接受 Chandler 返回的管理员角色。</p><button className="button primary" onClick={() => openAuth("login")}>登录继续</button></main>;
  if (user.role !== "admin") return <main id="main-content" className="admin-gate section-shell"><ShieldCheck size={38} /><h1>当前账号没有后台权限</h1><p>请让 Chandler 平台管理员授予此账号管理员角色后重新登录。</p></main>;
  return <main id="main-content" className="admin-page"><aside className="admin-sidebar"><div><span>GULONG CONSOLE</span><h1>管理员后台</h1><p>{user.displayName || user.username || user.email}</p></div><nav>{menu.map((item) => { const Icon = item.icon; return <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}><Icon size={19} weight={active === item.id ? "fill" : "regular"} /> {item.label}</button>; })}</nav><footer><UsersThree size={18} /><span>Chandler 统一账号</span></footer></aside><div className="admin-content">{active === "users" && <ChandlerUserManager />}{active === "prices" && <ChandlerPriceManager />}{active === "partners" && <PartnerManager />}{active === "brain" && <BrainAttachmentManager />}{active === "versions" && <VersionManager />}{active === "payments" && <OfflinePaymentManager />}</div></main>;
}
