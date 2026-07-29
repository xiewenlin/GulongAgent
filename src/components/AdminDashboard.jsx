import {
  ArrowClockwise,
  ArrowDownRight,
  ArrowUpRight,
  Brain,
  ChartLineUp,
  CheckCircle,
  CurrencyCny,
  Database,
  DownloadSimple,
  Funnel,
  GlobeHemisphereWest,
  Lightning,
  Pulse,
  Sparkle,
  UserPlus,
  UsersThree,
  Wallet,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, formatMoney } from "../api.js";

const sourceLabels = { DIRECT: "直接访问", SEARCH: "搜索引擎", SOCIAL: "社交媒体", REFERRAL: "外部推荐", CAMPAIGN: "营销活动" };
const deviceLabels = { DESKTOP: "桌面端", MOBILE: "移动端", TABLET: "平板" };
const kindLabels = { subscription: "在线会员", recharge: "账户充值", offline_subscription: "线下会员", other: "其他" };
const providerLabels = { wechat: "微信支付", alipay: "支付宝", offline: "线下支付", other: "其他" };
const cycleLabels = { month: "按月订阅", year: "按年订阅", other: "其他周期" };
const workflowLabels = { "smart-assembly": "智能任务组装", "second-brain-analysis": "第二大脑分析", "short-drama-studio": "短剧创作工作台" };
const taskStatusLabels = { queued: "排队中", running: "执行中", completed: "已完成", failed: "失败" };
const brainStatusLabels = { uploading: "上传中", queued_for_analysis: "待分析", analyzing: "分析中", completed: "已完成", failed: "失败" };

function number(value) {
  return new Intl.NumberFormat("zh-CN", { notation: Number(value) >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function percent(value) {
  return `${Number(value || 0).toFixed(1).replace(".0", "")}%`;
}

function Delta({ value }) {
  if (value == null) return <span className="gdx-delta neutral">暂无对比</span>;
  const positive = value >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return <span className={`gdx-delta ${positive ? "positive" : "negative"}`}><Icon size={12} weight="bold" /> {Math.abs(value)}%</span>;
}

function KpiCard({ icon: Icon, label, value, delta, note, money = false, accent = "jade" }) {
  return <article className={`gdx-kpi ${accent}`}><header><span><Icon size={18} weight="duotone" /></span><Delta value={delta} /></header><strong>{money ? formatMoney(value) : number(value)}</strong><h3>{label}</h3><p>{note}</p></article>;
}

function Distribution({ rows, labelKey, valueKey = "visitors", labels = {}, empty = "等待采集数据" }) {
  const total = rows.reduce((sum, row) => sum + Number(row[valueKey] || 0), 0);
  const maximum = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  if (!rows.length) return <div className="gdx-mini-empty">{empty}</div>;
  return <div className="gdx-distribution">{rows.map((row, index) => {
    const key = row[labelKey] || "other";
    const value = Number(row[valueKey] || 0);
    return <div key={`${key}-${index}`}><header><span>{labels[key] || key}</span><strong>{number(value)} <small>{total ? percent(value / total * 100) : "0%"}</small></strong></header><i><b style={{ width: `${value / maximum * 100}%` }} /></i></div>;
  })}</div>;
}

function Panel({ eyebrow, title, action, children, className = "" }) {
  return <section className={`gdx-panel ${className}`}><header className="gdx-panel-head"><div><span>{eyebrow}</span><h3>{title}</h3></div>{action}</header>{children}</section>;
}

function TrendChart({ trend }) {
  const visible = useMemo(() => {
    if (trend.length <= 31) return trend;
    const step = Math.ceil(trend.length / 30);
    return trend.filter((_, index) => index % step === 0 || index === trend.length - 1);
  }, [trend]);
  const revenueMax = Math.max(1, ...visible.map((row) => Number(row.revenueFen || 0)));
  const userMax = Math.max(1, ...visible.map((row) => Math.max(Number(row.activeUsers || 0), Number(row.registrations || 0))));
  return <div className="gdx-trend"><div className="gdx-trend-legend"><span><i className="revenue" /> 已确认收入</span><span><i className="active" /> 活跃用户</span><span><i className="register" /> 新增注册</span></div><div className="gdx-trend-plot">{visible.map((row, index) => <div className="gdx-trend-day" key={row.date} title={`${row.date}\n收入 ${formatMoney(row.revenueFen)}\n活跃 ${row.activeUsers || 0}\n注册 ${row.registrations || 0}`}><div className="gdx-user-bars"><i className="active" style={{ height: `${Math.max(2, Number(row.activeUsers || 0) / userMax * 100)}%` }} /><i className="register" style={{ height: `${Math.max(2, Number(row.registrations || 0) / userMax * 100)}%` }} /></div><i className="gdx-revenue-bar" style={{ height: `${Math.max(2, Number(row.revenueFen || 0) / revenueMax * 100)}%` }} /><span>{index === 0 || index === visible.length - 1 || index % Math.ceil(visible.length / 5) === 0 ? row.date.slice(5) : ""}</span></div>)}</div></div>;
}

function Lifecycle({ rows }) {
  const first = Math.max(1, Number(rows[0]?.value || 0));
  return <div className="gdx-funnel">{rows.map((row, index) => {
    const width = Math.max(20, Number(row.value || 0) / first * 100);
    const previous = index ? Number(rows[index - 1]?.value || 0) : first;
    return <div key={row.key}><header><span>{index + 1}</span><strong>{row.label}</strong><b>{number(row.value)}</b><small>{index ? `${percent(Number(row.value || 0) / Math.max(1, previous) * 100)} 到达` : "周期新用户"}</small></header><i><b style={{ width: `${width}%` }} /></i></div>;
  })}</div>;
}

export function AdminDashboard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async ({ quiet = false } = {}) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      setData(await apiFetch(`/api/admin/analytics/dashboard?days=${days}`));
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [days]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load({ quiet: true }), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading && !data) return <section className="gdx-loading"><Pulse size={34} /><strong>正在汇总古龙实时经营数据</strong><p>用户、收入、第二大脑与智能体任务将统一换算为北京时间口径。</p></section>;
  if (error && !data) return <section className="gdx-loading error"><WarningCircle size={34} /><strong>数据看板暂时无法加载</strong><p>{error}</p><button className="button secondary" onClick={() => load()}>重新加载</button></section>;

  const { today = {}, period = {}, comparisons = {}, scale = {}, revenue = {}, operations = {} } = data || {};
  const activeMemberRate = scale.totalUsers ? scale.activeMembers / scale.totalUsers * 100 : 0;
  const featureMaximum = Math.max(1, ...(data.featureAdoption || []).map((item) => Number(item.users || 0)));

  return <section className="gdx-dashboard">
    <header className="gdx-hero">
      <div className="gdx-hero-main"><span className="gdx-live"><i /> LIVE BUSINESS INTELLIGENCE</span><p>今日已确认收入</p><h2>{formatMoney(today.revenueFen)}</h2><div className="gdx-hero-today"><span><strong>{number(today.registrations)}</strong> 新增用户</span><span><strong>{number(today.activeUsers)}</strong> 活跃用户</span><span><strong>{number(today.tasks)}</strong> 智能体任务</span><span><strong>{number(today.brainUploads)}</strong> 第二大脑</span></div></div>
      <div className="gdx-hero-side"><div className="gdx-toolbar"><div>{[7, 30, 90].map((value) => <button className={days === value ? "active" : ""} key={value} onClick={() => setDays(value)}>{value} 天</button>)}</div><button className="gdx-refresh" disabled={refreshing} onClick={() => load({ quiet: true })} aria-label="刷新数据"><ArrowClockwise className={refreshing ? "spinning" : ""} size={17} /></button></div><dl><div><dt>用户活跃率</dt><dd>{percent(period.activeRate)}</dd></div><div><dt>活跃付费转化</dt><dd>{percent(period.paidConversionRate)}</dd></div><div><dt>每付费用户收入</dt><dd>{formatMoney(period.averageRevenuePerPayerFen)}</dd></div><div><dt>访问下载转化</dt><dd>{percent(period.downloadConversionRate)}</dd></div></dl><small>每 60 秒自动刷新 · 最近更新 {new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</small></div>
    </header>

    {error && <div className="gdx-inline-error"><WarningCircle size={16} /> 自动刷新失败，当前仍显示最近一次成功数据：{error}</div>}

    <div className="gdx-kpi-grid">
      <KpiCard icon={UserPlus} label="新增用户" value={period.registrations} delta={comparisons.registrations} note={`对比前 ${days} 天`} />
      <KpiCard icon={UsersThree} label="活跃用户" value={period.activeUsers} delta={comparisons.activeUsers} note={`${number(period.sessions)} 次有效会话`} accent="blue" />
      <KpiCard icon={GlobeHemisphereWest} label="独立访客" value={period.visitors} delta={comparisons.visitors} note={`${number(period.pageViews)} 次页面浏览`} accent="violet" />
      <KpiCard icon={CurrencyCny} label="已确认收入" value={period.revenueFen} delta={comparisons.revenue} note={`${number(period.paidOrders)} 笔到账订单`} money accent="gold" />
      <KpiCard icon={Lightning} label="智能体任务" value={period.tasks} delta={comparisons.tasks} note={`${number(period.taskUsers)} 位任务用户`} />
      <KpiCard icon={Brain} label="第二大脑提交" value={period.brainUploads} delta={comparisons.brainUploads} note={`${number(period.brainUsers)} 位贡献用户`} accent="blue" />
      <KpiCard icon={DownloadSimple} label="软件下载" value={period.downloads} delta={comparisons.downloads} note={`${percent(period.downloadConversionRate)} 访问转化`} accent="violet" />
      <KpiCard icon={Wallet} label="新增订阅" value={period.subscriptions} delta={comparisons.subscriptions} note={`${number(scale.activeMembers)} 位有效会员`} accent="gold" />
    </div>

    <section className="gdx-scale"><header><Database size={20} /><div><span>PLATFORM SCALE</span><strong>古龙平台累计规模</strong></div></header><dl><div><dt>注册用户</dt><dd>{number(scale.totalUsers)}</dd></div><div><dt>有效会员</dt><dd>{number(scale.activeMembers)}<small>{percent(activeMemberRate)}</small></dd></div><div><dt>MiniMax 已配置</dt><dd>{number(scale.minimaxConfiguredUsers)}</dd></div><div><dt>API 开发者</dt><dd>{number(scale.apiDevelopers)}</dd></div><div><dt>第二大脑贡献者</dt><dd>{number(scale.brainContributors)}</dd></div><div><dt>累计任务</dt><dd>{number(scale.totalTasks)}</dd></div></dl></section>

    <div className="gdx-layout gdx-primary-layout">
      <Panel eyebrow="GROWTH & REVENUE" title={`${days} 天增长与收入趋势`} className="gdx-span-2" action={<span className="gdx-badge">北京时间</span>}><TrendChart trend={data.trend || []} /></Panel>
      <Panel eyebrow="NEW USER JOURNEY" title="新用户激活漏斗" action={<Funnel size={19} />}><Lifecycle rows={data.lifecycle || []} /></Panel>
    </div>

    <div className="gdx-layout">
      <Panel eyebrow="REVENUE QUALITY" title="收入质量与结构" className="gdx-span-2">
        <div className="gdx-revenue-summary"><article><span>已确认到账</span><strong>{formatMoney(revenue.confirmedFen)}</strong><small>仅计入支付成功或人工审核通过</small></article><article className="pending"><span>待支付 / 待审核</span><strong>{formatMoney(revenue.pendingFen)}</strong><small>{number(revenue.pendingOrders)} 笔，未计入收入</small></article></div>
        <div className="gdx-revenue-groups"><div><h4>收入类型</h4><Distribution rows={revenue.kinds || []} labelKey="kind" valueKey="amountFen" labels={kindLabels} /></div><div><h4>支付渠道</h4><Distribution rows={revenue.providers || []} labelKey="provider" valueKey="amountFen" labels={providerLabels} /></div><div><h4>订阅周期</h4><Distribution rows={revenue.billingCycles || []} labelKey="cycle" valueKey="amountFen" labels={cycleLabels} empty="当前周期暂无在线订阅收入" /></div></div>
      </Panel>
      <Panel eyebrow="FEATURE ADOPTION" title="核心能力采用">
        <div className="gdx-features">{(data.featureAdoption || []).map((item) => <article key={item.key}><div><span>{item.label}</span><strong>{number(item.users)} <small>位用户</small></strong></div><i><b style={{ width: `${Number(item.users || 0) / featureMaximum * 100}%` }} /></i><small>累计 {number(item.total)} 次 / 项</small></article>)}</div>
      </Panel>
    </div>

    <div className="gdx-layout gdx-three">
      <Panel eyebrow="ACQUISITION" title="用户来源"><Distribution rows={data.acquisition?.trafficSources || []} labelKey="source" labels={sourceLabels} /></Panel>
      <Panel eyebrow="DEVICE MIX" title="访问设备"><Distribution rows={data.acquisition?.devices || []} labelKey="device" labels={deviceLabels} /></Panel>
      <Panel eyebrow="TOP CONTENT" title="热门页面"><Distribution rows={data.acquisition?.topPages || []} labelKey="path" valueKey="views" /></Panel>
    </div>

    <div className="gdx-layout gdx-three">
      <Panel eyebrow="AGENT WORKFLOWS" title="智能体工作流排行"><Distribution rows={data.workflows || []} labelKey="workflowId" valueKey="tasks" labels={workflowLabels} empty="暂无智能体任务数据" /></Panel>
      <Panel eyebrow="TASK HEALTH" title="任务执行状态"><Distribution rows={data.taskStatuses || []} labelKey="status" valueKey="count" labels={taskStatusLabels} empty="暂无任务状态数据" /></Panel>
      <Panel eyebrow="SECOND BRAIN" title="知识处理队列"><Distribution rows={data.brainStatuses || []} labelKey="status" valueKey="count" labels={brainStatusLabels} empty="暂无第二大脑文件" /></Panel>
    </div>

    <section className="gdx-operations"><header><div><span>OPERATIONS RADAR</span><h3>实时运营健康度</h3></div><Pulse size={24} weight="duotone" /></header><div><article className={operations.brainBacklog ? "attention" : "healthy"}><Brain size={21} /><span>第二大脑待处理</span><strong>{number(operations.brainBacklog)}</strong></article><article className={operations.openFeedback ? "attention" : "healthy"}><WarningCircle size={21} /><span>未解决反馈</span><strong>{number(operations.openFeedback)}</strong></article><article className={operations.failedReleaseJobs ? "danger" : "healthy"}><Lightning size={21} /><span>失败发版任务</span><strong>{number(operations.failedReleaseJobs)}</strong></article><article className="healthy"><CheckCircle size={21} /><span>有效发行渠道</span><strong>{number(operations.activeReleaseChannels)}</strong></article></div></section>

    <section className="gdx-insights"><header><Sparkle size={22} weight="fill" /><div><span>AI EXECUTIVE BRIEF</span><h3>经营洞察速报</h3></div></header><div>{(data.insights || []).map((item, index) => <article className={item.tone} key={`${item.title}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.title}</strong><p>{item.detail}</p></div><ChartLineUp size={20} /></article>)}</div></section>
  </section>;
}
