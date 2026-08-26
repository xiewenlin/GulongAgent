export const H3_ASSET_LIMITS = Object.freeze({ image: 9, video: 3, audio: 3 });
export const H3_MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
export const H3_ASSET_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/ogg,audio/webm";

const MIME_KINDS = Object.freeze({
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
});

const EXTENSION_TYPES = Object.freeze({
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  png: ["image", "image/png"],
  webp: ["image", "image/webp"],
  gif: ["image", "image/gif"],
  mp4: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  mp3: ["audio", "audio/mpeg"],
  m4a: ["audio", "audio/mp4"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  oga: ["audio", "audio/ogg"],
});

export function h3AssetDescriptor(file) {
  const declaredType = String(file?.type || "").trim().toLowerCase();
  if (MIME_KINDS[declaredType]) return { kind: MIME_KINDS[declaredType], contentType: declaredType };
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase() || "";
  const fallback = EXTENSION_TYPES[extension];
  return fallback ? { kind: fallback[0], contentType: fallback[1] } : null;
}

export function h3AssetCounts(files = []) {
  return files.reduce((counts, file) => {
    const descriptor = h3AssetDescriptor(file);
    if (descriptor) counts[descriptor.kind] += 1;
    return counts;
  }, { image: 0, video: 0, audio: 0 });
}

export function h3AssetReferences(files = []) {
  const counters = { image: 0, video: 0, audio: 0 };
  const labels = { image: "图片", video: "视频", audio: "音频" };
  return files.map((file, index) => {
    const descriptor = h3AssetDescriptor(file);
    if (!descriptor) return { index, file, kind: null, reference: null };
    counters[descriptor.kind] += 1;
    return { index, file, kind: descriptor.kind, reference: `@${labels[descriptor.kind]}${counters[descriptor.kind]}` };
  });
}

export function h3ReferenceQuery(value = "", caret = String(value || "").length) {
  const text = String(value || "");
  const safeCaret = Math.max(0, Math.min(Number.isInteger(caret) ? caret : text.length, text.length));
  const match = text.slice(0, safeCaret).match(/@[\p{Script=Han}\d]*$/u);
  if (!match) return null;
  return { start: safeCaret - match[0].length, end: safeCaret, query: match[0].slice(1) };
}

export function replaceH3ReferenceQuery(value = "", range, reference) {
  const text = String(value || "");
  const start = Math.max(0, Math.min(Number(range?.start) || 0, text.length));
  const end = Math.max(start, Math.min(Number(range?.end) || start, text.length));
  const normalizedReference = String(reference || "").trim();
  const after = text.slice(end);
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const next = `${text.slice(0, start)}${normalizedReference}${suffix}${after}`;
  return { value: next, caret: start + normalizedReference.length + suffix.length };
}

export function removeH3AssetAndRemapReferences(files = [], index, prompt = "") {
  const oldReferences = h3AssetReferences(files);
  const nextFiles = files.filter((_, itemIndex) => itemIndex !== index);
  const nextReferences = h3AssetReferences(nextFiles);
  const replacementByOldReference = new Map();
  for (const item of oldReferences) {
    if (item.index === index) replacementByOldReference.set(item.reference, "");
    else {
      const nextIndex = item.index > index ? item.index - 1 : item.index;
      replacementByOldReference.set(item.reference, nextReferences[nextIndex]?.reference || "");
    }
  }
  const nextPrompt = String(prompt || "")
    .replace(/@(?:图片|视频|音频)\d+/g, (reference) => replacementByOldReference.has(reference) ? replacementByOldReference.get(reference) : reference)
    .replace(/[ \t]{2,}/g, " ");
  return { files: nextFiles, prompt: nextPrompt };
}

export function validateH3AssetSelection(files = []) {
  for (const file of files) {
    const descriptor = h3AssetDescriptor(file);
    if (!descriptor) throw new Error(`不支持素材 ${file?.name || "未命名文件"}；请选择图片、视频或音频文件`);
    const bytes = Number(file?.size || 0);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > H3_MAX_ASSET_BYTES) throw new Error(`${file?.name || "素材"} 大小必须在 1 字节到 2 GB 之间`);
  }
  const counts = h3AssetCounts(files);
  if (counts.image > H3_ASSET_LIMITS.image) throw new Error(`图片最多上传 ${H3_ASSET_LIMITS.image} 张`);
  if (counts.video > H3_ASSET_LIMITS.video) throw new Error(`视频最多上传 ${H3_ASSET_LIMITS.video} 个`);
  if (counts.audio > H3_ASSET_LIMITS.audio) throw new Error(`音频最多上传 ${H3_ASSET_LIMITS.audio} 个`);
  return counts;
}

export function clampH3AssetSelection(files = []) {
  const counts = { image: 0, video: 0, audio: 0 };
  const accepted = [];
  const skipped = { image: 0, video: 0, audio: 0, unsupported: 0 };
  for (const file of files) {
    const descriptor = h3AssetDescriptor(file);
    if (!descriptor) {
      skipped.unsupported += 1;
      continue;
    }
    if (counts[descriptor.kind] >= H3_ASSET_LIMITS[descriptor.kind]) {
      skipped[descriptor.kind] += 1;
      continue;
    }
    counts[descriptor.kind] += 1;
    accepted.push(file);
  }
  return { files: accepted, counts, skipped };
}

export function calculateH3ClientPriceFen(durationSeconds, files = []) {
  const counts = validateH3AssetSelection(files);
  return Math.max(1, Number(durationSeconds || 0)) * 20 + counts.image * 5 + counts.video * 20;
}

export async function sha256Hex(file) {
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持素材安全校验，请升级浏览器后重试");
  let content;
  try { content = await file.arrayBuffer(); }
  catch { throw new Error(`无法读取素材 ${file?.name || "未命名文件"}`); }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function uploadH3AssetFile(file, { apiFetch, fetchImpl = globalThis.fetch, onProgress } = {}) {
  const descriptor = h3AssetDescriptor(file);
  if (!descriptor) throw new Error(`不支持素材 ${file?.name || "未命名文件"}`);
  onProgress?.({ phase: "hashing", name: file.name });
  const sha256 = await sha256Hex(file);
  const ticket = await apiFetch("/api/h3/assets/presign", {
    method: "POST",
    body: JSON.stringify({ kind: descriptor.kind, filename: file.name, content_type: descriptor.contentType, bytes: file.size, sha256 }),
  });
  onProgress?.({ phase: "uploading", name: file.name });
  let uploaded;
  try { uploaded = await fetchImpl(ticket.upload_url, { method: ticket.method || "PUT", headers: ticket.headers || {}, body: file }); }
  catch { throw new Error(`素材 ${file.name} 上传到腾讯云失败，请检查网络后重试`); }
  if (!uploaded?.ok) throw new Error(`素材 ${file.name} 上传失败（HTTP ${uploaded?.status || "未知"}）`);
  onProgress?.({ phase: "verifying", name: file.name });
  const completed = await apiFetch(`/api/h3/assets/${encodeURIComponent(ticket.asset_id)}/complete`, { method: "POST", body: JSON.stringify({}) });
  return {
    kind: descriptor.kind,
    assetId: completed.asset.asset_id,
    objectKey: completed.asset.object_key,
    filename: completed.asset.filename || file.name,
    bytes: completed.asset.bytes || file.size,
    sha256: completed.asset.sha256 || sha256,
  };
}

export async function uploadH3AssetFiles(files = [], options = {}) {
  if (options.validateSelection === false) {
    for (const file of files) {
      const descriptor = h3AssetDescriptor(file);
      if (!descriptor) throw new Error(`不支持素材 ${file?.name || "未命名文件"}`);
      const bytes = Number(file?.size || 0);
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > H3_MAX_ASSET_BYTES) throw new Error(`${file?.name || "素材"} 大小必须在 1 字节到 2 GB 之间`);
    }
  } else {
    validateH3AssetSelection(files);
  }
  if (!files.length) return [];
  const results = new Array(files.length);
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await uploadH3AssetFile(files[index], {
        ...options,
        onProgress: (progress) => options.onProgress?.({ ...progress, index, total: files.length, completed }),
      });
      completed += 1;
      options.onProgress?.({ phase: "completed", name: files[index].name, index, total: files.length, completed });
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, files.length) }, () => worker()));
  return results;
}

export function h3AssetManifest(assets = []) {
  const pick = (kind) => assets.filter((asset) => asset.kind === kind).map((asset) => ({ asset_id: asset.assetId, object_key: asset.objectKey }));
  return { images: pick("image"), videos: pick("video"), audio: pick("audio") };
}
