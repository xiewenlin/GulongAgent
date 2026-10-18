import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/components/CapabilityConsumersPanel.jsx", import.meta.url), "utf8");
const admin = await readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../../src/components/CapabilityConsumersPanel.css", import.meta.url), "utf8");
// Compile only the trusted, source-controlled pure JSON preview functions, not
// JSX or uploaded data. No browser, build output, files or network requests.
const prelude = source.slice(source.indexOf("const ROOT"), source.indexOf("function displayTime"));
const { parseAcceptanceDraft, shown, capabilityName, consumerBindingSearchParams } = new Function(`${prelude.replaceAll("export function ", "function ")}\nreturn {parseAcceptanceDraft, shown, capabilityName, consumerBindingSearchParams};`)();
const binding = { binding_id: "1234567890abcdef12345678", node_id: "test-only-node", node_name: "仅本地解析测试夹具" };
const body = () => ({
  binding_id: binding.binding_id, capability_id: "gulong_engine.music", capability_version: "1.0.0",
  artifact_sha256: "a".repeat(64), test_evidence_sha256: "b".repeat(64),
  models: [{ id: "fixture-only/music-model", max_duration_seconds: 300 }], asr_languages: ["zh"],
  contract_tests: { music_generation: true, whole_audio_asr: true, exact_lyrics: true, exact_duration: true },
  tested_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86400_000).toISOString(),
  admin_confirmed_real_consumer: true,
});

test("administrator menu opens the consumer acceptance panel through the existing section deep link", () => {
  assert.match(admin, /id: "capability-consumers", label: "共享能力验收"/);
  assert.match(admin, /active === "capability-consumers" && <CapabilityConsumersPanel/);
  assert.match(admin, /user\.role !== "admin"/);
  assert.match(source, /\/api\/admin\/capability-consumers/);
});

test("node search sends complete hash IDs exactly and names as bounded fuzzy keywords", () => {
  const load = source.slice(source.indexOf("async function loadBindings"), source.indexOf("async function loadAcceptances"));
  assert.match(load, /consumerBindingSearchParams\(nextQuery\)/);
  assert.match(load, /params\.size \? `\?\$\{params\}` : ""/);
  assert.match(source, /id="cc-node-query" maxLength=\{100\}/);
  assert.match(source, /binding_id: binding\.binding_id/);
  const nodeId = "85254b9d69e4e3307049020c58bab89f2edae70a50817c37ca561194105512d1";
  assert.equal(consumerBindingSearchParams(` ${nodeId} `).toString(), `node_id=${nodeId}`);
  assert.equal(consumerBindingSearchParams(" 施富的设备 ").get("q"), "施富的设备");
  assert.equal(consumerBindingSearchParams("   ").toString(), "");
  assert.equal(consumerBindingSearchParams("short-node-id").get("q"), "short-node-id");
});

test("failed binding searches invalidate stale selection and never masquerade as zero matches", async () => {
  const loadSource = source.slice(source.indexOf("  async function loadBindings"), source.indexOf("  async function loadAcceptances"));
  const bindingRequest = { current: 1 }, recordRequest = { current: 4 }, draftVersion = { current: 2 }, mounted = { current: true };
  const state = {}, names = ["setBindingsLoading", "setBindingSearchFailed", "setBindings", "setSelectedBinding", "setAcceptances", "setRecordsLoading", "setConfirmedEvidence", "setAccessDenied", "setNotice"];
  const apiError = { status: 400, message: "查询参数不正确" };
  const load = new Function("query", "bindingRequest", "recordRequest", "draftVersion", "mounted", "selectedBinding", "ROOT", "consumerBindingSearchParams", "apiFetch", "failRequest", ...names,
    `${loadSource}\nreturn loadBindings;`)("", bindingRequest, recordRequest, draftVersion, mounted, binding, "/api/admin/capability-consumers", consumerBindingSearchParams,
    async () => { throw apiError; }, (error) => { state.error = error; }, ...names.map((name) => (value) => { state[name] = value; }));
  await load("test");
  assert.equal(state.setBindingSearchFailed, true);
  assert.equal(state.setBindingsLoading, false);
  assert.equal(state.setNotice, null, "a new search clears stale errors from an earlier request");
  assert.equal(state.setRecordsLoading, false);
  assert.equal(state.setSelectedBinding, null);
  assert.equal(state.setConfirmedEvidence, false);
  assert.deepEqual(state.setBindings, []);
  assert.deepEqual(state.setAcceptances, []);
  assert.equal(state.error, apiError);
  assert.equal(recordRequest.current, 5);
  assert.equal(draftVersion.current, 3);
  assert.ok(source.indexOf('bindingSearchFailed ? <p className="cc-empty" role="alert">') < source.indexOf("没有找到匹配节点"));
  assert.match(source, /目前无法判断是否存在匹配节点/);
});

test("preview validates the selected binding and preserves the submitted evidence without manufacturing fields", () => {
  const input = body(), serialized = JSON.stringify(input);
  const parsed = parseAcceptanceDraft(serialized, binding);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.payload, input);
  assert.ok(parseAcceptanceDraft(serialized, null).errors.some((error) => error.includes("选择")));
  assert.ok(parseAcceptanceDraft(serialized, { ...binding, binding_id: "abcdef1234567890abcdef12" }).errors.some((error) => error.includes("不一致")));
  assert.equal(JSON.stringify(input), serialized);
});

test("invalid object/array fields never crash preview parsing or become React object children", () => {
  for (const key of ["binding_id", "capability_id", "capability_version", "artifact_sha256", "test_evidence_sha256", "tested_at", "expires_at", "default_model", "models", "contract_tests"]) {
    const parsed = parseAcceptanceDraft(JSON.stringify({ ...body(), [key]: { toString: "not-callable" } }), binding);
    assert.ok(parsed.errors.length > 0, key);
  }
  const prototypeValue = parseAcceptanceDraft(JSON.stringify({ ...body(), capability_id: "__proto__" }), binding);
  assert.ok(prototypeValue.errors.length > 0);
  assert.equal(capabilityName("__proto__"), "未知能力");
  assert.equal(capabilityName({}), "未知能力");
  for (const value of [{}, [], null, undefined]) assert.equal(typeof shown(value), "string");
  for (const field of ["binding_id", "capability_id", "capability_version", "artifact_sha256", "test_evidence_sha256"]) assert.ok(source.includes(`shown(preview.payload.${field})`), field);
  assert.match(source, /Object\.hasOwn\(CAPABILITIES, id\)/);
});

test("preview rejects credentials, unsafe JSON, oversized input and fabricated/missing proof assertions", () => {
  for (const field of ["api_key", "access_token", "private_key", "authorization", "password"]) {
    assert.equal(parseAcceptanceDraft(JSON.stringify({ ...body(), [field]: "fixture-only-not-a-real-secret" }), binding).payload, null);
  }
  assert.equal(parseAcceptanceDraft("x".repeat(64 * 1024 + 1), binding).payload, null);
  assert.equal(parseAcceptanceDraft("[]", binding).payload, null);
  assert.equal(parseAcceptanceDraft("{broken json", binding).payload, null);
  assert.ok(parseAcceptanceDraft(JSON.stringify({ ...body(), admin_confirmed_real_consumer: false }), binding).errors.length);
  assert.ok(parseAcceptanceDraft(JSON.stringify({ ...body(), contract_tests: { music_generation: true } }), binding).errors.length);
  assert.ok(parseAcceptanceDraft(JSON.stringify({ ...body(), models: [{ id: "fixture-only/music-model" }] }), binding).errors.length);
});

test("proof JSON upload is local editable preview only; no automatic POST from load, effect or upload", () => {
  assert.equal((source.match(/method: "POST"/g) || []).length, 1);
  const upload = source.slice(source.indexOf("async function importFile"), source.indexOf("async function submitRegistration"));
  assert.match(upload, /await file\.text\(\)/);
  assert.match(upload, /setDraft\(source\)/);
  assert.doesNotMatch(upload, /apiFetch|fetch\(/);
  assert.match(upload, /file\.size > MAX_JSON_BYTES/);
  const effect = source.slice(source.indexOf("  useEffect(() => {"), source.indexOf("  return <section"));
  assert.doesNotMatch(effect, /POST|submitRegistration\(/);
});

test("explicit checkbox, selected binding and shared confirmation must precede the sole write", () => {
  assert.match(source, /const \[confirmedEvidence, setConfirmedEvidence\] = useState\(false\)/);
  assert.match(source, /已核对实际部署制品与真实推理证据/);
  assert.match(source, /disabled=\{!canSubmit\}/);
  const submit = source.slice(source.indexOf("async function submitRegistration"), source.indexOf("  useEffect(() => {"));
  assert.match(submit, /!selectedBinding \|\| !confirmedEvidence \|\| checked\.errors\.length/);
  assert.ok(submit.indexOf("await confirmAction(") < submit.indexOf('method: "POST"'));
  assert.ok(submit.indexOf("if (!accepted") < submit.indexOf('method: "POST"'));
  assert.ok(submit.indexOf("payload.binding_id") < submit.indexOf('method: "POST"'));
  assert.match(submit, /body: JSON\.stringify\(payload\)/);
  assert.doesNotMatch(submit, /admin_confirmed_real_consumer:\s*true|artifact_sha256:\s*|test_evidence_sha256:\s*/);
  assert.match(source, /setConfirmedEvidence\(false\)/);
});

test("registration uses same-origin cookie API and presents clear administrator authentication failures", () => {
  assert.match(source, /import \{ apiFetch, localizeErrorMessage \}/);
  assert.match(source, /error\.status === 401 \|\| error\.status === 403/);
  assert.match(source, /重新登录管理员账号/);
  assert.match(source, /仅限管理员账号/);
  assert.doesNotMatch(source, /Authorization\s*:|window\.confirm|window\.alert|type="password"/);
});

test("401/403 invalidates both pending reads so stale 200 responses cannot restore administrator data", () => {
  const handler = source.slice(source.indexOf("  function failRequest"), source.indexOf("  async function loadBindings"));
  for (const status of [401, 403]) {
    const bindingRequest = { current: 4 }, recordRequest = { current: 7 }, draftVersion = { current: 2 };
    const state = {};
    const names = ["setBindingsLoading", "setRecordsLoading", "setAccessDenied", "setBindings", "setSelectedBinding", "setAcceptances", "setConfirmedEvidence", "setNotice"];
    const setters = names.map((name) => (value) => { state[name] = value; });
    const fail = new Function("bindingRequest", "recordRequest", "draftVersion", ...names, "localizeErrorMessage", `${handler}\nreturn failRequest;`)(bindingRequest, recordRequest, draftVersion, ...setters, (_error, fallback) => fallback);
    const staleBindingRequest = bindingRequest.current, staleRecordRequest = recordRequest.current;
    fail({ status }, "测试错误");
    assert.notEqual(staleBindingRequest, bindingRequest.current);
    assert.notEqual(staleRecordRequest, recordRequest.current);
    assert.equal(draftVersion.current, 3, "pending confirmation is invalidated too");
    assert.equal(state.setAccessDenied, true);
    assert.deepEqual(state.setBindings, []);
    assert.deepEqual(state.setAcceptances, []);
    assert.equal(state.setSelectedBinding, null);
    assert.equal(state.setBindingsLoading, false);
    assert.equal(state.setRecordsLoading, false);
  }
  for (const [start, end, requestRef] of [["async function loadBindings", "async function loadAcceptances", "bindingRequest"], ["async function loadAcceptances", "function chooseBinding", "recordRequest"]]) {
    const load = source.slice(source.indexOf(start), source.indexOf(end));
    assert.ok(load.indexOf(`request !== ${requestRef}.current`) < load.indexOf("setAccessDenied(false)"));
  }
});

test("unknown registration outcome blocks repeat submission until a successful records read", () => {
  assert.match(source, /uncertainBindings\.current\.add\(binding\.binding_id\)/);
  assert.match(source, /uncertainBindings\.current\.delete\(binding\.binding_id\)/);
  assert.match(source, /!uncertainSubmission/);
  assert.match(source, /先刷新当前节点的验收记录核对结果/);
});

test("records show exact hashes, model matrix and effective expiry without declaring a consumer online", () => {
  for (const field of ["record.artifact_sha256", "record.test_evidence_sha256", "record.models", "record.status", "record.effective_status", "record.expires_at"]) assert.ok(source.includes(field), field);
  assert.match(source, /登记本身不代表节点在线或已经可以派单/);
  assert.match(source, /携带列表中的验收编号正式上报/);
  assert.doesNotMatch(source, /\.(?:slice|substring)\([^)]*\).*record\.(?:artifact|test_evidence)/);
});

test("acceptance styling stays scoped, light and responsive without compressed action labels", () => {
  assert.match(css, /\.capability-consumers-panel/);
  assert.match(css, /white-space: nowrap/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /linear-gradient|background:\s*(?:black|#000|#111)/i);
});
