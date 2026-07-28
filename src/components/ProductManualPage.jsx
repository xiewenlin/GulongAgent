import {
  Archive,
  ArrowRight,
  BookOpenText,
  Brain,
  CaretRight,
  ChatCircleDots,
  ChatsCircle,
  CheckCircle,
  CirclesThree,
  Cloud,
  Cpu,
  Devices,
  FlowArrow,
  Image,
  Layout,
  MagnifyingGlass,
  Pulse,
  PuzzlePiece,
  ShieldCheck,
  Sparkle,
  VideoCamera,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { manualChapters, manualFaqs } from "../data/manual.js";

const iconMap = {
  archive: Archive,
  brain: Brain,
  chat: ChatCircleDots,
  cloud: Cloud,
  cpu: Cpu,
  devices: Devices,
  flow: FlowArrow,
  image: Image,
  layout: Layout,
  messages: ChatsCircle,
  pulse: Pulse,
  puzzle: PuzzlePiece,
  route: FlowArrow,
  shield: ShieldCheck,
  video: VideoCamera,
  wrench: Wrench,
};

function FeatureNode({ node, index }) {
  const Icon = iconMap[node.icon] || Sparkle;
  return (
    <article className="manual-node" id={node.id}>
      <div className="manual-node-visual" aria-hidden="true">
        <span>{String(index + 1).padStart(2, "0")}</span>
        <Icon size={34} weight="duotone" />
        <i />
      </div>
      <div className="manual-node-body">
        <div className="manual-node-heading">
          <div><p>功能知识点</p><h3>{node.title}</h3></div>
          <div className="manual-keywords">{node.keywords.slice(0, 3).map((word) => <span key={word}>{word}</span>)}</div>
        </div>
        <p className="manual-node-summary">{node.summary}</p>
        <div className="manual-node-detail">
          <div>
            <h4>照着做</h4>
            <ol>{node.steps.map((step, stepIndex) => <li key={step}><span>{stepIndex + 1}</span><p>{step}</p></li>)}</ol>
          </div>
          <aside>
            <h4>完成后你会得到</h4>
            <p>{node.result}</p>
            <h4>使用提醒</h4>
            <ul>{node.tips.map((tip) => <li key={tip}><CheckCircle size={15} weight="fill" />{tip}</li>)}</ul>
          </aside>
        </div>
      </div>
    </article>
  );
}

function BeforeAfter({ before, after, label }) {
  const [showAfter, setShowAfter] = useState(true);
  return (
    <article className="manual-example-card">
      <div className="manual-example-head">
        <div><span>真实内置示例</span><h3>{label}</h3></div>
        <div className="manual-segmented" aria-label={`${label}图片切换`}>
          <button className={!showAfter ? "active" : ""} onClick={() => setShowAfter(false)}>原图</button>
          <button className={showAfter ? "active" : ""} onClick={() => setShowAfter(true)}>结果</button>
        </div>
      </div>
      <figure><img src={showAfter ? after : before} alt={`${label}${showAfter ? "处理结果" : "原始素材"}`} loading="lazy" decoding="async" /></figure>
    </article>
  );
}

export function ProductManualPage({ navigate }) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const visibleChapters = useMemo(() => {
    if (!normalized) return manualChapters;
    return manualChapters.map((chapter) => ({
      ...chapter,
      nodes: chapter.nodes.filter((node) => [node.title, node.summary, ...node.keywords, ...node.steps].join(" ").toLowerCase().includes(normalized)),
    })).filter((chapter) => chapter.nodes.length);
  }, [normalized]);
  const totalNodes = manualChapters.reduce((sum, chapter) => sum + chapter.nodes.length, 0);
  const visibleCount = visibleChapters.reduce((sum, chapter) => sum + chapter.nodes.length, 0);

  return (
    <main id="main-content" className="manual-page">
      <section className="manual-hero section-shell">
        <div className="manual-hero-copy">
          <div className="eyebrow"><BookOpenText size={15} weight="fill" /> GULONG PRODUCT MANUAL</div>
          <h1>不会写提示词，<br />也能用好一支 <em>AI 团队</em></h1>
          <p>这不是功能清单，而是一条从“第一次打开”到“把经验变成长期能力”的学习路径。每个知识点都告诉你：它解决什么问题、怎么操作、完成后会得到什么。</p>
          <label className="manual-search">
            <MagnifyingGlass size={20} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索功能、场景或问题，例如：微信、图片、恢复…" />
            {query && <button aria-label="清空搜索" onClick={() => setQuery("")}><X size={17} /></button>}
          </label>
          <div className="manual-hero-meta"><span><strong>{totalNodes}</strong> 个核心知识点</span><span><strong>5</strong> 条学习路径</span><span><strong>0</strong> 技术门槛</span></div>
        </div>
        <div className="manual-hero-visual">
          <img src="/assets/manual/gulong-overview.png" alt="古龙智能体引擎官网与工作台总览" decoding="async" fetchPriority="high" />
          <div className="manual-visual-note"><CirclesThree size={20} weight="duotone" /><span><strong>从目标到结果</strong>理解 → 组装 → 执行 → 进化</span></div>
        </div>
      </section>

      <section className="manual-quickstart section-shell">
        <div><span>建议从这里开始</span><h2>四步完成第一次协作</h2></div>
        {["说清最终结果", "补充材料与约束", "确认执行方案", "审阅并沉淀经验"].map((item, index) => <article key={item}><span>0{index + 1}</span><strong>{item}</strong>{index < 3 && <ArrowRight size={18} />}</article>)}
      </section>

      <section className="manual-workspace section-shell">
        <aside className="manual-sidebar">
          <div><span>知识体系</span><strong>{normalized ? `找到 ${visibleCount} 个结果` : "按学习顺序阅读"}</strong></div>
          <nav>
            {manualChapters.map((chapter) => (
              <a key={chapter.id} href={`#chapter-${chapter.id}`}>
                <span>{chapter.title}</span><small>{chapter.nodes.length}</small>
              </a>
            ))}
          </nav>
          <button className="button primary full" onClick={() => navigate("/download")}>下载后边看边学 <ArrowRight size={17} /></button>
        </aside>

        <div className="manual-content">
          {visibleChapters.length ? visibleChapters.map((chapter) => (
            <section className="manual-chapter" id={`chapter-${chapter.id}`} key={chapter.id}>
              <header><span>{chapter.title}</span><h2>{chapter.description}</h2></header>
              <div>{chapter.nodes.map((node, index) => <FeatureNode key={node.id} node={node} index={index} />)}</div>
            </section>
          )) : (
            <div className="manual-empty"><MagnifyingGlass size={30} /><h2>还没有匹配的知识点</h2><p>换一个更短的关键词，或清空搜索后按章节浏览。</p><button className="button secondary" onClick={() => setQuery("")}>清空搜索</button></div>
          )}
        </div>
      </section>

      <section className="manual-examples section-shell">
        <div className="section-heading"><span>不只会聊天</span><h2>看看古龙怎样把素材变成结果</h2><p>以下图片来自桌面端“超能作图”的内置示例，可切换原图与处理结果。</p></div>
        <div>
          <BeforeAfter label="智能换背景与商业构图" before="/assets/manual/background-before.jpg" after="/assets/manual/background-after.png" />
          <BeforeAfter label="商品细节板自动生成" before="/assets/manual/detail-board-before.png" after="/assets/manual/detail-board-after.png" />
        </div>
      </section>

      <section className="manual-faq section-shell">
        <div className="section-heading"><span>常见问题</span><h2>第一次使用，通常会问这些</h2></div>
        <div>{manualFaqs.map(([question, answer], index) => <details key={question} open={index === 0}><summary>{question}<CaretRight size={18} /></summary><p>{answer}</p></details>)}</div>
      </section>

      <section className="manual-closing section-shell">
        <div><span>下一章</span><h2>去看看古龙怎样记住你</h2><p>第二大脑会把会话、笔记与文件变成有来源、有时间、有引用的长期知识。</p></div>
        <button className="button primary" onClick={() => navigate("/brain")}>进入第二大脑 <ArrowRight size={18} /></button>
      </section>
    </main>
  );
}
