import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import {
  PEAR_API_BASE_URL,
  PEAR_API_FREE_MODELS,
  PEAR_API_MARKUP_RATE,
  PEAR_API_TOKEN_CHANNELS,
  WALLET_RECHARGE_BONUS_THRESHOLD_FEN,
  callPearApiChat,
  checkPearApiFreeModels,
  creditPaymentBalanceWithPromotion,
  paymentPromotionBonusFen,
  pearApiMarkedUpFen,
  pearApiOutputRange,
  registerPearApiRoutes,
  reservePearMediaWallet,
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

test("PearAPI admin supports every published token channel", () => {
  assert.deepEqual([...PEAR_API_TOKEN_CHANNELS], ["默认", "优质", "免费", "按次", "特价", "限时免费"]);
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

test("membership and qualifying top-ups receive a ten-percent idempotent wallet bonus", async () => {
  assert.equal(WALLET_RECHARGE_BONUS_THRESHOLD_FEN, 50_000);
  assert.equal(paymentPromotionBonusFen({ amountFen: 19_900, kind: "subscription_payment" }), 1_990);
  assert.equal(paymentPromotionBonusFen({ amountFen: 49_999, kind: "recharge" }), 0);
  assert.equal(paymentPromotionBonusFen({ amountFen: 50_000, kind: "recharge" }), 5_000);
  const ownerId = new ObjectId();
  let wallet = null;
  const creditLedgers = new Map();
  const wallets = {
    findOne: async ({ ownerId: requested }) => wallet && requested.toString() === ownerId.toString() ? wallet : null,
    insertOne: async (record) => { wallet = { ...record }; return { insertedId: record._id || new ObjectId() }; },
    updateOne: async (filter, update) => {
      if (!wallet || filter._id?.toString() !== wallet._id?.toString() || wallet.credits.some((item) => item.key === filter["credits.key"].$ne)) return { modifiedCount: 0 };
      wallet.balanceFen += update.$inc.balanceFen;
      wallet.credits.push(update.$push.credits);
      return { modifiedCount: 1 };
    },
  };
  const ledgers = {
    updateOne: async (filter, update) => {
      const current = creditLedgers.get(filter.creditKey);
      const next = current || { ...update.$setOnInsert };
      Object.assign(next, update.$set || {});
      creditLedgers.set(filter.creditKey, next);
      return { upsertedCount: current ? 0 : 1, modifiedCount: 1 };
    },
    findOne: async (filter) => creditLedgers.get(filter.creditKey) || null,
  };
  const input = { ownerId, amountFen: 10_000, source: "offline_subscription", sourceId: "ORDER-ONE", kind: "subscription_payment", collectionProvider: async (name) => name === "wallets" ? wallets : ledgers };
  await creditPaymentBalanceWithPromotion(input);
  await creditPaymentBalanceWithPromotion(input);
  assert.equal(wallet.balanceFen, 11_000);
  assert.deepEqual(wallet.credits.map((item) => [item.kind, item.amountFen]), [["subscription_payment", 10_000], ["subscription_bonus", 1_000]]);
  assert.deepEqual([...creditLedgers.values()].map((item) => item.status), ["settled", "settled"]);
});

test("paid PearAPI media reserves wallet balance once and records an auditable ledger", async () => {
  const state = { balanceFen: 1_000, ledgerKeys: [], ledgerEntries: [] };
  const wallets = {
    findOneAndUpdate: async (filter, update) => {
      if (state.balanceFen < filter.balanceFen.$gte || state.ledgerKeys.includes(filter.ledgerKeys.$ne)) return null;
      state.balanceFen += update.$inc.balanceFen;
      state.ledgerKeys.push(...update.$push.ledgerKeys.$each);
      state.ledgerEntries.push(...update.$push.ledgerEntries.$each);
      return { ...state };
    },
    findOne: async (filter) => state.ledgerKeys.includes(filter.ledgerKeys) ? { ...state } : null,
  };
  const input = { wallets, ownerId: "user-1", amountFen: 260, ledgerKey: "pear-media:job-1", requestId: "request-1", mediaJobId: "job-1" };
  const first = await reservePearMediaWallet(input);
  const duplicate = await reservePearMediaWallet(input);
  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(state.balanceFen, 740);
  assert.equal(state.ledgerKeys.length, 1);
  assert.equal(state.ledgerEntries[0].amountFen, -260);
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

test("GPT-OSS retries the public lowercase alias when the canonical model ID is rejected", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.model === "GPT-OSS-120B") return new Response(JSON.stringify({ error: { message: "unsupported model" } }), { status: 400 });
    return Response.json({ id: "ok", model: body.model, choices: [{ message: { content: "正常" } }] });
  };
  const result = await callPearApiChat({ token: "valid-test-token", model: "GPT-OSS-120B", messages: [{ role: "user", content: "hello" }], fetchImpl, timeoutMs: 1_000 });
  assert.deepEqual(calls.map((body) => body.model), ["GPT-OSS-120B", "gpt-oss-120b"]);
  assert.deepEqual(Object.keys(calls[0]).sort(), ["messages", "model", "stream"]);
  assert.equal(result.resolvedModel, "gpt-oss-120b");
  assert.equal(result.fallback, false);
});

test("a transient free-model outage falls back to the known healthy free model", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.model);
    if (body.model === "spark-lite") return Response.json({ message: "当前服务暂不可用，请稍后重试" }, { status: 503 });
    return Response.json({ id: "fallback", model: body.model, choices: [{ message: { content: "已自动恢复" } }] });
  };
  const result = await callPearApiChat({ token: "valid-test-token", model: "spark-lite", messages: [{ role: "user", content: "hello" }], fetchImpl, timeoutMs: 1_000 });
  assert.deepEqual(calls, ["spark-lite", "glm-4-flash-250414"]);
  assert.equal(result.text, "已自动恢复");
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "PEAR_API_UPSTREAM_ERROR");
});

test("the administrator health check probes all seven free models independently", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.model);
    return Response.json({ id: body.model, model: body.model, choices: [{ message: { content: "正常" } }] });
  };
  const health = await checkPearApiFreeModels({ token: "valid-test-token", fetchImpl, timeoutMs: 1_000 });
  assert.equal(health.total, 7);
  assert.equal(health.healthy, 7);
  assert.equal(health.allAvailable, true);
  assert.deepEqual(new Set(calls), new Set(PEAR_API_FREE_MODELS.map((model) => model.id)));
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
  assert.ok(document.paths["/api/agent/workflows/{operationId}"]?.get);
  assert.ok(document.paths["/api/agent/bootstrap"]?.get);
  assert.ok(document.paths["/api/agent/media"]?.post);
  assert.ok(document.paths["/api/agent/media/{id}"]?.get);
  assert.ok(document.paths["/api/admin/pearapi/config"]?.put);
  assert.ok(document.paths["/api/admin/pearapi/test"]?.post);
  assert.match(JSON.stringify(document.paths["/api/agent/media"].post), /referenceAssets/);
});

test("website reference images bypass the old inline size gate through trusted COS assets", async () => {
  const [agentSource, pearSource] = await Promise.all([
    readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../server/pearapi.js", import.meta.url), "utf8"),
  ]);
  assert.match(agentSource, /referenceAssets/);
  assert.match(agentSource, /uploadH3AssetFiles\(attachments[^\n]+validateSelection: false/);
  assert.doesNotMatch(agentSource, /MAX_MEDIA_REFERENCE_BYTES|单张参考图不能超过 600 KB|imageDataUrl/);
  assert.match(pearSource, /ReferenceAssetSchema/);
  assert.match(pearSource, /getCollection\("h3AssetUploads"\)/);
  assert.match(pearSource, /createPresignedDownloadUrl/);
  assert.match(pearSource, /record\.objectKey !== asset\.object_key/);
});

test("website exposes the simplified agent while user settings no longer expose MiniMax", async () => {
  const [appSource, agentSource, adminSource, accountSource, stylesSource] = await Promise.all([
    readFile(new URL("../../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AdminPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
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
  assert.match(agentSource, /creationType === "text" && !bootstrap\?\.subscription\?\.active/);
  assert.doesNotMatch(agentSource, /已包含 30% 平台服务费/);
  assert.doesNotMatch(agentSource, /结算加收 30% 服务费/);
  assert.doesNotMatch(agentSource, /深度思考/);
  assert.match(agentSource, /<option value="image">图片<\/option>/);
  assert.match(agentSource, /<option value="video">视频<\/option>/);
  assert.doesNotMatch(agentSource, /<option value="shared">/);
  assert.match(agentSource, /name: "MiniMaxH3共享节点"/);
  assert.match(agentSource, /nextType === "video" \? H3_SHARED_MODEL\.id/);
  assert.match(agentSource, /\[H3_SHARED_MODEL, \.\.\.\(bootstrap\?\.mediaModels\?\.video/);
  assert.match(agentSource, /Idempotency-Key/);
  assert.match(agentSource, /已从余额预扣/);
  assert.match(agentSource, /\/api\/agent\/media/);
  assert.match(agentSource, /import ReactMarkdown from "react-markdown"/);
  assert.match(agentSource, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(agentSource, /<MarkdownMessage>\{item\.content\}<\/MarkdownMessage>/);
  assert.match(agentSource, /<WorkflowTrace workflow=\{item\.workflow\}/);
  assert.match(stylesSource, /\.agent-workflow-track \{[^}]*display: grid/);
  assert.match(stylesSource, /\.agent-workflow-node > b \{[^}]*position: absolute[^}]*bottom: 0[^}]*width: 1px/);
  assert.match(agentSource, /safeMarkdownHref/);
  assert.doesNotMatch(agentSource, /rehypeRaw/);
  assert.match(adminSource, /\{ id: "tokens", label: "令牌配置", icon: LockKey \}/);
  assert.match(adminSource, /\["默认", "优质", "免费", "按次", "特价", "限时免费"\]/);
  assert.doesNotMatch(accountSource, /id: "minimax"/);
  assert.doesNotMatch(accountSource, /MiniMax 配置/);
});

test("monthly subscription payments credit the wallet once and PearAPI routes are registered", async () => {
  const [serverSource, dbSource, pearSource, pricingSource, accountSource, vercel] = await Promise.all([
    readFile(new URL("../../server/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/db.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/pearapi.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/PlatformPages.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/AccountDashboard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /registerPearApiRoutes\(app, \{ authenticate, requireAdmin, requireTrustedMutation \}\)/);
  assert.match(serverSource, /source: "online_subscription"/);
  assert.match(serverSource, /source: "offline_subscription"/);
  assert.match(serverSource, /creditPaymentBalanceWithPromotion/);
  assert.match(dbSource, /uniq_wallet_owner/);
  assert.match(dbSource, /uniq_wallet_credit_ledger/);
  assert.match(dbSource, /agent_media_polling/);
  assert.match(dbSource, /uniq_agent_workflow_operation/);
  assert.match(dbSource, /ttl_agent_workflows/);
  assert.match(pearSource, /"credits\.key": \{ \$ne: key \}/);
  assert.match(pearSource, /subscription_bonus/);
  assert.match(pearSource, /recharge_bonus/);
  assert.match(pricingSource, /订阅即送 10% 创作余额/);
  assert.match(pricingSource, /满 500 元赠送 10%/);
  assert.match(accountSource, /单次充值满 500 元额外赠送 10% 余额/);
  assert.match(pearSource, /limit: 30, windowMs: 5 \* 60_000/);
  assert.match(pearSource, /const unlimited = auth\.user\.role === "admin"/);
  assert.doesNotMatch(pearSource, /图片和视频创作需要生效中的会员订阅/);
  assert.match(pearSource, /reservePearMediaWallet/);
  assert.match(pearSource, /pear_media_reservation/);
  assert.match(pearSource, /IDEMPOTENCY_KEY_REQUIRED/);
  assert.match(pearSource, /findOneAndUpdate\(\s*\{ _id: job\._id, status: "reserving" \}/);
  assert.match(dbSource, /uniq_agent_media_idempotency/);
  assert.match(pearSource, /configured: Boolean\(credentialSecrets\(credential\)\.token\)/);
  assert.match(pearSource, /callPearApiChat\(\{ token/);
  assert.match(pearSource, /WORKFLOW_ID_CONFLICT/);
  assert.match(pearSource, /Markdown 成品排版/);
  assert.match(pearSource, /tokenChannel: record\?\.tokenChannel \|\| "免费"/);
  assert.doesNotMatch(pearSource, /pear-chat:[\s\S]{0,1800}INSUFFICIENT_BALANCE/);
  assert.match(vercel, /"source": "\/api\/agent\/:path\*"/);
  assert.match(vercel, /"source": "\/api\/admin\/pearapi\/:path\*"/);
});
