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

test("web agent scrolls to the latest message only once and renders replies below their workflow", async () => {
  const source = await readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8");
  assert.match(source, /const streamRef = useRef\(null\);/);
  assert.match(source, /const initialScrollDoneRef = useRef\(false\);/);
  assert.match(source, /if \(!initialScrollDoneRef\.current\)[\s\S]*?initialScrollDoneRef\.current = true;[\s\S]*?stream\.scrollTop = stream\.scrollHeight;/);
  assert.match(source, /className="agent-chat-stream" aria-live="polite" ref=\{streamRef\}/);
  assert.doesNotMatch(source, /scrollIntoView\(\{ behavior: "smooth", block: "nearest" \}\)/);
  assert.doesNotMatch(source, /\[messages, sending\]/);

  const workflowIndex = source.indexOf("<WorkflowTrace workflow={item.workflow} />");
  const replyIndex = source.indexOf("<MarkdownMessage>{item.content}</MarkdownMessage>");
  assert.ok(workflowIndex >= 0 && replyIndex > workflowIndex, "assistant reply must render below its workflow trace");
});

test("web agent uses one page scrollbar and a collapsible centered composer", async () => {
  const [css, source] = await Promise.all([
    readFile(new URL("../../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/WebAgentPage.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(source, /const \[composerOpen, setComposerOpen\] = useState\(true\);/);
  assert.match(source, /composerOpen \? <section className=\{`agent-composer-wrap agent-floating-composer \$\{isH3Video \? "h3-desktop-composer" : ""\}`\}/);
  assert.match(source, /className=\{`agent-composer-orb \$\{sending \? "working" : ""\}`\}/);
  assert.match(source, /aria-label="收起创作输入框"/);
  assert.match(source, /aria-label="展开古龙创作输入框"/);
  assert.match(source, /aria-label="拓展技能" title="拓展技能"/);
  assert.match(source, /aria-label="剩余用量" title="剩余用量"/);
  assert.match(css, /\.agent-chat-stream\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.match(css, /\.agent-floating-composer\s*\{[^}]*position:\s*fixed;[^}]*top:\s*50%;[^}]*left:\s*50%;[^}]*width:\s*min\(66\.666vw, 1440px\);/s);
  assert.match(css, /\.agent-composer-wrap\.h3-desktop-composer \.agent-h3-prompt-wrap > textarea\s*\{[^}]*min-height:\s*350px;/s);
  assert.match(source, /H3_VIDEO_MODES/);
  assert.match(source, /H3_VIDEO_RESOLUTIONS/);
  assert.match(source, /H3_SAMPLING_STEPS/);
  assert.match(source, /超长视频生产方式/);
  assert.match(source, /导入 TXT（空行分段）/);
  assert.match(source, /segment_duration_seconds: h3VideoMode === "extended" \? h3SegmentDuration/);
  assert.match(source, /isH3Video \? <div className="agent-h3-composer-title"/);
  assert.match(source, /video_mode: h3VideoMode/);
  assert.match(source, /sampling_steps: h3SamplingSteps/);
  assert.match(source, /seed: h3SeedValue/);
  assert.match(css, /\.agent-composer-wrap textarea\s*\{[^}]*min-height:\s*216px;/s);
  assert.match(css, /\.agent-workspace-intro\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(css, /\.agent-home-cluster\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.agent-topbar nav button span\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.agent-model-select\s*\{[^}]*flex:\s*1 1 calc\(100% - 56px\);[^}]*order:\s*2;/s);
});
