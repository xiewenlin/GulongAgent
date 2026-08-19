import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { acceptH3OptimizedPrompt, compileH3Prompt, validateH3CompiledPrompt } from "../../server/h3-prompt.js";
import { normalizeH3TaskInput, registerH3SharedRoutes } from "../../server/h3-shared.js";

function headers(prompt) {
  return [...prompt.matchAll(/^([a-z_]+):/gm)].map((match) => match[1]);
}

test("H3 base prompt keeps the official three-section order and angle-bracket labels", () => {
  const text = compileH3Prompt({ prompt: "一条锦鲤跃出水面", durationSeconds: 10, aspectRatio: "16:9", assets: { images: [], videos: [], audio: [] } });
  assert.deepEqual(headers(text.prompt), ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]);
  assert.match(text.prompt, /non_diegetic_music: N\/A/);
  assert.equal(validateH3CompiledPrompt(text.prompt, { mode: "t2va", assets: {} }).valid, true);
});

test("H3 Ref2VA uses six sections, normalized labels, and one Subject per picture", () => {
  const assets = { images: [{}, {}], videos: [{}], audio: [{}] };
  const text = compileH3Prompt({ prompt: "让@图片1和@图片2中的人物参考@视频1的动作完成追逐", durationSeconds: 15, aspectRatio: "9:16", assets });
  assert.deepEqual(headers(text.prompt), ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]);
  assert.match(text.prompt, /<Subject 1>.*<Picture 1>/s);
  assert.match(text.prompt, /<Subject 2>.*<Picture 2>/s);
  assert.match(text.prompt, /<Video 1>/);
  assert.match(text.prompt, /<Audio 1>/);
  assert.doesNotMatch(text.prompt, /(?<!<)\b(?:Picture|Video|Audio)\s+\d+\b(?!>)/);
  assert.match(text.prompt, /background, furniture, original pose, composition, and lighting are not inherited/i);
});

test("H3 complex motion stays a clear single-shot timeline without accidental transitions", () => {
  const text = compileH3Prompt({ prompt: "镜头缓慢推进。人物绕过桌面后快速回头。", durationSeconds: 12, assets: { images: [{}, {}], videos: [{}], audio: [] } });
  assert.match(text.prompt, /00:00\.000 to 00:12\.000/);
  assert.match(text.prompt, /one continuous .* shot with no dissolves or unintended cuts/i);
  assert.match(text.prompt, /<Video 1>.*motion, camera movement, and pacing guidance/i);
});

test("H3 deterministic compiler removes prohibited spoken and visible-text requests", () => {
  const text = compileH3Prompt({ prompt: "镜头环绕产品。加入旁白、台词和字幕。使用 FLUX 合成首帧。", durationSeconds: 8, assets: {} });
  assert.doesNotMatch(text.prompt, /voice[- ]?over|narration|dialogue|subtitle|caption|旁白|台词|字幕|FLUX|首帧合成/i);
  assert.match(text.prompt, /non_diegetic_music: N\/A/);
});

test("H3 invalid model rewrite falls back to the deterministic validated compiler", () => {
  const input = { prompt: "两个人在竹林奔跑", durationSeconds: 10, assets: { images: [{}, {}], videos: [], audio: [] } };
  const result = acceptH3OptimizedPrompt("Picture 1 dialogue subtitles", input);
  assert.equal(result.source, "deterministic");
  assert.equal(result.validation.valid, true);
  assert.match(result.prompt, /<Picture 1>/);
  assert.doesNotMatch(result.prompt, /dialogue|subtitles/i);
});

test("H3 task creation queues the validated optimized prompt and deterministically compiles raw input", () => {
  const optimized = compileH3Prompt({ prompt: "金色鲤鱼跃过龙门", durationSeconds: 5, assets: {} }).prompt;
  const accepted = normalizeH3TaskInput({ prompt: optimized, original_prompt: "金色鲤鱼跃过龙门", optimized_prompt: optimized, duration_seconds: 5, assets: { images: [], videos: [], audio: [] } });
  assert.equal(accepted.prompt, optimized);
  assert.equal(accepted.originalPrompt, "金色鲤鱼跃过龙门");
  assert.equal(accepted.promptCompilation.source, "client_optimized");
  const fallback = normalizeH3TaskInput({ prompt: "金色鲤鱼跃过龙门", duration_seconds: 5, assets: { images: [], videos: [], audio: [] } });
  assert.notEqual(fallback.prompt, fallback.originalPrompt);
  assert.deepEqual(headers(fallback.prompt), ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]);
});

test("web H3 composer places a lucide magic action after duration and fills the prompt", async () => {
  const source = await readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8");
  const durationSelect = source.indexOf("select value={duration}");
  const magicButton = source.indexOf("agent-h3-magic", durationSelect);
  const modelSelect = source.indexOf("agent-model-select", durationSelect);
  assert.ok(durationSelect >= 0 && magicButton > durationSelect && modelSelect > magicButton);
  assert.match(source, /import \{ WandSparkles \} from "lucide-react"/);
  assert.match(source, /\/api\/h3\/prompts\/optimize/);
  assert.match(source, /setDraft\(optimized\)/);
  assert.match(source, /original_prompt: h3OriginalPrompt \|\| content, optimized_prompt:/);
});

test("H3 optimizer endpoint validates model output and safely falls back", async () => {
  const isolated = new OpenAPIHono();
  const auditRows = [];
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
    callPearApiChat: async () => ({ text: "Picture 1 dialogue subtitles" }),
  });
  const response = await isolated.request("http://localhost/api/h3/prompts/optimize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "让@图片1和@图片2中的人物奔跑", duration_seconds: 10, aspect_ratio: "16:9", assets: { images: [{}, {}], videos: [], audio: [] } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.fallback, true);
  assert.match(payload.optimized_prompt, /<Subject 1>.*<Picture 1>/s);
  assert.doesNotMatch(payload.optimized_prompt, /dialogue|subtitles/i);
  assert.equal(auditRows[0].event, "prompt_optimized");
});
