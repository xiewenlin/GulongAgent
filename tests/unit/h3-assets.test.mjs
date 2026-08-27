import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  H3_ASSET_ACCEPT,
  calculateH3ClientPriceFen,
  clampH3AssetSelection,
  h3AssetManifest,
  h3AssetReferences,
  h3ReferenceQuery,
  removeH3AssetAndRemapReferences,
  replaceH3ReferenceQuery,
  uploadH3AssetFile,
  validateH3AssetSelection,
} from "../../src/h3-assets.js";

function asset(name, type, size = 16, content = "gulong-h3") {
  return { name, type, size, arrayBuffer: async () => new TextEncoder().encode(content).buffer };
}

test("web H3 accepts and numbers 9 images, 3 videos and 3 audios for @ references", () => {
  const files = [
    ...Array.from({ length: 9 }, (_, index) => asset(`picture-${index + 1}.png`, "image/png")),
    ...Array.from({ length: 3 }, (_, index) => asset(`video-${index + 1}.mp4`, "video/mp4")),
    ...Array.from({ length: 3 }, (_, index) => asset(`audio-${index + 1}.mp3`, "audio/mpeg")),
  ];
  assert.deepEqual(validateH3AssetSelection(files), { image: 9, video: 3, audio: 3 });
  assert.deepEqual(h3AssetReferences(files).map((item) => item.reference), [
    "@图片1", "@图片2", "@图片3", "@图片4", "@图片5", "@图片6", "@图片7", "@图片8", "@图片9",
    "@视频1", "@视频2", "@视频3", "@音频1", "@音频2", "@音频3",
  ]);
  assert.equal(calculateH3ClientPriceFen(5, files), 205);
  assert.throws(() => validateH3AssetSelection([...files, asset("picture-10.png", "image/png")]), /图片最多上传 9 张/);
  assert.match(H3_ASSET_ACCEPT, /video\/mp4/);
  assert.match(H3_ASSET_ACCEPT, /audio\/mpeg/);
});

test("web H3 clamps oversized selections while preserving nine images and three files of other kinds", () => {
  const selected = [
    ...Array.from({ length: 11 }, (_, index) => asset(`picture-${index + 1}.png`, "image/png")),
    ...Array.from({ length: 4 }, (_, index) => asset(`video-${index + 1}.mp4`, "video/mp4")),
    ...Array.from({ length: 3 }, (_, index) => asset(`audio-${index + 1}.mp3`, "audio/mpeg")),
  ];
  const result = clampH3AssetSelection(selected);
  assert.deepEqual(result.counts, { image: 9, video: 3, audio: 3 });
  assert.deepEqual(result.skipped, { image: 2, video: 1, audio: 0, unsupported: 0 });
  assert.deepEqual(result.files.map((file) => file.name), [
    "picture-1.png", "picture-2.png", "picture-3.png", "picture-4.png", "picture-5.png", "picture-6.png", "picture-7.png", "picture-8.png", "picture-9.png",
    "video-1.mp4", "video-2.mp4", "video-3.mp4",
    "audio-1.mp3", "audio-2.mp3", "audio-3.mp3",
  ]);
});

test("web H3 keeps @ numbering stable in mixed upload order", () => {
  const references = h3AssetReferences([
    asset("opening.mp4", "video/mp4"),
    asset("hero.png", "image/png"),
    asset("music.wav", "audio/wav"),
    asset("ending.webm", "video/webm"),
    asset("scene.webp", "image/webp"),
  ]);
  assert.deepEqual(references.map((item) => item.reference), ["@视频1", "@图片1", "@音频1", "@视频2", "@图片2"]);
});

test("manual @ input finds and replaces the active H3 reference query", () => {
  assert.deepEqual(h3ReferenceQuery("让角色参考 @", 7), { start: 6, end: 7, query: "" });
  assert.deepEqual(h3ReferenceQuery("让角色参考 @图", 8), { start: 6, end: 8, query: "图" });
  assert.deepEqual(replaceH3ReferenceQuery("让角色参考 @图继续走", { start: 6, end: 8 }, "@图片1"), {
    value: "让角色参考 @图片1 继续走",
    caret: 11,
  });
  assert.equal(h3ReferenceQuery("普通文本", 4), null);
});

test("removing a referenced H3 asset safely renumbers later @ references", () => {
  const files = [asset("one.png", "image/png"), asset("two.png", "image/png"), asset("clip.mp4", "video/mp4")];
  const result = removeH3AssetAndRemapReferences(files, 0, "让 @图片1 离场，保留 @图片2 并参考 @视频1；外部 @图片9 不改");
  assert.deepEqual(result.files.map((file) => file.name), ["two.png", "clip.mp4"]);
  assert.equal(result.prompt, "让 离场，保留 @图片1 并参考 @视频1；外部 @图片9 不改");
});

test("web H3 asset upload uses SHA-256 COS metadata contract and completes the asset", async () => {
  const file = asset("hero.png", "image/png", 16, "gulong-h3-image");
  const apiCalls = [];
  const putCalls = [];
  const apiFetch = async (path, options) => {
    apiCalls.push({ path, options, body: JSON.parse(options.body) });
    if (path === "/api/h3/assets/presign") {
      return {
        asset_id: "asset-1",
        upload_url: "https://cos.example/upload",
        method: "PUT",
        headers: { "content-type": "image/png", "x-cos-meta-sha256": "SIGNED" },
      };
    }
    return { asset: { asset_id: "asset-1", object_key: "h3/requesters/user/assets/asset-1/hero.png", filename: file.name, bytes: file.size, sha256: "VERIFIED" } };
  };
  const fetchImpl = async (url, options) => {
    putCalls.push({ url, options });
    return { ok: true, status: 200 };
  };

  const completed = await uploadH3AssetFile(file, { apiFetch, fetchImpl });
  assert.equal(apiCalls[0].path, "/api/h3/assets/presign");
  assert.deepEqual({ kind: apiCalls[0].body.kind, filename: apiCalls[0].body.filename, content_type: apiCalls[0].body.content_type, bytes: apiCalls[0].body.bytes }, { kind: "image", filename: "hero.png", content_type: "image/png", bytes: 16 });
  assert.match(apiCalls[0].body.sha256, /^[A-F0-9]{64}$/);
  assert.equal(putCalls[0].url, "https://cos.example/upload");
  assert.equal(putCalls[0].options.method, "PUT");
  assert.deepEqual(putCalls[0].options.headers, { "content-type": "image/png", "x-cos-meta-sha256": "SIGNED" });
  assert.equal(putCalls[0].options.body, file);
  assert.equal(apiCalls[1].path, "/api/h3/assets/asset-1/complete");
  assert.deepEqual(completed, { kind: "image", assetId: "asset-1", objectKey: "h3/requesters/user/assets/asset-1/hero.png", filename: "hero.png", bytes: 16, sha256: "VERIFIED" });
  assert.deepEqual(h3AssetManifest([completed]), { images: [{ asset_id: "asset-1", object_key: completed.objectKey }], videos: [], audio: [] });
});

test("web H3 composer exposes multi-asset upload and inserts @ references into the prompt", async () => {
  const source = await readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /支持图片 9 张、视频 3 个、音频 3 个/);
  assert.match(source, /输入 @ 可选择图片、视频或音频素材/);
  assert.match(source, /H3ReferencePicker/);
  assert.match(source, /预览编辑/);
  assert.match(source, /AttachmentThumbnail/);
  assert.match(source, /insertH3Reference\(h3References\[index\]\.reference\)/);
  assert.doesNotMatch(source, /agent-h3-reference-bar|@ 引用素材/);
  assert.match(source, /agent-attachment-row \$\{isH3Video \? "h3-grid"/);
  assert.match(styles, /\.agent-attachment-row\.h3-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(230px, 1fr\)\);/s);
  assert.match(styles, /\.agent-chat-shell\s*\{[^}]*min-height:\s*calc\(100vh - 172px\);/s);
  assert.match(styles, /\.agent-chat-stream\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.match(source, /uploadH3AssetFiles\(attachments/);
  assert.match(source, /assets: h3AssetManifest\(uploadedAssets\)/);
  assert.doesNotMatch(source, /当前网页入口先支持纯提示词|完整素材请从桌面 Agent 提交|桌面素材/);
});
