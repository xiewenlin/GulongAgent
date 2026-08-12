const mediaModel = (modality, id, name, yuan, priceLabel, referenceImages, strengths, auto = false) => Object.freeze({
  id,
  name,
  modality,
  baseCostMilliFen: yuan == null ? null : Math.round(yuan * 100_000),
  priceLabel,
  referenceImages,
  strengths,
  auto,
});

export const PEAR_API_IMAGE_MODELS = Object.freeze([
  mediaModel("image", "auto-image", "图片全能模型", null, "智能匹配 · 按实际选用模型计费", 8, ["图片智能路由", "文生图", "参考图编辑"], true),
  mediaModel("image", "boogu-image-0.1", "Boogu Image 0.1", 0.10, "¥0.10", 1, ["通用作图", "单图参考"]),
  mediaModel("image", "doubao-seedream-4-0-250828", "豆包 Seedream 4.0", 0.14, "¥0.14", 10, ["中文理解", "多图参考", "商业视觉"]),
  mediaModel("image", "doubao-seedream-4-5-251128", "豆包 Seedream 4.5", 0.175, "¥0.175", 10, ["中文理解", "多图参考", "高质量作图"]),
  mediaModel("image", "doubao-seedream-5-0-260128", "豆包 Seedream 5.0", 0.154, "¥0.154", 10, ["中文创意", "多图一致性", "电商设计"]),
  mediaModel("image", "firered-image-edit1.1", "FireRed Image Edit 1.1", 0.10, "¥0.10", 3, ["图片编辑", "局部替换", "改色去物"]),
  mediaModel("image", "flux2-klein-9b", "FLUX.2 Klein 9B", 0.007, "¥0.007", 0, ["低成本", "快速草图", "通用作图"]),
  mediaModel("image", "glm-image", "GLM Image", 0.05, "¥0.05", 0, ["中文提示词", "低成本", "通用作图"]),
  mediaModel("image", "gpt-image-1.5", "GPT Image 1.5", 0.08, "¥0.08", 16, ["复杂指令", "多图参考", "文字排版"]),
  mediaModel("image", "gpt-image-2", "GPT Image 2", 0.06, "¥0.06", 16, ["复杂指令", "图片编辑", "通用高质量"]),
  mediaModel("image", "gpt-image-2-2k", "GPT Image 2 · 2K", 0.10, "¥0.10", 16, ["2K 高清", "多图参考", "广告设计"]),
  mediaModel("image", "gpt-image-2-4k", "GPT Image 2 · 4K", 0.14, "¥0.14", 16, ["4K 高清", "复杂排版", "商业成品"]),
  mediaModel("image", "grok-imagine-image", "Grok Imagine Image", 0.10, "¥0.10", 4, ["想象力", "风格创作", "参考图"]),
  mediaModel("image", "Image-Layered", "Image Layered", 0.30, "¥0.30", 1, ["分层图像", "后期编辑", "设计资产"]),
  mediaModel("image", "nano-banana", "Nano Banana", 0.09, "¥0.09", 6, ["图片编辑", "一致性", "多图融合"]),
  mediaModel("image", "nano-banana-2", "Nano Banana 2", 0.14, "¥0.14", 14, ["多图融合", "一致性", "复杂编辑"]),
  mediaModel("image", "nano-banana-2-4k", "Nano Banana 2 · 4K", 0.22, "¥0.22", 14, ["4K 高清", "多图融合", "复杂编辑"]),
  mediaModel("image", "nano-banana-2-lite", "Nano Banana 2 Lite", 0.08, "¥0.08", 14, ["性价比", "多图融合", "快速编辑"]),
  mediaModel("image", "nano-banana-pro", "Nano Banana Pro", 0.24, "¥0.24", 14, ["专业编辑", "高一致性", "商业视觉"]),
  mediaModel("image", "nano-banana-pro-4k", "Nano Banana Pro · 4K", 0.32, "¥0.32", 14, ["4K 专业编辑", "高一致性", "商业成品"]),
  mediaModel("image", "Real-ESRGAN", "Real-ESRGAN 超分", 0.015, "¥0.015", 1, ["图片超分", "老图增强", "低成本"]),
  mediaModel("image", "SeedVR2-Upscaler", "SeedVR2 Upscaler", 0.15, "¥0.15", 1, ["高质量超分", "细节恢复", "成品增强"]),
  mediaModel("image", "wan2.7-image", "Wan 2.7 Image", 0.20, "¥0.20", 9, ["中文创作", "多图参考", "风格化"]),
  mediaModel("image", "z-image", "Z-Image 云端版", 0.07, "¥0.07", 0, ["快速作图", "中文提示词", "性价比"]),
]);

export const PEAR_API_VIDEO_MODELS = Object.freeze([
  mediaModel("video", "auto-video", "视频全能模型", null, "智能匹配 · 按实际选用模型计费", 8, ["视频智能路由", "文生视频", "图生视频"], true),
  mediaModel("video", "doubao-seedance-2-0-260128", "豆包 Seedance 2.0", 0.62, "按时长 · 首档 ¥0.62", 10, ["多参考图", "运镜", "中文叙事"]),
  mediaModel("video", "doubao-seedance-2-0-fast-260128", "豆包 Seedance 2.0 Fast", 0.46, "按时长 · 首档 ¥0.46", 10, ["快速生成", "多参考图", "性价比"]),
  mediaModel("video", "doubao-seedance-2-0-mini-260615", "豆包 Seedance 2.0 Mini", 0.40, "按时长 · 首档 ¥0.40", 10, ["低成本", "多参考图", "快速短片"]),
  mediaModel("video", "gemini-omni", "Gemini Omni Video", 1.50, "¥1.50", 5, ["综合理解", "多模态", "复杂场景"]),
  mediaModel("video", "happyhorse-1.0", "HappyHorse 1.0", 0.56, "按时长 · 首档 ¥0.56", 10, ["多图参考", "创意视频", "人物表现"]),
  mediaModel("video", "ltx-digitalhuman", "LTX 数字人", 0.04, "按时长 · 首档 ¥0.04", 1, ["数字人", "口播", "超低成本"]),
  mediaModel("video", "seedance-1.0-pro", "Seedance 1.0 Pro", 1.52, "¥1.52", 12, ["多参考图", "专业视频", "镜头一致性"]),
  mediaModel("video", "seedance-1.5-pro", "Seedance 1.5 Pro", 1.93, "¥1.93", 9, ["高质量", "人物表演", "镜头一致性"]),
  mediaModel("video", "sora-2", "Sora 2", 0.17, "按时长 · 首档 ¥0.17", 1, ["电影感", "低成本", "文生视频"]),
  mediaModel("video", "veo-3.1", "Veo 3.1", 1.25, "¥1.25", 2, ["电影质量", "音画表现", "复杂运镜"]),
  mediaModel("video", "veo-3.1-fast", "Veo 3.1 Fast", 1.20, "¥1.20", 2, ["快速高质量", "音画表现", "通用视频"]),
]);

export const PEAR_API_MEDIA_MODELS = Object.freeze([...PEAR_API_IMAGE_MODELS, ...PEAR_API_VIDEO_MODELS]);
export const PEAR_API_MEDIA_MODEL_MAP = new Map(PEAR_API_MEDIA_MODELS.map((model) => [model.id, model]));
export const PEAR_IMAGE_SIZES = Object.freeze(["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"]);
export const PEAR_VIDEO_DURATIONS = Object.freeze([5, 6, 10, 15]);

const includesAny = (text, markers) => markers.some((marker) => text.includes(marker));

export function resolvePearAutoModel(modality, prompt = "") {
  const text = String(prompt).toLowerCase();
  if (modality === "video") {
    if (includesAny(text, ["数字人", "口播", "digital human"])) return PEAR_API_MEDIA_MODEL_MAP.get("ltx-digitalhuman");
    if (includesAny(text, ["电影", "音画", "对白", "音乐", "复杂运镜", "cinematic"])) return PEAR_API_MEDIA_MODEL_MAP.get("veo-3.1");
    if (includesAny(text, ["便宜", "低成本", "省钱"])) return PEAR_API_MEDIA_MODEL_MAP.get("ltx-digitalhuman");
    if (includesAny(text, ["快速", "加急", "fast"])) return PEAR_API_MEDIA_MODEL_MAP.get("doubao-seedance-2-0-fast-260128");
    return PEAR_API_MEDIA_MODEL_MAP.get("doubao-seedance-2-0-fast-260128");
  }
  if (includesAny(text, ["超分", "放大", "修复老图", "upscale"])) return PEAR_API_MEDIA_MODEL_MAP.get("SeedVR2-Upscaler");
  if (includesAny(text, ["分层", "图层", "layered"])) return PEAR_API_MEDIA_MODEL_MAP.get("Image-Layered");
  if (includesAny(text, ["编辑", "改色", "去除", "替换", "局部修改"])) return PEAR_API_MEDIA_MODEL_MAP.get("firered-image-edit1.1");
  if (includesAny(text, ["4k", "电商", "广告", "海报", "文字排版"])) return PEAR_API_MEDIA_MODEL_MAP.get("gpt-image-2-4k");
  if (includesAny(text, ["便宜", "低成本", "快速", "草图"])) return PEAR_API_MEDIA_MODEL_MAP.get("flux2-klein-9b");
  return PEAR_API_MEDIA_MODEL_MAP.get("gpt-image-2-4k");
}

export function publicPearMediaModel(model, markupRate = 0.3) {
  const chargedFen = model.baseCostMilliFen == null ? null : Math.ceil((model.baseCostMilliFen * (1 + markupRate)) / 1000);
  return { ...model, chargedFen };
}
