// Run through the existing pinned deployment SSH channel. No public endpoint,
// object/setting writes, model calls, raw SDK errors or secret-valued output.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { inspectCapabilityUploadPolicy } from "../server/cos.js";

export const productionUploadOrigins = Object.freeze([
  "https://www.sologle.com", "https://sologle.com", "https://111.229.70.235",
]);
export async function inspectProductionUploadStorage(inspect = inspectCapabilityUploadPolicy) {
  try { return await inspect(productionUploadOrigins); }
  catch { return { schema: "shared-upload-policy-audit-v1", mode: "read_only", ready: false,
    versioning: "unavailable", browser_cors: "unavailable", origin_count: productionUploadOrigins.length,
    checked_at: new Date().toISOString(), object_writes: 0, bucket_policy_writes: 0,
    model_requests: 0, real_transfer_verified: false }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // An observation, not a deployment gate or automatic acceptance grant.
  console.log(JSON.stringify(await inspectProductionUploadStorage()));
}
