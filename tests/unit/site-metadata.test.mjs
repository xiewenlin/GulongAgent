import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedTitle = "古龙 Gulong Agent Engine｜让每个人都拥有自己的 AI 团队";

test("browser bookmarks and social previews use the Gulong product title", async () => {
  const [html, manifestSource, brandIcon] = await Promise.all([
    readFile(new URL("../../index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public/site.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../../public/assets/gulong-agent-icon.png", import.meta.url)),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.match(html, new RegExp(`<title>${expectedTitle}</title>`));
  assert.match(html, new RegExp(`property="og:title" content="${expectedTitle}"`));
  assert.match(html, new RegExp(`name="twitter:title" content="${expectedTitle}"`));
  assert.doesNotMatch(html, /AI Tool Finder|Discover the Best AI Tools/i);
  assert.equal((html.match(/\/assets\/gulong-agent-icon\.png\?v=20260826-gulong-icon-2/g) || []).length, 3);
  assert.match(html, /rel="apple-touch-icon" href="\/assets\/gulong-agent-icon\.png\?v=20260826-gulong-icon-2"/);
  assert.equal(manifest.name, expectedTitle);
  assert.equal(manifest.short_name, "古龙 Gulong Agent Engine");
  assert.equal(manifest.icons[0].src, "/assets/gulong-agent-icon.png?v=20260826-gulong-icon-2");
  assert.equal(manifest.icons[0].purpose, "any");
  assert.equal(createHash("sha256").update(brandIcon).digest("hex"), "73b803c8eb117b14527b43016adafee2845cabc45fa84b3d399c1f7c6eb698d4");
});

test("all website themes use the same Gulong Agent brand icon", async () => {
  const siteSource = await readFile(new URL("../../src/data/site.js", import.meta.url), "utf8");
  assert.equal((siteSource.match(/icon: "\/assets\/gulong-agent-icon\.png"/g) || []).length, 4);
  assert.doesNotMatch(siteSource, /gulong-theme-(?:yuci|sunrise|bamboo|iris)-3d-v2\.png/);
});
