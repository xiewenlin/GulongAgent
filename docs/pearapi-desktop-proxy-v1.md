# PearAPI 桌面安全代理 v1

古龙桌面端只持有 Chandler 登录访问令牌。PearAPI Key、免费渠道令牌及渠道配置由官网管理员加密保存，任何桌面接口都不会返回这些共享凭据。

## 鉴权与通用约定

- 所有路径均以官网 HTTPS 域名为基准，例如 `https://www.sologle.com`。
- 请求头：`Authorization: Bearer <Chandler access token>`。
- 创建请求必须携带 `Idempotency-Key`，长度 8–160 字符。同一账户和幂等键重复提交同一请求会返回原任务；请求内容不同则返回 `409 IDEMPOTENCY_KEY_CONFLICT`。
- 金额全部为人民币分。免费文本模型不扣费；图片和视频沿用官网现有原子预扣、成功确认、失败或取消幂等退款账本。管理员免扣费。
- 错误统一为 `{ "ok": false, "code": "...", "message": "中文说明", "retryable": false }`。
- `PEAR_API_NOT_CONFIGURED` 只表示官网管理员尚未配置相应 PearAPI 共享凭据。桌面端应提示联系管理员或稍后重试，不应提示普通用户填写 Key。

## 模型目录

`GET /api/v1/desktop/pearapi/models`

返回免费文本模型、图片模型、视频模型以及 `configured`、`media_configured` 布尔值。响应不包含 Key、令牌、密文、尾号或渠道值。

## 安全素材引用

1. `POST /api/v1/desktop/pearapi/assets/presign`

```json
{
  "kind": "image",
  "filename": "reference.png",
  "content_type": "image/png",
  "bytes": 123456,
  "sha256": "64位十六进制摘要"
}
```

响应包含 1 小时内有效的 `upload_url`、必须原样携带的 `headers`、`asset_id` 与 `object_key`。文件使用 PUT 直传腾讯云 COS，不经过官网请求体。

2. `POST /api/v1/desktop/pearapi/assets/{asset_id}/complete`

官网通过 COS HEAD 同时核对大小、SHA-256、账户归属和素材编号，成功后返回可用于生成请求的 `asset.asset_id`。生成接口只接受这个不透明 ID，不接受任意外部 URL；当前 PearAPI 图片与视频生成只消费 `kind=image` 的参考素材。

## 提交生成

`POST /api/v1/desktop/pearapi/generations`

```json
{
  "type": "text",
  "model": "ox-alpha",
  "messages": [{ "role": "user", "content": "你好" }],
  "conversation_id": "可选会话ID",
  "assets": [],
  "image_size": "1:1",
  "aspect_ratio": "16:9",
  "duration_seconds": 5
}
```

- `type=text`：使用 `messages`，也可只传 `prompt`；免费、同步完成并以统一 generation 结构返回。桌面 Chandler 用户无需会员即可走这条免费兜底路径，但仍受限流与幂等保护。
- `type=image|video`：使用 `prompt`；`assets` 仅传 `{ "asset_id": "..." }`。模型、尺寸、比例和时长必须来自模型目录。

成功响应：

```json
{
  "ok": true,
  "generation": {
    "id": "任务ID",
    "type": "video",
    "status": "queued|processing|succeeded|failed|cancelled",
    "model": "请求模型",
    "resolved_model": "实际模型",
    "result": { "urls": [] },
    "error": null,
    "created_at": "ISO-8601",
    "completed_at": null,
    "cancelled_at": null
  },
  "billing": {
    "charged_fen": 0,
    "remaining_balance_fen": 0,
    "refunded_fen": 0,
    "exempt": false
  },
  "idempotent": false
}
```

## 轮询与取消

- `GET /api/v1/desktop/pearapi/generations/{id}`：仅返回当前登录账户自己的任务；媒体轮询会以短租约推进上游状态，避免并发重复查询。
- `POST /api/v1/desktop/pearapi/generations/{id}/cancel`：幂等取消。已成功或已失败任务保持原终态；尚未完成且已经预扣的媒体任务按同一账本键退款。上游不支持物理取消时，官网仍会终止本地轮询并拒绝把迟到结果再次结算。

## 稳定错误码

| HTTP | code | 含义 |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | 参数或素材类型不正确 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 缺少合格幂等键 |
| 401 | `DESKTOP_AUTH_REQUIRED` | Chandler 桌面登录令牌缺失或无效 |
| 402 | `INSUFFICIENT_BALANCE` | 付费媒体余额不足 |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | 同一幂等键对应了不同请求 |
| 409 | `ASSET_NOT_READY` | 素材未完成回执校验或不属于当前账户 |
| 404 | `GENERATION_NOT_FOUND` | 任务不存在或不属于当前账户 |
| 429 | `RATE_LIMITED` | 请求过于频繁 |
| 503 | `PEAR_API_NOT_CONFIGURED` | 官网管理员尚未配置共享凭据 |
| 503 | `PEAR_API_CREDENTIAL_REJECTED` | 上游拒绝官网管理员凭据 |
| 503 | `PEAR_API_MODEL_UNAVAILABLE` | 所选模型暂时不可用 |

`/api/agent/chat` 继续作为兼容入口，接受桌面 Chandler Bearer；桌面免费兜底不要求会员，仍受每账户限流，并可通过 `Idempotency-Key` 获得幂等重放。
