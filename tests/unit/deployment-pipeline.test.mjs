import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/deploy-production.yml", import.meta.url);
const deployScriptUrl = new URL("../../deploy/tencent/deploy-release.sh", import.meta.url);

test("production workflow gates both hosting targets behind tests and an immutable build", async () => {
  const source = await readFile(workflowUrl, "utf8");

  assert.match(source, /npm test/);
  assert.match(source, /npm run build/);
  assert.match(source, /npm run test:sites/);
  assert.match(source, /name: Deploy Vercel production[\s\S]*needs: quality/);
  assert.match(source, /name: Deploy Tencent Cloud production[\s\S]*needs: quality/);
  assert.equal((source.match(/if: github\.ref == 'refs\/heads\/main'/g) || []).length, 2);
  assert.match(source, /vercel@50\.28\.0 deploy --prebuilt --prod/);
  assert.match(source, /StrictHostKeyChecking=yes/g);
  assert.match(source, /rsync --archive --compress --checksum --delete/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /curl --fail --silent --show-error[\s\S]*\/api\/health/);
  assert.doesNotMatch(source, /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});

test("Tencent deployment validates its target and rolls back an unhealthy activation", async () => {
  const source = await readFile(deployScriptUrl, "utf8");

  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(source, /release_root="\/opt\/gulong\/releases"/);
  assert.match(source, /mode="\$\{1:-\}"/);
  assert.match(source, /\.staging-\$commit_sha/);
  assert.match(source, /tr -d '\\r'/);
  assert.match(source, /npm_config_cache="\$stage\/\.npm-cache"/);
  assert.match(source, /mv -Tf "\$next_link" "\$current_link"/);
  assert.match(source, /health_check/);
  assert.match(source, /rollback/);
  assert.match(source, /mv -Tf "\$rollback_link" "\$current_link"/);
  assert.match(source, /Previous release restored successfully/);
});
