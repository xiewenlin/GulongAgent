import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { buildFixedNativeMusicRegressionCase, matchesFixedNativeMusicParameters } from "./capability-fixed-music-case.js";

export const FIXED_MUSIC_RETEST_COLLECTION = "capabilityVerificationFixedMusicRetests";
const canonical = v => JSON.stringify(v,(_,i)=>i && typeof i==="object" && !Array.isArray(i)
  ? Object.fromEntries(Object.keys(i).sort().map(k=>[k,i[k]])):i);
const hash = v => createHash("sha256").update(canonical(v)).digest("hex");
const CASE = buildFixedNativeMusicRegressionCase();
const SPEC = Object.freeze({id:"gvf_20261020_1829_fixed_native_once",policy:"fixed-native-regression-once-v1",
  artifactSha256:"1829a188caee1e3bca564edaa0b836dd173785e7ffda7363cd7a27a7d9cf1ccb",
  scopeSha256:"f7fb77ad7bbea3dc0c193345dcde8b1b58bd56faa2f8ccbe2f418b6f348b90bf",
  capabilityId:"minimax_music_3.generate",capabilityVersion:"3",
  matrixSha256:"f3d8ce56d82d427c39e9ad95a525794019851efeb6173fd49be8e66fa1dc9c41",
  parametersSha256:CASE.audit_origin.parameters_sha256,origin:CASE.audit_origin,
  totalLimit:1,windowMs:120*60_000,activationDeadline:"2026-10-20T14:00:00.000Z",
  authorization:{source:"human-explicit-fixed-seed-one-attempt",threadId:"01a07627-9f49-7760-a1b0-ae21244c5c0a",
    turnId:"01a15865-4841-7491-a69f-fc413f3b7e2c",messageId:"01a158a3-2cf0-7733-ba32-a308a37d1563",
    questionId:"call_8ad53ad04b2e4721810164a8b6ef9a2e"},
});
const specSha256=hash(SPEC), scopeHash=b=>hash([String(b?._id),b?.nodeId,SPEC.artifactSha256,b?.computeGroupId||null]);
const bindingMatches=b=>scopeHash(b)===SPEC.scopeSha256 && b?.status==="active" && !b.revokedAt
  && b.autoVerificationPolicy==="capability-v2" && b.autoVerificationCapabilityIds?.includes(SPEC.capabilityId);
function exactCandidate(binding,candidate){
  const inv=candidate?.inventory;
  if(!bindingMatches(binding)||!inv||candidate.bindingId!==String(binding._id)||candidate.nodeId!==binding.nodeId
    ||(candidate.computeGroupId||null)!==(binding.computeGroupId||null)||candidate.inventoryEnabled!==true||inv.enabled!==true
    ||candidate.capabilityId!==SPEC.capabilityId||candidate.capabilityVersion!==SPEC.capabilityVersion
    ||candidate.artifactSha256!==SPEC.artifactSha256||candidate.matrixSha256!==SPEC.matrixSha256||inv.matrixSha256!==SPEC.matrixSha256)return false;
  const {capabilityId,capabilityVersion,artifactSha256,models,defaultModel,asrLanguages}=inv;
  return hash({capabilityId,capabilityVersion,artifactSha256,models,defaultModel,asrLanguages})===SPEC.matrixSha256
    && models.length===1 && canonical(candidate.model)===canonical(models[0]);
}
function valid(doc){
  if(!doc)return false;
  try{return doc.specSha256===specSha256 && hash(doc.spec)===specSha256 && hash(doc.authorization)===hash(SPEC.authorization)
    && doc.state==="active" && hash([doc.scope.bindingId,doc.scope.nodeId,doc.scope.artifactSha256,doc.scope.computeGroupId||null])===SPEC.scopeSha256
    && /^[a-f0-9]{40}$/.test(doc.activationCommit||"") && Number.isFinite(+new Date(doc.readyAt))
    && +new Date(doc.readyAt)<+new Date(SPEC.activationDeadline)
    && +new Date(doc.expiresAt)- +new Date(doc.readyAt)===SPEC.windowMs
    && +new Date(doc.notBefore)===Math.max(+new Date(doc.readyAt),+new Date(doc.sourceEvidence.nextRetryAt||0))
    && doc.sourceEvidence.requestId===SPEC.origin.source_request_id && doc.sourceEvidence.challengeId===SPEC.origin.source_challenge_id
    && doc.sourceEvidence.parametersSha256===SPEC.parametersSha256 && Number.isSafeInteger(doc.sourceEvidence.attempts)
    && doc.sourceEvidence.attempts>=1 && [0,1].includes(doc.usedTotal)
    && (doc.usedTotal===0?doc.consumption===null:doc.consumption?.unit===1
      && doc.consumption.capabilityId===SPEC.capabilityId && doc.consumption.artifactSha256===SPEC.artifactSha256
      && doc.consumption.matrixSha256===SPEC.matrixSha256 && doc.consumption.parametersSha256===SPEC.parametersSha256
      && /^[a-f0-9]{64}$/.test(doc.consumption.verificationId||""));}catch{return false;}
}
function error(code,message){return Object.assign(new Error(message),{code,status:409});}
function activationView(saved,instant){
  const expired=+new Date(instant)>=+new Date(saved.expiresAt);
  return {authorization_id:SPEC.id,ready_at:saved.readyAt,expires_at:saved.expiresAt,limit:1,used:saved.usedTotal,
    remaining:expired?0:Math.max(0,1-saved.usedTotal),state:expired?"expired":saved.usedTotal?"exhausted":"available",
    activation_commit:saved.activationCommit,model_requests:0,next_requests:0};
}

// Deployment-only operation. Not imported into any HTTP handler. CI calls it
// after BOTH releases and read-only contracts pass. Replays cannot extend time.
export async function activateFixedMusicRetestForDeployment({getCollection,now=()=>new Date(),expectedCommit,installedCommit}){
  if(!/^[a-f0-9]{40}$/.test(expectedCommit||"")||expectedCommit!==installedCommit)
    throw error("FIXED_RETEST_DEPLOYMENT_MISMATCH","发布提交不一致，禁止激活固定回归");
  const collection=await getCollection(FIXED_MUSIC_RETEST_COLLECTION);
  const existing=await collection.findOne({_id:SPEC.id});
  if(existing){
    if(!valid(existing))throw error("FIXED_RETEST_STATE_INVALID","固定回归账本不可更改或续期");
    return activationView(existing,now());
  }
  if(+new Date(now())>=+new Date(SPEC.activationDeadline))throw error("FIXED_RETEST_ACTIVATION_CLOSED","首次激活时段已结束，禁止以后自动启用");
  const records=await getCollection("capabilityVerificationChallenges");
  const source=await records.findOne({challengeId:SPEC.origin.source_challenge_id,requestId:SPEC.origin.source_request_id});
  if(!source||source.status!=="failed"||source.capabilityId!==SPEC.capabilityId||source.capabilityVersion!==SPEC.capabilityVersion
    ||source.artifactSha256!==SPEC.origin.source_artifact_sha256
    ||!matchesFixedNativeMusicParameters(source.parameters)||!ObjectId.isValid(source.bindingId))
    throw error("FIXED_RETEST_SOURCE_MISMATCH","原始失败回归向量不一致，禁止激活");
  const binding=await(await getCollection("nodeAccountBindings")).findOne({_id:new ObjectId(source.bindingId)});
  if(!bindingMatches(binding))throw error("FIXED_RETEST_BINDING_MISMATCH","固定回归节点或用户分组不一致");
  const readyAt=new Date(now()), sourceEvidence={requestId:source.requestId,challengeId:source.challengeId,
    parametersSha256:hash(source.parameters),attempts:source.attempts,nextRetryAt:source.nextRetryAt||null};
  const doc={_id:SPEC.id,spec:SPEC,specSha256,authorization:SPEC.authorization,state:"active",
    scope:{bindingId:String(binding._id),nodeId:binding.nodeId,artifactSha256:SPEC.artifactSha256,computeGroupId:binding.computeGroupId||null},
    activationCommit:expectedCommit,readyAt,expiresAt:new Date(+readyAt+SPEC.windowMs),
    notBefore:new Date(Math.max(+readyAt,+new Date(sourceEvidence.nextRetryAt||0))),sourceEvidence,
    usedTotal:0,consumption:null,createdAt:readyAt,updatedAt:readyAt};
  if(!valid(doc))throw error("FIXED_RETEST_SOURCE_INCOMPLETE","原始回归来源或退避证据不完整");
  try{await collection.updateOne({_id:SPEC.id},{$setOnInsert:doc},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
  const saved=await collection.findOne({_id:SPEC.id});
  if(!valid(saved))throw error("FIXED_RETEST_STATE_INVALID","固定回归账本不可更改或续期");
  return activationView(saved,now());
}

export function createFixedMusicRetestBudget({getCollection,now=()=>new Date()}){
  async function inspect({binding,candidate,controlled}){
    if(controlled!==true||!exactCandidate(binding,candidate))return {available:false};
    const live=await(await getCollection("capabilityAutoVerifications")).findOne({_id:candidate._id});
    if(!live||!exactCandidate(binding,live))return {available:false};
    const doc=await(await getCollection(FIXED_MUSIC_RETEST_COLLECTION)).findOne({_id:SPEC.id});
    if(!valid(doc)||doc.usedTotal!==0||+new Date(now())>=+new Date(doc.expiresAt))return {available:false};
    if(+new Date(now())<+new Date(doc.notBefore))return {available:false,retry_at:new Date(doc.notBefore).toISOString()};
    return {available:true};
  }
  const available=async args=>(await inspect(args)).available;
  async function reserve(args){
    if(!await available(args))return null;
    const {binding,candidate,challengeId,requestId,requestRecordId}=args,reservedAt=new Date(now());
    const consumption={challengeId,requestId,requestRecordId,verificationId:candidate._id,unit:1,reservedAt,
      capabilityId:SPEC.capabilityId,artifactSha256:SPEC.artifactSha256,matrixSha256:SPEC.matrixSha256,parametersSha256:SPEC.parametersSha256};
    const result=await(await getCollection(FIXED_MUSIC_RETEST_COLLECTION)).findOneAndUpdate({_id:SPEC.id,specSha256,state:"active",usedTotal:0,consumption:null,
      readyAt:{$lte:reservedAt},notBefore:{$lte:reservedAt},expiresAt:{$gt:reservedAt}},
    {$inc:{usedTotal:1},$set:{consumption,updatedAt:reservedAt}},{returnDocument:"after"});
    const saved=result&&Object.hasOwn(result,"value")?result.value:result;
    return saved?{authorizationId:SPEC.id,consumptionId:hash(challengeId),reservedAt,parametersSha256:SPEC.parametersSha256,
      priorAttempts:saved.sourceEvidence.attempts,origin:SPEC.origin}:null;
  }
  async function status({binding}){
    if(!bindingMatches(binding))return {policy:SPEC.policy,applicable:false,state:"not_applicable"};
    const doc=await(await getCollection(FIXED_MUSIC_RETEST_COLLECTION)).findOne({_id:SPEC.id}),good=valid(doc),instant=+new Date(now());
    const rows=await(await getCollection("capabilityAutoVerifications")).find({bindingId:String(binding._id),artifactSha256:SPEC.artifactSha256,
      capabilityId:SPEC.capabilityId}).limit(8).toArray(),ready=rows.some(r=>exactCandidate(binding,r));
    const open=good&&instant>=+new Date(doc.readyAt)&&instant<+new Date(doc.expiresAt),used=doc?.usedTotal||0;
    return {policy:SPEC.policy,applicable:true,authorization_id:SPEC.id,artifact_sha256:SPEC.artifactSha256,matrix_sha256:SPEC.matrixSha256,
      parameters_sha256:SPEC.parametersSha256,source_case:SPEC.origin,ready_at:doc?.readyAt||null,expires_at:doc?.expiresAt||null,
      activation_deadline:SPEC.activationDeadline,
      state:!doc?(instant>=+new Date(SPEC.activationDeadline)?"activation_closed":"awaiting_deployment_activation"):!good?"unavailable":!open?"expired":used?"exhausted":!ready?"awaiting_inventory":instant<+new Date(doc.notBefore)?"backoff":"available",
      inventory_ready:ready,total:{limit:1,used,remaining:open?1-used:0},ordinary_fallback:false,business_admission:false,
      consumption:good&&doc.consumption?{request_id:doc.consumption.requestId,challenge_id:doc.consumption.challengeId,reserved_at:doc.consumption.reservedAt}:null,
      resets_original_budgets:false,grants_admission:false};
  }
  return {available,inspect,reserve,status,buildProbe:()=>buildFixedNativeMusicRegressionCase().probe,
    matchesProbe:probe=>matchesFixedNativeMusicParameters(probe?.parameters),origin:SPEC.origin};
}
