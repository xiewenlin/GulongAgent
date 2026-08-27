# MiniMax H3 网页创作窗 Design QA

- source visual truth paths:
  - `C:\Users\YCAI\AppData\Local\Temp\codex-clipboard-82dc43f2-5b00-4f2c-ad5f-8982b51a14cb.png`
  - `C:\Users\YCAI\AppData\Local\Temp\codex-clipboard-93a049cb-4569-4c3b-ba6a-ed7f0bfdae51.png`
- implementation screenshot paths:
  - `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\design-qa-h3-inline-controls-full-1920x1080.png`
  - `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\design-qa-h3-inline-controls-full-1440x960.png`
- combined comparison path: `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\design-qa-h3-inline-controls-comparison.png`
- viewport: 1920 × 1080 primary desktop; 1440 × 960 responsive desktop
- source pixels: 1319 × 641 for the broken layout; 925 × 273 for the target upload-card detail
- implementation pixels: 1905 × 1072 and 1425 × 950 at device scale factor 1; browser scrollbar width is excluded from the captured content width
- normalization: the comparison board crops the 1920 implementation to the 1280 × 533 dialog rectangle and scales each source panel into a fixed 1280 px review width; browser chrome is excluded
- state: authenticated administrator mock, 视频类型, MiniMaxH3共享节点, empty prompt, no attachments, magic optimization disabled by default

## Full-view comparison evidence

The broken source state placed the reference-material control at the lower-left edge of the editor and wrapped the model selector onto a second footer row. The implementation now places a dashed, icon-led “参考素材” upload card in the upper-left of the prompt editor, keeps “魔法优化” centered inside the editor at the bottom, and keeps type, video mode, aspect ratio, resolution, sampling steps, duration, seed, model and send controls on one continuous parameter rail.

At the 1920 px primary viewport every parameter remains fully separated and vertically aligned. At 1440 px the rail measures 958 px with `scrollWidth === clientWidth` and `flex-wrap: nowrap`; longer native select values use intentional ellipsis instead of overlapping, wrapping or hiding controls. This is consistent with the reference treatment of the long model name.

## Focused region comparison evidence

- Reference assets: the target detail uses a square dashed upload card with a raised upload icon and label. The implementation reproduces this visual hierarchy at 104 × 96 px and places it at 16 px from the editor’s top-left edge.
- Magic switch: the existing functional toggle is repositioned at the horizontal center and 14 px above the editor bottom. Its pressed state, tooltip, hover treatment and accessible name remain intact.
- Parameter rail: all nine primary controls stay in one row at 1920 and 1440. At 1440 the measured rail is 958/958 px client/scroll width, so no persistent control is clipped outside the dialog.
- Reference-material interaction: opening the upload card displays the existing image/video/audio picker and closing it restores the clean editing surface without reflowing the footer.
- Extended video mode: ten controls remain on one line at 1440 with 958/958 px client/scroll width.
- Console: the browser console contained no warning or error entries after reload, video selection, material-panel open/close, magic-toggle activation and extended-mode selection.

## Required fidelity surfaces

- Fonts and typography: the product’s existing font stack and 18 px minimum control text are retained; labels remain horizontal and readable. Long model/sampling values truncate only inside their native select control at narrower desktop widths.
- Spacing and layout rhythm: the 2/3-width centered dialog is preserved; the 16 px upload-card inset, 14 px magic-switch bottom inset, 6 px desktop control gap and 68 px footer form one clear editor-to-parameter rhythm.
- Colors and visual tokens: dashed borders, surfaces, text, active states, shadows and focus rings continue to use the current light-theme variables; no dark or hard-coded foreign palette was introduced.
- Image quality and asset fidelity: the visible upload glyph uses the existing Phosphor `UploadSimple` icon rather than CSS art, emoji or a raster placeholder. Existing real attachment thumbnails remain unchanged.
- Copy and content: “参考素材” and “魔法优化” are preserved; all H3 parameter names and values remain available and the original task placeholder still explains `@图片1`、`@视频1`、`@音频1` references.
- Accessibility and interaction: controls remain semantic buttons/selects, the magic switch exposes `aria-pressed`, keyboard focus-visible styling is retained, and the mobile rail stays horizontally reachable rather than vertically stacking Chinese labels.

## Comparison history

1. P1 layout mismatch: the asset entry sat at the editor bottom and the footer wrapped the model/send controls onto a second row.
   - Fix: moved the material summary into a target-style dashed top-left upload card, moved the magic toggle into the editor bottom center, and converted the footer to a no-wrap adaptive flex rail.
   - Post-fix evidence: `artifacts/design-qa-h3-inline-controls-comparison.png`; all persistent controls are visible on one row and the upload card matches the supplied target hierarchy.
2. P2 responsive risk: the first layout calculation could over-constrain long labels below 1600 px.
   - Fix: introduced proportional flex bases, compact gaps/padding and icon suppression below 1600 px while preserving 18 px text; long native select values use ellipsis.
   - Post-fix evidence: `artifacts/design-qa-h3-inline-controls-full-1440x960.png`; rail client and scroll widths are both 958 px and no controls wrap or overlap.

## Findings

No actionable P0, P1 or P2 differences remain. The implementation preserves the current website theme while adopting the target upload-card composition and the requested single-row parameter layout. Select-value ellipsis at narrower desktop widths is an expected responsive constraint and does not hide any parameter control.

## Primary interactions tested

- Switch from text to video and load MiniMaxH3共享节点
- Open and close the reference-material picker
- Toggle magic optimization and verify `aria-pressed=true`
- Select extended video mode and verify all ten controls remain in one row
- Measure 1440 px rail geometry: 958 px client width, 958 px scroll width, `nowrap`
- Check browser console warnings and errors: none

final result: passed
