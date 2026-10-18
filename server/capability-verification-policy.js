export const CAPABILITY_VERIFICATION_POLICY = "capability-v2";

/** Server-owned, monotonic migration state. A v1 binding cannot regain legacy
 * admission by omitting an ID or changing request policy. Malformed v2 state
 * fails closed instead of treating a missing list as an empty migration. */
export function requiresAutomaticCapabilityVerification(binding, capabilityId) {
  if (binding?.autoVerificationPolicy === CAPABILITY_VERIFICATION_POLICY) {
    const ids = binding.autoVerificationCapabilityIds;
    return !Array.isArray(ids) || ids.some((id) => typeof id !== "string") || ids.includes(capabilityId);
  }
  return Boolean(binding?.autoVerificationEnrolledAt);
}
