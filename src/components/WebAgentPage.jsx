import {
  ArrowRight,
  Check,
  Coins,
  File,
  ImageSquare,
  LockKey,
  PaperPlaneRight,
  Paperclip,
  ShieldCheck,
  Sparkle,
  SpinnerGap,
  TextT,
  VideoCamera,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, formatMoney } from "../api.js";

const MAX_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 192 * 1024 * 1024;
const TEXT_ATTACHMENT_BYTES = 128 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json"]);
const MAX_MEDIA_REFERENCE_BYTES = 600 * 1024;

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

async function imageDataUrl(file) {
  if (!file.type.match(/^image\/(jpeg|png|webp)$/i)) throw new Error("参考图仅支持 JPEG、PNG 或 WebP 格式");
  if (file.size > MAX_MEDIA_REFERENCE_BYTES) throw new Error("单张参考图不能超过 600 KB，请压缩后重试");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取参考图 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function MediaResult({ item }) {
  if (item.status === "processing") return <div className="agent-media-pending"><SpinnerGap size={21} className="agent-spin" /><span>任务已进入 PearAPI 队列，正在创作…</span></div>;
  if (item.status === "failed") return <div className="agent-media-error">生成失败，费用已退回：{item.error}</div>;
  if (!item.urls?.length) return null;
  return <div className="agent-media-results">{item.urls.map((url) => item.modality === "video"
    ? <video key={url} src={url} controls preload="metadata" />
    : <a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} alt={item.content || "古龙生成图片"} /></a>)}</div>;
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
  return <article className="agent-estimate-card"><Icon size={25} weight="duotone" /><div><span>{title}</span>{value ? <strong>{value.minimum}–{value.maximum} {unit}</strong> : <strong>等待价格同步</strong>}{!value && <small>管理员录入 PearAPI 成本后自动计算</small>}</div></article>;
}

function AssetPanel({ bootstrap, onClose, navigate }) {
  const quota = bootstrap?.quota;
  return <div className="agent-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="agent-asset-drawer">
      <button className="modal-close" type="button" onClick={onClose}><X size={20} /></button>
      <span>REMAINING USAGE</span><h2>剩余用量</h2><p>查看当前余额、预计创作数量和滚动用量记录。</p>
      <div className="agent-balance-card"><div><Wallet size={29} weight="duotone" /><span>{quota?.unlimited ? "管理员创作权限" : "当前可用余额"}</span></div><strong>{quota?.unlimited ? "不限额" : formatMoney(quota?.balanceFen || 0)}</strong><small>{quota?.unlimited ? "管理员角色调用图片和视频模型不检查额度，也不会扣减余额" : "月度会员到账后，实付金额同步成为可用余额"}</small></div>
      {!quota?.unlimited && <div className="agent-estimate-grid"><EstimateCard icon={ImageSquare} title="预计可创作图片" value={quota?.estimates?.images} unit="张" /><EstimateCard icon={VideoCamera} title="预计可创作视频" value={quota?.estimates?.videos} unit="条" /></div>}
      <RollingUsage title="本周滚动用量" data={quota?.weekly} />
      <RollingUsage title="本月滚动用量" data={quota?.monthly} />
      {bootstrap?.assets?.length > 0 && <section className="agent-recent-assets"><header><span>RECENT CREATIONS</span><h3>最近创作</h3></header><div>{bootstrap.assets.map((asset) => <article key={asset.id}>{asset.modality === "video" ? <video src={asset.urls?.[0]} controls preload="metadata" /> : <a href={asset.urls?.[0]} target="_blank" rel="noreferrer"><img src={asset.urls?.[0]} alt={asset.prompt} /></a>}<strong>{asset.modelName}</strong><small>{asset.prompt}</small></article>)}</div></section>}
      <button className="button primary full" type="button" onClick={() => { onClose(); navigate("/pricing"); }}>充值或续订 <ArrowRight size={17} /></button>
    </aside>
  </div>;
}

function QuotaPrompt({ kind, onClose, navigate }) {
  const subscription = kind === "subscription";
  return <div className="modal-backdrop agent-quota-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="agent-quota-modal" role="dialog" aria-modal="true" aria-labelledby="agent-quota-title">
      <button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
      <div className="agent-quota-icon">{subscription ? <Coins size={34} weight="duotone" /> : <Wallet size={34} weight="duotone" />}</div>
      <span>{subscription ? "MEMBERSHIP REQUIRED" : "USAGE EXHAUSTED"}</span>
      <h2 id="agent-quota-title">{subscription ? "开通会员后开始创作" : "当前可用额度已用完"}</h2>
      <p>{subscription ? "图片和视频模型仅向已开通会员的用户开放。选择适合你的会员套餐，到账后即可开始创作。" : "你的会员权益仍然有效，但创作额度已经用完。充值余额后即可继续调用图片和视频模型。"}</p>
      <div className="agent-quota-summary"><ShieldCheck size={21} weight="duotone" /><span><strong>{subscription ? "先开通会员" : "会员无需重复开通"}</strong><small>{subscription ? "月度或年度会员均可使用媒体创作" : "只需补充余额，原会员有效期保持不变"}</small></span></div>
      <div className="agent-quota-actions"><button className="button secondary" type="button" onClick={onClose}>暂不处理</button><button className="button primary" type="button" onClick={() => { onClose(); navigate("/pricing"); }}>{subscription ? "查看会员套餐" : "立即充值"}<ArrowRight size={17} /></button></div>
    </section>
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
  const [creationType, setCreationType] = useState("text");
  const [imageSize, setImageSize] = useState("1:1");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [duration, setDuration] = useState(5);
  const [conversationId, setConversationId] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [quotaPrompt, setQuotaPrompt] = useState("");
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const pollersRef = useRef(new Map());

  useEffect(() => {
    if (!user) { setLoading(false); setBootstrap(null); return; }
    setLoading(true);
    apiFetch("/api/agent/bootstrap").then((result) => { setBootstrap(result); setModel(result.defaultModel || "glm-4-flash-250414"); }).catch((error) => setMessage(error.message)).finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => () => { for (const timer of pollersRef.current.values()) clearTimeout(timer); pollersRef.current.clear(); }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, sending]);

  const availableModels = useMemo(() => creationType === "text" ? (bootstrap?.models || []) : (bootstrap?.mediaModels?.[creationType] || []), [bootstrap, creationType]);
  const selectedModel = useMemo(() => availableModels.find((item) => item.id === model), [availableModels, model]);

  function changeCreationType(nextType) {
    setCreationType(nextType);
    setModel(nextType === "text" ? (bootstrap?.defaultModel || "glm-4-flash-250414") : (bootstrap?.mediaDefaults?.[nextType] || `auto-${nextType}`));
    setAttachments((current) => nextType === "text" ? current : current.filter((file) => file.type.startsWith("image/")));
    setMessage("");
  }

  function pollMedia(jobId) {
    if (!jobId || pollersRef.current.has(jobId)) return;
    const tick = async () => {
      try {
        const result = await apiFetch(`/api/agent/media/${jobId}`);
        const job = result.job;
        setMessages((current) => current.map((item) => item.jobId === jobId ? { ...item, status: job.status, urls: job.urls, error: job.error, content: job.status === "succeeded" ? `${job.modelName} 创作完成` : item.content } : item));
        if (["succeeded", "failed"].includes(job.status)) {
          pollersRef.current.delete(jobId);
          apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
          return;
        }
      } catch (error) { setMessage(error.message); }
      const timer = setTimeout(tick, 5_000);
      pollersRef.current.set(jobId, timer);
    };
    pollersRef.current.set(jobId, setTimeout(tick, 4_000));
  }

  function pickAttachments(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (creationType !== "text") {
      if (files.some((file) => !file.type.match(/^image\/(jpeg|png|webp)$/i))) { setMessage("参考图仅支持 JPEG、PNG 或 WebP 格式"); return; }
      if (files.some((file) => file.size > MAX_MEDIA_REFERENCE_BYTES)) { setMessage("单张参考图不能超过 600 KB，请压缩后重试"); return; }
    }
    const next = [...attachments, ...files].slice(0, MAX_ATTACHMENTS);
    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_ATTACHMENT_BYTES) { setMessage("附件总大小不能超过 192 MB"); return; }
    setAttachments(next);
    setMessage("");
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    if (!bootstrap?.subscription?.active) {
      if (creationType === "text") setMessage("网页版古龙 Agent 需要生效中的会员订阅。");
      else setQuotaPrompt("subscription");
      return;
    }
    if (creationType !== "text" && user.role !== "admin") {
      const balanceFen = Number(bootstrap?.quota?.balanceFen || 0);
      const durationFactor = creationType === "video" ? Math.max(1, Number(duration || 5) / 5) : 1;
      const expectedFen = selectedModel?.chargedFen == null ? 0 : Math.ceil(Number(selectedModel.chargedFen) * durationFactor);
      if (balanceFen <= 0 || (expectedFen > 0 && balanceFen < expectedFen)) { setQuotaPrompt("recharge"); return; }
    }
    if (creationType === "text" && !bootstrap?.configured) { setMessage("管理员尚未完成 PearAPI 免费渠道令牌配置，请稍后再试。"); return; }
    if (creationType !== "text" && !bootstrap?.mediaConfigured) { setMessage("管理员尚未完成 PearAPI Key 配置，请稍后再试。"); return; }
    setSending(true); setMessage("");
    const visibleUser = { role: "user", content, createdAt: new Date().toISOString(), attachments: attachments.map((file) => ({ name: file.name, size: file.size, type: file.type })) };
    const nextMessages = [...messages, visibleUser];
    setMessages(nextMessages); setDraft(""); setAttachments([]);
    try {
      if (creationType !== "text") {
        const referenceImages = await Promise.all(attachments.filter((file) => file.type.startsWith("image/")).map(imageDataUrl));
        const result = await apiFetch("/api/agent/media", { method: "POST", body: JSON.stringify({
          modality: creationType, model, prompt: content, conversationId: conversationId || undefined, referenceImages, imageSize, aspectRatio, duration,
        }) });
        setConversationId(result.job.conversationId);
        setMessages((current) => [...current, {
          role: "assistant", content: `${result.job.modelName} 已接收创作任务`, createdAt: new Date().toISOString(),
          jobId: result.job.id, modality: creationType, status: result.job.status, urls: result.job.urls, error: result.job.error,
        }]);
        if (!["succeeded", "failed"].includes(result.job.status)) pollMedia(result.job.id);
        apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
        return;
      }
      const context = await attachmentContext(attachments);
      const requestMessages = nextMessages.slice(-23).map((item, index, list) => ({ role: item.role, content: index === list.length - 1 && item.role === "user" ? `${item.content}${context}`.slice(0, 12_000) : item.content.slice(0, 12_000) }));
      const result = await apiFetch("/api/agent/chat", { method: "POST", body: JSON.stringify({ model, conversationId: conversationId || undefined, messages: requestMessages }) });
      setConversationId(result.conversationId);
      setMessages((current) => [...current, { ...result.message, model: result.model, resolvedModel: result.resolvedModel, fallback: result.fallback, free: result.free }]);
      apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
    } catch (error) {
      setMessages((current) => current.filter((item) => item !== visibleUser));
      setDraft(content);
      if (creationType !== "text" && error.code === "SUBSCRIPTION_REQUIRED") setQuotaPrompt("subscription");
      else if (creationType !== "text" && error.code === "INSUFFICIENT_BALANCE") setQuotaPrompt("recharge");
      else setMessage(error.message);
    } finally { setSending(false); }
  }

  function keyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  }

  if (!user) return <main id="main-content" className="web-agent-page web-agent-gate section-shell"><div className="agent-gate-orb"><LockKey size={42} weight="duotone" /></div><span>GULONG WEB AGENT</span><h1>登录后进入网页版古龙</h1><p>无需配置个人 API Key。管理员统一托管 PearAPI 令牌，你只需选择免费模型并开始对话。</p><button className="button primary" type="button" onClick={() => openAuth("login")}>登录网页版入口 <ArrowRight size={18} /></button></main>;

  return <main id="main-content" className="web-agent-page">
    <div className="agent-topbar section-shell">
      <div className="agent-home-cluster"><button className="agent-home" type="button" onClick={() => navigate("/")} aria-label="返回古龙官网首页"><img src={themeIcon} alt="" /><span><strong>古龙网页版</strong><small>轻量 · 安全 · 云端响应</small></span></button><a href="/" onClick={(event) => { event.preventDefault(); navigate("/"); }}>返回官网 <ArrowRight size={15} /></a></div>
      <nav aria-label="网页版功能"><button type="button" onClick={() => setSkillOpen(true)}><Sparkle size={21} weight="duotone" />拓展技能</button><button type="button" onClick={() => setAssetOpen(true)}><Wallet size={21} weight="duotone" />剩余用量</button></nav>
    </div>

    <section className="agent-workspace section-shell">
      <header className="agent-workspace-head"><div><span>PEARAPI FREE MODEL CLOUD</span><h1>今天想完成什么？</h1><p>7 个免费模型由古龙服务端统一调度；不暴露令牌，不加载第二大脑、本地模型、插件或工作流。</p></div><div className="agent-live-status"><i className={bootstrap?.configured ? "ready" : ""} /><span>{loading ? "正在连接" : bootstrap?.configured ? "远程模型已连接" : "等待管理员配置"}</span></div></header>

      <div className="agent-chat-shell">
        <div className="agent-chat-stream" aria-live="polite">
          {!messages.length && <div className="agent-empty-chat"><div className="agent-empty-mark"><Sparkle size={35} weight="duotone" /></div><h2>把目标交给古龙</h2><p>选择文字、图片或视频，挑选模型并描述你想完成的结果。</p><div>{starterPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{prompt}<ArrowRight size={16} /></button>)}</div></div>}
          {messages.map((item, index) => <article className={`agent-message ${item.role}`} key={`${item.createdAt}-${index}`}><div className="agent-message-avatar">{item.role === "assistant" ? <img src={themeIcon} alt="古龙" /> : (user.displayName || user.username || "我").slice(0, 1)}</div><div><header><strong>{item.role === "assistant" ? "古龙" : "你"}</strong><time>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>{item.free && <em>免费</em>}{item.fallback && <em>已切换备用模型</em>}</header><p>{item.content}</p><MediaResult item={item} />{item.attachments?.length > 0 && <div className="agent-message-files">{item.attachments.map((file) => <span key={file.name}><File size={15} />{file.name}</span>)}</div>}</div></article>)}
          {sending && <article className="agent-message assistant pending"><div className="agent-message-avatar"><img src={themeIcon} alt="" /></div><div><header><strong>古龙</strong><em>{creationType === "text" ? "文字" : creationType === "image" ? "图片" : "视频"}</em></header><p><SpinnerGap size={20} className="agent-spin" /> 正在通过 {selectedModel?.name || model} 提交任务…</p></div></article>}
          <div ref={endRef} />
        </div>

        <div className="agent-composer-wrap">
          {message && <div className="agent-inline-alert"><LockKey size={18} /><span>{message}</span><button type="button" onClick={() => setMessage("")}><X size={16} /></button></div>}
          {!bootstrap?.subscription?.active && !loading && <div className="agent-membership-gate"><div><Coins size={24} weight="duotone" /><span><strong>会员订阅尚未生效</strong><small>开通月度或年度会员后使用网页版 Agent。</small></span></div><button type="button" onClick={() => navigate("/pricing")}>查看会员 <ArrowRight size={16} /></button></div>}
          <div className="agent-mode-row"><div className="agent-creation-hint">{creationType === "text" ? "免费文字对话" : (selectedModel?.priceLabel || "按实际模型计费")}</div><span>{draft.length} / 4096</span></div>
          {attachments.length > 0 && <div className="agent-attachment-row">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><File size={16} /><b>{file.name}</b><small>{byteText(file.size)}</small><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></span>)}</div>}
          <textarea ref={inputRef} maxLength={4096} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="描述任务；上传附件后输入你的要求。Enter 发送，Shift + Enter 换行" />
          <footer>
            <label className="agent-attach-button" title={creationType === "text" ? "最多 12 个附件" : "上传参考图，每张不超过 600 KB"}><Paperclip size={20} /><span>{creationType === "text" ? "附件" : "参考图"}</span><input type="file" multiple accept={creationType === "text" ? "image/*,video/*,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx" : "image/jpeg,image/png,image/webp"} onChange={pickAttachments} /></label>
            <div className="agent-type-select"><span>{creationType === "text" ? <TextT size={18} /> : creationType === "image" ? <ImageSquare size={18} /> : <VideoCamera size={18} />}</span><select value={creationType} onChange={(event) => changeCreationType(event.target.value)}><option value="text">文字</option><option value="image">图片</option><option value="video">视频</option></select></div>
            {creationType === "image" && <div className="agent-parameter-select"><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>{(bootstrap?.mediaOptions?.imageSizes || ["1:1"]).map((value) => <option key={value} value={value}>{value}</option>)}</select></div>}
            {creationType === "video" && <><div className="agent-parameter-select"><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option></select></div><div className="agent-parameter-select"><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{(bootstrap?.mediaOptions?.videoDurations || [5]).map((value) => <option key={value} value={value}>{value} 秒</option>)}</select></div></>}
            <div className="agent-model-select"><select value={model} onChange={(event) => setModel(event.target.value)}>{availableModels.map((item) => <option value={item.id} key={item.id}>{item.name}{creationType === "text" ? " · 免费" : ` · ${item.priceLabel}`}</option>)}</select><Check size={15} weight="bold" /></div>
            <button className="agent-send-button" type="button" aria-label="发送" disabled={!draft.trim() || sending || loading} onClick={send}>{sending ? <SpinnerGap size={22} className="agent-spin" /> : <PaperPlaneRight size={22} weight="fill" />}</button>
          </footer>
        </div>
      </div>
    </section>

    {assetOpen && <AssetPanel bootstrap={bootstrap} onClose={() => setAssetOpen(false)} navigate={navigate} />}
    {skillOpen && <SkillPanel onClose={() => setSkillOpen(false)} setDraft={(value) => { setDraft(value); setTimeout(() => inputRef.current?.focus(), 0); }} />}
    {quotaPrompt && <QuotaPrompt kind={quotaPrompt} onClose={() => setQuotaPrompt("")} navigate={navigate} />}
  </main>;
}
