import { ArrowRight, MagnifyingGlass, Sparkle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api.js";

export function WorkflowCard({ workflow, navigate }) {
  const external = /^https?:\/\//i.test(workflow.url);
  function open() {
    if (external) window.open(workflow.url, "_blank", "noopener,noreferrer");
    else navigate(workflow.url);
  }
  return (
    <article className="public-workflow-card">
      <div className="public-workflow-image"><img src={workflow.imageUrl} alt={`${workflow.name}工作流图标`} /></div>
      <div><span>READY-TO-USE WORKFLOW</span><h3>{workflow.name}</h3><p>{workflow.description}</p></div>
      <button className="button secondary full" type="button" onClick={open}>打开工作流 <ArrowRight size={18} /></button>
    </article>
  );
}

export function WorkflowPage({ navigate }) {
  const [query, setQuery] = useState("");
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(event) {
    event?.preventDefault();
    setLoading(true); setError("");
    try {
      const result = await apiFetch(`/api/workflows?q=${encodeURIComponent(query.trim())}`);
      setWorkflows(result.workflows || []);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <main id="main-content" className="workflow-catalog-page">
      <section className="workflow-catalog-hero section-shell">
        <div><span>GULONG WORKFLOW LIBRARY</span><h1>把成熟能力，变成一键可用的工作流</h1><p>从任务发布到内容生产，每个工作流都封装了清晰入口与可复用能力。搜索目标，直接开始。</p></div>
        <img src="/assets/workflow-worker-v1.png" alt="古龙工作流能力网络" />
      </section>
      <section className="workflow-catalog section-shell">
        <form className="workflow-search" onSubmit={load} role="search">
          <MagnifyingGlass size={23} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作流名称或功能，例如：威客、任务、交付" aria-label="搜索工作流" />
          <button className="button primary" disabled={loading}>搜索工作流</button>
        </form>
        <header><div><span>WORKFLOW CATALOG</span><h2>{query ? `“${query}”的搜索结果` : "全部工作流"}</h2></div><strong>{workflows.length} 个可用能力</strong></header>
        {error && <div className="page-error">{error}</div>}
        {!loading && workflows.length === 0 ? <div className="workflow-empty"><Sparkle size={34} /><h3>没有找到匹配的工作流</h3><p>换一个更简短的关键词，或清空后查看全部。</p></div> : <div className="public-workflow-grid">{workflows.map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} navigate={navigate} />)}</div>}
      </section>
    </main>
  );
}

const SHORT_DRAMA_ORIGIN = "https://aipdd-drameclaw-new.vercel.app";

export function ShortDramaPage({ user, authResolved, openAuth }) {
  const frameRef = useRef(null);
  const issueInFlightRef = useRef(null);
  const pendingAuthModeRef = useRef(null);
  const queryAuthHandledRef = useRef(false);
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState("");

  const sendSso = useCallback((target = frameRef.current?.contentWindow) => {
    if (!user?.id || !target) return Promise.resolve();
    if (issueInFlightRef.current) return issueInFlightRef.current;
    const request = apiFetch("/api/auth/short-drama-sso", { method: "POST" })
      .then((result) => {
        target.postMessage({ type: "gulong:sso", token: result.token }, SHORT_DRAMA_ORIGIN);
        setError("");
      })
      .catch((reason) => setError(reason.message || "短剧账号授权失败，请重试"))
      .finally(() => { issueInFlightRef.current = null; });
    issueInFlightRef.current = request;
    return request;
  }, [user?.id]);

  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== SHORT_DRAMA_ORIGIN) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === "dramaclaw:ready") {
        setFrameReady(true);
        if (user?.id) void sendSso(event.source);
      } else if (event.data?.type === "dramaclaw:auth-request") {
        if (user?.id) void sendSso(event.source);
        else {
          const mode = event.data.mode === "register" ? "register" : "login";
          if (authResolved) openAuth(mode);
          else pendingAuthModeRef.current = mode;
        }
      } else if (event.data?.type === "dramaclaw:sso-error") {
        setError(event.data.message || "短剧账号授权失败，请重试");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [authResolved, openAuth, sendSso, user?.id]);

  useEffect(() => {
    if (frameReady && user?.id) void sendSso();
  }, [frameReady, sendSso, user?.id]);

  useEffect(() => {
    const pendingMode = pendingAuthModeRef.current;
    if (!pendingMode) return;
    if (user?.id) void sendSso();
    else if (authResolved) openAuth(pendingMode);
    if (user?.id || authResolved) pendingAuthModeRef.current = null;
  }, [authResolved, openAuth, sendSso, user?.id]);

  useEffect(() => {
    if (!authResolved || queryAuthHandledRef.current) return;
    const mode = new URLSearchParams(window.location.search).get("auth");
    if (mode !== "login" && mode !== "register") return;
    queryAuthHandledRef.current = true;
    if (!user?.id) openAuth(mode);
  }, [authResolved, openAuth, user?.id]);

  return (
    <main id="main-content" className="short-drama-page">
      <section className="short-drama-embed-shell">
        <div className="short-drama-embed-bar section-shell">
          <div><span>GULONG SHORT DRAMA</span><strong>短剧生产站</strong></div>
          {user ? <small>{`已使用古龙账号：${user.displayName || user.username || "用户"}`}</small> : null}
        </div>
        {error && <div className="short-drama-embed-error" role="alert">{error}</div>}
        <iframe
          ref={frameRef}
          className="short-drama-frame"
          src={`${SHORT_DRAMA_ORIGIN}/embed.html`}
          title="古龙短剧生产站"
          allow="autoplay; fullscreen; clipboard-read; clipboard-write"
          loading="eager"
          fetchPriority="high"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </section>
    </main>
  );
}
