# Design QA — Gulong Agent Engine

## Comparison basis

- Reference: `docs/design/selected-homepage-option-1.png`
- Implementation viewport: 1536 × 1024
- Final comparison: `docs/design/comparison-round-2.png`
- Core journeys checked in the in-app browser: homepage, theme picker, downloads, developer console, pricing, second-brain upload, feedback, authentication, and API docs.

## Resolved findings

- P1: The first implementation used excessive vertical whitespace and pushed the four-step workflow below the first viewport. Reduced the hero height and product-demo canvas, tightened the workflow heading, and placed both the workflow and capability strip in the 1536 × 1024 frame.
- P1: Hero typography wrapped more aggressively than the reference. Rebalanced the hero columns and type scale so both headline lines keep the intended hierarchy.
- P2: The workflow lacked the selected concept's contained panel treatment. Added the light bordered panel, compact horizontal steps, jade states, and pale-gold directional accents.
- P2: Route state originally omitted URL hashes. Included hash state so homepage navigation and active states remain reliable.
- P2: A mobile width expression was invalid CSS. Replaced it with a valid `calc()` expression.

## Final audit

- Visual hierarchy and section order match the selected concept.
- Real source logo and a code-native product UI are used; no fake placeholder assets are present.
- Layout is responsive at desktop, tablet, and mobile breakpoints.
- Primary navigation, CTAs, dialogs, forms, theme selection, and developer actions are interactive.
- Focus styles, labels, semantic landmarks, contrast, and keyboard-accessible controls are present.
- No unresolved P0, P1, or P2 design issues remain.

final result: passed

## 2026-07-30 合作伙伴全息神经网络与编辑流程

### 视觉依据与实现证据

- 参考页面截图：`docs/design/partner-network-reference-yeschic.png`
- 控件参考图：`C:/Users/YCAI/AppData/Local/Temp/codex-clipboard-f73e579a-b9f9-4ef3-8e01-6aa5fe65a5e8.png`
- 删除区域参考图：`C:/Users/YCAI/AppData/Local/Temp/codex-clipboard-08a86539-dea2-4198-a9ce-f4c9a0677c1e.png`
- 全息网络实现：`docs/design/partner-network-fullscreen.png`
- 右上角控件实现：`docs/design/partner-network-controls.png`
- 合作伙伴编辑弹窗：`docs/design/partner-admin-edit.png`
- 对照视口：参考页与实现页均为 1280 × 720。

### 交互与视觉验收

- P1：首轮节点在左上区域出现重叠；已按行业组重新分散纬度偏移并收敛前景节点最大尺寸，第二轮对照通过。
- P1：鼠标移入节点或画布时动画保持运行，只能使用“暂停/继续”按钮控制。
- P1：已删除“品牌网络正在实时旋转 / 已暂停，方便选择节点”底部提示卡片及相关样式。
- P1：暂停、继续、复位视角、全息预览和退出全屏均可操作；拖拽旋转、滚轮缩放可用。
- P1：合作伙伴编辑弹窗支持查看当前 Logo/宣传图、替换或删除图片，保存后同步品牌神经网络。
- P2：控件固定在画布右上角，图标、字号、边框和深色半透明质感与参考图一致。
- P2：全息画布使用真实合作伙伴 Logo 和真实行业分类数据，外层官网仍保持玉瓷浅色视觉。
- 可访问性：按钮包含可读文本/`aria-label`，全屏支持 Escape 退出，键盘焦点样式沿用全站系统。

final result: passed

## 2026-07-29 全站 18px 与账号身份修复

### 对照基础

- 原始用户截图：`C:/Users/YCAI/AppData/Local/Temp/codex-clipboard-6b0737b1-77df-4d5c-8e79-88a395e89b41.png`
- 同尺寸实现：`docs/design/account-minimax-18px.png`
- 并排对照：`docs/design/account-minimax-comparison.png`
- 对照视口：1512 × 669；另测 1024 × 768 与 390 × 844。
- 账号页面使用仅限本地设计验收的模拟管理员数据；模拟接口未进入生产代码。

### 已解决问题

- P1 · 字体：清除中文正文、侧栏、表单、表格和帮助说明中低于 18px 的计算字号；`small` 元素不再继承浏览器默认的 15px。
- P1 · 身份：侧栏和账户总览分别显示产品版本与账号角色；管理员身份不再被“会员”订阅状态覆盖，并恢复“进入管理员后台”入口。
- P1 · 响应式：账户后台在 1100px 以下改为上下布局，避免 18px 字号挤压 MiniMax 双栏；手机端菜单改为单列，文件元数据允许换行。
- P2 · 内容溢出：API 路径允许安全断行，首页产品演示扩大最小高度与侧栏宽度，并移除工作流步骤箭头造成的横向溢出。

### 最终检查

- 运行时扫描：桌面、平板、手机三个视口均未发现低于 18px 的可见文字。
- 1512px 与 1024px 用户后台均无页面级横向滚动；390px 首页与账户页保持在视口内。
- 管理员、会员状态、古龙版/永生花版三个维度视觉分离，长邮箱、API 路径和移动端菜单仍可读。
- 键盘可达按钮、焦点样式、语义导航和现有主题色保持不变。

final result: passed
