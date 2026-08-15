import {
  ArrowRight,
  Bell,
  CaretDown,
  ChatCircleText,
  CheckCircle,
  DownloadSimple,
  GearSix,
  Key,
  List,
  Palette,
  SignIn,
  SignOut,
  UploadSimple,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { apiFetch, trackAnalyticsEvent } from "./api.js";
import { AccountModal } from "./components/AccountModal.jsx";
import { AccountDashboard } from "./components/AccountDashboard.jsx";
import { AdminPage } from "./components/AdminPage.jsx";
import { HomePage } from "./components/HomePage.jsx";
import { ProductManualPage } from "./components/ProductManualPage.jsx";
import { SecondBrainPage } from "./components/SecondBrainPage.jsx";
import { SubscriptionReminderDialog } from "./components/SubscriptionReminderDialog.jsx";
import { WorkerPage } from "./components/WorkerPages.jsx";
import { ShortDramaPage, WorkflowPage } from "./components/WorkflowPages.jsx";
import {
  BrainUploadPage,
  DeveloperPage,
  DownloadPage,
  FeedbackPage,
  MockPaymentPage,
  PricingPage,
} from "./components/PlatformPages.jsx";
import { themes } from "./data/site.js";

const WebAgentPage = lazy(() => import("./components/WebAgentPage.jsx").then((module) => ({ default: module.WebAgentPage })));

const SHORT_DRAMA_ROUTE = "/short-drama";

const primaryNav = [
  { label: "产品能力", href: "/manual" },
  { label: "第二大脑", href: "/brain" },
  { label: "短剧", href: SHORT_DRAMA_ROUTE },
  { label: "工作流", href: "/workflows" },
  { label: "定价", href: "/pricing" },
  { label: "下载", href: "/download" },
  { label: "吐槽", href: "/feedback" },
];

const THEME_ICON_VERSION = "20260728-3d-favicon-1";

function themeIconUrl(theme) {
  return `${theme.icon}?theme=${theme.id}&v=${THEME_ICON_VERSION}`;
}

function currentRoute() {
  return window.location.pathname + window.location.search + window.location.hash;
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [user, setUser] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [themeOpen, setThemeOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [subscriptionLifecycle, setSubscriptionLifecycle] = useState(null);
  const [renewalOpen, setRenewalOpen] = useState(false);
  const [theme, setTheme] = useState(() => window.localStorage.getItem("gulong-web-theme") || "porcelain");
  const activeTheme = themes.find((item) => item.id === theme) || themes[0];
  const themeIcon = themeIconUrl(activeTheme);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("gulong-web-theme", theme);

    let themeColor = document.querySelector('meta[name="theme-color"]');
    if (!themeColor) {
      themeColor = document.createElement("meta");
      themeColor.name = "theme-color";
      document.head.appendChild(themeColor);
    }
    themeColor.content = activeTheme.colors[0];
  }, [activeTheme, theme]);

  useEffect(() => {
    let cancelled = false;
    const source = new Image();

    function installFavicon(href) {
      if (cancelled) return;
      document.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove());
      const favicon = document.createElement("link");
      favicon.rel = "icon";
      favicon.type = "image/png";
      favicon.sizes = "64x64";
      favicon.href = href;
      favicon.dataset.theme = activeTheme.id;
      document.head.appendChild(favicon);
    }

    source.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, 64, 64);
      context.drawImage(source, 0, 0, 64, 64);
      installFavicon(canvas.toDataURL("image/png"));
    };
    source.onerror = () => installFavicon(themeIcon);
    source.src = themeIcon;

    return () => {
      cancelled = true;
    };
  }, [activeTheme.id, themeIcon]);

  useEffect(() => {
    const preloadLinks = [];
    const preloadThemes = () => {
      themes.forEach((item) => {
        if (item.id === activeTheme.id) return;
        const preload = document.createElement("link");
        preload.rel = "preload";
        preload.as = "image";
        preload.href = themeIconUrl(item);
        preload.fetchPriority = "low";
        preload.dataset.themePreload = item.id;
        document.head.appendChild(preload);
        preloadLinks.push(preload);
      });
    };

    const idleId = "requestIdleCallback" in window
      ? window.requestIdleCallback(preloadThemes, { timeout: 1500 })
      : window.setTimeout(preloadThemes, 250);

    return () => {
      if ("cancelIdleCallback" in window) window.cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
      preloadLinks.forEach((link) => link.remove());
    };
  }, []);

  useEffect(() => {
    apiFetch("/api/auth/me").then((result) => { setUser(result.user); setSubscriptionLifecycle(result.subscriptionLifecycle || null); }).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) { setSubscriptionLifecycle(null); setRenewalOpen(false); return; }
    apiFetch("/api/billing/subscription").then((result) => {
      const lifecycle = result.subscriptionLifecycle || null;
      setSubscriptionLifecycle(lifecycle);
      if (!lifecycle || (!lifecycle.restricted && !lifecycle.renewalDue)) return;
      const reminderKey = `gulong-renewal-reminder-${new Date().toISOString().slice(0, 10)}`;
      if (lifecycle.restricted || window.localStorage.getItem(reminderKey) !== "dismissed") setRenewalOpen(true);
    }).catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    if (!user) { setNotificationCount(0); return undefined; }
    let cancelled = false;
    const refresh = () => apiFetch("/api/account/notifications").then((result) => { if (!cancelled) setNotificationCount(result.unread || 0); }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 45_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [user?.id, route]);

  useEffect(() => {
    setMobileOpen(false);
    setAccountOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
    trackAnalyticsEvent("PAGE_VIEW", { path: `${window.location.pathname}${window.location.search}` });
    const hash = window.location.hash;
    if (hash) setTimeout(() => document.querySelector(hash)?.scrollIntoView({ behavior: "smooth" }), 20);
  }, [route]);

  function navigate(to) {
    if (to.startsWith("http")) return window.location.assign(to);
    if (subscriptionLifecycle?.restricted && ["/agent", "/brain", "/upload"].some((path) => to.startsWith(path))) {
      setRenewalOpen(true);
      return;
    }
    window.history.pushState({}, "", to);
    setRoute(currentRoute());
    if (window.location.hash) {
      window.setTimeout(() => document.querySelector(window.location.hash)?.scrollIntoView({ behavior: "smooth" }), 20);
    }
  }

  function openAuth(mode = "login") {
    setAuthMode(mode);
    setAuthOpen(true);
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setAccountOpen(false);
  }

  async function downloadLatest() {
    trackAnalyticsEvent("DOWNLOAD_CLICK");
    try {
      const latest = await apiFetch("/api/releases/latest");
      if (!latest.release?.channelId) return navigate("/download");
      const result = await apiFetch(`/api/releases/${latest.release.channelId}/download`);
      window.location.assign(result.url);
    } catch {
      navigate("/download");
    }
  }

  const pathname = window.location.pathname;
  let page;
  if (pathname === "/admin") page = <AdminPage user={user} openAuth={openAuth} />;
  else if (pathname === "/agent") page = <Suspense fallback={<main id="main-content" className="web-agent-page web-agent-gate section-shell"><span>GULONG WEB AGENT</span><h1>正在打开古龙网页版</h1><p>正在加载对话排版与实时流程组件…</p></main>}><WebAgentPage user={user} openAuth={openAuth} navigate={navigate} themeIcon={themeIcon} /></Suspense>;
  else if (pathname === "/account") page = <AccountDashboard user={user} openAuth={openAuth} navigate={navigate} onUser={setUser} />;
  else if (pathname === "/manual") page = <ProductManualPage navigate={navigate} />;
  else if (pathname === "/brain") page = <SecondBrainPage user={user} openAuth={openAuth} navigate={navigate} />;
  else if (pathname === "/worker") page = <WorkerPage key={route} user={user} openAuth={openAuth} navigate={navigate} />;
  else if (pathname === "/workflows") page = <WorkflowPage navigate={navigate} />;
  else if (pathname === "/short-drama") page = <ShortDramaPage user={user} openAuth={openAuth} />;
  else if (pathname === "/download") page = <DownloadPage />;
  else if (pathname === "/developer") page = <DeveloperPage user={user} openAuth={openAuth} />;
  else if (pathname === "/pricing") page = <PricingPage user={user} openAuth={openAuth} navigate={navigate} />;
  else if (pathname === "/upload") page = <BrainUploadPage user={user} openAuth={openAuth} />;
  else if (pathname === "/feedback") page = <FeedbackPage user={user} />;
  else if (pathname === "/payment/mock") page = <MockPaymentPage user={user} navigate={navigate} />;
  else page = <HomePage navigate={navigate} openTheme={() => setThemeOpen(true)} themeIcon={themeIcon} downloadLatest={downloadLatest} />;

  return (
    <div className="site-app">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      {pathname !== "/agent" && <header className="site-header">
        <div className="header-inner section-shell">
          <button className="brand" type="button" onClick={() => navigate("/agent")} aria-label="进入古龙网页版 Agent">
            <img key={`brand-${activeTheme.id}`} src={themeIcon} alt="" />
            <span><strong>古龙</strong><small className="brand-web-entry">网页版入口</small></span>
          </button>
          <nav className={mobileOpen ? "primary-nav open" : "primary-nav"} aria-label="主要导航">
            {primaryNav.map((item) => <div className={`primary-nav-item ${pathname === item.href.split("?")[0] ? "active" : ""}`} key={item.href}><button type="button" onClick={() => navigate(item.href)}>{item.label}{item.children && <CaretDown size={15} />}</button>{item.children && <div className="primary-submenu">{item.children.map((child) => <button type="button" key={child.href} onClick={() => navigate(child.href)}>{child.label}<ArrowRight size={16} /></button>)}</div>}</div>)}
          </nav>
          <div className="header-actions">
            <button className="theme-button" type="button" aria-label="自定义主题" onClick={() => setThemeOpen(true)}><Palette size={18} /></button>
            {user ? (
              <div className="account-menu-wrap">
                <button className="header-notification" type="button" aria-label={`${notificationCount} 条未读消息`} onClick={() => navigate("/account")}><Bell size={21} weight={notificationCount ? "fill" : "regular"} />{notificationCount > 0 && <span>{notificationCount > 99 ? "99+" : notificationCount}</span>}</button>
                <button className="account-trigger" type="button" onClick={() => setAccountOpen(!accountOpen)}><UserCircle size={21} /><span>{user.displayName || user.username || "古龙用户"}</span><CaretDown size={14} /></button>
                {accountOpen && <div className="account-menu"><button onClick={() => navigate("/account")}><UserCircle size={17} /> 用户后台</button>{user.role === "admin" && <button onClick={() => navigate("/admin")}><GearSix size={17} /> 管理员后台</button>}<button onClick={() => navigate("/developer")}><Key size={17} /> API Key</button><button onClick={() => navigate("/upload")}><UploadSimple size={17} /> 第二大脑上传</button><button onClick={() => navigate("/feedback")}><ChatCircleText size={17} /> 问题反馈</button><button className="danger" onClick={logout}><SignOut size={17} /> 退出登录</button></div>}
              </div>
            ) : <button className="login-button" type="button" onClick={() => openAuth("login")}><SignIn size={17} /> 登录</button>}
            <button className="button primary header-download" type="button" onClick={downloadLatest}><DownloadSimple size={17} /> 下载 Windows 版</button>
            <button className="mobile-menu" type="button" aria-label={mobileOpen ? "关闭菜单" : "打开菜单"} onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X size={22} /> : <List size={22} />}</button>
          </div>
        </div>
      </header>}

      {page}

      {pathname !== "/agent" && <footer className="site-footer">
        <div className="footer-main section-shell">
          <div className="footer-brand"><img src={themeIcon} alt="" /><div><strong>古龙</strong><span>Gulong Agent Engine</span></div><p>不是又一个聊天机器人，而是一套会持续成长的 AI 操作系统。</p></div>
          <div><h3>产品</h3><button onClick={() => navigate("/manual")}>产品手册</button><button onClick={() => navigate("/brain")}>第二大脑</button><button onClick={() => navigate("/workflows")}>工作流</button><button onClick={() => navigate(SHORT_DRAMA_ROUTE)}>短剧</button><button onClick={() => navigate("/pricing")}>订阅与定价</button></div>
          <div><h3>开放能力</h3><button onClick={() => navigate("/developer")}>API Key</button><a href="/api/docs" target="_blank" rel="noreferrer">API 文档</a><a href="/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI JSON</a></div>
          <div><h3>支持</h3><button onClick={() => navigate("/download")}>软件下载</button><button onClick={() => navigate("/feedback")}>问题反馈</button><button onClick={() => setThemeOpen(true)}>自定义主题</button></div>
        </div>
        <div className="footer-bottom section-shell"><span>© 2026 古龙 Gulong Agent Engine</span><span>AI 智能体 · 非自然人</span><div><a href="#privacy">隐私政策</a><a href="#terms">服务条款</a></div></div>
      </footer>}

      {pathname !== "/agent" && <button className="floating-feedback" type="button" onClick={() => navigate("/feedback")}><ChatCircleText size={20} /><span>反馈</span></button>}

      <AccountModal open={authOpen} initialMode={authMode} onClose={() => setAuthOpen(false)} onUser={setUser} themeIcon={themeIcon} />
      {renewalOpen && subscriptionLifecycle && <SubscriptionReminderDialog lifecycle={subscriptionLifecycle} onRenew={() => { setRenewalOpen(false); navigate("/pricing"); }} onClose={() => { window.localStorage.setItem(`gulong-renewal-reminder-${new Date().toISOString().slice(0, 10)}`, "dismissed"); setRenewalOpen(false); }} />}
      {themeOpen && (
        <div className="theme-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setThemeOpen(false)}>
          <aside className="theme-drawer"><button className="modal-close" onClick={() => setThemeOpen(false)}><X size={19} /></button><span>PERSONALIZE</span><h2>选择你的古龙主题</h2><p>主题保存在当前浏览器，不会影响账户数据与功能。</p><div className="theme-options">{themes.map((item) => <button type="button" key={item.id} className={theme === item.id ? "active" : ""} onClick={() => setTheme(item.id)}><span className="theme-swatches">{item.colors.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><strong>{item.name}</strong>{theme === item.id && <CheckCircle size={18} weight="fill" />}</button>)}</div><button className="button secondary full" onClick={() => setThemeOpen(false)}>完成设置 <ArrowRight size={16} /></button></aside>
        </div>
      )}
    </div>
  );
}
