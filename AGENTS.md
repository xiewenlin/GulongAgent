# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Locked product direction

- Visual target: `docs/design/selected-homepage-option-1.png` (玉瓷·东方算力).
- Preserve the ivory porcelain base, jade-green actions, pale-gold accents, restrained borders and shadows, and code-native light product UI.
- The first 1536 × 1024 viewport must contain the hero, 理解/组装/执行/进化 flow, and four-capability strip.
- Keep all theme variants light, calm, and legible; do not introduce gradients or a dark default theme.
