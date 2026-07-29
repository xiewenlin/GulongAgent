import {
  ArrowRight,
  ArrowsOut,
  Brain,
  CaretDown,
  ChartScatter,
  ChatsCircle,
  CheckCircle,
  CirclesFour,
  CloudCheck,
  Database,
  FileMd,
  FileText,
  Fingerprint,
  FlowArrow,
  Graph,
  HardDrives,
  Images,
  LockKey,
  MagnifyingGlass,
  Network,
  Pause,
  Play,
  Quotes,
  ShieldCheck,
  Sparkle,
  UploadSimple,
  UserFocus,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrainUploadPanel } from "./PlatformPages.jsx";

const brainCategories = [
  { id: "project", label: "项目", color: "#3fd0a0" },
  { id: "insight", label: "洞察", color: "#43aef5" },
  { id: "decision", label: "决策", color: "#edbe48" },
  { id: "person", label: "人物", color: "#d77491" },
  { id: "method", label: "方法", color: "#8b7cf6" },
  { id: "evidence", label: "证据", color: "#64d7d1" },
];

const noteTitles = [
  ["古龙官网信息架构", "产品手册内容计划", "第二大脑发布清单", "桌面端 v0.17.4", "会员能力路线图", "移动端同步试验", "工作流市场改版", "模型路由评测"],
  ["用户更在意可恢复", "长任务需要静默运行", "本地优先建立信任", "知识缺口必须显式", "复杂任务先确认意图", "流程比提示词更可复用", "证据引用降低幻觉", "健康时不应自我优化"],
  ["Vault 作为唯一事实源", "默认只同步文字", "索引异常先重建", "候选改进必须审批", "消息渠道保持隔离", "视频任务先确认尺寸", "正常升级保留数据", "跨网同步由用户控制"],
  ["设计负责人 · 小林", "开发者 · 阿策", "测试用户 · 周姐", "运营伙伴 · 梁老师", "客户访谈 · 陈总", "内容创作者 · 阿满", "插件作者 · 路远", "体验顾问 · 七月"],
  ["RRF 多重检索", "原子 Markdown 写入", "Trace 根因聚类", "动态工作流组装", "黄金任务评测", "证据链核验", "知识陈旧检测", "分阶段灰度发布"],
  ["会话 2026-07-21", "需求评审纪要", "安装失败截图", "用户访谈录音", "功能验收报告", "模型成本对比", "版本发布记录", "隐私边界说明"],
];

const simulatedNotes = noteTitles.flatMap((titles, categoryIndex) => titles.map((title, noteIndex) => {
  const category = brainCategories[categoryIndex];
  return {
    id: `${category.id}-${noteIndex}`,
    title,
    category: category.id,
    categoryLabel: category.label,
    color: category.color,
    directory: ["工作记录", "产品研究", "个人知识", "决策档案"][noteIndex % 4],
    date: `2026-07-${String(10 + ((categoryIndex * 3 + noteIndex) % 18)).padStart(2, "0")}`,
    excerpt: [
      "来自会话与项目文件的结构化记忆，已保留原始来源和更新时间。",
      "这条知识与多个项目节点存在关系，可沿证据链回到原文。",
      "经过冲突检测与去重，当前版本被标记为可用于综合思考。",
    ][(categoryIndex + noteIndex) % 3],
    evidence: 1 + ((categoryIndex * 7 + noteIndex) % 6),
  };
}));

function HologramCanvas({ notes, paused, resetKey, fullScreen, onSelect }) {
  const canvasRef = useRef(null);
  const pausedRef = useRef(paused);
  const onSelectRef = useRef(onSelect);
  pausedRef.current = paused;
  onSelectRef.current = onSelect;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const base = notes.map((note, index) => {
      const count = Math.max(notes.length, 1);
      const y = 1 - ((index + 0.5) / count) * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = goldenAngle * index;
      return { x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius, color: note.color };
    });
    let width = 1;
    let height = 1;
    let ratio = 1;
    let rotationX = -0.12;
    let rotationY = 0.35;
    let zoom = fullScreen ? 1.05 : 0.92;
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    let frame = 0;
    let projected = [];
    let tick = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      const gradient = context.createRadialGradient(width * 0.5, height * 0.48, 15, width * 0.5, height * 0.5, Math.max(width, height) * 0.75);
      gradient.addColorStop(0, "#123847");
      gradient.addColorStop(0.44, "#071b28");
      gradient.addColorStop(1, "#020711");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      context.fillStyle = "rgba(148,221,224,.55)";
      for (let index = 0; index < 110; index += 1) {
        const x = (((index * 83) % 997) / 997) * width;
        const y = (((index * 47) % 773) / 773) * height;
        const size = index % 9 === 0 ? 1.3 : 0.65;
        context.fillRect(x, y, size, size);
      }
      if (!dragging && !pausedRef.current) rotationY += 0.0012;
      if (!pausedRef.current) tick += 0.018;
      const sinX = Math.sin(rotationX);
      const cosX = Math.cos(rotationX);
      const sinY = Math.sin(rotationY);
      const cosY = Math.cos(rotationY);
      const span = Math.min(width, height) * 0.43 * zoom;
      projected = base.map((point, index) => {
        const x1 = point.x * cosY - point.z * sinY;
        const z1 = point.x * sinY + point.z * cosY;
        const y2 = point.y * cosX - z1 * sinX;
        const z2 = point.y * sinX + z1 * cosX;
        const perspective = 1 / (2.25 - z2);
        return { index, x: width * 0.5 + x1 * span * perspective * 2.1, y: height * 0.5 + y2 * span * perspective * 2.1, z: z2, radius: Math.max(2, 2.5 + 3.7 * perspective), color: point.color };
      });

      context.lineWidth = 0.65;
      for (let index = 1; index < projected.length; index += 1) {
        const point = projected[index];
        const parent = projected[Math.floor((index - 1) / 4)];
        if (!parent) continue;
        const alpha = Math.max(0.05, 0.13 + point.z * 0.04);
        context.strokeStyle = `rgba(91,187,220,${alpha})`;
        context.beginPath();
        context.moveTo(parent.x, parent.y);
        context.lineTo(point.x, point.y);
        context.stroke();
      }
      const sorted = [...projected].sort((a, b) => a.z - b.z);
      for (const point of sorted) {
        const pulse = 1 + Math.sin(tick + point.index * 0.7) * 0.18;
        context.globalAlpha = Math.max(0.32, 0.72 + point.z * 0.24);
        context.shadowColor = point.color;
        context.shadowBlur = point.radius * 3.2;
        context.fillStyle = point.color;
        context.beginPath();
        context.arc(point.x, point.y, point.radius * pulse, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
      context.shadowBlur = 0;
      const fontSize = fullScreen ? (notes.length > 30 ? 10 : 12) : (notes.length > 30 ? 8 : 10);
      context.font = `${fontSize}px "Microsoft YaHei UI", sans-serif`;
      context.textBaseline = "middle";
      for (const point of sorted.filter((_, index) => fullScreen || index % 2 === 0)) {
        const title = notes[point.index]?.title || "未命名笔记";
        const text = title.length > (fullScreen ? 18 : 12) ? `${title.slice(0, fullScreen ? 17 : 11)}…` : title;
        const measured = context.measureText(text).width;
        const labelX = Math.max(4, Math.min(width - measured - 6, point.x + 8));
        const labelY = Math.max(fontSize, Math.min(height - fontSize, point.y + ((point.index % 5) - 2) * (fontSize + 2)));
        context.globalAlpha = Math.max(0.48, 0.8 + point.z * 0.14);
        context.fillStyle = "rgba(2,7,17,.72)";
        context.fillRect(labelX - 3, labelY - fontSize * 0.75, measured + 6, fontSize * 1.5);
        context.fillStyle = "rgba(230,249,247,.96)";
        context.fillText(text, labelX, labelY);
      }
      context.globalAlpha = 1;
      frame = window.requestAnimationFrame(draw);
    };

    const nearest = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      return projected.reduce((best, node) => {
        const distance = Math.hypot(node.x - x, node.y - y);
        return distance < best.distance ? { node, distance } : best;
      }, { node: null, distance: 18 });
    };
    const pointerDown = (event) => { dragging = true; moved = false; lastX = event.clientX; lastY = event.clientY; canvas.setPointerCapture(event.pointerId); };
    const pointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      rotationY += dx * 0.006;
      rotationX = Math.max(-1.25, Math.min(1.25, rotationX + dy * 0.006));
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const pointerUp = (event) => {
      dragging = false;
      if (!moved) {
        const hit = nearest(event.clientX, event.clientY);
        if (hit.node && notes[hit.node.index]) onSelectRef.current(notes[hit.node.index]);
      }
    };
    const wheel = (event) => { event.preventDefault(); zoom = Math.max(0.48, Math.min(2.3, zoom * (event.deltaY > 0 ? 0.92 : 1.08))); };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("wheel", wheel, { passive: false });
    resize();
    draw();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [notes, resetKey, fullScreen]);

  return <canvas ref={canvasRef} aria-label={`第二大脑动态神经网络，共 ${notes.length} 个可点击模拟节点`} />;
}

function NetworkStage({ notes, paused, setPaused, resetKey, setResetKey, selected, setSelected, fullScreen, openFullScreen, closeFullScreen }) {
  return (
    <div className={fullScreen ? "brain-hologram-fullscreen" : "brain-network-stage"} role={fullScreen ? "dialog" : undefined} aria-modal={fullScreen || undefined}>
      <div className="brain-network-toolbar">
        <div><span className="live-dot" /><p><strong>{fullScreen ? "神经网络全息预览" : "动态神经网络"}</strong><small>{notes.length} 个模拟节点实时渲染</small></p></div>
        <div>
          <button onClick={() => setPaused(!paused)}>{paused ? <Play size={16} weight="fill" /> : <Pause size={16} weight="fill" />}{paused ? "继续" : "暂停"}</button>
          <button onClick={() => setResetKey(resetKey + 1)}><FlowArrow size={16} />复位视角</button>
          {fullScreen ? <button onClick={closeFullScreen}><X size={17} />退出全息</button> : <button className="primary" onClick={openFullScreen}><ArrowsOut size={17} />全息预览</button>}
        </div>
      </div>
      <div className="brain-network-canvas">
        <HologramCanvas notes={notes} paused={paused} resetKey={resetKey} fullScreen={fullScreen} onSelect={setSelected} />
        <div className="network-help">拖拽 360° 旋转 · 滚轮缩放 · 点击节点查看证据</div>
      </div>
      {selected && (
        <aside className="network-note-card">
          <button aria-label="关闭节点详情" onClick={() => setSelected(null)}><X size={15} /></button>
          <span style={{ color: selected.color }}>{selected.categoryLabel} · {selected.directory}</span>
          <h4>{selected.title}</h4>
          <p>{selected.excerpt}</p>
          <footer><span>{selected.date}</span><strong><Quotes size={14} weight="fill" /> {selected.evidence} 条证据</strong></footer>
        </aside>
      )}
    </div>
  );
}

function NeuralHologramDemo() {
  const [category, setCategory] = useState("all");
  const [paused, setPaused] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [selected, setSelected] = useState(simulatedNotes[0]);
  const [fullScreen, setFullScreen] = useState(false);
  const notes = useMemo(() => category === "all" ? simulatedNotes : simulatedNotes.filter((note) => note.category === category), [category]);
  useEffect(() => {
    if (!fullScreen) return undefined;
    const onKey = (event) => event.key === "Escape" && setFullScreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen]);
  return (
    <div className="brain-network-demo">
      <div className="brain-network-filters">
        <div><strong>按记忆类型观察</strong><span>所有内容均为演示数据，不会读取你的本地知识。</span></div>
        <label><span>显示</span><select value={category} onChange={(event) => { setCategory(event.target.value); setSelected(null); }}><option value="all">全部节点</option>{brainCategories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><CaretDown size={14} /></label>
        <div className="network-legend">{brainCategories.map((item) => <button className={category === item.id ? "active" : ""} key={item.id} onClick={() => { setCategory(category === item.id ? "all" : item.id); setSelected(null); }}><i style={{ background: item.color }} />{item.label}</button>)}</div>
      </div>
      <NetworkStage notes={notes} paused={paused} setPaused={setPaused} resetKey={resetKey} setResetKey={setResetKey} selected={selected} setSelected={setSelected} fullScreen={false} openFullScreen={() => setFullScreen(true)} />
      {fullScreen && <NetworkStage notes={notes} paused={paused} setPaused={setPaused} resetKey={resetKey} setResetKey={setResetKey} selected={selected} setSelected={setSelected} fullScreen closeFullScreen={() => setFullScreen(false)} />}
    </div>
  );
}

function UploadModal({ user, openAuth, onClose }) {
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop brain-upload-backdrop" role="dialog" aria-modal="true" aria-label="把你的知识带回古龙" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="brain-upload-modal">
        <button className="modal-close" onClick={onClose}><X size={19} /></button>
        <header><span>IMPROVE GULONG</span><h2>把你的知识带回古龙</h2><p>上传 ZIP 格式的“第二大脑”存储目录，排队分析问题、需求与可复用经验。</p></header>
        <BrainUploadPanel user={user} openAuth={openAuth} embedded />
      </section>
    </div>
  );
}

export function SecondBrainPage({ user, openAuth, navigate }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  return (
    <main id="main-content" className="brain-page">
      <section className="brain-hero">
        <img className="brain-hero-art" src="/assets/brain/second-brain-hero.png" alt="由会话、文件和设备流向长期记忆核心的第二大脑概念图" decoding="async" fetchPriority="high" />
        <div className="brain-hero-overlay" />
        <div className="brain-hero-copy section-shell">
          <div className="eyebrow"><Brain size={15} weight="fill" /> SECOND BRAIN 2.0</div>
          <h1>你走过的每一步，<br />都不该在下一次对话里 <em>归零</em></h1>
          <p>古龙把散落在会话、笔记、文件与项目里的经验，整理成有来源、有时间、有关系、可引用的长期知识。它不是替你“记住一切”，而是让真正有价值的部分随时找得回、说得清、用得上。</p>
          <div className="brain-hero-actions">
            <button className="button primary" onClick={() => setUploadOpen(true)}><UploadSimple size={19} /> 把你的知识带回古龙</button>
            <a className="button secondary" href="#hologram"><Network size={19} /> 体验全息预览</a>
          </div>
          <div className="brain-trust"><span><FileMd size={17} /> Markdown 是事实源</span><span><HardDrives size={17} /> 本地优先</span><span><ShieldCheck size={17} /> 来源与权限先过滤</span></div>
        </div>
      </section>

      <section className="brain-proof section-shell">
        {[['34', '可审计 Agent 技能'], ['4', '种证据检索通道'], ['0', '默认外发网络请求'], ['1', '份可迁移事实源']].map(([value, label]) => <article key={label}><strong>{value}</strong><span>{label}</span></article>)}
      </section>

      <section className="brain-problem section-shell">
        <div className="section-heading"><span>你的知识不是一次性上下文</span><h2>真正浪费的，不是忘记。<br />而是每次都要从头解释自己。</h2></div>
        <div className="brain-problem-grid">
          {[{icon: ChatsCircle, title: '会话结束，经验散落', text: '关键决策埋在数百条对话里，下次开始仍要重复背景。'}, {icon: FileText, title: '文件很多，却找不到依据', text: '搜索能找到关键词，却说不清结论来自哪一版、哪一天。'}, {icon: Graph, title: '笔记存在，但彼此不认识', text: '人物、项目、事件和方法没有关系，无法支持更深入的判断。'}].map(({icon: Icon, title, text}) => <article key={title}><Icon size={28} weight="duotone" /><h3>{title}</h3><p>{text}</p></article>)}
        </div>
      </section>

      <section className="brain-capture section-shell">
        <div className="brain-section-copy"><span>01 · 捕获</span><h2>知识从你正在工作的地方，自然流进来</h2><p>不需要先学一套复杂的笔记方法。会话可以归档，文件可以导入，微信、企业微信与飞书可以在保持会话隔离的前提下，把有价值的内容送进同一个 Vault。</p></div>
        <div className="brain-capture-grid">
          {[{icon: ChatsCircle, title: '会话', text: '把决定、结论和未完成项一起保存'}, {icon: FileText, title: '文档', text: 'Markdown、项目文件与导入目录'}, {icon: Images, title: '素材', text: '图片与视频留在电脑端管理'}, {icon: UserFocus, title: '渠道', text: '微信、企业微信与飞书按来源隔离'}].map(({icon: Icon, title, text}, index) => <article key={title}><span>0{index + 1}</span><Icon size={25} weight="duotone" /><h3>{title}</h3><p>{text}</p></article>)}
        </div>
      </section>

      <section className="brain-layers">
        <div className="brain-layers-inner section-shell">
          <div className="brain-layers-art"><img src="/assets/brain/memory-layers.png" alt="由原始捕获、Markdown、索引、向量、知识图谱与证据结论组成的记忆分层结构" loading="lazy" decoding="async" /></div>
          <div className="brain-layers-copy">
            <span>02 · 存储结构</span><h2>一份原文，长出多种理解方式</h2><p>写入顺序被严格固定：先规范化，再原子写入 Markdown，然后记录哈希与事件，最后同步可重建的检索镜像。数据库损坏可以重建，原始知识仍然可读。</p>
            <ol>
              {[['捕获层', '会话、文件、图片、渠道事件'], ['事实层', 'Markdown Vault · 唯一事实源'], ['索引层', '分块、FTS5 全文与元数据'], ['语义层', '64 维本地向量记忆场'], ['关系层', '实体、关系、时间线与冲突'], ['真相层', 'Compiled Truth + 证据引用']].map(([title, text], index) => <li key={title}><span>0{index + 1}</span><div><strong>{title}</strong><p>{text}</p></div></li>)}
            </ol>
          </div>
        </div>
      </section>

      <section className="brain-hologram section-shell" id="hologram">
        <div className="brain-section-copy centered"><span>03 · 神经网络 / 全息预览</span><h2>你的知识，不再是一摞文件。<br />而是一张会呼吸的关系网络。</h2><p>下面复刻古龙桌面端的动态神经网络交互，并使用模拟数据演示。拖拽旋转、滚轮缩放、点击节点查看证据，或进入全屏全息预览。</p></div>
        <NeuralHologramDemo />
      </section>

      <section className="brain-retrieval section-shell" id="retrieval">
        <div className="brain-section-copy"><span>04 · 检索与思考</span><h2>先找证据，再组织答案</h2><p>古龙不会先让模型“凭感觉回忆”。它先在本地合并多路检索结果，再把同一份证据池交给综合思考，并强制标注引用与知识缺口。</p></div>
        <div className="retrieval-pipeline">
          <div className="retrieval-sources">
            {[{icon: MagnifyingGlass, title: 'FTS5 / BM25', text: '精确命中关键词与原文'}, {icon: ChartScatter, title: '本地向量', text: '找到表达不同但含义相近的内容'}, {icon: Graph, title: '知识图谱', text: '沿人物、项目与事件关系扩展'}, {icon: CirclesFour, title: '时间线', text: '理解结论在何时发生、是否过期'}].map(({icon: Icon, title, text}) => <article key={title}><Icon size={22} /><div><strong>{title}</strong><p>{text}</p></div></article>)}
          </div>
          <div className="rrf-core"><div><span>RRF</span><strong>合并排序</strong><small>先 ACL 过滤<br />再召回与融合</small></div></div>
          <div className="retrieval-answer"><Quotes size={31} weight="duotone" /><span>带引用综合思考</span><h3>每个关键结论，都能回到原始证据。</h3><p>输出使用 [E#] 标记证据，并明确说明仍缺少什么信息。</p><div><span>[E1] 产品评审纪要</span><span>[E2] 会话原文</span><span>[E3] 版本记录</span></div></div>
        </div>
      </section>

      <section className="brain-agent section-shell" id="agent-memory">
        <div className="brain-agent-copy"><span>05 · Agent 交互</span><h2>记忆不只是“被搜索”<em>它会参与下一次行动。</em></h2><p>当你提出一个目标，Agent 会先识别来源与权限，再读取相关证据、判断冲突和陈旧程度，最后把经过引用的结论交给计划与工作流。</p><button className="text-link" onClick={() => navigate("/manual#workflow")}>查看动态工作流用法 <ArrowRight size={17} /></button></div>
        <div className="agent-loop">
          {[['你的目标', '自然语言与文件'], ['权限过滤', 'source_id + ACL'], ['证据召回', '全文 · 向量 · 图谱 · 时间'], ['综合思考', '引用 · 冲突 · 知识缺口'], ['计划与执行', '模型 · 技能 · 工作流'], ['经验回写', '确认后进入 Vault']].map(([title, text], index) => <article key={title}><span>0{index + 1}</span><div><strong>{title}</strong><p>{text}</p></div>{index < 5 && <ArrowRight size={18} />}</article>)}
        </div>
      </section>

      <section className="brain-privacy">
        <div className="brain-privacy-inner section-shell">
          <div className="brain-privacy-copy"><span>06 · 隐私与控制</span><h2>它先属于你，<br />才有资格帮助你。</h2><p>第二大脑核心不依赖云数据库，不默认上传本地数据，也不把笔记、凭据或遥测藏进插件。卸载插件不会删除 Vault；兼容桥接与跨网同步默认关闭。</p>
            <div>{[{icon: HardDrives, title: '本地事实源', text: 'Markdown 文件随时可读、可备份、可迁移'}, {icon: LockKey, title: '权限先于检索', text: '来源与 ACL 在召回和排序前生效'}, {icon: Fingerprint, title: '凭据安全', text: '随机生成并使用 Windows DPAPI 加密'}, {icon: CloudCheck, title: '连接由你打开', text: '云同步、兼容桥与跨网访问均为可选'}].map(({icon: Icon, title, text}) => <article key={title}><Icon size={22} weight="duotone" /><div><strong>{title}</strong><p>{text}</p></div></article>)}</div>
          </div>
          <img src="/assets/brain/local-privacy.png" alt="本地计算机边界内受到保护的第二大脑记忆 Vault" loading="lazy" decoding="async" />
        </div>
      </section>

      <section className="brain-autopilot section-shell">
        <div className="brain-autopilot-card">
          <Sparkle size={32} weight="duotone" /><span>HEALTHY SLEEP</span><h2>健康时休眠，发现退化才行动</h2><p>Doctor 只给出排序后的修复计划；Autopilot 只在漂移、陈旧、断链或索引异常时启动。候选改进在沙箱中生成，必须经过人工批准、灰度发布与可回滚审计。</p>
          <div><span><CheckCircle size={17} weight="fill" /> 黄金任务对比</span><span><CheckCircle size={17} weight="fill" /> 根因聚类</span><span><CheckCircle size={17} weight="fill" /> 人工闸门</span><span><CheckCircle size={17} weight="fill" /> 一键回滚</span></div>
        </div>
      </section>

      <section className="brain-closing section-shell">
        <div><span>把旧知识变成下一次的起点</span><h2>把你的知识带回古龙</h2><p>上传第二大脑 ZIP，系统会在隔离存储中扫描结构、聚类问题、挖掘需求，并生成可审阅的升级建议。未经确认不会自动发布。</p></div>
        <button className="button primary" onClick={() => setUploadOpen(true)}><UploadSimple size={18} /> 上传并改进古龙</button>
      </section>
      {uploadOpen && <UploadModal user={user} openAuth={openAuth} onClose={() => setUploadOpen(false)} />}
    </main>
  );
}
