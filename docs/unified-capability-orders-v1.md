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
| `sam.video_track` | text 模式必填 `text_prompts` | `prompt_mode`=everything/text/points/box；text 模式为 1–8 个非空对象提示，每项≤200字符，不能混入点/框；其他模式禁止夹带文字提示。点/框规则同上；`start_frame` 0–1000000；`end_frame`=-1 或不小于 start_frame；可选 `sample_fps` 1–60，省略表示保留完整原帧，不隐式请求24FPS；`output_format`=mask_video/tracks_json/both/native_layers。消费者必须与已验证范围匹配，不能静默忽略未支持的参数 |
| `mediapipe.pose_track` | 无 | `model_complexity` 0–2；检测/跟踪置信度 0–1；`output_fps` 1–120；`include_world_landmarks` 布尔；`output_format`=json/csv/both |
| `mediapipe.video_analysis` | 无 | `pipelines` 为 pose/hands/face/holistic 中的 1–4 项；`model_complexity` 0–2；检测/跟踪置信度 0–1；可选 `output_fps` 1–120（省略保留原帧）；world landmarks/标注视频开关；`output_format`=json/csv/both/native_layers |
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
| SAM 视频跟踪 | `source_video` 1，MP4/WebM/MOV，≤2 GB | 旧模式 `mask_video` 0–1 MP4/WebM；`tracks_json` 0–1；`native_layers` 必须恰好 `manifest_json`、`tracks_jsonl`、`mask_archive` 各1份，不得以 JSONL 冒充视频或 JSON |
| MediaPipe | `source_video` 1，MP4/WebM/MOV，≤2 GB | `pose_json` 0–1；`pose_csv` 0–1；也可返回 ≤64 KB 内联结果 |
| MediaPipe 视频分析 | `source_video` 1，MP4/WebM/MOV，≤2 GB | 旧模式 `analysis_json` 0–1；`analysis_csv` 0–1；`annotated_video` 0–1；`native_layers` 必须恰好 `analysis_json`、`pose_tracks_jsonl`、`person_layers_archive` 各1份 |
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

### 素材丢响应恢复（新客户端）

新客户端在首次联网前，持久化业务原请求编号与每份素材独立的 `request_key`、产品、能力、角色、完整文件名/MIME/字节/SHA及本地上传阶段。素材请求键为8–160个ASCII字母数字或`_.:-`，首字符字母数字；一个业务有多素材时每份键不同，重启/网络未知后仍用原键，不能自动换键。

```json
{
  "request_key":"task-1234:attachment-1",
  "client_product":"worklucky",
  "capability_id":"qwen_image_2_1.multi_image_edit",
  "role":"reference_image",
  "filename":"source.png","content_type":"image/png","bytes":123456,
  "sha256":"文件的64位SHA256"
}
```

将上述JSON发给 `POST /api/v1/capability-assets/presign`。服务端按账号+原键唯一存储完整规范化清单与产品/能力/角色；同键改清单或跨产品返回409，不创建第二素材。首次201和同请求恢复200使用同一个asset_id/object_key，原1小时上传期限不延期。旧不带request_key的票据保留旧行为，不能追溯编造可恢复编号。

发生presign、PUT或complete响应未知时，只调用：

`GET /api/v1/capability-assets/by-request/{request_key}?product=worklucky`

古龙引擎客户端使用同值`gulong_engine`。Bearer为原登录账户的gge访问令牌（官网会话同样受账号隔离），不允许英语教练窄凭据查询。返回字段：

```json
{
  "asset_id":"原素材ID",
  "asset":{"asset_id":"原素材ID","filename":"source.png","content_type":"image/png","bytes":123456,"sha256":"大写SHA256"},
  "client_product":"worklucky","capability_id":"qwen_image_2_1.multi_image_edit","role":"reference_image",
  "idempotent":true,"stage":"uploaded","can_upload":false,"can_complete":true
}
```

| HTTP / stage | 客户端允许的下一步 |
|---|---|
| 200 `awaiting_upload` | COS明确404、存储防覆盖与CORS已核对。响应额外有原asset_id对应的`upload_url/method/headers/object_key/expires_at`；只向原对象PUT原完整字节，所有headers必须保留 |
| 200 `uploaded` | HEAD大小、MIME、摘要元数据、owner及asset ID完整一致；不含PUT。只POST原asset_id的complete |
| 200 `ready` | 原完成回执；不含PUT，不重传。沿用原业务Idempotency-Key下单，或GET已取得的原订单 |
| 404 | 本账户尚无该键；可重发同一完整清单的原presign POST，唯一索引合并并发，不改键/不直接PUT |
| 409 `mismatch/rejected` 或产品冲突 | 停止覆盖和重传，保留原日志供处理 |
| 410 `expired` | 原授权已过期，不续期、不自动创建新素材/新任务 |
| 503 `unknown` | 状态尚不明确；只退避重试同一GET，不发PUT、complete或新业务任务 |

GET不改变素材状态，不删除对象，不创建业务订单，不扣款/分佣。并发同键只生成一个素材意图。已标记产品的素材在完成、下单引用时继续匹配产品、能力和角色，不能拿WorkLucky素材给其他产品或其他输入用途。其他账号查询返回404，不泄露清单或凭据。

新素材完成使用 `POST /api/v1/capability-assets/{asset_id}/complete?product=worklucky`（或gulong_engine），成功 `{asset:{...},idempotent:false}`；重复完成同回执且`idempotent:true`。CAS状态已变化时不得虚假返回成功。即使包月之后到期，原GET/完成回执仍可恢复；新业务订单必须重新通过当前权益门禁。旧未标记素材complete不带product即可。

防覆盖PUT签名固定包含`x-cos-forbid-overwrite:true`，并在签发前只读核对COS版本策略。腾讯云明确说明版本控制开启时此header无效；因此当前实现对Enabled、Suspended或读取失败都不发新防覆盖凭据，不能为了续传擅自关闭桶版本控制。桶配置未知/无`cos:GetBucketVersioning`权限会得到503，联系管理员核对，不能绕过。参见[腾讯云PUT Object合同](https://cloud.tencent.com/document/product/436/7749)。PUT遇到对象已存在冲突时应GET原请求，不能删原对象再重传。短期URL/令牌不写入持久日志。

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

旧版请求首次上报后保存绑定级 `autoVerificationEnrolledAt`，仍按原绑定级严格策略处理，不允许静默回退。新消费者使用下面的 `capability-v2` 逐能力策略；不能把未迁移能力的历史兼容显示成“已自动验收”。自动通过的图像模型、配音音色同样只使用实际通过的交集。

### 完整库存与逐能力迁移（capability-v2）

节点必须继续上报完整的已安装、启用和共享选择库存，不通过只报三项来隐去其他能力。新消费者首次及后续自动上报均使用专属 `POST /api/v1/capability-verifications/report-v2`，不能回退 `/report`：旧服务器可能忽略新 JSON 字段而误入绑定级迁移，专属 URL 在旧部署只会返回404且不写入。请求：

```json
{
  "migration_policy": "capability-v2",
  "automatic_capability_ids": ["gulong_engine.agent_chat", "gulong_engine.embedding", "gulong_engine.music"],
  "capabilities": [
    {"capability_id":"gulong_engine.agent_chat","capability_version":"1.0.0","installed":true,"enabled":true,"sharing_opt_in":true,"artifact_sha256":"0000000000000000000000000000000000000000000000000000000000000000","models":[{"id":"actual-chat-model","tools":false,"multimodal":false}]},
    {"capability_id":"gulong_engine.embedding","capability_version":"1.0.0","installed":true,"enabled":true,"sharing_opt_in":true,"artifact_sha256":"0000000000000000000000000000000000000000000000000000000000000000","models":[{"id":"actual-vector-model","dimension":1024}]},
    {"capability_id":"gulong_engine.music","capability_version":"1.0.0","installed":true,"enabled":true,"sharing_opt_in":true,"artifact_sha256":"0000000000000000000000000000000000000000000000000000000000000000","models":[{"id":"actual-music-model","max_duration_seconds":300}],"asr_languages":["zh"]},
    {"capability_id":"gulong_engine.video","capability_version":"1.0.0","installed":true,"enabled":true,"sharing_opt_in":true,"artifact_sha256":"0000000000000000000000000000000000000000000000000000000000000000","models":[{"id":"minimax_h3"}]}
  ]
}
```

示例中的模型名、零摘要及安装选择仅说明数据类型，必须替换为该节点的真实值，并继续保留实际存在的其他能力。`capabilities` 每项仍遵守下述模型/制品合同。`automatic_capability_ids` 为 0–64 个不重复且存在于本次库存的能力 ID，新追加能力的每个模型都必须有实际服务器适配器，否则整个请求在登记迁移前返回 `409 VERIFICATION_CAPABILITY_NOT_MIGRATABLE`。已迁移能力出现未知版本或未适配的新变体时仍接受完整库存、使旧矩阵失效并保持 `adapter_required`，不能因更新被拒而继续使用旧证明。该列表是消费者自动升级的范围选择，不是人工新增验收，也不会批准其模型。

- 服务端原子追加 `autoVerificationCapabilityIds`，保存 `autoVerificationPolicy=capability-v2`；重试、并发上报、列表清空或库存遗漏只能扩展，不能撤销已迁移 ID。
- 已迁移能力采用自动结果的精确交集；pending、失败、到期、禁用、制品/模型/分组变更均禁止回退到旧 GCA 或客户端 `validated=true`。
- 未迁移能力记录为 `migration_deferred`，不会领取自动探测，仅保留原有能力版本、验证新鲜度、制品、GCA（若该原合同要求）、产品、算力分组和资源槽位规则。没有旧证明的能力仍不可用；不新建 GCA、不延长旧有效期、不为新制品继承旧证明、不放开原本 `dispatchable=false` 的能力。原生 H3 独立接口也不因另一个能力迁移而被整绑定停用。
- v2 **尚未迁移且不在本次迁移列表**的能力允许原样上报有界原生版本：1–120位，匹配 `[A-Za-z0-9][A-Za-z0-9_.+-]*`；不截断、不替换为假 `1.0.0`，原值参与库存指纹，拒绝空白、控制字符和路径分隔符。自动迁移能力只接受对应适配器的精确版本白名单：既有 `gulong_engine.*` 数字合同版本不变，下面明确注册的原生能力可以使用其真实组件修订号。注册原生能力的未知有界修订可进入库存但没有适配器，已迁移时旧矩阵失效，首次迁移则拒绝，不借此恢复旧证明。该库存兼容不新授予资格。
- 输入 fixture 和对应结果校验器已接入的原生能力仍须先部署节点消费者再实测，不能把文生图通过当作图像编辑、SAM、转录或姿态分析通过；未实现的统一 video/TTS 消费者继续保留库存，不提前追加迁移 ID。
- 已经是 v1 绑定级策略的节点请求 v2 返回 `409 VERIFICATION_MIGRATION_REVIEW_REQUIRED`，不通过客户端改变策略解除原保护；需要独立迁移审计。v2 节点以后每次 `/report` 都必须沿用策略，省略则返回 `409 VERIFICATION_POLICY_REQUIRED`。
- 新客户端只调用 `/report-v2`，必须确认响应 `migration.policy=capability-v2`；404、缺少确认或网络未知结果时停止自动登记/恢复原请求，不尝试旧 `/report`。旧 `/report` 保留 v1 行为并兼容显式 v2，但不推荐新消费者使用。已有 v2 节点投入使用后，不应把生产回滚到不识别逐能力策略的旧版本。
- 返回 `migration.policy`、累计 `migration.automatic_capability_ids` 和逐能力 `{capability_id,mode,all_models_have_adapter}`。`mode=legacy_compatibility` 不是已验证或已在线；实时鉴权目录才是派单依据。`all_models_have_adapter=true` 也不代表所有参数/输入模式已通过。

只迁移某项能力时，其他能力的有效历史资格不能受影响；领取最后一次绑定复核仍按订单的具体 capability 做迁移检查。迁移前已合法领取的任务可以按原 fenced lease 完成，不得为了迁移取消现有任务、重复执行或写新账务。

库存登记与探测领取的未知结果不能混用：`report-v2` 在超时/5xx后可退避并沿用同一真实库存重试同一URL，单调迁移不会重复领取探测或创建业务订单；没有正确的策略确认前不调用 `next`。`next` 可能已经领取探测，其未知响应必须按原 `request_id` 和 secret 通过 GET 恢复，不能换新请求重跑模型。404或策略不符时绝不改用旧 `/report`。

自动流程是“真实节点上报 → 空闲时领取受限随机探测 → 调用本次指定模型一次 → 上传实际结果 → 官网校验 → 精确模型自动开放”。不能把所有 `validated`、`contract_tests` 布尔值置为真来代替真实推理；自动验收接口上线也不代表所有节点已安装新消费者或所有模型已经通过。

### 接口与恢复

所有节点接口均使用 `X-Gulong-Account-Binding: gab_...`，响应 `private, no-store`；验收结果绑定当前账号、节点、计算组、制品摘要、完整模型矩阵、能力版本和模型特征。更换模型、维度、音色、制品或分组会使原记录失效，须重新验收。

| 方法与路径 | 用途 |
|---|---|
| `POST /api/v1/capability-verifications/report` | 上报 `{capabilities:[...]}`；每次 1–64 项能力、每能力 1–64 个精确模型、总计最多 256 个模型组合 |
| `POST /api/v1/capability-verifications/report-v2` | 新消费者专用；完整库存加 `migration_policy`、`automatic_capability_ids`，旧部署404时禁止回退 |
| `POST /api/v1/capability-verifications/next` | 使用 `{dry_run,resources,request_id,lease_token}` 领取一项随机探测；`dry_run=true` 不领取、不消耗预算 |
| `GET /api/v1/capability-verifications/by-request/{key}` | 按稳定请求编号恢复同一探测 |
| `GET /api/v1/capability-verifications/challenges/{id}` | 按 `gcv_...` 编号查询本节点探测 |
| `POST /api/v1/capability-verifications/{id}/outputs` | 为该探测签发一份私有 COS PUT 票据 |
| `POST /api/v1/capability-verifications/{id}/result` | 提交 `{lease_token,status,inline_result,outputs}`，`status=completed|failed`；outputs 只引用 `{output_id}` |
| `GET /api/admin/capability-verifications?binding_id=...&limit=100` | 管理员只读查询自动状态，每次最多 256 项 |

新客户端必须先在本地持久化稳定 `request_id`（1–128 个字母、数字、`_.:-`，首字符字母或数字）和 32 字节随机 `lease_token`（无填充 base64url，精确 43 字符），再请求 `next`；二者必须成对提供。查询恢复接口把同一 secret 放在 `X-Gulong-Verification-Lease` 请求头。官网只存摘要，不在审计中存 secret 或签名 URL。旧客户端省略这两个字段的兼容路径不具备丢响应恢复能力，不应用于新消费者。

正常领取返回 `state=leased`、`lease_valid=true`、`execute_once=true`，以及 `challenge` 中的 `id/expires_at/capability_id/capability_version/artifact_sha256/model/parameters/budget/compute_group_id/node_id/output_upload_required`。探测租约 15 分钟。客户端必须原样调用 `parameters`，不换模型、不裁切参数、不退回远程付费服务。

验收状态中的 `model` 是原始已安装库存；`verified_model` 才是 `active` 时本次真实通过的模型范围，另有服务端 `contract_tests/asr_languages`。失败或失效时这些通过字段为空。特别是音乐库存的 300 秒上限不等于 12 秒探测后的已验证上限；消费者须使用 `verified_model`，业务目录和派单始终以服务端已通过交集为准。

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
| `qwen_image_2_1.text_to_image` | 真实旧合同 `2.1`；原样模型 `qwen_image_2_1` 或真实组件 `qwen-image21-uc`、512²、单张 PNG | 不把旧消费者合同强改成 `1.0.0`，不把组件名映射为另一个模型 |
| `gulong_engine.tts` | `1.0.0`；原模型/真实音色、WAV 实物摘要、时长、采样率、声道及非静音 | 未做语音内容 ASR 或发音质量认证 |

图像自动验收按**实际已测范围**签发，不把模型名称当成全部图像功能的通行证。`verified_model` 与目录 `availability.models` 保留以下简单标量字段：

- `gulong_engine.image`：`{id,task:"text_to_image",input_asset_count:0,width:512,height:512}`。
- `gulong_engine.image_2k`：`{id:"qwen_image_2_1",task:"text_to_image",input_asset_count:0,width:2048,height:2048,generation_mode:"fast_lora_6",steps:6,prompt_enhancement:"none"}`。
- 自动验收的旧 `qwen_image_2_1.text_to_image`：`{id:"qwen_image_2_1"或"qwen-image21-uc",task:"text_to_image",input_asset_count:0,width:512,height:512,steps:4,guidance_scale:4,batch_size:1}`，ID 保持实际请求值。

创建和领取均按该范围匹配；原生 `image` 省略 task 视为文生图，但带任何参考素材仍拒绝。未测试的多图编辑、参考图路径、画布和 2K 标准/提示词增强模式不得从无参考图探测扩大开放。提示词、负向描述、随机种子仍可正常更改。显式上报编辑 task 的清单保持 `adapter_required`，不替换为文生图测试。历史自动记录若缺少范围或 `exact_image_scope` 证明，立即不再公开/派单，并在下一次清单上报时自动重新排队；原有明确验收的历史非自动消费者合同不因此改变。清单仍可只上报 `{id}`，范围由服务端实测生成，不能让客户端自行宣称范围。

其他 capability、未知版本、DWPose 等在缺少可靠 fixture 或结果验证器时，其自动验收状态保持 `adapter_required`，不得伪造验收；原有业务目录是否可用仍按对应独立合同和真实节点状态判断。统一 `gulong_engine.video` 的新消费者适配未完成前也不因此开放；原生 H3 视频仍走 `/api/h3/tasks`。`english_coach.*` 保持 `local_only`，不会因共享自动验收绕过产品边界。商业许可证仍由节点运营者负责，已有 `license_review_required` 限制不因探测通过消失。

### 自动探测输出的只读恢复（2026-10-19）

PUT响应丢失时，先停止写入，保留原输出文件、完整descriptor、ticket及journal。此入口专属自动验收节点，不是普通用户素材恢复：

```http
GET /api/v1/capability-verifications/{challenge_id}/outputs/{output_id}
X-Gulong-Account-Binding: 原绑定令牌
X-Gulong-Verification-Lease: 原journal中的租约secret
```

不接受query/body来更换文件描述。`challenge_id=gcv_<UUID>`、`output_id`是原POST outputs返回的43位base64url编号。服务器校验当前节点/账号绑定、分组、有效租约和原登记清单；返回`Cache-Control: private, no-store`：

```json
{"ok":true,"challenge_id":"原gcv编号","output_id":"原输出编号","state":"confirmed_present","retry_put_allowed":false,"content_verified":false,"descriptor":{"role":"primary_image","filename":"probe.png","content_type":"image/png","bytes":1234,"sha256":"原64位小写SHA256","object_key":"原专属对象键"},"expires_at":"原ticket到期时间","checked_at":"核对时间","reason_code":null}
```

- `confirmed_present`：HEAD的MIME/字节/SHA声明/节点/挑战/输出ID/角色与原descriptor一致；**不是**实际内容或模型验收通过。只能继续提交原`output_id`到原result，仍需服务器条件复制、全文件SHA、实际媒体/JSON/归档结构及模型验证。
- `confirmed_absent`且`retry_put_allowed=true`：只在直连COS确证原key不存在、原防覆盖策略可读且有效、原票据及挑战仍可写时返回；客户端还须核对原文件完整大小/SHA、原对象键、原全套headers及原期限，随后最多重试原PUT。不能重新推理、换输出ID、换对象、换文件或延长期限。
- `uncertain`：网络/403/非对象404/删除标记/元数据不符/旧无防覆盖票据/桶策略未知等，均`retry_put_allowed=false`。停止写入并保留journal，仅退避只读查询；不得将任意HTTP404当作COS缺文件。[腾讯云错误码](https://cloud.tencent.com/document/api/436/7730)

GET不签PUT或GET URL、不创建输出、不变更验收/预算/清理状态。每绑定每分钟最多60次；HTTP400=格式/额外query，401=绑定失效，403=错误节点/分组/租约，404=`VERIFICATION_OUTPUT_NOT_FOUND`表示此租约没有登记该输出，409=过期/结束/原清单不一致，429=查询限流，503=只读适配器缺失。所有这些错误均禁止PUT，不能解释为`confirmed_absent`。查询期间绑定、分组、任务状态或租约变化会再次拒绝或收紧为uncertain。

新POST outputs票据签名包括`x-cos-forbid-overwrite=true`、原verification/binding/output ID和role；桶版本策略不支持防覆盖时不出票。重复POST只可使用原清单、原output_id/对象和原expires_at，不延长时间；所有headers都必须按原票据发送。旧无防覆盖票据不能续签（409 `VERIFICATION_OUTPUT_LEGACY_TICKET`）且不获得absent重试权限，已上传的旧实物可在原有效期内继续走原全内容result校验。此恢复接口不会扩大任何能力的共享准入范围。

### 原生六能力的固定输入与精确输出（2026-10-19）

以下是服务器验证器合同，不是已发布消费者或所有模型已通过的声明。模型 ID、能力合同版本、模型制品修订分别保存，不相互替代。节点完成真实探测后才在鉴权目录出现 `availability.native_profiles`；客户端必须照该范围下单，不能将固定 schema 的所有参数当成已验收范围。

| 能力 / 版本 | 精确模型与测试参数 | 必须上传的实际结果 |
|---|---|---|
| `qwen_image_2_1.text_to_image` / `2.1` | `qwen-image21-uc`（兼容旧 `qwen_image_2_1`）；512²、4步、guidance=4、batch=1、无参考图 | `primary_image` PNG，实际512² |
| `qwen_image_2_1.multi_image_edit` / `2.1` | `qwen-image21-uc`；1张固定JPEG、512²、4步、guidance=4、batch=1、edit_strength=1 | `primary_image` PNG，实际512²；内联 `model/input_sha256` 精确绑定 |
| `minimax_music_3.generate` / `3` | `MiniMax-Music3`；12秒、44100Hz、FLAC、无参考音频、auto语言，固定随机英文歌词；库存需整段英文ASR | `primary_audio` + `inline_result.lyric_verification` 完整音频/歌词SHA、`full_audio=true`、有序完整ASR原文。实际11–12.05秒；开放上限取实测值且不超过12秒，不按库存300秒开放 |
| `sam.video_track` / `3.1-object-multiplex` | `sam-video-3.1`；`text_prompts=["person"]`、全源帧、无点/框/FPS重采样、`native_layers` | `manifest_json` 原生manifest、`tracks_jsonl` 原生objects.jsonl、`mask_archive` PNG归档；16帧全部有真实非空人物蒙版 |
| `whisper.transcribe` / `large-v3-turbo-whisper.cpp` | `whisper-large-v3-turbo`；11秒完整固定FLAC、auto语言、transcribe、无initial_prompt、无word timestamps、json | `transcript_json` 原始whisper.cpp JSON；原生毫秒offsets、完整英文句段含末句。不能改造成客户端“verified”摘要 |
| `mediapipe.video_analysis` / `0.10.14-pose-full` | `mediapipe-pose-full-0.10.14`；pose、complexity=1、两置信度0.5、完整源帧、无world/annotated/FPS重采样、`native_layers` | `analysis_json` 原生evidence、`pose_tracks_jsonl` 连续16帧、`person_layers_archive`；真实33点和匹配人物蒙版，不接受全空轨迹 |

SAM 的 manifest/轨迹/蒙版不能冒充 `mask_video`；MediaPipe 同样不能把 JSON 文件改名当视频。业务 `native_layers` 输出角色必须三份各一次；claim 的 `required_output_roles` 和目录 schema 是机器可读依据。原生音乐合同版本 `3` 不等于模型修订 `Music3 INT8 ConvRot`；图像合同版本 `2.1` 也不凭空生成模型版本。

带输入的探测新增：

```json
{
  "input_assets": [{"fixture_id":"registered-source-v1","role":"source_video","filename":"fixture.mp4","content_type":"video/mp4","bytes":62832,"sha256":"实际固定SHA256","download_url":"短期HTTPS签名GET","expires_at":"ISO时间"}],
  "output_requirements": [{"role":"tracks_jsonl","content_types":["application/x-ndjson"],"max_bytes":4194304,"min_count":1,"max_count":1}]
}
```

上例只说明字段，实际 challenge 同时携带全部必需输出。输入描述符固定于服务器适配器：最多3份/总8MiB，单份≤4MiB；不能传任意客户端URL或对象键。下载后先核对完整大小与SHA，再执行一次。GET票据≤5分钟且不越过租约，COS准备后再次检查租约；恢复只刷新同一输入下载票据，不增加推理。终态返回无URL描述符，绝不重跑。不要向COS或本地模型转发官网账号/绑定令牌。

固定源文件及出处见 `server/probe-fixtures/README.md`。2秒/16帧人物视频由一张真实源照片重复编码，仅验证逐帧处理、人物检测及结果链路，不是动态跟踪质量、任意长视频或性能认证。Whisper处理完整11秒音频，音乐只生成一次并整段ASR；任何未验证的参数组合仍会在入队前拒绝。

六类原生能力使用跨账户共享时，创建JSON带 `client_product=gulong_engine` 或 `worklucky`，查询/恢复带同值 `?product=`，取消JSON带相同 `client_product`；幂等键不能跨产品复用。古龙引擎桌面凭据也自动进入此共享边界。需要有效古龙引擎包月（管理员除外）、节点明确共享、服务端自动验收证明、相同算力分组及物理槽位；价格0分，不扣余额、不分佣。未标记的历史同账户原生任务保留原合同，不借其绕过新共享验收。新建素材票据可带精确 `capability_id`，以对应目录 MIME/大小上限允许ASR音频、SAM/姿态视频，不依赖尚未完成的统一视频能力。

### 多文件输出安全

探测 `outputs` 最多4个不重复的本租约 `output_id`，每个role的MIME/数量/大小由 `output_requirements` 决定，不能替换成URL或内联布尔。JSON≤1MiB，JSONL≤4MiB；JSONL保留完整逐帧记录并拒绝空行、非法UTF-8和原型污染键。蒙版ZIP≤32MiB/128条/解压总32MiB/单文件4MiB，仅接受安全相对路径的PNG及小型README，不落盘解包、不跟随链接；逐项验证CRC、实际解压大小及PNG像素，蒙版单图≤1024²、总像素≤16Mi。JSON、JSONL和归档与媒体一样经过私有条件复制和实际全文件SHA校验，按24小时探测输出生命周期清理。

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

## 一次性音乐补测：发布审定额度（2026-10-20，OpenAPI 2.14.2）

人类在 H3 归属会话明确要求解决当前音乐验收额度阻断后，本次发布只为经审定的单一绑定、匿名节点、当前执行制品 `f8bb182e7059eefe075567f37617324e4105dbfd81426c1cc82a44ef9355c27d` 及原计算组，启用 `gvs_20261020_music_f8_once`。范围仅 `gulong_engine.music` 与 `minimax_music_3.generate`、实际模型 `MiniMax-Music3`，每项新增最多 3 次，合计最多 6 次；2026-10-21T00:00:00Z（北京时间10月21日08:00）失效。源码只保存范围摘要；原始绑定/节点身份由真实认证上下文核对并写入服务端授权账本。不是通用管理员提额或环境开关，也不扩大其他节点/能力。

补测**已接入原 `POST /api/v1/capability-verifications/next`**：普通每日16次/每组合3次仍优先，原计数不清零、不改写；普通额度阻断时才检查精确匹配的补测范围。仍须原 request_id+安全 lease、正式自动迁移、完整库存、同组、新鲜空闲GPU及独占物理槽；一个原请求恢复不重复扣次。使用单一 Mongo CAS 同时封顶总6和每能力3，并把每次 reservation 的原 request/challenge/model-record/制品/时间记入独立 `capabilityVerificationSupplementBudgets` 消耗账本；准备失败仍留痕且占用一次，不能退款重开未知推理。后续原日志负责记录是否实际 issued/failed/active，补测不是授信或 passed。过期、变更节点/绑定/制品/组、非指定模型、未支持能力、撤销/损坏账本、并发满额均拒绝；不得用换hash绕过普通或补测限制。

节点可用原 `X-Gulong-Account-Binding` GET `/api/v1/capability-verifications/supplemental-budget` 只读查询自己的范围、期限、总/逐项 limit/used/remaining 与原挑战消耗引用；跨范围只返回 `applicable=false`。不创建挑战/上传/准入，保持 private/no-store，匿名401，每绑定每分钟30次。授权文档于第一个真实补测 reservation 由正式 next 路径原子登记，不由诊断脚本人工插入；此前查询可显示发布审定的可用额度，但**可用不等于已经实际消耗**。

节点无需重启、改密钥或更换制品，继续原自动轮询；原 `next_at` 退避仍有效，发布完成不等于强制立即领取。不改变 challenge 版本、参数、任何整数 `challenge.budget` 字段；补测来源仅存在服务端原日志/独立账本，现有 f8 客户端无需适配。每挑战仍最多一次模型推理及原完整ASR，歌词 `ordered-whole-lyrics-v1`、音频/歌词摘要、完整词序和原最小时长门槛均不变；历史失败绝不转通过，九项与整包真实验收仍是客户端发版门槛。Vercel/腾讯必须同提交上线，公网只核对 schema/401/提交标识，不由发布脚本抢领真实挑战。

### 冻结制品 554a 的七项独立补验（2026-10-20）

独立审定 `gvr_20261020_554a_once` 只匹配制品 `554a6c84d242aadb9e5df18b0dff5f24298ccc3a0ed35fb7f25c97ac0801c281` 和原经审定绑定、匿名节点及空计算组的摘要。有效窗口固定 `2026-10-20T05:45:00Z` 至 `2026-10-21T05:45:00Z`，不自动续额。原始库存已从生产只读核对：除制品哈希外全部模型、版本、默认模型、参数和语言保持不变，服务端钉住新的完整 matrix SHA-256；不是把已验证时长当成原始音乐库存上限。

| 能力 | 本次上限 | 固定原始模型范围 |
|---|---:|---|
| `gulong_engine.agent_chat` | 1 | `qwen38-27b-uncensored-q4-k-m`，tools=false、multimodal=false |
| `gulong_engine.embedding` | 1 | `qwen3-embedding-0.6b-q8-0`，1024维 |
| `sam.video_track` | 1 | `sam-video-3.1`，`3.1-object-multiplex` |
| `mediapipe.video_analysis` | 1 | `mediapipe-pose-full-0.10.14`，`0.10.14-pose-full` |
| `whisper.transcribe` | 1 | `whisper-large-v3-turbo`，`large-v3-turbo-whisper.cpp` |
| `gulong_engine.music` | 3 | `MiniMax-Music3`，原始上限300秒、ASR en/zh |
| `minimax_music_3.generate` | 3 | 同一实际音乐模型/原始上限/语言，原生版本3 |

硬总额11次、各能力不可借额；该制品不能回退到普通每日预算，即便普通日额度为零次已用或UTC日期改变。独立集合 `capabilityVerificationReleaseBudgets` 的唯一 `_id`、总数/分项数、challenge消费条目在一次Mongo CAS内预留；准备失败也保留消费与失败原因，原请求恢复不重复消费。旧f8专项账本、日预算、旧失败和原指数退避不重置，不复制旧通过。额度耗尽、过期或精确范围不符返回空challenge及 `VERIFICATION_RELEASE_BUDGET_UNAVAILABLE`；仍有本项额度但尚在原退避内返回 `VERIFICATION_BACKOFF`、原 `retry_at` 和准确秒数。

沿用原GAB及原request/lease合同。`GET /api/v1/capability-verifications/supplemental-budget` 保留旧f8顶层响应，新增 `release_reverification` 对象，含 `authorization_id/artifact_sha256/valid_from/expires_at/inventory_ready/state/total/capabilities/ordinary_fallback=false`；只读查询不创建账本、挑战、输出或模型调用。新制品尚未实际上报完整匹配库存时 `state=awaiting_inventory`，绝不能把剩余理论次数当作准入证明。新账本只在节点自然领取新制品真实库存时物化，旧f8不能消费。

替换制品后原7项按既有matrix变更规则失效并重新实测；两项Qwen只有独立制品、matrix、分组、范围、TTL仍有效才保留。单次推理预算、输入/输出实物检查、完整ASR及 `ordered-whole-lyrics-v1` 均未修改。原生音乐caption策略未随本次额度发布变更；时长达标但缺失验证码歌词仍是真实失败。有限补验不等于九项通过或桌面整包已发布。

OpenAPI 2.14.3 修正补测候选尚在失败退避时的提示分类：若本绑定范围内仍有真实补测余量，且对应已适配模型仅因原 `nextRetryAt` 未到而不可领，`next` 返回 `challenge=null, code=VERIFICATION_BACKOFF, retry_at=原最早nextRetryAt, retry_after_seconds=ceil(剩余秒数)`（至少1秒），而非错误的每日额度耗尽/3600秒。原日志同时保存本次提示对应的 `responseRetryAt`；不领取/预留挑战、不消耗补测、不重置 attempts、不改原8/16/32分钟退避。真正无剩余补测、失效/撤销/越范围或没有相应有效候选时仍保留原限额门禁。节点已经缓存的旧 `next_at` 不因发布或GET额度查询被追溯改写；目前没有无需操作节点、无需发行挑战的远程通知唤醒接口，本次不新造旁路。
