import {
  ArrowRight,
  Check,
  CheckCircle,
  ChatCircleDots,
  Coins,
  DownloadSimple,
  Eye,
  File,
  ImageSquare,
  LockKey,
  MagicWand,
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch, createClientRequestId, formatMoney } from "../api.js";
import {
  H3_ASSET_LIMITS,
  calculateH3ClientPriceFen,
  clampH3AssetSelection,
  h3AssetCounts,
  h3AssetDescriptor,
  h3AssetManifest,
  h3AssetReferences,
  h3ReferenceQuery,
  removeH3AssetAndRemapReferences,
  replaceH3ReferenceQuery,
  uploadH3AssetFiles,
  validateH3AssetSelection,
} from "../h3-assets.js";

const MAX_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 192 * 1024 * 1024;
const TEXT_ATTACHMENT_BYTES = 128 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json"]);
const H3_SHARED_MODEL = { id: "minimax_h3_shared", name: "MiniMaxH3共享节点", priceLabel: "0.20 元/秒 + 0.05 元/图 + 0.20 元/视频；音频免费" };
const H3_VIDEO_DURATIONS = Array.from({ length: 15 }, (_, index) => index + 1);
const H3_VIDEO_MODES = [
  { id: "all_reference", label: "全能参考" },
  { id: "first_last", label: "首尾帧" },
  { id: "smart_multiframe", label: "智能多帧" },
  { id: "extended", label: "超长视频" },
];
const H3_VIDEO_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const H3_VIDEO_RESOLUTIONS = [
  { label: "720P", profile: "official_max" },
  { label: "1080P", profile: "ultra1080" },
  { label: "2K极速", profile: "fast2k" },
];
const H3_SAMPLING_STEPS = [4, 8, 20];
const H3_ASSET_PICKERS = [
  { kind: "image", label: "图片", accept: "image/jpeg,image/png,image/webp,image/gif" },
  { kind: "video", label: "视频", accept: "video/mp4,video/webm,video/quicktime" },
  { kind: "audio", label: "音频", accept: "audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/ogg,audio/webm" },
];

function splitH3PromptSegments(value) {
  return String(value || "").trim().split(/\r?\n\s*\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

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

function AttachmentThumbnail({ file, reference = "" }) {
  const descriptor = h3AssetDescriptor(file);
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (descriptor?.kind !== "image" || typeof globalThis.URL?.createObjectURL !== "function") { setPreviewUrl(""); return undefined; }
    const url = globalThis.URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => globalThis.URL.revokeObjectURL(url);
  }, [file, descriptor?.kind]);
  return <span className={`agent-attachment-thumbnail ${descriptor?.kind || "file"}`} aria-hidden="true">
    {previewUrl ? <img src={previewUrl} alt="" /> : descriptor?.kind === "video" ? <VideoCamera size={22} weight="duotone" /> : descriptor?.kind === "image" ? <ImageSquare size={22} weight="duotone" /> : <File size={21} weight="duotone" />}
    {reference && <b>{reference.replace("@", "")}</b>}
  </span>;
}

function matchingH3References(references, picker) {
  if (!picker) return [];
  const query = String(picker.query || "").trim().toLocaleLowerCase("zh-CN");
  return references.filter((item) => !query
    || item.reference.slice(1).toLocaleLowerCase("zh-CN").includes(query)
    || item.file.name.toLocaleLowerCase("zh-CN").includes(query));
}

function H3ReferencePicker({ items, activeIndex = 0, onSelect }) {
  if (!items.length) return null;
  return <div className="agent-reference-picker" role="listbox" aria-label="选择要引用的素材">
    <header><strong>选择参考素材</strong><span>方向键选择，Enter 插入</span></header>
    <div>{items.map((item, index) => <button type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} key={`${item.reference}-${item.file.name}`} onMouseDown={(event) => { event.preventDefault(); onSelect(item); }}>
      <AttachmentThumbnail file={item.file} reference={item.reference} />
      <span><strong>{item.reference}</strong><small>{item.file.name}</small></span>
    </button>)}</div>
  </div>;
}

function DraftPreviewEditor({ value, setValue, maxLength, references, onClose }) {
  const textareaRef = useRef(null);
  const [picker, setPicker] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const suggestions = useMemo(() => matchingH3References(references, picker), [references, picker]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  function syncPicker(nextValue, caret) {
    const nextPicker = references.length ? h3ReferenceQuery(nextValue, caret) : null;
    setPicker(nextPicker);
    setActiveIndex(0);
  }

  function selectReference(item) {
    if (!picker) return;
    const next = replaceH3ReferenceQuery(value, picker, item.reference);
    setValue(next.value); setPicker(null);
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(next.caret, next.caret); });
  }

  function keyDown(event) {
    if (picker && suggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (current + direction + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectReference(suggestions[activeIndex] || suggestions[0]); return; }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (picker) setPicker(null); else onClose();
    }
  }

  return <div className="agent-draft-preview-backdrop">
    <section className="agent-draft-preview" role="dialog" aria-modal="true" aria-labelledby="agent-draft-preview-title">
      <header><div><span>FULL SCREEN EDITOR</span><h2 id="agent-draft-preview-title">提示词预览与编辑</h2><p>大屏检查长文本并直接修改；输入 @ 可选择当前参考素材。</p></div><div><strong>{value.length} / {maxLength}</strong><button className="modal-close" type="button" aria-label="关闭全屏预览" onClick={onClose}><X size={21} /></button></div></header>
      {references.length > 0 && <div className="agent-draft-reference-strip">{references.map((item) => <span key={`${item.reference}-${item.file.name}`}><AttachmentThumbnail file={item.file} reference={item.reference} /><b>{item.reference}</b><small>{item.file.name}</small></span>)}</div>}
      <div className="agent-draft-editor-area">
        <textarea ref={textareaRef} autoFocus maxLength={maxLength} value={value} onChange={(event) => { setValue(event.target.value); syncPicker(event.target.value, event.target.selectionStart); }} onClick={(event) => syncPicker(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={keyDown} placeholder="在这里查看并编辑完整任务说明……" />
        {picker && <H3ReferencePicker items={suggestions} activeIndex={activeIndex} onSelect={selectReference} />}
      </div>
      <footer><span>编辑内容会实时同步回对话框。Esc 返回，输入 @ 可引用素材。</span><button className="button primary" type="button" onClick={onClose}><Check size={18} weight="bold" />完成编辑</button></footer>
    </section>
  </div>;
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
    const optimizingPrompt = item.h3Task.progressStage === "prompt_optimization";
    return <section className={`agent-h3-progress ${failed ? "failed" : "running"}`}>
      <header><span><SpinnerGap size={20} className={failed ? "" : "agent-spin"} />{failed ? "视频任务未完成" : optimizingPrompt ? "本地节点正在优化中文提示词" : "共享节点正在制作视频"}</span><strong>{failed ? "已结束" : optimizingPrompt ? "准备中" : `${progress}%`}</strong></header>
      {!failed && <><div className="agent-h3-progress-track"><i style={{ width: `${Math.max(2, progress)}%` }} /></div><div className="agent-h3-progress-meta"><span>{optimizingPrompt ? "你已开启魔法优化，桌面节点正在处理提示词" : item.h3Task.estimatedTotalSeconds ? `预计总耗时 ${Math.ceil(item.h3Task.estimatedTotalSeconds / 60)} 分钟` : "节点正在估算制作时间"}</span><span>{optimizingPrompt ? "优化完成后自动开始视频生成" : item.h3Task.expectedCompletedAt ? `预计完成：${new Date(item.h3Task.expectedCompletedAt).toLocaleString("zh-CN")}` : "等待节点首次耗时回调"}</span></div></>}
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
      <div className="agent-balance-card"><div><Wallet size={29} weight="duotone" /><span>{quota?.unlimited ? "管理员创作权限" : "当前可用余额"}</span></div><strong>{quota?.unlimited ? "不限额" : formatMoney(quota?.balanceFen || 0)}</strong><small>{quota?.unlimited ? "管理员角色调用图片和视频模型不检查额度，也不会扣减余额" : bootstrap?.shortVideoPackage?.active ? `短视频包月剩余额度 ${formatMoney(bootstrap.shortVideoPackage.packageBalanceFen || 0)}；额度归零后 H3 仍可无限生成` : "会员实付金额与额外赠送的 10% 已合并为可用余额"}</small></div>
      {!quota?.unlimited && <div className="agent-estimate-grid"><EstimateCard icon={ImageSquare} title="预计可创作图片" value={quota?.estimates?.images} unit="张" /><EstimateCard icon={VideoCamera} title="预计可创作视频" value={quota?.estimates?.videos} unit="条" /></div>}
      <RollingUsage title="本周滚动用量" data={quota?.weekly} />
      <RollingUsage title="本月滚动用量" data={quota?.monthly} />
      {bootstrap?.assets?.length > 0 && <section className="agent-recent-assets"><header><span>RECENT CREATIONS</span><h3>最近创作</h3></header><div>{bootstrap.assets.map((asset) => <article key={asset.id}>{asset.modality === "video" ? <video src={asset.urls?.[0]} controls preload="metadata" /> : <a href={asset.urls?.[0]} target="_blank" rel="noreferrer"><img src={asset.urls?.[0]} alt={asset.prompt} /></a>}<strong>{asset.modelName}</strong><small>{asset.prompt}</small></article>)}</div></section>}
      <button className="button primary full" type="button" onClick={() => { onClose(); navigate("/pricing?tab=recharge"); }}>充值或续订 <ArrowRight size={17} /></button>
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
      <div className="agent-quota-actions"><button className="button secondary" type="button" onClick={onClose}>暂不处理</button><button className="button primary" type="button" onClick={() => { onClose(); navigate(subscription ? "/pricing?tab=subscription" : "/pricing?tab=recharge"); }}>{subscription ? "查看会员套餐" : "立即充值"}<ArrowRight size={17} /></button></div>
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
  const [model, setModel] = useState("ox-alpha");
  const [creationType, setCreationType] = useState("text");
  const [imageSize, setImageSize] = useState("1:1");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [duration, setDuration] = useState(5);
  const [h3VideoMode, setH3VideoMode] = useState("all_reference");
  const [h3Resolution, setH3Resolution] = useState("720P");
  const [h3SamplingSteps, setH3SamplingSteps] = useState(4);
  const [h3Seed, setH3Seed] = useState("-1");
  const [h3LongformMode, setH3LongformMode] = useState("continuous");
  const [h3SegmentDuration, setH3SegmentDuration] = useState(5);
  const [h3PromptListFileName, setH3PromptListFileName] = useState("");
  const [h3PromptOptimizationEnabled, setH3PromptOptimizationEnabled] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [assetUploadProgress, setAssetUploadProgress] = useState(null);
  const [sending, setSending] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [draftPreviewOpen, setDraftPreviewOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(true);
  const [referencePicker, setReferencePicker] = useState(null);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [quotaPrompt, setQuotaPrompt] = useState("");
  const [liveWorkflow, setLiveWorkflow] = useState(null);
  const inputRef = useRef(null);
  const streamRef = useRef(null);
  const initialScrollDoneRef = useRef(false);
  const pollersRef = useRef(new Map());

  function rememberConversation(nextConversationId) {
    const value = String(nextConversationId || "");
    setConversationId(value);
    if (user?.id && value) sessionStorage.setItem(`gulong-agent-conversation:${user.id}`, value);
  }

  useEffect(() => {
    initialScrollDoneRef.current = false;
    if (!user) { setLoading(false); setBootstrap(null); return; }
    setMessages([]);
    setConversationId(sessionStorage.getItem(`gulong-agent-conversation:${user.id}`) || "");
    setLoading(true);
    apiFetch("/api/agent/bootstrap").then((result) => { setBootstrap(result); setModel(result.defaultModel || "ox-alpha"); }).catch((error) => setMessage(error.message)).finally(() => setLoading(false));
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
        if (!initialScrollDoneRef.current) {
          initialScrollDoneRef.current = true;
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            const stream = streamRef.current;
            if (stream) stream.scrollTop = stream.scrollHeight;
          }));
        }
      } catch (error) {
        if (!cancelled && error.status !== 401) setMessage(error.message);
      }
    };
    void poll();
    const timer = setInterval(poll, 6_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [user?.id, conversationId]);

  useEffect(() => () => { for (const timer of pollersRef.current.values()) clearTimeout(timer); pollersRef.current.clear(); }, []);

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
  const h3References = useMemo(() => isH3Video ? h3AssetReferences(attachments) : [], [attachments, isH3Video]);
  const referenceSuggestions = useMemo(() => matchingH3References(h3References, referencePicker), [h3References, referencePicker]);
  const h3Counts = useMemo(() => h3AssetCounts(attachments), [attachments]);
  const h3PromptSegments = useMemo(() => splitH3PromptSegments(draft), [draft]);
  const h3EffectiveDuration = h3VideoMode === "extended" ? h3PromptSegments.length * h3SegmentDuration : duration;
  const h3EstimatedPriceFen = useMemo(() => {
    if (!isH3Video) return 0;
    try { return calculateH3ClientPriceFen(h3EffectiveDuration || h3SegmentDuration, attachments); }
    catch { return Number(h3EffectiveDuration || h3SegmentDuration) * 20; }
  }, [attachments, h3EffectiveDuration, h3SegmentDuration, isH3Video]);
  const h3Profile = useMemo(() => H3_VIDEO_RESOLUTIONS.find((item) => item.label === h3Resolution)?.profile || "official_max", [h3Resolution]);
  const h3SeedValue = useMemo(() => {
    if (!String(h3Seed).trim()) return -1;
    const parsed = Number(h3Seed);
    return Number.isSafeInteger(parsed) && parsed >= -1 && parsed <= 2_147_483_647 ? parsed : -1;
  }, [h3Seed]);

  function changeCreationType(nextType) {
    setCreationType(nextType);
    setModel(nextType === "text" ? (bootstrap?.defaultModel || "ox-alpha") : nextType === "video" ? H3_SHARED_MODEL.id : (bootstrap?.mediaDefaults?.[nextType] || `auto-${nextType}`));
    if (nextType === "video") { setDuration(5); setAspectRatio("9:16"); }
    setAttachments((current) => nextType === "text"
      ? current
      : nextType === "video"
        ? clampH3AssetSelection(current.filter((file) => h3AssetDescriptor(file))).files
        : current.filter((file) => file.type.startsWith("image/")));
    setMessage("");
  }

  function changeModel(nextModel) {
    setModel(nextModel);
    if (creationType === "video") {
      if (nextModel === H3_SHARED_MODEL.id) {
        if (!H3_VIDEO_DURATIONS.includes(duration)) setDuration(5);
        setAttachments((current) => clampH3AssetSelection(current).files);
      } else {
        if (!(bootstrap?.mediaOptions?.videoDurations || [5]).includes(duration)) setDuration(5);
        setAttachments((current) => current.filter((file) => file.type.startsWith("image/")));
      }
    }
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
    if (isH3Video) {
      try {
        const selection = clampH3AssetSelection([...attachments, ...files]);
        validateH3AssetSelection(selection.files);
        setAttachments(selection.files);
        const skippedCount = Object.values(selection.skipped).reduce((sum, value) => sum + value, 0);
        setMessage(skippedCount ? "部分素材未添加：MiniMax H3 单次任务支持图片 9 张、视频 3 个、音频 3 个，并仅接收支持的图片、视频和音频格式。" : "");
      } catch (error) { setMessage(error.message); }
      return;
    }
    if (creationType !== "text") {
      if (files.some((file) => !file.type.match(/^image\/(jpeg|png|webp)$/i))) { setMessage("参考图仅支持 JPEG、PNG 或 WebP 格式"); return; }
    }
    const next = [...attachments, ...files].slice(0, MAX_ATTACHMENTS);
    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (creationType === "text" && total > MAX_ATTACHMENT_BYTES) { setMessage("附件总大小不能超过 192 MB"); return; }
    setAttachments(next);
    setMessage("");
  }

  function insertH3Reference(reference) {
    if (!reference) return;
    const input = inputRef.current;
    const start = Number.isInteger(input?.selectionStart) ? input.selectionStart : draft.length;
    const end = Number.isInteger(input?.selectionEnd) ? input.selectionEnd : start;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const insertion = `${prefix}${reference}${suffix}`;
    const next = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    setDraft(next); setReferencePicker(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }

  function syncReferencePicker(value, caret) {
    const nextPicker = isH3Video && h3References.length ? h3ReferenceQuery(value, caret) : null;
    setReferencePicker(nextPicker);
    setReferenceActiveIndex(0);
  }

  function selectTypedReference(item) {
    if (!referencePicker) return;
    const next = replaceH3ReferenceQuery(draft, referencePicker, item.reference);
    setDraft(next.value); setReferencePicker(null);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.caret, next.caret); });
  }

  function removeAttachment(index) {
    const current = attachments;
    if (!isH3Video) {
      setAttachments(current.filter((_, itemIndex) => itemIndex !== index));
      return;
    }
    const next = removeH3AssetAndRemapReferences(current, index, draft);
    setAttachments(next.files);
    setDraft(next.prompt);
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    if (isH3Video && h3VideoMode === "extended" && h3EffectiveDuration > 600) { setMessage("当前单个官网超长项目最多 600 秒，请减少提示词段数或单段时长。"); return; }
    if (creationType === "text" && !bootstrap?.subscription?.active) {
      setMessage("网页版古龙 Agent 需要生效中的会员订阅。");
      return;
    }
    if (creationType !== "text" && user.role !== "admin") {
      const balanceFen = Number(bootstrap?.quota?.balanceFen || 0);
      const durationFactor = creationType === "video" ? Math.max(1, Number(duration || 5) / 5) : 1;
      const expectedFen = isH3Video ? calculateH3ClientPriceFen(h3EffectiveDuration || h3SegmentDuration, attachments) : selectedModel?.chargedFen == null ? 0 : Math.ceil(Number(selectedModel.chargedFen) * durationFactor);
      const shortVideoUnlimited = isH3Video && bootstrap?.shortVideoPackage?.active && bootstrap?.shortVideoPackage?.unlimitedH3;
      if (!shortVideoUnlimited && (balanceFen <= 0 || (expectedFen > 0 && balanceFen < expectedFen))) { setQuotaPrompt(bootstrap?.subscription?.active ? "recharge" : "subscription"); return; }
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
    const visibleReferences = isH3Video ? h3AssetReferences(attachments) : [];
    const visibleUser = { role: "user", content, createdAt: new Date().toISOString(), attachments: attachments.map((file, index) => ({ name: file.name, size: file.size, type: file.type, reference: visibleReferences[index]?.reference })) };
    const nextMessages = [...messages, visibleUser];
    setMessages(nextMessages); setDraft("");
    try {
      if (isH3Video) {
        const idempotencyKey = createClientRequestId();
        const uploadedAssets = await uploadH3AssetFiles(attachments, { apiFetch, onProgress: setAssetUploadProgress });
        const result = await apiFetch("/api/h3/tasks", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ source_channel: "website", model: H3_SHARED_MODEL.id, prompt: content, prompt_optimization_enabled: h3PromptOptimizationEnabled, conversation_id: conversationId || undefined, video_mode: h3VideoMode, longform_mode: h3VideoMode === "extended" ? h3LongformMode : undefined, segment_duration_seconds: h3VideoMode === "extended" ? h3SegmentDuration : undefined, duration_seconds: h3EffectiveDuration || duration, aspect_ratio: aspectRatio, profile: h3Profile, sampling_steps: h3SamplingSteps, seed: h3SeedValue, assets: h3AssetManifest(uploadedAssets) }) });
        rememberConversation(result.task.conversationId);
        const billingText = user.role === "admin"
          ? "管理员免扣费，本任务不产生分佣。"
          : result.billing?.billingMode === "short_video_package" && Number(result.billing?.chargedFen || 0) === 0
            ? "短视频包月额度已用完，本任务继续免费生成，不产生节点或平台分佣。"
            : `已从余额预扣：${formatMoney(result.billing?.chargedFen ?? result.task.priceFen)}\n\n剩余余额：${formatMoney(result.billing?.remainingBalanceFen || 0)}`;
        const optimizationText = h3PromptOptimizationEnabled ? "魔法提示词优化：已开启，桌面节点领取后将先优化再生成。" : "魔法提示词优化：未开启，桌面节点将直接使用你的原始提示词。";
        setMessages((current) => [...current, { role: "assistant", content: `MiniMaxH3共享节点任务已创建。\n\n订单号：${result.task.orderNo}\n\n${optimizationText}\n\n${billingText}\n\n状态：等待桌面节点领取。视频生成完成后会自动回到当前会话；最终失败会自动退款。`, createdAt: new Date().toISOString(), model: H3_SHARED_MODEL.id, h3TaskId: result.task.id, h3Task: { id: result.task.id, orderNo: result.task.orderNo, status: result.task.status, progress: 0, promptOptimizationEnabled: result.task.promptOptimizationEnabled ?? h3PromptOptimizationEnabled, createdAt: result.task.createdAt } }]);
        setAttachments([]);
        apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
        return;
      }
      if (creationType !== "text") {
        const uploadedReferenceAssets = await uploadH3AssetFiles(attachments.filter((file) => file.type.startsWith("image/")), { apiFetch, onProgress: setAssetUploadProgress, validateSelection: false });
        const referenceAssets = h3AssetManifest(uploadedReferenceAssets).images;
        const result = await apiFetch("/api/agent/media", { method: "POST", headers: { "Idempotency-Key": createClientRequestId() }, body: JSON.stringify({
          modality: creationType, model, prompt: content, conversationId: conversationId || undefined, referenceAssets, imageSize, aspectRatio, duration,
        }) });
        rememberConversation(result.job.conversationId);
        setMessages((current) => [...current, {
          role: "assistant", content: `${result.job.modelName} 已接收创作任务${user.role === "admin" ? " · 管理员免扣额度" : ` · 已从余额预扣 ${formatMoney(result.billing?.chargedFen ?? result.job.chargedFen)}`}`, createdAt: new Date().toISOString(),
          jobId: result.job.id, modality: creationType, status: result.job.status, urls: result.job.urls, error: result.job.error,
        }]);
        setAttachments([]);
        if (!["succeeded", "failed"].includes(result.job.status)) pollMedia(result.job.id);
        apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
        return;
      }
      const context = await attachmentContext(attachments);
      const requestMessages = nextMessages.slice(-23).map((item, index, list) => ({ role: item.role, content: index === list.length - 1 && item.role === "user" ? `${item.content}${context}`.slice(0, 12_000) : item.content.slice(0, 12_000) }));
      const result = await apiFetch("/api/agent/chat", { method: "POST", body: JSON.stringify({ operationId, model, conversationId: conversationId || undefined, messages: requestMessages }) });
      rememberConversation(result.conversationId);
      setMessages((current) => [...current, { ...result.message, model: result.model, resolvedModel: result.resolvedModel, fallback: result.fallback, free: result.free, workflow: result.workflow }]);
      setAttachments([]);
      apiFetch("/api/agent/bootstrap").then(setBootstrap).catch(() => {});
    } catch (error) {
      setMessages((current) => current.filter((item) => item !== visibleUser));
      setDraft(content);
      if (creationType !== "text" && error.code === "SUBSCRIPTION_REQUIRED") setQuotaPrompt("subscription");
      else if (creationType !== "text" && error.code === "INSUFFICIENT_BALANCE") setQuotaPrompt("recharge");
      else setMessage(error.message);
    } finally { setSending(false); setLiveWorkflow(null); setAssetUploadProgress(null); }
  }

  function keyDown(event) {
    if (referencePicker && referenceSuggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setReferenceActiveIndex((current) => (current + direction + referenceSuggestions.length) % referenceSuggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); selectTypedReference(referenceSuggestions[referenceActiveIndex] || referenceSuggestions[0]); return;
      }
      if (event.key === "Escape") { event.preventDefault(); setReferencePicker(null); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  }

  if (!user) return <main id="main-content" className="web-agent-page web-agent-gate section-shell"><div className="agent-gate-orb"><LockKey size={42} weight="duotone" /></div><span>GULONG WEB AGENT</span><h1>登录后进入网页版古龙</h1><p>无需配置个人 API Key。管理员统一托管 PearAPI 令牌，你只需选择免费模型并开始对话。</p><button className="button primary" type="button" onClick={() => openAuth("login")}>登录网页版入口 <ArrowRight size={18} /></button></main>;

  return <main id="main-content" className="web-agent-page">
    <div className="agent-topbar section-shell">
      <div className="agent-home-cluster"><button className="agent-home" type="button" onClick={() => navigate("/")} aria-label="返回古龙官网首页"><img src={themeIcon} alt="" /><span><strong>古龙网页版</strong><small>轻量 · 安全 · 云端响应</small></span></button><a href="/" onClick={(event) => { event.preventDefault(); navigate("/"); }}>返回官网 <ArrowRight size={15} /></a></div>
      <nav aria-label="网页版功能"><button type="button" aria-label="拓展技能" title="拓展技能" onClick={() => setSkillOpen(true)}><Sparkle size={21} weight="duotone" /><span>拓展技能</span></button><button type="button" aria-label="剩余用量" title="剩余用量" onClick={() => setAssetOpen(true)}><Wallet size={21} weight="duotone" /><span>剩余用量</span></button></nav>
    </div>

    <section className="agent-workspace section-shell">
      <header className="agent-workspace-head"><div className="agent-workspace-intro"><span>PEARAPI FREE MODEL CLOUD</span><h1>今天想完成什么？</h1><p title={`${bootstrap?.models?.length || 9} 个免费模型由古龙服务端统一调度；每次回复展示实时处理节点，不加载第二大脑、本地模型、插件或扩展工作流。`}>{bootstrap?.models?.length || 9} 个免费模型由古龙服务端统一调度；每次回复展示实时处理节点，不加载第二大脑、本地模型、插件或扩展工作流。</p></div><div className="agent-live-status"><i className={bootstrap?.configured ? "ready" : ""} /><span>{loading ? "正在连接" : bootstrap?.configured ? "远程模型已连接" : "等待管理员配置"}</span></div></header>

      <div className="agent-chat-shell">
        <div className="agent-chat-stream" aria-live="polite" ref={streamRef}>
          {!messages.length && <div className="agent-empty-chat"><div className="agent-empty-mark"><Sparkle size={35} weight="duotone" /></div><h2>把目标交给古龙</h2><p>选择文字、图片或视频，挑选模型并描述你想完成的结果。</p><div>{starterPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => { setDraft(prompt); setComposerOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}>{prompt}<ArrowRight size={16} /></button>)}</div></div>}
          {messages.map((item, index) => <article className={`agent-message ${item.role}`} key={`${item.createdAt}-${index}`}><div className="agent-message-avatar">{item.role === "assistant" ? <img src={themeIcon} alt="古龙" /> : (user.displayName || user.username || "我").slice(0, 1)}</div><div><header><strong>{item.role === "assistant" ? "古龙" : "你"}</strong><time>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>{item.free && <em>免费</em>}{item.fallback && <em>已切换备用模型</em>}</header>{item.role === "assistant" ? <><WorkflowTrace workflow={item.workflow} /><MarkdownMessage>{item.content}</MarkdownMessage></> : <p>{item.content}</p>}<MediaResult item={item} />{item.attachments?.length > 0 && <div className="agent-message-files">{item.attachments.map((file, fileIndex) => <span key={`${file.name}-${fileIndex}`}><File size={15} />{file.reference && <b>{file.reference}</b>}{file.name}</span>)}</div>}</div></article>)}
          {sending && <article className="agent-message assistant pending"><div className="agent-message-avatar"><img src={themeIcon} alt="" /></div><div><header><strong>古龙</strong><em>{creationType === "text" ? "文字" : creationType === "image" ? "图片" : "视频"}</em></header>{creationType === "text" && <WorkflowTrace workflow={liveWorkflow} live />}<p><SpinnerGap size={20} className="agent-spin" /> {assetUploadProgress ? `正在${assetUploadProgress.phase === "hashing" ? "校验" : assetUploadProgress.phase === "uploading" ? "上传" : assetUploadProgress.phase === "verifying" ? "确认" : "处理"}素材 ${assetUploadProgress.name}…` : `正在通过 ${selectedModel?.name || model} 处理任务…`}</p></div></article>}
        </div>

      </div>

      {composerOpen ? <section className={`agent-composer-wrap agent-floating-composer ${isH3Video ? "h3-desktop-composer" : ""}`} role="dialog" aria-modal="false" aria-label="古龙创作输入框">
          <button className="agent-composer-close" type="button" aria-label="收起创作输入框" title="收起为悬浮球" onClick={() => { setReferencePicker(null); setComposerOpen(false); }}><X size={20} weight="bold" /></button>
          {message && <div className="agent-inline-alert"><LockKey size={18} /><span>{message}</span><button type="button" onClick={() => setMessage("")}><X size={16} /></button></div>}
          {!bootstrap?.subscription?.active && !loading && <div className="agent-membership-gate"><div><Coins size={24} weight="duotone" /><span><strong>会员订阅尚未生效</strong><small>免费文字对话需开通会员；付费图片与视频可使用已有余额按次创作。</small></span></div><button type="button" onClick={() => navigate("/pricing")}>查看会员 <ArrowRight size={16} /></button></div>}
          {isH3Video ? <div className="agent-h3-composer-title"><div><strong>创作描述</strong><span>描述主体、动作、环境和镜头</span></div><div><em>{formatMoney(h3EstimatedPriceFen)} · 接单后实时估时</em><span>视频生成</span><small>{draft.length} / 20000</small></div></div> : <div className="agent-mode-row"><div className="agent-creation-hint">{creationType === "text" ? "免费文字对话" : (selectedModel?.priceLabel || "按实际模型计费")}</div><div className="agent-draft-meta"><button type="button" onClick={() => { setReferencePicker(null); setDraftPreviewOpen(true); }} title="全屏查看并编辑长文本"><Eye size={19} weight="duotone" /><span>预览编辑</span></button><span>{draft.length} / 4096</span></div></div>}
          {!isH3Video && attachments.length > 0 && <div className="agent-attachment-row">{attachments.map((file, index) => <article key={`${file.name}-${index}`}><AttachmentThumbnail file={file} /><div><b title={file.name}>{file.name}</b><small>{byteText(file.size)}</small></div><button className="agent-attachment-remove" type="button" disabled={sending} aria-label={`移除 ${file.name}`} onClick={() => removeAttachment(index)}><X size={15} /></button></article>)}</div>}
          <div className={isH3Video ? "agent-h3-prompt-wrap" : "agent-standard-prompt-wrap"}>
            {isH3Video && <details className="agent-h3-assets-menu">
              <summary title="上传和管理参考素材"><span><Paperclip size={20} /></span><small>参考素材</small>{attachments.length > 0 && <b>{attachments.length}</b>}</summary>
              <div className="agent-h3-assets-popover">
                <header><div><strong>参考素材</strong><span>最多 9 图、3 视频、3 音频</span></div></header>
                <div className="agent-h3-assets-upload-options">{H3_ASSET_PICKERS.map((item) => <label key={item.kind}><span>{item.label === "图片" ? <ImageSquare size={19} /> : item.label === "视频" ? <VideoCamera size={19} /> : <File size={19} />}</span><strong>添加{item.label}</strong><small>{h3Counts[item.kind]}/{H3_ASSET_LIMITS[item.kind]}</small><input type="file" multiple disabled={sending} accept={item.accept} onChange={pickAttachments} /></label>)}</div>
                {attachments.length > 0 ? <div className="agent-h3-assets-grid">{attachments.map((file, index) => <article key={`${file.name}-${index}`}><button type="button" title={`引用 ${h3References[index]?.reference}`} onClick={() => insertH3Reference(h3References[index]?.reference)}><AttachmentThumbnail file={file} reference={h3References[index]?.reference} /></button><div><button type="button" disabled={sending} onClick={() => insertH3Reference(h3References[index]?.reference)}>{h3References[index]?.reference}</button><b title={file.name}>{file.name}</b><small>{byteText(file.size)}</small></div><button className="agent-attachment-remove" type="button" disabled={sending} aria-label={`移除 ${file.name}`} onClick={() => removeAttachment(index)}><X size={15} /></button></article>)}</div> : <p>添加素材后，输入 @ 可选择图片、视频或音频素材。</p>}
              </div>
            </details>}
            <textarea ref={inputRef} maxLength={isH3Video ? 20000 : 4096} value={draft} onChange={(event) => { setDraft(event.target.value); syncReferencePicker(event.target.value, event.target.selectionStart); }} onSelect={(event) => syncReferencePicker(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={keyDown} placeholder={isH3Video ? "描述人物、场景、动作和运镜，也可以用 @图片1、@视频1、@音频1 精确引用素材……" : "描述任务；上传附件后输入你的要求。Enter 发送，Shift + Enter 换行"} />
            {referencePicker && <H3ReferencePicker items={referenceSuggestions} activeIndex={referenceActiveIndex} onSelect={selectTypedReference} />}
          </div>
          {isH3Video && h3VideoMode === "extended" && <div className="agent-h3-longform-bar"><div><File size={20} weight="duotone" /><span><strong>{h3LongformMode === "continuous" ? "超长续帧提示词列表" : "批量短视频提示词列表"}</strong><small>{h3PromptSegments.length ? `${h3PromptSegments.length} 段 × 每段 ${h3SegmentDuration} 秒 = 总时长 ${h3EffectiveDuration} 秒` : "使用空行分隔每一段提示词"}</small></span></div><label><File size={18} /><span>{h3PromptListFileName || "导入 TXT（空行分段）"}</span><input type="file" accept=".txt,text/plain" onChange={async (event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; const text = (await file.text()).replace(/^\uFEFF/u, "").trim(); if (!splitH3PromptSegments(text).length) { setMessage("TXT 文件中没有可用提示词，请使用空行分隔每一段。" ); return; } setDraft(text); setH3PromptListFileName(file.name); }} /></label></div>}
          {assetUploadProgress && <div className="agent-h3-upload-progress"><SpinnerGap size={18} className="agent-spin" /><span>正在安全上传 {assetUploadProgress.name}</span><strong>{assetUploadProgress.completed || 0} / {assetUploadProgress.total || attachments.length}</strong></div>}
          <footer className={isH3Video ? "agent-h3-parameter-rail" : ""}>
            {!isH3Video && <label className="agent-attach-button" title={creationType === "text" ? "最多 12 个附件" : "上传参考图，不限制原始文件大小"}><Paperclip size={20} /><span>{creationType === "text" ? "附件" : "参考图"}</span><input type="file" multiple disabled={sending} accept={creationType === "text" ? "image/*,video/*,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx" : "image/jpeg,image/png,image/webp"} onChange={pickAttachments} /></label>}
            <div className="agent-type-select"><span>{creationType === "text" ? <TextT size={18} /> : creationType === "image" ? <ImageSquare size={18} /> : <VideoCamera size={18} />}</span><select value={creationType} onChange={(event) => changeCreationType(event.target.value)}><option value="text">文字</option><option value="image">图片</option><option value="video">视频</option></select></div>
            {creationType === "image" && <div className="agent-parameter-select"><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>{(bootstrap?.mediaOptions?.imageSizes || ["1:1"]).map((value) => <option key={value} value={value}>{value}</option>)}</select></div>}
            {creationType === "video" && !isH3Video && <><div className="agent-parameter-select"><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option></select></div><div className="agent-parameter-select"><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{(bootstrap?.mediaOptions?.videoDurations || [5]).map((value) => <option key={value} value={value}>{value} 秒</option>)}</select></div></>}
            {isH3Video && <>
              <label className="agent-h3-compact-control wide" title="视频生成方式"><Sparkle size={17} /><select value={h3VideoMode} onChange={(event) => setH3VideoMode(event.target.value)} aria-label="视频生成方式">{H3_VIDEO_MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              {h3VideoMode === "extended" && <label className="agent-h3-compact-control wide" title="超长视频生产方式"><File size={17} /><select value={h3LongformMode} onChange={(event) => setH3LongformMode(event.target.value)} aria-label="超长视频生产方式"><option value="continuous">连续成片</option><option value="independent">批量短片</option></select></label>}
              <label className="agent-h3-compact-control" title="画面比例"><ImageSquare size={17} /><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} aria-label="画面比例">{H3_VIDEO_ASPECTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <label className="agent-h3-compact-control" title="分辨率"><Sparkle size={17} /><select value={h3Resolution} onChange={(event) => setH3Resolution(event.target.value)} aria-label="分辨率">{H3_VIDEO_RESOLUTIONS.map((item) => <option key={item.label} value={item.label}>{item.label}</option>)}</select></label>
              <label className="agent-h3-compact-control sampling" title="主采样步数"><Coins size={17} /><select value={h3SamplingSteps} onChange={(event) => setH3SamplingSteps(Number(event.target.value))} aria-label="主采样步数">{H3_SAMPLING_STEPS.map((value) => <option key={value} value={value}>{value}步 · {value === 4 ? "默认极速" : value === 8 ? "高质量" : "原生质量"}</option>)}</select></label>
              <details className="agent-h3-duration-menu"><summary title={h3VideoMode === "extended" ? "总时长由提示词段数自动计算" : "视频时长 1–15 秒"}><VideoCamera size={17} /><span>{h3VideoMode === "extended" ? h3EffectiveDuration : duration}秒</span></summary><div><header><strong>{h3VideoMode === "extended" ? "超长视频时长" : "选择视频生成时长"}</strong><span>{h3VideoMode === "extended" ? "总时长自动计算" : "1–15 秒"}</span></header>{h3VideoMode === "extended" ? <><section className="agent-h3-longform-duration"><span>提示词段数<strong>{h3PromptSegments.length}</strong></span><i>×</i><span>单段时长<strong>{h3SegmentDuration}秒</strong></span><i>=</i><span>总时长<strong>{h3EffectiveDuration}秒</strong></span></section><label className="agent-h3-segment-field"><span>单段生成时长</span><input type="number" min="5" max="15" value={h3SegmentDuration} onChange={(event) => setH3SegmentDuration(Math.max(5, Math.min(15, Number(event.target.value) || 5)))} /><em>秒</em></label><small className="agent-h3-duration-note">每段可设置 5–15 秒，总时长随提示词段数实时更新。</small></> : <><section><input type="range" min="1" max="15" step="1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><label><input type="number" min="1" max="15" value={duration} onChange={(event) => setDuration(Math.max(1, Math.min(15, Number(event.target.value) || 1)))} /><span>秒</span></label></section><footer>{[1, 5, 10, 15].map((value) => <button type="button" className={duration === value ? "active" : ""} key={value} onClick={() => setDuration(value)}>{value}</button>)}</footer></>}</div></details>
              <label className="agent-h3-compact-control seed" title="随机种子，-1 表示随机"><ShieldCheck size={17} /><input type="text" inputMode="numeric" value={h3Seed} onChange={(event) => setH3Seed(event.target.value.replace(/[^0-9-]/g, ""))} aria-label="随机种子" /></label>
              <button className={`agent-h3-prompt-toggle ${h3PromptOptimizationEnabled ? "active" : ""}`} type="button" disabled={sending} aria-pressed={h3PromptOptimizationEnabled} aria-label={`魔法提示词优化${h3PromptOptimizationEnabled ? "已开启" : "已关闭"}`} title={h3PromptOptimizationEnabled ? "已开启：桌面节点会先优化提示词" : "未开启：桌面节点直接使用原始提示词"} onClick={() => setH3PromptOptimizationEnabled((enabled) => !enabled)}><MagicWand size={20} weight={h3PromptOptimizationEnabled ? "fill" : "duotone"} /><span>魔法优化</span><em>{h3PromptOptimizationEnabled ? "开" : "关"}</em></button>
            </>}
            <div className="agent-model-select"><select value={model} onChange={(event) => changeModel(event.target.value)}>{availableModels.map((item) => <option value={item.id} key={item.id}>{item.name}{creationType === "text" ? " · 免费" : ` · ${item.priceLabel}`}</option>)}</select><Check size={15} weight="bold" /></div>
            <button className="agent-send-button" type="button" aria-label="发送" disabled={!draft.trim() || sending || loading} onClick={send}>{sending ? <SpinnerGap size={22} className="agent-spin" /> : <PaperPlaneRight size={22} weight="fill" />}</button>
          </footer>
        </section> : <button className={`agent-composer-orb ${sending ? "working" : ""}`} type="button" aria-label="展开古龙创作输入框" title="展开创作输入框" onClick={() => { setComposerOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}><img src={themeIcon} alt="" /><ChatCircleDots size={25} weight="fill" /></button>}
    </section>

    {assetOpen && <AssetPanel bootstrap={bootstrap} onClose={() => setAssetOpen(false)} navigate={navigate} />}
    {skillOpen && <SkillPanel onClose={() => setSkillOpen(false)} setDraft={(value) => { setDraft(value); setComposerOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }} />}
    {draftPreviewOpen && <DraftPreviewEditor value={draft} setValue={setDraft} maxLength={isH3Video ? 20000 : 4096} references={h3References} onClose={() => setDraftPreviewOpen(false)} />}
    {quotaPrompt && <QuotaPrompt kind={quotaPrompt} onClose={() => setQuotaPrompt("")} navigate={navigate} />}
  </main>;
}
