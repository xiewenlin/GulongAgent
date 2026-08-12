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
import { PEAR_API_IMAGE_MODELS, PEAR_API_VIDEO_MODELS, publicPearMediaModel, resolvePearAutoModel } from "../../server/pearapi-models.js";

test("PearAPI web agent only exposes the seven approved free models", () => {
  assert.equal(PEAR_API_BASE_URL, "https://api.pearapi.ai");
  assert.equal(PEAR_API_FREE_MODELS.length, 7);
  assert.deepEqual(PEAR_API_FREE_MODELS.map((model) => model.id), [
    "glm-4-flash-250414",
    "GPT-OSS-120B",
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
  const image = publicPearMediaModel(PEAR_API_IMAGE_MODELS.find((model) => model.id === "boogu-image-0.1"));
  const video = publicPearMediaModel(PEAR_API_VIDEO_MODELS.find((model) => model.id === "doubao-seedance-2-0-fast-260128"));
  assert.equal(image.chargedFen, 13);
  assert.equal(image.priceLabel, "¥0.13");
  assert.equal(video.chargedFen, 60);
  assert.equal(video.priceLabel, "按时长 · 首档 ¥0.60");
});

test("desktop PearAPI media catalog and automatic routing are available on web", () => {
  assert.equal(PEAR_API_IMAGE_MODELS.length, 24);
  assert.equal(PEAR_API_VIDEO_MODELS.length, 12);
  assert.equal(resolvePearAutoModel("image", "生成一张 4K 电商海报").id, "gpt-image-2-4k");
  assert.equal(resolvePearAutoModel("video", "快速生成一条短片").id, "doubao-seedance-2-0-fast-260128");
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
  assert.ok(document.paths["/api/agent/media"]?.post);
  assert.ok(document.paths["/api/agent/media/{id}"]?.get);
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
  assert.match(appSource, /<small className="brand-web-entry">网页版入口<\/small>/);
  assert.match(agentSource, /返回官网/);
  assert.match(agentSource, /远程模型已连接/);
  assert.match(agentSource, /拓展技能/);
  assert.match(agentSource, /剩余用量/);
  assert.match(agentSource, /MEMBERSHIP REQUIRED/);
  assert.match(agentSource, /USAGE EXHAUSTED/);
  assert.match(agentSource, /creationType !== "text" && user\.role !== "admin"/);
  assert.doesNotMatch(agentSource, /已包含 30% 平台服务费/);
  assert.doesNotMatch(agentSource, /结算加收 30% 服务费/);
  assert.doesNotMatch(agentSource, /深度思考/);
  assert.match(agentSource, /<option value="image">图片<\/option>/);
  assert.match(agentSource, /<option value="video">视频<\/option>/);
  assert.match(agentSource, /\/api\/agent\/media/);
  assert.match(adminSource, /\{ id: "tokens", label: "令牌配置", icon: LockKey \}/);
  assert.doesNotMatch(accountSource, /id: "minimax"/);
  assert.doesNotMatch(accountSource, /MiniMax 配置/);
});

test("monthly subscription payments credit the wallet once and PearAPI routes are registered", async () => {
  const [serverSource, dbSource, pearSource, vercel] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/pearapi.js", import.meta.url), "utf8"),
    readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /registerPearApiRoutes\(app, \{ authenticate, requireAdmin, requireTrustedMutation \}\)/);
  assert.match(serverSource, /source: "online_subscription"/);
  assert.match(serverSource, /source: "offline_subscription"/);
  assert.match(dbSource, /uniq_wallet_owner/);
  assert.match(dbSource, /agent_media_polling/);
  assert.match(pearSource, /"credits\.key": \{ \$ne: key \}/);
  assert.match(pearSource, /limit: 30, windowMs: 5 \* 60_000/);
  assert.match(pearSource, /const unlimited = auth\.user\.role === "admin"/);
  assert.match(pearSource, /configured: Boolean\(credentialSecrets\(credential\)\.token\)/);
  assert.match(pearSource, /callPearApiChat\(\{ token/);
  assert.doesNotMatch(pearSource, /pear-chat:[\s\S]{0,1800}INSUFFICIENT_BALANCE/);
  assert.match(vercel, /"source": "\/api\/agent\/:path\*"/);
  assert.match(vercel, /"source": "\/api\/admin\/pearapi\/:path\*"/);
});
