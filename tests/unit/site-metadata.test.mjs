import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedTitle = "古龙 Gulong Agent Engine｜让每个人都拥有自己的 AI 团队";

test("browser bookmarks and social previews use the Gulong product title", async () => {
  const [html, manifestSource] = await Promise.all([
    readFile(new URL("../../index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public/site.webmanifest", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.match(html, new RegExp(`<title>${expectedTitle}</title>`));
  assert.match(html, new RegExp(`property="og:title" content="${expectedTitle}"`));
  assert.match(html, new RegExp(`name="twitter:title" content="${expectedTitle}"`));
  assert.doesNotMatch(html, /AI Tool Finder|Discover the Best AI Tools/i);
  assert.equal(manifest.name, expectedTitle);
  assert.equal(manifest.short_name, "古龙 Gulong Agent Engine");
});
