import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
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
import { normalizeH3TaskInput, registerH3SharedRoutes, toH3WorkerTask } from "../../server/h3-shared.js";

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

test("website H3 input preserves the original Chinese prompt and keeps legacy clients opted into desktop-local optimization", () => {
  const input = normalizeH3TaskInput({ prompt: "让@图片1中的人物在竹林缓慢回头", authoring_prompt: "SHOULD NOT WIN", optimized_prompt: "SHOULD NOT WIN", duration_seconds: 5, assets: { images: [{ object_key: "h3/requesters/test/assets/picture-1.png" }], videos: [], audio: [] } });
  assert.equal(input.prompt, "让@图片1中的人物在竹林缓慢回头");
  assert.equal(input.originalPrompt, input.prompt);
  assert.equal(input.sourcePrompt, input.prompt);
  assert.equal(input.compiledPrompt, undefined);
  assert.equal(input.promptOptimizationEnabled, true);
  assert.equal(input.localPromptOptimizationRequired, true);
  assert.equal(input.promptMode, "desktop_local_magic_v1");
  assert.deepEqual(input.promptCompilation, { mode: "desktop_local_magic_v1", source: "execution_node", validated: false, status: "pending" });
});

test("website H3 input can explicitly keep the raw prompt and skip desktop-local optimization", () => {
  const input = normalizeH3TaskInput({ prompt: "让@图片1中的人物在竹林缓慢回头", prompt_optimization_enabled: false, duration_seconds: 5, assets: { images: [{ object_key: "h3/requesters/test/assets/picture-1.png" }], videos: [], audio: [] } });
  assert.equal(input.prompt, "让@图片1中的人物在竹林缓慢回头");
  assert.equal(input.promptOptimizationEnabled, false);
  assert.equal(input.localPromptOptimizationRequired, false);
  assert.equal(input.promptMode, "raw_prompt_v1");
  assert.deepEqual(input.promptCompilation, { mode: "raw_prompt_v1", source: "requester", validated: false, status: "skipped" });
});

test("web H3 composer exposes an opt-in magic control and submits the explicit user choice", async () => {
  const source = await readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8");
  assert.match(source, /useState\(false\)[\s\S]+prompt_optimization_enabled: h3PromptOptimizationEnabled/);
  assert.match(source, /MagicWand[\s\S]+agent-h3-prompt-toggle[\s\S]+aria-pressed=\{h3PromptOptimizationEnabled\}/);
  assert.match(source, /<span>魔法优化<\/span>[\s\S]+\? "开" : "关"/);
  assert.doesNotMatch(source, /WandSparkles|agent-h3-magic|optimizeH3Prompt|h3PromptState|h3OriginalPrompt/);
  assert.doesNotMatch(source, /authoring_prompt|optimized_prompt|\/api\/h3\/prompts\/optimize/);
});

test("website H3 optimizer endpoint is retired with a Chinese migration response", async () => {
  const isolated = new OpenAPIHono();
  registerH3SharedRoutes(isolated, {
    getCollection: async () => ({ findOne: async () => null }),
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ error: new Response(null, { status: 401 }) }),
    requireAdmin: async () => ({ error: new Response(null, { status: 403 }) }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => null,
  });
  const response = await isolated.request("http://localhost/api/h3/prompts/optimize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "原始中文提示词" }),
  });
  assert.equal(response.status, 410);
  const payload = await response.json();
  assert.equal(payload.code, "PROMPT_OPTIMIZATION_MOVED_TO_DESKTOP");
  assert.match(payload.message, /prompt_optimization_enabled.*桌面端.*本地魔法优化/);
});

test("worker task receives the original prompt plus the selected local optimization contract", () => {
  const task = normalizeH3TaskInput({ prompt: "金色鲤鱼跃过龙门", duration_seconds: 5, assets: { images: [], videos: [], audio: [] } });
  const dto = toH3WorkerTask({ _id: "task-1", orderNo: "H3-1", ...task });
  assert.equal(dto.prompt, "金色鲤鱼跃过龙门");
  assert.equal(dto.source_prompt, dto.prompt);
  assert.equal(dto.original_prompt, dto.prompt);
  assert.equal(dto.prompt_mode, "desktop_local_magic_v1");
  assert.equal(dto.prompt_optimization_enabled, true);
  assert.equal(dto.local_prompt_optimization_required, true);
  assert.deepEqual(dto.progress_callback.first_required_fields, ["estimated_total_seconds", "compiled_prompt"]);
  assert.equal(dto.progress_callback.optimization_status, "optimizing");
  assert.equal(dto.compiled_prompt, undefined);
  for (const forbidden of ["requester", "priceFen", "walletLedgerId", "bindingId"]) assert.equal(Object.hasOwn(dto, forbidden), false);

  const rawTask = normalizeH3TaskInput({ prompt: "直接使用这一句中文", prompt_optimization_enabled: false, duration_seconds: 5, assets: { images: [], videos: [], audio: [] } });
  const rawDto = toH3WorkerTask({ _id: "task-2", orderNo: "H3-2", ...rawTask });
  assert.equal(rawDto.prompt, "直接使用这一句中文");
  assert.equal(rawDto.prompt_mode, "raw_prompt_v1");
  assert.equal(rawDto.prompt_optimization_enabled, false);
  assert.equal(rawDto.local_prompt_optimization_required, false);
  assert.deepEqual(rawDto.progress_callback.first_required_fields, ["estimated_total_seconds"]);
  assert.equal(rawDto.progress_callback.optimization_status, undefined);
});

test("buildH3AuthoringPrompt never changes the compiled model body", () => {
  const compiled = compileH3Prompt({ prompt: "A crane flies over calm water.", durationSeconds: 5, assets: {} }).prompt;
  const authoring = buildH3AuthoringPrompt(compiled);
  assert.equal(stripH3ControlTemplate(authoring), compiled);
});
