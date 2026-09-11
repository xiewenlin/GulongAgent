import {
  ArrowDown,
  ArrowRight,
  BookOpenText,
  CheckCircle,
  Clock,
  FileText,
  FilmSlate,
  FolderOpen,
  FrameCorners,
  ImageSquare,
  MagnifyingGlass,
  MagicWand,
  MonitorPlay,
  Play,
  Sparkle,
  SquaresFour,
  Target,
  TreeStructure,
  UsersThree,
  VideoCamera,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";

const stageIcons = {
  source: BookOpenText,
  screenplay: FileText,
  visual: Sparkle,
  character: UsersThree,
  background: ImageSquare,
  prop: SquaresFour,
  shots: FilmSlate,
  batch: Play,
};

const dramaNodes = [
  {
    id: "source",
    kind: "source",
    eyebrow: "原著",
    title: "小说原文",
    description: "从完整故事出发，保留人物关系与关键事件。",
    status: "已完成",
    progress: 100,
    activity: "12.6 万字原文已完整读取",
    metric: "126,438 字",
    detail: "原文始终保留为创作源头。系统会按章节、人物与事件拆解内容，后续改写不会覆盖用户上传的原始文件。",
  },
  {
    id: "screenplay",
    kind: "screenplay",
    eyebrow: "剧本",
    title: "小说剧本",
    description: "GPT 分批改写为可拍摄、可审阅的分场剧本。",
    status: "已完成",
    progress: 100,
    activity: "12 集导演剧本已通过结构检查",
    metric: "12 集 · 86 场",
    detail: "每一场都包含场次、地点、日夜、动作、表演和对白。支持全屏阅读、编辑与自动保存，确认后再进入视觉设计。",
  },
  {
    id: "visual",
    kind: "visual",
    eyebrow: "视觉中枢",
    title: "视觉资产",
    description: "统一锁定角色、场景、道具与整部作品的美术规则。",
    status: "已完成",
    progress: 100,
    activity: "31 项视觉资产已建立独立身份版本",
    metric: "31 项资产",
    detail: "系统从剧本中抽取实际出镜的人物、道具和背景，为每项资产生成可编辑的中文提示词与多张参考图。",
  },
  {
    id: "character",
    kind: "character",
    eyebrow: "人物设定",
    title: "林晚 · 港城记者",
    description: "身份、体貌、发型、服装与情绪连续性。",
    status: "已完成",
    progress: 100,
    activity: "4 张设定图已锁定",
    metric: "4 张参考图",
    detail: "同一人物的不同服装、伤势和时间状态会建立独立版本，避免跨场景变脸或妆造漂移。",
  },
  {
    id: "background",
    kind: "background",
    eyebrow: "背景设定",
    title: "旧港灯塔 · 雨夜",
    description: "空间结构、光线、天气与镜头轴线。",
    status: "已完成",
    progress: 100,
    activity: "3 个机位与空镜设定已保存",
    metric: "3 张参考图",
    detail: "背景资产只描述空场景和空间关系，不把参考图中的人物带入后续画面，方便镜头调度保持一致。",
  },
  {
    id: "prop",
    kind: "prop",
    eyebrow: "道具设定",
    title: "父亲的铜钥匙",
    description: "材质、磨损、尺寸和持有关系全程可追踪。",
    status: "已完成",
    progress: 100,
    activity: "关键道具状态已锁定",
    metric: "2 张参考图",
    detail: "关键道具会记录出现时间、持有人和状态变化，让交接、损坏与特写镜头都能延续前一场结果。",
  },
  {
    id: "shots",
    kind: "shots",
    eyebrow: "导演分镜",
    title: "镜头任务",
    description: "按剧情节拍拆镜，绑定提示词与最多 9 张参考图。",
    status: "处理中",
    progress: 72,
    activity: "正在检查第 36 / 63 个镜头包",
    metric: "63 个镜头包",
    detail: "每个镜头包含 5、10 或 15 秒时长、动作节拍、对白、运镜、环境声和可见资产。复杂镜头会先生成空间调度预演。",
  },
  {
    id: "batch",
    kind: "batch",
    eyebrow: "本地算力",
    title: "批量生成视频",
    description: "把已批准镜头分发给局域网 MiniMax H3 节点。",
    status: "等待上游",
    progress: 0,
    activity: "镜头任务全部通过后即可开始",
    metric: "智能分发",
    detail: "调度器会比较节点能力、显存、排队任务和预计耗时，把镜头交给最合适的设备，并持续回传每个节点的真实进度。",
  },
];

const processSteps = [
  ["01", "导入故事", "从小说原文、现有剧本、视觉资产或镜头任务任意阶段开始。", BookOpenText],
  ["02", "剧本改写", "把长篇内容拆成可拍摄分场，人物动机、对白和连续性同步校验。", MagicWand],
  ["03", "锁定视觉", "人物、背景、道具分别建立身份版本，中文提示词随时可编辑重做。", ImageSquare],
  ["04", "导演分镜", "逐镜设计时长、表演、走位、运镜、声音与参考素材。", FilmSlate],
  ["05", "集群成片", "将批量任务分给局域网 H3 算力节点，真实进度可以暂停和继续。", VideoCamera],
  ["06", "审看交付", "按场景聚合视频产物，保留人工审看、下载和后期剪辑入口。", MonitorPlay],
];

function StageIcon({ kind, size = 22 }) {
  const Icon = stageIcons[kind] || Sparkle;
  return <Icon size={size} weight="duotone" />;
}

function DramaNode({ node, active, dimmed, onSelect }) {
  return (
    <button
      type="button"
      className={`short-drama-node ${active ? "active" : ""} ${dimmed ? "dimmed" : ""}`}
      onClick={() => onSelect(node.id)}
      aria-pressed={active}
    >
      <span className="short-drama-node-kicker"><StageIcon kind={node.kind} size={18} />{node.eyebrow}</span>
      <strong>{node.title}</strong>
      <small>{node.description}</small>
      <span className="short-drama-node-status"><i className={node.progress === 100 ? "done" : node.progress ? "running" : "waiting"} />{node.status}<b>{node.progress}%</b></span>
      <span className="short-drama-progress" aria-hidden="true"><i style={{ width: `${node.progress}%` }} /></span>
      <em>{node.activity}</em>
    </button>
  );
}

export function ShortDramaPage({ navigate }) {
  const workbenchRef = useRef(null);
  const [activeId, setActiveId] = useState("source");
  const [query, setQuery] = useState("");
  const [view, setView] = useState("canvas");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectTitle, setProjectTitle] = useState("雾港来信");
  const activeNode = dramaNodes.find((node) => node.id === activeId) || dramaNodes[0];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const matchedIds = useMemo(() => new Set(dramaNodes.filter((node) => `${node.title}${node.eyebrow}${node.description}${node.activity}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)).map((node) => node.id)), [normalizedQuery]);

  function openWorkbench() {
    workbenchRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function locateNode(event) {
    event?.preventDefault();
    const firstMatch = normalizedQuery ? dramaNodes.find((node) => matchedIds.has(node.id)) : activeNode;
    if (firstMatch) setActiveId(firstMatch.id);
  }

  return (
    <main id="main-content" className="short-drama-page">
      <section className="short-drama-hero section-shell">
        <div className="short-drama-hero-copy">
          <span>GULONG STORY TO SCREEN</span>
          <h1>一部小说，沿一张画布<br />生长成完整短剧。</h1>
          <p>把剧本、人物、场景、道具、分镜和视频任务放进同一个可追溯创作空间。每个环节都能看见、能审阅、能接续。</p>
          <div>
            <button className="button primary" type="button" onClick={openWorkbench}>体验示例画布 <ArrowRight size={20} /></button>
            <button className="button secondary" type="button" onClick={() => navigate("/download")}>下载完整工作台</button>
          </div>
          <small><CheckCircle size={18} weight="fill" /> 官网原生功能展示 · 不再跳转或嵌入外部项目</small>
        </div>
        <div className="short-drama-hero-map" aria-label="短剧创作流程概览">
          <span><BookOpenText size={22} />小说原文</span>
          <ArrowDown size={20} />
          <span><MagicWand size={22} />小说剧本</span>
          <ArrowDown size={20} />
          <div><span><UsersThree size={21} />人物</span><span><ImageSquare size={21} />场景</span><span><SquaresFour size={21} />道具</span></div>
          <ArrowDown size={20} />
          <strong><FilmSlate size={23} />镜头任务</strong>
          <ArrowDown size={20} />
          <strong><Play size={23} weight="fill" />集群成片</strong>
        </div>
      </section>

      <section className="short-drama-promise section-shell" aria-label="短剧工作台关键价值">
        <article><strong>任意阶段接续</strong><span>已有成果不用重来</span></article>
        <article><strong>中文提示词可编辑</strong><span>创作决定权始终在你</span></article>
        <article><strong>全流程真实进度</strong><span>每个节点都可追溯</span></article>
        <article><strong>局域网算力协同</strong><span>按预计耗时智能分发</span></article>
      </section>

      <section ref={workbenchRef} id="short-drama-workbench" className="short-drama-demo section-shell">
        <header className="short-drama-demo-bar">
          <div className="short-drama-demo-brand"><span><Sparkle size={22} weight="fill" /></span><strong>短剧工作台</strong><small>灵感成片</small></div>
          <div className="short-drama-demo-context"><span>{projectTitle}</span><i>/</i><strong>{view === "canvas" ? "无限画布" : "阶段列表"}</strong></div>
          <div className="short-drama-demo-actions">
            <div className="short-drama-project-menu">
              <button type="button" onClick={() => setProjectOpen((current) => !current)} aria-expanded={projectOpen}><FolderOpen size={19} /> 项目管理</button>
              {projectOpen && <div role="menu">{["雾港来信", "长安夜行", "一封家书"].map((title) => <button type="button" role="menuitem" key={title} className={projectTitle === title ? "active" : ""} onClick={() => { setProjectTitle(title); setProjectOpen(false); }}>{title}<span>{title === "雾港来信" ? "示例已就绪" : "功能预览"}</span></button>)}</div>}
            </div>
            <span className="short-drama-demo-pill">网页演示</span>
            <span className="short-drama-live"><i />创作连接</span>
          </div>
        </header>

        <div className="short-drama-demo-toolbar">
          <div><span>STORY TO SCREEN</span><h2>{projectTitle}</h2><em>镜头生成中</em></div>
          <form onSubmit={locateNode} role="search"><MagnifyingGlass size={20} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找人物、场景、镜头…" aria-label="查找创作节点" /><button type="submit">定位</button></form>
          <div className="short-drama-view-switch"><button type="button" className={view === "canvas" ? "active" : ""} onClick={() => setView("canvas")}><TreeStructure size={18} />无限画布</button><button type="button" className={view === "pipeline" ? "active" : ""} onClick={() => setView("pipeline")}><SquaresFour size={18} />阶段列表</button></div>
        </div>

        <div className="short-drama-workspace">
          <aside className="short-drama-stage-nav">
            <span>创作流程</span>
            {dramaNodes.filter((node) => ["source", "screenplay", "visual", "shots", "batch"].includes(node.id)).map((node, index) => <button type="button" key={node.id} className={activeId === node.id ? "active" : ""} onClick={() => setActiveId(node.id)}><b>{String(index + 1).padStart(2, "0")}</b><StageIcon kind={node.kind} size={19} /><span>{node.id === "batch" ? "批量生成" : node.title}</span>{node.progress === 100 ? <CheckCircle size={17} weight="fill" /> : node.progress ? <i /> : null}</button>)}
            <div><span>项目概况</span><p><strong>31</strong> 视觉资产</p><p><strong>63</strong> 镜头任务</p><p><strong>1</strong> 节点运行中</p></div>
          </aside>

          <div className="short-drama-canvas-shell">
            <div className="short-drama-canvas-tools"><button type="button" onClick={() => { setQuery(""); setActiveId("source"); }}><FrameCorners size={18} />全览</button><button type="button" onClick={locateNode}><Target size={18} />定位</button></div>
            {view === "canvas" ? (
              <div className="short-drama-canvas" aria-label="短剧无限创作画布">
                <DramaNode node={dramaNodes[0]} active={activeId === "source"} dimmed={normalizedQuery && !matchedIds.has("source")} onSelect={setActiveId} />
                <ArrowDown className="short-drama-node-arrow" size={24} />
                <DramaNode node={dramaNodes[1]} active={activeId === "screenplay"} dimmed={normalizedQuery && !matchedIds.has("screenplay")} onSelect={setActiveId} />
                <ArrowDown className="short-drama-node-arrow" size={24} />
                <DramaNode node={dramaNodes[2]} active={activeId === "visual"} dimmed={normalizedQuery && !matchedIds.has("visual")} onSelect={setActiveId} />
                <ArrowDown className="short-drama-node-arrow" size={24} />
                <div className="short-drama-asset-branches">{dramaNodes.slice(3, 6).map((node) => <DramaNode key={node.id} node={node} active={activeId === node.id} dimmed={normalizedQuery && !matchedIds.has(node.id)} onSelect={setActiveId} />)}</div>
                <ArrowDown className="short-drama-node-arrow" size={24} />
                <DramaNode node={dramaNodes[6]} active={activeId === "shots"} dimmed={normalizedQuery && !matchedIds.has("shots")} onSelect={setActiveId} />
                <ArrowDown className="short-drama-node-arrow" size={24} />
                <DramaNode node={dramaNodes[7]} active={activeId === "batch"} dimmed={normalizedQuery && !matchedIds.has("batch")} onSelect={setActiveId} />
              </div>
            ) : (
              <div className="short-drama-pipeline-list">{dramaNodes.map((node, index) => <button type="button" key={node.id} className={activeId === node.id ? "active" : ""} onClick={() => setActiveId(node.id)}><b>{String(index + 1).padStart(2, "0")}</b><span><StageIcon kind={node.kind} size={23} /></span><div><strong>{node.title}</strong><small>{node.description}</small></div><em>{node.metric}</em><i><span style={{ width: `${node.progress}%` }} /></i></button>)}</div>
            )}
            <span className="short-drama-canvas-caption"><i />无限创作画布 · 8 个功能节点 · 点击节点查看说明</span>
          </div>

          <aside className="short-drama-inspector" aria-live="polite">
            <header><span>节点详情</span><span>活动</span></header>
            <div className="short-drama-inspector-body">
              <span className="short-drama-detail-icon"><StageIcon kind={activeNode.kind} size={29} /></span>
              <small>{activeNode.eyebrow}</small>
              <h2>{activeNode.title}</h2>
              <div className="short-drama-detail-status"><span><i className={activeNode.progress === 100 ? "done" : activeNode.progress ? "running" : "waiting"} />{activeNode.status}</span><strong>{activeNode.progress}%</strong></div>
              <span className="short-drama-detail-progress"><i style={{ width: `${activeNode.progress}%` }} /></span>
              <p>{activeNode.activity}</p>
              <div className="short-drama-detail-metric"><span>当前产物</span><strong>{activeNode.metric}</strong></div>
              <section><h3>这个节点会完成什么？</h3><p>{activeNode.detail}</p></section>
              <section><h3>创作接续</h3><p>上游修改后，只重新检查受影响的资产与镜头；已经确认的成果不会无故重做。</p></section>
            </div>
          </aside>
        </div>
        <footer className="short-drama-demo-footer"><span><TreeStructure size={16} />网页功能演示 · 不执行真实生成</span><span><Clock size={16} />进度来自节点活动</span><span>GPT 创作 · MiniMax H3 成片</span></footer>
      </section>

      <section className="short-drama-process section-shell">
        <header><span>ONE CANVAS, COMPLETE PIPELINE</span><h2>普通人也能看懂的影视创作路径</h2><p>每一步只回答一个问题：现在要做什么、系统产出了什么、下一步什么时候可以开始。</p></header>
        <div>{processSteps.map(([number, title, description, Icon]) => <article key={number}><span><Icon size={25} weight="duotone" /></span><small>{number}</small><h3>{title}</h3><p>{description}</p></article>)}</div>
      </section>

      <section className="short-drama-cta section-shell">
        <div><span>从故事到成片，不再在十几个工具之间迷路。</span><h2>先在网页看懂全流程，再用完整工作台开始创作。</h2></div>
        <div><button className="button secondary" type="button" onClick={() => navigate("/agent")}>进入古龙网页版</button><button className="button primary" type="button" onClick={() => navigate("/download")}>下载短剧工作台 <ArrowRight size={20} /></button></div>
      </section>
    </main>
  );
}
