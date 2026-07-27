import {
  ArrowCounterClockwise,
  Brain,
  CheckCircle,
  Circle,
  CirclesThreePlus,
  Code,
  ImageSquare,
  ListBullets,
  Paperclip,
  PaperPlaneTilt,
  Play,
  PuzzlePiece,
  UserCircle,
} from "@phosphor-icons/react";

const navItems = [
  [CirclesThreePlus, "会话任务", true],
  [ImageSquare, "超能作图"],
  [Play, "视频创作"],
  [PuzzlePiece, "拓展技能"],
  [Brain, "第二大脑"],
];

const taskSteps = [
  ["开始", "completed"],
  ["理解与规划", "completed"],
  ["执行：生成详情文案", "running"],
  ["生成配图素材", "waiting"],
  ["排版与导出", "waiting"],
];

export function ProductDemo({ themeIcon }) {
  return (
    <div className="product-demo" aria-label="古龙软件浅色主题演示">
      <aside className="demo-sidebar">
        <img src={themeIcon} alt="古龙" />
        <div className="demo-health"><span /> 服务健康</div>
        <nav>
          {navItems.map(([Icon, label, active]) => (
            <button className={active ? "active" : ""} type="button" key={label}>
              <Icon size={16} weight={active ? "fill" : "regular"} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="demo-user"><UserCircle size={24} /><span><strong>访客</strong><small>尚未登录</small></span></div>
      </aside>

      <div className="demo-workflows">
        <div className="demo-panel-heading">
          <div><strong>工作流</strong><small>点击后直接加载并启动</small></div>
          <span>2</span>
        </div>
        <label className="demo-search">按名称或描述搜索工作流</label>
        <article className="demo-flow-card selected">
          <span className="flow-icon"><CirclesThreePlus size={16} /></span>
          <div><strong>智能任务组装</strong><small>自动匹配插件、技能与模型，并行执行并保留恢复点。</small></div>
          <em>已启用</em>
        </article>
        <article className="demo-flow-card">
          <span className="flow-icon gold"><ImageSquare size={16} /></span>
          <div><strong>商品详情图</strong><small>生成高质量文案、配图与完整交付文件。</small></div>
          <em>可配置</em>
        </article>
      </div>

      <section className="demo-conversation">
        <div className="demo-conversation-head">
          <div><strong>今天想完成什么？</strong><small>古龙会规划、执行，并持续汇报进度。</small></div>
          <div className="demo-head-actions"><button><ListBullets size={14} /> 会话记录</button><button><ArrowCounterClockwise size={14} /> 恢复数据</button></div>
        </div>
        <div className="demo-message">
          <img src={themeIcon} alt="" />
          <div><time>助手 · 10:30</time><p>你好，我是古龙。告诉我你想完成的任务，我会规划、执行，并持续汇报进度。</p></div>
        </div>
        <div className="demo-composer">
          <p>描述任务；上传附件后输入 @ 可指定图片、视频或文件</p>
          <div><button><Paperclip size={15} /> 附件</button><span>创作类型　文字</span><button className="send"><PaperPlaneTilt size={16} weight="fill" /></button></div>
          <small>MiniMax-M3</small>
        </div>
      </section>

      <aside className="demo-progress">
        <div className="demo-panel-heading">
          <div><strong>任务进度</strong><small>自动更新执行 DAG</small></div>
          <span>就绪</span>
        </div>
        <div className="progress-list">
          {taskSteps.map(([label, state]) => (
            <div className={`progress-step ${state}`} key={label}>
              <span>{state === "completed" ? <CheckCircle size={18} weight="fill" /> : state === "running" ? <Code size={16} /> : <Circle size={16} />}</span>
              <div><strong>{label}</strong><small>{state === "completed" ? "已完成" : state === "running" ? "进行中 · 42%" : "等待中"}</small></div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
