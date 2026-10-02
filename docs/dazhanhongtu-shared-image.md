# 大展宏图共享生图合同（v1）

生产根地址：`https://www.sologle.com`。OpenAPI：`/api/openapi.json`。

此合同采用独立能力 ID `gulong_engine.image_2k`，不修改历史 `qwen_image_2_1.text_to_image`、`qwen_image_2_1.multi_image_edit` 或 `gulong_engine.image` 订单。官网会话、已登录桌面端的 Chandler Bearer，或古龙引擎桌面短期 Bearer 可访问；创建与上传要求生效中的 `gulong_engine_monthly` 权益（现价 999 元/月，线下支付审核）。所有订单价格固定为 0 分，会员共享算力不扣余额、不分佣。普通未登录请求返回 401；权益未生效返回 403 `GULONG_ENGINE_SUBSCRIPTION_REQUIRED`。桌面客户端不能用节点的 `X-Gulong-Account-Binding` 令牌冒充发单用户。

## 先查可用性

`GET /api/v1/capability-orders/catalog`，取 `capability_id=gulong_engine.image_2k`：

- `required_capability_version: "1.0.0"`。只有最近 3 分钟内在线、绑定有效、30 天内通过真实推理验证、显式上报 `supported_models:["qwen_image_2_1"]` 且允许跨账户共享的节点才计入。
- `availability.status` 为 `ready`、`busy` 或 `offline`；同时返回 `verified_node_count` 和 `free_slot_count`。`busy` 仍可排队；`offline` 时 `dispatchable=false`，不能创建新订单。旧 Qwen 2.1 节点报告不等于此合同验收。
- 可用性是瞬时快照，实际提交时再次检查。没有兼容节点时返回 HTTP 409 `CAPABILITY_NO_COMPATIBLE_NODE`，不创建订单。

节点必须在 `POST /api/v1/capability-orders/claim` 的 `capabilities` 中明确上报 `capability_id:gulong_engine.image_2k`、`capability_version:1.0.0`、`supported_models:["qwen_image_2_1"]`、`installed/validated/enabled:true`、`sharing_opt_in:true`、真实验证的 `tested_at` 与产物 SHA-256。未实施此能力的旧节点不得冒用新 ID。

## 素材与提交

先对每张参考图调用 `POST /api/v1/capability-assets/presign`，请求 `{filename,content_type,bytes,sha256}`，使用响应的 `upload_url`、`method=PUT` 和**全部** `headers` 直传 COS，再调用 `POST /api/v1/capability-assets/{asset_id}/complete` 完成 HEAD 大小、摘要和归属验证。只使用返回的 `asset_id`；每张图片上限 40 MiB，允许 PNG/JPEG/WebP。传输原图不经过 Vercel 请求体。

`POST /api/v1/capability-orders` 必须提供稳定的 `Idempotency-Key`（8–160 字符）。示例：

```json
{
  "capability_id": "gulong_engine.image_2k",
  "capability_version": "1.0.0",
  "source_channel": "desktop_agent",
  "parameters": {
    "model": "qwen_image_2_1",
    "task": "multi_image_edit",
    "prompt": "用户的创作要求",
    "negative_prompt": "",
    "width": 1792,
    "height": 2400,
    "generation_mode": "fast_lora_6",
    "steps": 6,
    "prompt_enhancement": "local",
    "seed": -1
  },
  "assets": [
    { "asset_id": "已完成上传的 ObjectId", "role": "reference_image" }
  ]
}
```

仅验收 Qwen 官方列出的七种原生 2K 画布：`2048×2048`、`2400×1792`、`1792×2400`、`2528×1696`、`1696×2528`、`2752×1536`、`1536×2752`。[官方模型说明](https://github.com/QwenLM/Qwen-Image-2.1)。`task=text_to_image` 必须没有参考图；`multi_image_edit` 必须有 1–10 张参考图。`assets` 数组顺序就是工作器收到的参考图顺序，不进行服务器排序。`generation_mode=fast_lora_6` 必须 `steps=6`；标准模式默认 30 步。`prompt_enhancement` 可为 `none`、`official`、`local`；由已验收的执行节点实现，服务端只保存并原样下发所选模式，不能假装官网已经运行增强。未经节点真实验收，请保持不可派单。

成功返回 HTTP 201 `{order:{id,order_no,status,capability_id,capability_version,queue_position,estimated_wait_seconds,queue_reason_code,queue_message,auto_cancel_at,billing},idempotent:false}`。同一账户、同一幂等键及相同请求重放，返回原订单并设 `idempotent:true`；不同请求复用同一键返回 409 `IDEMPOTENCY_KEY_CONFLICT`。订单零价，无钱包预扣。

## 恢复、进度、取消和结果

- `GET /api/v1/capability-orders/by-request/{Idempotency-Key}`：重启后按稳定请求键恢复本人原订单。
- `GET /api/v1/capability-orders/{id}`：只读本人订单，返回 `queued/claimed/processing/completed/failed/cancelled`、队列位置、进度、ETA、排队截止、错误码和结果。无节点的旧排队订单给出 `queue_reason_code=NO_COMPATIBLE_NODE`；超时后为 `cancelled`、`error.code=CAPABILITY_QUEUE_TIMEOUT`。
- `POST /api/v1/capability-orders/{id}/cancel` 或 `POST /api/v1/capability-orders/by-request/{key}/cancel`：用户主动幂等取消。客户端不能在查询或启动时自动取消用户订单。
- 完成后 `order.results[].download_url` 为每次查询时签发的 15 分钟短期 COS 下载地址；不保存永久公开 URL。只有订单本人可查询。节点通过既有领取、进度回调、COS 输出票据和完成回调合同交付图片。

前述接口只是官网能力合同；真正端到端可用还取决于执行节点实现并上报此精确版本及所有模式的真实推理验收。客户端遇到 `offline` 或 `CAPABILITY_NO_COMPATIBLE_NODE` 应继续本地/局域网方案或提示稍后重试，不应声称已进入共享队列。
