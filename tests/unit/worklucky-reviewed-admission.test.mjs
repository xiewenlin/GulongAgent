import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createWorkLuckyReviewedAdmission, isReviewedWorkLuckyBusinessAllowed } from "../../server/worklucky-reviewed-admission.js";
import { capabilityNodeCanRunOrder } from "../../server/capability-orders.js";

// In-memory server proofs only: no acceptance registration, asset or model call.
const NOW = new Date(), ARTIFACT = "1829a188caee1e3bca564edaa0b836dd173785e7ffda7363cd7a27a7d9cf1ccb";
function fixture() {
  const binding={_id:new ObjectId("6ab71678e4859d7255789e08"),userId:new ObjectId("6ab71678e4859d7255789e09"),
    nodeId:"85254b9d69e4e3307049020c58bab89f2edae70a50817c37ca561194105512d1",computeGroupId:null,status:"active",revokedAt:null};
  const inventory={capabilityId:"gulong_engine.embedding",capabilityVersion:"1.0.0",artifactSha256:ARTIFACT,
    matrixSha256:"50b6a996594e11511e9136c79ca57c8dc999eaa87585f54672cb394580271f3a"};
  const record={_id:"memory-real-proof",bindingId:String(binding._id),userId:String(binding.userId),nodeId:binding.nodeId,
    capabilityId:inventory.capabilityId,artifactSha256:ARTIFACT,matrixSha256:inventory.matrixSha256,status:"active",inventoryEnabled:true,
    computeGroupId:null,challengeId:"memory-original-challenge",contractTests:{exact_request:true,complete_response:true,exact_model_dimension:true},
    testedAt:new Date(+NOW-1000),expiresAt:new Date(+NOW+6*86400_000),testEvidenceSha256:"a".repeat(64),resultFingerprint:"b".repeat(64),
    verifiedModel:{id:"qwen3-embedding-0.6b-q8-0",dimension:1024}};
  let audit={action:"capability.automatic_verification_passed",verificationId:record._id,challengeId:record.challengeId,
    bindingId:String(binding._id),nodeId:binding.nodeId,artifactSha256:ARTIFACT,matrixSha256:inventory.matrixSha256,
    model:{dimension:1024,id:record.verifiedModel.id},resultSha256:"c".repeat(64)};
  const service=createWorkLuckyReviewedAdmission({getCollection:async()=>({findOne:async query=>audit&&Object.entries(query).every(([key,value])=>audit[key]===value)?audit:null})});
  return {binding,inventory,record,service,set audit(value){audit=value;}};
}
test("review creates only process-owned WorkLucky authority and copied/client flags cannot bypass product, group, capability or expiry",async()=>{
  const f=fixture(),decision=await f.service.review({...f,records:[f.record],now:NOW});assert.ok(decision);
  const report={capabilityId:f.inventory.capabilityId,capabilityVersion:"1.0.0",validation:{artifactSha256:ARTIFACT},reviewedBusinessAdmission:decision.approval};
  assert.equal(isReviewedWorkLuckyBusinessAllowed(f.binding,report,"worklucky",NOW),true);
  for(const product of [null,"gulong_engine","digital_live","english_coach"])assert.equal(isReviewedWorkLuckyBusinessAllowed(f.binding,report,product,NOW),false);
  assert.equal(isReviewedWorkLuckyBusinessAllowed({...f.binding,computeGroupId:"other"},report,"worklucky",NOW),false);
  assert.equal(isReviewedWorkLuckyBusinessAllowed(f.binding,JSON.parse(JSON.stringify(report)),"worklucky",NOW),false);
  assert.equal(isReviewedWorkLuckyBusinessAllowed(f.binding,{...report,capabilityId:"minimax_music_3.generate"},"worklucky",NOW),false);
  assert.equal(isReviewedWorkLuckyBusinessAllowed(f.binding,report,"worklucky",new Date(+NOW+8*86400_000)),false);
});
test("fixed regression, missing audit, changed inventory, revoked/group/user/hash/TTL/flag evidence never becomes ordinary admission",async()=>{
  for(const mutate of [f=>{f.record.fixedCaseOnly=true;},f=>{f.audit=null;},f=>{f.inventory.matrixSha256="d".repeat(64);},
    f=>{f.binding.revokedAt=NOW;},f=>{f.binding.computeGroupId="other";},f=>{f.record.userId="other";},
    f=>{f.record.testEvidenceSha256="";},f=>{f.record.expiresAt=new Date(0);},f=>{f.record.contractTests.exact_request=false;},
    f=>{f.record.testedAt="invalid";},f=>{f.inventory.capabilityId="minimax_music_3.generate";}]){
    const f=fixture();mutate(f);assert.equal(await f.service.review({...f,records:[f.record],now:NOW}),null);
  }
});
test("final business matcher admits fresh server-reviewed exact report for WorkLucky only, not same-account fallback",async()=>{
  const f=fixture(),decision=await f.service.review({...f,records:[f.record],now:NOW});
  const report={capabilityId:f.inventory.capabilityId,capabilityVersion:"1.0.0",validation:{artifactSha256:ARTIFACT},
    installed:true,validated:true,enabled:true,trustedAcceptance:true,models:[f.record.verifiedModel],reviewedBusinessAdmission:decision.approval};
  const node={binding:f.binding,nodeId:f.binding.nodeId,availableSlots:1,capabilities:[report]};
  const order={capabilityId:f.inventory.capabilityId,capabilityVersion:"1.0.0",requesterUserId:String(f.binding.userId),computeGroupId:null,catalogProbe:true,clientProduct:"worklucky"};
  assert.equal(capabilityNodeCanRunOrder(node,order),true);
  assert.equal(capabilityNodeCanRunOrder(node,{...order,clientProduct:null}),false);
  assert.equal(capabilityNodeCanRunOrder(node,{...order,clientProduct:"digital_live"}),false);
  assert.equal(capabilityNodeCanRunOrder({...node,capabilities:[JSON.parse(JSON.stringify(report))]},order),false);
});
