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

## 英语任务

所有用户端英语订单接口接受 `Authorization: Bearer gec_at_...`。`GET /api/v1/capability-orders/catalog` 返回四项能力、精确参数 JSON Schema、素材和输出限制。创建订单：

```http
POST /api/v1/capability-orders
Authorization: Bearer gec_at_...
Idempotency-Key: stable-job-uuid
Content-Type: application/json

{"capability_id":"english_coach.text","parameters":{"task":"coach","input":"Explain this sentence"},"assets":[],"source_channel":"desktop_agent"}
```

| `capability_id` | `parameters` | 输入素材 | 结果 |
|---|---|---|---|
| `english_coach.text` | `task: coach|writing|explain`、`input`，可选 `context`、`exam` | 无 | `inline_result.text` |
| `english_coach.transcribe` | 可选 `language: en` | `media` 1 个音频 | `inline_result.text` |
| `english_coach.speech` | `text`，可选 `locale: en-US|en-GB`、`output_format: wav` | 无 | `results[]` 中 `role: primary_audio` 的短时签名下载链接 |
| `english_coach.assess` | `reference_text`，可选 `language: en-US` | `media` 1 个音频 | `inline_result`，`provider: local-phoneme`、逐词和音素证据及评分 |

音频限 20 MiB，接受 WAV、MP3、FLAC、WebM；以目录实时返回的 MIME 合同为准。四项订单的 `billing.price_fen=0`、`charge_status=exempt`，不扣钱包且不分佣。无已安装、验证并启用的节点时订单保持排队；超时或节点失败会返回明确状态，不生成模拟结果。套餐到期后拒绝新建并在领取前取消尚未处理的英语订单；本人仍可查询历史结果。

稳定请求编号是恢复入口：`GET /api/v1/capability-orders/by-request/{key}`。在原始 POST 响应丢失时，先以同一 `Idempotency-Key` 查询，存在则继续轮询原订单；不存在才重新提交。`POST /api/v1/capability-orders/by-request/{key}/cancel` 可取消或原子创建取消标记，阻止迟到的创建请求进入队列。不要对同一请求编号重新上传后改变 `asset_id` 再重复创建，否则会得到 `IDEMPOTENCY_KEY_CONFLICT`。返回的 `order` 含 `id`、`status`、`stage`、`progress`、`eta_seconds`、`inline_result`、`results` 和 `billing`。也可按订单 ID 调用 `GET /api/v1/capability-orders/{id}` 与 `POST /api/v1/capability-orders/{id}/cancel`。

### 录音直传

1. 计算文件字节数及 SHA-256 大写十六进制，调用 `POST /api/v1/capability-assets/presign`，提交 `{ "filename", "content_type", "bytes", "sha256" }`。
2. 使用响应 `upload_url`、`method: PUT` 及原样 `headers` 上传二进制，不经过官网请求体。
3. `POST /api/v1/capability-assets/{asset_id}/complete` 完成 COS 大小、摘要和归属核验；在订单 `assets` 中引用 `{ "asset_id": "...", "role": "media" }`。已完成素材的重复 complete 安全返回原素材。

签名 URL 只在需要时使用，不能永久保存或共享。查询结果仅限订单本人；上传素材与输出均按用户、任务和执行节点校验。

## 执行节点

执行节点沿用 `X-Gulong-Account-Binding: gab_...`，不接收用户的桌面访问令牌。`POST /api/v1/capability-orders/claim` 上报已安装、30 天内真实验证、启用的能力；英语共享节点还需为每项能力声明 `sharing_opt_in: true`。`dry_run: true` 仅检查连通性，不领取任务。跨账户英语任务仅能分配给主动共享的轮询节点；回调、COS 输出票据和 worker 状态接口只接受该任务指定执行节点的绑定。领取任务 DTO 不含需求用户邮箱、用户 ID、钱包或内部绑定 ID。

节点的 `started/progress` 回调续租五分钟；`completed` 可传文字内联结果，或先通过 `/api/v1/capability-orders/{id}/outputs/presign` 获得 `primary_audio` 的 COS PUT 票据，再提交 `output_id`。回调按任务和 `event_id` 幂等。精确领取、进度、回调 JSON 及通用私有素材合同见 [统一能力订单 v1](./unified-capability-orders-v1.md)。
