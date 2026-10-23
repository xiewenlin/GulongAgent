# 2.1.335 已安装制品的独立九项验收窗口

此窗口仅签发自动验收挑战，不是普通业务准入。依据实际安装 delta 与完整九项库存的 SHA-256 核验，最终消费者为 `f41db323…24418`；两项 Qwen 图片的独立制品仍为 `983ea1b0…c9aa7`，不能冒称这两项属于 f41。账号、绑定、节点、空分组、模型矩阵均固定在服务端作用域摘要中，不接受环境变量或管理员接口改额。

窗口 ID：`gvn_20261023_f41_nine`。固定 UTC 起止为 `2026-10-23T00:00:00.000Z` 至 `2026-10-23T02:00:00.000Z`（北京时间 08:00 至 10:00），不随部署、重复查询、UTC 换日或重启续期。桌面端已有的受保护本地 preparation 期限更晚；真正启用仍由桌面所属任务在双端发布完成后、空闲检查点恢复“仅验收”调度。

九项：文本对话、1024 维向量、通用音乐、Qwen 文生图、Qwen 图片编辑、原生 Music3、SAM 视频跟踪、MediaPipe 视频分析、Whisper 转写。不包含 H3 视频生成、数字直播口型或新 TTS。

- 七项非音乐能力各一次。两项音乐沿直接用户“请追加次数，无需确认，直到验收通过为止，测完之后，立即重新发版”的同目标授权继续；每三次归为一个独立审计批次，每项最多 126 次安全上限，并受固定截止、原退避和一次生成/一次完整 ASR 约束。真实通过即停止再签发，窗口到期或安全上限耗尽也停止；绝不自动续窗。
- 每项建立带 `verificationWindowId` 的新验证行，旧 Qwen 有效证明也不计入本窗口通过数。原失败日志、旧额度及旧消耗账本保留，不重置。库存上报仍只代表候选，客户端 `validated=true` 不产生证明。
- 新独立账本集合 `capabilityVerificationInstalledNineWindows`，首次真实领取时物化；`_id`、spec 摘要、身份作用域、不可续期的截止、逐能力计数及逐挑战消耗同一 CAS 校验。准备失败仍算一次，不退款重放；原 request/lease 恢复不重复消费。
- 继续使用原 GAB 身份、请求 UUID、DPAPI 租约、四个全局槽和每节点独占物理槽。资源未知/忙碌、原任务未释放、错误账号/分组/模型或矩阵变化均不签发。普通业务与 LAN 仍由本地保护策略关闭，服务端 f41 未知制品普通业务隔离不解除。

只读合同：`GET /api/v1/capability-verifications/supplemental-budget`，Header `X-Gulong-Account-Binding`。新增 `installed_nine_window`，含 authorization_id、valid_from、expires_at、inventory_ready、passed_count、state、capabilities（逐项 artifact/matrix/已用/剩余/状态）及 `grants_admission=false`。原 `/report-v2`、`/next`、原请求恢复、输出上传、`/result` 路由不变。不新增公开激活/改额接口。未实际上报时为 awaiting_inventory，查询不建窗口或挑战。

本轮授权原件已从桌面任务人类消息读取核实：新窗口协同 `01a16319-3091-7e62-83d2-fa771df4194e` 内 `01a1631e-03c8-7e22-b027-520a9bcfcd0b`；音乐继续 `01a159aa-4e6e-7a30-b764-942e0491b314` 内 `01a159bc-19d5-7643-9a8f-3648714f5635`。安装成功消息在 `01a1660f-b228-7c70-9d04-fc4ba4d19521`。官网任务不操作本地模型、Windows 服务或私有账户配置；真实模型验收由桌面所属任务执行。
