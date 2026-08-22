import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  CalendarBlank,
  Briefcase,
  ChatCircleText,
  ChartLineUp,
  CheckCircle,
  CloudArrowDown,
  CloudArrowUp,
  Cube,
  CurrencyCny,
  Copy,
  DownloadSimple,
  FileZip,
  FlowArrow,
  FloppyDisk,
  GearSix,
  Handshake,
  ImageSquare,
  Lightning,
  LockKey,
  Key,
  MagnifyingGlass,
  Package,
  PencilSimple,
  Plus,
  RocketLaunch,
  ShieldCheck,
  SpinnerGap,
  Trash,
  UsersThree,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, formatMoney, localizedFetch, localizeErrorMessage } from "../api.js";
import { AdminDashboard } from "./AdminDashboard.jsx";
import { useConfirmDialog } from "./ConfirmDialog.jsx";

const menu = [
  { id: "dashboard", label: "数据看板", icon: ChartLineUp },
  { id: "users", label: "订阅用户", icon: UsersThree },
  { id: "prices", label: "订阅价格", icon: Cube },
  { id: "tokens", label: "令牌配置", icon: LockKey },
  { id: "activations", label: "授权管理", icon: Key },
  { id: "partners", label: "合作伙伴", icon: Handshake },
  { id: "workflows", label: "工作流管理", icon: FlowArrow },
  { id: "brain", label: "第二大脑", icon: FileZip },
  { id: "versions", label: "版本管理", icon: Package },
  { id: "payments", label: "订单管理", icon: ShieldCheck },
  { id: "h3tasks", label: "任务派单", icon: VideoCamera },
  { id: "worker", label: "威客审核", icon: Briefcase },
  { id: "feedback", label: "用户反馈", icon: ChatCircleText },
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

const h3StatusText = { reserving: "正在预扣", queued: "等待领取", claimed: "已领取", processing: "执行中", completed: "已完成", failed: "执行失败", cancelled: "已取消", rejected: "余额不足" };

function H3TaskManager() {
  const confirmAction = useConfirmDialog();
  const [filters, setFilters] = useState({ q: "", status: "", source: "", assignee: "", from: "", to: "" });
  const [tasks, setTasks] = useState([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function load(event) {
    event?.preventDefault(); setBusy("load"); setMessage("");
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const result = await apiFetch(`/api/admin/h3/tasks?${query}`);
      setTasks(result.tasks || []); setTotal(result.total || 0);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function inspect(task) {
    setSelected(task); setDetail(null); setBusy(`detail:${task.id}`); setMessage("");
    try { setDetail(await apiFetch(`/api/admin/h3/tasks/${task.id}`)); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function cancel(task) {
    if (!await confirmAction({ tone: "danger", eyebrow: "CANCEL & REFUND", title: "取消并退款这个共享节点任务？", message: "系统会幂等终止未完成任务，并把本次预扣金额退回需求用户余额。", detail: `${task.orderNo} · ${formatMoney(task.priceFen)}`, detailLabel: "任务订单", confirmLabel: "确认取消并退款" })) return;
    setBusy(`cancel:${task.id}`); setMessage("");
    try { await apiFetch(`/api/admin/h3/tasks/${task.id}/cancel`, { method: "POST", body: "{}" }); setMessage("任务已取消，退款账本已幂等处理。"); setSelected(null); setDetail(null); await load(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function retry(task) {
    if (!await confirmAction({ tone: "warning", eyebrow: "REQUEUE SHARED NODE", title: "重新派发这个任务？", message: "系统会重新校验需求用户余额并创建新的预扣账本，然后把任务放回共享节点队列。", detail: `${task.orderNo} · 第 ${(task.retryCount || 0) + 1} 次重试`, detailLabel: "重试信息", confirmLabel: "重新扣费并派单" })) return;
    setBusy(`retry:${task.id}`); setMessage("");
    try { await apiFetch(`/api/admin/h3/tasks/${task.id}/retry`, { method: "POST", body: "{}" }); setMessage("任务已重新进入共享节点队列。"); setSelected(null); setDetail(null); await load(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  useEffect(() => { load(); }, []);
  return <section className="admin-module h3-task-manager">
    <header className="admin-module-head"><div><span>MINIMAX H3 SHARED NODES</span><h2>任务派单</h2><p>统一查看官网和桌面 Agent 的共享节点订单；领取节点与实际执行节点分开留痕，最终接单人以成功回调的账号绑定令牌为准。</p></div><button className="button secondary" disabled={Boolean(busy)} onClick={() => load()}><ArrowClockwise size={17} />刷新</button></header>
    {message && <AdminNotice tone={message.includes("已") ? "success" : "error"}>{message}</AdminNotice>}
    <form className="h3-task-filters" onSubmit={load}><label><span>关键词 / 用户邮箱</span><input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="订单号、提示词、需求用户" /></label><label><span>状态</span><select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option>{Object.entries(h3StatusText).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>来源</span><select value={filters.source} onChange={(event) => setFilters({ ...filters, source: event.target.value })}><option value="">全部来源</option><option value="website">官网</option><option value="desktop_agent">桌面 Agent</option></select></label><label><span>接单人</span><input value={filters.assignee} onChange={(event) => setFilters({ ...filters, assignee: event.target.value })} placeholder="邮箱模糊搜索" /></label><label><span>开始日期</span><input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label><label><span>结束日期</span><input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label><button className="button primary" disabled={busy === "load"}><MagnifyingGlass size={18} />搜索</button></form>
    <div className="h3-task-summary"><span>当前条件共 <strong>{total}</strong> 条任务</span><em>实际计费：0.20 元/秒 + 0.05 元/图 + 0.20 元/视频；音频免费</em></div>
    {tasks.length ? <div className="h3-task-table"><div className="h3-task-head"><span>订单 / 来源</span><span>需求与参数</span><span>价格 / 状态</span><span>接单人与节点</span><span>时间</span><span>操作</span></div>{tasks.map((task) => <article key={task.id}><div><strong>{task.orderNo}</strong><small>{task.sourceChannel === "desktop_agent" ? "桌面 Agent" : "官网"} · {task.requester?.email || task.requester?.userId}</small></div><div><strong title={task.prompt}>{task.prompt?.slice(0, 48)}{task.prompt?.length > 48 ? "…" : ""}</strong><small>{task.durationSeconds} 秒 · 图 {task.imageCount} / 视频 {task.videoCount} / 音频 {task.audioCount}</small></div><div><strong>{formatMoney(task.priceFen)}</strong><em className={`status-pill ${task.status}`}>{h3StatusText[task.status] || task.status}</em></div><div><strong>{task.assignee?.displayName || task.assignee?.email || "等待成功回调确认"}</strong><small>领取：{task.claimedByNode?.nodeName || "-"} · 执行：{task.executedByNode?.nodeName || "-"}</small></div><div><time>{new Date(task.createdAt).toLocaleString("zh-CN")}</time><small>{task.completedAt ? `完成 ${new Date(task.completedAt).toLocaleString("zh-CN")}` : task.claimedAt ? `领取 ${new Date(task.claimedAt).toLocaleString("zh-CN")}` : "尚未领取"}</small></div><div className="admin-row-actions"><button className="button small secondary" type="button" onClick={() => inspect(task)}>详情</button>{["failed", "cancelled"].includes(task.status) && task.refundStatus === "refunded" && <button className="button small primary" type="button" disabled={Boolean(busy)} onClick={() => retry(task)}>重试</button>}{!["completed", "cancelled", "rejected"].includes(task.status) && <button className="button small danger" type="button" disabled={Boolean(busy)} onClick={() => cancel(task)}>取消</button>}</div></article>)}</div> : <EmptyState icon={VideoCamera} title={busy === "load" ? "正在读取任务" : "没有匹配的共享节点任务"} text="新任务创建并完成余额预扣后，会自动出现在这里等待桌面节点领取。" />}
    {selected && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setSelected(null)}><section className="admin-form-modal h3-task-detail" role="dialog" aria-modal="true" aria-labelledby="h3-task-detail-title"><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setSelected(null)}><X size={19} /></button><span>SHARED NODE RECEIPT</span><h2 id="h3-task-detail-title">任务 {selected.orderNo}</h2>{!detail ? <div className="admin-empty"><SpinnerGap size={28} className="agent-spin" /><strong>正在读取完整回执</strong></div> : <><div className="h3-detail-grid"><article><span>需求用户</span><strong>{detail.task.requester.email || detail.task.requester.userId}</strong></article><article><span>最终接单人</span><strong>{detail.task.assignee?.email || "尚未确认"}</strong></article><article><span>领取节点</span><strong>{detail.task.claimedByNode?.nodeName || "未领取"}</strong><small>{detail.task.claimedByNode?.nodeId}</small></article><article><span>执行节点</span><strong>{detail.task.executedByNode?.nodeName || "未执行"}</strong><small>{detail.task.executedByNode?.nodeId}</small></article></div><div className="h3-detail-prompt"><span>完整提示词</span><p>{detail.task.prompt}</p></div>{detail.task.output && <div className={`h3-detail-output ${detail.task.output.status}`}><span>输出视频</span>{detail.task.output.previewPath ? <><video controls preload="metadata" src={detail.task.output.previewPath} /><div className="h3-output-retention"><strong>请尽快下载，视频将在生成完成后 24 小时自动删除。</strong><small>准确到期时间：{new Date(detail.task.output.expiresAt).toLocaleString("zh-CN")} · 清理状态：{detail.task.output.cleanupStatus || "等待清理"}</small></div><a className="button secondary" href={detail.task.output.downloadPath}><DownloadSimple size={17} />下载输出视频</a></> : <div className="admin-notice error"><X size={18} /><span>视频已过期并删除 · 到期时间：{detail.task.output.expiresAt ? new Date(detail.task.output.expiresAt).toLocaleString("zh-CN") : "未知"} · 清理状态：{detail.task.output.cleanupStatus || "等待清理"}</span></div>}</div>}{detail.task.error && <div className="admin-notice error"><X size={18} /><span>{localizeErrorMessage(detail.task.error.message, "任务处理失败，请稍后重试")}</span></div>}<div className="h3-detail-events"><h3>回调与审计轨迹</h3>{[...(detail.callbacks || []).map((item) => ({ ...item, type: "callback" })), ...(detail.audits || []).map((item) => ({ ...item, type: "audit" }))].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).map((item) => <div key={`${item.type}-${item.id}`}><i /><span>{item.type === "callback" ? `节点回调 · ${h3StatusText[item.status] || item.status}` : `审计 · ${item.event}`}</span><time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time></div>)}</div></>}</section></div>}
  </section>;
}

function ReleaseChannelOptions({ channels }) {
  return <><option value="">全部发行渠道</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.isDefault ? "古龙版（默认）" : channel.name}</option>)}</>;
}

function releaseProductName(channel) {
  const identity = `${channel?.profileKey || ""} ${channel?.name || ""}`.toLowerCase();
  if (identity.includes("yongshenghua") || identity.includes("airos") || identity.includes("永生花")) return "MiniMax H3 极速视频版";
  return channel?.isDefault ? "古龙版（默认）" : channel?.name || "未命名发行渠道";
}

function ChandlerUserManager() {
  const confirmAction = useConfirmDialog();
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
    const disabling = status === "disabled";
    if (!await confirmAction({
      tone: disabling ? "danger" : "positive",
      eyebrow: disabling ? "FREEZE USER ACCOUNT" : "RESTORE USER ACCOUNT",
      title: disabling ? "冻结这个用户账号？" : "恢复这个用户账号？",
      message: disabling ? "冻结后该用户将无法继续使用需要登录的官网和桌面端功能。" : "恢复后该用户可以重新登录并继续使用已有权益。",
      detail: user.email || user.display_name || user.id,
      detailLabel: "目标用户",
      confirmLabel: disabling ? "确认冻结" : "确认恢复",
    })) return;
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
    if (!await confirmAction({
      tone: "secure",
      eyebrow: "ADMINISTRATOR ACCESS",
      title: "授予管理员权限？",
      message: "该用户将能够进入管理员后台，并使用账号具备权限的管理功能。",
      detail: user.display_name || user.email || user.id,
      detailLabel: "目标用户",
      note: "请仅向可信任的团队成员授予管理员权限。",
      confirmLabel: "设为管理员",
    })) return;
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
      plan: subscription?.plan === "short_video_monthly" || selected?.subscription_plan === "short_video_monthly" ? "short_video_monthly" : "member",
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
        body: JSON.stringify({ plan: periodEditor.plan, currentPeriodStart: start.toISOString(), currentPeriodEnd: end.toISOString() }),
      });
      setPeriodEditor(null);
      await Promise.all([inspect(user), load()]);
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
    {users.length ? <div className="chandler-user-list">{users.map((user) => <article key={user.id}><div className="chandler-user-avatar">{(user.display_name || user.email || "U").slice(0, 1).toUpperCase()}</div><div><strong>{user.display_name || "未设置昵称"}</strong><span>{user.email || user.phone || user.id}</span><small>{user.edition_name ? `${user.edition_name} · ` : ""}{user.role === "admin" ? "管理员" : user.is_member && user.subscription_plan === "short_video_monthly" ? "短视频包月用户" : user.is_member ? "订阅会员" : "普通用户"}{user.is_member && user.membership_valid_until ? ` · 有效至 ${new Date(user.membership_valid_until).toLocaleDateString("zh-CN")}` : ""}</small></div><span className={`status-pill ${user.status || "active"}`}>{user.status === "disabled" ? "已冻结" : user.status === "deleted" ? "已删除" : "正常"}</span><div className="admin-row-actions"><button className="button small ghost" onClick={() => inspect(user)}>订阅详情</button>{user.role !== "admin" && <button className="button small primary" disabled={busy === `role-${user.id}`} onClick={() => promoteToAdmin(user)}><ShieldCheck size={16} />{busy === `role-${user.id}` ? "设置中" : "设为管理员"}</button>}{meta.capabilities?.globalUserStatus === true && user.status !== "deleted" && <button className="button small secondary" disabled={busy === user.id} onClick={() => changeStatus(user)}>{user.status === "disabled" ? "恢复" : "冻结"}</button>}{meta.capabilities?.globalEntitlementApproval === true && <button className="button small primary" onClick={() => setGrant({ user, entitlementCode: "gulong.member", validUntil: new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 16), reason: "管理员根据线下合同申请开通古龙会员权益" })}>申请权益</button>}</div></article>)}</div> : <EmptyState icon={UsersThree} title="没有匹配用户" text="尝试使用邮箱、昵称或用户 ID 的一部分重新搜索。" />}
    {selected && <div className="admin-detail-panel"><header><div><span>SUBSCRIPTIONS</span><h3>{selected.display_name || selected.email || selected.id} 的订阅</h3></div><div className="admin-row-actions"><button className="button small primary" type="button" onClick={openPeriodEditor}><CalendarBlank size={17} />修改类型与有效期</button><button className="icon-danger" type="button" onClick={() => setSelected(null)}><X size={17} /></button></div></header>{subscriptionMeta.permissionLimited && <AdminNotice>Chandler 应用订阅属性暂未同步，当前显示官网权威有效期与线下支付审核记录；管理员保存的有效期仍会立即同步到官网和桌面端。</AdminNotice>}{!subscriptionMeta.permissionLimited && subscriptionMeta.partial && <AdminNotice>该用户已有部分 Chandler 应用订阅属性完成同步，官网有效期与线下记录均已合并展示。</AdminNotice>}{subscriptions.length ? subscriptions.map((subscription, index) => { const start = subscription.current_period_start || subscription.valid_from; const end = subscription.current_period_end || subscription.valid_until; return <article key={subscription.id || index}><strong className={`subscription-state ${subscription.status || "unknown"}`}>{subscriptionStatusLabels[subscription.status] || subscription.status || "未知状态"}</strong><span>{subscription.sku_name || subscription.sku_id || subscription.product_name || "订阅套餐"}{subscription.authoritative ? " · 官网权威有效期" : ""}</span><time>{start ? `生效 ${new Date(start).toLocaleString("zh-CN")}` : "生效时间未返回"} · {end ? `到期 ${new Date(end).toLocaleString("zh-CN")}` : subscription.status === "pending_review" ? "等待审核" : "到期时间未返回"}</time></article>; }) : <p>该用户当前没有订阅记录。可点击“修改类型与有效期”直接开通并设置时间。</p>}</div>}
    {periodEditor && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPeriodEditor(null)}><form className="admin-form-modal subscription-period-modal" onSubmit={saveSubscriptionPeriod}><button className="modal-close" type="button" onClick={() => setPeriodEditor(null)}><X size={18} /></button><span>MEMBERSHIP PERIOD</span><h2>修改订阅类型与有效期</h2><p>目标用户：{periodEditor.user.display_name || periodEditor.user.email || periodEditor.user.id}</p><div className="admin-form-grid"><label className="span-2"><span>用户类型</span><select value={periodEditor.plan} onChange={(event) => setPeriodEditor({ ...periodEditor, plan: event.target.value })}><option value="member">会员用户</option><option value="short_video_monthly">短视频包月用户</option></select></label><label><span>生效时间</span><input required type="datetime-local" value={periodEditor.currentPeriodStart} onChange={(event) => setPeriodEditor({ ...periodEditor, currentPeriodStart: event.target.value })} /></label><label><span>到期时间</span><input required type="datetime-local" value={periodEditor.currentPeriodEnd} onChange={(event) => setPeriodEditor({ ...periodEditor, currentPeriodEnd: event.target.value })} /></label></div><AdminNotice>短视频包月用户在有效期内可无限使用 MiniMaxH3共享节点；管理员手动设置类型不会凭空增加付费额度。超过到期时间后，剩余套餐额度自动清除。</AdminNotice><button className="button primary full" disabled={busy === "period"}><CalendarBlank size={18} />{busy === "period" ? "保存中" : "保存订阅类型与有效期"}</button></form></div>}
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
  const confirmAction = useConfirmDialog();
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
    try { response = await localizedFetch(ticket.uploadUrl, { method: "PUT", mode: "cors", headers: ticket.requiredHeaders || {}, body: file }); }
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
    const partner = partners.find((item) => item.id === id);
    if (!await confirmAction({
      tone: "danger",
      eyebrow: "REMOVE PARTNER",
      title: "删除这个合作伙伴？",
      message: "删除后，首页品牌神经网络会立即停止展示该合作伙伴。",
      detail: partner?.name || id,
      detailLabel: "合作伙伴",
      note: "对应的腾讯云 COS Logo 与宣传图片也会一并删除，无法恢复。",
      confirmLabel: "永久删除",
    })) return;
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
  const filtered = useMemo(() => channels.filter((channel) => !keyword || `${channel.name} ${releaseProductName(channel)}`.toLowerCase().includes(keyword.toLowerCase())), [channels, keyword]);

  async function release(channel) {
    setMessage("");
    try {
      const result = await apiFetch("/api/admin/release-jobs", { method: "POST", body: JSON.stringify({ channelId: channel.id }) });
      setMessage(`${releaseProductName(channel)} 已进入发行队列；Windows 工作器会自动调用既有版本发布工作流。`);
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
      setMessage(`${releaseProductName(channel)} 的 v${version} 已上传并切换为最新版本。`);
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
    <div className="release-picker"><button className="release-picker-trigger" onClick={() => setOpen(!open)}><div><span>选择用户分组 / 发行渠道</span><strong>{channels.length ? `${channels.length} 个可用渠道` : "等待工作器同步分组"}</strong></div><MagnifyingGlass size={19} /></button>{open && <div className="release-picker-menu"><label><MagnifyingGlass size={16} /><input autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入用户分组或产品版本关键词" /></label><div>{filtered.map((channel) => <article key={channel.id}><div><strong>{releaseProductName(channel)}</strong><small>内部渠道：{channel.name} · 允许主题：{(channel.themeNames || []).join("、")}</small>{channel.latestRelease && <span>当前 v{channel.latestRelease.version} · {new Date(channel.latestRelease.publishedAt).toLocaleString("zh-CN")}</span>}</div><div className="release-channel-actions"><button className="button small secondary" onClick={() => setManualUpload({ channel, version: channel.latestRelease?.version || "1.0.0", file: null, busy: false, error: "", progress: 0 })}><CloudArrowUp size={15} /> 手动上传</button><button className="button small primary" onClick={() => release(channel)}><RocketLaunch size={15} /> 手动打包发布</button></div></article>)}{!filtered.length && <p className="release-picker-empty">没有匹配的用户分组。请先运行发行工作器同步桌面端权限文件。</p>}</div></div>}</div>
    <div className="release-job-list"><h3>最近发版任务</h3>{jobs.length ? jobs.map((job) => { const channel = channels.find((item) => item.id === job.channelId) || { name: job.channelName }; return <article key={job.id}><div className={`job-status ${job.status}`}><span /><strong>{job.status === "queued" ? "排队" : job.status === "building" ? "构建中" : job.status === "uploading" ? "上传中" : job.status === "completed" ? "已发布" : "失败"}</strong></div><div><strong>{releaseProductName(channel)}</strong><small>{job.version ? `v${job.version}` : "等待生成版本号"} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small></div>{job.error && <p>{localizeErrorMessage(job.error, "发行任务失败，请重新发起")}</p>}</article>; }) : <EmptyState icon={RocketLaunch} title="还没有发版任务" text="从上方用户分组列表选择一个渠道开始发版。" />}</div>
    {manualUpload && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !manualUpload.busy && setManualUpload(null)}><form className="admin-form-modal release-upload-modal" onSubmit={uploadRelease}><button className="modal-close" type="button" disabled={manualUpload.busy} onClick={() => setManualUpload(null)}><X size={18} /></button><span>MANUAL COS RELEASE</span><h2>手动上传新版本</h2><p>发行渠道：<strong>{releaseProductName(manualUpload.channel)}</strong></p><div className="admin-form-grid"><label><span>版本号</span><input required maxLength={40} value={manualUpload.version} onChange={(event) => setManualUpload({ ...manualUpload, version: event.target.value })} placeholder="例如 1.6.0" /></label><label><span>Windows 安装包</span><input required type="file" accept=".exe,.msix,.msixbundle,.zip,application/octet-stream" onChange={(event) => setManualUpload({ ...manualUpload, file: event.target.files?.[0] || null })} /></label></div><AdminNotice>只有点击下方按钮后文件才会从浏览器直传成都 COS。新文件校验成功后替换线上版本，并清理该渠道旧安装包。</AdminNotice>{manualUpload.busy && <div className="upload-progress"><span style={{ width: `${manualUpload.progress}%` }} /><em>{manualUpload.progress}%</em></div>}{manualUpload.error && <div className="form-error">{manualUpload.error}</div>}<button className="button primary full" disabled={manualUpload.busy || !manualUpload.file}><CloudArrowUp size={18} /> {manualUpload.busy ? "正在上传并校验" : "确认手动上传并设为最新版"}</button></form></div>}
  </section>;
}

function WorkerReviewManager() {
  const confirmAction = useConfirmDialog();
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
    const taskPayment = kind === "task";
    if (!await confirmAction({
      tone: "positive",
      eyebrow: "PAYMENT REVIEW",
      title: taskPayment ? "确认任务预算已到账？" : "确认联系方式订单已到账？",
      message: taskPayment ? `通过后任务将按“${item.assignment?.label || "公开接单"}”立即开放。` : "通过后，申请用户将立即获得本任务另一方的微信号。",
      detail: taskPayment ? item.title : item.orderNo,
      detailLabel: taskPayment ? "任务" : "订单号",
      confirmLabel: "确认到账并通过",
    })) return;
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

const feedbackStatusLabels = { open: "待处理", processing: "处理中", resolved: "已处理", closed: "已处理" };

function FeedbackResponseAssets({ assets = [] }) {
  if (!assets.length) return null;
  return <div className="feedback-response-assets">{assets.map((asset) => asset.kind === "video"
    ? <figure key={asset.id}><video controls preload="metadata" src={asset.url} /><figcaption><VideoCamera size={18} />{asset.filename}</figcaption></figure>
    : <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><img src={asset.url} alt={asset.filename} /><span><ImageSquare size={18} />{asset.filename}</span></a>)}</div>;
}

function FeedbackManager() {
  const confirmAction = useConfirmDialog();
  const [keyword, setKeyword] = useState("");
  const [tab, setTab] = useState("open");
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ open: 0, processing: 0, resolved: 0, total: 0 });
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [handling, setHandling] = useState(null);

  async function load(event, page = 1, query = keyword, status = tab) {
    event?.preventDefault();
    setBusy("load"); setMessage("");
    const params = new URLSearchParams({ page: String(page), limit: "30", status });
    if (query.trim()) params.set("q", query.trim());
    try {
      const result = await apiFetch(`/api/admin/feedback?${params}`);
      setItems(result.items || []);
      setSummary(result.summary || { open: 0, processing: 0, resolved: 0, total: 0 });
      setPagination(result.pagination || { page: 1, pages: 1, total: 0 });
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  useEffect(() => { load(); }, []);

  function switchTab(status) {
    setTab(status);
    load(null, 1, keyword, status);
  }

  function beginHandling(item) {
    setHandling({ item, progress: item.progress || "", response: item.response || "", files: [] });
    setMessage("");
  }

  async function uploadResponseFiles(feedbackId, files) {
    const attachmentIds = [];
    for (const file of files) {
      const ticket = await apiFetch(`/api/admin/feedback/${feedbackId}/assets/presign`, { method: "POST", body: JSON.stringify({ filename: file.name, contentType: file.type, bytes: file.size }) });
      const uploaded = await localizedFetch(ticket.uploadUrl, { method: "PUT", headers: ticket.requiredHeaders, body: file });
      if (!uploaded.ok) throw new Error(`附件“${file.name}”上传失败，请重试`);
      await apiFetch(`/api/admin/feedback/${feedbackId}/assets/${ticket.uploadId}/complete`, { method: "POST", body: "{}" });
      attachmentIds.push(ticket.uploadId);
    }
    return attachmentIds;
  }

  async function save(status) {
    if (!handling) return;
    if (handling.progress.trim().length < 2) return setMessage("请填写处理进度。");
    if (status === "resolved" && handling.response.trim().length < 2) return setMessage("标记为已处理前，请填写处理结果。");
    setBusy(`handle-${handling.item.id}`); setMessage("");
    try {
      const attachmentIds = await uploadResponseFiles(handling.item.id, handling.files);
      await apiFetch(`/api/admin/feedback/${handling.item.id}`, { method: "PUT", body: JSON.stringify({ status, progress: handling.progress, response: handling.response, attachmentIds }) });
      setHandling(null);
      setMessage(status === "resolved" ? "处理结果已保存，并已通知反馈用户。" : "处理进度已保存。用户可在“我的反馈”中查看。" );
      if (status !== tab) { setTab(status); await load(null, 1, keyword, status); }
      else await load(null, pagination.page, keyword, tab);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function remove(item) {
    if (!await confirmAction({
      tone: "danger",
      eyebrow: "DELETE USER FEEDBACK",
      title: "永久删除这条用户反馈？",
      message: "反馈记录、处理进度和处理结果将从管理员及用户后台同时移除。",
      detail: item.id,
      detailLabel: "反馈编号",
      note: "已上传的处理图片与视频附件也会从腾讯云 COS 删除，此操作不可恢复。",
      confirmLabel: "永久删除反馈",
    })) return;
    setBusy(`delete-${item.id}`); setMessage("");
    try {
      await apiFetch(`/api/admin/feedback/${item.id}`, { method: "DELETE" });
      setMessage("用户反馈及其处理附件已删除。");
      await load(null, items.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page, keyword, tab);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  return <section className="admin-module feedback-manager">
    <header className="admin-module-head"><div><span>VOICE OF USER</span><h2>用户反馈</h2><p>从待处理、处理中到已处理完整跟踪用户问题；处理结果与附件会同步到用户后台。</p></div><button className="button secondary" disabled={Boolean(busy)} onClick={() => load(null, pagination.page || 1)}><ArrowClockwise size={17} /> {busy === "load" ? "加载中" : "刷新"}</button></header>
    <div className="feedback-status-tabs" role="tablist" aria-label="用户反馈处理状态">{[["open", "待处理"], ["processing", "处理中"], ["resolved", "已处理"]].map(([status, label]) => <button type="button" role="tab" aria-selected={tab === status} className={tab === status ? "active" : ""} key={status} onClick={() => switchTab(status)}><span>{label}</span><strong>{summary[status] || 0}</strong></button>)}</div>
    <form className="feedback-admin-filter" onSubmit={(event) => load(event, 1)}><label><MagnifyingGlass size={19} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索反馈内容、昵称、用户名、邮箱、编号或状态" /></label><button className="button primary" disabled={busy}><MagnifyingGlass size={17} /> 搜索反馈</button>{keyword && <button type="button" className="button ghost" onClick={() => { setKeyword(""); load(null, 1, ""); }}>清空</button>}</form>
    {message && <AdminNotice tone={message.startsWith("处理") || message.includes("已删除") ? "success" : "error"}>{message}</AdminNotice>}
    {items.length ? <div className="admin-feedback-list">{items.map((item) => {
      const ownerName = item.owner?.displayName || item.owner?.username || item.owner?.email || "匿名用户";
      return <article key={item.id}>
        <header><div className="feedback-user-avatar">{item.owner?.avatar ? <img src={item.owner.avatar} alt="" /> : ownerName.slice(0, 1).toUpperCase()}</div><div><strong>{ownerName}</strong><span>{item.owner?.email || "匿名反馈"}</span></div><div className="admin-feedback-card-actions"><em className={`status-pill ${item.status}`}>{feedbackStatusLabels[item.status] || item.status || "待处理"}</em><button className="button small secondary" disabled={Boolean(busy)} onClick={() => beginHandling(item)}>{item.status === "open" ? "处理" : "查看并更新"}</button><button className="icon-danger" disabled={Boolean(busy)} onClick={() => remove(item)} aria-label={`删除反馈 ${item.id}`}><Trash size={18} /></button></div></header>
        <p>{item.message}</p>
        {item.screenshots?.length > 0 && <div className="admin-feedback-images">{item.screenshots.map((url, index) => <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" aria-label={`查看第 ${index + 1} 张反馈截图`}><img src={url} alt={`反馈截图 ${index + 1}`} /><ArrowSquareOut size={18} /></a>)}</div>}
        {(item.progress || item.response) && <div className="admin-feedback-response"><span>处理记录</span>{item.progress && <p><strong>处理进度</strong>{item.progress}</p>}{item.response && <p><strong>处理结果</strong>{item.response}</p>}<FeedbackResponseAssets assets={item.responseAttachments} /></div>}
        <footer><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time><span>反馈编号：{item.id}</span></footer>
      </article>;
    })}</div> : <EmptyState icon={ChatCircleText} title={busy === "load" ? "正在读取用户反馈" : keyword ? "没有匹配的反馈" : `当前没有${feedbackStatusLabels[tab]}反馈`} text={keyword ? "请尝试更换关键词后重新搜索。" : "新反馈和处理进展会自动进入对应状态列表。"} />}
    <footer className="admin-module-footer feedback-pagination"><span>共 {pagination.total || 0} 条反馈</span><div><button className="button small ghost" disabled={busy || (pagination.page || 1) <= 1} onClick={() => load(null, (pagination.page || 1) - 1)}>上一页</button><strong>第 {pagination.page || 1} / {pagination.pages || 1} 页</strong><button className="button small ghost" disabled={busy || (pagination.page || 1) >= (pagination.pages || 1)} onClick={() => load(null, (pagination.page || 1) + 1)}>下一页</button></div></footer>
    {handling && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setHandling(null)}><section className="admin-form-modal feedback-handle-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-handle-title"><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setHandling(null)}><X size={18} /></button><span>FEEDBACK WORKLOG</span><h2 id="feedback-handle-title">处理用户反馈</h2><p className="feedback-handle-source">{handling.item.message}</p><label><span>处理进度</span><textarea required minLength={2} maxLength={5000} rows={4} value={handling.progress} onChange={(event) => setHandling({ ...handling, progress: event.target.value })} placeholder="例如：已复现问题，正在检查桌面端与官网的同步链路。" /></label><label><span>处理结果</span><textarea maxLength={20000} rows={6} value={handling.response} onChange={(event) => setHandling({ ...handling, response: event.target.value })} placeholder="处理完成后，向用户清楚说明修复结果、使用方法或后续安排。" /></label><label className="feedback-result-picker"><span><ImageSquare size={20} />处理图片或视频</span><strong>{handling.files.length ? `已选择 ${handling.files.length} 个附件` : "选择图片或视频"}</strong><small>图片支持 JPG、PNG、WebP、GIF；视频支持 MP4、WebM、MOV。单个文件不超过 200 MB，最多 12 个。</small><input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={(event) => setHandling({ ...handling, files: Array.from(event.target.files || []).slice(0, 12) })} /></label>{handling.files.length > 0 && <div className="feedback-selected-files">{handling.files.map((file, index) => <span key={`${file.name}-${file.lastModified}`}>{file.type.startsWith("video/") ? <VideoCamera size={18} /> : <ImageSquare size={18} />}{file.name}<button type="button" onClick={() => setHandling({ ...handling, files: handling.files.filter((_, candidate) => candidate !== index) })}><X size={15} /></button></span>)}</div>}{handling.item.responseAttachments?.length > 0 && <div className="feedback-existing-results"><strong>已上传的处理附件</strong><FeedbackResponseAssets assets={handling.item.responseAttachments} /></div>}<div className="feedback-handle-actions"><button type="button" className="button ghost" disabled={Boolean(busy)} onClick={() => setHandling(null)}>取消</button><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => save("processing")}><FloppyDisk size={18} />保存为处理中</button><button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => save("resolved")}><CheckCircle size={18} />标记已处理并通知用户</button></div></section></div>}
  </section>;
}

function WorkflowManager() {
  const confirmAction = useConfirmDialog();
  const [workflows, setWorkflows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setBusy("load"); setMessage("");
    try { const result = await apiFetch("/api/admin/workflows"); setWorkflows(result.workflows || []); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }
  useEffect(() => { load(); }, []);

  function openEditor(workflow = null) {
    setEditing({
      id: workflow?.id || null,
      name: workflow?.name || "",
      description: workflow?.description || "",
      url: workflow?.url || "",
      sort: workflow?.sort ?? 100,
      status: workflow?.status || "active",
      imageUrl: workflow?.imageUrl || "",
      file: null,
    });
    setMessage("");
  }

  async function uploadImage(file) {
    const ticket = await apiFetch("/api/admin/workflows/assets/presign", { method: "POST", body: JSON.stringify({ filename: file.name, contentType: file.type, bytes: file.size }) });
    const response = await localizedFetch(ticket.uploadUrl, { method: "PUT", headers: ticket.requiredHeaders, body: file });
    if (!response.ok) throw new Error("图片上传到腾讯云 COS 失败，请重试");
    await apiFetch(`/api/admin/workflows/assets/${ticket.uploadId}/complete`, { method: "POST", body: "{}" });
    return ticket.uploadId;
  }

  async function save(event) {
    event.preventDefault();
    setBusy("save"); setMessage("");
    try {
      const imageUploadId = editing.file ? await uploadImage(editing.file) : null;
      const payload = { name: editing.name, description: editing.description, url: editing.url, sort: Number(editing.sort), status: editing.status, ...(imageUploadId ? { imageUploadId } : {}) };
      await apiFetch(editing.id ? `/api/admin/workflows/${editing.id}` : "/api/admin/workflows", { method: editing.id ? "PUT" : "POST", body: JSON.stringify(payload) });
      setEditing(null); setMessage(editing.id ? "工作流已更新。" : "工作流已创建并加入官网列表。"); await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function remove(workflow) {
    if (!await confirmAction({ tone: "danger", eyebrow: "DELETE WORKFLOW", title: `删除“${workflow.name}”？`, message: "删除后官网工作流列表将立即移除该入口；如果图片存储在 COS，也会同步删除。", confirmLabel: "确认删除" })) return;
    setBusy(workflow.id); setMessage("");
    try { await apiFetch(`/api/admin/workflows/${workflow.id}`, { method: "DELETE" }); setMessage("工作流已删除。"); await load(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  return <section className="admin-module workflow-manager">
    <header className="admin-module-head"><div><span>PUBLIC WORKFLOW CATALOG</span><h2>工作流管理</h2><p>配置官网可搜索的工作流入口；图片直传腾讯云 COS，名称与跳转地址实时生效。</p></div><button type="button" className="button primary" onClick={() => openEditor()}><Plus size={18} />新建工作流</button></header>
    {message && <AdminNotice tone={message.includes("已") ? "success" : "error"}>{message}</AdminNotice>}
    {workflows.length ? <div className="admin-workflow-grid">{workflows.map((workflow) => <article key={workflow.id}><img src={workflow.imageUrl} alt={`${workflow.name}图标`} /><div><span>{workflow.status === "active" ? "官网展示中" : "已停用"}</span><h3>{workflow.name}</h3><p>{workflow.description}</p><code>{workflow.url}</code></div><div><button type="button" className="button small secondary" onClick={() => openEditor(workflow)}><PencilSimple size={16} />修改</button><button type="button" className="button small danger" disabled={busy === workflow.id} onClick={() => remove(workflow)}><Trash size={16} />删除</button></div></article>)}</div> : <EmptyState icon={FlowArrow} title={busy === "load" ? "正在读取工作流" : "还没有工作流"} text="点击右上角新建第一个官网工作流。" />}
    {editing && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setEditing(null)}><form className="admin-form-modal workflow-editor-modal" onSubmit={save}><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setEditing(null)}><X size={18} /></button><span>WORKFLOW EDITOR</span><h2>{editing.id ? "修改工作流" : "新建工作流"}</h2><p>上传一张清晰图标，填写名称与网址。站内功能可直接使用 / 开头的路径。</p><div className="workflow-editor-layout"><label className="workflow-image-picker"><span>工作流图片</span><div>{editing.file ? <img src={URL.createObjectURL(editing.file)} alt="新图片预览" /> : editing.imageUrl ? <img src={editing.imageUrl} alt="当前图片" /> : <ImageSquare size={46} />}</div><strong>{editing.file ? editing.file.name : "选择图片"}</strong><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setEditing({ ...editing, file: event.target.files?.[0] || null })} /></label><div className="workflow-editor-fields"><label><span>名称</span><input required minLength={2} maxLength={60} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="例如：威客" /></label><label><span>跳转 URL</span><input required value={editing.url} onChange={(event) => setEditing({ ...editing, url: event.target.value })} placeholder="/worker?tab=publish 或 https://..." /></label><label><span>功能说明</span><textarea maxLength={300} rows={4} value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} placeholder="用一句通俗的话告诉用户这个工作流能解决什么问题。" /></label><div className="workflow-editor-row"><label><span>排序</span><input type="number" value={editing.sort} onChange={(event) => setEditing({ ...editing, sort: event.target.value })} /></label><label><span>状态</span><select value={editing.status} onChange={(event) => setEditing({ ...editing, status: event.target.value })}><option value="active">官网展示</option><option value="disabled">暂时停用</option></select></label></div></div></div><button className="button primary full" disabled={Boolean(busy)}>{busy === "save" ? "正在保存" : editing.id ? "保存工作流" : "创建并加入官网"}</button></form></div>}
  </section>;
}

const paymentStatusText = { pending: "待支付", paid: "已支付", approved: "已通过", rejected: "已拒绝", failed: "支付失败", refunded: "已退款", cancelled: "已取消", canceled: "已取消" };

function PaymentManager() {
  const confirmAction = useConfirmDialog();
  const [mode, setMode] = useState("online");
  const [reviewTab, setReviewTab] = useState("pending");
  const [filters, setFilters] = useState({ q: "", from: "", to: "", channelId: "" });
  const [channels, setChannels] = useState([]);
  const [orders, setOrders] = useState([]);
  const [summary, setSummary] = useState({ total: 0, pending: 0, reviewed: 0, approved: 0, rejected: 0 });
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState(null);
  const [busy, setBusy] = useState("");

  async function load(event, nextMode = mode, nextReviewTab = reviewTab, nextFilters = filters, silent = false) {
    event?.preventDefault();
    if (!silent) { setBusy("orders"); setMessage(""); }
    const params = new URLSearchParams({ limit: "100" });
    if (nextMode === "offline") params.set("status", nextReviewTab);
    for (const [key, value] of Object.entries(nextFilters)) if (value) params.set(key, value);
    try {
      const result = await apiFetch(`/api/admin/${nextMode === "online" ? "payments" : "offline-payments"}?${params}`);
      setOrders(result.orders || []);
      setSummary(result.summary || { total: 0, pending: 0, reviewed: 0, approved: 0, rejected: 0 });
    } catch (error) { setMessage(error.message); }
    finally { if (!silent) setBusy(""); }
  }

  useEffect(() => {
    apiFetch("/api/admin/release-channels").then((result) => setChannels(result.channels || [])).catch(() => setChannels([]));
  }, []);
  useEffect(() => { load(null, mode, reviewTab); }, [mode, reviewTab]);
  useEffect(() => {
    if (mode !== "offline" || reviewTab !== "pending") return undefined;
    const timer = window.setInterval(() => load(null, "offline", "pending", filters, true), 15_000);
    return () => window.clearInterval(timer);
  }, [mode, reviewTab, filters]);

  function switchMode(nextMode) {
    setOrders([]); setMessage(""); setMode(nextMode);
  }

  function resetFilters() {
    const empty = { q: "", from: "", to: "", channelId: "" };
    setFilters(empty);
    load(null, mode, reviewTab, empty);
  }

  async function approve(order) {
    if (!await confirmAction({
      tone: "positive",
      eyebrow: "OFFLINE PAYMENT REVIEW",
      title: "确认款项已到账？",
      message: "通过后会员权益会立即写入官网，并同步到桌面端。",
      detail: order.user?.email || order.userEmail || order.orderNo,
      detailLabel: "用户 / 订单",
      confirmLabel: "确认到账并开通",
    })) return;
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
    {orders.length ? <div className="offline-order-grid">{orders.map((order) => <article key={order.id}><header><div><span>{order.kind === "recharge" ? `${mode === "online" ? "线上" : "线下"}账户充值` : order.subscriptionPlan === "short_video_monthly" || order.partnerData?.subscription_plan === "short_video_monthly" ? `线下短视频包月 · ${order.cycle === "year" ? "年度" : "月度"}` : mode === "online" ? order.cycle === "year" ? "线上年度会员" : "线上月度会员" : order.cycle === "year" ? "线下年度会员" : "线下月度会员"}</span><strong>{formatMoney(order.amountFen)}</strong></div><span className={`status-pill ${order.status}`}>{mode === "offline" && order.status === "pending" ? "待审核" : paymentStatusText[order.status] || order.status || "未知"}</span></header><dl><div><dt>订单号</dt><dd>{order.orderNo}</dd></div><div><dt>用户</dt><dd>{order.user?.displayName || order.user?.email || order.userEmail || order.ownerId}</dd></div><div><dt>{mode === "offline" && reviewTab === "reviewed" ? "审核时间" : "下单时间"}</dt><dd>{new Date(mode === "offline" && reviewTab === "reviewed" ? order.reviewedAt || order.updatedAt || order.createdAt : order.createdAt).toLocaleString("zh-CN")}</dd></div><div><dt>发行渠道</dt><dd>{order.releaseChannel?.isDefault ? "古龙版（默认）" : order.releaseChannel?.name || "古龙版（默认）"}</dd></div><div><dt>{mode === "online" ? "支付渠道" : "Chandler"}</dt><dd>{mode === "online" ? order.provider === "wechat" ? "微信支付" : order.provider === "alipay" ? "支付宝" : order.provider || "未返回" : order.chandlerOrderNo || "等待镜像"}</dd></div>{mode === "online" && <div><dt>交易号</dt><dd>{order.providerTransactionId || "尚未完成支付"}</dd></div>}</dl>{mode === "offline" && order.previousReviewReason && <div className="offline-review-history"><strong>上次拒绝：</strong>{order.previousReviewReason}<br /><strong>用户调整：</strong>{order.resubmissionNote || "未填写"}</div>}{mode === "offline" && order.reviewReason && <div className="offline-review-history rejected"><strong>拒绝原因：</strong>{order.reviewReason}</div>}{mode === "offline" && order.status === "pending" && <div className="offline-review-actions"><button className="button primary" disabled={busy === order.id} onClick={() => approve(order)}><CheckCircle size={17} /> 确认到账并通过</button><button className="button danger" disabled={busy === order.id} onClick={() => setRejecting({ order, reason: "" })}><X size={17} /> 拒绝通过</button></div>}</article>)}</div> : <EmptyState icon={mode === "online" ? CurrencyCny : ShieldCheck} title={busy === "orders" ? "正在读取订单" : mode === "online" ? "没有匹配的线上订单" : reviewTab === "pending" ? "当前没有待审核申请" : "没有匹配的已审核记录"} text={mode === "online" ? "可调整关键词、日期或发行渠道后重新查询。" : reviewTab === "pending" ? "新的线下支付申请会优先显示在这里。" : "已通过和已拒绝的申请会统一保留在这里。"} />}
    {rejecting && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setRejecting(null)}><form className="admin-form-modal offline-reject-modal" onSubmit={reject}><button className="modal-close" type="button" disabled={Boolean(busy)} onClick={() => setRejecting(null)}><X size={18} /></button><span>REJECT OFFLINE PAYMENT</span><h2>拒绝通过</h2><p>订单：<strong>{rejecting.order.orderNo}</strong></p><label><span>拒绝原因</span><textarea required minLength={2} maxLength={500} autoFocus value={rejecting.reason} onChange={(event) => setRejecting({ ...rejecting, reason: event.target.value })} placeholder="请清楚说明金额、付款截图或订单信息中需要用户调整的内容。" /></label><div className="offline-reject-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => setRejecting(null)}>取消</button><button className="button danger" disabled={Boolean(busy)}><FloppyDisk size={17} /> {busy ? "正在保存" : "保存拒绝原因"}</button></div></form></div>}
  </section>;
}

function PearTokenManager() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({ key: "", token: "", tokenChannel: "免费", imageMin: "", imageMax: "", videoMin: "", videoMax: "" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  function yuan(fen) {
    return Number(fen || 0) ? (Number(fen) / 100).toFixed(2) : "";
  }

  function fen(value) {
    const number = Number(value || 0);
    return Math.max(0, Math.round(number * 100));
  }

  async function load() {
    setBusy("load"); setMessage("");
    try {
      const result = await apiFetch("/api/admin/pearapi/config");
      setConfig(result);
      setForm((current) => ({ ...current, tokenChannel: result.tokenChannel || "免费", imageMin: yuan(result.pricing?.imageMinFen), imageMax: yuan(result.pricing?.imageMaxFen), videoMin: yuan(result.pricing?.videoMinFen), videoMax: yuan(result.pricing?.videoMaxFen) }));
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  useEffect(() => { load(); }, []);

  async function save(event) {
    event.preventDefault(); setBusy("save"); setMessage("");
    try {
      const result = await apiFetch("/api/admin/pearapi/config", { method: "PUT", body: JSON.stringify({ key: form.key || undefined, token: form.token || undefined, tokenChannel: form.tokenChannel, imageMinFen: fen(form.imageMin), imageMaxFen: fen(form.imageMax), videoMinFen: fen(form.videoMin), videoMaxFen: fen(form.videoMax) }) });
      setConfig(result.config); setForm((current) => ({ ...current, key: "", token: "" }));
      setMessage("PearAPI 全局凭据与计费区间已加密保存，网页版立即生效。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function testConnection() {
    setBusy("test"); setMessage("");
    try {
      const result = await apiFetch("/api/admin/pearapi/test", { method: "POST", body: "{}" });
      const unavailable = (result.models || []).filter((model) => !model.available).map((model) => model.name).join("、");
      setMessage(result.allAvailable ? `连接成功：全部 ${result.total} 个免费文字模型均可用。` : `检测完成：${result.healthy}/${result.total} 个模型可用；暂不可用：${unavailable || "未知模型"}。对话时会自动切换至可用的免费模型。`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  return <section className="admin-module pear-token-manager">
    <header className="admin-module-head"><div><span>GLOBAL MODEL CREDENTIAL</span><h2>令牌配置</h2><p>由管理员统一管理 PearAPI，普通用户与浏览器永远无法读取明文 Key 或令牌。</p></div><button className="button secondary" type="button" disabled={Boolean(busy)} onClick={load}><ArrowClockwise size={17} />刷新状态</button></header>
    {message && <AdminNotice tone={message.includes("成功") || message.includes("已") ? "success" : "error"}>{message}</AdminNotice>}
    <div className="pear-token-layout">
      <form className="pear-token-form" onSubmit={save}>
        <div className="pear-token-form-head"><div><LockKey size={29} weight="duotone" /><span><strong>PearAPI Key 与渠道令牌</strong><small>AES-256-GCM 加密保存，保存后只显示末 4 位</small></span></div><em className={config?.keyConfigured && config?.tokenConfigured ? "ready" : ""}>{config?.keyConfigured && config?.tokenConfigured ? "文字与媒体模型已连接" : "等待完整配置"}</em></div>
        <label><span>PearAPI API Key</span><input type="password" minLength={config?.keyConfigured ? 0 : 8} value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} placeholder={config?.keyMasked ? `${config.keyMasked}（留空表示不修改）` : "输入 PearAPI API Key"} /><small>用于图片、视频接口的 key 参数；网页版不会回显。</small></label>
        <label><span>PearAPI 令牌渠道</span><select value={form.tokenChannel} onChange={(event) => setForm({ ...form, tokenChannel: event.target.value })}>{(config?.tokenChannels || ["默认", "优质", "免费", "按次", "特价", "限时免费"]).map((channel) => <option key={channel} value={channel}>{channel}</option>)}</select><small>请选择与 PearAPI 控制台中该枚令牌完全一致的渠道。切换渠道时需要同时填写新令牌。</small></label>
        <label><span>PearAPI 渠道令牌</span><input type="password" minLength={config?.tokenConfigured ? 0 : 8} required={Boolean(config?.tokenConfigured && form.tokenChannel !== config?.tokenChannel)} value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} placeholder={config?.tokenMasked ? `${config.tokenMasked}（留空表示不修改）` : `粘贴“${form.tokenChannel}”渠道的 AI 令牌`} /><small>{form.tokenChannel === "免费" ? "当前网页版免费文字模型使用“免费”渠道令牌。" : `当前选择“${form.tokenChannel}”渠道；该令牌只能调用此渠道支持的模型，免费文字模型通常需要切换到“免费”。`}</small></label>
        <fieldset><legend>付费媒体成本区间（人民币 / 次）</legend><p>PearAPI 免费文字模型扣费为 0；图片、视频成本录入后，用户资产按官方成本增加 30% 计算可创作范围。</p><div><label><span>图片最低成本</span><input type="number" min="0" step="0.01" value={form.imageMin} onChange={(event) => setForm({ ...form, imageMin: event.target.value })} placeholder="例如 0.10" /></label><label><span>图片最高成本</span><input type="number" min="0" step="0.01" value={form.imageMax} onChange={(event) => setForm({ ...form, imageMax: event.target.value })} placeholder="例如 0.80" /></label><label><span>视频最低成本</span><input type="number" min="0" step="0.01" value={form.videoMin} onChange={(event) => setForm({ ...form, videoMin: event.target.value })} placeholder="例如 1.00" /></label><label><span>视频最高成本</span><input type="number" min="0" step="0.01" value={form.videoMax} onChange={(event) => setForm({ ...form, videoMax: event.target.value })} placeholder="例如 10.00" /></label></div></fieldset>
        <div className="pear-token-actions"><button className="button primary" disabled={Boolean(busy)}><FloppyDisk size={17} />{busy === "save" ? "正在加密保存" : "保存并立即应用"}</button><button className="button secondary" type="button" disabled={Boolean(busy) || !config?.tokenConfigured} onClick={testConnection}><Lightning size={17} />{busy === "test" ? "正在检测 7 个模型" : "测试全部免费模型"}</button></div>
      </form>
      <aside className="pear-token-guide"><span>HOW TO GET CHANNEL TOKEN</span><h3>渠道令牌获取方式</h3><ol><li><b>1</b><span><strong>打开 PearAPI 控制台</strong><small>使用平台账号登录管理后台。</small></span></li><li><b>2</b><span><strong>进入“令牌管理”</strong><small>点击新建令牌，并确认它所属的渠道。</small></span></li><li><b>3</b><span><strong>复制 AI 令牌并保存</strong><small>左侧选择相同渠道，再粘贴令牌。免费文字模型请选择“免费”。</small></span></li></ol><a className="button secondary full" href="https://api.pearapi.ai/zh/dashboard/tokens" target="_blank" rel="noreferrer">打开 PearAPI 令牌管理 <ArrowSquareOut size={17} /></a><a className="pear-doc-link" href={config?.docsUrl || "https://api.pearapi.ai/zh/dashboard/docs"} target="_blank" rel="noreferrer">查看官方接入文档 <ArrowRight size={16} /></a><div className="pear-security-note"><ShieldCheck size={22} weight="duotone" /><p><strong>凭据分工</strong><span>渠道令牌用于文字模型；API Key 用于图片与视频。两者均只保存在古龙服务端。</span></p></div></aside>
    </div>
    <div className="pear-free-models"><header><div><span>FREE MODEL ALLOWLIST</span><h3>网页版免费 LLM 白名单</h3></div><strong>{config?.models?.length || 7} 个模型</strong></header><div>{(config?.models || []).map((model) => <article key={model.id}><div><ChatCircleText size={21} weight="duotone" /><span>{model.vendor}</span><em>免费</em></div><h4>{model.name}</h4><code>{model.id}</code><p>{model.description}</p></article>)}</div></div>
    <div className="pear-free-models pear-media-catalog"><header><div><span>MEDIA MODEL CATALOG</span><h3>PearAPI 图片与视频模型</h3></div><strong>{(config?.mediaModels?.image?.length || 0) + (config?.mediaModels?.video?.length || 0)} 个模型</strong></header><div>{[...(config?.mediaModels?.image || []), ...(config?.mediaModels?.video || [])].map((model) => <article key={model.id}><div>{model.modality === "image" ? <ImageSquare size={21} weight="duotone" /> : <VideoCamera size={21} weight="duotone" />}<span>{model.modality === "image" ? "图片" : "视频"}</span><em>{model.priceLabel}</em></div><h4>{model.name}</h4><code>{model.id}</code><p>{model.strengths?.join(" · ")}<br />参考图上限：{model.referenceImages} 张；用户结算已包含 30% 服务费。</p></article>)}</div></div>
  </section>;
}

function ActivationCodeManager() {
  const confirmAction = useConfirmDialog();
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [status, setStatus] = useState("");
  const [count, setCount] = useState(10);
  const [note, setNote] = useState("");
  const [generated, setGenerated] = useState([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function load(nextStatus = status) {
    setBusy("load"); setMessage("");
    try {
      const query = nextStatus ? `?status=${encodeURIComponent(nextStatus)}` : "";
      const result = await apiFetch(`/api/admin/activation-codes${query}`);
      setItems(result.items || []); setCounts(result.counts || {});
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  useEffect(() => { load(); }, []);

  async function generate(event) {
    event.preventDefault(); setBusy("generate"); setMessage(""); setGenerated([]);
    try {
      const result = await apiFetch("/api/admin/activation-codes", {
        method: "POST",
        body: JSON.stringify({ count: Number(count), product: "minimax-h3-universal", note }),
      });
      setGenerated(result.codes || []);
      setMessage(`已生成 ${result.count} 个 MiniMax H3 永久激活码；明文只在本窗口显示一次。`);
      await load(status);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  async function writeClipboard(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("COPY_FAILED");
  }

  async function copyCodes() {
    try {
      await writeClipboard(generated.join("\n"));
      setMessage(`已复制 ${generated.length} 个激活码。`);
    } catch {
      setMessage("浏览器未允许写入剪贴板，请选中激活码后手动复制。");
    }
  }

  async function copyCode(item) {
    setBusy(item.id); setMessage("");
    try {
      let code = item.code;
      let reissued = false;
      if (!code && item.status === "unused") {
        const result = await apiFetch(`/api/admin/activation-codes/${item.id}/reissue`, { method: "POST", body: "{}" });
        code = result.code;
        reissued = Boolean(result.reissued);
        setItems((current) => current.map((record) => record.id === item.id ? { ...record, code, codePreview: result.codePreview || record.codePreview } : record));
      }
      if (!code) {
        setMessage("这条已使用或已停用的旧授权只保留安全摘要，不能再次发送给用户。");
        return;
      }
      await writeClipboard(code);
      setMessage(reissued ? `旧密文无法恢复，已重新生成并复制激活码 ${code}。` : `激活码 ${code} 已复制。`);
    } catch (error) {
      setMessage(error?.code || error?.status ? error.message : "浏览器未允许写入剪贴板，请选中激活码后手动复制。");
    } finally { setBusy(""); }
  }

  async function revoke(item) {
    if (!await confirmAction({
      tone: "danger",
      eyebrow: "REVOKE ACTIVATION",
      title: "停用这个永久授权？",
      message: "停用后该设备保留的离线回执不会被远程删除，但后续重新激活和在线校验会被拒绝。",
      detail: `${item.codePreview}${item.deviceName ? ` · ${item.deviceName}` : ""}`,
      detailLabel: "授权记录",
      confirmLabel: "确认停用",
    })) return;
    setBusy(item.id); setMessage("");
    try {
      await apiFetch(`/api/admin/activation-codes/${item.id}/revoke`, { method: "POST", body: "{}" });
      setMessage("授权记录已停用。"); await load(status);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  }

  return <section className="admin-module activation-manager">
    <header className="admin-module-head"><div><span>DEVICE-BOUND OFFLINE LICENSES</span><h2>授权管理</h2><p>批量生成安装激活码。首次使用后绑定设备物理网卡指纹，同一台电脑可永久离线使用。</p></div><button className="button secondary" disabled={Boolean(busy)} onClick={() => load()}><ArrowClockwise size={17} />刷新</button></header>
    {message && <AdminNotice tone={message.includes("已") ? "success" : "error"}>{message}</AdminNotice>}
    <div className="activation-summary"><button className={!status ? "active" : ""} onClick={() => { setStatus(""); load(""); }}><strong>{(counts.unused || 0) + (counts.used || 0) + (counts.revoked || 0)}</strong><span>全部</span></button><button className={status === "unused" ? "active" : ""} onClick={() => { setStatus("unused"); load("unused"); }}><strong>{counts.unused || 0}</strong><span>未使用</span></button><button className={status === "used" ? "active" : ""} onClick={() => { setStatus("used"); load("used"); }}><strong>{counts.used || 0}</strong><span>已使用</span></button><button className={status === "revoked" ? "active" : ""} onClick={() => { setStatus("revoked"); load("revoked"); }}><strong>{counts.revoked || 0}</strong><span>已停用</span></button></div>
    <form className="activation-generator" onSubmit={generate}><div><label><span>生成数量</span><input type="number" min="1" max="500" value={count} onChange={(event) => setCount(event.target.value)} /></label><label className="wide"><span>批次备注</span><input maxLength="200" value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：2026 年 8 月创作者内测" /></label></div><button className="button primary" disabled={Boolean(busy)}><Key size={18} weight="fill" />{busy === "generate" ? "正在生成" : "批量生成激活码"}</button></form>
    {generated.length > 0 && <section className="activation-generated"><header><div><strong>本批次激活码</strong><span>激活码已加密保存，管理员可随时从下方列表复制。</span></div><button type="button" className="button secondary small" onClick={copyCodes}><Copy size={16} />复制全部</button></header><textarea readOnly value={generated.join("\n")} rows={Math.min(generated.length + 1, 12)} /></section>}
    <div className="activation-table"><div className="activation-table-head"><span>激活码</span><span>状态</span><span>绑定设备</span><span>生成 / 激活时间</span><span>操作</span></div>{items.map((item) => <article key={item.id}><div><strong className="activation-code-value" title={item.code || item.codePreview}>{item.code || item.codePreview}</strong><small>{item.note || item.product}{!item.code ? " · 旧记录仅保留安全摘要" : ""}</small></div><em className={`status-pill ${item.status}`}>{item.status === "unused" ? "未使用" : item.status === "used" ? "已使用" : "已停用"}</em><div><strong>{item.deviceName || "尚未绑定"}</strong><small>{item.macHint ? `MAC 尾号 ${item.macHint}` : "首次安装时绑定"}</small></div><div><time>{item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "-"}</time><small>{item.activatedAt ? `激活 ${new Date(item.activatedAt).toLocaleString("zh-CN")}` : "等待使用"}</small></div><div className="activation-row-actions"><button type="button" className="button small secondary" disabled={Boolean(busy)} onClick={() => copyCode(item)} title={item.code ? "复制完整激活码" : item.status === "unused" ? "重新生成旧激活码并复制" : "查看旧授权复制说明"}><Copy size={16} />{busy === item.id ? "复制中" : "复制"}</button><button type="button" className="button small danger" disabled={Boolean(busy) || item.status === "revoked"} onClick={() => revoke(item)}>停用</button></div></article>)}</div>
    {!items.length && <EmptyState icon={Key} title={busy === "load" ? "正在读取授权" : "暂无授权记录"} text="在上方输入数量，生成第一批设备激活码。" />}
  </section>;
}

export function AdminPage({ user, openAuth }) {
  const [active, setActive] = useState(() => {
    const section = new URLSearchParams(window.location.search).get("section");
    return menu.some((item) => item.id === section) ? section : "dashboard";
  });
  function selectSection(section) {
    setActive(section);
    const url = new URL(window.location.href);
    if (section === "dashboard") url.searchParams.delete("section");
    else url.searchParams.set("section", section);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
  if (!user) return <main id="main-content" className="admin-gate section-shell"><LockKey size={38} /><h1>登录管理员账号</h1><p>管理员后台已接入 Chandler 统一身份，只接受 Chandler 返回的管理员角色。</p><button className="button primary" onClick={() => openAuth("login")}>登录继续</button></main>;
  if (user.role !== "admin") return <main id="main-content" className="admin-gate section-shell"><ShieldCheck size={38} /><h1>当前账号没有后台权限</h1><p>请让 Chandler 平台管理员授予此账号管理员角色后重新登录。</p></main>;
  return <main id="main-content" className="admin-page"><aside className="admin-sidebar"><div><span>GULONG CONSOLE</span><h1>管理员后台</h1><p>{user.displayName || user.username || user.email}</p></div><nav>{menu.map((item) => { const Icon = item.icon; return <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => selectSection(item.id)}><Icon size={19} weight={active === item.id ? "fill" : "regular"} /> {item.label}</button>; })}</nav><footer><UsersThree size={18} /><span>Chandler 统一账号</span></footer></aside><div className="admin-content">{active === "dashboard" && <AdminDashboard />}{active === "users" && <ChandlerUserManager />}{active === "prices" && <ChandlerPriceManager />}{active === "tokens" && <PearTokenManager />}{active === "activations" && <ActivationCodeManager />}{active === "partners" && <PartnerManager />}{active === "workflows" && <WorkflowManager />}{active === "brain" && <BrainAttachmentManager />}{active === "versions" && <VersionManager />}{active === "payments" && <PaymentManager />}{active === "h3tasks" && <H3TaskManager />}{active === "worker" && <WorkerReviewManager />}{active === "feedback" && <FeedbackManager />}</div></main>;
}
