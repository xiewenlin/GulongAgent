import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createNativeMusicBusinessProbe, createNativeCapabilityVerificationAdapters } from "../../server/capability-native-verification.js";

// Constructor/validator checks only: synthetic media receipts stay in memory.
// No challenge is issued, budget reopened, model called or file fixture made.
const hash = value => createHash("sha256").update(value).digest("hex");
function fixture(patch = {}) {
  const inventory = { capabilityId: "minimax_music_3.generate", capabilityVersion: "3", asrLanguages: ["en", "zh"] };
  const model = { id: "MiniMax-Music3", max_duration_seconds: 11.993106575963719 };
  const spec = { inventory, model, lyrics: "晨光照亮小河\n微风陪我唱歌", durationSeconds: 11, seed: 108533201, ...patch };
  const probe = createNativeMusicBusinessProbe(spec);
  const audio = { role: "primary_audio", contentType: "audio/flac", bytes: 1234, sha256: "c".repeat(64), durationSeconds: 11, sampleRate: 44100 };
  let inspections = 0;
  const adapter = createNativeCapabilityVerificationAdapters({ verifyMediaOutputs: async () => { inspections++; return [audio]; } })[inventory.capabilityId];
  const challenge = { capabilityId: inventory.capabilityId, capabilityVersion: inventory.capabilityVersion, inventory: spec.inventory, model: spec.model,
    parameters: probe.parameters, language: probe.language, probeOutputRules: probe.outputRules };
  const inlineResult = { model: model.id, lyric_verification: { algorithm: "ordered-whole-lyrics-v1", full_audio: true, language: "zh",
    audio_sha256: audio.sha256, lyrics_sha256: hash(probe.parameters.lyrics), transcript: probe.parameters.lyrics } };
  const args = { challenge, inlineResult, outputs: [{ output_id: "memory-only-native-audio" }] };
  return { spec, probe, audio, adapter, args, get inspections() { return inspections; } };
}

test("an explicit Chinese native case preserves two whole lyrics, integer duration, seed and one generation/whole-ASR budget", () => {
  const f = fixture();
  assert.equal(f.probe.language, "zh"); assert.equal(f.probe.probeKind, "native-music");
  assert.equal(f.probe.parameters.lyrics, f.spec.lyrics); assert.equal(f.probe.parameters.seed, 108533201);
  assert.equal(f.probe.parameters.duration_seconds, 11); assert.equal(f.probe.parameters.language, "auto");
  assert.deepEqual(f.probe.budget, { max_inferences: 1, max_output_tokens: 0, max_audio_seconds: 11, max_asr_passes: 1 });
  assert.equal(f.probe.business_admission, undefined); assert.equal(f.probe.fixed_case_only, undefined);
  assert.equal(f.probe.execute_once, undefined); assert.equal(f.inspections, 0);
});

test("Chinese case construction rejects the wrong native identity, unavailable zh and invented or excessive parameters", () => {
  const valid = fixture().spec;
  for (const patch of [
    { inventory: { ...valid.inventory, capabilityId: "gulong_engine.music" } },
    { inventory: { ...valid.inventory, capabilityVersion: "unknown" } },
    { inventory: { ...valid.inventory, asrLanguages: ["en"] } }, { model: { ...valid.model, id: "alias" } },
    { durationSeconds: 12 }, { durationSeconds: 11.5 }, { durationSeconds: 9 }, { durationSeconds: 13 },
    { model: { ...valid.model, max_duration_seconds: 10 }, durationSeconds: 11 },
    { model: { ...valid.model, max_duration_seconds: 301 } },
    { seed: undefined }, { seed: "108533201" }, { seed: -1 }, { seed: 0x80000000 },
    { lyrics: "Blue sky\nSilver river" }, { lyrics: "只有一行" }, { lyrics: "三行\n中文\n歌词" },
    { lyrics: "中文\n" }, { lyrics: "中文\r\n歌词" }, { lyrics: "中".repeat(41) + "\n歌词" },
  ]) assert.throws(() => createNativeMusicBusinessProbe({ ...valid, ...patch }));
});

test("a Chinese proof reports only the actual validated zh scope and never inherits English or another duration", async () => {
  const f = fixture(), result = await f.adapter.validateResult(f.args);
  assert.deepEqual(result.asrLanguages, ["zh"]); assert.equal(result.verifiedModel.id, "MiniMax-Music3");
  assert.equal(result.verifiedModel.max_duration_seconds, 11); assert.equal(result.verifiedModel.sample_rate, 44100);
  assert.equal(result.contractTests.whole_audio_asr, true); assert.equal(result.contractTests.exact_native_scope, true);
  assert.equal(f.inspections, 1);
  f.audio.durationSeconds = 10.993;
  assert.equal((await f.adapter.validateResult(f.args)).verifiedModel.max_duration_seconds, 10.993);
});

test("English legacy challenges cannot turn a Chinese result into a zh admission and changed inventory fails before inspection", async () => {
  const f = fixture(); delete f.args.challenge.language;
  await assert.rejects(f.adapter.validateResult(f.args));
  const g = fixture(); g.args.challenge.inventory = { ...g.args.challenge.inventory, asrLanguages: ["en"] };
  await assert.rejects(g.adapter.validateResult(g.args)); assert.equal(g.inspections, 0);
  g.args.challenge.language = "auto";
  await assert.rejects(g.adapter.validateResult(g.args)); assert.equal(g.inspections, 0);
});

test("Chinese result checking requires complete original lyrics, matching full audio digest, exact language and bounded real duration", async () => {
  for (const change of [
    f => { f.args.inlineResult.lyric_verification.language = "en"; },
    f => { f.args.inlineResult.lyric_verification.transcript = "晨光照亮小河"; },
    f => { f.args.inlineResult.lyric_verification.transcript = "微风陪我唱歌晨光照亮小河"; },
    f => { f.args.inlineResult.lyric_verification.full_audio = false; },
    f => { f.args.inlineResult.lyric_verification.audio_sha256 = "d".repeat(64); },
    f => { f.args.inlineResult.lyric_verification.lyrics_sha256 = "d".repeat(64); },
    f => { f.audio.durationSeconds = 10.8; }, f => { f.audio.durationSeconds = 11.2; },
    f => { f.audio.sampleRate = 48000; }, f => { f.args.challenge.model.max_duration_seconds = 10; },
  ]) { const f = fixture(); change(f); await assert.rejects(f.adapter.validateResult(f.args)); }
});

test("the constructor does not select itself or change the existing English issuance path", () => {
  const f = fixture();
  const original = f.adapter.createProbe({ inventory: f.spec.inventory, model: { ...f.spec.model, max_duration_seconds: 300 }, nonce: "memory-nonce-only" });
  assert.equal(original.parameters.duration_seconds, 12); assert.match(original.parameters.lyrics, /^Blue sky/);
  assert.equal(original.language, undefined); assert.equal(original.parameters.lyrics.includes("晨光"), false);
  assert.equal(f.inspections, 0);
});

test("future English issuance also respects the real model ceiling rather than requesting twelve above 11.993 seconds", () => {
  const f = fixture(), limited = f.adapter.createProbe({ inventory: f.spec.inventory, model: f.spec.model, nonce: "memory-nonce-only" });
  assert.equal(limited.parameters.duration_seconds, 11); assert.equal(limited.budget.max_audio_seconds, 11);
  assert.equal(limited.parameters.lyrics.startsWith("Blue sky"), true); assert.equal(limited.language, undefined);
});
