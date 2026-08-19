import {
  ArrowRight,
  Check,
  CheckCircle,
  Coins,
  DownloadSimple,
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
  WarningCircle,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { WandSparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch, formatMoney } from "../api.js";

const MAX_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 192 * 1024 * 1024;
const TEXT_ATTACHMENT_BYTES = 128 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json"]);
const MAX_MEDIA_REFERENCE_BYTES = 600 * 1024;
const H3_SHARED_MODEL = { id: "minimax_h3_shared", name: "MiniMaxH3共享节点", priceLabel: "0.20 元/秒 + 0.05 元/图 + 0.20 元/视频；音频免费" };
const H3_VIDEO_DURATIONS = [5, 10, 15, 30, 60];

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

function formatElapsed(milliseconds) {
  const value = Math.max(0, Number(milliseconds || 0));
  if (value < 1_000) return `${Math.max(1, Math.round(value))} 毫秒`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

function safeMarkdownHref(href) {
  const value = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(value) || value.startsWith("/") || value.startsWith("#")) return value;
  return null;
}

function MarkdownMessage({ children }) {
  return <div className="agent-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ children: label, href }) => {
        const safeHref = safeMarkdownHref(href);
        return safeHref ? <a href={safeHref} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>;
      },
      img: ({ alt }) => <span className="agent-markdown-image-note">图片：{alt || "模型返回的图片"}</span>,
    }}
  >{String(children || "")}</ReactMarkdown></div>;
}

function WorkflowTrace({ workflow, live = false }) {
  if (!workflow?.nodes?.length) return null;
  const completed = workflow.nodes.filter((node) => node.status === "completed").length;
  const failed = workflow.nodes.some((node) => node.status === "failed");
  return <section className={`agent-workflow-trace ${live ? "live" : "completed"}`} aria-label="本次回复处理流程">
    <header><div><span>RESPONSE WORKFLOW</span><strong>{live ? "正在组织回复" : "本次回复处理流程"}</strong></div><em>{completed}/{workflow.nodes.length} 节点 · {formatElapsed(workflow.totalMs)}</em></header>
    <div className="agent-workflow-track">{workflow.nodes.map((node, index) => <div className={`agent-workflow-node ${node.status}`} key={node.id}>
      <i aria-hidden="true">{node.status === "completed" ? <Check size={12} weight="bold" /> : node.status === "running" ? <SpinnerGap size={13} className="agent-spin" /> : node.status === "failed" ? <X size={12} weight="bold" /> : index + 1}</i>
      <div><strong>{node.title}</strong><span>{node.status === "completed" ? "已完成" : node.status === "running" ? "执行中" : node.status === "failed" ? "执行失败" : "等待执行"}{node.elapsedMs != null ? ` · ${formatElapsed(node.elapsedMs)}` : ""}</span>{node.detail && <small title={node.detail}>{node.detail}</small>}</div>
      {index < workflow.nodes.length - 1 && <b aria-hidden="true" />}
    </div>)}</div>
    {!live && <footer><CheckCircle size={18} weight="fill" /><span>{failed ? "流程已结束" : "全部节点处理完成"}</span><strong>总耗时 {formatElapsed(workflow.totalMs)}</strong></footer>}
  </section>;
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
  if (item.video) {
    const expired = item.video.status === "expired" || !item.video.previewPath;
    return <section className={`agent-h3-result ${expired ? "expired" : "available"}`}>
      <header><div><VideoCamera size={22} weight="duotone" /><span><strong>MiniMaxH3 共享节点视频</strong><small>{item.video.filename}</small></span></div><em>{expired ? "已过期" : "24 小时保留"}</em></header>
      {expired ? <div className="agent-h3-expired"><WarningCircle size={28} weight="duotone" /><strong>视频已过期并删除</strong><span>为保护隐私并控制存储成本，过期视频不能继续播放或下载。</span></div> : <>
        <video src={item.video.previewPath} controls preload="metadata" />
        <div className="agent-h3-retention"><WarningCircle size={21} weight="fill" /><span><strong>请尽快下载，视频将在生成完成后 24 小时自动删除。</strong><small>准确到期时间：{new Date(item.video.expiresAt).toLocaleString("zh-CN")}</small></span></div>
        <a className="button primary" href={item.video.downloadPath}><DownloadSimple size={18} weight="bold" />下载视频</a>
      </>}
    </section>;
  }
  if (item.h3Task && item.h3Task.status !== "completed") {
    const failed = ["failed", "cancelled", "rejected"].includes(item.h3Task.status);
    const progress = Math.min(99, Math.max(0, Number(item.h3Task.progress || 0)));
    return <section className={`agent-h3-progress ${failed ? "failed" : "running"}`}>
      <header><span><SpinnerGap size={20} className={failed ? "" : "agent-spin"} />{failed ? "视频任务未完成" : "共享节点正在制作视频"}</span><strong>{failed ? "已结束" : `${progress}%`}</strong></header>
      {!failed && <><div className="agent-h3-progress-track"><i style={{ width: `${Math.max(2, progress)}%` }} /></div><div className="agent-h3-progress-meta"><span>{item.h3Task.estimatedTotalSeconds ? `预计总耗时 ${Math.ceil(item.h3Task.estimatedTotalSeconds / 60)} 分钟` : "节点正在估算制作时间"}</span><span>{item.h3Task.expectedCompletedAt ? `预计完成：${new Date(item.h3Task.expectedCompletedAt).toLocaleString("zh-CN")}` : "等待节点首次耗时回调"}</span></div></>}
      <small>订单号：{item.h3Task.orderNo}{item.h3Task.progressUpdatedAt ? ` · 更新于 ${new Date(item.h3Task.progressUpdatedAt).toLocaleTimeString("zh-CN")}` : ""}</small>
    </section>;
  }
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
      <div className="agent-balance-card"><div><Wallet size={29} weight="duotone" /><span>{quota?.unlimited ? "管理员创作权限" : "当前可用余额"}</span></div><strong>{quota?.unlimited ? "不限额" : formatMoney(quota?.balanceFen || 0)}</strong><small>{quota?.unlimited ? "管理员角色调用图片和视频模型不检查额度，也不会扣减余额" : "会员实付金额与额外赠送的 10% 已合并为可用余额"}</small></div>
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
      <p>{subscription ? "当前没有生效会员或可用余额。开通月度或年度会员后，实付金额会成为创作余额，并额外赠送 10%；已有充值余额的普通用户也可以按次调用付费图片和视频模型。" : "你的会员权益仍然有效，但创作额度已经用完。单次充值满 500 元会额外赠送 10% 余额。"}</p>
      <div className="agent-quota-summary"><ShieldCheck size={21} weight="duotone" /><span><strong>{subscription ? "开通会员获得余额" : "会员无需重复开通"}</strong><small>{subscription ? "普通用户与订阅用户都按实际调用扣减余额" : "只需补充余额，原会员有效期保持不变"}</small></span></div>
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
  const [liveWorkflow, setLiveWorkflow] = useState(null);
  const [h3PromptState, setH3PromptState] = useState({ status: "idle", optimized: "" });
  const [h3OriginalPrompt, setH3OriginalPrompt] = useState("");
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const pollersRef = useRef(new Map());

  function rememberConversation(nextConversationId) {
    const value = String(nextConversationId || "");
    setConversationId(value);
    if (user?.id && value) sessionStorage.setItem(`gulong-agent-conversation:${user.id}`, value);
  }

  useEffect(() => {
    if (!user) { setLoading(false); setBootstrap(null); return; }
    setMessages([]);
    setConversationId(sessionStorage.getItem(`gulong-agent-conversation:${user.id}`) || "");
    setLoading(true);
    apiFetch("/api/agent/bootstrap").then((result) => { setBootstrap(result); setModel(result.defaultModel || "glm-4-flash-250414"); }).catch((error) => setMessage(error.message)).finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : "";
        const result = await apiFetch(`/api/h3/conversations/recent${query}`);
        if (cancelled) return;
        if (result.conversationId && result.conversationId !== conversationId) rememberConversation(result.conversationId);
        setMessages((current) => {
          const next = current.map((item) => {
            const task = result.tasks?.find((candidate) => candidate.id === item.h3TaskId);
            return task ? { ...item, h3Task: task } : item;
          });
          const knownMessages = new Set(next.map((item) => item.id).filter(Boolean));
          for (const message of result.messages || []) if (!knownMessages.has(message.id)) next.push(message);
          const knownTasks = new Set(next.map((item) => item.h3TaskId).filter(Boolean));
          for (const task of result.tasks || []) {
            if (!knownTasks.has(task.id) && task.status !== "completed") next.push({ id: `h3-progress-${task.id}`, role: "assistant", content: "MiniMaxH3共享节点任务处理进度", createdAt: task.createdAt, h3TaskId: task.id, h3Task: task });
          }
          return next;
        });
      } catch (error) {
        if (!cancelled && error.status !== 401) setMessage(error.message);
      }
    };
    void poll();
    const timer = setInterval(poll, 6_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [user?.id, conversationId]);

  useEffect(() => () => { for (const timer of pollersRef.current.values()) clearTimeout(timer); pollersRef.current.clear(); }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, sending]);

  useEffect(() => {
    if (!sending || !liveWorkflow?.operationId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await apiFetch(`/api/agent/workflows/${liveWorkflow.operationId}`);
        if (!cancelled) setLiveWorkflow(result.workflow);
      } catch (error) {
        if (!cancelled && error.status !== 404) setMessage(error.message);
      }
    };
    void poll();
    const timer = setInterval(poll, 450);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sending, liveWorkflow?.operationId]);

  const availableModels = useMemo(() => {
    if (creationType === "text") return bootstrap?.models || [];
    if (creationType === "video") return [H3_SHARED_MODEL, ...(bootstrap?.mediaModels?.video || []).filter((item) => item.id !== H3_SHARED_MODEL.id)];
    return bootstrap?.mediaModels?.[creationType] || [];
  }, [bootstrap, creationType]);
  const selectedModel = useMemo(() => availableModels.find((item) => item.id === model), [availableModels, model]);
  const isH3Video = creationType === "video" && model === H3_SHARED_MODEL.id;

  function changeCreationType(nextType) {
    setCreationType(nextType);
    setModel(nextType === "text" ? (bootstrap?.defaultModel || "glm-4-flash-250414") : nextType === "video" ? H3_SHARED_MODEL.id : (bootstrap?.mediaDefaults?.[nextType] || `auto-${nextType}`));
    if (nextType === "video") setDuration(5);
    setAttachments((current) => nextType === "text" ? current : current.filter((file) => file.type.startsWith("image/")));
    setH3PromptState({ status: "idle", optimized: "" });
    setH3OriginalPrompt("");
    setMessage("");
  }

  function changeModel(nextModel) {
    setModel(nextModel);
    if (creationType === "video") {
      if (nextModel === H3_SHARED_MODEL.id) {
        if (!H3_VIDEO_DURATIONS.includes(duration)) setDuration(5);
        setAttachments([]);
      } else if (!(bootstrap?.mediaOptions?.videoDurations || [5]).includes(duration)) setDuration(5);
    }
    setH3PromptState({ status: "idle", optimized: "" });
    setH3OriginalPrompt("");
    setMessage("");
  }

  async function optimizeH3Prompt() {
    const original = draft.trim();
    if (!isH3Video || !original || h3PromptState.status === "processing" || sending) return;
    setH3PromptState({ status: "processing", optimized: "" });
    setMessage("");
    try {
      const result = await apiFetch("/api/h3/prompts/optimize", { method: "POST", body: JSON.stringify({ prompt: original, duration_seconds: duration, aspect_ratio: aspectRatio, assets: { images: [], videos: [], audio: [] } }) });
      const optimized = String(result.authoring_prompt || result.optimized_prompt || "").trim();
      if (!optimized) throw new Error("提示词优化结果为空，请重试");
      setH3OriginalPrompt(original);
      setDraft(optimized);
      setH3PromptState({ status: "success", optimized, fallback: Boolean(result.fallback) });
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (error) {
      setH3PromptState({ status: "failed", optimized: "" });
      setMessage(error.message || "提示词优化失败，请稍后重试");
    }
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
    if (isH3Video) { setMessage("MiniMaxH3共享节点素材需要先保存为可访问的资产清单；当前网页入口先支持纯提示词视频任务，桌面 Agent 可提交完整素材。"); return; }
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
    if (creationType === "text" && !bootstrap?.subscription?.active) {
      setMessage("网页版古龙 Agent 需要生效中的会员订阅。");
      return;
    }
    if (creationType !== "text" && user.role !== "admin") {
      const balanceFen = Number(bootstrap?.quota?.balanceFen || 0);
      const durationFactor = creationType === "video" ? Math.max(1, Number(duration || 5) / 5) : 1;
      const expectedFen = isH3Video ? Number(duration || 5) * 20 : selectedModel?.chargedFen == null ? 0 : Math.ceil(Number(selectedModel.chargedFen) * durationFactor);
      if (balanceFen <= 0 || (expectedFen > 0 && balanceFen < expectedFen)) { setQuotaPrompt(bootstrap?.subscription?.active ? "recharge" : "subscription"); return; }
    }
    if (creationType === "text" && !bootstrap?.configured) { setMessage("管理员尚未完成 PearAPI 免费渠道令牌配置，请稍后再试。"); return; }
    if (creationType !== "text" && !isH3Video && !bootstrap?.mediaConfigured) { setMessage("管理员尚未完成 PearAPI Key 配置，请稍后再试。"); return; }
    setSending(true); setMessage("");
    const operationId = creationType === "text" ? `pearop_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(2)).join("_")}` : null;
    const workflowNodes = [
      { id: "understand", title: "理解任务", status: "running", elapsedMs: 0 },
      { id: "context", title: attachments.length ? "读取附件" : "整理上下文", status: "pending", elapsedMs: null },
      { id: "route", title: "匹配模型", status: "pending", elapsedMs: null },
      { id: "inference", title: creationType === "text" ? "远程推理" : "提交创作", status: "pending", elapsedMs: null },
      { id: "format", title: creationType === "text" ? "排版回复" : "生成结果", status: "pending", elapsedMs: null },
    ];
    setLiveWorkflow(operationId ? { operationId, totalMs: 0, nodes: workflowNodes } : null);
    const visibleUser = { role: "user", content: isH3Video && h3OriginalPrompt ? h3OriginalPrompt : content, createdAt: new Date().toISOString(), attachments: attachments.map((file) => ({ name: file.name, size: file.size, type: file.type })) };
    const nextMessages = [...messages, visibleUser];
    setMessages(nextMessages); setDraft(""); setAttachments([]);
    try {
      if (isH3Video) {
        const idempotencyKey = crypto.randomUUID();
        const result = await apiFetch("/api/h3/tasks", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ source_channel: "website", model: H3_SHARED_MODEL.id, prompt: content, original_prompt: h3OriginalPrompt || content, authoring_prompt: content, optimized_prompt: h3OriginalPrompt ? content : undefined, conversation_id: conversationId || undefined, aspect_ratio: aspectRatio, duration_seconds: duration, profile: "balanced", assets: { images: [], videos: [], audio: [] } }) });
        rememberConversation(result.task.conversationId);
        setH3PromptState({ status: "idle", optimized: "" });
        setH3OriginalPrompt("");
        setMessages((current) => [...current, { role: "assistant", content: `MiniMaxH3共享节点任务已创建。\n\n订单号：${result.task.orderNo}\n\n${user.role === "admin" ? "管理员免扣费，本任务不产生分佣。" : `已从余额预扣：${formatMoney(result.billing?.chargedFen ?? result.task.priceFen)}\n\n剩余余额：${formatMoney(result.billing?.remainingBalanceFen || 0)}`}\n\n状态：等待桌面节点领取。视频生成完成后会自动回到当前会话；最终失败会自动退款。`, createdAt: new Date().toISOString(), model: H3_SHARED_MODEL.id, h3TaskId: result.task.id, h3Task: { id: result.task.id, orderNo: result.task.orderNo, status: result.task.status, progress: 0, createdAt: result.task.createdAt } }]);
        apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
        return;
      }
      if (creationType !== "text") {
        const referenceImages = await Promise.all(attachments.filter((file) => file.type.startsWith("image/")).map(imageDataUrl));
        const result = await apiFetch("/api/agent/media", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({
          modality: creationType, model, prompt: content, conversationId: conversationId || undefined, referenceImages, imageSize, aspectRatio, duration,
        }) });
        rememberConversation(result.job.conversationId);
        setMessages((current) => [...current, {
          role: "assistant", content: `${result.job.modelName} 已接收创作任务${user.role === "admin" ? " · 管理员免扣额度" : ` · 已从余额预扣 ${formatMoney(result.billing?.chargedFen ?? result.job.chargedFen)}`}`, createdAt: new Date().toISOString(),
          jobId: result.job.id, modality: creationType, status: result.job.status, urls: result.job.urls, error: result.job.error,
        }]);
        if (!["succeeded", "failed"].includes(result.job.status)) pollMedia(result.job.id);
        apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
        return;
      }
      const context = await attachmentContext(attachments);
      const requestMessages = nextMessages.slice(-23).map((item, index, list) => ({ role: item.role, content: index === list.length - 1 && item.role === "user" ? `${item.content}${context}`.slice(0, 12_000) : item.content.slice(0, 12_000) }));
      const result = await apiFetch("/api/agent/chat", { method: "POST", body: JSON.stringify({ operationId, model, conversationId: conversationId || undefined, messages: requestMessages }) });
      rememberConversation(result.conversationId);
      setMessages((current) => [...current, { ...result.message, model: result.model, resolvedModel: result.resolvedModel, fallback: result.fallback, free: result.free, workflow: result.workflow }]);
      apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
    } catch (error) {
      setMessages((current) => current.filter((item) => item !== visibleUser));
      setDraft(content);
      if (creationType !== "text" && error.code === "SUBSCRIPTION_REQUIRED") setQuotaPrompt("subscription");
      else if (creationType !== "text" && error.code === "INSUFFICIENT_BALANCE") setQuotaPrompt("recharge");
      else setMessage(error.message);
    } finally { setSending(false); setLiveWorkflow(null); }
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
      <header className="agent-workspace-head"><div><span>PEARAPI FREE MODEL CLOUD</span><h1>今天想完成什么？</h1><p>7 个免费模型由古龙服务端统一调度；每次回复展示实时处理节点，不加载第二大脑、本地模型、插件或扩展工作流。</p></div><div className="agent-live-status"><i className={bootstrap?.configured ? "ready" : ""} /><span>{loading ? "正在连接" : bootstrap?.configured ? "远程模型已连接" : "等待管理员配置"}</span></div></header>

      <div className="agent-chat-shell">
        <div className="agent-chat-stream" aria-live="polite">
          {!messages.length && <div className="agent-empty-chat"><div className="agent-empty-mark"><Sparkle size={35} weight="duotone" /></div><h2>把目标交给古龙</h2><p>选择文字、图片或视频，挑选模型并描述你想完成的结果。</p><div>{starterPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{prompt}<ArrowRight size={16} /></button>)}</div></div>}
          {messages.map((item, index) => <article className={`agent-message ${item.role}`} key={`${item.createdAt}-${index}`}><div className="agent-message-avatar">{item.role === "assistant" ? <img src={themeIcon} alt="古龙" /> : (user.displayName || user.username || "我").slice(0, 1)}</div><div><header><strong>{item.role === "assistant" ? "古龙" : "你"}</strong><time>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>{item.free && <em>免费</em>}{item.fallback && <em>已切换备用模型</em>}</header>{item.role === "assistant" ? <MarkdownMessage>{item.content}</MarkdownMessage> : <p>{item.content}</p>}<WorkflowTrace workflow={item.workflow} /><MediaResult item={item} />{item.attachments?.length > 0 && <div className="agent-message-files">{item.attachments.map((file) => <span key={file.name}><File size={15} />{file.name}</span>)}</div>}</div></article>)}
          {sending && <article className="agent-message assistant pending"><div className="agent-message-avatar"><img src={themeIcon} alt="" /></div><div><header><strong>古龙</strong><em>{creationType === "text" ? "文字" : creationType === "image" ? "图片" : "视频"}</em></header>{creationType === "text" && <WorkflowTrace workflow={liveWorkflow} live />}<p><SpinnerGap size={20} className="agent-spin" /> 正在通过 {selectedModel?.name || model} 处理任务…</p></div></article>}
          <div ref={endRef} />
        </div>

        <div className="agent-composer-wrap">
          {message && <div className="agent-inline-alert"><LockKey size={18} /><span>{message}</span><button type="button" onClick={() => setMessage("")}><X size={16} /></button></div>}
          {!bootstrap?.subscription?.active && !loading && <div className="agent-membership-gate"><div><Coins size={24} weight="duotone" /><span><strong>会员订阅尚未生效</strong><small>免费文字对话需开通会员；付费图片与视频可使用已有余额按次创作。</small></span></div><button type="button" onClick={() => navigate("/pricing")}>查看会员 <ArrowRight size={16} /></button></div>}
          <div className="agent-mode-row"><div className="agent-creation-hint">{creationType === "text" ? "免费文字对话" : isH3Video ? `${formatMoney(Number(duration || 0) * 20)} · MiniMaxH3共享节点预估价` : (selectedModel?.priceLabel || "按实际模型计费")}</div><span>{draft.length} / {isH3Video ? 20000 : 4096}</span></div>
          {attachments.length > 0 && <div className="agent-attachment-row">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><File size={16} /><b>{file.name}</b><small>{byteText(file.size)}</small><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></span>)}</div>}
          <textarea ref={inputRef} maxLength={isH3Video ? 20000 : 4096} value={draft} onChange={(event) => { const next = event.target.value; setDraft(next); if (h3PromptState.status === "success" && next !== h3PromptState.optimized) { setH3PromptState({ status: "idle", optimized: "" }); setH3OriginalPrompt(""); } }} onKeyDown={keyDown} placeholder="描述任务；上传附件后输入你的要求。Enter 发送，Shift + Enter 换行" />
          <footer>
            <label className="agent-attach-button" title={creationType === "text" ? "最多 12 个附件" : isH3Video ? "完整素材请从桌面 Agent 提交" : "上传参考图，每张不超过 600 KB"}><Paperclip size={20} /><span>{creationType === "text" ? "附件" : isH3Video ? "桌面素材" : "参考图"}</span><input type="file" multiple accept={creationType === "text" ? "image/*,video/*,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx" : "image/jpeg,image/png,image/webp"} onChange={pickAttachments} /></label>
            <div className="agent-type-select"><span>{creationType === "text" ? <TextT size={18} /> : creationType === "image" ? <ImageSquare size={18} /> : <VideoCamera size={18} />}</span><select value={creationType} onChange={(event) => changeCreationType(event.target.value)}><option value="text">文字</option><option value="image">图片</option><option value="video">视频</option></select></div>
            {creationType === "image" && <div className="agent-parameter-select"><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>{(bootstrap?.mediaOptions?.imageSizes || ["1:1"]).map((value) => <option key={value} value={value}>{value}</option>)}</select></div>}
            {creationType === "video" && <><div className="agent-parameter-select"><select value={aspectRatio} onChange={(event) => { setAspectRatio(event.target.value); setH3PromptState({ status: "idle", optimized: "" }); setH3OriginalPrompt(""); }}><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option></select></div><div className="agent-parameter-select"><select value={duration} onChange={(event) => { setDuration(Number(event.target.value)); setH3PromptState({ status: "idle", optimized: "" }); setH3OriginalPrompt(""); }}>{(isH3Video ? H3_VIDEO_DURATIONS : bootstrap?.mediaOptions?.videoDurations || [5]).map((value) => <option key={value} value={value}>{value} 秒</option>)}</select></div>{isH3Video && <button className={`agent-h3-magic ${h3PromptState.status}`} type="button" onClick={optimizeH3Prompt} disabled={!draft.trim() || sending || h3PromptState.status === "processing"} aria-label="魔法提示词优化" title="魔法提示词优化">{h3PromptState.status === "processing" ? <SpinnerGap size={18} className="agent-spin" /> : <WandSparkles size={18} aria-hidden="true" />}<span>{h3PromptState.status === "processing" ? "优化中" : h3PromptState.status === "success" ? "已优化" : h3PromptState.status === "failed" ? "重试" : "魔法优化"}</span></button>}</>}
            <div className="agent-model-select"><select value={model} onChange={(event) => changeModel(event.target.value)}>{availableModels.map((item) => <option value={item.id} key={item.id}>{item.name}{creationType === "text" ? " · 免费" : ` · ${item.priceLabel}`}</option>)}</select><Check size={15} weight="bold" /></div>
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
