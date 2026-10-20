import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { isNodeArtifactQuarantined, nodeArtifactInstallationGuardStatus } from "../../server/capability-artifact-installation-guard.js";
import { capabilityNodeCanRunOrder } from "../../server/capability-orders.js";

// In-memory policy tests; no inventory report, database write or model request.
const binding={_id:new ObjectId("6ab71678e4859d7255789e08"),nodeId:"85254b9d69e4e3307049020c58bab89f2edae70a50817c37ca561194105512d1",userId:"same-user",computeGroupId:null};
const existing=["554a6c84d242aadb9e5df18b0dff5f24298ccc3a0ed35fb7f25c97ac0801c281",
  "983ea1b00180824ef7cf310594efa2a1e755b0293a853225ea286055149c9aa7","f8bb182e7059eefe075567f37617324e4105dbfd81426c1cc82a44ef9355c27d"];
test("deny-only quarantine preserves existing artifact rules and blocks every unknown, predicted or missing artifact",()=>{
  for(const artifact of existing){assert.equal(isNodeArtifactQuarantined(binding,artifact),false);assert.equal(isNodeArtifactQuarantined(binding,artifact.toUpperCase()),false);}
  for(const artifact of ["1829a188caee1e3bca564edaa0b836dd173785e7ffda7363cd7a27a7d9cf1ccb","a".repeat(64),null,undefined,""])
    assert.equal(isNodeArtifactQuarantined(binding,artifact),true);
  assert.equal(nodeArtifactInstallationGuardStatus(binding).fixed_case_authorization_active,false);
  assert.equal(nodeArtifactInstallationGuardStatus(binding).grants_admission,false);
});
test("unknown artifact cannot escape quarantine by changing group, and unrelated bindings/nodes remain unchanged",()=>{
  assert.equal(isNodeArtifactQuarantined({...binding,computeGroupId:"changed"},"a".repeat(64)),true);
  for(const patch of [{_id:new ObjectId()},{nodeId:"another-node"}])assert.equal(isNodeArtifactQuarantined({...binding,...patch},"a".repeat(64)),false);
});
test("same-account legacy and client-validated business flags cannot bypass unknown-artifact installation quarantine",()=>{
  const item={capabilityId:"codex.text",capabilityVersion:"1",installed:true,validated:true,enabled:true,artifactSha256:"a".repeat(64)};
  const node={availableSlots:1,nodeId:binding.nodeId,binding,capabilities:[item]};
  const order={capabilityId:"codex.text",capabilityVersion:"1",requesterUserId:"same-user",computeGroupId:null,parameters:{}};
  assert.equal(capabilityNodeCanRunOrder(node,order),false);
  assert.equal(capabilityNodeCanRunOrder({...node,capabilities:[{...item,artifactSha256:existing[0]}]},order),true);
  assert.equal(capabilityNodeCanRunOrder({...node,nodeId:"other",binding:{...binding,nodeId:"other"}},order),true);
});
