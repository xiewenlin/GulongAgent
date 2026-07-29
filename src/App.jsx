import {
  ArrowRight,
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
import { useEffect, useState } from "react";
import { apiFetch, trackAnalyticsEvent } from "./api.js";
import { AccountModal } from "./components/AccountModal.jsx";
import { AccountDashboard } from "./components/AccountDashboard.jsx";
import { AdminPage } from "./components/AdminPage.jsx";
import { HomePage } from "./components/HomePage.jsx";
import { ProductManualPage } from "./components/ProductManualPage.jsx";
import { SecondBrainPage } from "./components/SecondBrainPage.jsx";
import {
  BrainUploadPage,
  DeveloperPage,
  DownloadPage,
  FeedbackPage,
  MockPaymentPage,
  PricingPage,
} from "./components/PlatformPages.jsx";
import { themes } from "./data/site.js";

const primaryNav = [
  ["产品能力", "/manual"],
  ["第二大脑", "/brain"],
  ["开发者", "/developer"],
  ["定价", "/pricing"],
  ["下载", "/download"],
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
    apiFetch("/api/auth/me").then((result) => setUser(result.user)).catch(() => setUser(null));
  }, []);

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
  else if (pathname === "/account") page = <AccountDashboard user={user} openAuth={openAuth} navigate={navigate} onUser={setUser} />;
  else if (pathname === "/manual") page = <ProductManualPage navigate={navigate} />;
  else if (pathname === "/brain") page = <SecondBrainPage user={user} openAuth={openAuth} navigate={navigate} />;
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
      <header className="site-header">
        <div className="header-inner section-shell">
          <button className="brand" type="button" onClick={() => navigate("/")} aria-label="古龙首页">
            <img key={`brand-${activeTheme.id}`} src={themeIcon} alt="" />
            <span><strong>古龙</strong><small>Gulong Agent Engine</small></span>
          </button>
          <nav className={mobileOpen ? "primary-nav open" : "primary-nav"} aria-label="主要导航">
            {primaryNav.map(([label, href]) => <button className={pathname === href.split("#")[0] && (!href.includes("#") || window.location.hash === `#${href.split("#")[1]}`) ? "active" : ""} type="button" key={href} onClick={() => navigate(href)}>{label}</button>)}
            <button className="mobile-feedback" type="button" onClick={() => navigate("/feedback")}>问题反馈</button>
          </nav>
          <div className="header-actions">
            <button className="theme-button" type="button" aria-label="自定义主题" onClick={() => setThemeOpen(true)}><Palette size={18} /></button>
            {user ? (
              <div className="account-menu-wrap">
                <button className="account-trigger" type="button" onClick={() => setAccountOpen(!accountOpen)}><UserCircle size={21} /><span>{user.displayName || user.username || "古龙用户"}</span><CaretDown size={14} /></button>
                {accountOpen && <div className="account-menu"><button onClick={() => navigate("/account")}><UserCircle size={17} /> 用户后台</button>{user.role === "admin" && <button onClick={() => navigate("/admin")}><GearSix size={17} /> 管理员后台</button>}<button onClick={() => navigate("/developer")}><Key size={17} /> API Key</button><button onClick={() => navigate("/upload")}><UploadSimple size={17} /> 第二大脑上传</button><button onClick={() => navigate("/feedback")}><ChatCircleText size={17} /> 问题反馈</button><button className="danger" onClick={logout}><SignOut size={17} /> 退出登录</button></div>}
              </div>
            ) : <button className="login-button" type="button" onClick={() => openAuth("login")}><SignIn size={17} /> 登录</button>}
            <button className="button primary header-download" type="button" onClick={downloadLatest}><DownloadSimple size={17} /> 下载 Windows 版</button>
            <button className="mobile-menu" type="button" aria-label={mobileOpen ? "关闭菜单" : "打开菜单"} onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X size={22} /> : <List size={22} />}</button>
          </div>
        </div>
      </header>

      {page}

      <footer className="site-footer">
        <div className="footer-main section-shell">
          <div className="footer-brand"><img src={themeIcon} alt="" /><div><strong>古龙</strong><span>Gulong Agent Engine</span></div><p>不是又一个聊天机器人，而是一套会持续成长的 AI 操作系统。</p></div>
          <div><h3>产品</h3><button onClick={() => navigate("/manual")}>产品手册</button><button onClick={() => navigate("/brain")}>第二大脑</button><button onClick={() => navigate("/pricing")}>订阅与定价</button></div>
          <div><h3>开发者</h3><button onClick={() => navigate("/developer")}>开放平台</button><a href="/api/docs" target="_blank" rel="noreferrer">API 文档</a><a href="/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI JSON</a></div>
          <div><h3>支持</h3><button onClick={() => navigate("/download")}>软件下载</button><button onClick={() => navigate("/feedback")}>问题反馈</button><button onClick={() => setThemeOpen(true)}>自定义主题</button></div>
        </div>
        <div className="footer-bottom section-shell"><span>© 2026 古龙 Gulong Agent Engine</span><span>AI 智能体 · 非自然人</span><div><a href="#privacy">隐私政策</a><a href="#terms">服务条款</a></div></div>
      </footer>

      <button className="floating-feedback" type="button" onClick={() => navigate("/feedback")}><ChatCircleText size={20} /><span>反馈</span></button>

      <AccountModal open={authOpen} initialMode={authMode} onClose={() => setAuthOpen(false)} onUser={setUser} themeIcon={themeIcon} />
      {themeOpen && (
        <div className="theme-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setThemeOpen(false)}>
          <aside className="theme-drawer"><button className="modal-close" onClick={() => setThemeOpen(false)}><X size={19} /></button><span>PERSONALIZE</span><h2>选择你的古龙主题</h2><p>主题保存在当前浏览器，不会影响账户数据与功能。</p><div className="theme-options">{themes.map((item) => <button type="button" key={item.id} className={theme === item.id ? "active" : ""} onClick={() => setTheme(item.id)}><span className="theme-swatches">{item.colors.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><strong>{item.name}</strong>{theme === item.id && <CheckCircle size={18} weight="fill" />}</button>)}</div><button className="button secondary full" onClick={() => setThemeOpen(false)}>完成设置 <ArrowRight size={16} /></button></aside>
        </div>
      )}
    </div>
  );
}
