# Design QA — 古龙网页版消息分栏与品牌白底

- source visual truth: 用户在 2026-08-26 明确指定“古龙头像和聊天内容居左，用户头像和聊天内容居右”，并要求所有古龙品牌图标统一使用白色背景。
- source brand asset path: `D:\openclaw\古龙智能体引擎\图标设计\古龙智能体.png`
- implementation desktop screenshot: `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\qa\web-agent-message-layout-desktop-final.png`
- implementation mobile screenshot: `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\qa\web-agent-message-layout-mobile-final.png`
- local preview URL: `http://127.0.0.1:4175/qa-web-agent.html`
- viewport: 1440 × 900 CSS px and 390 × 844 CSS px
- source pixels: supplied brand asset 1260 × 1260 px; layout source is a role-alignment specification rather than a raster mockup.
- implementation pixels: 1440 × 900 px desktop; 390 × 844 px mobile.
- density normalization: browser screenshots were captured at their CSS viewport size with the same production stylesheet and canonical brand PNG.
- state: 玉瓷浅色主题, representative assistant/user conversation, completed assistant response.

## Full-view comparison evidence

The desktop capture visibly separates the conversation roles: both Gulong avatar/reply groups begin on the left, while the user avatar and message bubble terminate on the right. The mobile capture preserves the same reading direction without horizontal overflow. All visible Gulong artwork sits on a pure white image/avatar background.

## Focused region comparison evidence

The two assistant avatar circles were inspected in both captures, including an icon URL carrying a theme query parameter. Both resolve to the same undistorted artwork with a white background. The user row uses the reverse grid order, while text inside each bubble remains naturally left-aligned for readability.

## Primary interactions and console checks

- Loaded the production CSS in a browser-rendered QA harness using the same message DOM classes as `WebAgentPage`.
- Checked desktop and the 760 px responsive breakpoint at 390 px width.
- Verified the browser console contained no warnings or errors.

## Required fidelity surfaces

- Fonts and typography: existing 18 px body copy, weights, and line heights are preserved; no small-text regression.
- Spacing and layout rhythm: 46 px desktop and 38 px mobile avatar tracks remain balanced; bubbles are capped at 960 px and align to their role edge.
- Colors and visual tokens: theme surfaces remain unchanged; only the canonical Gulong image background is forced to `#fff`.
- Image quality and asset fidelity: the supplied PNG is rendered with `object-fit: contain`, preserving the full circular artwork without crop or stretch.
- Copy and content: application copy is unchanged.

## Findings

No actionable P0, P1, or P2 visual differences remain.

## Open Questions

None.

## Implementation Checklist

- [x] Apply white background to every canonical Gulong brand image, including theme-query variants.
- [x] Keep functional icons unchanged.
- [x] Align assistant identity and message left.
- [x] Align user identity and message right.
- [x] Preserve the same role separation on mobile.
- [x] Add regression tests and browser screenshots.

## Comparison history

1. Initial desktop comparison passed for white image backgrounds and left/right role separation.
2. Initial 390 px capture found a P2 issue: the assistant completion badge compressed the message header.
3. The header was made wrap-aware and the mobile status badge received its own row.
4. The revised 390 px capture shows a readable status badge, stable role alignment, and no overflow.

## Follow-up Polish

None required for this scope.

final result: passed
