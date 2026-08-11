import {
  ArrowRight,
  Brain,
  CloudCheck,
  Code,
  Database,
  Devices,
  FlowArrow,
  HandCoins,
  PaperPlaneRight,
  Palette,
  PuzzlePiece,
  ShieldCheck,
  Sparkle,
  WindowsLogo,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { apiFetch } from "../api.js";
import { capabilities, workflowSteps } from "../data/site.js";
import { ProductDemo } from "./ProductDemo.jsx";
import { PartnerNetwork } from "./PartnerNetwork.jsx";
import { WorkflowCard } from "./WorkflowPages.jsx";

const iconMap = {
  route: FlowArrow,
  brain: Brain,
  market: PuzzlePiece,
  devices: Devices,
};

export function HomePage({ navigate, openTheme, themeIcon, downloadLatest }) {
  const [partners, setPartners] = useState([]);
  const [workflows, setWorkflows] = useState([]);

  useEffect(() => {
    apiFetch("/api/partners").then((result) => setPartners(result.partners || [])).catch(() => setPartners([]));
    apiFetch("/api/workflows").then((result) => setWorkflows(result.workflows || [])).catch(() => setWorkflows([]));
  }, []);

  return (
    <>
      <main id="main-content">
        <section className="hero section-shell">
          <div className="hero-ghost" aria-hidden="true"><img src={themeIcon} alt="" /></div>
          <div className="hero-copy">
            <div className="eyebrow"><Sparkle size={14} weight="fill" /> 本地优先的智能体操作系统</div>
            <h1><span>古龙</span> Gulong Agent Engine</h1>
            <h2>让每个人，都拥有自己的 <em>AI 团队</em></h2>
            <p>把目标交给古龙：它会自动选择最合适的模型，调用插件、技能与工作流，把执行经验沉淀进第二大脑，并让每一步都可追溯、可恢复、可持续。</p>
            <div className="hero-actions">
              <button className="button primary" type="button" onClick={downloadLatest}><WindowsLogo size={20} weight="fill" /> 下载 Windows 版</button>
              <button className="button secondary" type="button" onClick={() => navigate("/workflows")}><FlowArrow size={20} /> 探索工作流</button>
            </div>
            <div className="trust-row">
              <span><ShieldCheck size={18} /> 本地优先</span>
              <i />
              <span><CloudCheck size={18} /> 离线可用</span>
              <i />
              <span><Database size={18} /> 数据可控</span>
            </div>
          </div>
          <div className="hero-product">
            <div className="product-toolbar">
              <span>古龙 · 工作台</span>
              <button type="button" onClick={openTheme}><Palette size={15} /> 自定义主题</button>
            </div>
            <ProductDemo themeIcon={themeIcon} />
          </div>
        </section>

        <section className="workflow-story section-shell" id="capabilities">
          <div className="section-heading centered">
            <span>从想法到结果</span>
            <h2>古龙帮你全程落地</h2>
            <p>你只需要说清目标，剩下的交给一套会理解、会协作、会成长的执行系统。</p>
          </div>
          <div className="steps-track">
            {workflowSteps.map((step, index) => (
              <article key={step.index}>
                <div className="step-orb"><span>{step.index}</span><strong>{step.title}</strong></div>
                <p>{step.text}</p>
                {index < workflowSteps.length - 1 && <ArrowRight className="step-arrow" size={24} />}
              </article>
            ))}
          </div>
        </section>

        <section className="capability-strip section-shell" aria-label="核心能力">
          {capabilities.map((item) => {
            const Icon = iconMap[item.icon];
            return (
              <article key={item.title}>
                <div className="capability-icon"><Icon size={26} /></div>
                <div><h3>{item.title}</h3><p>{item.text}</p></div>
              </article>
            );
          })}
        </section>

        <section className="home-workflows section-shell">
          <div className="section-heading"><span>WORKFLOW LIBRARY</span><h2>成熟能力，打开就能用</h2><p>每个工作流都是经过整理的功能入口。威客已经上架：发布任务、接单赚钱、跟踪交付都从同一个工作流进入。</p></div>
          <div className="public-workflow-grid">{workflows.slice(0, 3).map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} navigate={navigate} />)}</div>
          <button className="text-link" type="button" onClick={() => navigate("/workflows")}>查看全部工作流 <ArrowRight size={18} /></button>
        </section>

        {partners.length > 0 && <PartnerNetwork partners={partners} />}

        <section className="local-first section-shell" id="brain">
          <div>
            <span className="section-kicker">LOCAL-FIRST, CLOUD-READY</span>
            <h2>能力在本地生长，服务在云端连接</h2>
            <p>古龙把离线运行、隐私隔离与云端开放接口放进同一套架构。个人可以安心积累第二大脑，团队和开发者也能用 API 将智能体能力嵌入自己的产品。</p>
            <button className="text-link" type="button" onClick={() => navigate("/workflows")}>探索工作流 <ArrowRight size={17} /></button>
          </div>
          <div className="architecture-flow" aria-label="古龙能力架构">
            <div><strong>你的目标</strong><small>自然语言 / 文件 / 多模态</small></div>
            <ArrowRight size={21} />
            <div className="featured"><strong>古龙引擎</strong><small>路由 · 组装 · 执行 · 复核</small></div>
            <ArrowRight size={21} />
            <div><strong>可交付结果</strong><small>文件 / 任务 / 产品 API</small></div>
          </div>
        </section>

        <section className="closing-cta section-shell">
          <img src={themeIcon} alt="古龙主题图标" />
          <div><span>你的 AI 团队，今天开始成长</span><h2>把下一个想法交给古龙</h2></div>
          <button className="button primary" type="button" onClick={downloadLatest}>免费下载 <ArrowRight size={18} /></button>
        </section>
      </main>
    </>
  );
}
