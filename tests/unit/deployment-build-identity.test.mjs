import assert from "node:assert/strict";
import test from "node:test";
import { assertManifestIdentity, resolveBuildCommit } from "../../scripts/deployment-build-identity.mjs";
const SHA = "a".repeat(40), OTHER = "b".repeat(40);
const resolve = (env, git = null) => resolveBuildCommit({ env, cwd: "unused", readGitHead: () => git });

test("build identity survives Vercel child environments without GITHUB_SHA", () => {
  assert.equal(resolve({ GITHUB_SHA: SHA }), SHA);
  assert.equal(resolve({ VERCEL_GIT_COMMIT_SHA: SHA, VERCEL_ENV: "production" }), SHA);
  assert.equal(resolve({ GULONG_BUILD_COMMIT: SHA, CI: "true" }), SHA);
  assert.equal(resolve({ VERCEL_ENV: "production" }, SHA), SHA);
  assert.equal(resolve({}, SHA.toUpperCase()), SHA);
  assert.equal(resolve({}), null, "unregistered local-only previews may still have no source commit");
});

test("production identity fails closed for missing, malformed or conflicting source metadata", () => {
  for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }, { VERCEL_ENV: "production" }]) assert.throws(() => resolve(env));
  assert.throws(() => resolve({ GITHUB_SHA: "not-a-commit" }, SHA));
  assert.throws(() => resolve({ GITHUB_SHA: SHA }, OTHER));
  assert.equal(resolve({ GITHUB_SHA: SHA, VERCEL_GIT_COMMIT_SHA: OTHER }, SHA), SHA, "the exact GitHub checkout wins over inherited Vercel metadata");
});

test("prepublish verifier rejects a null or wrong commit rather than publishing an untraceable artifact", () => {
  assert.equal(assertManifestIdentity({ commit: SHA }, SHA), SHA);
  for (const commit of [null, undefined, "", "HEAD", OTHER]) assert.throws(() => assertManifestIdentity({ commit }, SHA));
  assert.throws(() => assertManifestIdentity({ commit: SHA }, ""));
});
