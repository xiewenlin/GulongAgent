# 英语教练桌面端接入合同

生产基址：`https://www.sologle.com`。机器可读文档：`/api/openapi.json`；交互文档：`/api/docs`。请求与响应均为 JSON，音频通过短期票据直传私有腾讯云 COS。用户使用已有官网账号，不需要开发者 API Key。

## 桌面绿色版下载与发布

- 官网 `/download` 的“英语教练”卡片读取独立发行渠道 `website-english-coach`，未上传版本时明确显示“绿色版准备中”。
- 管理员在“版本管理”中选择“英语教练”，只可手动上传 `.zip` 绿色软件压缩包；非 ZIP 文件由前端和服务端双重拒绝。文件从浏览器直传成都 COS，完成大小核验后成为该渠道唯一最新版，随后清理旧版本对象。
- `GET /api/downloads` 的 `editions[]` 在有最新版时包含 `editionKey: "english_coach"`；`GET /api/downloads/english_coach/download` 返回 15 分钟有效的私有 COS 下载链接与文件名。无已上传版本返回 `404 RELEASE_NOT_FOUND`。

## 登录、刷新与权益

| 操作 | 路径 | 请求 | 返回 |
|---|---|---|---|
| 用户名或邮箱密码登录 | `POST /api/v1/desktop/english-coach/auth/login` | `{ "identifier": "用户名或邮箱", "password": "密码" }` | `{ "access_token": "gec_at_...", "refresh_token": "gec_rt_...", "token_type": "Bearer", "expires_in": 900 }` |
| 轮换令牌 | `POST /api/v1/desktop/english-coach/auth/refresh` | `{ "refresh_token": "gec_rt_..." }` | 同登录；旧令牌立即失效 |
| 注销 | `POST /api/v1/desktop/english-coach/auth/logout` | Bearer 访问令牌与 `{ "refresh_token": "gec_rt_..." }` | `{ "ok": true }` |
| 账户和独立套餐 | `GET /api/v1/desktop/english-coach/account` | `Authorization: Bearer gec_at_...` | `user`、`entitlement`、`checked_at` |

`entitlement` 固定包含 `product: "english_coach"`、`plan_id: "english_coach_monthly"`、`active`、`status`（`inactive|scheduled|active|expired`）、`starts_at`、`expires_at`、`capabilities` 和 `monthly_price_fen: 19800`。`checked_at` 是服务器核验时间。英语权益只由本产品有效期决定，普通会员与短视频包月不会代替它。访问令牌 15 分钟有效，刷新会话最长 30 天；桌面端应将刷新令牌保存在操作系统安全存储中，不传给渲染层或日志。

错误响应为 `{ "code": "...", "message": "中文说明" }`。错误登录为 `401 AUTH_INVALID_CREDENTIALS`，刷新凭据失效为 `401 AUTH_EXPIRED`，频繁请求为 `429 AUTH_RATE_LIMITED`。客户端过期后仍可保留已保存的本地资料和记录；新远程任务必须先取得有效套餐。

## 购买与后台调整

- 官网 `/pricing?tab=subscription` 展示“英语教练包月”，每月 198 元，仅支持线下支付审核。
- 已登录用户通过 `POST /api/billing/orders` 提交 `{ "kind":"subscription", "planType":"english_coach_monthly", "cycle":"month", "provider":"offline" }`；返回待审核订单。付款凭据和审核状态由官网管理。审核通过后只开通英语产品的独立有效期，不增加钱包余额。
- 当前用户可通过 `GET /api/billing/subscription` 读取 `products[]`；管理员可通过 `PUT /api/admin/users/{id}/subscription-period` 提交所改产品的 `products[]`，每项为 `{ "id", "enabled", "currentPeriodStart", "currentPeriodEnd" }`。时间采用 ISO 8601；取消勾选只提交 `{ "id", "enabled": false }`。未提交的产品有效期保持不变。
- 公开价格 `GET /api/v1/pricing/subscriptions` 中的 `englishCoach` 含 `monthlyFen: 19800` 和 `paymentProviders: ["offline"]`。

## 免费文字模型

英语教练桌面端只持有上节的 15 分钟 `gec_at_` 访问令牌，不获取 PearAPI Key 或渠道令牌。官网后端代为调用免费模型，不进入共享节点订单队列；管理员需在“令牌配置”保存可用的 PearAPI 免费渠道令牌。

PearAPI 平台凭据以共享的 `API_KEY_PEPPER` 派生独立 AES-GCM 密钥加密，两部署目标必须沿用同一高熵值；旧版 `SESSION_SECRET` 密文仍可在原环境读取。若历史凭据在新服务器解不开，管理员须在官网“令牌配置”重新填写免费渠道令牌并保存一次，不能通过更换会话密钥或复制别人的密钥恢复。

| 操作 | 路径 | 请求 | 返回 |
|---|---|---|---|
| 模型状态 | `GET /api/v1/desktop/english-coach/llm/config` | `Authorization: Bearer gec_at_...` | `{ "ok":true, "provider":"pearapi", "model":"glm-4-flash-250414", "display_name":"GLM-4-Flash-250414 · 免费", "ready":true }`；缺少渠道令牌时 `ready:false` |
| 即时对话 | `POST /api/v1/desktop/english-coach/llm/chat` | Bearer、JSON `{ "model":"glm-4-flash-250414", "messages":[{"role":"user","content":"请解释这个英语句子"}] }` | `{ "ok":true, "model":"glm-4-flash-250414", "text":"...", "billing":{"charged_fen":0,"free":true} }` |

两接口均要求英语教练包月权益有效；未登录为 401，权益失效为 `403 ENGLISH_SUBSCRIPTION_REQUIRED`。`chat` 仅允许纯文本 `glm-4-flash-250414`，每条消息最多 12000 字符，最多 24 条、总计最多 48000 字符；每 5 分钟最多 30 次。模型不可用时不自动切换其他模型，也不自动重试。该同步免费接口当前不使用 `Idempotency-Key`，客户端超时后不要盲目重发。

## 英语任务

所有用户端英语订单接口接受 `Authorization: Bearer gec_at_...`。`GET /api/v1/capability-orders/catalog` 仍返回四项能力供兼容历史订单，但现在全部为 `dispatchable:false`、`adapter_status:local_only`。新建任意 `english_coach.*` 派单订单和申请新录音上传票据均返回 `409 CAPABILITY_LOCAL_ONLY`。转录改由桌面端内置 Whisper base.en CPU 执行，朗读改用 Windows 本地能力；文字继续调用上面的免费同步接口，发音评估由桌面端本地执行。官网不再为新的英语学习任务派单，也不影响其他产品能力。已创建的合法旧订单仍可由原节点完成原生命周期、由本人查询或取消。

| `capability_id` | `parameters` | 输入素材 | 结果 |
|---|---|---|---|
| `english_coach.text` | 仅保留历史订单合同；新文字请调用 `/api/v1/desktop/english-coach/llm/chat` | 无 | 历史结果可查询 |
| `english_coach.transcribe` | 仅供历史订单解析；新转录使用桌面内置 Whisper base.en CPU | 历史订单含 `media` 1 个音频 | 历史 `inline_result.text` 可查询 |
| `english_coach.speech` | 仅供历史订单解析；新朗读使用 Windows 本地能力 | 无 | 历史 `primary_audio` 结果可查询 |
| `english_coach.assess` | 仅保留历史订单合同；新评估在桌面端本地 CPU 执行 | 不再上传评估录音 | 历史结果可查询 |

历史派单音频限 20 MiB，接受 WAV、MP3、FLAC、WebM；不再签发新录音票据。现有英语订单的 `billing.price_fen=0`、`charge_status=exempt`，不扣钱包且不分佣。无已安装、验证并启用的节点时旧订单保持排队；超时或节点失败会返回明确状态，不生成模拟结果。套餐到期后在领取前取消尚未处理的英语订单；本人仍可查询历史结果。

稳定请求编号仍是历史订单恢复入口：`GET /api/v1/capability-orders/by-request/{key}`。在原始 POST 响应丢失时，以同一 `Idempotency-Key` 查询；若不存在，不要重新提交英语派单，改走客户端本地能力。`POST /api/v1/capability-orders/by-request/{key}/cancel` 可取消或原子创建取消标记，阻止迟到的创建请求进入队列。返回的历史 `order` 含 `id`、`status`、`stage`、`progress`、`eta_seconds`、`inline_result`、`results` 和 `billing`。也可按订单 ID 调用 `GET /api/v1/capability-orders/{id}` 与 `POST /api/v1/capability-orders/{id}/cancel`。

### 历史录音直传

新英语录音不再上传官网 COS；`POST /api/v1/capability-assets/presign` 对英语教练客户端返回 `409 CAPABILITY_LOCAL_ONLY`。已取得票据的旧素材仍可通过 `POST /api/v1/capability-assets/{asset_id}/complete` 完成大小、摘要和归属核验；已完成素材的重复 complete 安全返回原素材。

签名 URL 只在需要时使用，不能永久保存或共享。查询结果仅限订单本人；上传素材与输出均按用户、任务和执行节点校验。

## 执行节点

历史执行节点仍沿用 `X-Gulong-Account-Binding: gab_...`，不接收用户的桌面访问令牌。`POST /api/v1/capability-orders/claim` 仅为已存在且仍在队列的合法英语订单保留原领取流程，不可能领取关闭后新建的英语订单；节点上报仍须已安装、30 天内真实验证、启用，共享旧订单仍须 `sharing_opt_in: true`。`dry_run: true` 仅检查连通性，不领取任务。跨账户英语旧任务仅能分配给主动共享的轮询节点；回调、COS 输出票据和 worker 状态接口只接受该任务指定执行节点的绑定。领取任务 DTO 不含需求用户邮箱、用户 ID、钱包或内部绑定 ID。

节点的 `started/progress` 回调续租五分钟；`completed` 可传文字内联结果，或先通过 `/api/v1/capability-orders/{id}/outputs/presign` 获得 `primary_audio` 的 COS PUT 票据，再提交 `output_id`。回调按任务和 `event_id` 幂等。精确领取、进度、回调 JSON 及通用私有素材合同见 [统一能力订单 v1](./unified-capability-orders-v1.md)。
