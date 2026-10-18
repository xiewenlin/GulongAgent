# 古龙共享节点 TTS 合同

`gulong_engine.tts` 是现有 `gulong-capability-orders-v1` 的独立零价能力，不复用已暂停共享派单的 `breeze_tts_2.synthesize`。仅生效中的 `gulong_engine_monthly` 账户可下单；登录、取消、请求键幂等、进度、结果鉴权与其他古龙能力订单一致。没有真实在线并共享的 TTS 节点时，目录返回 `dispatchable: false`，创建返回 `409 CAPABILITY_NO_COMPATIBLE_NODE`，不会创建虚假订单。

## 客户端

先用既有古龙账号登录，取得桌面令牌；`GET /api/v1/capability-orders/catalog` 找到 `gulong_engine.tts`。新消费者必须按 `availability.models:[{id,voice_id}]` 选择**同一条**已自动验收的模型和音色，不得把不同条目的模型、音色自由组合。矩阵只含服务端已验证且仍在线、绑定与分组有效的交集；未验收或仅有历史扁平上报时为空，不能猜模型或默认音色。`availability.voice_ids` 保留为旧客户端兼容字段，不是模型/音色组合证明。

`parameters_schema.properties.model` 为 1–240 字符的字符串，不设置默认模型。新消费者显式提交 `model` 和对应 `voice_id`；服务端创建及领取均校验精确配对。为兼容旧客户端，未传 model 的原有 voice-only 合同暂时保留，但新客户端不得用它绕过矩阵。`text` 为必填 1–12000 字符，`language` 默认 `auto`，`speed` 默认 1，`output_format` 为 `mp3`（默认）或 `wav`。空白文本和声音 ID 会被拒绝。输入素材数必须为零。

创建：

```http
POST /api/v1/capability-orders
Idempotency-Key: <同一次本地任务的稳定随机键，8–160 字符>
Content-Type: application/json
Authorization: Bearer <古龙桌面访问令牌>

{
  "capability_id": "gulong_engine.tts",
  "capability_version": "1.0.0",
  "source_channel": "desktop_agent",
  "parameters": {
    "model": "<availability.models 某一条目的原始 id>",
    "text": "欢迎使用古龙。",
    "voice_id": "<同一条目的 voice_id>",
    "language": "zh-CN",
    "speed": 1,
    "output_format": "mp3"
  },
  "assets": []
}
```

返回 `201 {order,idempotent}`，`order.billing.price_fen=0`。同一账号和键重试返回原订单；不同请求体复用同键返回 `409 IDEMPOTENCY_KEY_CONFLICT`。按 `GET /api/v1/capability-orders/by-request/{key}` 恢复、`GET /api/v1/capability-orders/{id}` 轮询；`POST /api/v1/capability-orders/by-request/{key}/cancel` 或 `POST /api/v1/capability-orders/{id}/cancel` 取消。完成后 `order.results[0]` 包含 `role=primary_audio`、`content_type`、`bytes`、大写 `sha256` 和 15 分钟短时 `download_url`；不要持久化该 URL，过期重新查询订单。未登录、非本人、套餐失效均不能读取别人的音频。

## 节点

当前新消费者采用自动验收合同，详见 [统一能力自动验收](./unified-capability-orders-v1.md)。上报结构化 `models:[{id,voice_id}]`；每个组合单独探测和记录，探测 `parameters` 原样包含模型与音色。下面的扁平上报仅为历史兼容示例，不能产生新的自动验收模型矩阵。

执行端使用既有 `X-Gulong-Account-Binding: gab_...`，以 `POST /api/v1/capability-orders/claim` 上报：

```json
{
  "protocol_version": "gulong-capability-orders-v1",
  "node_id": "stable-anonymous-node-id",
  "node_name": "配音节点",
  "capabilities": [{
    "capability_id": "gulong_engine.tts",
    "capability_version": "1.0.0",
    "protocol_version": "gulong-capability-orders-v1",
    "installed": true,
    "validated": true,
    "enabled": true,
    "sharing_opt_in": true,
    "supported_voices": ["default"],
    "max_concurrent": 1,
    "validation": {
      "tested_at": "<最近30天的真实本机音频推理测试时间，ISO 8601>",
      "artifact_sha256": "<本地模型或运行产物的64位SHA-256>",
      "test_id": "<本机真实音频测试回执ID>"
    }
  }],
  "resources": { "running_task_count": 0, "estimated_total_seconds": 0, "max_concurrent_tasks": 1 }
}
```

`dry_run:true` 只验证连接和上报，不领取订单。正式领取按老订单优先及节点预计负载调度；共享别人的订单必须显式 `sharing_opt_in:true`，只投给支持该 `voice_id` 的节点。`task` 不下发请求人的邮箱或钱包信息。首次 `started` 回调需 `estimated_total_seconds`，后续 `progress` 回调更新百分比并续租；执行端每 15 秒查询 `task.worker_state.url`，在取消时停止推理。

生成一个 `mp3` 或 `wav` 文件，最大 32 MiB，先本地计算真实字节数和大写 SHA-256。调用 `POST /api/v1/capability-orders/{id}/outputs/presign`，请求包含 `claim_id`、`role:"primary_audio"`、`filename`、`content_type:"audio/mpeg"`（mp3）或 `"audio/wav"`（wav）、`bytes`、`sha256`。按返回的 `method:"PUT"`、`upload_url` 和全部 `required_headers` 直传 COS，文件不经过官网请求体。最后调用 `POST /api/v1/capability-orders/callback`：

```json
{
  "order_id": "<task.id>",
  "claim_id": "<task.claim_id>",
  "event_id": "<同一完成事件的稳定唯一ID>",
  "status": "completed",
  "outputs": [{ "output_id": "<票据中的output_id>" }]
}
```

服务端先校验 claim、节点绑定、COS HEAD 大小与对象元数据，再对最多 32 MiB 的私有音频做实际内容 SHA-256 核验；不接受伪造 URL、仅伪造 `x-cos-meta-sha256` 或上传了其它内容的文件。摘要不一致返回 `409 OUTPUT_CONTENT_HASH_MISMATCH`；COS 暂不可读返回 `503 OUTPUT_VERIFICATION_UNAVAILABLE`，使用原 `event_id` 重试。成功后只写入一次订单完成和结果记录。节点运行模型、声音授权与商业使用合规由节点经营者负责。

## 联调门禁

生产目录显示 `offline` 时仅代表后端合同已上线，**不代表已有真实 TTS 处理器**。端到端验收必须由已激活且绑定古龙账号的节点完成真实音频推理、上报验证、领取订单、COS 直传、成功回调，再由下单本人下载并核对 `sha256`；不得用模拟回执冒充生产联调成功。
