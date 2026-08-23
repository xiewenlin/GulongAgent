# MiniMax H3 共享节点接入合同

生产基址：`https://www.sologle.com`

在线 OpenAPI：`https://www.sologle.com/api/openapi.json`

交互式文档：`https://www.sologle.com/api/docs`

所有金额均为人民币整数分。除账号绑定接口外，用户侧接口使用古龙会话或 `Authorization: Bearer gla_live_...`。领取、回调和解绑统一使用：

```http
X-Gulong-Account-Binding: gab_...
```

服务端只保存该令牌的 HMAC-SHA256 摘要。桌面端应使用 Electron `safeStorage` 加密保存明文令牌。

## 1. 绑定桌面节点账号

`POST /api/desktop/account-bindings/verify`

```json
{
  "email": "user@example.com",
  "node_id": "匿名稳定节点ID，不是原始MAC",
  "node_name": "H3-CREATOR-01",
  "app_version": "2.1.0",
  "activation_receipt": {
    "version": 1,
    "licenseId": "MongoDB ObjectId",
    "product": "minimax-h3-universal",
    "deviceId": "64位设备指纹摘要",
    "macHint": null,
    "activatedAt": "2026-08-18T03:04:05.000Z",
    "perpetual": true,
    "algorithm": "RS256",
    "signature": "base64"
  }
}
```

服务端先验签并核对激活记录仍为 `used`，通过后才查询邮箱，因此未激活客户端不能用该接口枚举用户。

成功：

```json
{
  "ok": true,
  "binding_token": "gab_仅显示一次的高熵令牌",
  "binding": {
    "id": "绑定记录ID",
    "email": "user@example.com",
    "user_id": "用户ID",
    "display_name": "用户昵称",
    "node_id": "匿名稳定节点ID",
    "node_name": "H3-CREATOR-01",
    "app_version": "2.1.0",
    "verified_at": "2026-08-18T12:00:00.000Z"
  }
}
```

激活有效但用户不存在：

```json
{
  "code": "USER_NOT_FOUND",
  "message": "该邮箱尚未注册古龙账户",
  "register_url": "https://www.sologle.com/"
}
```

解绑：`POST /api/desktop/account-bindings/unbind`，只需要绑定令牌请求头。重新调用 verify 会轮换令牌，并留下 rebind 审计。

## 2. 输入素材直传

输入素材不能经 Vercel 中转，也不能直接提交任意 COS 对象键。

### 2.1 获取上传票据

`POST /api/h3/assets/presign`

```json
{
  "kind": "image",
  "filename": "reference.png",
  "content_type": "image/png",
  "bytes": 124578,
  "sha256": "64位十六进制SHA-256"
}
```

响应：

```json
{
  "asset_id": "资产ID",
  "upload_url": "一小时有效的COS签名URL",
  "method": "PUT",
  "object_key": "h3/requesters/<userId>/assets/<assetId>-reference.png",
  "headers": {
    "Content-Type": "image/png",
    "x-cos-meta-sha256": "64位大写SHA-256",
    "x-cos-meta-bytes": "124578",
    "x-cos-meta-owner-id": "用户ID",
    "x-cos-meta-h3-asset-id": "资产ID"
  },
  "expires_at": "ISO-8601"
}
```

客户端必须原样携带全部 headers 执行 PUT。

### 2.2 完成素材

`POST /api/h3/assets/{asset_id}/complete`

服务端 HEAD 校验对象大小、SHA-256 元数据、用户归属和 asset id。成功后返回可放入任务 `assets` 的 manifest。

## 3. 创建共享节点订单

`POST /api/h3/tasks`

请求头必须包含 8–160 字符的 `Idempotency-Key`。也可把同一值放入 `idempotency_key`。

```json
{
  "source_channel": "website",
  "model": "minimax_h3_shared",
  "prompt": "生成一段产品发布视频",
  "aspect_ratio": "16:9",
  "duration_seconds": 15,
  "profile": "balanced",
  "assets": {
    "images": [{ "asset_id": "已完成的资产ID" }],
    "videos": [],
    "audio": []
  }
}
```

`source_channel` 可为 `website` 或 `desktop_agent`。服务端只统计已经完成、属于当前账号的资产记录：

网页版与桌面端均支持最多 9 张图片、3 个视频、3 个音频。每一类素材按照任务 manifest 中的顺序独立编号，用户可在原始提示词中使用 `@图片1`、`@视频1`、`@音频1` 引用；桌面执行节点本地优化时会将这些引用编译为 H3 所需的精确模型标签。素材先通过上一节的短时票据直接上传 COS，网页请求体只提交已完成的 `asset_id`，不承载大文件。

```text
priceFen = duration_seconds * 20 + image_count * 5 + video_count * 20
```

音频为 0 分。官方 MiniMax H3 对照价只用于展示，不能参与实际账单。客户端上传的 count 与 price 会被忽略。

创建时钱包原子预扣。余额不足：HTTP 402。

官网只保存并排队用户输入的原始中文 `prompt`，不提供“魔法优化”按钮，也不会在服务器端翻译或编译。新任务会标记 `prompt_mode=desktop_local_magic_v1`，由领取任务的 MiniMax H3 极速视频桌面端在本地自动优化；原文始终保留用于审计。

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "可用余额不足，本次任务需要 3.05 元",
  "requiredFen": 305
}
```

## 4. 按节点能力原子领取

`POST /api/h3/tasks/claim`

```json
{
  "bound_account_email": "仅作审计快照",
  "bound_account_id": "仅作审计快照",
  "node_id": "必须与绑定令牌的节点一致",
  "node_name": "H3-4090-01",
  "dry_run": false,
  "capabilities": {
    "max_duration_seconds": 15,
    "profiles": ["balanced", "quality"],
    "vram_mb": 24576,
    "max_image_count": 9,
    "max_video_count": 3,
    "max_audio_count": 3,
    "local_prompt_optimization_v1": true
  }
}
```

领取使用单次 `findOneAndUpdate`，筛选 `queued`、模型、最大时长、profile、三类素材上限和本地提示词优化能力。未声明 `local_prompt_optimization_v1=true` 的旧节点不会领取新任务。没有适配任务时返回 `{ "task": null }`。

“测试连接”必须发送 `dry_run: true`。服务端完成绑定身份、能力和限流校验后直接返回：

```json
{ "ok": true, "service": "gulong-h3-shared", "queue": "reachable" }
```

此分支不会读取或减少队列，不会改变任何任务状态，也不会签发输入下载或输出上传票据。正式轮询发送 `dry_run: false`。

正式领取返回的是专用的最小权限 `workerTask`，仅包含 `id`、`orderNo`、`model`、原始中文 `prompt` / `source_prompt` / `original_prompt`、`prompt_mode=desktop_local_magic_v1`、`local_prompt_optimization_required=true`、视频参数、三类素材数量、短时素材下载票据和 `output_upload`。它不会包含 `requester`、需求用户邮箱或 ID、`priceFen`、`walletLedgerId`、内部账号绑定、领取节点身份等字段，局域网渲染节点因此看不到需求用户的账号信息。管理员和订单本人通过各自受权查询接口查看完整订单。

节点领取后必须先回调 `status=optimizing`，在本机调用 PromptEngine 完成魔法优化；成功后再回调 `status=started`，并提交本地产生的 `compiled_prompt`、`estimated_total_seconds` 和可选的 `prompt_optimization.engine/version/elapsed_seconds`。服务端收到并保存编译结果前，不接受生成进度或成功回调；本地优化失败时节点直接回调 `failed`，不得启动 H3 推理。

有任务时，每个输入素材带 15 分钟下载票据：

```json
{
  "assetId": "资产ID",
  "kind": "image",
  "filename": "reference.png",
  "objectKey": "h3/requesters/...",
  "bytes": 124578,
  "sha256": "...",
  "download_url": "短时COS签名下载地址",
  "download_expires_at": "ISO-8601"
}
```

任务同时带输出直传票据：

```json
{
  "output_upload": {
    "url": "一小时有效的COS签名PUT地址",
    "method": "PUT",
    "headers": {
      "Content-Type": "video/mp4",
      "x-cos-meta-h3-task-id": "task id",
      "x-cos-meta-h3-upload-grant": "grant id"
    },
    "required_metadata_headers": [
      "x-cos-meta-sha256",
      "x-cos-meta-bytes",
      "x-cos-meta-filename-b64"
    ],
    "object_key": "h3/tasks/<taskId>/outputs/<grantId>.mp4",
    "grant_id": "一次性grant id",
    "expires_at": "ISO-8601"
  }
}
```

桌面端在 PUT 时还必须设置：

- `x-cos-meta-sha256`：成品 MP4 的 64 位大写 SHA-256；
- `x-cos-meta-bytes`：十进制字节数；
- `x-cos-meta-filename-b64`：UTF-8 文件名的 Base64，便于审计。

调度节点写入 `claimedByNode`。局域网中的执行节点可以使用自己的绑定令牌回调；最终接单人不取 claim 的账号。

## 5. 回调

`POST /api/h3/tasks/callback`

请求类型为 `multipart/form-data`，但只发送文本字段 `metadata`。禁止附加 `video` 文件；大视频必须使用 claim 返回的票据直传 COS。

```json
{
  "event": "render-completed",
  "assignee_email": "仅作审计，不可信",
  "assignee_user_id": "仅作审计，不可信",
  "node_id": "执行节点绑定ID",
  "node_name": "H3-EXECUTOR-02",
  "task_id": "任务ID或订单号",
  "local_job_id": "桌面本地任务ID",
  "status": "completed",
  "elapsed_seconds": 83.5,
  "video": {
    "sha256": "64位十六进制摘要",
    "bytes": 45897231,
    "filename": "h3-output.mp4",
    "object_key": "claim返回的output_upload.object_key"
  }
}
```

服务端严格校验：

- object key 必须位于 `h3/tasks/{taskId}/outputs/`；
- object key 必须对应未过期或已完成的 grant；
- COS 对象必须存在；
- `Content-Length`、`x-cos-meta-bytes` 与 callback bytes 完全一致；
- `x-cos-meta-sha256` 与 callback sha256 完全一致；
- COS 任务 id 和 grant id 元数据必须一致。

成功回调后，`executedByNode` 与 `assigneeUserId` 只取当前绑定令牌解析结果。回调幂等键为 `task_id + event + status + local_job_id`。重复回调不会重复扣款、退款或变更接单人。回调响应同样只返回任务 ID、订单号、状态、进度及完成/失败时间，不回传需求用户或计费字段。

失败或取消回调会把预扣款按订单幂等退回。管理员重试时重新检查余额并创建新一轮预扣记录。

## 6. 管理员接口与页面

- 页面：`https://www.sologle.com/admin?section=h3tasks`
- 列表：`GET /api/admin/h3/tasks`
- 详情：`GET /api/admin/h3/tasks/{id}`
- 重试：`POST /api/admin/h3/tasks/{id}/retry`
- 取消退款：`POST /api/admin/h3/tasks/{id}/cancel`

支持 `status`、`source`、`assignee`、`q`、`from`、`to` 筛选。全部管理操作需要管理员身份并写入审计。
