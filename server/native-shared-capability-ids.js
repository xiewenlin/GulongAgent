// These are independent executable consumers, not every installed runtime or
// model volume. Public sharing still requires an automatic exact-model proof.
export const NATIVE_SHARED_CAPABILITY_IDS = Object.freeze([
  "qwen_image_2_1.text_to_image", "qwen_image_2_1.multi_image_edit", "minimax_music_3.generate",
  "sam.video_track", "whisper.transcribe", "mediapipe.video_analysis",
]);
export const isNativeSharedCapability = (id) => NATIVE_SHARED_CAPABILITY_IDS.includes(id);
