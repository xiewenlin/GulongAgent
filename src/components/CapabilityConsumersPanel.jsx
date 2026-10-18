import { ArrowClockwise, CheckCircle, CloudArrowUp, MagnifyingGlass, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, localizeErrorMessage } from "../api.js";
import { useConfirmDialog } from "./ConfirmDialog.jsx";
import "./CapabilityConsumersPanel.css";

const ROOT = "/api/admin/capability-consumers";
const MAX_JSON_BYTES = 64 * 1024;
const CAPABILITIES = {
  "gulong_engine.agent_chat": "智能对话",
  "gulong_engine.embedding": "向量模型",
  "gulong_engine.music": "音乐生成",
};
const STATUS_LABELS = { active: "有效", pending_audit: "待审计", revoked: "已撤销", expired: "已过期", binding_inactive: "绑定已失效", binding_unavailable: "绑定不可用", unconfirmed: "尚未确认" };
const PROOF_KEYS = new Set(["exact_request", "complete_response", "exact_model_dimension", "music_generation", "whole_audio_asr", "exact_lyrics", "exact_duration", "tools", "multimodal"]);
const REQUIRED_PROOFS = {
  "gulong_engine.agent_chat": ["exact_request", "complete_response"],
  "gulong_engine.embedding": ["exact_request", "complete_response", "exact_model_dimension"],
  "gulong_engine.music": ["music_generation", "whole_audio_asr", "exact_lyrics", "exact_duration"],
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const validModelId = (value) => typeof value === "string" && /^[A-Za-z0-9_./:@+-]{1,240}$/.test(value) && value.toLowerCase() !== "auto";
const shown = (value, fallback = "未提供") => ["string", "number", "boolean"].includes(typeof value) ? String(value) : fallback;
const capabilityName = (id) => typeof id === "string" && Object.hasOwn(CAPABILITIES, id) ? CAPABILITIES[id] : "未知能力";

function secretOrUnsafeField(value) {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++visited > 5000 || current.depth > 12) return "JSON 结构过于复杂，请只保留验收登记字段。";
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, item] of Object.entries(current.value)) {
      if (/secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|binding[_-]?token|authorization|private[_-]?key/i.test(key)
        || ["__proto__", "constructor", "prototype"].includes(key)) return "登记 JSON 含凭据或不安全字段，请移除密钥、密码、令牌和认证头后再导入。";
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return "";
}

// This is a local safety preview, not a replacement for the server's authoritative
// administrator, binding, artifact, evidence and validity checks. It never makes proofs.
export function parseAcceptanceDraft(source, selectedBinding) {
  const errors = [];
  if (!source.trim()) return { payload: null, errors, empty: true };
  if (new TextEncoder().encode(source).byteLength > MAX_JSON_BYTES) return { payload: null, errors: ["登记 JSON 不能超过 64 KB。"] };
  let payload;
  try { payload = JSON.parse(source.replace(/^\uFEFF/u, "")); }
  catch { return { payload: null, errors: ["JSON 格式不正确，请检查引号、逗号和括号。"] }; }
  if (!isObject(payload)) return { payload: null, errors: ["登记内容必须是一个 JSON 对象，不能是列表或普通文字。"] };
  const unsafe = secretOrUnsafeField(payload);
  if (unsafe) return { payload: null, errors: [unsafe] };
  const capabilityId = typeof payload.capability_id === "string" ? payload.capability_id : "";
  const common = ["binding_id", "capability_id", "capability_version", "artifact_sha256", "test_evidence_sha256", "contract_tests", "tested_at", "expires_at", "admin_confirmed_real_consumer", "models", "default_model"];
  const allowed = new Set([...common, ...(payload.capability_id === "gulong_engine.music" ? ["asr_languages"] : [])]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) errors.push("包含接口不接受的字段，请仅导入消费者验收登记 JSON，不要导入完整日志或运行配置。");
  if (typeof payload.binding_id !== "string" || !/^[a-f0-9]{24}$/i.test(payload.binding_id)) errors.push("binding_id 必须是完整的节点绑定编号。");
  if (!selectedBinding) errors.push("请先搜索并选择实际部署的节点。");
  else if (typeof payload.binding_id !== "string" || payload.binding_id.toLowerCase() !== String(selectedBinding.binding_id).toLowerCase()) errors.push("JSON 的 binding_id 与当前所选节点不一致，已阻止跨节点登记。");
  if (!Object.hasOwn(CAPABILITIES, capabilityId)) errors.push("仅支持智能对话、向量模型或音乐生成三项消费者能力。");
  if (payload.capability_version !== "1.0.0") errors.push("当前消费者合同版本必须为 1.0.0。");
  if (!validHash(payload.artifact_sha256)) errors.push("制品摘要 artifact_sha256 必须是完整的 64 位 SHA-256。");
  if (!validHash(payload.test_evidence_sha256)) errors.push("证据摘要 test_evidence_sha256 必须是完整的 64 位 SHA-256。");
  if (payload.admin_confirmed_real_consumer !== true) errors.push("登记 JSON 尚未明确确认真实消费者，请核对真实证据后再填写 admin_confirmed_real_consumer。");
  const tested = Date.parse(typeof payload.tested_at === "string" ? payload.tested_at : ""), expires = Date.parse(typeof payload.expires_at === "string" ? payload.expires_at : ""), now = Date.now();
  if (!Number.isFinite(tested) || !Number.isFinite(expires) || tested > now || expires <= now || expires <= tested || expires - tested > 30 * 86400_000 || now - tested >= 30 * 86400_000) {
    errors.push("请填写真实测试时间和到期时间：测试不能在未来，验收须仍有效，且自测试日起最多有效 30 天。");
  }
  if (!isObject(payload.contract_tests) || Object.entries(payload.contract_tests || {}).some(([key, value]) => !PROOF_KEYS.has(key) || typeof value !== "boolean")
    || (Object.hasOwn(REQUIRED_PROOFS, capabilityId) ? REQUIRED_PROOFS[capabilityId] : []).some((key) => payload.contract_tests?.[key] !== true)) errors.push("contract_tests 缺少该能力必需的真实验收项，或包含不支持的验收字段。");
  if (!Array.isArray(payload.models) || !payload.models.length || payload.models.length > 64) errors.push("必须提供 1–64 项实际验收模型，不能使用空模型列表。");
  else {
    const seen = new Set();
    for (const model of payload.models) {
      if (!isObject(model) || !validModelId(model.id)) { errors.push("模型必须提供真实、完整的模型 ID，不能使用 auto。"); continue; }
      const keys = payload.capability_id === "gulong_engine.agent_chat" ? ["id", "tools", "multimodal"] : payload.capability_id === "gulong_engine.embedding" ? ["id", "dimension"] : ["id", "max_duration_seconds"];
      if (Object.keys(model).some((key) => !keys.includes(key))) errors.push("模型矩阵包含该能力不支持的字段。");
      const identity = `${model.id}:${model.dimension ?? ""}`;
      if (seen.has(identity)) errors.push("同一模型和维度不能重复登记。");
      seen.add(identity);
      if (payload.capability_id === "gulong_engine.agent_chat" && (typeof model.tools !== "boolean" || typeof model.multimodal !== "boolean"
        || (model.tools && payload.contract_tests?.tools !== true) || (model.multimodal && payload.contract_tests?.multimodal !== true))) errors.push("对话模型须明确工具和多模态支持；启用任何一项都必须有对应真实验收。");
      if (payload.capability_id === "gulong_engine.embedding" && (!Number.isSafeInteger(model.dimension) || model.dimension < 1 || model.dimension > 65536)) errors.push("向量模型必须提供实际验收的精确维度（1–65536）。");
      if (payload.capability_id === "gulong_engine.music" && (typeof model.max_duration_seconds !== "number" || !Number.isFinite(model.max_duration_seconds) || model.max_duration_seconds < 1 || model.max_duration_seconds > 600)) errors.push("音乐模型须提供实际最长时长 max_duration_seconds（1–600 秒），不能用字符串或省略。");
    }
    if ((payload.capability_id === "gulong_engine.agent_chat" || payload.default_model != null)
      && !payload.models.some((model) => model?.id === payload.default_model)) errors.push("默认模型必须是本次实际验收模型矩阵中的模型。");
  }
  if (payload.capability_id === "gulong_engine.music" && (!Array.isArray(payload.asr_languages) || !payload.asr_languages.length || payload.asr_languages.length > 2
    || payload.asr_languages.some((language) => !["zh", "en"].includes(language)))) errors.push("音乐须明确实际验收的整段 ASR 语言：zh 或 en，未测试的语言不能登记。");
  return { payload, errors: [...new Set(errors)], empty: false };
}

function displayTime(value) {
  const date = new Date(typeof value === "string" ? value : NaN);
  return Number.isFinite(+date) ? date.toLocaleString("zh-CN", { hour12: false }) : "未提供";
}
function effectiveStatus(record) {
  if (record.effective_status) return String(record.effective_status);
  return record.expires_at && +new Date(record.expires_at) <= Date.now() ? "expired" : "unconfirmed";
}
function StatusPill({ status }) {
  return <span className={`cc-status ${status === "active" ? "is-active" : ["expired", "revoked", "binding_inactive", "binding_unavailable"].includes(status) ? "is-inactive" : ""}`}>{STATUS_LABELS[status] || "未识别状态"}<code>{status || "unconfirmed"}</code></span>;
}

export function CapabilityConsumersPanel() {
  const confirmAction = useConfirmDialog();
  const [query, setQuery] = useState("");
  const [bindings, setBindings] = useState([]);
  const [selectedBinding, setSelectedBinding] = useState(null);
  const [acceptances, setAcceptances] = useState([]);
  const [draft, setDraft] = useState("");
  const [filename, setFilename] = useState("");
  const [confirmedEvidence, setConfirmedEvidence] = useState(false);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [uncertainSubmission, setUncertainSubmission] = useState(false);
  const [notice, setNotice] = useState(null);
  const bindingRequest = useRef(0), recordRequest = useRef(0), draftVersion = useRef(0), mounted = useRef(true), submittingRef = useRef(false), uncertainBindings = useRef(new Set());
  const preview = useMemo(() => parseAcceptanceDraft(draft, selectedBinding), [draft, selectedBinding]);
  const canSubmit = Boolean(selectedBinding && preview.payload && !preview.errors.length && confirmedEvidence && !accessDenied && !uncertainSubmission && !submitting && !fileLoading);

  function failRequest(error, fallback) {
    if (error.status === 401 || error.status === 403) {
      // Invalidate both independent reads and any pending confirmation. A stale
      // successful response must not restore administrator data after denial.
      bindingRequest.current += 1; recordRequest.current += 1; draftVersion.current += 1;
      setBindingsLoading(false); setRecordsLoading(false);
      setAccessDenied(true); setBindings([]); setSelectedBinding(null); setAcceptances([]); setConfirmedEvidence(false);
      setNotice({ tone: "error", text: error.status === 401 ? "登录已失效，请重新登录管理员账号后再操作。" : "此功能仅限管理员账号使用，请确认当前账号的管理员权限。" });
    } else setNotice({ tone: "error", text: localizeErrorMessage(error, fallback) });
  }

  async function loadBindings(nextQuery = query) {
    const request = ++bindingRequest.current;
    setBindingsLoading(true);
    try {
      const keyword = String(nextQuery).trim();
      const params = new URLSearchParams();
      if (keyword) params.set("q", keyword);
      const result = await apiFetch(`${ROOT}/bindings${params.size ? `?${params}` : ""}`);
      if (!mounted.current || request !== bindingRequest.current) return;
      const rows = Array.isArray(result.bindings) ? result.bindings : [];
      setBindings(rows); setAccessDenied(false);
      if (selectedBinding && !rows.some((row) => row.binding_id === selectedBinding.binding_id)) {
        draftVersion.current += 1; setSelectedBinding(null); setAcceptances([]); setConfirmedEvidence(false); recordRequest.current += 1;
      }
    } catch (error) { if (mounted.current && request === bindingRequest.current) failRequest(error, "节点搜索失败，请稍后重试。"); }
    finally { if (mounted.current && request === bindingRequest.current) setBindingsLoading(false); }
  }

  async function loadAcceptances(binding) {
    if (!binding) return;
    const request = ++recordRequest.current;
    setRecordsLoading(true);
    try {
      const result = await apiFetch(`${ROOT}/acceptances?${new URLSearchParams({ binding_id: binding.binding_id })}`);
      if (!mounted.current || request !== recordRequest.current) return;
      setAcceptances(Array.isArray(result.acceptances) ? result.acceptances : []); setAccessDenied(false); uncertainBindings.current.delete(binding.binding_id); setUncertainSubmission(false);
    } catch (error) { if (mounted.current && request === recordRequest.current) failRequest(error, "验收记录暂时无法读取，请稍后刷新。"); }
    finally { if (mounted.current && request === recordRequest.current) setRecordsLoading(false); }
  }

  function chooseBinding(binding) {
    if (submittingRef.current) return;
    draftVersion.current += 1; setSelectedBinding(binding); setConfirmedEvidence(false); setAcceptances([]); setNotice(null); setUncertainSubmission(uncertainBindings.current.has(binding.binding_id));
    loadAcceptances(binding);
  }

  function editDraft(value) {
    draftVersion.current += 1; setDraft(value); setConfirmedEvidence(false); setFilename("");
  }

  async function importFile(event) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || submittingRef.current) return;
    setNotice(null); setFileLoading(true); setConfirmedEvidence(false);
    const version = ++draftVersion.current;
    try {
      if (!/\.json$/i.test(file.name) || file.size > MAX_JSON_BYTES) throw new Error("请上传不超过 64 KB 的非密钥 JSON 登记文件，不能使用 .env 或 PEM 文件。");
      const source = await file.text();
      const parsed = parseAcceptanceDraft(source, selectedBinding);
      if (!parsed.payload) throw new Error(parsed.errors[0] || "登记文件为空，请选择真实验收登记 JSON。");
      if (!mounted.current || draftVersion.current !== version) return;
      setDraft(source); setFilename(file.name);
    } catch (error) { if (mounted.current) setNotice({ tone: "error", text: localizeErrorMessage(error, "登记文件无法读取。") }); }
    finally { if (mounted.current) setFileLoading(false); }
  }

  async function submitRegistration(event) {
    event.preventDefault();
    if (submittingRef.current || !canSubmit) return;
    const checked = parseAcceptanceDraft(draft, selectedBinding);
    if (!selectedBinding || !confirmedEvidence || checked.errors.length || !checked.payload || accessDenied || uncertainSubmission) return;
    const binding = selectedBinding, payload = checked.payload, version = draftVersion.current;
    submittingRef.current = true; setSubmitting(true); setNotice(null);
    let sent = false;
    try {
      const accepted = await confirmAction({
        tone: "secure", eyebrow: "共享能力真实验收", title: "登记这个节点的消费者验收？",
        message: "此操作不会测试模型，也不会生成证据。请确认已人工核对当前部署制品与完整真实推理记录，登记内容将进入管理员审计。",
        detail: `${binding.node_name || "未命名节点"} · ${CAPABILITIES[payload.capability_id]} · ${payload.artifact_sha256}`,
        detailLabel: "节点、能力与实际制品", note: "登记成功不代表节点在线；节点还须携带验收编号正式上报，目录才会按实际容量决定是否可派单。", confirmLabel: "确认核对并登记",
      });
      if (!accepted || !mounted.current || draftVersion.current !== version) return;
      // Never replace a file's binding silently, synthesize proof flags, or POST
      // from mount/file-upload effects. Only this explicit confirmed action writes.
      if (String(payload.binding_id).toLowerCase() !== String(binding.binding_id).toLowerCase()) return;
      sent = true;
      await apiFetch(`${ROOT}/acceptances`, { method: "POST", body: JSON.stringify(payload) });
      if (!mounted.current) return;
      setConfirmedEvidence(false);
      setNotice({ tone: "success", text: "验收登记已完成。请让节点携带列表中的验收编号正式上报；登记本身不代表节点在线或已经可以派单。" });
      await loadAcceptances(binding);
    } catch (error) {
      if (!mounted.current) return;
      setConfirmedEvidence(false);
      if (sent && (error.status === 0 || error.status >= 500) && error.status !== 401 && error.status !== 403) {
        uncertainBindings.current.add(binding.binding_id);
        setUncertainSubmission(true);
        setNotice({ tone: "error", text: "登记结果暂未确认，请先刷新当前节点的验收记录核对结果，再决定是否重新登记，避免重复提交。" });
      } else failRequest(error, "验收登记失败，请检查内容后重试。");
    } finally { submittingRef.current = false; if (mounted.current) setSubmitting(false); }
  }

  useEffect(() => {
    mounted.current = true;
    loadBindings("");
    return () => { mounted.current = false; bindingRequest.current += 1; recordRequest.current += 1; };
  }, []);

  return <section className="admin-module capability-consumers-panel">
    <header className="admin-module-head"><div><span>SHARED CONSUMER ACCEPTANCE</span><h2>共享能力验收</h2><p>先选择实际部署节点，再核对真实证据并登记。验收状态与节点在线状态分别管理，不会自动运行模型或创建任务。</p></div><ShieldCheck size={38} weight="duotone" /></header>
    {notice && <div className={`cc-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <CheckCircle size={21} /> : <WarningCircle size={21} />}<span>{notice.text}</span></div>}
    <section className="cc-card"><header className="cc-section-heading"><span>01</span><div><h3>选择实际部署节点</h3><p>仅搜索有效的账号绑定；支持节点 ID 或设备名称关键词。</p></div></header>
      <form className="cc-search" onSubmit={(event) => { event.preventDefault(); loadBindings(); }}><label htmlFor="cc-node-query">节点 ID / 设备名称<input id="cc-node-query" maxLength={100} value={query} disabled={submitting || accessDenied} onChange={(event) => setQuery(event.target.value)} placeholder="输入节点名称或 node_id 关键词" /></label><button className="button secondary" type="submit" disabled={bindingsLoading || submitting || accessDenied}><MagnifyingGlass size={18} />{bindingsLoading ? "正在搜索" : "搜索节点"}</button></form>
      {accessDenied ? <p className="cc-empty">请重新登录管理员账号后返回此页面。</p> : bindingsLoading ? <p className="cc-empty" role="status">正在读取节点绑定…</p> : bindings.length ? <div className="cc-binding-list" role="listbox" aria-label="选择共享计算节点">{bindings.map((binding) => <button className={`cc-binding ${selectedBinding?.binding_id === binding.binding_id ? "selected" : ""}`} type="button" role="option" aria-selected={selectedBinding?.binding_id === binding.binding_id} key={binding.binding_id} disabled={submitting} onClick={() => chooseBinding(binding)}><span><strong>{binding.node_name || "未命名节点"}</strong><small>节点 ID</small><code>{binding.node_id}</code></span><CheckCircle size={21} weight={selectedBinding?.binding_id === binding.binding_id ? "fill" : "regular"} /></button>)}</div> : <p className="cc-empty">没有找到匹配节点。请确认设备已绑定官网账号，或更换关键词后重新搜索。</p>}
      {selectedBinding && <div className="cc-selected"><div><small>当前绑定编号</small><code>{selectedBinding.binding_id}</code></div><div><small>所属账户 ID</small><code>{selectedBinding.user_id || "未提供"}</code></div><div><small>算力分组 ID</small><code>{selectedBinding.compute_group_id || "未设置分组"}</code></div></div>}
    </section>
    <form className="cc-card" onSubmit={submitRegistration}><header className="cc-section-heading"><span>02</span><div><h3>核对并登记真实验收</h3><p>仅导入不含密钥的登记 JSON。请勿上传令牌、密码、.env 或 PEM 文件；原始证据由管理员自行保管核对。</p></div></header>
      <div className="cc-draft-grid"><div className="cc-editor"><div className="cc-editor-heading"><label htmlFor="cc-registration-json">可编辑的登记 JSON</label><label className={`button secondary cc-file-button ${submitting || fileLoading || accessDenied ? "disabled" : ""}`}><CloudArrowUp size={18} />{fileLoading ? "正在读取" : "上传登记 JSON"}<input type="file" accept=".json,application/json" aria-label="上传非密钥验收登记 JSON" disabled={submitting || fileLoading || accessDenied} onChange={importFile} /></label></div><textarea id="cc-registration-json" rows={18} value={draft} disabled={submitting || fileLoading || accessDenied} onChange={(event) => editDraft(event.target.value)} spellCheck={false} autoComplete="off" placeholder="上传或粘贴真实验收登记 JSON；页面不会生成制品摘要、模型或测试通过证据。" /><small>{filename ? `已读取：${filename} · ` : ""}最多 64 KB；导入和编辑均仅保留在当前页面，未经明确确认不会提交。</small></div>
        <aside className="cc-preview" aria-live="polite"><h4>登记内容核对</h4>{preview.empty ? <p className="cc-muted">请选择节点并导入真实登记文件，核对摘要后再确认。</p> : <>{preview.payload && <dl><div><dt>绑定编号</dt><dd><code>{shown(preview.payload.binding_id)}</code></dd></div><div><dt>能力 / 合同版本</dt><dd>{capabilityName(preview.payload.capability_id)}<code>{shown(preview.payload.capability_id)} · {shown(preview.payload.capability_version)}</code></dd></div><div><dt>实际制品 SHA-256</dt><dd><code>{shown(preview.payload.artifact_sha256)}</code></dd></div><div><dt>真实证据 SHA-256</dt><dd><code>{shown(preview.payload.test_evidence_sha256)}</code></dd></div><div><dt>测试 / 到期时间</dt><dd>{displayTime(preview.payload.tested_at)}<br />{displayTime(preview.payload.expires_at)}</dd></div><div><dt>实际模型矩阵</dt><dd><pre>{JSON.stringify(preview.payload.models || [], null, 2)}</pre></dd></div></dl>}{preview.errors.length > 0 ? <ul className="cc-validation-errors">{preview.errors.map((error) => <li key={error}>{error}</li>)}</ul> : <p className="cc-local-valid"><CheckCircle size={17} />本地格式检查通过；不代表真实推理或管理员验收已通过。</p>}</>}</aside></div>
      <div className="cc-submit-area"><label className="cc-attestation"><input type="checkbox" checked={confirmedEvidence} disabled={submitting || accessDenied || !selectedBinding || !preview.payload || preview.errors.length > 0 || uncertainSubmission} onChange={(event) => { draftVersion.current += 1; setConfirmedEvidence(event.target.checked); }} /><span><strong>已核对实际部署制品与真实推理证据</strong><small>我已确认节点、实际模型、完整输入输出、证据摘要和有效期完全对应；未实测的工具、多模态、向量或语言能力不登记为已通过。</small></span></label><button className="button primary" type="submit" disabled={!canSubmit}><ShieldCheck size={18} />{submitting ? "正在确认登记" : "核对并登记验收"}</button></div>
      {uncertainSubmission && <p className="cc-uncertain">上一次登记结果尚未确认。请使用下方“刷新验收记录”先核对现有记录；系统不会自动重复提交。</p>}
    </form>
    <section className="cc-card"><header className="cc-record-heading"><div><h3>所选节点的验收记录</h3><p>“当前有效状态”由服务端判断，不代表节点在线；节点须正式上报后才会进入实时目录。</p></div><button className="button secondary" type="button" disabled={!selectedBinding || recordsLoading || submitting || accessDenied} onClick={() => loadAcceptances(selectedBinding)}><ArrowClockwise size={18} />{recordsLoading ? "正在刷新" : "刷新验收记录"}</button></header>
      {!selectedBinding ? <p className="cc-empty">请先选择节点。</p> : recordsLoading ? <p className="cc-empty" role="status">正在读取该节点的验收记录…</p> : !acceptances.length ? <p className="cc-empty">该节点暂无验收记录。完成真实推理验收并人工核对后，才能登记。</p> : <div className="cc-record-list">{acceptances.map((record) => <article className="cc-record" key={record.id}><header><div><strong>{CAPABILITIES[record.capability_id] || "共享能力"}</strong><code>{record.capability_id} · {record.capability_version}</code></div><StatusPill status={effectiveStatus(record)} /></header><dl className="cc-record-grid"><div><dt>验收编号</dt><dd><code>{record.id}</code></dd></div><div><dt>登记状态 status</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>当前有效状态 effective_status</dt><dd><StatusPill status={effectiveStatus(record)} /></dd></div><div><dt>实际制品 SHA-256</dt><dd><code>{record.artifact_sha256}</code></dd></div><div><dt>真实证据 SHA-256</dt><dd><code>{record.test_evidence_sha256}</code></dd></div><div><dt>测试 / 到期时间</dt><dd>{displayTime(record.tested_at)}<br />{displayTime(record.expires_at)}</dd></div></dl><div className="cc-record-models"><span>实际验收模型</span><pre>{JSON.stringify(record.models || [], null, 2)}</pre></div></article>)}</div>}
    </section>
  </section>;
}
