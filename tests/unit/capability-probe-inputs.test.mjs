import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { normalizeProbeInputs, validateProbeInputTickets, createProbeFixtureIssuer } from "../../server/capability-probe-inputs.js";

// Synthetic buffers exist only in memory. No downloaded fixture, model request,
// COS operation, installation or on-disk test payload is created by these tests.
const NOW = new Date("2026-10-19T00:00:00Z");
const BYTES = Buffer.from("fixed-test-input");
const INPUT = { fixture_id: "fixed-pose-v1", role: "source_video", filename: "pose-v1.mp4", content_type: "video/mp4",
  bytes: BYTES.length, sha256: createHash("sha256").update(BYTES).digest("hex") };
const binding = { _id: "binding-one", nodeId: "node-one" };
const challenge = () => ({ bindingId: binding._id, nodeId: binding.nodeId, probeInputs: [INPUT], leaseExpiresAt: new Date(+NOW + 900_000) });
const ticket = () => ({ ...INPUT, download_url: "https://fixtures.example.invalid/fixed?signature=test-only", expires_at: new Date(+NOW + 300_000).toISOString() });

test("fixed fixture descriptors are bounded immutable metadata, never arbitrary client URLs or object keys", () => {
  assert.deepEqual(normalizeProbeInputs([INPUT]), [INPUT]);
  for (const patch of [{ url: "https://unknown.invalid" }, { object_key: "users/private" }, { filename: "../video.mp4" },
    { fixture_id: "../user" }, { sha256: "z".repeat(64) }, { role: "binding_secret" }, { content_type: "text/html" },
    { bytes: 0 }, { bytes: 4 * 1024 * 1024 + 1 }]) assert.throws(() => normalizeProbeInputs([{ ...INPUT, ...patch }]));
  assert.throws(() => normalizeProbeInputs([INPUT, INPUT]));
  assert.throws(() => normalizeProbeInputs(Array.from({ length: 3 }, (_, i) => ({ ...INPUT, fixture_id: `clip-${i}`, bytes: 4 * 1024 * 1024 }))));
});

test("signed input tickets bind exact descriptors, HTTPS and at most five minutes within the original lease", () => {
  assert.deepEqual(validateProbeInputTickets([INPUT], [ticket()], challenge().leaseExpiresAt, NOW), [ticket()]);
  for (const patch of [{ bytes: INPUT.bytes + 1 }, { sha256: "a".repeat(64) }, { download_url: "http://fixtures.invalid" },
    { download_url: "https://user:secret@fixtures.invalid/input" }, { expires_at: NOW.toISOString() },
    { expires_at: new Date(+NOW + 301_000).toISOString() }]) {
    assert.throws(() => validateProbeInputTickets([INPUT], [{ ...ticket(), ...patch }], challenge().leaseExpiresAt, NOW));
  }
  assert.throws(() => validateProbeInputTickets([INPUT], [ticket()], new Date(+NOW + 10_000), NOW));
  assert.throws(() => validateProbeInputTickets([INPUT], [], challenge().leaseExpiresAt, NOW));
});

test("a fixture issuer only uploads registered hash-checked source bytes and reuses concurrent preparation", async () => {
  const writes = [], signatures = []; let exists = false;
  const issue = createProbeFixtureIssuer({ fixtures: [{ descriptor: INPUT, read: async () => BYTES }], now: () => NOW,
    readObject: async () => { if (!exists) throw Object.assign(new Error("not found"), { statusCode: 404 }); return { headers: { "content-length": INPUT.bytes } }; },
    writeObject: async (key, bytes, type) => { writes.push({ key, bytes, type }); exists = true; },
    signDownload: (key, options) => { signatures.push({ key, options }); return ticket().download_url; } });
  const first = await Promise.all([issue({ binding, challenge: challenge() }), issue({ binding, challenge: challenge() })]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, `capability-probe-fixtures/v1/${INPUT.sha256}/${INPUT.filename}`);
  assert.equal(writes[0].bytes, BYTES);
  assert.equal(signatures.length, 2);
  assert.ok(signatures.every((item) => item.options.expires === 300));
  assert.deepEqual(first[0], [ticket()]);
  await issue({ binding, challenge: challenge() });
  assert.equal(writes.length, 1, "an existing registered fixture is not overwritten");
});

test("missing, changed or wrong-size fixtures and storage permission failures never produce a download grant", async () => {
  for (const mode of ["missing", "hash", "size", "permission"]) {
    let signed = false, written = false;
    const issue = createProbeFixtureIssuer({ fixtures: mode === "missing" ? [] : [{ descriptor: INPUT, read: async () => mode === "hash" ? Buffer.from("changed") : BYTES }],
      now: () => NOW, readObject: async () => { if (mode === "permission") throw Object.assign(new Error("denied"), { status: 403 }); return { headers: { "content-length": INPUT.bytes + 1 } }; },
      writeObject: async () => { written = true; }, signDownload: () => { signed = true; return ticket().download_url; } });
    await assert.rejects(() => issue({ binding, challenge: challenge() }));
    assert.equal(signed, false); assert.equal(written, false);
  }
});

test("fixture signing requires the exact bound node and a still-active lease", async () => {
  const issue = createProbeFixtureIssuer({ fixtures: [{ descriptor: INPUT, read: async () => BYTES }], now: () => NOW });
  for (const changed of [{ bindingId: "other" }, { nodeId: "other-node" }, { leaseExpiresAt: NOW }]) {
    await assert.rejects(() => issue({ binding, challenge: { ...challenge(), ...changed } }));
  }
});

test("slow fixture preparation rechecks the lease and never signs after expiration", async () => {
  let instant = +NOW, signatures = 0;
  const issue = createProbeFixtureIssuer({ fixtures: [{ descriptor: INPUT, read: async () => BYTES }], now: () => new Date(instant),
    readObject: async () => { instant += 900_000; return { headers: { "content-length": INPUT.bytes } }; },
    signDownload: () => { signatures++; return ticket().download_url; } });
  await assert.rejects(() => issue({ binding, challenge: challenge() }), { code: "VERIFICATION_LEASE_EXPIRED" });
  assert.equal(signatures, 0);
});
