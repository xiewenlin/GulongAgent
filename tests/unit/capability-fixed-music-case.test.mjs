import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildFixedNativeMusicRegressionCase, matchesFixedNativeMusicParameters, fixedNativeMusicActivationPlan } from "../../server/capability-fixed-music-case.js";
import { createNativeCapabilityVerificationAdapters } from "../../server/capability-native-verification.js";

// Memory-only validator stand-ins; no model, ASR, network, media files or grants.
const expected = {
  prompt: "A clear solo singing voice, simple gentle accompaniment, sing the complete lyrics exactly once.",
  lyrics: "Blue sky, silver river.\ntwo, zero, three, three.",
  duration_seconds: 12, sample_rate: 44100, output_format: "flac", language: "auto", seed: 716491643,
};
const sha = value => createHash("sha256").update(value).digest("hex");

test("fixed case preserves approved raw bytes, numeric seed and exactly one inference plus one full ASR", () => {
  const { probe, audit_origin } = buildFixedNativeMusicRegressionCase();
  assert.deepEqual(probe.parameters, expected);
  assert.equal(typeof probe.parameters.seed,"number");
  assert.equal(probe.parameters.lyrics.includes("[verse]"),false);
  assert.deepEqual(probe.budget,{max_inferences:1,max_output_tokens:0,max_audio_seconds:12,max_asr_passes:1});
  assert.equal(audit_origin.source_challenge_id,"gcv_626fd91d-e00e-4c36-93ea-18a0bd98b8bd");
  assert.equal(audit_origin.source_request_id,"254ab592-da1a-4738-afcd-05a2312c530d");
  assert.match(audit_origin.parameters_sha256,/^[a-f0-9]{64}$/);
  probe.parameters.lyrics="changed";audit_origin.source_request_id="changed";
  assert.deepEqual(buildFixedNativeMusicRegressionCase().probe.parameters,expected);
  assert.equal(matchesFixedNativeMusicParameters(expected),true);
});

test("fixed case refuses coercion, extra ASR hints, tags, lyric changes and changed audio settings",()=>{
  for(const patch of [{seed:"716491643"},{seed:716491644},{lyrics:expected.lyrics.replace("\n"," ")},
    {lyrics:`[verse]\n${expected.lyrics}`},{duration_seconds:11},{sample_rate:48000},{output_format:"wav"},
    {language:"en"},{prompt:"another prompt"},{asr_hint:expected.lyrics}]){
    assert.equal(matchesFixedNativeMusicParameters({...expected,...patch}),false,JSON.stringify(patch));
  }
  for(const invalid of [null,undefined,[],"text",{}])assert.equal(matchesFixedNativeMusicParameters(invalid),false);
});

async function validateMemoryResult({ transcript=expected.lyrics, duration=11.993106575963719, fullAudio=true }={}) {
  const {probe}=buildFixedNativeMusicRegressionCase();const audioSha="a".repeat(64);
  const adapter=createNativeCapabilityVerificationAdapters({verifyMediaOutputs:async()=>[
    {role:"primary_audio",contentType:"audio/flac",bytes:1000,sha256:audioSha,durationSeconds:duration,sampleRate:44100},
  ]})["minimax_music_3.generate"];
  return adapter.validateResult({binding:{_id:"memory-only"},
    challenge:{capabilityId:"minimax_music_3.generate",capabilityVersion:"3",inventory:{asrLanguages:["en","zh"]},
      model:{id:"MiniMax-Music3",max_duration_seconds:300},parameters:probe.parameters,probeOutputRules:probe.outputRules},
    outputs:[{output_id:"memory-only-output"}],inlineResult:{model:"MiniMax-Music3",lyric_verification:{
      algorithm:"ordered-whole-lyrics-v1",full_audio:fullAudio,language:"en",audio_sha256:audioSha,
      lyrics_sha256:sha(expected.lyrics),transcript,
    }},
  });
}

test("unchanged native v1 validator still rejects actual historical missing lyrics and truncated ASR",async()=>{
  const synthetic=await validateMemoryResult();assert.equal(synthetic.contractTests.exact_lyrics,true);
  for(const transcript of ["Please God, Silver River","Blue sky, silver river.","two, zero, three, three. Blue sky, silver river."])
    await assert.rejects(()=>validateMemoryResult({transcript}));
  await assert.rejects(()=>validateMemoryResult({duration:10.9}));
  await assert.rejects(()=>validateMemoryResult({fullAudio:false}));
});

test("review draft has no artifact authorization, TTL, route or runtime wiring",async()=>{
  const plan=fixedNativeMusicActivationPlan();assert.equal(plan.state,"draft_not_active");
  for(const key of ["authorization_id","artifact_sha256","matrix_sha256","valid_from","expires_at"])assert.equal(plan[key],null);
  assert.equal(plan.hard_limit,1);assert.equal(plan.routable,false);assert.equal(plan.grants_admission,false);
  assert.equal(plan.ordinary_fallback,false);assert.equal(plan.resets_original_budgets,false);
  for(const file of ["app.js","capability-auto-verification.js"]){
    const source=await readFile(new URL(`../../server/${file}`,import.meta.url),"utf8");
    assert.equal(source.includes('from "./capability-fixed-music-case.js"'),false);
  }
});
