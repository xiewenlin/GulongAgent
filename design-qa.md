# Design QA — 古龙网页版 H3 多参考素材与对话区高度

- source visual truth: 用户要求移除独立的“@ 引用素材”行，恢复最多 9 张参考图，保证每张缩略图清晰可辨且界面不混乱，并把网页版对话框高度增加 3/5。
- implementation desktop screenshot: `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\qa\web-agent-h3-assets-desktop-final.png`
- implementation mobile screenshot: `C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent\artifacts\qa\web-agent-h3-assets-mobile-final.png`
- local preview URL: `http://127.0.0.1:4173/qa-h3-grid.html`
- viewport: 1440 × 900 CSS px and 390 × 844 CSS px
- state: 玉瓷浅色主题、MiniMaxH3共享节点、9 张图片全部上传。

## Full-view comparison evidence

桌面端对话框最小高度由 680 px 增加至 1088 px，精确增加 60%；消息区最小高度同步由 390 px 增加至 624 px。9 张图片在 1440 px 下形成 5+4 两行自适应卡片，不出现横向溢出。390 px 移动端维持单列并使用内部纵向滚动，不撑破页面宽度。

## Focused region comparison evidence

素材区不再渲染独立的“@ 引用素材”快捷行。每个素材卡片保留 58 × 58 px 的真实图片缩略图、就近的 `@图片N` 引用按钮、文件名、大小与删除操作；桌面卡片宽约 261 px，移动端卡片宽约 285 px。

## Primary interactions and console checks

- 验证 9 张图片全部显示缩略图。
- 验证网格自适应列数、限定最大高度并内部滚动。
- 验证桌面与移动端均无水平溢出。
- 验证控制台无警告或错误。

## Required fidelity surfaces

- 字体：沿用全站正文最低 18 px 的既有规范。
- 颜色：保持当前浅色主题 token，不引入新的暗色界面。
- 图片：使用 `object-fit: cover`，缩略图不拉伸。
- 交互：手动输入 `@` 的素材选择器仍保留，卡片上的引用按钮仍可直接插入。
- 上传：图片/视频素材继续直传腾讯云 COS，参考图不再经过 600 KB 的内联 Base64 门槛。

## Findings

无待处理的 P0、P1 或 P2 视觉问题。

## Implementation Checklist

- [x] H3 图片上限恢复为 9 张，视频和音频各 3 个。
- [x] 移除独立的“@ 引用素材”行。
- [x] 9 张缩略图使用响应式网格并保持可见。
- [x] 素材多时使用内部滚动，避免挤乱编辑器。
- [x] 对话框桌面高度增加 3/5。
- [x] 移动端保留适度增高与安全滚动。
- [x] 取消普通图片创作的 600 KB 前端门槛，改为受信任 COS 直传。

## Follow-up Polish

None required for this scope.

final result: passed
