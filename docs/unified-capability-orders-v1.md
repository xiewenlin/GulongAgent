# 古龙官网统一能力订单 v1

协议版本：`gulong-capability-orders-v1`

本合同用于调用官网账号绑定的本机、已配对局域网或明确加入共享的节点中真实安装并完成推理验收的本地能力。BIN 分卷、模型附件和 runtime 是安装组成，不是独立能力订单。可发现、具备接口适配器、真实自动验收通过和当前有可用节点是不同状态，不能互相替代。

MiniMax H3 视频继续使用 `/api/h3/tasks`、`/api/h3/tasks/claim` 与 `/api/h3/tasks/callback`，旧客户端不需要迁移。目录中的 `minimax_h3.video_generation` 只用于发现，并返回 `legacy_route=/api/h3/tasks`。

## 安全边界

- 用户创建、查询、取消订单：官网会话或桌面 Chandler Bearer。
- 节点领取、结果票据、回调：`X-Gulong-Account-Binding: gab_...`。
- 局域网转发只在同一账户的已绑定节点之间进行；`preferred_node_id` 也必须属于当前账户。`gulong_engine.*` 共享节点还要求有效权益、明确共享授权及官网权威算力分组严格匹配；其他账号的更优节点必须自行携带其绑定令牌拉取，不会把它的任务或票据交给当前轮询者。
- 节点能力必须同时声明 `installed=true`、`validated=true`、`enabled=true`。
- `artifact_sha256` 必须是 64 位模型或运行产物摘要。新增自动验收记录由官网根据实物结果签发并保留 7 天；历史有效人工记录只作原合同兼容，不能再人工新增。原有 30 天能力上报新鲜度不是客户端可自行授予的自动验收资格。
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
    "gpu_state": "idle",
    "gpu_observed_at": "2026-10-18T12:00:00.000Z",
    "current_task_remaining_seconds": 0,
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

调度顺序：有效身份、用户权益、计算组与精确模型/参数/版本匹配 → FIFO 最早订单和显式 `preferred_node_id` 约束 → 原子并发容量 → 新鲜显卡空闲优先 → 当前任务列表总剩余耗时最短 → 运行任务数最少 → node_id 稳定排序。每派出一项任务就重新纳入其预计负载，不能复用上一单的空闲结果。完整资源与跨账号偏好等待规则见下方“统一显卡调度”。

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
    "scheduling": "fifo_gpu_idle_then_shortest_remaining_v1",
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

## 自动共享模型验收（2026-10-18）

协议：`gulong-auto-verification-v1`。管理员页面改为“共享模型状态”，仅查询自动状态，不再上传/编辑 JSON 手工新增验收。旧 `POST /api/admin/capability-consumers/acceptances` 经管理员和来源验证后返回 `410 MANUAL_ACCEPTANCE_RETIRED`；已有未过期有效记录保持兼容。

节点首次上报自动库存后，服务端为该绑定登记 `autoVerificationEnrolledAt`：此后不能用旧的自报 `validated=true` 或历史人工记录绕过自动验收到期/模型交集。未升级的既有消费者暂按原合同兼容，不能把这种兼容显示成“已自动验收”。自动通过的图像模型、配音音色同样只使用实际通过的交集。

自动流程是“真实节点上报 → 空闲时领取受限随机探测 → 调用本次指定模型一次 → 上传实际结果 → 官网校验 → 精确模型自动开放”。不能把所有 `validated`、`contract_tests` 布尔值置为真来代替真实推理；自动验收接口上线也不代表所有节点已安装新消费者或所有模型已经通过。

### 接口与恢复

所有节点接口均使用 `X-Gulong-Account-Binding: gab_...`，响应 `private, no-store`；验收结果绑定当前账号、节点、计算组、制品摘要、完整模型矩阵、能力版本和模型特征。更换模型、维度、音色、制品或分组会使原记录失效，须重新验收。

| 方法与路径 | 用途 |
|---|---|
| `POST /api/v1/capability-verifications/report` | 上报 `{capabilities:[...]}`；每次 1–64 项能力、每能力 1–64 个精确模型、总计最多 256 个模型组合 |
| `POST /api/v1/capability-verifications/next` | 使用 `{dry_run,resources,request_id,lease_token}` 领取一项随机探测；`dry_run=true` 不领取、不消耗预算 |
| `GET /api/v1/capability-verifications/by-request/{key}` | 按稳定请求编号恢复同一探测 |
| `GET /api/v1/capability-verifications/challenges/{id}` | 按 `gcv_...` 编号查询本节点探测 |
| `POST /api/v1/capability-verifications/{id}/outputs` | 为该探测签发一份私有 COS PUT 票据 |
| `POST /api/v1/capability-verifications/{id}/result` | 提交 `{lease_token,status,inline_result,outputs}`，`status=completed|failed`；outputs 只引用 `{output_id}` |
| `GET /api/admin/capability-verifications?binding_id=...&limit=100` | 管理员只读查询自动状态，每次最多 256 项 |

新客户端必须先在本地持久化稳定 `request_id`（1–128 个字母、数字、`_.:-`，首字符字母或数字）和 32 字节随机 `lease_token`（无填充 base64url，精确 43 字符），再请求 `next`；二者必须成对提供。查询恢复接口把同一 secret 放在 `X-Gulong-Verification-Lease` 请求头。官网只存摘要，不在审计中存 secret 或签名 URL。旧客户端省略这两个字段的兼容路径不具备丢响应恢复能力，不应用于新消费者。

正常领取返回 `state=leased`、`lease_valid=true`、`execute_once=true`，以及 `challenge` 中的 `id/expires_at/capability_id/capability_version/artifact_sha256/model/parameters/budget/compute_group_id/node_id/output_upload_required`。探测租约 15 分钟。客户端必须原样调用 `parameters`，不换模型、不裁切参数、不退回远程付费服务。

HTTP 超时不等于请求没创建。必须用原请求编号和原 secret 查询；恢复响应的 `execution_policy=resume_existing_journal_only` 表示只恢复本地既有执行日志，不能把查到的相同 challenge 再推理一次。`preparing/failed/expired/invalidated/not_issued`、`lease_valid=false` 或无法确认原执行状态时不得启动推理，也不得通过换请求编号掩盖未知执行。相同结果重放幂等，不同结果使用同一探测编号返回 `409 VERIFICATION_REPLAY_CONFLICT`。

### 清单、预算与模型范围

清单必须明确 `installed=true`、`enabled=true`、`sharing_opt_in=true`，并提交真实 `artifact_sha256` 与 `models[]`。仅安装但未同意共享的能力不进入探测。对话模型逐项上报 `tools/multimodal`，向量模型逐项上报精确 `dimension`，音乐模型逐项上报 `max_duration_seconds` 及 `asr_languages`；TTS 模型必须携带真实 `voice_id`，不能隐式选择 default。

每个节点最多一项探测，全局最多四项；每节点每天最多 16 次，每个精确模型组合每天最多 3 次，每天新建稳定请求日志最多 64 次。单项最多一次推理，文字探测最多 32 输出 token，音乐/配音最多 12 秒；图像最多一张、最大 2048×2048 像素。预算不足或节点忙时返回空 challenge 并给出重试间隔。失败按 1 分钟起的指数退避重试，最高 1 小时；通过记录 7 天后重新排队验收。自动探测不产生用户订单、钱包扣费或分佣。

| 能力 | 自动适配版本与实物验证 | 仍不代表 |
|---|---|---|
| `gulong_engine.agent_chat` | `1.0.0`；随机回显、完整原始 OpenAI response/model/choices/usage | 未逐项验证的 tools 或 multimodal 不会因纯文字成功而开放 |
| `gulong_engine.text` | `1` 或 `1.0.0`；随机文字回显 | 不能用进程存活或布尔值替代结果 |
| `gulong_engine.embedding` | `1.0.0`；两条随机输入，完整 data 索引、准确维度、非零且不相同的向量 | 不允许裁切、补齐或替换模型/维度 |
| `gulong_engine.music` | `1.0.0`；完整 FLAC 实物大小、SHA、实际时长，完整歌词与整段 ASR 原文 | 12 秒小探测不会证明模型支持任意长时长；目录只开放实际验证范围 |
| `gulong_engine.image` | `1` 或 `1.0.0`；仅原样 `zimage/qwen_image_2_1`，512² PNG 单图 | 其他名字不猜测映射或偷偷替换模型 |
| `gulong_engine.image_2k` | `1.0.0`；原样 `qwen_image_2_1`，原生 2048²、`fast_lora_6`、6 步 PNG | 不以 512² 探测冒充原生 2K |
| `qwen_image_2_1.text_to_image` | 真实旧合同 `2.1`；固定 Qwen、512²、单张 PNG | 不把旧消费者合同强改成 `1.0.0` |
| `gulong_engine.tts` | `1.0.0`；原模型/真实音色、WAV 实物摘要、时长、采样率、声道及非静音 | 未做语音内容 ASR 或发音质量认证 |

其他 capability、未知版本、图像编辑、SAM/Whisper/MediaPipe/DWPose 等需要输入素材的能力在缺少可靠 fixture 或结果验证器时，其本轮自动验收状态保持 `adapter_required`，不得伪造验收；原有业务目录是否可用仍按对应独立合同和真实节点状态判断。统一 `gulong_engine.video` 的新消费者适配未完成前也不因此开放；原生 H3 视频仍走 `/api/h3/tasks`。`english_coach.*` 保持 `local_only`，不会因共享自动验收绕过产品边界。商业许可证仍由节点运营者负责，已有 `license_review_required` 限制不因探测通过消失。

### 媒体探测安全

探测输出只允许本 challenge 专属私有路径：音乐完整 FLAC ≤64 MiB；图像 PNG ≤20 MiB；配音 WAV ≤32 MiB。PUT 有效期不超过 10 分钟且不越过探测租约。官网先比对 HEAD 大小/摘要元数据/节点/challenge/ETag，再使用源 ETag 条件复制至无客户端 PUT 授权的 `verified/` 路径，读取副本的全部字节校验 SHA 和实际媒体结构；不能信任客户端 URL 或 JSON 的 `verified=true`。

PNG 校验签名、IHDR、CRC、受界限的像素解压与实际尺寸；TTS WAV 校验采样参数、实际时长和非静音。图像/配音完成时 `inline_result.model` 必须精确匹配本次模型，配音另需 `inline_result.voice_id` 精确匹配矩阵音色。音乐仍须绑定完整音频 SHA 与原始完整歌词 SHA，并验证 `ordered-whole-lyrics-v1` 的整段转录顺序，不能仅给 verified 布尔或省略尾部歌词。

探测上传对象与验证副本在 24 小时后由现有能力维护清理机制幂等删除，失败延后 10 分钟重试；清理只处理本 challenge 专属前缀，不能删除用户作品或其他订单对象。

## 统一显卡调度与物理任务槽

`/api/v1/capability-orders/claim` 与原生 `/api/h3/tasks/claim` 都使用 `claim_plan.scheduling=fifo_gpu_idle_then_shortest_remaining_v1`。每次拉单应上送：

```json
{
  "resources": {
    "gpu_state": "idle",
    "gpu_observed_at": "2026-10-18T12:00:00.000Z",
    "current_task_remaining_seconds": 0,
    "running_task_count": 0
  }
}
```

`gpu_state` 仅为 `idle|busy|unknown`；利用率为零、缺字段或缺采集时间不能推定空闲。显卡状态最多新鲜 30 秒，未来时钟偏移最多 5 秒；过期状态降为 unknown。`current_task_remaining_seconds` 为完整当前任务列表的预计剩余总秒数（0–2678400）；未知传 null 或不传，不得按零耗时抢先；显式 0 仍为真实已知零。老 `estimated_total_seconds` 保留兼容。采集时间之后官网新派出的租约会追加进当前工作量；既有租约为总负载提供下界，防止旧空闲报告反复领单。已知有限负载排在未知 ETA 前，显式空闲仍优先于忙碌/未知显卡。

LAN 节点可在各自的 `lan_cluster.nodes[].resources` 独立上报，必须全部属于当前账号，并由被指派节点自己的绑定令牌执行回调。服务端只比较近 3 分钟的有效认证报告，并先过滤当前计算组、权益、精确模型、参数范围及原子容量；不匹配的空闲设备不能抢别组任务。发现更优的全局节点不属于本次合法 LAN 时，只保留原 FIFO 任务等它自行拉取，绝不向当前轮询者泄漏其任务、绑定或 COS 票据。偏好等待用订单 CAS 记时，最多 5 秒，防止已离线的更优节点造成永久饥饿。

统一能力空轮询用 `claim_plan.waiting_for_preferred_node=true`；H3 使用 `queue_reason_code=PREFERRED_NODE_POLL_WAIT` 与 `preferred_node_wait_ms`。两者都不代表任务失败。H3 当前每轮候选预算最多 200 个（含最多 64 个同账号 LAN 节点），其余按最新全局认证报告补足；超过预算的部署应扩展分片快照，不能据此声称无限节点下的全局最优。

`capabilityNodeSlots` 是原生 H3、统一业务和自动探测共用的物理 CAS 准入边界。任务必须先预留再原子领取，领取失败或签发票据失败精确释放；探测持有独占租约时，业务并发槽为零。运行中取消不会提前释放槽位，待节点确认停止后才释放，防止仍在运行的任务与新探测重叠。终态重复回调不能重复释放其他任务的槽，也不能重复扣费、退款或分账。

原生 H3 worker task 与回调响应新增 `claim_lease_expires_at`；其 `progress_callback` 提供 `interval_seconds=15`、`lease_seconds=2700`、`on_lease_expired=stop_task_and_wait_for_redispatch`。节点必须定期回调续租并遵守本地 watchdog；到截止时间、收到取消或 `409 H3_PHYSICAL_SLOT_EXPIRED` 时停止对应精确任务。新 H3 物理槽过期不能用迟到回调复活；旧无物理槽标记的任务仍可按旧合同完成，不强制中断既有作业。物理槽属于官网内部状态，worker DTO 不含其 claim ID、binding ID、需求用户或账务隐私字段。
