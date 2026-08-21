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
- The partner-brand neural network may use a contained dark holographic canvas, matching the Second Brain visualization, while the surrounding homepage remains light and porcelain-toned.
- Partner-network rotation must pause only through its explicit control. Hovering a node or the canvas must never pause it, and the removed bottom status/instruction card must not be restored.
- Never use browser-native `alert`, `confirm`, or `prompt` dialogs. All confirmations and notices must use the shared porcelain-themed application dialog so typography, hierarchy, keyboard behavior, and mobile layout remain consistent across the website.
- Administrator filter bars must wrap into deliberate multi-row responsive grids before controls become cramped; action buttons, labels, pricing notes, and summary copy must never be clipped or forced into narrow character-by-character wrapping.
- The Web Agent creation-type selector contains only text, image, and video. `MiniMaxH3共享节点` is the first and default video model, with its full price formula visible in the model list; it must not reappear as a separate creation type.
- Every non-administrator paid image or video request must atomically reserve wallet balance with an idempotency key and auditable ledger entry, return the charged and remaining balance, and refund a failed task exactly once. Administrators remain exempt.
- Paid PearAPI image/video calls are balance-funded for every non-administrator, including standard and subscribed users; membership status must not bypass or replace the atomic balance reservation.
- A successful charged MiniMaxH3 shared-node task settles exactly once: 50% goes to the bound execution-node user and the remainder goes to the platform administrator wallet, with separate idempotent ledgers. Administrator-created H3 tasks are exempt from both charging and revenue sharing.
- MiniMaxH3 website tasks must stay linked to their originating Agent conversation. After claiming, the node reports `started` with an estimated total duration and then sends percentage progress updates; the conversation displays that progress until an idempotent assistant video result replaces it.
- Generated MiniMaxH3 output video is private and retained for exactly 24 hours from successful completion. Preview and download always use requester/admin authorization plus short-lived signed URLs, and both the Agent card and administrator detail show the exact expiry and deletion state.
- The Web Agent must show no magic-prompt button or web optimization state. It stores and queues the user's original Chinese H3 prompt unchanged. Only a compatible MiniMax H3 Fast Video desktop execution node may automatically compile it locally immediately before inference; the node preserves the original prompt for audit, returns the locally generated `compiled_prompt` in its authenticated `started` callback, and fails the task without starting H3 when local optimization fails. New tasks must not be assigned to nodes that do not advertise `local_prompt_optimization_v1`.
- Authorization-management copy controls must remain clickable. If an unused legacy activation record cannot decrypt its original code, copying may securely reissue that unused code; used or revoked legacy records must never be silently reissued.
- The embedded short-drama product must use the Gulong website as its only account UI: signed-in users enter the studio directly, while signed-out users see the website's `AccountModal`; never expose the short-drama app's own login or registration card inside the iframe.
