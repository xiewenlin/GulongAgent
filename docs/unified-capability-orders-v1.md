# 古龙官网统一能力订单 v1

协议版本：`gulong-capability-orders-v1`

本合同用于调用同一官网账户下，本机或已配对局域网节点中真实安装并完成推理验收的本地能力。BIN 分卷、模型附件和 runtime 是安装组成，不是独立能力订单。

MiniMax H3 视频继续使用 `/api/h3/tasks`、`/api/h3/tasks/claim` 与 `/api/h3/tasks/callback`，旧客户端不需要迁移。目录中的 `minimax_h3.video_generation` 只用于发现，并返回 `legacy_route=/api/h3/tasks`。

## 安全边界

- 用户创建、查询、取消订单：官网会话或桌面 Chandler Bearer。
- 节点领取、结果票据、回调：`X-Gulong-Account-Binding: gab_...`。
- 官网只在同一账户的节点之间派单；`preferred_node_id` 也必须属于当前账户。
- 节点能力必须同时声明 `installed=true`、`validated=true`、`enabled=true`。
- `validation.tested_at` 必须是最近 30 天内的真实推理验收时间，`artifact_sha256` 必须是 64 位模型或运行产物摘要。
- worker task 不含需求用户邮箱、用户 ID、价格、钱包流水或内部 binding ID。
- 输入与输出都直接上传私有腾讯云 COS；业务请求只携带不透明 ID，二进制不经过 Vercel。

## 能力 ID

| capability_id | 能力 |
|---|---|
| `qwen_image_2_1.text_to_image` | Qwen Image 2.1 文生图 |
| `qwen_image_2_1.multi_image_edit` | Qwen Image 2.1 多图编辑 |
| `minimax_music_3.generate` | MiniMax Music3 |
| `yue_2.generate` | YuE2 音乐生成 |
| `breeze_tts_2.synthesize` | Breeze TTS2；等待独立队列适配与许可证确认，不可派单 |
| `whisper.transcribe` | Whisper 转录 |
| `sam.segment` | SAM 单图对象分割；等待独立适配器，不可派单 |
| `sam.video_track` | SAM 视频对象分割与跟踪 |
| `mediapipe.pose_track` | MediaPipe 单一姿态轨迹；等待独立适配器，不可派单 |
| `mediapipe.video_analysis` | MediaPipe 完整视频分析流水线 |
| `dwpose.estimate` | DWPose pose-control 前处理；等待独立适配器，不可派单 |
| `prompt.optimize_translate` | 提示词优化/翻译 |
| `minimax_h3.video_generation` | 发现项；继续使用旧 H3 视频接口 |

官网不会根据安装介质名称猜测能力。桌面后续新增能力时，需要把新的、已完成真实推理验收的稳定 `capability_id` 与 MIME/资源上限加入官网目录后才能接单。

`orientation-detector` 只属于视频方向 QC 内部依赖，不是独立订单能力，禁止上报。YuE2 与 Breeze TTS2 当前标记为 `commercial_use=license_review_required`；在双方确认许可证允许商业使用前，价格固定为 0，不能进入商业收费订单。目录中的 `dispatchable=false / adapter_status=adapter_required` 项只能用于能力发现；节点上报会收到 `CAPABILITY_ADAPTER_REQUIRED`，官网也拒绝创建该类订单。

`english_coach.*` 四项能力现统一为 `dispatchable=false / adapter_status=local_only`：新建订单及新录音素材上传返回 `409 CAPABILITY_LOCAL_ONLY`。已存在的合法旧订单可按原鉴权、租约与幂等合同继续完成、查询和取消；此兼容路径不会产生新英语订单，也不影响其他产品的共享 ASR/TTS 能力。

## 机器可读能力合同

目录中每个可调用能力都返回以下机器可读字段：

- `parameters_schema_version=1.0.0`
- `parameters_schema`：JSON Schema；`additionalProperties=false`，未知字段直接返回 `INVALID_CAPABILITY_PARAMETERS`。
- `input_assets[]`：`role/min_count/max_count/mime_types/max_bytes_per_file`。
- `outputs[]`：`role/min_count/max_count/mime_types/max_bytes_per_file`。
- `execution`：领取租约、续租事件、worker 状态查询地址、默认 ETA、最大运行时间和重试上限。

服务端会补入 Schema 中声明的默认值，再把规范化后的完整 `parameters` 下发给执行节点；桌面端不需要猜默认值。

创建订单时 `capability_version` 可省略，表示接受同能力任一已验证版本；调度成功后订单会锁定并返回执行节点真实上报的版本。若显式填写，则只会分配版本完全一致的节点。

### parameters 1.0.0

| capability_id | 必填参数 | 可选参数及精确边界 |
|---|---|---|
| `qwen_image_2_1.text_to_image` | `prompt` 1–8000 字符 | `negative_prompt` ≤4000；`width/height` ∈ 512/768/1024/1280/1536，默认 1024；`steps` 1–100，默认 30；`guidance_scale` 0–20，默认 4；`seed` -1–2147483647；`batch_size` 1–4 |
| `qwen_image_2_1.multi_image_edit` | `prompt` 1–8000 字符 | 同文生图，另有 `edit_strength` 0–1，默认 0.75 |
| `minimax_music_3.generate` | `prompt` 1–4000 字符 | `lyrics` ≤12000；`duration_seconds` 10–300；`language`=auto/zh/en/ja/ko/instrumental；`sample_rate`=44100/48000；`output_format`=mp3/wav/flac；`seed` -1–2147483647 |
| `yue_2.generate` | `prompt` 1–4000、`lyrics` 1–16000 字符 | `duration_seconds` 10–600；`language`=zh/en/ja/ko/multilingual；`sample_rate`=44100/48000；`output_format`=mp3/wav/flac；`seed` -1–2147483647 |
| `breeze_tts_2.synthesize` | `text` 1–12000 字符 | `language`=zh-CN/en-US/ja-JP/ko-KR；`voice_id` 1–120；`speed` 0.5–2；`pitch_semitones` -12–12；`sample_rate`=16000/22050/24000/44100/48000；`output_format`=mp3/wav/flac；`seed` -1–2147483647 |
| `whisper.transcribe` | 无 | `task`=transcribe/translate；`language`=auto 或 BCP-47 简码；`initial_prompt` ≤4000；`word_timestamps` 布尔；`output_format`=json/txt/vtt/srt |
| `sam.segment` | 无 | `mode`=everything/points/box；`points` 最多 64 个 `{x,y,label}`，x/y 为 0–1，label 为 0/1；`box` 为 4 个 0–1 数值；`multimask` 布尔；`output_format`=mask_png/json/both。points/box 模式必须提交对应数据 |
| `sam.video_track` | 无 | `prompt_mode`=everything/points/box；点/框规则同上；`start_frame` 0–1000000；`end_frame`=-1 或不小于 start_frame；`sample_fps` 1–60；`output_format`=mask_video/tracks_json/both |
| `mediapipe.pose_track` | 无 | `model_complexity` 0–2；检测/跟踪置信度 0–1；`output_fps` 1–120；`include_world_landmarks` 布尔；`output_format`=json/csv/both |
| `mediapipe.video_analysis` | 无 | `pipelines` 为 pose/hands/face/holistic 中的 1–4 项；`model_complexity` 0–2；检测/跟踪置信度 0–1；`output_fps` 1–120；world landmarks/标注视频开关；`output_format`=json/csv/both |
| `dwpose.estimate` | 无 | `detect_resolution` 128–2048；body/hands/face 开关；`output_fps` 1–60；`output_format`=json/pose_png/both |
| `prompt.optimize_translate` | `text` 1–32000 字符 | `mode`=optimize/translate/optimize_translate；源/目标语言 2–32 字符；`tone`=neutral/cinematic/commercial/technical/natural；`preserve_placeholders` 布尔 |

### 素材与输出 role

| capability_id | 输入素材合同 | 输出合同 |
|---|---|---|
| Qwen 文生图 | 无 | `primary_image` 1–4，PNG/JPEG/WebP，每个 ≤256 MB |
| Qwen 多图编辑 | `reference_image` 1–9，PNG/JPEG/WebP，每个 ≤512 MB | `primary_image` 1–4，PNG/JPEG/WebP，每个 ≤256 MB |
| MiniMax Music3 | `reference_audio` 0–1，MP3/WAV/FLAC，每个 ≤512 MB | `primary_audio` 1，MP3/WAV/FLAC，≤1 GB |
| YuE2 | `melody_reference` 0–1、`vocal_reference` 0–1，MP3/WAV/FLAC，每个 ≤512 MB | `primary_audio` 1，MP3/WAV/FLAC，≤1 GB |
| Breeze TTS2 | `voice_reference` 0–1，MP3/WAV/FLAC，≤256 MB | `primary_audio` 1，MP3/WAV/FLAC，≤512 MB |
| Whisper | `media` 1，MP3/WAV/FLAC/MP4/WebM/MOV，≤2 GB | `transcript_json` 0–1；`transcript_text` 0–1（TXT/VTT/SRT）；也可返回 ≤64 KB 内联结果 |
| SAM | `source_image` 1，PNG/JPEG/WebP，≤512 MB | `mask_image` 0–1 PNG；`segments_json` 0–1；也可返回 ≤64 KB 内联结果 |
| SAM 视频跟踪 | `source_video` 1，MP4/WebM/MOV，≤2 GB | `mask_video` 0–1 MP4/WebM；`tracks_json` 0–1；也可返回 ≤64 KB 内联结果 |
| MediaPipe | `source_video` 1，MP4/WebM/MOV，≤2 GB | `pose_json` 0–1；`pose_csv` 0–1；也可返回 ≤64 KB 内联结果 |
| MediaPipe 视频分析 | `source_video` 1，MP4/WebM/MOV，≤2 GB | `analysis_json` 0–1；`analysis_csv` 0–1；`annotated_video` 0–1；也可返回 ≤64 KB 内联结果 |
| DWPose | `source_media` 1，PNG/JPEG/WebP/MP4/WebM，≤2 GB | `pose_json` 0–1；`pose_image` 0–1 PNG；也可返回 ≤64 KB 内联结果 |
| 提示词优化/翻译 | 无 | `result_json` 或 `result_text` 各 0–1；也可返回 ≤64 KB 内联结果 |

## 用户接口

### 目录

`GET /api/v1/capability-orders/catalog`

返回每个能力的协议版本、输入/输出 MIME、素材数、总输入字节上限、价格和旧路由。

### 输入素材

1. `POST /api/v1/capability-assets/presign`

```json
{
  "filename": "voice.wav",
  "content_type": "audio/wav",
  "bytes": 123456,
  "sha256": "64位十六进制摘要"
}
```

2. 使用响应中的 `upload_url`、`method=PUT` 和全部 `headers` 直传 COS。
3. `POST /api/v1/capability-assets/{asset_id}/complete`

官网 HEAD 核对大小、SHA-256、账户和素材编号后才把 `asset_id` 标为可用。

### 创建订单

`POST /api/v1/capability-orders`

请求头：`Idempotency-Key: 8–160 字符稳定键`

```json
{
  "source_channel": "desktop_agent",
  "capability_id": "qwen_image_2_1.multi_image_edit",
  "capability_version": "2.1",
  "parameters": {
    "prompt": "保持人物身份，把背景改成雨夜街道",
    "width": 1024,
    "height": 1024,
    "steps": 30,
    "seed": -1
  },
  "assets": [
    { "asset_id": "Mongo ObjectId", "role": "reference_1" }
  ],
  "preferred_node_id": null,
  "max_attempts": 2
}
```

服务端按规范化参数、素材摘要和指定节点生成请求指纹。同一账户和幂等键只能对应一个请求。

v1 本地能力订单价格固定为 0 分，`charge_status=exempt`、`refund_status=not_applicable`，不扣钱包、不产生节点佣金。后续启用付费时必须由官网增加服务器端价格版本和原子账本，桌面不得自报价。

### 查询与取消

- `GET /api/v1/capability-orders/{id}`：返回进度、阶段、已用时间、ETA、重试次数、指定节点与结果；排队时另有 `queue_position` 和 `estimated_wait_seconds`，后者在无空闲已验收节点时为 `null`。结果下载地址每次查询重新签发，15 分钟有效。
- `POST /api/v1/capability-orders/{id}/cancel`：幂等取消；未完成的输出票据立即过期。v1 零费用订单无退款流水。
- 执行节点通过 `GET /api/v1/capability-orders/{id}/worker-state?claim_id=...` 每 15 秒检查取消与租约；只能使用 `assigned_node` 自己的绑定令牌。`cancellation_requested=true` 或 `should_stop=true` 时立即停止本地任务。

## 节点能力上报与领取

`POST /api/v1/capability-orders/claim`

请求头：`X-Gulong-Account-Binding: gab_...`

```json
{
  "protocol_version": "gulong-capability-orders-v1",
  "node_id": "stable-node-id",
  "node_name": "4090 创作节点",
  "dry_run": false,
  "capabilities": [
    {
      "capability_id": "qwen_image_2_1.multi_image_edit",
      "capability_version": "2.1",
      "protocol_version": "gulong-capability-orders-v1",
      "installed": true,
      "validated": true,
      "enabled": true,
      "max_concurrent": 1,
      "validation": {
        "tested_at": "2026-09-23T08:00:00.000Z",
        "artifact_sha256": "64位模型或运行产物摘要",
        "runtime_version": "desktop-2.1.262-candidate",
        "test_id": "qwen-real-inference-smoke"
      }
    }
  ],
  "resources": {
    "running_task_count": 0,
    "estimated_total_seconds": 0,
    "max_concurrent_tasks": 1,
    "gpu_name": "NVIDIA RTX 4090",
    "vram_total_mb": 24576,
    "vram_free_mb": 22100
  },
  "lan_cluster": {
    "cluster_id": "same-account-lan-cluster",
    "nodes": []
  }
}
```

`dry_run=true` 只验证身份、协议和能力清单，不读取或领取队列。

调度顺序：同账户 → FIFO 最早订单 → `preferred_node_id`（若指定）→ 能力完全匹配 → 有可用并发 → 预计剩余总耗时最短 → 运行任务数最少 → node_id 稳定排序。

领取响应：

```json
{
  "task": {
    "id": "订单ID",
    "order_no": "CAP...",
    "protocol_version": "gulong-capability-orders-v1",
    "capability_id": "qwen_image_2_1.multi_image_edit",
    "capability_version": "2.1",
    "parameters": { "prompt": "..." },
    "assets": [
      {
        "asset_id": "...",
        "role": "reference_1",
        "filename": "ref.png",
        "content_type": "image/png",
        "bytes": 123456,
        "sha256": "...",
        "download_url": "15分钟COS签名GET",
        "download_expires_at": "ISO-8601"
      }
    ],
    "assigned_node": { "node_id": "stable-node-id", "node_name": "4090 创作节点" },
    "claim_id": "高熵领取ID",
    "attempt": 1,
    "max_attempts": 2,
    "progress_callback": {
      "url": "/api/v1/capability-orders/callback",
      "statuses": ["started", "progress", "completed", "failed", "cancelled"],
      "first_required_fields": ["estimated_total_seconds"],
      "renews_lease_on": ["started", "progress"],
      "lease_seconds": 300
    },
    "output_upload": {
      "presign_url": "/api/v1/capability-orders/{id}/outputs/presign",
      "method": "POST",
      "direct_to_cos": true,
      "callback_accepts_files": false
    },
    "worker_state": {
      "method": "GET",
      "url": "/api/v1/capability-orders/{id}/worker-state?claim_id=...",
      "poll_interval_seconds": 15
    },
    "lease_expires_at": "ISO-8601"
  },
  "claim_plan": {
    "protocol_version": "gulong-capability-orders-v1",
    "scheduling": "same_account_fifo_least_estimated_load",
    "selected_node_id": "stable-node-id"
  }
}
```

如果轮询节点不是 `assigned_node`，它只能把最小权限 task 转给同账户局域网目标节点；最终输出票据和回调必须由目标节点自己的 binding token 提交。

## 输出直传

`POST /api/v1/capability-orders/{id}/outputs/presign`

```json
{
  "claim_id": "claim响应中的领取ID",
  "role": "primary_image",
  "filename": "result.png",
  "content_type": "image/png",
  "bytes": 345678,
  "sha256": "64位摘要"
}
```

响应是与订单、claim、执行节点、输出 role、MIME、大小和 SHA-256 绑定的 1 小时 COS PUT 票据。每个输出单独申请一个 `output_id`，完整响应如下；上传时必须原样发送全部 `required_headers`：

```json
{
  "output_id": "高熵输出ID",
  "upload_url": "1小时COS签名PUT",
  "method": "PUT",
  "headers": {
    "Content-Type": "image/png",
    "x-cos-meta-sha256": "64位摘要",
    "x-cos-meta-bytes": "345678",
    "x-cos-meta-capability-order-id": "订单ID",
    "x-cos-meta-capability-output-id": "高熵输出ID",
    "x-cos-meta-node-id-hash": "节点ID摘要"
  },
  "required_headers": {
    "Content-Type": "image/png",
    "x-cos-meta-sha256": "64位摘要",
    "x-cos-meta-bytes": "345678",
    "x-cos-meta-capability-order-id": "订单ID",
    "x-cos-meta-capability-output-id": "高熵输出ID",
    "x-cos-meta-node-id-hash": "节点ID摘要"
  },
  "object_key": "订单专属私有COS路径",
  "expires_at": "ISO-8601",
  "expires_in_seconds": 3600,
  "complete_via": {
    "method": "POST",
    "url": "/api/v1/capability-orders/callback",
    "status": "completed",
    "output_reference": { "output_id": "高熵输出ID" }
  }
}
```

## 进度与完成回调

`POST /api/v1/capability-orders/callback`

开始：

```json
{
  "order_id": "...",
  "claim_id": "...",
  "event_id": "local-job-1:started",
  "local_job_id": "local-job-1",
  "status": "started",
  "stage": "loading_model",
  "progress": 1,
  "elapsed_seconds": 2,
  "estimated_total_seconds": 180,
  "eta_seconds": 178
}
```

进度：

```json
{
  "order_id": "...",
  "claim_id": "...",
  "event_id": "local-job-1:progress:45",
  "local_job_id": "local-job-1",
  "status": "progress",
  "stage": "inference",
  "progress": 45,
  "elapsed_seconds": 80,
  "eta_seconds": 100
}
```

完成：

```json
{
  "order_id": "...",
  "claim_id": "...",
  "event_id": "local-job-1:completed",
  "local_job_id": "local-job-1",
  "status": "completed",
  "elapsed_seconds": 176,
  "outputs": [
    { "output_id": "已完成COS直传的output_id" }
  ]
}
```

Whisper、SAM、MediaPipe、DWPose 和提示词优化等文本/JSON 小结果也可使用不超过 64 KB 的 `inline_result`。二进制必须使用 COS 票据。

失败与重试：

```json
{
  "order_id": "...",
  "claim_id": "...",
  "event_id": "local-job-1:failed:1",
  "status": "failed",
  "error_code": "LOCAL_OUT_OF_VRAM",
  "error_message": "显存不足",
  "retryable": true,
  "retry_after_seconds": 30
}
```

`event_id` 在订单内唯一。可重试失败且未超过 `max_attempts` 时重新排队；claim 租约超时同样重排，达到上限后终止。取消或终态后的迟到回调不会覆盖结果。

领取租约固定为 300 秒。每一次合法的 `started` 或 `progress` 回调都会从服务端收到回调的时刻起重新续满 300 秒；单纯查询 worker-state 不续租。建议执行节点至少每 60 秒提交一次新 `event_id` 的 progress，并每 15 秒查询 worker-state，以便及时收到用户取消通知。

## 本地联调

官网仓库：`C:\Users\YCAI\Documents\Codex\2026-07-28\product-design-plugin-product-design-openai-3\work\GulongAgent`

```powershell
node --test tests/unit/capability-orders.test.mjs
npm test
npm run build
```

在线合同以 `/api/openapi.json` 与 `/api/docs` 为准。
