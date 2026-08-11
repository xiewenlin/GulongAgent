import { ArrowRight, MagnifyingGlass, Sparkle, VideoCamera } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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

export function ShortDramaPage() {
  return (
    <main id="main-content" className="short-drama-page">
      <section className="short-drama-placeholder section-shell">
        <div className="short-drama-orb"><VideoCamera size={54} weight="duotone" /></div>
        <span>GULONG SHORT DRAMA</span>
        <h1>短剧创作能力，正在精心打磨</h1>
        <p>从剧本、分镜、角色一致性到配音与成片，我们正在构建一条真正可交付的 AI 短剧生产线。功能上线前，这里暂不开放操作。</p>
        <div><Sparkle size={20} /> 即将开放，敬请期待</div>
      </section>
    </main>
  );
}
