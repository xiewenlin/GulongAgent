import assert from "node:assert/strict";
import test from "node:test";
import { requiresAutomaticCapabilityVerification as required } from "../../server/capability-verification-policy.js";

test("per-capability migration is server-owned and v1 or malformed v2 state cannot relax admission", () => {
  assert.equal(required({}, "gulong_engine.image"), false);
  assert.equal(required({ autoVerificationEnrolledAt: new Date() }, "gulong_engine.image"), true);
  for (const ids of [undefined, null, "gulong_engine.agent_chat", [null]]) {
    assert.equal(required({ autoVerificationPolicy: "capability-v2", autoVerificationCapabilityIds: ids }, "gulong_engine.image"), true);
  }
  const binding = { autoVerificationEnrolledAt: new Date(), autoVerificationPolicy: "capability-v2",
    autoVerificationCapabilityIds: ["gulong_engine.agent_chat"] };
  assert.equal(required(binding, "gulong_engine.agent_chat"), true);
  assert.equal(required(binding, "gulong_engine.image"), false);
  assert.equal(required({ ...binding, autoVerificationCapabilityIds: [] }, "gulong_engine.image"), false);
});
