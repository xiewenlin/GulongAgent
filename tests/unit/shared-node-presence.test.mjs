import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { readFile } from "node:fs/promises";
import { NODE_PRESENCE_WINDOW_MS, projectSharedNodePresence, readSharedNodeHeartbeats } from "../../server/shared-node-presence.js";
import { nodePresenceSnapshot, nodePresenceView } from "../../src/shared-node-presence.js";

const NOW = new Date("2026-10-23T04:00:00Z");
const binding = { _id: new ObjectId(), nodeId: "node-one", status: "active", revokedAt: null };

test("presence reads two bounded batches with exact binding and node identity, never per-node queries", async () => {
  const calls = [], other = { ...binding, _id: new ObjectId(), nodeId: "node-two" };
  const rows = await readSharedNodeHeartbeats(async name => ({ aggregate(pipeline) {
    calls.push({ name, pipeline });
    return { async toArray() { return [{ _id: { bindingId: binding._id, nodeId: binding.nodeId }, lastSeenAt: NOW }]; } };
  } }), [binding, other], NOW);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(row => row.name), ["capabilityNodeReports", "capabilityAutoVerifications"]);
  for (const { pipeline } of calls) {
    assert.equal(pipeline[0].$match.$or.length, 2);
    assert.equal(pipeline[0].$match.$or[0].nodeId, binding.nodeId);
    assert.equal(pipeline.at(-1).$limit, 2);
    assert.deepEqual(pipeline[1].$group.lastSeenAt, { $max: "$reportedAt" });
  }
  assert.ok(calls[0].pipeline[0].$match.$or[0].bindingId instanceof ObjectId);
  assert.equal(calls[1].pipeline[0].$match.$or[0].bindingId, String(binding._id));
  assert.equal(rows[0].bindingId, String(binding._id));
  assert.equal(projectSharedNodePresence(binding, rows, NOW).online_status, "online");
});

test("empty node list does not access heartbeat collections", async () => {
  assert.deepEqual(await readSharedNodeHeartbeats(() => { throw new Error("unexpected query"); }, [], NOW), []);
});

test("latest genuine heartbeat is used; missing/stale heartbeat is offline, revoked binding cannot be online", () => {
  assert.equal(NODE_PRESENCE_WINDOW_MS, 180000);
  assert.equal(projectSharedNodePresence(binding, [], NOW).online_status, "offline");
  const beats = [{ bindingId: String(binding._id), nodeId: binding.nodeId, lastSeenAt: new Date(+NOW - 2000) }];
  const result = projectSharedNodePresence({ ...binding, lastSeenAt: new Date(+NOW - 200000) }, beats, NOW);
  assert.equal(result.online_status, "online");
  assert.equal(result.last_seen_at, new Date(+NOW - 2000).toISOString());
  assert.equal(projectSharedNodePresence({ ...binding, lastSeenAt: new Date(+NOW - 180000) }, [], NOW).online_status, "offline");
  assert.equal(projectSharedNodePresence({ ...binding, lastSeenAt: NOW, revokedAt: NOW }, [], NOW).online, false);
});

test("invalid or future heartbeat and unavailable store are unknown, never falsely online", () => {
  for (const lastSeenAt of ["bad date", "2026-10-23 04:00:00", new Date(+NOW + 1), new Date(NaN)]) {
    assert.equal(projectSharedNodePresence({ ...binding, lastSeenAt }, [], NOW).online_status, "unknown");
  }
  assert.equal(projectSharedNodePresence({ ...binding, lastSeenAt: NOW }, [], NOW, true).online_status, "unknown");
});

test("browser uses monotonic elapsed time, expires green even without a successful refresh", () => {
  const result = { checked_at: NOW.toISOString(), bindings: [{ online: true, online_status: "online", online_expires_at: new Date(+NOW + 1000).toISOString() }] };
  const [row] = nodePresenceSnapshot(result, 500);
  assert.deepEqual(nodePresenceView(row, 501), { status: "online", label: "在线" });
  assert.deepEqual(nodePresenceView(row, 1500), { status: "offline", label: "离线" });
  assert.deepEqual(nodePresenceView(row, 700, true), { status: "unknown", label: "状态未知" });
  assert.equal(nodePresenceView(row, 499).status, "unknown");
});

test("legacy/malformed presence response is gray unknown, not red offline or green online", () => {
  for (const result of [
    { bindings: [{}] },
    { checked_at: NOW.toISOString(), presence_unavailable: true, bindings: [{ online: true, online_status: "online", online_expires_at: NOW.toISOString() }] },
    { checked_at: NOW.toISOString(), bindings: [{ online: false, online_status: "online" }] },
    { checked_at: NOW.toISOString(), bindings: [{ online: true, online_status: "online", online_expires_at: "bad date" }] },
  ]) assert.equal(nodePresenceView(nodePresenceSnapshot(result, 500)[0], 501).status, "unknown");
  const [row] = nodePresenceSnapshot({ checked_at: NOW.toISOString(), bindings: [{ online: false, online_status: "offline" }] }, 500);
  assert.equal(nodePresenceView(row, 501).status, "offline");
});

test("node name includes accessible large status dots; quiet polling preserves group editor and does not trigger jobs", async () => {
  const source = await readFile(new URL("../../src/components/CapabilityConsumersPanel.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../../src/components/CapabilityConsumersPanel.css", import.meta.url), "utf8");
  assert.match(source, /<strong>\{binding.node_name[^]*?<NodePresence binding=\{binding\}/);
  assert.match(source, /cc-node-dot[^]*?aria-hidden="true"/);
  assert.match(css, /\.cc-node-dot\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px/);
  assert.match(css, /is-online[^]*?#15a36e/);
  assert.match(css, /is-offline[^]*?#dc4c4c/);
  assert.match(source, /setInterval\(refresh, 15000\)/);
  assert.match(source, /selectedBinding\?\.binding_id, accessDenied/);
  assert.match(source, /if \(groupSavingRef.current \|\| quiet && bindingInFlight.current\) return/);
  assert.equal(source.includes("/next"), false);
  assert.equal(source.includes('method: "POST"'), false);
});

test("dual-target post-deployment gate checks presence contract and anonymous rejection without probes", async () => {
  const script = await readFile(new URL("../../scripts/verify-compute-group-deployment.mjs", import.meta.url), "utf8");
  assert.match(script, /nodeProperties\?\.online\?\.type !== "boolean"/);
  assert.match(script, /bindingsResponse.status !== 401/);
  assert.match(script, /bindingsResponse.headers.get\("cache-control"\)/);
  assert.equal(script.includes("/capability-verifications/next"), false);
});
