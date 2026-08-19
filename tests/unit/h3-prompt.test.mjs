import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import {
  H3_DEFAULT_CONTROL_TEMPLATE,
  buildH3AuthoringPrompt,
  compileH3Prompt,
  containsCjkText,
  hardenH3CompiledPrompt,
  parseH3AuthoringPrompt,
  stripH3ControlTemplate,
  validateH3CompiledPrompt,
} from "../../server/h3-prompt.js";
import { normalizeH3TaskInput, registerH3SharedRoutes, resolveH3TaskPrompt } from "../../server/h3-shared.js";

function headers(prompt) {
  return [...prompt.matchAll(/^([a-z_]+):/gm)].map((match) => match[1]);
}

test("H3 authoring prompt starts with the editable compile-time control template and strips it before model use", () => {
  const compiled = compileH3Prompt({ prompt: "A golden koi leaps over a stone gate.", durationSeconds: 10, assets: {} });
  assert.ok(compiled.authoringPrompt.startsWith(H3_DEFAULT_CONTROL_TEMPLATE));
  assert.match(compiled.authoringPrompt, /画外音：关闭[\s\S]*禁止朗读提示词/);
  assert.equal(stripH3ControlTemplate(compiled.authoringPrompt), compiled.prompt);
  assert.doesNotMatch(compiled.prompt, /用户自定义控制|画外音|背景音乐/);
  const edited = compiled.authoringPrompt.replace("背景音：仅自然环境声和画面中真实发生的动作声", "背景音：只保留水声与风声");
  const parsed = parseH3AuthoringPrompt(edited);
  assert.match(parsed.controlTemplate, /只保留水声与风声/);
  assert.equal(parsed.controls.backgroundSound, "只保留水声与风声");
});

test("H3 Base prompt uses the official three-section order and pure-English ambient-only policy", () => {
  const result = compileH3Prompt({ prompt: "A golden koi leaps out of a clear pond.", durationSeconds: 10, aspectRatio: "16:9", assets: {} });
  assert.deepEqual(headers(result.prompt), ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]);
  assert.equal(containsCjkText(result.prompt), false);
  assert.match(result.prompt, /lips naturally closed/i);
  assert.match(result.prompt, /prompt reading, text-to-speech, singing, whispering, chanting/i);
  assert.match(result.prompt, /Only natural environmental ambience and synchronized sounds caused by visible physical actions/i);
  assert.match(result.prompt, /non_diegetic_music: N\/A/);
  assert.equal(validateH3CompiledPrompt(result.prompt, { mode: "t2va", assets: {} }).valid, true);
});

test("H3 Ref2VA uses six English sections, exact labels, and one Subject per picture", () => {
  const assets = { images: [{}, {}], videos: [{}], audio: [{}] };
  const result = compileH3Prompt({ prompt: "Let @图片1 and @图片2 follow the motion in @视频1 while @音频1 provides only environmental rhythm.", durationSeconds: 15, aspectRatio: "9:16", assets });
  assert.deepEqual(headers(result.prompt), ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]);
  assert.match(result.prompt, /<Subject 1>.*<Picture 1>/s);
  assert.match(result.prompt, /<Subject 2>.*<Picture 2>/s);
  assert.match(result.prompt, /<Video 1>/);
  assert.match(result.prompt, /<Audio 1>/);
  assert.doesNotMatch(result.prompt, /(?<!<)\b(?:Picture|Video|Audio)\s+\d+\b(?!>)/);
  assert.match(result.prompt, /background, furniture, original pose, composition, and lighting are not inherited/i);
  assert.equal(containsCjkText(result.prompt), false);
});

test("H3 deterministic compiler creates a single-shot timeline and applies all audiovisual exclusions", () => {
  const result = compileH3Prompt({ prompt: "The camera slowly pushes forward as the character circles a table and turns back.", durationSeconds: 12, assets: {} });
  assert.match(result.prompt, /00:00\.000 to 00:12\.000/);
  assert.match(result.prompt, /no transitions, dissolves, face swapping, or identity swapping/i);
  assert.match(result.prompt, /No subtitles, captions, titles, watermarks, or readable on-screen text/i);
  assert.match(result.prompt, /no dialogue, voice-over, narration, announcer voice, prompt reading, text-to-speech, singing, whispering, chanting/i);
});

test("H3 deterministic compiler fails closed when untranslated CJK remains", () => {
  assert.throws(
    () => compileH3Prompt({ prompt: "镜头环绕产品并展示细节", durationSeconds: 8, assets: {} }),
    (error) => error.code === "H3_PROMPT_TRANSLATION_REQUIRED" && error.status === 422,
  );
});

test("H3 existing official structure is re-hardened instead of trusted verbatim", () => {
  const safe = compileH3Prompt({ prompt: "A paper boat moves through rainwater.", durationSeconds: 8, assets: {} }).prompt;
  const weakened = safe
    .replace(/Every visible person[\s\S]*?identity swapping\./, "A presenter speaks while a title appears.")
    .replace(/^overall_soundscape:.*$/m, "overall_soundscape: A narrator reads the scene description.")
    .replace(/^non_diegetic_music:.*$/m, "non_diegetic_music: Vocal song");
  const hardened = hardenH3CompiledPrompt(weakened, { prompt: "A paper boat moves through rainwater.", durationSeconds: 8, assets: {} });
  assert.match(hardened.prompt, /lips naturally closed/i);
  assert.match(hardened.prompt, /Only natural environmental ambience/i);
  assert.match(hardened.prompt, /non_diegetic_music: N\/A/);
  assert.doesNotMatch(hardened.prompt, /presenter speaks|title appears|narrator reads|vocal song/i);
  assert.equal(hardened.validation.valid, true);
});

test("H3 shared resolver translates Chinese through the server model and returns authoring plus compiled prompts", async () => {
  const translated = compileH3Prompt({ prompt: "A golden koi leaps over a stone gate in one continuous shot.", durationSeconds: 5, assets: {} }).prompt;
  const input = normalizeH3TaskInput({ prompt: "金色鲤鱼跃过龙门", duration_seconds: 5, assets: { images: [], videos: [], audio: [] } });
  const resolved = await resolveH3TaskPrompt(input, {
    loadCredential: async () => ({ token: "test-token", tokenChannel: "免费" }),
    callModel: async () => ({ text: translated }),
  });
  assert.equal(containsCjkText(resolved.compiledPrompt), false);
  assert.ok(resolved.authoringPrompt.startsWith(H3_DEFAULT_CONTROL_TEMPLATE));
  assert.equal(stripH3ControlTemplate(resolved.authoringPrompt), resolved.compiledPrompt);
  assert.equal(resolved.promptCompilation.englishOnly, true);
  assert.equal(resolved.promptCompilation.ambientOnly, true);
});

test("H3 shared resolver fails closed when Chinese translation service is unavailable", async () => {
  const input = normalizeH3TaskInput({ prompt: "竹林中的人物缓慢回头", duration_seconds: 5, assets: { images: [], videos: [], audio: [] } });
  await assert.rejects(
    resolveH3TaskPrompt(input, { loadCredential: async () => null, callModel: async () => ({ text: "" }) }),
    (error) => error.code === "H3_PROMPT_TRANSLATION_UNAVAILABLE" && error.status === 503,
  );
});

test("web H3 composer keeps the lucide magic action after duration and fills editable authoring prompt", async () => {
  const source = await readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8");
  const durationSelect = source.indexOf("select value={duration}");
  const magicButton = source.indexOf("agent-h3-magic", durationSelect);
  const modelSelect = source.indexOf("agent-model-select", durationSelect);
  assert.ok(durationSelect >= 0 && magicButton > durationSelect && modelSelect > magicButton);
  assert.match(source, /import \{ WandSparkles \} from "lucide-react"/);
  assert.match(source, /result\.authoring_prompt \|\| result\.optimized_prompt/);
  assert.match(source, /setDraft\(optimized\)/);
  assert.match(source, /authoring_prompt: content/);
});

test("H3 optimizer endpoint returns the editable control template and a separate pure-English compiled prompt", async () => {
  const isolated = new OpenAPIHono();
  const auditRows = [];
  const modelPrompt = compileH3Prompt({ prompt: "Two people run through a bamboo grove in one continuous shot.", durationSeconds: 10, assets: { images: [{}, {}], videos: [], audio: [] } }).prompt;
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => name === "h3TaskAudits"
      ? { insertOne: async (row) => auditRows.push(row) }
      : { findOne: async () => null, insertOne: async () => ({}), updateOne: async () => ({}), updateMany: async () => ({}), find: () => ({ sort() { return this; }, limit() { return this; }, async toArray() { return []; } }) },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: new ObjectId().toString(), role: "user" } }),
    requireAdmin: async () => ({ error: new Response(null, { status: 403 }) }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => null,
    loadPearApiTextCredential: async () => ({ token: "test-token", tokenChannel: "免费" }),
    callPearApiChat: async () => ({ text: modelPrompt }),
  });
  const response = await isolated.request("http://localhost/api/h3/prompts/optimize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "让@图片1和@图片2中的人物在竹林奔跑", duration_seconds: 10, aspect_ratio: "16:9", assets: { images: [{}, {}], videos: [], audio: [] } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.authoring_prompt.startsWith(H3_DEFAULT_CONTROL_TEMPLATE));
  assert.equal(payload.optimized_prompt, payload.authoring_prompt);
  assert.equal(containsCjkText(payload.compiled_prompt), false);
  assert.doesNotMatch(payload.compiled_prompt, /用户自定义控制|画外音/);
  assert.match(payload.compiled_prompt, /<Subject 1>.*<Picture 1>/s);
  assert.match(payload.compiled_prompt, /no dialogue, voice-over, narration/i);
  assert.equal(payload.validation.ambient_only, true);
  assert.equal(auditRows[0].event, "prompt_optimized");
});

test("H3 optimizer endpoint refuses an invalid translation instead of falling back to Chinese", async () => {
  const isolated = new OpenAPIHono();
  registerH3SharedRoutes(isolated, {
    getCollection: async () => ({ findOne: async () => null, insertOne: async () => ({}), updateOne: async () => ({}), updateMany: async () => ({}), find: () => ({ sort() { return this; }, limit() { return this; }, async toArray() { return []; } }) }),
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: new ObjectId().toString(), role: "user" } }),
    requireAdmin: async () => ({ error: new Response(null, { status: 403 }) }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => null,
    loadPearApiTextCredential: async () => ({ token: "test-token", tokenChannel: "免费" }),
    callPearApiChat: async () => ({ text: "这是仍然包含中文的无效结果" }),
  });
  const response = await isolated.request("http://localhost/api/h3/prompts/optimize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "镜头缓慢推进", duration_seconds: 10, aspect_ratio: "16:9", assets: { images: [], videos: [], audio: [] } }),
  });
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.code, "H3_PROMPT_TRANSLATION_FAILED");
  assert.match(payload.message, /已阻止|不会/);
});

test("POST /api/h3/tasks applies the same fail-closed compiler before task insert or wallet charge", async () => {
  const isolated = new OpenAPIHono();
  let taskInserts = 0;
  let walletWrites = 0;
  registerH3SharedRoutes(isolated, {
    getCollection: async (name) => {
      if (name === "h3SharedTasks") return { findOne: async () => null, insertOne: async () => { taskInserts += 1; } };
      if (name === "wallets" || name === "h3WalletLedger") return { findOne: async () => null, updateOne: async () => { walletWrites += 1; } };
      return { findOne: async () => null, insertOne: async () => ({}), updateOne: async () => ({}), updateMany: async () => ({}) };
    },
    queueCoordinator: { invalidate: async () => {} },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: new ObjectId().toString(), email: "member@example.com", role: "user" } }),
    requireAdmin: async () => ({ error: new Response(null, { status: 403 }) }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => null,
    loadPearApiTextCredential: async () => ({ token: "test-token", tokenChannel: "免费" }),
    callPearApiChat: async () => ({ text: "未翻译的中文模型结果" }),
  });
  const response = await isolated.request("http://localhost/api/h3/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "fail-closed-task-001" },
    body: JSON.stringify({ source_channel: "website", model: "minimax_h3_shared", prompt: "人物走过竹林", duration_seconds: 5, aspect_ratio: "16:9", profile: "balanced", assets: { images: [], videos: [], audio: [] } }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "H3_PROMPT_TRANSLATION_FAILED");
  assert.equal(taskInserts, 0);
  assert.equal(walletWrites, 0);
});

test("buildH3AuthoringPrompt never changes the compiled model body", () => {
  const compiled = compileH3Prompt({ prompt: "A crane flies over calm water.", durationSeconds: 5, assets: {} }).prompt;
  const authoring = buildH3AuthoringPrompt(compiled);
  assert.equal(stripH3ControlTemplate(authoring), compiled);
});
