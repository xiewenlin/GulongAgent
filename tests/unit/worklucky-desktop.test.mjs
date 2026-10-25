import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { workLuckyEntitlement, workLuckyConfig, workLuckyUpdates, capabilityProducts, withClientProductFingerprint, clientProductConflicts } from "../../server/worklucky-product.js";
import { registerWorkLuckyDesktopRoutes } from "../../server/worklucky-desktop.js";
import { createWorkLuckyReleaseService } from "../../server/worklucky-releases.js";
import { createGulongEngineDesktopAuth, GULONG_ENGINE_DESKTOP_ROOT } from "../../server/desktop-gulong-auth.js";
import { createGulongEngineSessionStore } from "../../server/desktop-english-sessions.js";
const entitlement = { product: "gulong_engine", plan_id: "gulong_engine_monthly", active: true, status: "active", starts_at: "2026-10-01", expires_at: "2026-11-01", monthly_price_fen: 99900 };
const root = "/api/v1/desktop/worklucky";

function routeFixture(options = {}) {
  const rows = new Map();
  const users = [{ _id: "worklucky-owner-1", status: "active", email: "first@example.test", displayName: "第一位用户" }, { _id: "worklucky-owner-2", status: "active", email: "second@example.test", displayName: "第二位用户" }];
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (value && typeof value === "object" && "$gt" in value) return +row[key] > +value.$gt;
    return Array.isArray(row[key]) ? row[key].includes(value) : row[key] === value;
  });
  const collection = {
    createIndex: async () => "memory-only", insertOne: async (doc) => { rows.set(doc._id, structuredClone(doc)); },
    findOne: async (query) => structuredClone([...rows.values()].find((row) => matches(row, query)) || null),
    updateOne: async (query, update) => {
      const row = [...rows.values()].find((candidate) => matches(candidate, query));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, structuredClone(update.$set || {}));
      for (const [key, value] of Object.entries(update.$push || {})) row[key].push(value);
      return { modifiedCount: 1 };
    },
  };
  const sessions = createGulongEngineSessionStore({ getCollection: async (name) => name === "users" ? { findOne: async (query) => structuredClone(users.find((user) => matches(user, query)) || null) } : collection });
  const readEntitlement = options.readEntitlement || (async () => entitlement);
  const createAuth = (dependencies = {}) => createGulongEngineDesktopAuth({ sessions, readEntitlement,
    rateLimit: options.rateLimit || (async () => ({ allowed: true })),
    verifyPassword: async (identifier, password) => {
      const user = users.find((candidate) => candidate.email === identifier);
      if (!user || password !== "memory-test-password") throw Object.assign(new Error("upstream-private-token"), { status: 401 });
      return user;
    }, ...dependencies });
  const app = new OpenAPIHono();
  createAuth().register(app);
  registerWorkLuckyDesktopRoutes(app, { createAuth, readEntitlement, monthlyPriceFen: 99900 });
  app.doc("/api/openapi.json", { openapi: "3.1.0", info: { title: "Memory route test", version: "1" } });
  const post = (path, body, token) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const account = (path, token) => app.request(`${path}/account`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { app, users, sessions, post, account };
}

test("WorkLucky inherits the exact active monthly entitlement and price", () => {
  const result = workLuckyEntitlement(entitlement);
  assert.equal(result.product, "worklucky"); assert.equal(result.active, true);
  assert.equal(result.monthly_price_fen, entitlement.monthly_price_fen); assert.equal(result.expires_at, entitlement.expires_at);
  assert.ok(result.capabilities.includes("worklucky.use"));
  for (const invalid of [null, { ...entitlement, active: false }, { ...entitlement, status: "expired" }, { ...entitlement, product: "english_coach" }, { ...entitlement, plan_id: "member" }]) {
    const view = workLuckyEntitlement(invalid); assert.equal(view.active, false); assert.deepEqual(view.capabilities, []);
  }
});
test("public config has no second purchase and unpublished executable cannot update", () => {
  const config = workLuckyConfig(12345); assert.equal(config.subscription.monthly_price_fen, 12345); assert.equal(config.subscription.separate_purchase, false);
  assert.equal(config.capability_orders.video, "adapter_required"); assert.throws(() => workLuckyConfig(0));
  assert.equal(config.schema_version, "worklucky-product-v1"); assert.equal(config.product_id, "worklucky");
  assert.equal(config.updates.endpoint, "https://www.sologle.com/api/v1/desktop/worklucky/updates");
  assert.equal(config.updates.signature_algorithm, "worklucky-ed25519-sha256-v1");
  assert.deepEqual(workLuckyUpdates(), { product_id: "worklucky", product: "worklucky", status: "no_update", release: null, reason: "release_not_published" });
});
test("catalog binding cannot authorize an unrelated paid capability", () => {
  for (const id of ["gulong_engine.text", "gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music"]) assert.ok(capabilityProducts(id).includes("worklucky"));
  for (const id of ["minimax_h3.video_generation", "pearapi.image", "english_coach.text", "worklucky.fake"]) assert.deepEqual(capabilityProducts(id), []);
});
test("public config and updates routes are uncached and cannot advertise fake consumers", async () => {
  const { app } = routeFixture();
  const configResponse = await app.request(`${root}/config`);
  assert.equal(configResponse.status, 200); assert.match(configResponse.headers.get("Cache-Control"), /no-store/);
  const config = await configResponse.json();
  assert.equal(config.capability_orders.availability_source, "authenticated_catalog");
  assert.equal(config.capability_orders.execution_requires, "verified_consumer_contract");
  assert.equal(config.capability_orders.paid_fallback, false);
  assert.equal(config.capability_orders.video, "adapter_required");
  for (const id of ["gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music"]) assert.ok(config.capability_orders.capability_ids.includes(id));
  assert.equal("dispatchable" in config.capability_orders, false);
  assert.equal("verified_node_count" in config.capability_orders, false);
  const updates = await app.request(`${root}/updates?platform=windows&arch=x64`);
  assert.equal(updates.status, 200); assert.match(updates.headers.get("Cache-Control"), /no-store/);
  assert.deepEqual(await updates.json(), createWorkLuckyReleaseService().updates());
});

test("fixed WorkLucky routes reject invalid or duplicate product selectors", async () => {
  const { app } = routeFixture();
  for (const route of ["config", "updates", "account"]) {
    for (const query of ["product=english_coach", "product=", "product=worklucky&product=worklucky"]) {
      const response = await app.request(`${root}/${route}?${query}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "WORKLUCKY_PRODUCT_INVALID");
      assert.match(response.headers.get("Cache-Control"), /no-store/);
    }
  }
  assert.equal((await app.request(`${root}/config?product=worklucky`)).status, 200);
});

test("real WorkLucky login/account routes retain shared GGE auth and account isolation", async () => {
  const f = routeFixture({ readEntitlement: async (id) => ({ ...entitlement, active: id === "worklucky-owner-1", status: id === "worklucky-owner-1" ? "active" : "expired" }) });
  assert.equal((await f.account(root)).status, 401);
  assert.equal((await f.account(root, "unrelated-chandler-token")).status, 401);
  assert.equal((await f.account(root, "gge_at_invalid")).status, 401);
  const login = await f.post(`${root}/auth/login`, { identifier: f.users[0].email, password: "memory-test-password" });
  assert.equal(login.status, 200); assert.match(login.headers.get("Cache-Control"), /no-store/);
  const tokens = await login.json(); assert.match(tokens.access_token, /^gge_at_/); assert.match(tokens.refresh_token, /^gge_rt_/);
  const first = await f.account(root, tokens.access_token); const view = await first.json();
  assert.equal(first.status, 200); assert.equal(view.user.id, f.users[0]._id); assert.equal(view.entitlement.product, "worklucky");
  assert.equal(view.entitlement.active, true); assert.equal(view.entitlement.monthly_price_fen, entitlement.monthly_price_fen);
  assert.ok(view.entitlement.capabilities.includes("worklucky.use"));
  const original = await f.account(GULONG_ENGINE_DESKTOP_ROOT, tokens.access_token);
  assert.equal(original.status, 200); assert.equal((await original.json()).entitlement.product, "gulong_engine");
  const secondTokens = await (await f.post(`${root}/auth/login`, { identifier: f.users[1].email, password: "memory-test-password" })).json();
  const secondView = await (await f.account(root, secondTokens.access_token)).json();
  assert.equal(secondView.user.id, f.users[1]._id); assert.equal(secondView.entitlement.active, false); assert.deepEqual(secondView.entitlement.capabilities, []);
  assert.equal(JSON.stringify(view).includes(tokens.access_token), false);
});

test("WorkLucky refresh/logout invalidate the same session across both aliases", async () => {
  const f = routeFixture();
  const tokens = await (await f.post(`${GULONG_ENGINE_DESKTOP_ROOT}/auth/login`, { identifier: f.users[0].email, password: "memory-test-password" })).json();
  const refresh = await f.post(`${root}/auth/refresh`, { refresh_token: tokens.refresh_token });
  assert.equal(refresh.status, 200);
  const rotated = await refresh.json(); assert.notEqual(rotated.access_token, tokens.access_token);
  assert.equal((await f.account(root, tokens.access_token)).status, 401);
  assert.equal((await f.account(GULONG_ENGINE_DESKTOP_ROOT, rotated.access_token)).status, 200);
  const logout = await f.post(`${root}/auth/logout`, { refresh_token: rotated.refresh_token }, rotated.access_token);
  assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { ok: true });
  assert.equal((await f.account(GULONG_ENGINE_DESKTOP_ROOT, rotated.access_token)).status, 401);
  assert.equal((await f.post(`${root}/auth/refresh`, { refresh_token: rotated.refresh_token })).status, 401);
});

test("WorkLucky auth routes keep sanitization, request validation and throttling", async () => {
  const f = routeFixture();
  const denied = await f.post(`${root}/auth/login`, { identifier: f.users[0].email, password: "wrong-password" });
  assert.equal(denied.status, 401); assert.equal((await denied.text()).includes("upstream-private-token"), false);
  assert.equal((await f.post(`${root}/auth/login`, { identifier: f.users[0].email, password: "x".repeat(20000) })).status, 400);
  const throttled = routeFixture({ rateLimit: async () => ({ allowed: false }) });
  assert.equal((await throttled.post(`${root}/auth/login`, { identifier: f.users[0].email, password: "memory-test-password" })).status, 429);
  assert.equal((await throttled.account(root)).status, 429);
});

test("live OpenAPI registry contains all six WorkLucky operations and exact capability IDs", async () => {
  const { app } = routeFixture();
  const response = await app.request("/api/openapi.json"); assert.equal(response.status, 200);
  const spec = await response.json();
  for (const [suffix, method] of [["config", "get"], ["updates", "get"], ["account", "get"], ["auth/login", "post"], ["auth/refresh", "post"], ["auth/logout", "post"]]) {
    const operation = spec.paths[`${root}/${suffix}`]?.[method];
    assert.ok(operation?.responses?.["200"]); assert.match(operation.description, /shared session/);
  }
  const ids = spec.paths[`${root}/config`].get.responses["200"].content["application/json"].schema.properties.capability_orders.properties.capability_ids.items.enum;
  assert.deepEqual(ids, workLuckyConfig(99900).capability_orders.capability_ids);
  assert.equal(spec.components.securitySchemes.workLuckyDesktopBearer.bearerFormat, "gge_at_ opaque access token");
});

test("client product is part of idempotency and cannot reuse a legacy or tombstoned order", () => {
  const request = { capabilityId: "gulong_engine.text", parameters: { prompt: "test" }, assets: [], preferredNodeId: null };
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(digest(withClientProductFingerprint(request, undefined)), digest(request));
  assert.notEqual(digest(withClientProductFingerprint(request, "worklucky")), digest(request));
  assert.equal(clientProductConflicts({}, undefined), false);
  assert.equal(clientProductConflicts({ clientProduct: "worklucky" }, "worklucky"), false);
  assert.equal(clientProductConflicts({}, "worklucky"), true);
  assert.equal(clientProductConflicts({ clientProduct: "worklucky" }, undefined), true);
  assert.equal(clientProductConflicts({ cancellationTombstone: true }, "worklucky"), true);
  assert.equal(clientProductConflicts({ cancellationTombstone: true, clientProduct: "worklucky" }, undefined), true);
});

test("standalone OpenAPI describes auth and gated release routes with the shared-session boundary", () => {
  // JSON is a strict subset of YAML 1.2, so this spec needs no test dependency.
  const spec = JSON.parse(readFileSync(new URL("../../docs/openapi-worklucky.yaml", import.meta.url), "utf8"));
  assert.equal(spec.openapi, "3.0.3"); assert.equal(Object.keys(spec.paths).length, 7);
  assert.ok(spec.paths[`${root}/releases/{version}/{filename}`].get.responses["404"]);
  assert.equal(spec.components.schemas.PublishedUpdate.properties.status.enum[0], "update_available");
  for (const [suffix, method] of [["config", "get"], ["updates", "get"], ["account", "get"], ["auth/login", "post"], ["auth/refresh", "post"], ["auth/logout", "post"]]) {
    const operation = spec.paths[`/api/v1/desktop/worklucky/${suffix}`]?.[method];
    assert.ok(operation?.operationId); assert.ok(operation?.responses?.["200"]);
  }
  assert.match(spec.info.description, /shared.*session/i);
  assert.equal(spec.components.schemas.ProductConfig.properties.schema_version.enum[0], workLuckyConfig(99900).schema_version);
  assert.equal(spec.components.schemas.NoUpdate.properties.reason.enum[0], workLuckyUpdates().reason);
});
