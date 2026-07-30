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

const iconMap = {
  route: FlowArrow,
  brain: Brain,
  market: PuzzlePiece,
  devices: Devices,
};

export function HomePage({ navigate, openTheme, themeIcon, downloadLatest }) {
  const [partners, setPartners] = useState([]);

  useEffect(() => {
    apiFetch("/api/partners").then((result) => setPartners(result.partners || [])).catch(() => setPartners([]));
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
              <button className="button secondary" type="button" onClick={() => navigate("/developer")}><Code size={20} /> 开发者接入</button>
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

        <section className="home-worker section-shell">
          <div className="home-worker-copy"><span>GULONG WORKER MARKET</span><h2>系统自动接单，<br /><em>AI 攻城狮军团</em>帮你快速搞定</h2><p>难题不用独自硬扛。发布需求、托管预算、跟进进度、验收交付；也可以把你的能力变成收入，接单赚钱。</p><div><button className="button primary" onClick={() => navigate("/worker?tab=publish")}><PaperPlaneRight size={20} />发布任务</button><button className="button secondary" onClick={() => navigate("/worker?tab=earn")}><HandCoins size={20} />接单赚钱</button></div></div>
          <div className="home-worker-engine"><div className="home-worker-orbit"><span>需求</span><span>接单</span><strong>古龙<br />威客</strong><span>交付</span><span>结算</span></div><div className="home-worker-rules"><article><strong>80%</strong><span>接单者任务收入</span></article><article><strong>60%</strong><span>工作流复用双方分佣</span></article><article><strong>40%</strong><span>平台复用收益</span></article></div><p><ShieldCheck size={19} />预算审核后开放接单 · 验收后自动结算 · 每一步可追踪</p></div>
        </section>

        {partners.length > 0 && <PartnerNetwork partners={partners} />}

        <section className="local-first section-shell" id="brain">
          <div>
            <span className="section-kicker">LOCAL-FIRST, CLOUD-READY</span>
            <h2>能力在本地生长，服务在云端连接</h2>
            <p>古龙把离线运行、隐私隔离与云端开放接口放进同一套架构。个人可以安心积累第二大脑，团队和开发者也能用 API 将智能体能力嵌入自己的产品。</p>
            <button className="text-link" type="button" onClick={() => navigate("/developer")}>了解开放平台 <ArrowRight size={17} /></button>
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
