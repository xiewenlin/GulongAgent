import { createHash } from "node:crypto";
import { createFixedMusicRetestBudget, FIXED_MUSIC_RETEST_COLLECTION } from "./capability-fixed-music-retest.js";
import { buildFixedNativeMusicRegressionCase, matchesFixedNativeMusicParameters } from "./capability-fixed-music-case.js";
import { nativeVerifiedModelScope } from "./capability-native-verification.js";

// LOCAL REVIEW ONLY: not imported by app/next. Reviewed conditional policy;
// no caller/environment quota configuration. Production wiring waits for the
// fixed native's real database proof and a separate reviewed release.
export const CONDITIONAL_SIX_COLLECTION="capabilityVerificationConditionalSixBudgets";
const canonical=v=>JSON.stringify(v,(_,i)=>i&&typeof i==="object"&&!Array.isArray(i)?Object.fromEntries(Object.keys(i).sort().map(k=>[k,i[k]])):i);
const hash=v=>createHash("sha256").update(canonical(v)).digest("hex");
const CAPS={
  "gulong_engine.agent_chat":{key:"chat",matrix:"ff6559891450080c6b0b9299e4f4d0d3ccaa01f113c62ee5d357032ef8e7fbd8"},
  "gulong_engine.embedding":{key:"embedding",matrix:"50b6a996594e11511e9136c79ca57c8dc999eaa87585f54672cb394580271f3a"},
  "gulong_engine.music":{key:"music",matrix:"f565786022f87dd38ce6d893e0208650977dc7ce45fd92b5e11679ac2a7461af"},
  "sam.video_track":{key:"sam",matrix:"d28defd37c921603c6f674b124abbe45eaea461140764a087e62021a8b5f22ab"},
  "mediapipe.video_analysis":{key:"mediapipe",matrix:"93b9bfc38d97323252b8d7e7b50fd12ee9857a8faf4fc9bfeeffd578f5c214fa"},
  "whisper.transcribe":{key:"whisper",matrix:"53496ac6369494461ca65920b8e0b83f616dbafbdc562b19a8ddd9043096ecf4"},
};
const SPEC={id:"gvs_20261020_1829_after_fixed_six",policy:"six-after-verified-fixed-native-v1",
  artifactSha256:"1829a188caee1e3bca564edaa0b836dd173785e7ffda7363cd7a27a7d9cf1ccb",
  scopeSha256:"f7fb77ad7bbea3dc0c193345dcde8b1b58bd56faa2f8ccbe2f418b6f348b90bf",
  fixedAuthorizationId:"gvf_20261020_1829_fixed_native_once",totalLimit:6,capabilities:CAPS,
  authorization:{source:"human-conditional-six-only-after-fixed-native",threadId:"01a07627-9f49-7760-a1b0-ae21244c5c0a",
    turnId:"01a15924-9506-7660-bf1d-358345ca170d",messageId:"01a15943-0a37-7d81-9a97-7ca53607a54b",questionId:"call_c3a9a9525da2456f86bef39f1f5f67d4"}};
const specSha256=hash(SPEC),CASE=buildFixedNativeMusicRegressionCase();
const matchesBinding=b=>hash([String(b?._id),b?.nodeId,SPEC.artifactSha256,b?.computeGroupId||null])===SPEC.scopeSha256
  && b?.status==="active"&&!b.revokedAt&&b.autoVerificationPolicy==="capability-v2";
function exact(binding,row){
  const cap=CAPS[row?.capabilityId],inv=row?.inventory;if(!matchesBinding(binding)||!cap||!inv||!binding.autoVerificationCapabilityIds?.includes(row.capabilityId)
    ||row.bindingId!==String(binding._id)||row.nodeId!==binding.nodeId||row.userId!==String(binding.userId)||(row.computeGroupId||null)!==(binding.computeGroupId||null)
    ||row.artifactSha256!==SPEC.artifactSha256||row.matrixSha256!==cap.matrix||inv.matrixSha256!==cap.matrix||!row.inventoryEnabled||inv.enabled!==true)return false;
  const {capabilityId,capabilityVersion,artifactSha256,models,defaultModel,asrLanguages}=inv;
  return hash({capabilityId,capabilityVersion,artifactSha256,models,defaultModel,asrLanguages})===cap.matrix
    &&models.length===1&&canonical(row.model)===canonical(models[0]);
}
function valid(doc){
  if(!doc)return true;
  try{const entries=Object.entries(doc.consumptions||{});
    return doc.specSha256===specSha256&&hash(doc.spec)===specSha256&&doc.state==="active"
      &&hash([doc.scope.bindingId,doc.scope.nodeId,doc.scope.artifactSha256,doc.scope.computeGroupId||null])===SPEC.scopeSha256
      && Number.isSafeInteger(doc.usedTotal)&&doc.usedTotal>=0&&doc.usedTotal<=6&&entries.length===doc.usedTotal
      &&+new Date(doc.expiresAt)- +new Date(doc.readyAt)===7_200_000&&/^[a-f0-9]{64}$/.test(doc.fixedEvidenceSha256)
      &&Object.keys(doc.usedByCapability||{}).length===6&&Object.entries(CAPS).every(([id,cap])=>[0,1].includes(doc.usedByCapability[cap.key])
        &&entries.filter(([,r])=>r.capabilityId===id).length===doc.usedByCapability[cap.key])
      &&entries.every(([key,r])=>key===hash(r.challengeId)&&CAPS[r.capabilityId]&&r.unit===1
        &&r.artifactSha256===SPEC.artifactSha256&&r.matrixSha256===CAPS[r.capabilityId].matrix&&/^[a-f0-9]{64}$/.test(r.verificationId||""));
  }catch{return false;}
}
export function createConditionalSixBudget({getCollection,now=()=>new Date()}){
  const fixed=createFixedMusicRetestBudget({getCollection,now});
  async function prerequisite(binding){
    if(!matchesBinding(binding))return {eligible:false,state:"not_applicable"};
    const status=await fixed.status({binding});
    const closed=state=>({eligible:false,state,readyAt:status.ready_at?new Date(status.ready_at):null,expiresAt:status.expires_at?new Date(status.expires_at):null});
    if(!status.ready_at||+new Date(now())>=+new Date(status.expires_at))return closed(status.ready_at?"expired":"awaiting_fixed_native");
    if(status.state!=="exhausted"||status.total.used!==1||!status.inventory_ready)return closed("awaiting_fixed_native");
    const grant=await(await getCollection(FIXED_MUSIC_RETEST_COLLECTION)).findOne({_id:SPEC.fixedAuthorizationId});
    if(!grant?.consumption)return closed("awaiting_fixed_native");
    const proof=await(await getCollection("capabilityAutoVerifications")).findOne({_id:grant.consumption.verificationId,
      bindingId:String(binding._id),nodeId:binding.nodeId,userId:String(binding.userId),computeGroupId:binding.computeGroupId||null,
      artifactSha256:SPEC.artifactSha256,matrixSha256:status.matrix_sha256,status:"active",inventoryEnabled:true});
    const flags=["exact_native_scope","music_generation","whole_audio_asr","exact_lyrics","exact_duration","fixed_regression_case"];
    if(!proof||proof.challengeId!==grant.consumption.challengeId||!proof.fixedCaseOnly
      ||canonical(proof.fixedCaseOrigin)!==canonical(CASE.audit_origin)||!matchesFixedNativeMusicParameters(proof.parameters)
      ||!flags.every(k=>proof.contractTests?.[k]===true)||!/^[a-f0-9]{64}$/.test(proof.testEvidenceSha256||"")
      ||!/^[a-f0-9]{64}$/.test(proof.resultFingerprint||"")||canonical(proof.asrLanguages)!=='["en"]'
      ||+new Date(proof.testedAt)<+new Date(status.ready_at)||+new Date(proof.testedAt)>+new Date(now())||+new Date(proof.expiresAt)<=+new Date(now())
      ||+new Date(proof.expiresAt)- +new Date(proof.testedAt)>7*86400_000)return closed("awaiting_fixed_native");
    const model=nativeVerifiedModelScope("minimax_music_3.generate",proof.verifiedModel);
    if(!model||model.max_duration_seconds<11||model.max_duration_seconds>12)return closed("awaiting_fixed_native");
    const journal=await(await getCollection("capabilityVerificationChallenges")).findOne({_id:grant.consumption.requestRecordId,
      requestId:grant.consumption.requestId,challengeId:proof.challengeId,bindingId:String(binding._id),userId:String(binding.userId),status:"active"});
    if(!journal||journal.featureId!==proof._id||journal.artifactSha256!==SPEC.artifactSha256||journal.matrixSha256!==status.matrix_sha256
      ||journal.budgetSource!=="fixed_music_regression"||journal.resultFingerprint!==proof.resultFingerprint
      ||!matchesFixedNativeMusicParameters(journal.parameters))return closed("awaiting_fixed_native");
    const audit=await(await getCollection("capabilityVerificationAudits")).findOne({action:"capability.automatic_verification_passed",
      challengeId:proof.challengeId,verificationId:proof._id,bindingId:String(binding._id),nodeId:binding.nodeId,
      artifactSha256:SPEC.artifactSha256,matrixSha256:status.matrix_sha256});
    if(!audit||canonical(audit.model)!==canonical(proof.verifiedModel)||!/^[a-f0-9]{64}$/.test(audit.resultSha256||""))return closed("awaiting_fixed_native");
    return {eligible:true,state:"available",readyAt:new Date(status.ready_at),expiresAt:new Date(status.expires_at),
      proofId:proof._id,challengeId:proof.challengeId,evidence:proof.testEvidenceSha256};
  }
  async function available(args){
    if(args.controlled!==true||!exact(args.binding,args.candidate))return false;
    const row=await(await getCollection("capabilityAutoVerifications")).findOne({_id:args.candidate._id});
    if(!row||!exact(args.binding,row))return false;
    const gate=await prerequisite(args.binding);if(!gate.eligible)return false;
    const doc=await(await getCollection(CONDITIONAL_SIX_COLLECTION)).findOne({_id:SPEC.id});
    return valid(doc)&&(!doc||doc.fixedProofId===gate.proofId&&doc.fixedEvidenceSha256===gate.evidence
      &&+new Date(doc.readyAt)===+gate.readyAt&&+new Date(doc.expiresAt)===+gate.expiresAt&&doc.usedTotal<6&&doc.usedByCapability[CAPS[row.capabilityId].key]===0);
  }
  async function reserve(args){
    if(!await available(args))return null;
    const {binding,candidate,challengeId,requestId,requestRecordId}=args,gate=await prerequisite(binding);
    if(!gate.eligible)return null;
    const collection=await getCollection(CONDITIONAL_SIX_COLLECTION),instant=new Date(now());
    try{await collection.updateOne({_id:SPEC.id},{$setOnInsert:{spec:SPEC,specSha256,state:"active",readyAt:gate.readyAt,expiresAt:gate.expiresAt,
      scope:{bindingId:String(binding._id),nodeId:binding.nodeId,artifactSha256:SPEC.artifactSha256,computeGroupId:binding.computeGroupId||null},
      fixedProofId:gate.proofId,fixedChallengeId:gate.challengeId,fixedEvidenceSha256:gate.evidence,
      usedTotal:0,usedByCapability:Object.fromEntries(Object.values(CAPS).map(c=>[c.key,0])),consumptions:{},createdAt:instant,updatedAt:instant}},{upsert:true});}
    catch(e){if(e.code!==11000)throw e;}
    const doc=await collection.findOne({_id:SPEC.id});if(!valid(doc))return null;
    const key=hash(challengeId),cap=CAPS[candidate.capabilityId],reservedAt=new Date(now());
    const receipt={challengeId,requestId,requestRecordId,verificationId:candidate._id,capabilityId:candidate.capabilityId,
      artifactSha256:SPEC.artifactSha256,matrixSha256:candidate.matrixSha256,unit:1,reservedAt};
    const result=await collection.findOneAndUpdate({_id:SPEC.id,specSha256,state:"active",fixedProofId:gate.proofId,fixedEvidenceSha256:gate.evidence,
      readyAt:{$lte:reservedAt},expiresAt:{$gt:reservedAt},usedTotal:{$lt:6},[`usedByCapability.${cap.key}`]:0,[`consumptions.${key}`]:{$exists:false}},
    {$inc:{usedTotal:1,[`usedByCapability.${cap.key}`]:1},$set:{[`consumptions.${key}`]:receipt,updatedAt:reservedAt}},{returnDocument:"after"});
    const saved=result&&Object.hasOwn(result,"value")?result.value:result;
    if(!saved)return null;
    if(!(await prerequisite(binding)).eligible)throw Object.assign(new Error("原生固定回归证明已变化，禁止执行后继探测"),{code:"VERIFICATION_PREREQUISITE_CHANGED",status:409});
    return {authorizationId:SPEC.id,consumptionId:key,reservedAt,fixedProofId:gate.proofId};
  }
  async function status({binding}){
    const gate=await prerequisite(binding);if(gate.state==="not_applicable")return {policy:SPEC.policy,applicable:false,state:gate.state};
    const doc=await(await getCollection(CONDITIONAL_SIX_COLLECTION)).findOne({_id:SPEC.id});
    const good=valid(doc)&&(!doc||!gate.eligible||doc.fixedProofId===gate.proofId&&doc.fixedEvidenceSha256===gate.evidence
      &&+new Date(doc.readyAt)===+gate.readyAt&&+new Date(doc.expiresAt)===+gate.expiresAt),open=gate.eligible&&good,used=doc?.usedTotal||0;
    return {policy:SPEC.policy,applicable:true,authorization_id:SPEC.id,artifact_sha256:SPEC.artifactSha256,
      state:!good?"unavailable":!gate.eligible?gate.state:used>=6?"exhausted":"available",prerequisite_met:gate.eligible,
      approved_limit:6,total:{limit:gate.eligible?6:0,used,remaining:open?6-used:0},ready_at:gate.readyAt||doc?.readyAt||null,
      expires_at:gate.expiresAt||doc?.expiresAt||null,capabilities:Object.entries(CAPS).map(([id,cap])=>({capability_id:id,
        approved_limit:1,limit:gate.eligible?1:0,used:doc?.usedByCapability?.[cap.key]||0,remaining:open?1-(doc?.usedByCapability?.[cap.key]||0):0})),
      ordinary_fallback:false,resets_original_budgets:false,grants_admission:false,business_admission:false};
  }
  return {prerequisite,available,reserve,status};
}
