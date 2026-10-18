import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const SHA = /^[0-9a-f]{40}$/i;
function localGitHead(cwd) {
  if (!cwd) return null;
  try {
    const options = { cwd, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] };
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim();
    const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (normalize(top) !== normalize(cwd)) return null; // Never inherit an unrelated parent repository.
    return execFileSync("git", ["rev-parse", "HEAD"], options).trim();
  } catch { return null; }
}

export function resolveBuildCommit({ env = process.env, cwd, readGitHead = localGitHead } = {}) {
  let selected = null;
  for (const key of ["GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA", "GULONG_BUILD_COMMIT"]) {
    if (!env[key]) continue;
    assert.match(env[key], SHA, `${key} 不是有效的40位提交标识`);
    selected = env[key].toLowerCase();
    break;
  }
  const rawGit = readGitHead(cwd);
  const git = typeof rawGit === "string" && SHA.test(rawGit) ? rawGit.toLowerCase() : null;
  if (selected && git) assert.equal(selected, git, "构建环境提交与实际源码提交不一致，禁止发布");
  const commit = selected || git;
  if (!commit && (env.CI === "true" || env.GITHUB_ACTIONS === "true" || env.VERCEL_ENV === "production")) {
    throw new Error("生产构建缺少可验证的提交标识，禁止生成空版本发布清单");
  }
  return commit;
}

export function assertManifestIdentity(manifest, expected) {
  assert.match(String(expected || ""), SHA, "必须提供目标提交标识");
  assert.match(String(manifest?.commit || ""), SHA, "发布清单缺少有效提交标识");
  assert.equal(manifest.commit.toLowerCase(), expected.toLowerCase(), "发布产物不是目标源码提交，禁止发布");
  return manifest.commit.toLowerCase();
}
