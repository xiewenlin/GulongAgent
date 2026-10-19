import { readFileSync } from "node:fs";

// Literal traced paths ensure production contains the exact source assets.
const jpeg = () => readFileSync(new URL("./probe-fixtures/nasa-pose-source.jpg", import.meta.url));
const clip = () => readFileSync(new URL("./probe-fixtures/pose-16frames.mp4", import.meta.url));
const audio = () => readFileSync(new URL("./probe-fixtures/jfk.flac", import.meta.url));
export const POSE_IMAGE_FIXTURE = Object.freeze({ fixture_id: "nasa-kibo-pose-image-v1", role: "reference_image",
  filename: "nasa-pose-source.jpg", content_type: "image/jpeg", bytes: 127056,
  sha256: "bf68496dd810ed43df4ef8a68008b22fada9800b56eb90e6bf7cc8d15c39ae7d" });
export const POSE_VIDEO_FIXTURE = Object.freeze({ fixture_id: "nasa-kibo-pose-clip-v1", role: "source_video",
  filename: "pose-16frames.mp4", content_type: "video/mp4", bytes: 62832,
  sha256: "3a2af643f2723ed16b0240a8d4e416b256d499320f143233a50ad89a6dfcd293" });
export const WHISPER_AUDIO_FIXTURE = Object.freeze({ fixture_id: "whisper-jfk-11s-v1", role: "media",
  filename: "jfk.flac", content_type: "audio/flac", bytes: 1152693,
  sha256: "63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715" });
export const CAPABILITY_PROBE_FIXTURES = Object.freeze([
  { descriptor: POSE_IMAGE_FIXTURE, read: jpeg }, { descriptor: POSE_VIDEO_FIXTURE, read: clip },
  { descriptor: WHISPER_AUDIO_FIXTURE, read: audio },
]);
