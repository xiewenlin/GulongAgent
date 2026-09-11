import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/deploy-production.yml", import.meta.url);
const deployScriptUrl = new URL("../../deploy/tencent/deploy-release.sh", import.meta.url);
const caddyUrl = new URL("../../deploy/tencent/Caddyfile", import.meta.url);
const parityScriptUrl = new URL("../../scripts/verify-production-parity.mjs", import.meta.url);
const vercelUrl = new URL("../../vercel.json", import.meta.url);
const appUrl = new URL("../../src/App.jsx", import.meta.url);

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
  assert.match(source, /cp -a shared "\$bundle\/shared"/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /curl --fail --silent --show-error[\s\S]*\/api\/health/);
  assert.match(source, /name: Verify Vercel and Tencent frontend parity[\s\S]*needs: \[vercel-production, tencent-production\]/);
  assert.match(source, /node scripts\/verify-production-parity\.mjs https:\/\/sologle\.com https:\/\/111\.229\.70\.235/);
  assert.match(source, /deploy\/tencent\/Caddyfile[\s\S]*\/tmp\/gulong-Caddyfile/);
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
  assert.match(source, /\.failed-\$\{commit_sha\}/);
  assert.match(source, /shared\/error-messages\.js/);
  assert.match(source, /mv -Tf "\$next_link" "\$current_link"/);
  assert.match(source, /health_check/);
  assert.match(source, /rollback/);
  assert.match(source, /mv -Tf "\$rollback_link" "\$current_link"/);
  assert.match(source, /Previous release restored successfully/);
  assert.match(source, /gulong-h3-maintenance\.timer/);
  assert.match(source, /OnUnitActiveSec=60s/);
  assert.match(source, /api\/cron\/h3-output-cleanup/);
  assert.match(source, /apply_caddy_config/);
  assert.match(source, /caddy validate --config "\$caddy_candidate"/);
  assert.match(source, /systemctl reload caddy/);
});

test("Tencent serves the SPA shell without stale caching and keeps hashed assets immutable", async () => {
  const source = await readFile(caddyUrl, "utf8");

  assert.match(source, /handle \/assets\/\*/);
  assert.match(source, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(source, /Cache-Control "no-store, max-age=0, must-revalidate"/);
  assert.match(source, /Pragma "no-cache"/);
  assert.match(source, /try_files \{path\} \/index\.html/);
});

test("Vercel never caches the deployment identity while preserving immutable assets", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8"));
  const deploymentHeader = config.headers.find((entry) => entry.source === "/deployment-manifest.json");
  const assetHeader = config.headers.find((entry) => entry.source === "/assets/(.*)");

  assert.equal(deploymentHeader?.headers?.find((entry) => entry.key === "Cache-Control")?.value, "no-store, max-age=0, must-revalidate");
  assert.equal(assetHeader?.headers?.find((entry) => entry.key === "Cache-Control")?.value, "public, max-age=31536000, immutable");
});

test("production parity verifier checks manifests, commit identity, and every client hash", async () => {
  const source = await readFile(parityScriptUrl, "utf8");

  assert.match(source, /deployment-manifest\.json/);
  assert.match(source, /assert\.deepEqual\(tencentManifest, vercelManifest/);
  assert.match(source, /manifest\.commit, expectedCommit/);
  assert.match(source, /sha256\(vercelBytes\)/);
  assert.match(source, /sha256\(tencentBytes\)/);
});

test("long-lived browser sessions detect a newer dual-target deployment without discarding drafts", async () => {
  const source = await readFile(appUrl, "utf8");

  assert.match(source, /deployment-manifest\.json\?check=/);
  assert.match(source, /cache:\s*"no-store"/);
  assert.match(source, /window\.setInterval\(checkDeploymentVersion,\s*30_000\)/);
  assert.match(source, /当前输入内容不会被自动打断/);
  assert.match(source, /立即刷新/);
  assert.doesNotMatch(source, /nextCommit[\s\S]{0,120}window\.location\.reload\(\)/);
});
