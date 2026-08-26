# Design QA — 统一古龙品牌图标

- source visual truth path: `D:\openclaw\古龙智能体引擎\图标设计\古龙智能体.png`
- implementation screenshot path: `C:\Users\YCAI\AppData\Local\Temp\gulong-sites-v52.png`
- production URL: `https://gulong-agent-official-2026.wellonxie.chatgpt.site`
- viewport: 1200 × 750 CSS px
- source pixels: 1260 × 1260 px
- implementation pixels: 1200 × 750 px
- density normalization: source icon was inspected at original density; implementation was reviewed at the deployed screenshot's native density.
- state: 玉瓷浅色主题、官网首页、未登录。

## Full-view comparison evidence

The deployed header brand mark, hero product preview logo, and assistant avatar visibly use the supplied rainbow 3D dragon neural-network artwork. The transparent source background remains clean on the light theme, and the square artwork keeps its proportions inside circular icon masks without stretching.

## Focused region comparison evidence

The header's 48 px brand slot and the product preview's larger avatar slot were checked in the same deployed capture. Both preserve the source artwork's central dragon, rainbow network halo, and transparent edge treatment. No placeholder, old theme-specific icon, or distorted crop remains in these visible brand locations.

## Required fidelity surfaces

- Fonts and typography: unchanged; the icon replacement does not alter the established 18 px body typography.
- Spacing and layout rhythm: existing icon containers retain their dimensions and alignment; no header or preview reflow is visible.
- Colors and visual tokens: the full rainbow artwork remains legible against the porcelain light background while theme color tokens remain unchanged.
- Image quality and asset fidelity: the exact supplied PNG is copied byte-for-byte and rendered with preserved aspect ratio.
- Copy and content: unchanged.

## Findings

No actionable P0, P1, or P2 visual differences were found for the requested brand-icon replacement.

## Open Questions

None.

## Implementation Checklist

- [x] Use one canonical brand asset for all four themes.
- [x] Replace header, footer, login, home preview, assistant avatar, download card, favicon, and PWA icon sources.
- [x] Preserve functional action icons for usability.
- [x] Verify production asset responses and deployment capture.

## Comparison history

Initial production comparison passed; no visual correction iteration was required.

## Follow-up Polish

None required for this scope.

final result: passed
