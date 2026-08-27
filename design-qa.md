# MiniMax H3 网页创作窗 Design QA

- source visual truth path: `C:\Users\YCAI\AppData\Local\Temp\codex-clipboard-3aeef378-4f97-414d-af4c-9ce1f00b280d.png`
- implementation screenshot path: `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\design-qa-h3-final-1440x960.png`
- combined comparison path: `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\design-qa-h3-comparison.png`
- focused states: `artifacts/design-qa-h3-assets-1440x960.png`, `artifacts/design-qa-h3-duration-1440x960.png`, `artifacts/design-qa-h3-extended-1440x960.png`, `artifacts/design-qa-h3-mobile-390x844.png`
- viewport: 1440 × 960 desktop target; browser content viewport 1425 × 950; 390 × 844 mobile resilience check
- source pixels: 982 × 525 at source density
- implementation pixels: 1425 × 950 at device scale factor 1
- normalization: comparison board scales the source proportionally to 1424 × 761 and keeps the implementation at 1424 × 950; browser chrome is excluded
- state: authenticated administrator mock, 视频类型, MiniMaxH3共享节点, empty prompt, no attachments

## Full-view comparison evidence

The source screenshot shows a narrow composer where “多模态素材” collapses into a vertical word stack and hides most generation parameters. The final implementation uses exactly two thirds of the configured 1440 px desktop CSS viewport (959.98 px), keeps the dialog centered, gives the prompt editor a 350 px minimum height, and presents all desktop-generation parameters in a stable two-row rail without clipping. The page scrollbar reduces `documentElement.clientWidth` to 1425 px but does not alter the requested viewport-relative width.

## Focused region comparison evidence

- Reference assets: the compact “参考素材” control opens a 3-column image/video/audio picker; it can expand to a 2-column thumbnail grid and remains scrollable without changing the composer geometry.
- Duration: the 1–15 second control opens a separate range/number/quick-value panel above the toolbar and does not cover the send or model controls.
- Long-form mode: selecting “超长视频” reveals the desktop-matched “连续成片 / 批量短片” strategy, blank-line prompt segmentation, per-segment duration, total-duration summary and TXT import without widening or clipping the composer.
- Mobile: at 390 × 844, the editor and controls become a full-width stacked layout; no horizontal clipping or vertically stacked label characters are visible.
- Interactions: video mode, aspect ratio, resolution, sampling steps, seed, duration, asset panel and the existing magic switch were exercised. The console contained no warning or error entries.

## Required fidelity surfaces

- Fonts and typography: retains the product’s existing font stack and 18 px minimum UI text; headings remain 20 px; no clipped or vertical Chinese labels.
- Spacing and layout rhythm: centered 2/3-width frame, 76 px title band, 350 px editor, 72 px parameter rail, consistent 8–18 px gaps and existing 11–22 px radii.
- Colors and visual tokens: all surfaces, borders, focus indicators and active states use the existing theme tokens; no new hard-coded dark theme.
- Image quality and asset fidelity: existing Phosphor icons and real file thumbnails are reused; no placeholder imagery, handcrafted SVG, emoji or CSS illustration was introduced.
- Copy and content: desktop parameter names and options are present; website-only “魔法优化” is retained; “优化提示词”和“预览提示词” buttons are not implemented.

## Comparison history

1. P1 layout failure: source state compressed the asset label vertically and exposed only a subset of H3 parameters.
   - Fix: widened the desktop composer to 66.666vw, introduced the desktop-style title/editor/asset popover/parameter rail, and added full mode, ratio, resolution, sampling, duration and seed controls.
   - Post-fix evidence: `artifacts/design-qa-h3-desktop-1440x960.png`; all controls are visible and the vertical label failure is gone.
2. P2 polish issue: first focused-state capture showed the browser’s default black focus outline around `summary` controls.
   - Fix: replaced mouse focus styling with the existing theme border and preserved a brand-color `:focus-visible` ring for keyboard accessibility.
   - Post-fix evidence: `artifacts/design-qa-h3-final-1440x960.png`; no black outline remains in the idle state.

## Findings

No actionable P0, P1 or P2 differences remain. The desktop design preserves the current website theme while matching the current MiniMax H3 desktop parameter model. Responsive deviations on tablet and mobile are intentional usability adaptations.

## Primary interactions tested

- Switch from text to video and select MiniMaxH3共享节点
- Select smart multiframe, 16:9, 1080P and 8 sampling steps
- Enter seed 20260827
- Open/close reference asset and duration panels
- Enable the existing magic optimization switch
- Select long-form generation, enter three blank-line-separated prompt segments and verify a 15-second computed total
- Verify the computed width is 959.98 px in a 1440 px configured viewport (66.665%); the 15 px page scrollbar is outside that CSS viewport calculation
- Check browser console warnings and errors: none

final result: passed
