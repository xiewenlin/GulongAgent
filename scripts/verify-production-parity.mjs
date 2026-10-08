#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const [vercelBase = "https://sologle.com", tencentBase = "https://111.229.70.235"] = process.argv.slice(2);
const expectedCommit = /^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA || "")
  ? process.env.GITHUB_SHA.toLowerCase()
  : null;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(base, pathname, cacheKey) {
  const url = new URL(pathname, `${base.replace(/\/$/, "")}/`);
  url.searchParams.set("deployment", cacheKey || Date.now().toString());
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        redirect: "follow",
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        const error = new Error(`返回 HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3 || error.retryable === false) {
        throw new Error(`${url.origin}${url.pathname} 下载校验失败（第 ${attempt} 次）：${error.message}`, { cause: error });
      }
      console.warn(`${url.origin}${url.pathname} 下载暂时失败，正在重试 ${attempt}/3：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

async function fetchManifest(base) {
  const bytes = await fetchBytes(base, "/deployment-manifest.json", expectedCommit);
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.version, 1, `${base} 的部署清单版本不受支持`);
  assert.ok(manifest.files && typeof manifest.files === "object", `${base} 的部署清单缺少文件哈希`);
  if (expectedCommit) assert.equal(manifest.commit, expectedCommit, `${base} 尚未运行目标提交 ${expectedCommit}`);
  return manifest;
}

const [vercelManifest, tencentManifest] = await Promise.all([
  fetchManifest(vercelBase),
  fetchManifest(tencentBase),
]);
assert.deepEqual(tencentManifest, vercelManifest, "Vercel 与腾讯云部署清单不一致");

const entries = Object.entries(vercelManifest.files);
assert.ok(entries.length > 0, "部署清单不能为空");
for (const [relative, expected] of entries) {
  assert.match(relative, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/, `部署清单包含不安全路径：${relative}`);
  const pathname = `/${relative}`;
  console.log(`Verifying ${relative} (${expected.bytes} bytes)`);
  const [vercelBytes, tencentBytes] = await Promise.all([
    fetchBytes(vercelBase, pathname, vercelManifest.commit),
    fetchBytes(tencentBase, pathname, tencentManifest.commit),
  ]);
  assert.equal(vercelBytes.length, expected.bytes, `Vercel 文件大小不符：${relative}`);
  assert.equal(tencentBytes.length, expected.bytes, `腾讯云文件大小不符：${relative}`);
  assert.equal(sha256(vercelBytes), expected.sha256, `Vercel 文件哈希不符：${relative}`);
  assert.equal(sha256(tencentBytes), expected.sha256, `腾讯云文件哈希不符：${relative}`);
}

console.log(JSON.stringify({
  ok: true,
  commit: vercelManifest.commit,
  filesVerified: entries.length,
  targets: [vercelBase, tencentBase],
}));
