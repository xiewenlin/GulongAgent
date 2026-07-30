import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  CalendarBlank,
  Briefcase,
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
  PencilSimple,
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
  { id: "payments", label: "订单管理", icon: ShieldCheck },
  { id: "worker", label: "威客审核", icon: Briefcase },
];

const subscriptionStatusLabels = {
  active: "生效中",
  pending: "待处理",
  pending_review: "待人工审核",
  approved: "已通过",
  canceled: "已取消",
  cancelled: "已取消",
  expired: "已到期",
  scheduled: "尚未生效",
  inactive: "未生效",
  rejected: "已拒绝",
};

function AdminNotice({ children, tone = "info" }) {
  return <div className={`admin-notice ${tone}`}><ShieldCheck size={18} /> <span>{children}</span></div>;
}

function EmptyState({ icon: Icon = Cube, title, text }) {
  return <div className="admin-empty"><Icon size={34} weight="duotone" /><strong>{title}</strong><p>{text}</p></div>;
}

function ReleaseChannelOptions({ channels }) {
  const defaultChannel = channels.find((channel) => channel.isDefault);
  return <><option value="">全部发行渠道</option><option value={defaultChannel?.id || "unassigned"}>古龙版（默认）</option>{channels.filter((channel) => channel.id !== defaultChannel?.id).map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</>;
}

function ChandlerUserManager() {
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channels, setChannels] = useState([]);
  const [users, setUsers] = useState([]);
  const [meta, setMeta] = useState({});
  const [selected, setSelected] = useState(null);
  const [subscriptions, setSubscriptions] = useState([]);
  const [subscriptionMeta, setSubscriptionMeta] = useState({});
  const [grant, setGrant] = useState(null);
  const [periodEditor, setPeriodEditor] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load(event) {
    event?.preventDefault();
    setBusy("search"); setMessage("");
    try {
      const params = new URLSearchParams({ q: query, limit: "50" });
      if (channelId) params.set("channelId", channelId);
      const result = await apiFetch(`/api/admin/chandler/users?${params}`);
      setUsers(result.users || []); setMeta(result.meta || {});
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  useEffect(() => {
    load();
    apiFetch("/api/admin/release-channels").then((result) => setChannels(result.channels || [])).catch(() => setChannels([]));
  }, []);

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

  async function promoteToAdmin(user) {
    if (!window.confirm(`确认将 ${user.display_name || user.email || user.id} 设置为古龙官网管理员吗？`)) return;
    setBusy(`role-${user.id}`); setMessage("");
    try {
      const result = await apiFetch(`/api/admin/users/${encodeURIComponent(user.website_user_id || user.id)}/role`, { method: "PUT", body: JSON.stringify({ role: "admin" }) });
      setMessage(result.message || "用户已提升为管理员。");
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  function openPeriodEditor() {
    const subscription = subscriptions.find((item) => item.authoritative)
      || subscriptions.find((item) => item.source === "website" && item.current_period_end)
      || subscriptions.find((item) => item.current_period_end || item.valid_until);
    const start = subscription?.current_period_start || subscription?.valid_from || new Date();
    const end = subscription?.current_period_end || subscription?.valid_until || new Date(Date.now() + 365 * 86_400_000);
    setPeriodEditor({
      user: selected,
      currentPeriodStart: localDateTimeValue(start),
      currentPeriodEnd: localDateTimeValue(end),
    });
  }

  async function saveSubscriptionPeriod(event) {
    event.preventDefault();
    const start = new Date(periodEditor.currentPeriodStart);
    const end = new Date(periodEditor.currentPeriodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setMessage("到期时间必须晚于生效时间。");
      return;
    }
    setBusy("period"); setMessage("");
    try {
      const user = periodEditor.user;
      const result = await apiFetch(`/api/admin/users/${encodeURIComponent(user.website_user_id || user.id)}/subscription-period`, {
        method: "PUT",
        body: JSON.stringify({ currentPeriodStart: start.toISOString(), currentPeriodEnd: end.toISOString() }),
      });
      setPeriodEditor(null);
      await inspect(user);
      setMessage(result.message || "会员有效期已保存并同步到用户端。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>UNIFIED SUBSCRIPTION DIRECTORY</span><h2>订阅用户</h2><p>统一查看官网用户、古龙版与永生花版 Chandler 应用授权用户，以及实时会员有效期和线下审核记录。</p></div><div className="storage-badge"><ShieldCheck size={18} /><span>数据来源</span><strong>{busy === "search" && !users.length ? "同步中" : meta.synchronized ? "官网 + Chandler 应用" : "官网同步快照"}</strong></div></header>
    <form className="admin-filterbar" onSubmit={load}><label><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮箱、昵称或用户 ID" /></label><select aria-label="选择用户分组或发行渠道" value={channelId} onChange={(event) => setChannelId(event.target.value)}><ReleaseChannelOptions channels={channels} /></select><button className="button secondary" disabled={busy === "search"}><MagnifyingGlass size={16} /> {busy === "search" ? "搜索中" : "搜索"}</button><span>共 {meta.total ?? users.length} 个结果</span></form>
    {message && <AdminNotice tone={message.includes("已") ? "success" : "error"}>{message}</AdminNotice>}
    {meta.permissionLimited && <AdminNotice>Chandler 应用用户同步暂不可用，当前显示最近一次官网同步快照；请重新登录，或确认当前 Chandler 账号已加入古龙应用团队。</AdminNotice>}
    {!meta.permissionLimited && meta.partial && <AdminNotice>古龙版与永生花版中有一个应用暂未完成同步；当前已合并展示成功同步的应用与官网用户。</AdminNotice>}
    {users.length ? <div className="chandler-user-list">{users.map((user) => <article key={user.id}><div className="chandler-user-avatar">{(user.display_name || user.email || "U").slice(0, 1).toUpperCase()}</div><div><strong>{user.display_name || "未设置昵称"}</strong><span>{user.email || user.phone || user.id}</span><small>{user.edition_name ? `${user.edition_name} · ` : ""}{user.role === "admin" ? "管理员" : "普通用户"}</small></div><span className={`status-pill ${user.status || "active"}`}>{user.status === "disabled" ? "已冻结" : user.status === "deleted" ? "已删除" : "正常"}</span><div className="admin-row-actions"><button className="button small ghost" onClick={() => inspect(user)}>订阅详情</button>{user.role !== "admin" && <button className="button small primary" disabled={busy === `role-${user.id}`} onClick={() => promoteToAdmin(user)}><ShieldCheck size={16} />{busy === `role-${user.id}` ? "设置中" : "设为管理员"}</button>}{meta.capabilities?.globalUserStatus === true && user.status !== "deleted" && <button className="button small secondary" disabled={busy === user.id} onClick={() => changeStatus(user)}>{user.status === "disabled" ? "恢复" : "冻结"}</button>}{meta.capabilities?.globalEntitlementApproval === true && <button className="button small primary" onClick={() => setGrant({ user, entitlementCode: "gulong.member", validUntil: new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 16), reason: "管理员根据线下合同申请开通古龙会员权益" })}>申请权益</button>}</div></article>)}</div> : <EmptyState icon={UsersThree} title="没有匹配用户" text="尝试使用邮箱、昵称或用户 ID 的一部分重新搜索。" />}
    {selected && <div className="admin-detail-panel"><header><div><span>SUBSCRIPTIONS</span><h3>{selected.display_name || selected.email || selected.id} 的订阅</h3></div><div className="admin-row-actions"><button className="button small primary" type="button" onClick={openPeriodEditor}><CalendarBlank size={17} />修改有效期</button><button className="icon-danger" type="button" onClick={() => setSelected(null)}><X size={17} /></button></div></header>{subscriptionMeta.permissionLimited && <AdminNotice>Chandler 应用订阅属性暂未同步，当前显示官网权威有效期与线下支付审核记录；管理员保存的有效期仍会立即同步到官网和桌面端。</AdminNotice>}{!subscriptionMeta.permissionLimited && subscriptionMeta.partial && <AdminNotice>该用户已有部分 Chandler 应用订阅属性完成同步，官网有效期与线下记录均已合并展示。</AdminNotice>}{subscriptions.length ? subscriptions.map((subscription, index) => { const start = subscription.current_period_start || subscription.valid_from; const end = subscription.current_period_end || subscription.valid_until; return <article key={subscription.id || index}><strong className={`subscription-state ${subscription.status || "unknown"}`}>{subscriptionStatusLabels[subscription.status] || subscription.status || "未知状态"}</strong><span>{subscription.sku_name || subscription.sku_id || subscription.product_name || "订阅套餐"}{subscription.authoritative ? " · 官网权威有效期" : ""}</span><time>{start ? `生效 ${new Date(start).toLocaleString("zh-CN")}` : "生效时间未返回"} · {end ? `到期 ${new Date(end).toLocaleString("zh-CN")}` : subscription.status === "pending_review" ? "等待审核" : "到期时间未返回"}</time></article>; }) : <p>该用户当前没有订阅记录。可点击“修改有效期”直接开通并设置时间。</p>}</div>}
    {periodEditor && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPeriodEditor(null)}><form className="admin-form-modal subscription-period-modal" onSubmit={saveSubscriptionPeriod}><button className="modal-close" type="button" onClick={() => setPeriodEditor(null)}><X size={18} /></button><span>MEMBERSHIP PERIOD</span><h2>修改会员有效期</h2><p>目标用户：{periodEditor.user.display_name || periodEditor.user.email || periodEditor.user.id}</p><div className="admin-form-grid"><label><span>生效时间</span><input required type="datetime-local" value={periodEditor.currentPeriodStart} onChange={(event) => setPeriodEditor({ ...periodEditor, currentPeriodStart: event.target.value })} /></label><label><span>到期时间</span><input required type="datetime-local" value={periodEditor.currentPeriodEnd} onChange={(event) => setPeriodEditor({ ...periodEditor, currentPeriodEnd: event.target.value })} /></label></div><AdminNotice>保存后，官网和桌面端会立即按这段时间判断会员状态；未来时间显示“尚未生效”，超过到期时间自动显示“已到期”。</AdminNotice><button className="button primary full" disabled={busy === "period"}><CalendarBlank size={18} />{busy === "period" ? "保存中" : "保存会员有效期"}</button></form></div>}
    {grant && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setGrant(null)}><form className="admin-form-modal" onSubmit={requestGrant}><button className="modal-close" type="button" onClick={() => setGrant(null)}><X size={18} /></button><span>DUAL APPROVAL</span><h2>申请订阅权益</h2><p>目标用户：{grant.user.email || grant.user.id}</p><div className="admin-form-grid"><label><span>权益代码</span><input required value={grant.entitlementCode} onChange={(event) => setGrant({ ...grant, entitlementCode: event.target.value })} /></label><label><span>有效期至</span><input required type="datetime-local" value={grant.validUntil} onChange={(event) => setGrant({ ...grant, validUntil: event.target.value })} /></label><label className="span-2"><span>申请原因</span><textarea required minLength={2} maxLength={1024} value={grant.reason} onChange={(event) => setGrant({ ...grant, reason: event.target.value })} /></label></div><AdminNotice>申请将进入 Chandler 双人审批，申请人不能审批自己的请求。</AdminNotice><button className="button primary full" disabled={busy === "grant"}>{busy === "grant" ? "提交中" : "提交审批"}</button></form></div>}
  </section>;
}

function localDateTimeValue(value = new Date()) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ChandlerPriceManager() {
  const [plans, setPlans] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [publishing, setPublishing] = useState(null);
  const [history, setHistory] = useState(null);
  async function load() {
    setMessage("");
    try { const result = await apiFetch("/api/admin/chandler/catalog"); setPlans(result.plans || []); }
    catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);
  function openPublish(plan) {
    const yearly = `${plan.skuType} ${plan.billingInterval}`.toLowerCase().includes("year");
    setPublishing({ plan, yearly, amountYuan: ((plan.amountFen ?? 0) / 100).toFixed(2), effectiveAt: localDateTimeValue() });
  }
  async function loadHistory(plan) {
    setHistory({ plan, prices: [], loading: true, error: "" });
    try {
      const result = await apiFetch(`/api/admin/chandler/skus/${encodeURIComponent(plan.skuId)}/prices`);
      setHistory({ plan, prices: result.prices || [], loading: false, error: "" });
    } catch (error) { setHistory({ plan, prices: [], loading: false, error: error.message }); }
  }
  async function publish(event) {
    event.preventDefault();
    const { plan, amountYuan, effectiveAt } = publishing;
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountYuan.trim())) { setMessage("请输入正确的价格，最多保留两位小数。"); return; }
    const amountFen = Math.round(Number(amountYuan) * 100);
    if (amountFen < 100 || amountFen > 5_000_000) { setMessage("订阅价格必须在 ¥1–¥50,000 之间。"); return; }
    const effectiveDate = new Date(effectiveAt);
    if (Number.isNaN(effectiveDate.getTime())) { setMessage("请选择正确的价格生效时间。"); return; }
    setBusy(plan.skuId); setMessage("");
    try {
      const result = await apiFetch("/api/admin/chandler/prices", { method: "POST", body: JSON.stringify({ skuId: plan.skuId, amountFen, effectiveAt: effectiveDate.toISOString() }) });
      setPublishing(null);
      await load();
      setMessage(result.message || "Chandler 远程价格版本已创建，官网与桌面端已完成同步。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  return <section className="admin-module">
    <header className="admin-module-head"><div><span>CHANDLER PRODUCT PRICING V2.2</span><h2>订阅价格</h2><p>直接在 Chandler 远程服务器创建应用级价格版本；远程成功后，官网、下单与桌面端同步接口使用同一价格。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} /> 刷新远程价格</button></header>
    {message && <AdminNotice tone={message.includes("已") || message.includes("成功") ? "success" : "error"}>{message}</AdminNotice>}
    <div className="price-live-api"><CloudArrowDown size={21} weight="duotone" /><div><strong>Chandler 权威定价 · 桌面端实时同步</strong><code>GET /api/v1/pricing/subscriptions</code></div><span>价格下单时由 SKU 校验 · 禁止客户端改价</span></div>
    <div className="price-admin-grid">{plans.map((plan) => {
      const yearly = `${plan.skuType} ${plan.billingInterval}`.toLowerCase().includes("year");
      return <article key={plan.skuId}><span>{yearly ? "YEARLY" : "MONTHLY"}</span><h3>{plan.productName}</h3><p>{plan.skuName}</p><div><strong>{plan.amountFen == null ? "尚未定价" : formatMoney(plan.amountFen)}</strong><small>Chandler 远程生效价</small></div><div><strong>{plan.skuStatus === "inactive" ? "已停售" : "在售"}</strong><small>{plan.remotePriceEffectiveAt ? `生效于 ${new Date(plan.remotePriceEffectiveAt).toLocaleString("zh-CN")}` : "等待首个价格版本"}</small></div><span className={`price-sync-state ${plan.skuStatus === "inactive" || !plan.remotePriceId ? "pending" : "ready"}`}>{plan.remotePriceId ? `远程版本 ${String(plan.remotePriceId).slice(0, 8)}…` : "尚无远程版本"}</span><div className="price-admin-actions"><button className="button secondary" type="button" onClick={() => loadHistory(plan)}>版本记录</button><button className="button primary" disabled={busy === plan.skuId} onClick={() => openPublish(plan)}>{busy === plan.skuId ? "发布中" : plan.remotePriceId ? "修改远程价格" : "创建首个价格"}</button></div></article>;
    })}</div>
    {!plans.length && <EmptyState title="没有可用订阅套餐" text="请先在 Chandler 合作伙伴后台为古龙应用创建月度、年度 SKU 与有效价格。" />}
    {publishing && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setPublishing(null)}><form className="admin-form-modal price-publish-modal" onSubmit={publish}><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setPublishing(null)}><X size={18} /></button><header className="price-publish-head"><div className="price-publish-icon"><CurrencyCny size={30} weight="duotone" /></div><div><span>CHANDLER REMOTE PRICE VERSION</span><h2>{publishing.plan.remotePriceId ? "修改远程订阅价格" : "创建首个远程价格"}</h2><p>{publishing.plan.productName} · {publishing.plan.skuName}</p></div></header><div className="price-compare"><article><span>当前远程价格</span><strong>{publishing.plan.amountFen == null ? "尚未定价" : formatMoney(publishing.plan.amountFen)}</strong><small>版本 {String(publishing.plan.remotePriceId || "尚未创建").slice(0, 12)}</small></article><ArrowRight size={25} /><article className="target price-edit-target"><span>新价格版本</span><label><em>¥</em><input required autoFocus inputMode="decimal" value={publishing.amountYuan} onChange={(event) => setPublishing({ ...publishing, amountYuan: event.target.value })} aria-label="新的订阅价格" /></label><small>{publishing.yearly ? "按年订阅" : "按月订阅"} · 金额单位自动换算为分</small></article></div><label className="price-effective-field"><span><CalendarBlank size={18} /> 价格生效时间</span><input required type="datetime-local" value={publishing.effectiveAt} onChange={(event) => setPublishing({ ...publishing, effectiveAt: event.target.value })} /><small>立即生效或预约未来时间。新版本会替代重叠的旧版本，历史订单金额保持不变。</small></label><div className="price-publish-impact"><ShieldCheck size={23} weight="duotone" /><div><strong>先写入 Chandler，再同步官网</strong><p>系统调用应用级 SKU 价格版本接口。只有 Chandler 远程创建成功后，才会镜像到 MongoDB 和桌面端公开价格接口，不再使用旧的全局管理员价格接口或权限降级覆盖。</p></div></div><div className="price-publish-actions"><button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => setPublishing(null)}>取消</button><button className="button primary" disabled={Boolean(busy)}><RocketLaunch size={18} /> {busy ? "正在创建远程版本" : "发布远程价格版本"}</button></div></form></div>}
    {history && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setHistory(null)}><section className="admin-form-modal price-history-modal" role="dialog" aria-modal="true" aria-label={`${history.plan.skuName} 价格版本记录`}><button className="modal-close" type="button" onClick={() => setHistory(null)}><X size={18} /></button><span>CHANDLER VERSION HISTORY</span><h2>{history.plan.skuName} · 价格版本</h2><p>以下数据实时读取自 Chandler 应用级 SKU 价格历史。</p>{history.loading ? <AdminNotice>正在读取远程价格版本…</AdminNotice> : history.error ? <AdminNotice tone="error">{history.error}</AdminNotice> : history.prices.length ? <div className="price-history-list">{history.prices.map((price) => <article key={price.id}><div><strong>{formatMoney(Number(price.amount || 0))}</strong><span className={`status-pill ${price.status}`}>{price.status === "active" ? "生效中" : price.status === "superseded" ? "已被替换" : price.status === "archived" ? "已归档" : "草稿"}</span></div><p>{price.billing_interval === "year" ? "按年" : price.billing_interval === "month" ? "按月" : "单次"} · 每 {price.interval_count || 1} 个周期</p><time>生效：{new Date(price.effective_at).toLocaleString("zh-CN")}</time><code>{price.id}</code></article>)}</div> : <EmptyState title="暂无价格版本" text="请先创建第一个 Chandler 远程价格版本。" />}</section></div>}
  </section>;
}

function emptyPartnerForm() {
  return { name: "", industry: "", websiteUrl: "https://", logoMode: "upload", logoUrl: "", logoObjectKey: null, logoFile: null, promotionObjectKey: null, promotionUrl: null, promotionFile: null, removePromotion: false, nodeAction: "website", sort: 100, enabled: true, currentLogoPreviewUrl: null, currentPromotionPreviewUrl: null };
}

function PartnerFormModal({ editing, form, setForm, busy, onClose, onSubmit }) {
  const hasCurrentPromotion = Boolean(form.currentPromotionPreviewUrl);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><form className="admin-form-modal partner-form-modal" onSubmit={onSubmit}>
    <button className="modal-close" type="button" disabled={busy} onClick={onClose}><X size={18} /></button>
    <span>{editing ? "EDIT PARTNER" : "NEW PARTNER"}</span><h2>{editing ? `修改 ${editing.name}` : "新建合作伙伴"}</h2>
    {editing && <div className="partner-existing-assets"><div><span>当前 Logo</span><img src={form.currentLogoPreviewUrl} alt={`${editing.name} 当前 Logo`} /></div>{form.currentPromotionPreviewUrl && <div><span>当前宣传图</span><img src={form.currentPromotionPreviewUrl} alt={`${editing.name} 当前宣传图`} /></div>}<p>选择新图片后，系统会先从腾讯云 COS 删除旧图片，再上传并绑定新图片。</p></div>}
    <div className="admin-form-grid">
      <label><span>企业名称</span><input required minLength={2} maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：中科智能" /></label>
      <label><span>企业所属行业</span><input required maxLength={80} value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })} placeholder="例如：人工智能软件" /></label>
      <label className="span-2"><span>官网网址</span><input required type="url" value={form.websiteUrl} onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })} placeholder="https://example.com" /></label>
      <label><span>Logo 方式</span><select value={form.logoMode} onChange={(event) => setForm({ ...form, logoMode: event.target.value })}><option value="upload">上传企业 Logo（推荐）</option><option value="generated">根据名称自动生成</option><option value="url">使用 HTTPS 图片链接</option></select></label>
      {form.logoMode === "upload" && <label><span>{editing ? "替换企业 Logo（可选）" : "企业 Logo 图片"}</span><input required={!editing && !form.logoObjectKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setForm({ ...form, logoFile: event.target.files?.[0] || null })} /></label>}
      {form.logoMode === "url" && <label><span>Logo 图片链接</span><input required type="url" value={form.logoUrl || ""} onChange={(event) => setForm({ ...form, logoUrl: event.target.value })} placeholder="https://example.com/logo.png" /></label>}
      <label><span>{editing ? "替换宣传图片（可选）" : "宣传图片（可选）"}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setForm({ ...form, promotionFile: event.target.files?.[0] || null, removePromotion: false })} /></label>
      <label><span>点击 Logo 后</span><select value={form.nodeAction} onChange={(event) => setForm({ ...form, nodeAction: event.target.value })}><option value="website">新标签页打开官网</option><option value="promotion">弹窗放大宣传图片</option></select></label>
      <label><span>首页排序</span><input type="number" value={form.sort} onChange={(event) => setForm({ ...form, sort: Number(event.target.value) })} /></label>
      {editing && hasCurrentPromotion && <label className="partner-remove-asset"><input type="checkbox" checked={form.removePromotion} onChange={(event) => setForm({ ...form, removePromotion: event.target.checked, promotionFile: null })} /><span>删除当前宣传图片</span></label>}
    </div>
    <div className="logo-generation-hint"><ImageSquare size={25} /><div><strong>{editing ? "替换顺序受保护" : "行业自动分类"}</strong><p>{editing ? "图片替换严格执行“删除旧图 → 上传新图 → 保存资料”；其他资料修改不会重复上传图片。" : "系统会根据“企业所属行业”和企业名称归入科技、金融、教育、医疗、商业、工业、文化等网络簇；首页节点会自动进入对应行业轨道。"}</p></div></div>
    <button className="button primary full" disabled={busy}>{busy ? (editing ? "正在更新伙伴资料" : "正在上传到 COS 并创建") : (editing ? "保存修改并同步品牌神经网络" : "创建伙伴并加入品牌神经网络")}</button>
  </form></div>;
}

function PartnerManager() {
  const [partners, setPartners] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyPartnerForm);
  const [state, setState] = useState({ busy: false, message: "", tone: "info" });

  async function load() {
    try { setPartners((await apiFetch("/api/admin/partners")).partners || []); }
    catch (error) { setState({ busy: false, message: error.message, tone: "error" }); }
  }
  useEffect(() => { load(); }, []);

  function closeForm() { setFormOpen(false); setEditing(null); setForm(emptyPartnerForm()); }
  function openCreate() { setEditing(null); setForm(emptyPartnerForm()); setFormOpen(true); }
  function openEdit(partner) {
    setEditing(partner);
    setForm({
      ...emptyPartnerForm(),
      name: partner.name,
      industry: partner.industryInput || partner.industryName || "其他",
      websiteUrl: partner.websiteUrl,
      logoMode: partner.logoMode || "generated",
      logoUrl: partner.logoUrl || "",
      logoObjectKey: partner.logoObjectKey || null,
      promotionObjectKey: partner.promotionObjectKey || null,
      promotionUrl: partner.promotionUrl || null,
      nodeAction: partner.nodeAction || "website",
      sort: Number(partner.sort ?? 100),
      enabled: partner.enabled !== false,
      currentLogoPreviewUrl: partner.logoPreviewUrl,
      currentPromotionPreviewUrl: partner.promotionPreviewUrl || null,
    });
    setFormOpen(true);
  }

  async function uploadAsset(file, kind, partnerId = null) {
    const endpoint = partnerId ? `/api/admin/partners/${partnerId}/assets/replace` : "/api/admin/partners/assets/presign";
    const ticket = await apiFetch(endpoint, { method: "POST", body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type, kind }) });
    let response;
    try { response = await fetch(ticket.uploadUrl, { method: "PUT", mode: "cors", headers: ticket.requiredHeaders || {}, body: file }); }
    catch { throw new Error("无法连接腾讯云 COS，请刷新页面后重试；如果持续失败，请检查存储桶是否允许 www.sologle.com 跨域上传"); }
    if (!response.ok) throw new Error(`腾讯云 COS 上传失败（${response.status}）`);
    return ticket.objectKey;
  }

  function partnerPayload(logoObjectKey, promotionObjectKey) {
    return { name: form.name, industry: form.industry, websiteUrl: form.websiteUrl, logoMode: form.logoMode, logoUrl: form.logoMode === "url" ? form.logoUrl : null, logoObjectKey: form.logoMode === "upload" ? logoObjectKey : null, promotionObjectKey, promotionUrl: form.removePromotion ? null : form.promotionUrl, nodeAction: form.nodeAction, sort: form.sort, enabled: form.enabled };
  }

  async function save(event) {
    event.preventDefault();
    setState({ busy: true, message: "", tone: "info" });
    try {
      let logoObjectKey = form.logoMode === "upload" ? form.logoObjectKey : null;
      let promotionObjectKey = form.removePromotion ? null : form.promotionObjectKey;
      if (form.logoMode === "upload" && !logoObjectKey && !form.logoFile) throw new Error("请选择企业 Logo 图片");
      if (form.logoMode === "upload" && form.logoFile) logoObjectKey = await uploadAsset(form.logoFile, "logo", editing?.id);
      if (form.promotionFile) promotionObjectKey = await uploadAsset(form.promotionFile, "promotion", editing?.id);
      if (form.nodeAction === "promotion" && !promotionObjectKey && !form.promotionUrl) throw new Error("选择“宣传图片”跳转时，请上传宣传图片");
      const payload = partnerPayload(logoObjectKey, promotionObjectKey);
      if (editing) await apiFetch(`/api/admin/partners/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await apiFetch("/api/admin/partners", { method: "POST", body: JSON.stringify(payload) });
      closeForm();
      setState({ busy: false, message: editing ? "合作伙伴修改已保存，首页品牌神经网络已同步更新。" : "合作伙伴已创建，行业已自动分类，首页品牌神经网络会自动更新。", tone: "success" });
      await load();
    } catch (error) { setState({ busy: false, message: error.message, tone: "error" }); await load(); }
  }

  async function remove(id) {
    if (!window.confirm("确定删除这个合作伙伴吗？对应的 COS 图片也会删除，首页会立即停止展示。")) return;
    try { await apiFetch(`/api/admin/partners/${id}`, { method: "DELETE" }); setState({ busy: false, message: "合作伙伴及其 COS 图片已删除。", tone: "success" }); await load(); }
    catch (error) { setState({ busy: false, message: error.message, tone: "error" }); }
  }

  return <section className="admin-module">
    <header className="admin-module-head"><div><span>PARTNER ECOSYSTEM</span><h2>合作伙伴管理</h2><p>创建、修改企业 Logo、官网与宣传图片；图片替换先清理 COS 旧图，再同步首页品牌神经网络。</p></div><button className="button primary" onClick={openCreate}><Plus size={17} /> 新建合作伙伴</button></header>
    {state.message && <AdminNotice tone={state.tone}>{state.message}</AdminNotice>}
    {partners.length ? <div className="admin-partner-grid">{partners.map((partner) => <article key={partner.id}><div className="admin-logo-frame"><img src={partner.logoPreviewUrl} alt={`${partner.name} Logo`} /></div><div><strong>{partner.name}</strong><a href={partner.websiteUrl} target="_blank" rel="noreferrer">{new URL(partner.websiteUrl).hostname} <ArrowSquareOut size={13} /></a><small>{partner.industryName || "其他行业"} · {partner.logoMode === "upload" ? "COS Logo" : partner.logoMode === "generated" ? "自动 Logo" : "外部 Logo"} · 排序 {partner.sort}</small>{partner.promotionPreviewUrl && <a className="partner-promo-link" href={partner.promotionPreviewUrl} target="_blank" rel="noreferrer"><ImageSquare size={16} /> 查看宣传图片</a>}</div><div className="admin-partner-actions"><button className="icon-edit" onClick={() => openEdit(partner)} aria-label={`修改 ${partner.name}`}><PencilSimple size={17} /></button><button className="icon-danger" onClick={() => remove(partner.id)} aria-label={`删除 ${partner.name}`}><Trash size={17} /></button></div></article>)}</div> : <EmptyState icon={Handshake} title="还没有合作伙伴" text="创建第一家伙伴后，首页会自动出现品牌神经网络。" />}
    {formOpen && <PartnerFormModal editing={editing} form={form} setForm={setForm} busy={state.busy} onClose={closeForm} onSubmit={save} />}
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
    <header className="admin-module-head"><div><span>RELEASE CONTROL PLANE</span><h2>版本管理</h2><p>每个“主题访问权限”用户分组对应一个发行渠道；只有管理员明确操作时才上传或打包发布。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} /> 刷新状态</button></header>
    <AdminNotice>桌面端本地构建不会自动上传腾讯云 COS。只有管理员点击“手动上传”或“手动打包发布”才会创建单渠道任务并消耗 COS 流量。</AdminNotice>
    {message && <AdminNotice tone={message.includes("进入发行队列") || message.includes("已上传并切换") ? "success" : "error"}>{message}</AdminNotice>}
    <div className="release-picker"><button className="release-picker-trigger" onClick={() => setOpen(!open)}><div><span>选择用户分组 / 发行渠道</span><strong>{channels.length ? `${channels.length} 个可用渠道` : "等待工作器同步分组"}</strong></div><MagnifyingGlass size={19} /></button>{open && <div className="release-picker-menu"><label><MagnifyingGlass size={16} /><input autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入用户分组关键词" /></label><div>{filtered.map((channel) => <article key={channel.id}><div><strong>{channel.name}</strong><small>允许主题：{(channel.themeNames || []).join("、")}</small>{channel.latestRelease && <span>当前 v{channel.latestRelease.version} · {new Date(channel.latestRelease.publishedAt).toLocaleString("zh-CN")}</span>}</div><div className="release-channel-actions"><button className="button small secondary" onClick={() => setManualUpload({ channel, version: channel.latestRelease?.version || "1.0.0", file: null, busy: false, error: "", progress: 0 })}><CloudArrowUp size={15} /> 手动上传</button><button className="button small primary" onClick={() => release(channel)}><RocketLaunch size={15} /> 手动打包发布</button></div></article>)}{!filtered.length && <p className="release-picker-empty">没有匹配的用户分组。请先运行发行工作器同步桌面端权限文件。</p>}</div></div>}</div>
    <div className="release-job-list"><h3>最近发版任务</h3>{jobs.length ? jobs.map((job) => <article key={job.id}><div className={`job-status ${job.status}`}><span /><strong>{job.status === "queued" ? "排队" : job.status === "building" ? "构建中" : job.status === "uploading" ? "上传中" : job.status === "completed" ? "已发布" : "失败"}</strong></div><div><strong>{job.channelName}</strong><small>{job.version ? `v${job.version}` : "等待生成版本号"} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small></div>{job.error && <p>{job.error}</p>}</article>) : <EmptyState icon={RocketLaunch} title="还没有发版任务" text="从上方用户分组列表选择一个渠道开始发版。" />}</div>
    {manualUpload && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !manualUpload.busy && setManualUpload(null)}><form className="admin-form-modal release-upload-modal" onSubmit={uploadRelease}><button className="modal-close" type="button" disabled={manualUpload.busy} onClick={() => setManualUpload(null)}><X size={18} /></button><span>MANUAL COS RELEASE</span><h2>手动上传新版本</h2><p>发行渠道：<strong>{manualUpload.channel.name}</strong></p><div className="admin-form-grid"><label><span>版本号</span><input required maxLength={40} value={manualUpload.version} onChange={(event) => setManualUpload({ ...manualUpload, version: event.target.value })} placeholder="例如 1.6.0" /></label><label><span>Windows 安装包</span><input required type="file" accept=".exe,.msix,.msixbundle,.zip,application/octet-stream" onChange={(event) => setManualUpload({ ...manualUpload, file: event.target.files?.[0] || null })} /></label></div><AdminNotice>只有点击下方按钮后文件才会从浏览器直传成都 COS。新文件校验成功后替换线上版本，并清理该渠道旧安装包。</AdminNotice>{manualUpload.busy && <div className="upload-progress"><span style={{ width: `${manualUpload.progress}%` }} /><em>{manualUpload.progress}%</em></div>}{manualUpload.error && <div className="form-error">{manualUpload.error}</div>}<button className="button primary full" disabled={manualUpload.busy || !manualUpload.file}><CloudArrowUp size={18} /> {manualUpload.busy ? "正在上传并校验" : "确认手动上传并设为最新版"}</button></form></div>}
  </section>;
}

function WorkerReviewManager() {
  const [kind, setKind] = useState("task");
  const [tab, setTab] = useState("pending");
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ pending: 0, reviewed: 0 });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [rejecting, setRejecting] = useState(null);
  async function load() {
    setMessage("");
    try {
      const result = await apiFetch(kind === "task" ? `/api/admin/worker-payments?status=${tab}` : `/api/admin/worker-contact-payments?status=${tab}`);
      setItems(kind === "task" ? result.tasks || [] : result.orders || []);
      setSummary(result.summary || { pending: 0, reviewed: 0 });
    } catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, [kind, tab]);
  async function approve(item) {
    if (!window.confirm(kind === "task" ? `确认任务“${item.title}”预算已到账，并按“${item.assignment?.label || "公开接单"}”开放吗？` : `确认订单 ${item.orderNo} 的 2 元已到账并解锁联系方式吗？`)) return;
    setBusy(item.id);
    try {
      await apiFetch(kind === "task" ? `/api/admin/worker-payments/${item.id}/approve` : `/api/admin/worker-contact-payments/${item.id}/approve`, { method: "POST", body: "{}" });
      setMessage("已确认到账，审核结果与站内提醒已经同步。"); await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  async function reject(event) {
    event.preventDefault(); setBusy(rejecting.item.id); setMessage("");
    try {
      await apiFetch(kind === "task" ? `/api/admin/worker-payments/${rejecting.item.id}/reject` : `/api/admin/worker-contact-payments/${rejecting.item.id}/reject`, { method: "POST", body: JSON.stringify({ reason: rejecting.reason }) });
      setRejecting(null); setMessage("已拒绝并把原因发送给申请用户。"); await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  return <section className="admin-module"><header className="admin-module-head"><div><span>WORKER ESCROW REVIEW</span><h2>威客审核</h2><p>审核任务预算与双方查看微信号的 2 元线下订单；只有审核通过才开放对应能力。</p></div><button className="button secondary" onClick={load}><ArrowClockwise size={17} />刷新</button></header>{message && <AdminNotice tone={message.startsWith("已") ? "success" : "error"}>{message}</AdminNotice>}<div className="worker-admin-kind-tabs"><button className={kind === "task" ? "active" : ""} onClick={() => setKind("task")}><CurrencyCny size={19} />任务预算审核</button><button className={kind === "contact" ? "active" : ""} onClick={() => setKind("contact")}><UsersThree size={19} />联系方式订单</button></div><div className="offline-review-tabs"><button className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}><span>待审核</span><strong>{summary.pending || 0}</strong></button><button className={tab === "reviewed" ? "active" : ""} onClick={() => setTab("reviewed")}><span>已审核</span><strong>{summary.reviewed || 0}</strong></button></div>{items.length ? <div className="worker-admin-review-list">{items.map((item) => <article key={item.id}><div><span>{kind === "task" ? "任务预算" : "联系方式查看"}</span><h3>{kind === "task" ? item.title : item.taskTitle}</h3><p>{kind === "task" ? `${item.publisher?.displayName || "发单用户"} · ${item.assignment?.label || "公开接单"}` : `${item.requester?.displayName || "用户"} 申请查看 ${item.target?.displayName || "任务另一方"}`}</p><small>{kind === "task" ? item.paymentOrderNo : item.orderNo}</small></div><strong>{formatMoney(kind === "task" ? item.budgetFen : item.amountFen)}</strong><em className={`status-pill ${kind === "task" ? item.paymentStatus : item.status}`}>{(kind === "task" ? item.paymentStatus : item.status) === "pending" ? "待审核" : (kind === "task" ? item.paymentStatus : item.status) === "approved" ? "已通过" : "已拒绝"}</em>{tab === "pending" && <div className="admin-row-actions"><button className="button small primary" disabled={busy === item.id} onClick={() => approve(item)}>确认到账并通过</button><button className="button small secondary" disabled={busy === item.id} onClick={() => setRejecting({ item, reason: "" })}>拒绝通过</button></div>}</article>)}</div> : <EmptyState icon={Briefcase} title={tab === "pending" ? "没有待审核威客订单" : "还没有已审核记录"} text="新订单提交后会自动显示在这里。" />}{rejecting && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setRejecting(null)}><form className="admin-form-modal" onSubmit={reject}><button className="modal-close" type="button" onClick={() => setRejecting(null)}><X size={18} /></button><span>REJECT WORKER PAYMENT</span><h2>填写拒绝原因</h2><p>原因会原样发送给申请用户，并允许用户调整后重新提交。</p><label><span>拒绝原因</span><textarea autoFocus required minLength={2} maxLength={500} value={rejecting.reason} onChange={(event) => setRejecting({ ...rejecting, reason: event.target.value })} /></label><button className="button primary full" disabled={busy === rejecting.item.id}>保存并通知用户</button></form></div>}</section>;
}

const paymentStatusText = { pending: "待支付", paid: "已支付", approved: "已通过", rejected: "已拒绝", failed: "支付失败", refunded: "已退款", cancelled: "已取消", canceled: "已取消" };

function PaymentManager() {
  const [mode, setMode] = useState("online");
  const [reviewTab, setReviewTab] = useState("pending");
  const [filters, setFilters] = useState({ q: "", from: "", to: "", channelId: "" });
  const [channels, setChannels] = useState([]);
  const [orders, setOrders] = useState([]);
  const [summary, setSummary] = useState({ total: 0, pending: 0, reviewed: 0, approved: 0, rejected: 0 });
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState(null);
  const [busy, setBusy] = useState("");

  async function load(event, nextMode = mode, nextReviewTab = reviewTab, nextFilters = filters) {
    event?.preventDefault();
    setBusy("orders"); setMessage("");
    const params = new URLSearchParams({ limit: "100" });
    if (nextMode === "offline") params.set("status", nextReviewTab);
    for (const [key, value] of Object.entries(nextFilters)) if (value) params.set(key, value);
    try {
      const result = await apiFetch(`/api/admin/${nextMode === "online" ? "payments" : "offline-payments"}?${params}`);
      setOrders(result.orders || []);
      setSummary(result.summary || { total: 0, pending: 0, reviewed: 0, approved: 0, rejected: 0 });
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  useEffect(() => {
    apiFetch("/api/admin/release-channels").then((result) => setChannels(result.channels || [])).catch(() => setChannels([]));
  }, []);
  useEffect(() => { load(null, mode, reviewTab); }, [mode, reviewTab]);

  function switchMode(nextMode) {
    setOrders([]); setMessage(""); setMode(nextMode);
  }

  function resetFilters() {
    const empty = { q: "", from: "", to: "", channelId: "" };
    setFilters(empty);
    load(null, mode, reviewTab, empty);
  }

  async function approve(order) {
    if (!window.confirm(`确认 ${order.user?.email || order.userEmail || order.orderNo} 已到账并开通会员吗？`)) return;
    setBusy(order.id);
    try { await apiFetch(`/api/admin/offline-payments/${order.id}/approve`, { method: "POST", body: "{}" }); await load(null, "offline", "pending"); setMessage("已确认到账，权益已写入官网并尝试同步 Chandler。"); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function reject(event) {
    event.preventDefault();
    setBusy(rejecting.order.id); setMessage("");
    try {
      await apiFetch(`/api/admin/offline-payments/${rejecting.order.id}/reject`, { method: "POST", body: JSON.stringify({ reason: rejecting.reason }) });
      setRejecting(null); await load(null, "offline", "pending"); setMessage("已拒绝该申请，用户后台已收到原因与重新申请入口。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  return <section className="admin-module payment-manager">
    <header className="admin-module-head"><div><span>UNIFIED ORDER CENTER</span><h2>订单管理</h2><p>集中查看线上支付订单与线下审核订单，并按用户、订单、时间和发行渠道快速定位。</p></div><button className="button secondary" disabled={busy === "orders"} onClick={() => load()}><ArrowClockwise size={17} /> {busy === "orders" ? "加载中" : "刷新"}</button></header>
    <div className="payment-mode-tabs" role="tablist" aria-label="订单支付方式"><button type="button" role="tab" aria-selected={mode === "online"} className={mode === "online" ? "active" : ""} onClick={() => switchMode("online")}><CurrencyCny size={20} />线上支付</button><button type="button" role="tab" aria-selected={mode === "offline"} className={mode === "offline" ? "active" : ""} onClick={() => switchMode("offline")}><ShieldCheck size={20} />线下支付</button></div>
    <form className="order-filter-panel" onSubmit={load}><label className="order-keyword"><span>关键词模糊搜索</span><div><MagnifyingGlass size={18} /><input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="订单号、邮箱、昵称、支付渠道或状态" /></div></label><label><span>开始日期</span><input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label><label><span>结束日期</span><input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label><label className="order-channel"><span>用户分组 / 发行渠道</span><select value={filters.channelId} onChange={(event) => setFilters({ ...filters, channelId: event.target.value })}><ReleaseChannelOptions channels={channels} /></select></label><div className="order-filter-actions"><button type="button" className="button ghost" onClick={resetFilters}>清空</button><button className="button secondary" disabled={busy === "orders"}><MagnifyingGlass size={17} />查询订单</button></div></form>
    {message && <AdminNotice tone={message.startsWith("已") ? "success" : "error"}>{message}</AdminNotice>}
    {mode === "offline" && <div className="offline-review-tabs" role="tablist" aria-label="线下支付审核状态"><button type="button" role="tab" aria-selected={reviewTab === "pending"} className={reviewTab === "pending" ? "active" : ""} onClick={() => setReviewTab("pending")}><span>待审核</span><strong>{summary.pending || 0}</strong></button><button type="button" role="tab" aria-selected={reviewTab === "reviewed"} className={reviewTab === "reviewed" ? "active" : ""} onClick={() => setReviewTab("reviewed")}><span>已审核</span><strong>{summary.reviewed || 0}</strong></button></div>}
    {orders.length ? <div className="offline-order-grid">{orders.map((order) => <article key={order.id}><header><div><span>{mode === "online" ? order.kind === "recharge" ? "账户充值" : order.cycle === "year" ? "线上年度会员" : "线上月度会员" : order.cycle === "year" ? "线下年度会员" : "线下月度会员"}</span><strong>{formatMoney(order.amountFen)}</strong></div><span className={`status-pill ${order.status}`}>{mode === "offline" && order.status === "pending" ? "待审核" : paymentStatusText[order.status] || order.status || "未知"}</span></header><dl><div><dt>订单号</dt><dd>{order.orderNo}</dd></div><div><dt>用户</dt><dd>{order.user?.displayName || order.user?.email || order.userEmail || order.ownerId}</dd></div><div><dt>{mode === "offline" && reviewTab === "reviewed" ? "审核时间" : "下单时间"}</dt><dd>{new Date(mode === "offline" && reviewTab === "reviewed" ? order.reviewedAt || order.updatedAt || order.createdAt : order.createdAt).toLocaleString("zh-CN")}</dd></div><div><dt>发行渠道</dt><dd>{order.releaseChannel?.isDefault ? "古龙版（默认）" : order.releaseChannel?.name || "古龙版（默认）"}</dd></div><div><dt>{mode === "online" ? "支付渠道" : "Chandler"}</dt><dd>{mode === "online" ? order.provider === "wechat" ? "微信支付" : order.provider === "alipay" ? "支付宝" : order.provider || "未返回" : order.chandlerOrderNo || "等待镜像"}</dd></div>{mode === "online" && <div><dt>交易号</dt><dd>{order.providerTransactionId || "尚未完成支付"}</dd></div>}</dl>{mode === "offline" && order.previousReviewReason && <div className="offline-review-history"><strong>上次拒绝：</strong>{order.previousReviewReason}<br /><strong>用户调整：</strong>{order.resubmissionNote || "未填写"}</div>}{mode === "offline" && order.reviewReason && <div className="offline-review-history rejected"><strong>拒绝原因：</strong>{order.reviewReason}</div>}{mode === "offline" && order.status === "pending" && <div className="offline-review-actions"><button className="button primary" disabled={busy === order.id} onClick={() => approve(order)}><CheckCircle size={17} /> 确认到账并通过</button><button className="button danger" disabled={busy === order.id} onClick={() => setRejecting({ order, reason: "" })}><X size={17} /> 拒绝通过</button></div>}</article>)}</div> : <EmptyState icon={mode === "online" ? CurrencyCny : ShieldCheck} title={busy === "orders" ? "正在读取订单" : mode === "online" ? "没有匹配的线上订单" : reviewTab === "pending" ? "当前没有待审核申请" : "没有匹配的已审核记录"} text={mode === "online" ? "可调整关键词、日期或发行渠道后重新查询。" : reviewTab === "pending" ? "新的线下支付申请会优先显示在这里。" : "已通过和已拒绝的申请会统一保留在这里。"} />}
    {rejecting && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setRejecting(null)}><form className="admin-form-modal offline-reject-modal" onSubmit={reject}><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setRejecting(null)}><X size={18} /></button><span>REJECT OFFLINE PAYMENT</span><h2>拒绝通过</h2><p>订单：<strong>{rejecting.order.orderNo}</strong></p><label><span>拒绝原因</span><textarea required minLength={2} maxLength={500} autoFocus value={rejecting.reason} onChange={(event) => setRejecting({ ...rejecting, reason: event.target.value })} placeholder="请清楚说明金额、付款截图或订单信息中需要用户调整的内容。" /></label><div className="offline-reject-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => setRejecting(null)}>取消</button><button className="button danger" disabled={Boolean(busy)}><FloppyDisk size={17} /> {busy ? "正在保存" : "保存拒绝原因"}</button></div></form></div>}
  </section>;
}

export function AdminPage({ user, openAuth }) {
  const [active, setActive] = useState("dashboard");
  if (!user) return <main id="main-content" className="admin-gate section-shell"><LockKey size={38} /><h1>登录管理员账号</h1><p>管理员后台已接入 Chandler 统一身份，只接受 Chandler 返回的管理员角色。</p><button className="button primary" onClick={() => openAuth("login")}>登录继续</button></main>;
  if (user.role !== "admin") return <main id="main-content" className="admin-gate section-shell"><ShieldCheck size={38} /><h1>当前账号没有后台权限</h1><p>请让 Chandler 平台管理员授予此账号管理员角色后重新登录。</p></main>;
  return <main id="main-content" className="admin-page"><aside className="admin-sidebar"><div><span>GULONG CONSOLE</span><h1>管理员后台</h1><p>{user.displayName || user.username || user.email}</p></div><nav>{menu.map((item) => { const Icon = item.icon; return <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}><Icon size={19} weight={active === item.id ? "fill" : "regular"} /> {item.label}</button>; })}</nav><footer><UsersThree size={18} /><span>Chandler 统一账号</span></footer></aside><div className="admin-content">{active === "dashboard" && <AdminDashboard />}{active === "users" && <ChandlerUserManager />}{active === "prices" && <ChandlerPriceManager />}{active === "partners" && <PartnerManager />}{active === "brain" && <BrainAttachmentManager />}{active === "versions" && <VersionManager />}{active === "payments" && <PaymentManager />}{active === "worker" && <WorkerReviewManager />}</div></main>;
}
