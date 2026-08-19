const BASE_SECTIONS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
const REFERENCE_SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
const PROHIBITED_AUDIOVISUAL = /\b(?:voice[- ]?over|narrat(?:ion|or)|dialogue|spoken lines?|speech|subtitles?|captions?|visible titles?|on-screen titles?)\b|配音|旁白|画外音|口播|解说|台词|对白|字幕|可见标题/iu;
const PROHIBITED_PIPELINE = /z[- ]?image|flux|intermediate image|first[- ]frame synthesis|首帧合成|中间图像/iu;
const INSTRUMENTAL_REQUEST = /\b(?:instrumental|orchestral|piano|strings|background music|bgm|score)\b|器乐|纯音乐|背景音乐|配乐/iu;

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

function removeUnsafeIntent(value) {
  const parts = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[。！？.!?;；\n])/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !PROHIBITED_AUDIOVISUAL.test(part) && !PROHIBITED_PIPELINE.test(part));
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
  if (/@\s*(?:图片|视频|音频)\s*\d+/u.test(value) || /(?<!<)\b(?:Picture|Video|Audio)\s+\d+\b(?!>)/iu.test(value)) errors.push("素材标签没有使用尖括号");
  for (let index = 1; index <= counts.images; index += 1) if (!value.includes(`<Picture ${index}>`)) errors.push(`缺少 <Picture ${index}>`);
  for (let index = 1; index <= counts.videos; index += 1) if (!value.includes(`<Video ${index}>`)) errors.push(`缺少 <Video ${index}>`);
  for (let index = 1; index <= counts.audio; index += 1) if (!value.includes(`<Audio ${index}>`)) errors.push(`缺少 <Audio ${index}>`);
  if (mode === "ref2va" && counts.images > 1) {
    for (let index = 1; index <= counts.images; index += 1) {
      if (!value.includes(`<Subject ${index}>`) || !value.includes(`<Picture ${index}>`)) errors.push(`多图人物缺少 <Subject ${index}> 定义`);
    }
    if (!/background, furniture, original pose, composition, and lighting are not inherited/i.test(value)) errors.push("没有明确拒绝继承参考图场景信息");
  }
  if (PROHIBITED_AUDIOVISUAL.test(value)) errors.push("包含禁用的声画字段");
  if (PROHIBITED_PIPELINE.test(value)) errors.push("包含禁用的中间生成路线");
  const music = value.match(/^non_diegetic_music:\s*(.*)$/mi)?.[1]?.trim() || "";
  if (!options.instrumentalRequested && music !== "N/A") errors.push("未明确要求器乐配乐时必须为 N/A");
  return { valid: errors.length === 0, errors, mode, sections: names };
}

function subjectDefinitions(counts) {
  const definitions = [];
  for (let index = 1; index <= counts.images; index += 1) {
    definitions.push(`<Subject ${index}> is the visible subject whose identity and appearance come from <Picture ${index}>. Only identity and visible appearance are retained; the source background, furniture, original pose, composition, and lighting are not inherited unless the user's visual intent explicitly requests them.`);
  }
  for (let index = 1; index <= counts.videos; index += 1) definitions.push(`<Video ${index}> provides motion, camera movement, and pacing guidance for one continuous target shot.`);
  for (let index = 1; index <= counts.audio; index += 1) definitions.push(`<Audio ${index}> provides non-verbal environmental texture and action-synchronized rhythm.`);
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
  const counts = countAssets(input.assets);
  const mode = input.mode || h3PromptMode(counts);
  const duration = Math.max(1, Math.round(Number(input.durationSeconds ?? input.duration_seconds ?? 5)));
  const ratio = String(input.aspectRatio ?? input.aspect_ratio ?? "16:9").trim() || "16:9";
  const rawIntent = removeUnsafeIntent(input.prompt);
  const intent = normalizeReferenceMentions(rawIntent, counts);
  const instrumentalRequested = Boolean(input.instrumentalRequested ?? INSTRUMENTAL_REQUEST.test(String(input.prompt || "")));
  const music = instrumentalRequested ? "A restrained instrumental score follows the requested pacing, using only non-vocal instruments." : "N/A";
  const soundscape = "Natural environmental ambience and synchronized sounds produced by visible physical actions continue across the shot.";
  const timeline = `[Shot 1] From 00:00.000 to ${clock(duration)}, use one continuous ${ratio} shot with no dissolves or unintended cuts. Establish the subjects and environment immediately, develop the requested physical action through clear beginning, middle, and end phases, and keep spatial continuity, screen direction, and camera movement coherent until the final frame. Visual intent: ${intent}`;

  let prompt;
  if (mode === "ref2va") {
    const references = referencedSubjects(counts);
    prompt = `subject_definitions:\n${subjectDefinitions(counts)}\n\nsummary:\n[reference generation] Create a ${duration}-second ${ratio} target video using ${references} only in the roles defined above, with a single continuous shot and a clear time progression.\n\nretention_analysis:\n${retentionAnalysis(counts)}\n\ndetailed_description:\n${timeline}\n\noverall_soundscape: ${soundscape}\n\nnon_diegetic_music: ${music}`;
  } else {
    const instruction = mode === "i2va" ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n" : "";
    const imageAnchor = mode === "i2va" ? " Begin from <Picture 1> as the exact first-frame anchor, then develop forward while preserving visible identity and key appearance." : "";
    prompt = `${instruction}integrated_multimodal_description: ${timeline}${imageAnchor}\n\noverall_soundscape: ${soundscape}\n\nnon_diegetic_music: ${music}`;
  }
  const validation = validateH3CompiledPrompt(prompt, { mode, assets: counts, instrumentalRequested });
  if (!validation.valid) throw Object.assign(new Error(`H3 提示词编译失败：${validation.errors.join("；")}`), { code: "H3_PROMPT_COMPILATION_FAILED", status: 500 });
  return { prompt, mode, source: "deterministic", validation, instrumentalRequested };
}

export function h3PromptOptimizerMessages(input = {}) {
  const deterministic = compileH3Prompt(input);
  return {
    deterministic,
    messages: [
      {
        role: "system",
        content: "You compile MiniMax H3 prompts. Return only the final prompt, without Markdown fences or explanation. Preserve the exact section names and order shown in the supplied deterministic draft. Keep every <Picture N>, <Video N>, <Audio N>, and <Subject N> label inside angle brackets. Use one continuous shot and a clear timestamped timeline. Never add voices, spoken content, text overlays, intermediate image generation, or first-frame synthesis. Do not change non_diegetic_music: N/A unless the input explicitly requests instrumental music.",
      },
      {
        role: "user",
        content: `Improve concrete visual action, composition, camera movement, timing, and physical sound while preserving this exact contract.\n\nContext: ${JSON.stringify({ duration_seconds: input.durationSeconds ?? input.duration_seconds, aspect_ratio: input.aspectRatio ?? input.aspect_ratio, assets: countAssets(input.assets), original_prompt: String(input.prompt || "") })}\n\nDeterministic contract draft:\n${deterministic.prompt}`,
      },
    ],
  };
}

export function acceptH3OptimizedPrompt(candidate, input = {}) {
  const prepared = String(candidate || "").trim().replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/i, "");
  const deterministic = compileH3Prompt(input);
  const normalized = normalizeReferenceMentions(prepared, countAssets(input.assets));
  const validation = validateH3CompiledPrompt(normalized, {
    mode: deterministic.mode,
    assets: input.assets,
    instrumentalRequested: deterministic.instrumentalRequested,
  });
  return validation.valid
    ? { prompt: normalized, mode: deterministic.mode, source: "pearapi", validation, instrumentalRequested: deterministic.instrumentalRequested }
    : { ...deterministic, fallbackReason: validation.errors };
}

