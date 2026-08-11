import {
  ArrowRight,
  Brain,
  Check,
  Coins,
  File,
  ImageSquare,
  Lightning,
  LockKey,
  PaperPlaneRight,
  Paperclip,
  Sparkle,
  SpinnerGap,
  TextT,
  VideoCamera,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, formatMoney } from "../api.js";

const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_BYTES = 192 * 1024 * 1024;
const TEXT_ATTACHMENT_BYTES = 128 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json"]);

const starterPrompts = [
  "帮我把这段想法整理成可执行计划",
  "用通俗语言解释一个复杂概念",
  "把下面内容改写得更专业、更有说服力",
  "比较三种方案，并给出明确建议",
];

function byteText(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function attachmentContext(files) {
  const contexts = [];
  for (const file of files) {
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    const isText = file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension);
    if (isText && file.size <= TEXT_ATTACHMENT_BYTES) {
      const text = (await file.text()).trim().slice(0, 6_000);
      contexts.push(`\n\n[文本附件：${file.name}]\n${text}`);
    } else {
      contexts.push(`\n\n[附件：${file.name}，${byteText(file.size)}。当前免费文本模型仅收到文件信息，不读取二进制内容。]`);
    }
  }
  return contexts.join("").slice(0, 7_000);
}

function RollingUsage({ title, data }) {
  const maximum = Math.max(1, ...(data?.days || []).map((day) => day.usedFen));
  return <section className="agent-usage-card">
    <header><div><span>{data?.rollingDays || 0} DAY WINDOW</span><h3>{title}</h3></div><strong>{formatMoney(data?.usedFen || 0)}</strong></header>
    <div className="agent-usage-bars" aria-label={`${title}每日用量`}>
      {(data?.days || []).map((day) => <div key={day.date} title={`${day.date} · ${formatMoney(day.usedFen)} · ${day.calls} 次`}><i style={{ height: `${Math.max(day.usedFen ? 12 : 4, Math.round((day.usedFen / maximum) * 100))}%` }} /><span>{new Date(`${day.date}T00:00:00Z`).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</span></div>)}
    </div>
    <footer><span>滚动 {data?.rollingDays || 0} 天</span><span>{data?.calls || 0} 次调用</span></footer>
  </section>;
}

function EstimateCard({ icon: Icon, title, value, unit }) {
  return <article className="agent-estimate-card"><Icon size={25} weight="duotone" /><div><span>{title}</span>{value ? <strong>{value.minimum}–{value.maximum} {unit}</strong> : <strong>等待价格同步</strong>}<small>{value ? `已包含 30% 平台服务费` : "管理员录入 PearAPI 成本后自动计算"}</small></div></article>;
}

function AssetPanel({ bootstrap, onClose, navigate }) {
  const quota = bootstrap?.quota;
  return <div className="agent-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="agent-asset-drawer">
      <button className="modal-close" type="button" onClick={onClose}><X size={20} /></button>
      <span>MY ASSETS</span><h2>我的资产</h2><p>余额来自会员订阅与充值；PearAPI 免费文字模型不扣费，付费能力按官方成本加 30% 结算。</p>
      <div className="agent-balance-card"><div><Wallet size={29} weight="duotone" /><span>当前可用余额</span></div><strong>{formatMoney(quota?.balanceFen || 0)}</strong><small>月度会员到账后，实付金额同步成为可用余额</small></div>
      <div className="agent-estimate-grid"><EstimateCard icon={ImageSquare} title="预计可创作图片" value={quota?.estimates?.images} unit="张" /><EstimateCard icon={VideoCamera} title="预计可创作视频" value={quota?.estimates?.videos} unit="条" /></div>
      <RollingUsage title="本周滚动用量" data={quota?.weekly} />
      <RollingUsage title="本月滚动用量" data={quota?.monthly} />
      <button className="button primary full" type="button" onClick={() => { onClose(); navigate("/pricing"); }}>充值或续订 <ArrowRight size={17} /></button>
    </aside>
  </div>;
}

function SkillPanel({ onClose, setDraft }) {
  const skills = [
    ["总结提炼", "把长内容整理成重点、结论和下一步。", "请总结下面内容，并按重点、结论、下一步输出：\n"],
    ["专业改写", "优化表达、结构与说服力，不改变事实。", "请把下面内容改写得专业、清晰、有说服力：\n"],
    ["多语翻译", "调用免费翻译模型，保留语气和格式。", "请准确翻译下面内容，并保留原有格式：\n"],
    ["方案比较", "从成本、速度、风险和效果给出建议。", "请比较下面的方案，从成本、速度、风险和效果分析并给出建议：\n"],
  ];
  return <div className="agent-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="agent-skill-drawer">
      <button className="modal-close" type="button" onClick={onClose}><X size={20} /></button>
      <span>LIGHTWEIGHT CAPABILITIES</span><h2>拓展技能</h2><p>网页版只提供轻量提示能力，不加载桌面端插件、技能包、工作流、第二大脑或本地模型。</p>
      <div className="agent-skill-grid">{skills.map(([name, description, prompt]) => <button key={name} type="button" onClick={() => { setDraft(prompt); onClose(); }}><Sparkle size={23} weight="duotone" /><span><strong>{name}</strong><small>{description}</small></span><ArrowRight size={17} /></button>)}</div>
    </aside>
  </div>;
}

export function WebAgentPage({ user, openAuth, navigate, themeIcon }) {
  const [bootstrap, setBootstrap] = useState(null);
  const [loading, setLoading] = useState(Boolean(user));
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("glm-4-flash-250414");
  const [mode, setMode] = useState("fast");
  const [creationType, setCreationType] = useState("text");
  const [conversationId, setConversationId] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => {
    if (!user) { setLoading(false); setBootstrap(null); return; }
    setLoading(true);
    apiFetch("/api/agent/bootstrap").then((result) => { setBootstrap(result); setModel(result.defaultModel || "glm-4-flash-250414"); }).catch((error) => setMessage(error.message)).finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, sending]);

  const selectedModel = useMemo(() => bootstrap?.models?.find((item) => item.id === model), [bootstrap, model]);

  function pickAttachments(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    const next = [...attachments, ...files].slice(0, MAX_ATTACHMENTS);
    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_ATTACHMENT_BYTES) { setMessage("附件总大小不能超过 192 MB"); return; }
    setAttachments(next);
    setMessage("");
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    if (creationType !== "text") { setMessage("当前接入的是 PearAPI 免费文字模型；图片和视频创作会在管理员同步付费模型后开放。"); setAssetOpen(true); return; }
    if (!bootstrap?.subscription?.active) { setMessage("网页版古龙 Agent 需要生效中的会员订阅。"); return; }
    if (!bootstrap?.configured) { setMessage("管理员尚未完成 PearAPI 令牌配置，请稍后再试。"); return; }
    setSending(true); setMessage("");
    const visibleUser = { role: "user", content, createdAt: new Date().toISOString(), attachments: attachments.map((file) => ({ name: file.name, size: file.size, type: file.type })) };
    const nextMessages = [...messages, visibleUser];
    setMessages(nextMessages); setDraft(""); setAttachments([]);
    try {
      const context = await attachmentContext(attachments);
      const requestMessages = nextMessages.slice(-23).map((item, index, list) => ({ role: item.role, content: index === list.length - 1 && item.role === "user" ? `${item.content}${context}`.slice(0, 12_000) : item.content.slice(0, 12_000) }));
      const result = await apiFetch("/api/agent/chat", { method: "POST", body: JSON.stringify({ model, mode, conversationId: conversationId || undefined, messages: requestMessages }) });
      setConversationId(result.conversationId);
      setMessages((current) => [...current, { ...result.message, model: result.model, free: result.free }]);
      apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
    } catch (error) {
      setMessages((current) => current.filter((item) => item !== visibleUser));
      setDraft(content);
      setMessage(error.message);
    } finally { setSending(false); }
  }

  function keyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  }

  if (!user) return <main id="main-content" className="web-agent-page web-agent-gate section-shell"><div className="agent-gate-orb"><LockKey size={42} weight="duotone" /></div><span>GULONG WEB AGENT</span><h1>登录后进入网页版古龙</h1><p>无需配置个人 API Key。管理员统一托管 PearAPI 令牌，你只需选择免费模型并开始对话。</p><button className="button primary" type="button" onClick={() => openAuth("login")}>登录网页版入口 <ArrowRight size={18} /></button></main>;

  return <main id="main-content" className="web-agent-page">
    <div className="agent-topbar section-shell">
      <button className="agent-home" type="button" onClick={() => navigate("/")} aria-label="返回古龙官网首页"><img src={themeIcon} alt="" /><span><strong>古龙网页版</strong><small>轻量 · 安全 · 云端响应</small></span></button>
      <nav aria-label="网页版功能"><button type="button" onClick={() => setSkillOpen(true)}><Sparkle size={21} weight="duotone" />拓展技能</button><button type="button" onClick={() => setAssetOpen(true)}><Wallet size={21} weight="duotone" />我的资产</button></nav>
    </div>

    <section className="agent-workspace section-shell">
      <header className="agent-workspace-head"><div><span>PEARAPI FREE MODEL CLOUD</span><h1>今天想完成什么？</h1><p>7 个免费模型由古龙服务端统一调度；不暴露令牌，不加载第二大脑、本地模型、插件或工作流。</p></div><div className="agent-live-status"><i className={bootstrap?.configured ? "ready" : ""} /><span>{loading ? "正在连接" : bootstrap?.configured ? "PearAPI 已连接" : "等待管理员配置"}</span></div></header>

      <div className="agent-chat-shell">
        <div className="agent-chat-stream" aria-live="polite">
          {!messages.length && <div className="agent-empty-chat"><div className="agent-empty-mark"><Sparkle size={35} weight="duotone" /></div><h2>把目标交给古龙</h2><p>选择一个起点，或直接在下方描述任务。简单问题用快速响应，需要推演时切换深度思考。</p><div>{starterPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{prompt}<ArrowRight size={16} /></button>)}</div></div>}
          {messages.map((item, index) => <article className={`agent-message ${item.role}`} key={`${item.createdAt}-${index}`}><div className="agent-message-avatar">{item.role === "assistant" ? <img src={themeIcon} alt="古龙" /> : (user.displayName || user.username || "我").slice(0, 1)}</div><div><header><strong>{item.role === "assistant" ? "古龙" : "你"}</strong><time>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>{item.free && <em>免费</em>}</header><p>{item.content}</p>{item.attachments?.length > 0 && <div className="agent-message-files">{item.attachments.map((file) => <span key={file.name}><File size={15} />{file.name}</span>)}</div>}</div></article>)}
          {sending && <article className="agent-message assistant pending"><div className="agent-message-avatar"><img src={themeIcon} alt="" /></div><div><header><strong>古龙</strong><em>{mode === "deep" ? "深度思考" : "快速响应"}</em></header><p><SpinnerGap size={20} className="agent-spin" /> 正在通过 {selectedModel?.name || model} 组织答案…</p></div></article>}
          <div ref={endRef} />
        </div>

        <div className="agent-composer-wrap">
          {message && <div className="agent-inline-alert"><LockKey size={18} /><span>{message}</span><button type="button" onClick={() => setMessage("")}><X size={16} /></button></div>}
          {!bootstrap?.subscription?.active && !loading && <div className="agent-membership-gate"><div><Coins size={24} weight="duotone" /><span><strong>会员订阅尚未生效</strong><small>开通月度或年度会员后使用网页版 Agent。</small></span></div><button type="button" onClick={() => navigate("/pricing")}>查看会员 <ArrowRight size={16} /></button></div>}
          <div className="agent-mode-row"><div role="group" aria-label="响应方式"><button type="button" className={mode === "fast" ? "active" : ""} onClick={() => setMode("fast")}><Lightning size={17} weight="fill" />快速响应</button><button type="button" className={mode === "deep" ? "active" : ""} onClick={() => setMode("deep")}><Brain size={17} weight="duotone" />深度思考</button></div><span>{draft.length} / 4096</span></div>
          {attachments.length > 0 && <div className="agent-attachment-row">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><File size={16} /><b>{file.name}</b><small>{byteText(file.size)}</small><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></span>)}</div>}
          <textarea ref={inputRef} maxLength={4096} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="描述任务；上传附件后输入你的要求。Enter 发送，Shift + Enter 换行" />
          <footer>
            <label className="agent-attach-button" title="最多 12 个附件，总计 192 MB"><Paperclip size={20} /><span>附件</span><input type="file" multiple accept="image/*,video/*,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx" onChange={pickAttachments} /></label>
            <div className="agent-type-select"><span>{creationType === "text" ? <TextT size={18} /> : creationType === "image" ? <ImageSquare size={18} /> : <VideoCamera size={18} />}</span><select value={creationType} onChange={(event) => setCreationType(event.target.value)}><option value="text">文字</option><option value="image">图片（即将开放）</option><option value="video">视频（即将开放）</option></select></div>
            <div className="agent-model-select"><select value={model} onChange={(event) => setModel(event.target.value)}>{(bootstrap?.models || []).map((item) => <option value={item.id} key={item.id}>{item.name} · 免费</option>)}</select><Check size={15} weight="bold" /></div>
            <button className="agent-send-button" type="button" aria-label="发送" disabled={!draft.trim() || sending || loading} onClick={send}>{sending ? <SpinnerGap size={22} className="agent-spin" /> : <PaperPlaneRight size={22} weight="fill" />}</button>
          </footer>
          <div className="agent-composer-note"><LockKey size={14} /> PearAPI 凭据只保存在服务端加密存储中；免费 LLM 调用费用为 0 元。</div>
        </div>
      </div>
    </section>

    {assetOpen && <AssetPanel bootstrap={bootstrap} onClose={() => setAssetOpen(false)} navigate={navigate} />}
    {skillOpen && <SkillPanel onClose={() => setSkillOpen(false)} setDraft={(value) => { setDraft(value); setTimeout(() => inputRef.current?.focus(), 0); }} />}
  </main>;
}
