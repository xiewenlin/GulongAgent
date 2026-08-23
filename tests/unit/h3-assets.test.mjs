import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  H3_ASSET_ACCEPT,
  calculateH3ClientPriceFen,
  h3AssetManifest,
  h3AssetReferences,
  removeH3AssetAndRemapReferences,
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
  assert.match(source, /图片最多 9 张、视频最多 3 个、音频最多 3 个/);
  assert.match(source, /@图片1、@视频1、@音频1/);
  assert.match(source, /insertH3Reference\(item\.reference\)/);
  assert.match(source, /uploadH3AssetFiles\(attachments/);
  assert.match(source, /assets: h3AssetManifest\(uploadedAssets\)/);
  assert.doesNotMatch(source, /当前网页入口先支持纯提示词|完整素材请从桌面 Agent 提交|桌面素材/);
});
