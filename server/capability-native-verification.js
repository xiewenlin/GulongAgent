import { POSE_IMAGE_FIXTURE, POSE_VIDEO_FIXTURE, WHISPER_AUDIO_FIXTURE } from "./capability-probe-fixtures.js";
import { validateSpecialInlineResult, wholeLyricsInTranscript } from "./worklucky-capabilities.js";
import { createHash } from "node:crypto";
import { verifiedImageModelScope } from "./capability-verification-adapters.js";

// Native component revisions are not invented numeric API versions. Formats
// stay bounded; only these capability-specific versions have real adapters.
export const NATIVE_PROBE_VERSIONS = Object.freeze({
  "qwen_image_2_1.text_to_image": ["2.1"], "qwen_image_2_1.multi_image_edit": ["2.1"], "minimax_music_3.generate": ["3"],
  "sam.video_track": ["3.1-object-multiplex"], "whisper.transcribe": ["large-v3-turbo-whisper.cpp"],
  "mediapipe.video_analysis": ["0.10.14-pose-full"],
});
const MODEL_IDS = { "qwen_image_2_1.multi_image_edit": "qwen-image21-uc", "minimax_music_3.generate": "MiniMax-Music3",
  "sam.video_track": "sam-video-3.1", "whisper.transcribe": "whisper-large-v3-turbo", "mediapipe.video_analysis": "mediapipe-pose-full-0.10.14" };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function demand(value, message) { if (!value) throw Object.assign(new Error(message), { code: "VERIFICATION_NATIVE_RESULT_INVALID", status: 409 }); }
const rule = (role, type, max) => ({ role, content_types: [type], max_bytes: max, min_count: 1, max_count: 1 });
const MiB = 1024 * 1024;
const seed = (nonce) => createHash("sha256").update(nonce).digest().readUInt32BE(0) & 0x7fffffff;
const SCOPES = {
  "qwen_image_2_1.multi_image_edit": { task: "multi_image_edit", input_asset_count: 1, width: 512, height: 512, steps: 4, guidance_scale: 4, batch_size: 1, edit_strength: 1 },
  "sam.video_track": { output_format: "native_layers", prompt_mode: "text", max_text_prompts: 1, full_source_frames: true, probe_input_frames: 16, probe_input_seconds: 2 },
  "mediapipe.video_analysis": { output_format: "native_layers", pipeline: "pose", landmark_count: 33, model_complexity: 1, full_source_frames: true, probe_input_frames: 16, probe_input_seconds: 2 },
  "whisper.transcribe": { task: "transcribe", language: "auto", word_timestamps: false, output_format: "json", probe_input_seconds: 11 },
};
export function nativeVerifiedModelScope(capabilityId, model) {
  if (!plain(model) || model.id !== MODEL_IDS[capabilityId]) return null;
  if (capabilityId === "minimax_music_3.generate") {
    if (!Number.isFinite(model.max_duration_seconds) || model.max_duration_seconds < 10 || model.max_duration_seconds > 12
      || model.sample_rate !== 44100 || model.output_format !== "flac" || model.reference_audio_count !== 0) return null;
    return { id: model.id, max_duration_seconds: model.max_duration_seconds, sample_rate: 44100, output_format: "flac", reference_audio_count: 0 };
  }
  const scope = SCOPES[capabilityId];
  return scope && Object.entries(scope).every(([key, value]) => model[key] === value) ? { id: model.id, ...scope } : null;
}

export function automaticNativeNodeMatchesOrder(report, order) {
  if (!report.automaticVerification || !Object.hasOwn(MODEL_IDS, order.capabilityId)) return true;
  if (report.contractTests?.exact_native_scope !== true) return false;
  const p = order.parameters || {}, assets = order.assets || [];
  return Array.isArray(report.models) && report.models.some((model) => {
    const scope = nativeVerifiedModelScope(order.capabilityId, model);
    if (!scope) return false;
    if (order.catalogProbe === true) return true;
    if (!Array.isArray(assets)) return false;
    if (order.capabilityId === "qwen_image_2_1.multi_image_edit") return assets.length === 1 && assets[0].role === "reference_image"
      && ["width", "height", "steps", "guidance_scale", "batch_size", "edit_strength"].every((key) => p[key] === scope[key]);
    if (order.capabilityId === "minimax_music_3.generate") return !assets.length && p.sample_rate === 44100 && p.output_format === "flac"
      && p.language === "auto" && Number.isFinite(p.duration_seconds) && p.duration_seconds >= 10 && p.duration_seconds <= scope.max_duration_seconds;
    if (order.capabilityId === "whisper.transcribe") return assets.length === 1 && assets[0].role === "media" && p.task === "transcribe"
      && p.language === "auto" && !p.initial_prompt && p.word_timestamps !== true && p.output_format === "json";
    if (assets.length !== 1 || assets[0].role !== "source_video" || p.output_format !== "native_layers") return false;
    if (order.capabilityId === "sam.video_track") return p.prompt_mode === "text" && Array.isArray(p.text_prompts) && p.text_prompts.length === 1
      && typeof p.text_prompts[0] === "string" && p.text_prompts[0].trim() && !p.points?.length && !p.box
      && (p.start_frame ?? 0) === 0 && (p.end_frame ?? -1) === -1 && p.sample_fps === undefined;
    return JSON.stringify(p.pipelines) === '["pose"]' && p.model_complexity === 1
      && p.min_detection_confidence === 0.5 && p.min_tracking_confidence === 0.5 && p.output_fps === undefined
      && p.include_world_landmarks !== true && p.include_annotated_video !== true;
  });
}

export function nativeVerificationAvailability(capabilityId, reports = []) {
  if (capabilityId === "qwen_image_2_1.text_to_image") {
    const models = new Map();
    for (const report of reports) {
      if (report.automaticVerification !== true || report.trustedAcceptance !== true || report.contractTests?.exact_image_scope !== true) continue;
      for (const model of report.models || []) {
        const scope = verifiedImageModelScope(capabilityId, model);
        if (scope) models.set(JSON.stringify(scope), scope);
      }
    }
    return { models: [...models.values()] };
  }
  if (!Object.hasOwn(MODEL_IDS, capabilityId)) return {};
  const profiles = new Map();
  for (const report of reports) {
    if (report.automaticVerification !== true || report.trustedAcceptance !== true || report.contractTests?.exact_native_scope !== true) continue;
    for (const model of report.models || []) {
      const scope = nativeVerifiedModelScope(capabilityId, model);
      if (scope) profiles.set(JSON.stringify(scope), scope);
    }
  }
  return { native_profiles: [...profiles.values()] };
}

/** Fixture SHA, full frame count and all mandatory real output roles are checked
 * in addition to the original native payload; no client `validated` is evidence. */
export function createNativeCapabilityVerificationAdapters({ verifyMediaOutputs } = {}) {
  if (typeof verifyMediaOutputs !== "function") return {};
  function supports(inventory, model) {
    return NATIVE_PROBE_VERSIONS[inventory.capabilityId]?.includes(inventory.capabilityVersion) === true
      && plain(model) && model.id === MODEL_IDS[inventory.capabilityId]
      && (inventory.capabilityId !== "minimax_music_3.generate" || Number.isFinite(model.max_duration_seconds)
        && model.max_duration_seconds >= 10 && model.max_duration_seconds <= 300 && inventory.asrLanguages?.includes("en"));
  }
  function createProbe({ inventory, model, nonce }) {
    demand(supports(inventory, model), "原生模型、版本或完整音频识别能力不匹配");
    const id = inventory.capabilityId;
    const common = { outputUploadRequired: true, budget: { max_inferences: 1, max_output_tokens: 0 } };
    if (id === "minimax_music_3.generate") return { ...common, probeKind: "native-music", budget: { ...common.budget, max_audio_seconds: 12, max_asr_passes: 1 },
      parameters: { prompt: `Clear English solo singing, a gentle simple melody. Verification ${nonce}.`,
        lyrics: `Blue sky, silver river.\n${[...createHash("sha256").update(nonce).digest().subarray(0, 4)].map((x) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][x % 10]).join(", ")}.`, duration_seconds: 12,
        sample_rate: 44100, output_format: "flac", language: "auto", seed: seed(nonce) },
      outputRules: [rule("primary_audio", "audio/flac", 64 * MiB)] };
    const image = id === "qwen_image_2_1.multi_image_edit", whisper = id === "whisper.transcribe";
    const input = image ? POSE_IMAGE_FIXTURE : whisper ? WHISPER_AUDIO_FIXTURE : POSE_VIDEO_FIXTURE;
    const budget = { ...common.budget, max_input_assets: 1, max_input_bytes: input.bytes,
      ...(whisper ? { max_audio_seconds: 11 } : image ? { max_images: 1, max_image_pixels: 512 * 512 } : { max_video_frames: 16, max_video_seconds: 2 }) };
    if (image) return { ...common, probeKind: "native-image-edit", budget, inputAssets: [input],
      parameters: { prompt: `Keep the person and pose unchanged. Change the large white fabric cover on the right to pale blue. No added text. ${nonce}`,
        negative_prompt: "", width: 512, height: 512, steps: 4, guidance_scale: 4, batch_size: 1, edit_strength: 1, seed: seed(nonce) },
      outputRules: [rule("primary_image", "image/png", 20 * MiB)] };
    if (whisper) return { ...common, probeKind: "native-whisper", budget, inputAssets: [input],
      parameters: { task: "transcribe", language: "auto", initial_prompt: "", word_timestamps: false, output_format: "json" },
      outputRules: [rule("transcript_json", "application/json", MiB)] };
    if (id === "sam.video_track") return { ...common, probeKind: "native-sam", budget, inputAssets: [input],
      parameters: { prompt_mode: "text", text_prompts: ["person"], points: [], box: null, start_frame: 0, end_frame: -1, output_format: "native_layers" },
      outputRules: [rule("manifest_json", "application/json", MiB), rule("tracks_jsonl", "application/x-ndjson", 4 * MiB), rule("mask_archive", "application/zip", 32 * MiB)] };
    return { ...common, probeKind: "native-mediapipe", budget, inputAssets: [input],
      parameters: { pipelines: ["pose"], model_complexity: 1, min_detection_confidence: 0.5, min_tracking_confidence: 0.5,
        include_world_landmarks: false, include_annotated_video: false, output_format: "native_layers" },
      outputRules: [rule("analysis_json", "application/json", MiB), rule("pose_tracks_jsonl", "application/x-ndjson", 4 * MiB), rule("person_layers_archive", "application/zip", 32 * MiB)] };
  }
  async function validateResult({ challenge, inlineResult, outputs, binding }) {
    const id = challenge.capabilityId;
    demand(supports({ capabilityId: id, capabilityVersion: challenge.capabilityVersion, asrLanguages: challenge.inventory?.asrLanguages || [] }, challenge.model), "原生验收结果不能替换模型或版本");
    demand(plain(inlineResult) && inlineResult.model === challenge.model.id && !Object.hasOwn(inlineResult, "url"), "须返回真实原生模型编号，不接受客户端输出URL");
    if (challenge.probeInputs?.length) demand(inlineResult.input_sha256 === challenge.probeInputs[0].sha256, "原生结果与本次固定输入摘要不一致");
    demand(Array.isArray(outputs) && outputs.length === challenge.probeOutputRules.length
      && outputs.every((row) => plain(row) && Object.keys(row).length === 1 && typeof row.output_id === "string"), "原生验收必须提交所有本次输出的私有票据");
    const verified = await verifyMediaOutputs({ binding, challenge, outputs });
    demand(Array.isArray(verified) && verified.length === outputs.length, "原生结果未完成实际内容校验");
    const one = (role) => { const rows = verified.filter((row) => row.role === role); demand(rows.length === 1, "原生结果角色缺失或重复"); return rows[0]; };
    if (id === "qwen_image_2_1.multi_image_edit") {
      const image = one("primary_image"); demand(image.width === 512 && image.height === 512 && image.actualContentType === "image/png", "参考图编辑的实际输出尺寸或格式不匹配");
    } else if (id === "minimax_music_3.generate") {
      const audio = one("primary_audio");
      validateSpecialInlineResult({ capabilityId: "gulong_engine.music", parameters: { model: challenge.model.id, caption: challenge.parameters.prompt,
        lyrics: challenge.parameters.lyrics, seconds: challenge.parameters.duration_seconds, seed: challenge.parameters.seed } }, inlineResult, { outputs: verified });
      demand(audio.durationSeconds >= 11 && audio.durationSeconds <= 12.05 && audio.sampleRate === 44100 && inlineResult.lyric_verification.language === "en", "完整音乐时长、采样率或整段ASR语言不匹配");
      return { verifiedModel: { id: challenge.model.id, max_duration_seconds: Math.min(12, audio.durationSeconds), sample_rate: 44100, output_format: "flac", reference_audio_count: 0 },
        contractTests: { exact_native_scope: true, music_generation: true, whole_audio_asr: true, exact_lyrics: true, exact_duration: true }, asrLanguages: ["en"] };
    } else if (id === "whisper.transcribe") {
      const json = one("transcript_json").json, rows = json?.transcription;
      demand(Array.isArray(rows) && rows.length > 0 && rows.length <= 128 && [json.result?.language, json.language].includes("en"), "须保留Whisper完整原生英文转录JSON");
      let end = 0;
      for (const row of rows) {
        const a = row.offsets?.from, b = row.offsets?.to;
        demand(typeof row.text === "string" && row.text.trim() && Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a && b <= 11250 && a >= end - 250, "Whisper原生句段时间戳缺失、乱序或越界"); end = b;
      }
      demand(rows[0].offsets.from <= 1500 && end >= 9500 && wholeLyricsInTranscript("my fellow Americans ask not what your country can do for you ask what you can do for your country", rows.map((row) => row.text).join(" ")), "转录未覆盖完整音频与末尾，不能以截断识别通过");
    } else if (id === "sam.video_track") {
      const manifest = one("manifest_json").json, rows = one("tracks_jsonl").jsonl, archive = one("mask_archive").archiveEntries;
      demand(manifest?.schema === "sam31-object-multiplex-evidence-v1" && manifest.sourceFrameCount === 16 && manifest.framesProcessed === 16
        && JSON.stringify(manifest.promptFrameCounts) === "[16]" && JSON.stringify(manifest.prompts) === '["person"]' && manifest.trace === "objects.jsonl", "SAM须完整处理固定源的每一帧与对象提示");
      demand(Array.isArray(rows) && rows.length >= 16 && rows.length <= 128 && Array.isArray(archive), "SAM逐帧记录或蒙版归档缺失");
      const frames = new Set(), masks = new Set();
      for (const row of rows) {
        demand(Number.isSafeInteger(row.frame) && row.frame >= 0 && row.frame < 16 && Number.isSafeInteger(row.objectId)
          && row.objectId >= 0 && row.concept === "person" && row.visible === true && typeof row.mask === "string"
          && /^masks\/object-\d{5}\/frame-\d{6}\.png$/.test(row.mask) && !masks.has(row.mask), "SAM对象/逐帧/蒙版关联不完整");
        const mask = archive.find((entry) => entry.name === row.mask);
        demand(mask && mask.width === 512 && mask.height === 512 && mask.foregroundRatio > 0.005 && mask.foregroundRatio < 0.95, "SAM真实蒙版为空、全满或尺寸不匹配");
        frames.add(row.frame); masks.add(row.mask);
      }
      demand(frames.size === 16, "SAM缺少源视频帧，禁止以部分轨迹通过");
    } else {
      const json = one("analysis_json").json, evidence = json?.evidence, rows = one("pose_tracks_jsonl").jsonl, archive = one("person_layers_archive").archiveEntries;
      demand(json?.sourceSha256 === POSE_VIDEO_FIXTURE.sha256 && evidence?.decodedFrames === 16 && Array.isArray(rows) && rows.length === 16 && Array.isArray(archive), "姿态分析必须绑定完整原始视频与逐帧记录");
      let poses = 0, masks = 0;
      rows.forEach((row, index) => {
        demand(row.frame === index && Number.isFinite(row.time) && Math.abs(row.time - index / 8) <= 0.03 && Array.isArray(row.landmarks), "姿态分析帧号或时间戳必须完整连续");
        if (row.landmarks.length) {
          demand(row.landmarks.length === 33 && row.landmarks.every((point) => Array.isArray(point) && point.length === 4 && point.every(Number.isFinite)
            && point[3] >= 0 && point[3] <= 1), "姿态必须保留33点及真实可见度"); poses++;
        }
        if (row.mask) {
          demand(row.mask === `masks/${String(index).padStart(6, "0")}.png`, "人物蒙版与帧号不一致");
          const mask = archive.find((entry) => entry.name === row.mask);
          demand(mask && mask.width === 512 && mask.height === 512 && mask.foregroundRatio > 0.005 && mask.foregroundRatio < 0.95, "真实人物蒙版缺失或无效"); masks++;
        }
      });
      demand(poses >= 8 && masks >= 8 && evidence.poseFrames === poses && evidence.maskFrames === masks, "人物检测或图层结果不足，不能以全空轨迹通过");
    }
    return { verifiedModel: { id: challenge.model.id, ...SCOPES[id] }, contractTests: { exact_native_scope: true, exact_request: true, complete_response: true, output_sha256: true, full_input: true } };
  }
  return Object.fromEntries(Object.keys(MODEL_IDS).map((id) => [id, { versions: NATIVE_PROBE_VERSIONS[id], supports, createProbe, validateResult,
    requiresProbeInputs: id !== "minimax_music_3.generate", isVerifiedModel: (_inventory, model, tests) => tests?.exact_native_scope === true && nativeVerifiedModelScope(id, model) !== null }]));
}
