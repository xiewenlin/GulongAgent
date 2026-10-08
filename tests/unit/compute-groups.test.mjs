import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { computeGroupsMatch, computeGroupFilter, registerComputeGroupRoutes } from "../../server/compute-groups.js";

const A = `gug_${"a".repeat(32)}`, B = `gug_${"b".repeat(32)}`;
const valueAt = (item, key) => key.split(".").reduce((value, part) => value?.[part], item);
function matches(item, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((entry) => matches(item, entry));
    const actual = valueAt(item, key);
    if (expected == null) return actual == null;
    if (expected instanceof ObjectId) return String(actual) === String(expected);
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if (expected.$in) return expected.$in.includes(actual);
      if (expected.$gt != null) return actual > expected.$gt;
      if (expected.$regex != null) return new RegExp(expected.$regex, expected.$options).test(actual || "");
    }
    return actual === expected;
  });
}
function fixture() {
  const user = { _id: new ObjectId(), status: "active", role: "user", computeGroupId: A };
  const owner = { _id: new ObjectId(), status: "active", role: "user" };
  const admin = { _id: new ObjectId(), status: "active", role: "admin" };
  const binding = { _id: new ObjectId(), userId: owner._id, nodeId: "compute-node-0001", tokenHash: "binding-hash", status: "active", revokedAt: null, computeGroupId: A };
  const data = {
    users: [user, owner, admin], computeGroups: [{ id: A, name: "影视一组" }, { id: B, name: "影视二组" }],
    subscriptions: [{ ownerId: user._id, products: { gulong_engine_monthly: { enabled: true, status: "active" } } }],
    nodeAccountBindings: [binding], h3SharedTasks: [], capabilityOrders: [], codexMarketTasks: [], computeAccessPermits: [], computeGroupAudits: [],
  };
  const getCollection = async (name) => {
    const rows = data[name]; assert.ok(rows, `unexpected collection ${name}`);
    return {
      findOne: async (filter) => rows.find((item) => matches(item, filter)) || null,
      find: (filter) => {
        let count = Infinity, sort = null;
        const cursor = { limit: (limit) => { count = limit; return cursor; }, sort: (order) => { sort = order; return cursor; }, toArray: async () => {
          const result = rows.filter((item) => matches(item, filter));
          if (sort) result.sort((a, b) => String(a.id).localeCompare(String(b.id)));
          return result.slice(0, count);
        } }; return cursor;
      },
      insertOne: async (item) => {
        if (name === "computeGroups" && rows.some((row) => row.nameNormalized === item.nameNormalized)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        item._id ||= new ObjectId(); rows.push(item); return { insertedId: item._id };
      },
      updateOne: async (filter, update) => { const item = rows.find((row) => matches(row, filter)); if (item) Object.assign(item, update.$set); return { matchedCount: item ? 1 : 0 }; },
      updateMany: async (filter, update) => { const selected = rows.filter((row) => matches(row, filter)); selected.forEach((row) => Object.assign(row, update.$set)); return { modifiedCount: selected.length }; },
      findOneAndUpdate: async (filter, update) => { const item = rows.find((row) => matches(row, filter)); if (!item) return null; Object.assign(item, update.$set); return item; },
    };
  };
  let isAdmin = true, membershipActive = true;
  const app = new OpenAPIHono();
  registerComputeGroupRoutes(app, { getCollection, enforceRateLimit: async () => ({ allowed: true }), requireTrustedMutation: () => null,
    requireAdmin: async (c) => isAdmin ? { user: { id: admin._id.toString(), role: "admin" } } : { error: c.json({ code: "FORBIDDEN" }, 403) },
    authenticate: async () => ({ user: { id: user._id.toString(), role: user.role } }),
    readGulongEngineEntitlement: async () => ({ active: membershipActive }),
    hashOpaqueToken: (token, purpose) => purpose === "h3-account-binding" ? token === `gab_${"x".repeat(43)}` ? "binding-hash" : "invalid-hash" : token,
  });
  const request = (path, body, method = "POST", authenticatedNode = false) => app.request(`http://localhost${path}`, { method, headers: {
    "Content-Type": "application/json", ...(authenticatedNode ? { "X-Gulong-Account-Binding": `gab_${"x".repeat(43)}` } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, request, data, user, owner, binding, setAdmin: (value) => { isAdmin = value; }, setMembership: (value) => { membershipActive = value; } };
}

test("group equality never grants grouped users access to ungrouped or other groups", () => {
  assert.equal(computeGroupsMatch(A, A), true);
  assert.equal(computeGroupsMatch(A, B), false);
  assert.equal(computeGroupsMatch(A, null), false);
  assert.equal(computeGroupsMatch(null, B), false);
  assert.equal(computeGroupsMatch(null, undefined), true);
  assert.deepEqual(computeGroupFilter(null), { computeGroupId: null });
});
test("only admin creates unique immutable group IDs and normalized duplicate names are refused", async () => {
  const f = fixture(); f.setAdmin(false);
  assert.equal((await f.request("/api/admin/compute-groups", { name: "一组" })).status, 403);
  f.setAdmin(true);
  const result = await f.request("/api/admin/compute-groups", { name: "新一组" });
  assert.equal(result.status, 201);
  const first = (await result.json()).group;
  const second = (await (await f.request("/api/admin/compute-groups", { name: "新二组" })).json()).group;
  assert.match(first.id, /^gug_[a-f0-9]{32}$/); assert.notEqual(first.id, second.id);
  assert.equal((await f.request("/api/admin/compute-groups", { name: " 新一组 " })).status, 409);
  assert.equal(f.data.computeGroupAudits.length, 2);
});
test("group name fuzzy search is literal, paginated and available only to bound nodes", async () => {
  const f = fixture();
  assert.equal((await f.request("/api/desktop/compute-groups", undefined, "GET")).status, 401);
  const response = await f.request("/api/desktop/compute-groups?q=影视&limit=1", undefined, "GET", true);
  const payload = await response.json(); assert.equal(payload.groups.length, 1); assert.equal(payload.nextCursor, A);
  assert.equal((await (await f.request(`/api/desktop/compute-groups?q=影视&cursor=${A}`, undefined, "GET", true)).json()).groups[0].id, B);
  assert.equal((await (await f.request("/api/desktop/compute-groups?q=.*", undefined, "GET", true)).json()).groups.length, 0);
  assert.equal(JSON.stringify(payload).includes("userId"), false);
});
test("assignment requires an existing group and Gulong product; clearing still works after cancellation", async () => {
  const f = fixture(), path = `/api/admin/users/${f.user._id}/compute-group`;
  assert.equal((await f.request(path, { groupId: `gug_${"c".repeat(32)}` }, "PUT")).status, 404);
  const result = await f.request(path, { groupId: B }, "PUT"); assert.equal(result.status, 200); assert.equal(f.user.computeGroupId, B);
  f.data.subscriptions[0].products.gulong_engine_monthly.enabled = false;
  assert.equal((await f.request(path, { groupId: A }, "PUT")).status, 403);
  assert.equal((await f.request(path, { groupId: null }, "PUT")).status, 200); assert.equal(f.user.computeGroupId, null);
});
test("queued orders follow group changes but running orders block destructive reassignment", async () => {
  const f = fixture(), path = `/api/admin/users/${f.user._id}/compute-group`;
  const queued = { requesterUserId: f.user._id, status: "queued", computeGroupId: A }; f.data.capabilityOrders.push(queued);
  assert.equal((await f.request(path, { groupId: B }, "PUT")).status, 200); assert.equal(queued.computeGroupId, B);
  queued.status = "processing";
  const blocked = await f.request(path, { groupId: A }, "PUT"); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "USER_GROUP_BUSY");
  assert.equal(f.user.computeGroupId, B);
});
test("bound node can set only its own group and cannot change group while processing", async () => {
  const f = fixture(), path = "/api/desktop/nodes/compute-group";
  assert.equal((await f.request(path, { node_id: "other-node-00001", group_id: B }, "PUT", true)).status, 403);
  const result = await f.request(path, { node_id: f.binding.nodeId, group_id: B }, "PUT", true);
  assert.equal(result.status, 200); assert.equal((await result.json()).group_id, B);
  f.data.h3SharedTasks.push({ claimedByNode: { bindingId: f.binding._id }, status: "claimed" });
  assert.equal((await f.request(path, { node_id: f.binding.nodeId, group_id: null }, "PUT", true)).status, 409);
  assert.equal(f.binding.computeGroupId, B);
});
test("local/LAN permit creation forbids spoofed or other-group nodes and expired membership", async () => {
  const f = fixture(); f.binding.computeGroupId = B;
  assert.equal((await f.request("/api/v1/compute-access/authorize", { node_id: f.binding.nodeId, group_id: B })).status, 403);
  assert.equal(f.data.computeAccessPermits.length, 0);
  f.binding.computeGroupId = A; f.setMembership(false);
  assert.equal((await f.request("/api/v1/compute-access/authorize", { node_id: f.binding.nodeId })).status, 403);
});
test("permit verification rechecks current groups and consumes exactly once under concurrency", async () => {
  const f = fixture();
  const issue = await f.request("/api/v1/compute-access/authorize", { node_id: f.binding.nodeId });
  assert.equal(issue.status, 200); const { permit } = await issue.json();
  f.user.computeGroupId = B;
  assert.equal((await f.request("/api/desktop/compute-access/verify", { node_id: f.binding.nodeId, permit }, "POST", true)).status, 403);
  f.user.computeGroupId = A;
  const results = await Promise.all([1, 2].map(() => f.request("/api/desktop/compute-access/verify", { node_id: f.binding.nodeId, permit }, "POST", true)));
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 403]);
  assert.equal(f.data.computeGroupAudits.filter((item) => item.action === "local_access_allowed").length, 1);
  assert.equal(f.data.computeAccessPermits[0].status, "used");
});
test("permits cannot cross nodes, survive expiry or be forged", async () => {
  const f = fixture();
  const { permit } = await (await f.request("/api/v1/compute-access/authorize", { node_id: f.binding.nodeId })).json();
  assert.equal((await f.request("/api/desktop/compute-access/verify", { node_id: f.binding.nodeId, permit: `gcp_${"z".repeat(43)}` }, "POST", true)).status, 403);
  assert.equal((await f.request("/api/desktop/compute-access/verify", { node_id: "other-node-00001", permit }, "POST", true)).status, 403);
  f.data.computeAccessPermits[0].expiresAt = new Date(0);
  assert.equal((await f.request("/api/desktop/compute-access/verify", { node_id: f.binding.nodeId, permit }, "POST", true)).status, 403);
});
