const BASE_SECTIONS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
const REFERENCE_SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
const PROHIBITED_PIPELINE = /z[- ]?image|flux|intermediate image|first[- ]frame synthesis|首帧合成|中间图像/iu;
const CJK_TEXT = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
const CONTROL_START = "[用户自定义控制开始]";
const CONTROL_END = "[用户自定义控制结束]";
const SILENT_VISUAL_POLICY = "Every visible person remains silent with lips naturally closed. No dialogue, voice-over, narration, announcer voice, prompt reading, text-to-speech, singing, whispering, chanting, or intelligible vocal content is present. No subtitles, captions, titles, watermarks, or readable on-screen text appear. Use one continuous shot with no transitions, dissolves, face swapping, or identity swapping.";
const AMBIENT_ONLY_POLICY = "Only natural environmental ambience and synchronized sounds caused by visible physical actions are audible; there is no dialogue, voice-over, narration, prompt reading, text-to-speech, singing, whispering, chanting, or other intelligible human voice.";

export const H3_DEFAULT_CONTROL_TEMPLATE = `${CONTROL_START}
画外音：关闭
对白/人物说话：关闭
字幕/画面文字：关闭
背景音：仅自然环境声和画面中真实发生的动作声
背景音乐：关闭
负向排除：禁止朗读提示词；禁止播报场景描述；禁止旁白、解说、TTS、歌唱、耳语、口播；禁止字幕、标题、水印；禁止转场、溶解、变脸和身份互换
${CONTROL_END}`;

function compilationError(message, code = "H3_PROMPT_COMPILATION_FAILED", status = 422, details = []) {
  return Object.assign(new Error(message), { code, status, details });
}

function countAssets(assets = {}) {
  const count = (value, maximum) => Math.min(maximum, Math.max(0, Array.isArray(value) ? value.length : Number(value || 0)));
  return {
    images: count(assets.images ?? assets.image_count, 9),
    videos: count(assets.videos ?? assets.video_count, 3),
    audio: count(assets.audio ?? assets.audio_count, 3),
  };
}

function sectionPositions(prompt, names) {
  return names.map((name) => ({ name, index: prompt.search(new RegExp(`^${name}:`, "m")) }));
}

function sectionBodies(prompt, names) {
  const matches = [...String(prompt || "").matchAll(/^([a-z_]+):\s*/gm)];
  if (matches.length !== names.length || matches.some((match, index) => match[1] !== names[index])) return null;
  return Object.fromEntries(matches.map((match, index) => [match[1], String(prompt).slice(match.index + match[0].length, matches[index + 1]?.index ?? String(prompt).length).trim()]));
}

function removeUnsafeIntent(value) {
  const parts = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?;\n])/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !PROHIBITED_PIPELINE.test(part))
    .filter((part) => !/\b(?:dialogue|voice[- ]?over|narrat(?:ion|or)|spoken lines?|speech|subtitles?|captions?|titles?|watermarks?|on-screen text|readable text|tts|singing|whispering|chanting|speaks?|says?)\b/iu.test(part));
  return parts.join(" ").trim() || "Create a visually coherent scene with clear physical action and camera continuity.";
}

function normalizeReferenceMentions(value, counts) {
  const limits = { 图片: counts.images, 视频: counts.videos, 音频: counts.audio };
  const names = { 图片: "Picture", 视频: "Video", 音频: "Audio" };
  let prompt = String(value || "").replace(/@\s*(图片|视频|音频)\s*(\d+)/gu, (_, type, number) => {
    const index = Number(number);
    return index >= 1 && index <= limits[type] ? `<${names[type]} ${index}>` : "the referenced asset";
  });
  prompt = prompt.replace(/(?<!<)\b(Picture|Video|Audio)\s+(\d+)\b(?!>)/giu, (_, type, number) => {
    const key = type.toLowerCase() === "picture" ? "images" : type.toLowerCase() === "video" ? "videos" : "audio";
    const index = Number(number);
    return index >= 1 && index <= counts[key] ? `<${type[0].toUpperCase()}${type.slice(1).toLowerCase()} ${index}>` : "the referenced asset";
  });
  return prompt;
}

function clock(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1_000));
  const minutes = Math.floor(milliseconds / 60_000);
  const remainder = milliseconds % 60_000;
  return `${String(minutes).padStart(2, "0")}:${(remainder / 1_000).toFixed(3).padStart(6, "0")}`;
}

export function parseH3AuthoringPrompt(value) {
  const raw = String(value || "").trim();
  const start = raw.indexOf(CONTROL_START);
  const end = raw.indexOf(CONTROL_END);
  const parseControls = (template) => {
    const values = Object.fromEntries(String(template || "").split(/\r?\n/u).map((line) => line.split(/[：:]/u)).filter((parts) => parts.length > 1).map(([key, ...rest]) => [key.trim(), rest.join(":").trim()]));
    return { voiceover: values["画外音"] || "关闭", dialogue: values["对白/人物说话"] || "关闭", visibleText: values["字幕/画面文字"] || "关闭", backgroundSound: values["背景音"] || "仅自然环境声和画面中真实发生的动作声", music: values["背景音乐"] || "关闭", negativeExclusions: values["负向排除"] || "" };
  };
  if (start === 0 && end > start) {
    const controlTemplate = raw.slice(0, end + CONTROL_END.length).trim();
    const sourcePrompt = raw.slice(end + CONTROL_END.length).trim();
    return { controlTemplate, controls: parseControls(controlTemplate), sourcePrompt, hasControlTemplate: true };
  }
  return { controlTemplate: H3_DEFAULT_CONTROL_TEMPLATE, controls: parseControls(H3_DEFAULT_CONTROL_TEMPLATE), sourcePrompt: raw, hasControlTemplate: false };
}

export function stripH3ControlTemplate(value) {
  return parseH3AuthoringPrompt(value).sourcePrompt;
}

export function buildH3AuthoringPrompt(compiledPrompt, controlTemplate = H3_DEFAULT_CONTROL_TEMPLATE) {
  const safeControl = String(controlTemplate || H3_DEFAULT_CONTROL_TEMPLATE).trim();
  return `${safeControl}\n\n${String(compiledPrompt || "").trim()}`;
}

export function containsCjkText(value) {
  return CJK_TEXT.test(String(value || ""));
}

export function h3PromptMode(assets = {}) {
  const counts = countAssets(assets);
  if (counts.images === 0 && counts.videos === 0 && counts.audio === 0) return "t2va";
  if (counts.images === 1 && counts.videos === 0 && counts.audio === 0) return "i2va";
  return "ref2va";
}

export function validateH3CompiledPrompt(prompt, options = {}) {
  const value = String(prompt || "").trim();
  const counts = countAssets(options.assets);
  const mode = options.mode || h3PromptMode(counts);
  const names = mode === "ref2va" ? REFERENCE_SECTIONS : BASE_SECTIONS;
  const errors = [];
  const positions = sectionPositions(value, names);
  if (positions.some((item) => item.index < 0)) errors.push("缺少必需段落");
  if (positions.some((item, index) => index > 0 && item.index <= positions[index - 1].index)) errors.push("段落顺序不正确");
  const allHeaders = [...value.matchAll(/^([a-z_]+):/gm)].map((match) => match[1]);
  if (allHeaders.length !== names.length || allHeaders.some((name, index) => name !== names[index])) errors.push("段落名称或数量不正确");
  if (value.includes(CONTROL_START) || value.includes(CONTROL_END)) errors.push("模型提示词中残留了编译期控制模板");
  if (containsCjkText(value)) errors.push("模型提示词的非对白正文必须为纯英文");
  if (/@\s*(?:图片|视频|音频)\s*\d+/u.test(value) || /(?<!<)\b(?:Picture|Video|Audio)\s+\d+\b(?!>)/iu.test(value)) errors.push("素材标签没有使用尖括号");
  for (let index = 1; index <= counts.images; index += 1) if (!value.includes(`<Picture ${index}>`)) errors.push(`缺少 <Picture ${index}>`);
  for (let index = 1; index <= counts.videos; index += 1) if (!value.includes(`<Video ${index}>`)) errors.push(`缺少 <Video ${index}>`);
  for (let index = 1; index <= counts.audio; index += 1) if (!value.includes(`<Audio ${index}>`)) errors.push(`缺少 <Audio ${index}>`);
  if (mode === "ref2va" && counts.images > 1) {
    for (let index = 1; index <= counts.images; index += 1) if (!value.includes(`<Subject ${index}>`) || !value.includes(`<Picture ${index}>`)) errors.push(`多图人物缺少 <Subject ${index}> 定义`);
    if (!/background, furniture, original pose, composition, and lighting are not inherited/i.test(value)) errors.push("没有明确拒绝继承参考图场景信息");
  }
  if (PROHIBITED_PIPELINE.test(value)) errors.push("包含禁用的中间生成路线");
  const bodies = sectionBodies(value, names);
  const visualBody = mode === "ref2va" ? bodies?.detailed_description : bodies?.integrated_multimodal_description;
  if (!visualBody || !/lips naturally closed/i.test(visualBody) || !/no dialogue, voice-over, narration, announcer voice, prompt reading, text-to-speech, singing, whispering, chanting, or intelligible vocal content/i.test(visualBody)) errors.push("缺少人物静默和禁止朗读提示词的硬约束");
  if (!visualBody || !/no subtitles, captions, titles, watermarks, or readable on-screen text/i.test(visualBody)) errors.push("缺少字幕和画面文字禁用约束");
  if (!visualBody || !/no transitions, dissolves, face swapping, or identity swapping/i.test(visualBody)) errors.push("缺少转场和身份互换禁用约束");
  const soundscape = bodies?.overall_soundscape || "";
  if (!/only natural environmental ambience and synchronized sounds caused by visible physical actions/i.test(soundscape) || !/no dialogue, voice-over, narration, prompt reading, text-to-speech, singing, whispering, chanting, or other intelligible human voice/i.test(soundscape)) errors.push("音频策略不是纯环境声或仍允许可理解人声");
  const music = bodies?.non_diegetic_music || "";
  if (music !== "N/A") errors.push("背景音乐必须为 N/A");
  if (/<d>|\(S\d+\)|\b(?:says?|speaks?|asks?|replies|shouts?|whispers?)\s+["“']/iu.test(value)) errors.push("包含对白或说话人标记");
  return { valid: errors.length === 0, errors: [...new Set(errors)], mode, sections: names };
}

function subjectDefinitions(counts) {
  const definitions = [];
  for (let index = 1; index <= counts.images; index += 1) definitions.push(`<Subject ${index}> is the visible subject whose identity and appearance come from <Picture ${index}>. Only identity and visible appearance are retained; the source background, furniture, original pose, composition, and lighting are not inherited unless the user's visual intent explicitly requests them.`);
  for (let index = 1; index <= counts.videos; index += 1) definitions.push(`<Video ${index}> provides motion, camera movement, and pacing guidance for one continuous target shot.`);
  for (let index = 1; index <= counts.audio; index += 1) definitions.push(`<Audio ${index}> provides non-verbal environmental texture and action-synchronized rhythm only.`);
  return definitions.join("\n");
}

function retentionAnalysis(counts) {
  const rows = [];
  for (let index = 1; index <= counts.images; index += 1) rows.push(`<Subject ${index}> (throughout [Shot 1]): partially_preserved - identity and visible appearance from <Picture ${index}> are retained while scene layout, pose, composition, and lighting are newly directed by the target intent.`);
  for (let index = 1; index <= counts.videos; index += 1) rows.push(`<Video ${index}> (motion, camera, and pacing): weak_reference - only its physical movement, camera behavior, and temporal rhythm guide the new single shot.`);
  for (let index = 1; index <= counts.audio; index += 1) rows.push(`<Audio ${index}>: reference - only non-verbal environmental texture and action-synchronized rhythm are referenced.`);
  return rows.join("\n");
}

function referencedSubjects(counts) {
  const labels = [];
  for (let index = 1; index <= counts.images; index += 1) labels.push(`<Subject ${index}>`);
  for (let index = 1; index <= counts.videos; index += 1) labels.push(`<Video ${index}>`);
  for (let index = 1; index <= counts.audio; index += 1) labels.push(`<Audio ${index}>`);
  return labels.join(", ");
}

export function compileH3Prompt(input = {}) {
  const parsed = parseH3AuthoringPrompt(input.prompt);
  const counts = countAssets(input.assets);
  const mode = input.mode || h3PromptMode(counts);
  const duration = Math.max(1, Math.round(Number(input.durationSeconds ?? input.duration_seconds ?? 5)));
  const ratio = String(input.aspectRatio ?? input.aspect_ratio ?? "16:9").trim() || "16:9";
  const intent = normalizeReferenceMentions(removeUnsafeIntent(parsed.sourcePrompt), counts);
  if (containsCjkText(intent)) throw compilationError("提示词包含中文场景描述，需要先完成英文优化；翻译失败时不会把中文提示词发送给 MiniMax H3", "H3_PROMPT_TRANSLATION_REQUIRED", 422);
  const timeline = `[Shot 1] From 00:00.000 to ${clock(duration)}, use one continuous ${ratio} shot with no unintended cuts. Establish the subjects and environment immediately, develop the requested physical action through clear beginning, middle, and end phases, and keep spatial continuity, screen direction, and camera movement coherent until the final frame. Visual intent: ${intent} ${SILENT_VISUAL_POLICY}`;
  let prompt;
  if (mode === "ref2va") {
    const references = referencedSubjects(counts);
    prompt = `subject_definitions:\n${subjectDefinitions(counts)}\n\nsummary:\n[reference generation] Create a ${duration}-second ${ratio} target video using ${references} only in the roles defined above, with a single continuous shot and a clear time progression.\n\nretention_analysis:\n${retentionAnalysis(counts)}\n\ndetailed_description:\n${timeline}\n\noverall_soundscape: ${AMBIENT_ONLY_POLICY}\n\nnon_diegetic_music: N/A`;
  } else {
    const instruction = mode === "i2va" ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n" : "";
    const imageAnchor = mode === "i2va" ? " Begin from <Picture 1> as the exact first-frame anchor, then develop forward while preserving visible identity and key appearance." : "";
    prompt = `${instruction}integrated_multimodal_description: ${timeline}${imageAnchor}\n\noverall_soundscape: ${AMBIENT_ONLY_POLICY}\n\nnon_diegetic_music: N/A`;
  }
  const validation = validateH3CompiledPrompt(prompt, { mode, assets: counts });
  if (!validation.valid) throw compilationError(`H3 提示词编译失败：${validation.errors.join("；")}`, "H3_PROMPT_COMPILATION_FAILED", 422, validation.errors);
  return { prompt, compiledPrompt: prompt, authoringPrompt: buildH3AuthoringPrompt(prompt, parsed.controlTemplate), mode, source: "deterministic", validation };
}

function replaceSectionBody(prompt, name, replacement) {
  const pattern = new RegExp(`(^${name}:\\s*)[\\s\\S]*?(?=\\n\\n[a-z_]+:|$)`, "m");
  return String(prompt).replace(pattern, `$1${replacement}`);
}

function sanitizeModelVisualBody(value) {
  const unsafe = /\b(?:dialogue|voice[- ]?over|narrat(?:ion|or)|announcer voice|prompt reading|text-to-speech|tts|singing|whispering|chanting|intelligible vocal|subtitles?|captions?|titles?|watermarks?|on-screen text|readable text|speaks?|says?)\b/iu;
  const clean = String(value || "")
    .split(SILENT_VISUAL_POLICY).join(" ")
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !unsafe.test(part) && !PROHIBITED_PIPELINE.test(part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return clean || "Show the requested visual action with coherent physical motion and camera continuity.";
}

export function hardenH3CompiledPrompt(candidate, input = {}) {
  const parsed = parseH3AuthoringPrompt(candidate);
  const counts = countAssets(input.assets);
  const mode = input.mode || h3PromptMode(counts);
  const names = mode === "ref2va" ? REFERENCE_SECTIONS : BASE_SECTIONS;
  let prompt = normalizeReferenceMentions(String(parsed.sourcePrompt || "").trim().replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/i, ""), counts);
  const bodies = sectionBodies(prompt, names);
  if (!bodies) throw compilationError("提示词优化结果没有遵循 MiniMax H3 官方段落结构", "H3_PROMPT_VALIDATION_FAILED", 422);
  const visualSection = mode === "ref2va" ? "detailed_description" : "integrated_multimodal_description";
  const cleanVisualBody = sanitizeModelVisualBody(bodies[visualSection]);
  prompt = replaceSectionBody(prompt, visualSection, `${cleanVisualBody} ${SILENT_VISUAL_POLICY}`.trim());
  prompt = replaceSectionBody(prompt, "overall_soundscape", AMBIENT_ONLY_POLICY);
  prompt = replaceSectionBody(prompt, "non_diegetic_music", "N/A");
  const validation = validateH3CompiledPrompt(prompt, { mode, assets: counts });
  if (!validation.valid) throw compilationError(`H3 提示词安全校验失败：${validation.errors.join("；")}`, containsCjkText(prompt) ? "H3_PROMPT_TRANSLATION_FAILED" : "H3_PROMPT_VALIDATION_FAILED", 422, validation.errors);
  return { prompt, compiledPrompt: prompt, authoringPrompt: buildH3AuthoringPrompt(prompt, parsed.controlTemplate), mode, source: "pearapi", validation };
}

export function h3PromptOptimizerMessages(input = {}) {
  const parsed = parseH3AuthoringPrompt(input.prompt);
  const counts = countAssets(input.assets);
  const mode = input.mode || h3PromptMode(counts);
  const sections = mode === "ref2va" ? REFERENCE_SECTIONS : BASE_SECTIONS;
  return {
    mode,
    controlTemplate: parsed.controlTemplate,
    messages: [
      { role: "system", content: `You compile MiniMax H3 prompts. Return only the final model prompt, without Markdown fences, explanation, or compile-time control metadata. Write every non-dialogue section in English. Use exactly these section names and this order: ${sections.join(", ")}. Keep every <Picture N>, <Video N>, <Audio N>, and <Subject N> label inside angle brackets. For multiple pictures, define one <Subject N> from each corresponding <Picture N>, preserving identity and appearance only, never the source background, furniture, pose, composition, or lighting. Use one continuous shot with a timestamped timeline. People remain silent with naturally closed lips. Prohibit dialogue, voice-over, narration, announcer voice, prompt reading, TTS, singing, whispering, chanting, and intelligible vocals. Prohibit subtitles, captions, titles, watermarks, and readable on-screen text. overall_soundscape must contain only natural ambience and visible action sounds with no intelligible human voice. non_diegetic_music must be exactly N/A. Never use Z-Image, FLUX, intermediate images, or first-frame synthesis.` },
      { role: "user", content: `Compile this visual request into the required MiniMax H3 structure. Translate all scene description and applicable compile-time controls into English. The safety floor always keeps voice-over, dialogue, readable text, and music disabled even if edited controls request otherwise.\n\nContext: ${JSON.stringify({ duration_seconds: input.durationSeconds ?? input.duration_seconds, aspect_ratio: input.aspectRatio ?? input.aspect_ratio, assets: counts, compile_time_controls: parsed.controls })}\n\nVisual request:\n${parsed.sourcePrompt}` },
    ],
  };
}

export function acceptH3OptimizedPrompt(candidate, input = {}) {
  try {
    return hardenH3CompiledPrompt(candidate, input);
  } catch (error) {
    if (containsCjkText(parseH3AuthoringPrompt(input.prompt).sourcePrompt)) throw compilationError("英文提示词优化没有通过安全校验，已阻止把中文场景描述发送给 MiniMax H3，请重试", "H3_PROMPT_TRANSLATION_FAILED", 422, error?.details || []);
    const deterministic = compileH3Prompt(input);
    return { ...deterministic, fallbackReason: error?.details || [error?.message || "模型输出校验失败"] };
  }
}
