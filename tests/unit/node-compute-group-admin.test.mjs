import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { readFile } from "node:fs/promises";
import { registerComputeGroupRoutes } from "../../server/compute-groups.js";
import { createCapabilityMemoryCollection } from "../helpers/capability-memory.mjs";

const A = `gug_${"a".repeat(32)}`, B = `gug_${"b".repeat(32)}`;
function fixture() {
  const tables = new Map(), f = { role: "admin", trusted: true, allowed: true };
  f.table = (name) => { if (!tables.has(name)) tables.set(name, createCapabilityMemoryCollection()); return tables.get(name); };
  f.binding = { _id: new ObjectId(), userId: new ObjectId(), nodeId: "node-test-00001", status: "active", revokedAt: null, computeGroupId: A, tokenHash: "never-expose-this" };
  f.table("nodeAccountBindings").rows.push(f.binding);
  f.table("computeGroups").rows.push({ id: A, name: "设计一组", createdAt: new Date() }, { id: B, name: "创作二组", createdAt: new Date() });
  const app = new OpenAPIHono();
  let tail = Promise.resolve();
  registerComputeGroupRoutes(app, {
    getCollection: async (name) => f.table(name), enforceRateLimit: async () => ({ allowed: f.allowed }),
    requireAdmin: async (c) => f.role ? { user: { id: "a".repeat(24), role: f.role } } : { error: c.json({ code: "LOGIN_REQUIRED" }, 401) },
    requireTrustedMutation: (c) => f.trusted ? null : c.json({ code: "ORIGIN_REJECTED" }, 403),
    transaction: (operation) => {
      const pending = tail.then(async () => {
        // Use detached documents and preserve ObjectIds in rollback snapshots.
        const backups = new Map();
        for (const [name, table] of tables) backups.set(name, await table.find({}).toArray());
        try { return await operation({ fixture: true }); }
        catch (error) { for (const [name, table] of tables) table.rows.splice(0, table.rows.length, ...(backups.get(name) || [])); throw error; }
      });
      tail = pending.catch(() => {}); return pending;
    },
  });
  f.path = `/api/admin/nodes/${f.binding._id}/compute-group`;
  f.call = async (method = "GET", body, path = f.path) => {
    const response = await app.request(`https://example.test${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  f.app = app; return f;
}
const assign = { group_id: B, expected_group_id: A };

test("admin node groups reject anonymous, non-admin, cross-origin and rate-limited mutations", async () => {
  const f = fixture(); f.role = null;
  assert.equal((await f.call()).status, 401);
  f.role = "user";
  assert.equal((await f.call()).status, 403); assert.equal((await f.call("PUT", assign)).status, 403);
  f.role = "admin"; f.trusted = false;
  assert.equal((await f.call("PUT", assign)).status, 403);
  f.trusted = true; f.allowed = false;
  assert.equal((await f.call("PUT", assign)).status, 429);
  assert.equal(f.table("computeGroupAudits").rows.length, 0);
});

test("admin reads authoritative node group without exposing tokens and may assign/clear only that binding", async () => {
  const f = fixture(), second = { ...f.binding, _id: new ObjectId() }; f.table("nodeAccountBindings").rows.push(second);
  const before = await f.call();
  assert.equal(before.body.binding_id, String(f.binding._id)); assert.equal(before.body.group.name, "设计一组");
  assert.equal(before.headers.get("cache-control"), "private, no-store");
  assert.doesNotMatch(JSON.stringify(before.body), /never-expose|tokenHash|userId/);
  const saved = await f.call("PUT", assign);
  assert.equal(saved.status, 200); assert.equal(saved.body.group_id, B); assert.equal(saved.body.policy, "same_group_only");
  assert.equal(f.table("nodeAccountBindings").rows[1].computeGroupId, A);
  assert.equal(f.table("computeGroupAudits").rows[0].action, "admin_node_assigned");
  assert.equal((await f.call("PUT", { group_id: null, expected_group_id: B })).status, 200);
  assert.equal((await f.call()).body.group_id, null);
  assert.equal(f.table("capabilityAutoVerifications").rows.length, 0, "assignment never manufactures admission");
});

test("concurrent/stale admin edits cannot overwrite a different group and reject unknown fields/groups", async () => {
  const f = fixture();
  assert.deepEqual((await Promise.all([f.call("PUT", assign), f.call("PUT", assign)])).map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.table("computeGroupAudits").rows.length, 1);
  assert.equal((await f.call("PUT", { ...assign, expected_group_id: B, group_id: `gug_${"c".repeat(32)}` })).status, 404);
  for (const body of [{ group_id: B }, { ...assign, role: "admin" }, { ...assign, group_id: "invalid" }]) assert.equal((await f.call("PUT", body)).status, 400);
});

test("running H3, capability jobs and physical verification leases block changing group", async () => {
  for (const kind of ["h3", "capability", "verification", "unknown-slots"]) {
    const f = fixture();
    if (kind === "h3") f.table("h3SharedTasks").rows.push({ claimedByNode: { bindingId: f.binding._id }, status: "claimed" });
    if (kind === "capability") f.table("capabilityOrders").rows.push({ assignedNode: { bindingId: f.binding._id }, status: "processing" });
    if (kind === "verification") f.table("capabilityNodeSlots").rows.push({ _id: String(f.binding._id), version: 1, leases: [{ expiresAt: new Date(Date.now() + 60000), exclusive: true }] });
    if (kind === "unknown-slots") f.table("capabilityNodeSlots").rows.push({ _id: String(f.binding._id), version: 1, leases: null });
    const result = await f.call("PUT", assign);
    assert.equal(result.status, 409, kind); assert.equal(result.body.code, "NODE_GROUP_BUSY");
    assert.equal(f.table("nodeAccountBindings").rows[0].computeGroupId, A);
    assert.equal(f.table("computeGroupAudits").rows.length, 0);
  }
});

test("expired leases do not block idle changes; no-op saves create neither audit nor reservation", async () => {
  const f = fixture();
  assert.equal((await f.call("PUT", { group_id: A, expected_group_id: A })).status, 200);
  assert.equal(f.table("capabilityNodeSlots").rows.length, 0);
  assert.equal(f.table("computeGroupAudits").rows.length, 0);
  f.table("capabilityNodeSlots").rows.push({ _id: String(f.binding._id), version: 7, leases: [{ expiresAt: new Date(0) }] });
  assert.equal((await f.call("PUT", assign)).status, 200);
  assert.equal(f.table("capabilityNodeSlots").rows[0].version, 8);
});

test("revoked/missing nodes reject admin edits, audit failure rolls back group and slot fence", async () => {
  const f = fixture(); f.table("computeGroupAudits").insertOne = async () => { throw new Error("private database failure"); };
  const result = await f.call("PUT", assign);
  assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.body), /private database/);
  assert.equal((await f.call()).body.group_id, A); assert.equal(f.table("capabilityNodeSlots").rows.length, 0);
  f.table("nodeAccountBindings").rows[0].status = "revoked";
  assert.equal((await f.call("PUT", assign)).status, 404);
  assert.equal((await f.call("GET", null, "/api/admin/nodes/not-an-id/compute-group")).status, 404);
});

test("group list searches literally and exposes all result pages, no private member data", async () => {
  const f = fixture();
  const page = await f.call("GET", null, "/api/admin/compute-groups?limit=1");
  assert.equal(page.body.nextCursor, A);
  assert.equal((await f.call("GET", null, `/api/admin/compute-groups?cursor=${A}&limit=1`)).body.groups[0].id, B);
  assert.equal((await f.call("GET", null, "/api/admin/compute-groups?q=%E5%88%9B%E4%BD%9C")).body.groups[0].id, B);
  assert.equal((await f.call("GET", null, "/api/admin/compute-groups?q=.*")).body.groups.length, 0);
});

test("node group editor requires fresh state, confirmation, pagination and saves only through admin API", async () => {
  const source = await readFile(new URL("../../src/components/NodeComputeGroupSettings.jsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/admin\/nodes\/.*compute-group/); assert.match(source, /\/api\/admin\/compute-groups/);
  assert.match(source, /expected_group_id: current.group_id/); assert.match(source, /await confirm\(/);
  assert.match(source, /加载更多分组/); assert.match(source, /显示全部/); assert.match(source, /controller.signal.aborted/);
  assert.doesNotMatch(source, /\/api\/desktop|window.confirm|Authorization:|localStorage|method: "POST"/);
});

test("Vercel forwards deep admin node group routes to the platform instead of returning hosting 404", async () => {
  const configuration = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));
  const rule = configuration.rewrites.find((entry) => entry.source === "/api/admin/nodes/:id/compute-group");
  assert.equal(rule?.destination, "/api/platform?_platform_path=admin/nodes/:id/compute-group");
  const fixturePath = rule.destination.replace(":id", "1".repeat(24));
  assert.equal(new URL(fixturePath, "https://example.test").searchParams.get("_platform_path"), `admin/nodes/${"1".repeat(24)}/compute-group`);
});
