import assert from "node:assert/strict";

const bases = process.argv.slice(2);
if (!bases.length) throw new Error("请指定官网与腾讯云地址");
for (const base of bases) {
  const request = async (path, options = {}) => fetch(new URL(path, base), { ...options, redirect: "follow", signal: AbortSignal.timeout(30000), cache: "no-store" });
  const page = await request("/birthday-wall");
  assert.equal(page.status, 200, `${base} 生日墙页面不可用`);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const docs = await (await request("/api/openapi.json")).json();
  for (const path of ["/api/birthday-walls", "/api/birthday-walls/mine", "/api/birthday-walls/{wallId}", "/api/birthday-walls/{wallId}/notes"]) {
    assert.ok(docs.paths[path], `${base} 缺少合同 ${path}`);
  }
  const mine = await request("/api/birthday-walls/mine");
  assert.equal(mine.status, 401, "个人墙列表必须要求登录");
  const create = await request("/api/birthday-walls", { method: "POST", headers: { "content-type": "application/json", origin: new URL(mine.url).origin }, body: "{}" });
  assert.equal(create.status, 401, "匿名请求不能创建个人生日墙");
  const workflows = await (await request("/api/workflows?q=%E7%94%9F%E6%97%A5%E5%A2%99")).json();
  assert.ok(workflows.workflows.some((item) => item.url === "/birthday-wall"), "工作流目录缺少生日墙入口");
  console.log(JSON.stringify({ origin: base, page: page.status, ownList: mine.status, anonymousCreate: create.status, workflow: true, openapi: docs.info.version, productionNotesCreated: 0, imageOrdersCreated: 0 }));
}
