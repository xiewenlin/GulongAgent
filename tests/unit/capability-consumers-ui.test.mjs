import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = await readFile(new URL("../../src/components/CapabilityConsumersPanel.jsx", import.meta.url), "utf8");
const admin = await readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8");
const prelude = source.slice(source.indexOf("export function consumerBindingSearchParams"), source.indexOf("function displayTime"));
const search = new Function(prelude.replace("export function", "function") + "\nreturn consumerBindingSearchParams;")();
test("administrator model-status page replaces manual acceptance creation", () => {
  assert.match(admin, /id: "capability-consumers", label: "共享模型状态"/);
  assert.match(source, /自动排队验收/); assert.match(source, /\/api\/admin\/capability-verifications/);
  assert.doesNotMatch(source, /method:\s*["']POST|type=["']file|submitRegistration|parseAcceptanceDraft|确认核对并登记/);
});
test("node IDs use exact search and names use bounded fuzzy search", () => {
  const node = "8".repeat(64);
  assert.equal(search(" " + node + " ").get("node_id"), node);
  assert.equal(search(" 节点一 ").get("q"), "节点一");
  assert.equal(search(" ").size, 0);
  assert.match(source, /maxLength=\{100\}/);
});
test("query failures cannot look like no matching nodes", () => {
  assert.match(source, /setSearchFailed\(true\)/); assert.match(source, /节点查询失败/);
  assert.match(source, /目前无法判断是否存在匹配节点/);
  assert.match(source, /setSelectedBinding\(null\)/);
});
test("stale responses and unmounts cannot restore administrator data", () => {
  assert.match(source, /sequence !== bindingRequest.current/);
  assert.match(source, /sequence !== recordRequest.current/);
  assert.match(source, /error.status === 401 \|\| error.status === 403/);
  assert.match(source, /bindingRequest.current \+= 1; recordRequest.current \+= 1/);
});
test("automatic status polling is bounded, visibility-aware and read-only", () => {
  assert.match(source, /!document.hidden/); assert.match(source, /15000/);
  assert.match(source, /clearInterval\(timer\)/);
  assert.doesNotMatch(source, /window.alert|window.confirm|localStorage|lease_token|Authorization:/);
  assert.match(source, /未安装、未开启共享或缺少执行适配/);
});
