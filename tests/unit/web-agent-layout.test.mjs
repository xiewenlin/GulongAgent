import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Gulong brand artwork always renders on a white background", async () => {
  const css = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /img\[src\*="\/assets\/gulong-agent-icon\.png"\]\s*\{[^}]*background:\s*#fff;/s);
  assert.match(css, /\.agent-message-avatar img\s*\{[^}]*object-fit:\s*contain;[^}]*background:\s*#fff;/s);
  assert.match(css, /\.agent-message\.assistant \.agent-message-avatar\s*\{[^}]*background:\s*#fff;/s);
});

test("web agent aligns Gulong replies left and user messages right", async () => {
  const [css, source] = await Promise.all([
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /className=\{`agent-message \$\{item\.role\}`\}/);
  assert.match(css, /\.agent-message\s*\{[^}]*grid-template-columns:\s*46px minmax\(0, 1fr\);/s);
  assert.match(css, /\.agent-message\.user\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 46px;/s);
  assert.match(css, /\.agent-message\.user \.agent-message-avatar\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*end;/s);
  assert.match(css, /\.agent-message\.user > div:last-child\s*\{[^}]*grid-column:\s*1;[^}]*justify-self:\s*end;/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.agent-message\.user\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 38px;/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.agent-message header em\s*\{[^}]*flex-basis:\s*100%;/s);
});
