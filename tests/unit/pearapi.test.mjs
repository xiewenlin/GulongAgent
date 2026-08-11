import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  PEAR_API_BASE_URL,
  PEAR_API_FREE_MODELS,
  PEAR_API_MARKUP_RATE,
  callPearApiChat,
  pearApiMarkedUpFen,
  pearApiOutputRange,
  registerPearApiRoutes,
} from "../../server/pearapi.js";

test("PearAPI web agent only exposes the seven approved free models", () => {
  assert.equal(PEAR_API_BASE_URL, "https://api.pearapi.ai");
  assert.equal(PEAR_API_FREE_MODELS.length, 7);
  assert.deepEqual(PEAR_API_FREE_MODELS.map((model) => model.id), [
    "glm-4-flash-250414",
    "gpt-oss-120b",
    "hunyuan-mt-7b",
    "hy-mt2-1.8b",
    "mistral-7b-instruct-v0.2",
    "spark-lite",
    "step-3.5-flash",
  ]);
});

test("paid media estimates apply the required 30 percent markup", () => {
  assert.equal(PEAR_API_MARKUP_RATE, 0.3);
  assert.equal(pearApiMarkedUpFen(100), 130);
  assert.equal(pearApiMarkedUpFen(101), 132);
  assert.deepEqual(pearApiOutputRange(1_300, 100, 500), {
    minimum: 2,
    maximum: 10,
    cheapestUnitFen: 130,
    mostExpensiveUnitFen: 650,
  });
});

test("chat rejects models outside the free allowlist before any upstream request", async () => {
  await assert.rejects(
    callPearApiChat({ token: "valid-test-token", model: "unknown-paid-model", messages: [{ role: "user", content: "hello" }] }),
    (error) => error.code === "MODEL_NOT_ALLOWED" && error.status === 400,
  );
});

test("PearAPI routes publish the free-model and protected admin contracts in OpenAPI", async () => {
  const app = new OpenAPIHono();
  registerPearApiRoutes(app, {
    authenticate: async () => ({ error: new Response("unauthorized", { status: 401 }) }),
    requireAdmin: async () => ({ error: new Response("forbidden", { status: 403 }) }),
    requireTrustedMutation: () => null,
  });
  const response = await app.request("/api/agent/models");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).models.length, 7);
  const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
  assert.ok(document.paths["/api/agent/chat"]?.post);
  assert.ok(document.paths["/api/agent/bootstrap"]?.get);
  assert.ok(document.paths["/api/admin/pearapi/config"]?.put);
  assert.ok(document.paths["/api/admin/pearapi/test"]?.post);
});

test("website exposes the simplified agent while user settings no longer expose MiniMax", async () => {
  const [appSource, agentSource, adminSource, accountSource] = await Promise.all([
    readFile(new URL("../../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /pathname === "\/agent"/);
  assert.match(appSource, /<small>网页版入口<\/small>/);
  assert.match(agentSource, /拓展技能/);
  assert.match(agentSource, /我的资产/);
  assert.match(agentSource, /快速响应/);
  assert.match(agentSource, /深度思考/);
  assert.match(agentSource, /当前接入的是 PearAPI 免费文字模型/);
  assert.match(adminSource, /\{ id: "tokens", label: "令牌配置", icon: LockKey \}/);
  assert.doesNotMatch(accountSource, /id: "minimax"/);
  assert.doesNotMatch(accountSource, /MiniMax 配置/);
});
