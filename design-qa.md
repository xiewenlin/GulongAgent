# Design QA — 古龙官网品牌图标统一

- source visual truth: `D:\openclaw\古龙智能体引擎\bak\图标设计\古龙图标.png`
- canonical website asset: `public/assets/gulong-agent-icon.png`
- desktop home screenshot: `artifacts/qa/brand-icon-home-desktop.png`
- desktop download screenshot: `artifacts/qa/brand-icon-download-desktop.png`
- mobile home screenshot: `artifacts/qa/brand-icon-home-mobile.png`
- viewports: 1440 × 900 CSS px and 390 × 844 CSS px
- tested themes: 玉瓷、日出

## Full-view comparison evidence

源图标与官网规范资源的 SHA-256 完全一致。主页导航、产品演示、行动区、页脚、下载版本卡片和网页版入口均读取同一规范资源；桌面端与移动端未出现裁切、变形或横向溢出。

## Browser icon and cache evidence

- HTML favicon、shortcut icon、Apple Touch Icon 与 PWA manifest 均指向同一规范图标。
- 静态收藏图标使用 `20260826-gulong-icon-2` 缓存版本。
- 主题切换后运行时图标 URL 同步切换 `theme` 参数并重建 favicon；验证从玉瓷切换为日出后 `data-theme=morning`。
- 1254 × 1254 源图在导航 48 px、下载卡片 80 px、移动端 42 px 等槽位均保持 1:1 比例。

## Primary interactions and console checks

- 验证主页所有古龙品牌图像均成功加载，白色背景规则生效。
- 验证下载页两个版本卡片均显示新图标。
- 验证主题切换后页面图标与浏览器标签图标同步刷新。
- 验证浏览器控制台无警告或错误。

## Findings

无待处理的 P0、P1 或 P2 视觉问题。

## Implementation Checklist

- [x] 替换全站规范品牌 PNG。
- [x] 导航、演示、对话头像、登录、下载卡片、页脚与主题入口复用同一资源。
- [x] 浏览器 favicon、快捷图标、Apple Touch Icon 与 PWA 图标统一。
- [x] 新增缓存版本，规避浏览器继续显示旧图标。
- [x] 桌面端、移动端与主题切换完成视觉验收。

final result: passed
