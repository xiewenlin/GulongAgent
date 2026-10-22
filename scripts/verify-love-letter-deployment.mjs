import assert from "node:assert/strict";

const bases = process.argv.slice(2);
if (!bases.length) throw new Error("请指定官网与腾讯云地址");
for (const base of bases) {
  const request = (path, options = {}) => fetch(new URL(path, base), {
    ...options, redirect: "follow", signal: AbortSignal.timeout(30000), cache: "no-store",
  });
  // Never publish a real letter merely to check a deployment.
  const page = await request("/love-letter/deployment-check");
  assert.equal(page.status, 200, `${base} 信件阅读页面不可用`);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("cache-control") || "", /no-store/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("x-robots-tag") || "", /noindex/);
  const docs = await (await request("/api/openapi.json")).json();
  for (const path of ["/api/love-letters/session", "/api/love-letters", "/api/love-letters/{id}"]) {
    assert.ok(docs.paths[path], `${base} 缺少接口合同 ${path}`);
  }
  const invalid = await request("/api/love-letters/deployment-check");
  assert.equal(invalid.status, 404, "无效信件标识必须返回 404");
  assert.equal(invalid.headers.get("referrer-policy"), "no-referrer");
  assert.match(invalid.headers.get("cache-control") || "", /no-store/);
  const crossOrigin = await request("/api/love-letters", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" }, body: "{}",
  });
  assert.equal(crossOrigin.status, 403, "跨站创建情书必须被拒绝");
  console.log(JSON.stringify({ origin: base, page: page.status, invalidLetter: invalid.status, crossOrigin: crossOrigin.status, openapi: docs.info.version, productionLettersCreated: 0 }));
}
