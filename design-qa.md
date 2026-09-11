# Short Drama Native Showcase Design QA

- Source visual truth path: `http://127.0.0.1:1432/` (Codex in-app Browser tab 2, DramaSoul 0.3.16 browser demo, example project `雾港来信`, infinite-canvas state).
- Implementation screenshot path: `http://127.0.0.1:4173/short-drama` (Codex in-app Browser tab 3, local Gulong website, `雾港来信`, infinite-canvas and pipeline states).
- Viewport: 1280 × 720 CSS pixels.
- Source pixels: 1280 × 720; implementation pixels: 1280 × 720; device scale factor: 1; no density normalization required.
- State: light theme, signed out, native short-drama feature showcase, sample project loaded.

**Full-view comparison evidence**

- The implementation preserves the source hierarchy: compact workbench header, project context, search and view switch, left workflow rail, central canvas, right node inspector, and bottom runtime strip.
- The native website intentionally adds a product hero, value strip, plain-language process cards, and Gulong calls to action around the source workbench. These are website-context additions rather than fidelity drift.
- The source sage-green system is translated into the existing Gulong porcelain tokens: ivory background, jade actions, pale-gold stage accents, restrained borders, and light shadows.

**Focused region comparison evidence**

- Workbench header: project name, infinite-canvas label, project control, demo status, and connection status align with the source anatomy.
- Canvas: vertically connected source, screenplay, visual-asset branches, shot task, and batch-generation nodes retain the source card density, selection border, progress, and activity feedback.
- Inspector: icon, stage label, title, status, progress, current output, node explanation, and continuation guidance match the source information order.
- Stage-list mode was opened and inspected; it preserves the same workflow data while providing a compact alternate reading mode.

**Findings**

- No remaining P0, P1, or P2 visual or interaction findings.

**Comparison history**

1. First pass found two P2 issues: the inspector progress track rendered as an oversized round block because its inline container did not establish a fixed box, and the final stage label was clipped in the workflow rail. The hero headline also wrapped one character before the intended line break at 1280 px.
2. Fixed by block-formatting the progress track at full width, shortening only the rail label to `批量生成`, and reducing the responsive hero display size while retaining the complete node title.
3. Post-fix capture at the same viewport shows a normal five-pixel progress track, an unbroken workflow label, and a clean two-line hero. No additional P0/P1/P2 issue was visible.

**Required fidelity surfaces**

- Fonts and typography: website font stack retained; body and control copy remain at least 18 px, with clear 18–29 px workbench hierarchy and a responsive hero display size.
- Spacing and layout rhythm: source three-column workbench proportions are preserved; 22–30 px radii and restrained elevations match the porcelain website system.
- Colors and visual tokens: all new UI uses the existing theme variables so 玉瓷、日出、青竹、鸢尾 remain compatible; no dark embedded surface remains.
- Image quality and asset fidelity: the source workbench is predominantly code-native UI and iconography; matching Phosphor icons are used, with no placeholder images or fake external screenshots.
- Copy and content: every stage is explained in plain Chinese, and the page explicitly states that this is a website-native demonstration that does not execute real generation.

**Primary interactions tested**

- Hero button scrolls to the example workbench.
- Infinite canvas / stage list switch works.
- Search for `灯塔` selects `旧港灯塔 · 雨夜` in the inspector.
- Project menu, workflow-stage selection, full-view reset, and node selection render interactive controls.
- DOM contains zero iframes and zero links to the former external Vercel short-drama project.
- Browser console error count: 0.

**Implementation checklist**

- [x] Replace the external iframe with a native website route.
- [x] Recreate the source workflow anatomy and sample project.
- [x] Add working search, view switch, project menu, stage selection, and node inspection.
- [x] Preserve the Gulong light theme and 18 px text floor.
- [x] Verify the rendered page in the in-app browser.

**Follow-up polish**

- P3: future production data can replace the sample project without changing the current page anatomy.

final result: passed
