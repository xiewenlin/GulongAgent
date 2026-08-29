# MiniMax H3 共享节点接入合同

生产基址：`https://www.sologle.com`

在线 OpenAPI：`https://www.sologle.com/api/openapi.json`

交互式文档：`https://www.sologle.com/api/docs`

所有金额均为人民币整数分。除账号绑定接口外，用户侧接口使用古龙会话或 `Authorization: Bearer gla_live_...`。领取、回调和解绑统一使用：

```http
X-Gulong-Account-Binding: gab_...
```

服务端只保存该令牌的 HMAC-SHA256 摘要。桌面端应使用 Electron `safeStorage` 加密保存明文令牌。

## 0. 加权硬件指纹 v2 激活

`POST /api/licenses/redeem` 保持 RS256 回执 canonical 顺序不变。新版客户端必须提交当前产品标识，仍把旧 MAC 算法生成的 `legacyDeviceId` 放入 `deviceId`，并可追加硬件摘要：

```json
{
  "code": "H3-ABCDE-FGHJK-MNPQR-STUVW",
  "product": "minimax-h3-ultra-video",
  "deviceId": "64位旧版设备指纹摘要",
  "fingerprintVersion": "h3-hw-v2",
  "hardwareHash": "64位小写SHA-256",
  "hardwareEvidenceHash": "64位小写SHA-256",
  "fingerprintConfidence": "high",
  "hardwareScore": 72,
  "bindingScore": 72,
  "identityComponents": ["systemUuid", "baseboardSerial", "baseboardModel", "biosSerial"],
  "hardwareComponentDigests": {
    "systemUuid": "64位小写SHA-256",
    "baseboardSerial": "64位小写SHA-256",
    "baseboardModel": "64位小写SHA-256",
    "biosSerial": "64位小写SHA-256"
  }
}
```

产品标识固定为：

- MiniMax H3 超清视频：`minimax-h3-ultra-video`
- 越狱视频-MiniMax H3 超能视频：`minimax-h3-super-video`

两款产品必须分别购买激活码。同一电脑可分别激活，但激活码不能混用。跨产品提交时服务端先返回 `409 ACTIVATION_PRODUCT_MISMATCH` 与购买当前产品新激活码的中文提示，不会再把产品错误误报成硬件分类摘要错误。

分类权重固定为：`systemUuid 30`、`baseboardSerial 22`、`baseboardModel 8`、`biosSerial 12`、`chassisSerial 8`、`tpm 5`、`cpu 5`、`systemDisk 4`、`gpu 2`、`physicalMacs 2`、`systemModel 1`、`oemStrings 1`。`hardwareScore` 必须等于已提交分类权重之和。

官网只保存分类名和 SHA-256 摘要，拒绝原始主板、SMBIOS、序列号、TPM、MAC 等值。旧授权首次提交 v2 时，若旧 `deviceId` 仍相同，会直接原子补录 `hardwareBindingV2`，不改变 `activatedAt`，也不消耗新的激活次数。同一 `hardwareHash` 幂等返回原回执；不同 `hardwareHash` 返回 HTTP 409：

```json
{
  "code": "HARDWARE_FINGERPRINT_MISMATCH",
  "message": "激活码已绑定到另一组主板硬件指纹"
}
```

成功回执仍只有原有 `version`、`licenseId`、`product`、`deviceId`、`macHint`、`activatedAt`、`perpetual`、`algorithm`、`signature` 字段；Claim、账号绑定、收益与隐私 DTO 不变。

### 0.1 同机重装后的旧授权安全恢复

客户端必须使用两阶段调用，禁止看到任意 409 就自动恢复：

1. 第一次按正常兑换请求提交完整 v2 摘要，但不带 `legacyRecovery`。
2. 只有服务端精确返回 HTTP `409` 且 `code=LEGACY_RECOVERY_REQUIRED` 时，客户端才可以再次发送同一组硬件摘要，并追加 `legacyRecovery`。

该唯一触发响应为：

```json
{
  "code": "LEGACY_RECOVERY_REQUIRED",
  "message": "检测到这是尚未绑定新版硬件指纹的旧授权，且重装后的旧版设备指纹已经变化；仅当确认仍是原电脑时，才可追加 legacyRecovery.mode=os_reinstall 重新请求安全恢复"
}
```

服务端仅在以下条件全部成立时返回该码：激活码状态为 `used`、记录尚无 `hardwareBindingV2`、本次 `deviceId` 与旧记录不同、本次已提交格式有效的完整 v2 摘要、且请求尚未带 `legacyRecovery`。任一其他 400/409 都不是恢复触发码。

第二阶段请求：

```json
{
  "code": "H3-ABCDE-FGHJK-MNPQR-STUVW",
  "product": "minimax-h3-ultra-video",
  "deviceId": "重装后重新计算的64位旧版设备指纹摘要",
  "deviceName": "CREATOR-PC",
  "macHint": "A1B2C3",
  "legacyRecovery": { "mode": "os_reinstall" },
  "fingerprintVersion": "h3-hw-v2",
  "hardwareHash": "64位小写SHA-256",
  "hardwareEvidenceHash": "64位小写SHA-256",
  "fingerprintConfidence": "high",
  "hardwareScore": 64,
  "bindingScore": 85,
  "identityComponents": ["systemUuid", "baseboardSerial", "biosSerial"],
  "hardwareComponentDigests": {
    "systemUuid": "64位小写SHA-256",
    "baseboardSerial": "64位小写SHA-256",
    "biosSerial": "64位小写SHA-256"
  }
}
```

服务端安全门禁：

- 必须持有原激活码，产品必须精确匹配，授权状态必须为 `used` 且尚未绑定 v2。
- `fingerprintConfidence` 必须为 `high`，必须包含 `systemUuid` 和至少一项 `baseboardSerial`、`biosSerial`、`chassisSerial`。
- 主要身份锚点权重至少为 52，`bindingScore` 至少为 75；历史记录没有 `macHint` 时，门槛提高为主要锚点至少 64、`bindingScore` 至少 85。
- 历史记录有 `macHint` 时，当前 MAC 尾号后六位必须一致。
- 通过后一次性原子更新 `deviceId` 并补录 v2，保留原 `activatedAt`，不增加激活次数；并发迁移只有一个请求能成功。
- 已经绑定 v2 的授权不走本合同；不同主板或证据不足均返回 409，绝不降级为仅凭激活码恢复。

迁移成功除原有签名回执外增加：

```json
{
  "ok": true,
  "recovered": true,
  "code": "LEGACY_LICENSE_RECOVERED",
  "message": "已确认是原电脑并恢复旧授权；激活时间和授权次数保持不变",
  "receipt": { "version": 1, "algorithm": "RS256", "signature": "base64" }
}
```

错误响应固定为 JSON `{"code":"...","message":"中文提示"}`。客户端必须按 `code` 分支处理，不要把全部 HTTP 400 映射为“硬件格式错误”。恢复相关错误码：

- `400 INVALID_LEGACY_RECOVERY_REQUEST`：`legacyRecovery` 格式不正确。
- `400 LEGACY_RECOVERY_HARDWARE_REQUIRED`：未提交完整 v2 摘要。
- `409 LEGACY_RECOVERY_REQUIRED`：唯一允许客户端进入第二阶段恢复的触发码。
- `409 LEGACY_RECOVERY_EVIDENCE_INSUFFICIENT`：强主板证据或可信度不足。
- `409 LEGACY_RECOVERY_MAC_MISMATCH`：历史 MAC 尾号不一致。
- `409 LEGACY_RECOVERY_NOT_APPLICABLE`：授权已经绑定 v2，不能走旧授权迁移。
- `409 HARDWARE_FINGERPRINT_MISMATCH`：已绑定到另一台电脑的主板硬件。
- `409 LEGACY_RECOVERY_CONFLICT`：并发恢复导致授权状态已经改变。

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
    "product": "minimax-h3-ultra-video",
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
  "prompt_optimization_enabled": false,
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

官网只保存并排队用户输入的原始中文 `prompt`，不会在服务器端翻译或编译。网页版在“时长”后提供“魔法优化”图标，由用户自主开启或关闭，并把选择写入 `prompt_optimization_enabled`。开启时任务标记为 `prompt_mode=desktop_local_magic_v1`，由领取任务的 MiniMax H3 极速视频桌面端在本地优化；关闭时标记为 `prompt_mode=raw_prompt_v1`，桌面节点必须原样使用提示词且不得回传 `compiled_prompt`。为兼容旧客户端，省略该字段时按开启处理；新版网页默认关闭并始终显式提交布尔值。原文始终保留用于审计。

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "可用余额不足，本次任务需要 3.05 元",
  "requiredFen": 305
}
```

## 4. 局域网集群负载感知领取

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
    "local_prompt_optimization_v1": true,
    "max_concurrent_tasks": 4
  },
  "lan_cluster": {
    "cluster_id": "稳定匿名局域网集群ID，不得使用原始IP或MAC",
    "observed_at": "2026-08-29T08:00:00.000Z",
    "nodes": [
      {
        "node_id": "stable-node-0001",
        "node_name": "H3-4090-01",
        "running_task_count": 2,
        "estimated_total_seconds": 1260,
        "available": true,
        "capabilities": "与上层 capabilities 同结构"
      },
      {
        "node_id": "stable-node-0002",
        "node_name": "H3-5090-02",
        "running_task_count": 0,
        "estimated_total_seconds": 0,
        "available": true,
        "capabilities": "与上层 capabilities 同结构"
      }
    ]
  }
}
```

`lan_cluster.nodes` 必须包含轮询节点以及同一局域网中所有可用执行节点。每个节点都必须已经用自己的 `X-Gulong-Account-Binding` 绑定到与轮询节点相同的官网账号；服务端不信任客户端自报邮箱或用户 ID，也拒绝跨账号节点。报告时间与服务器时间偏差不得超过 2 分钟，单次最多 64 个节点。老客户端暂时允许省略 `lan_cluster`，此时仅把轮询节点作为一节点集群。

服务端先按 `createdAt、_id` 从旧到新读取候选任务，再对能力匹配的节点按 `estimated_total_seconds`、`running_task_count`、`node_id` 排序，选择预计完成时间最短的节点。任务仍通过原子 `findOneAndUpdate` 抢占，避免并发重复领取。开启优化的任务只会分配给声明 `local_prompt_optimization_v1=true` 的节点；未声明该能力的节点仍可领取用户明确关闭优化的 `raw_prompt_v1` 任务。没有适配任务时返回 `{ "task": null }`。

相同账号与 `cluster_id` 共享一个短租约和 `nextClaimAt`：同一轮询窗口只有一个请求进入真实队列查询，其余节点直接得到 `cluster_throttled=true`、`poll_after_ms` 与 `Retry-After`。集群 ID 只以 SHA-256 保存。服务端同时读取各节点已经领取但尚未完成的任务，用服务端活动数和剩余耗时校正上报值，避免少报负载或旧客户端重复领取超过并发上限。

“测试连接”必须发送 `dry_run: true`。服务端完成绑定身份、能力和限流校验后直接返回：

```json
{ "ok": true, "service": "gulong-h3-shared", "queue": "reachable" }
```

此分支不会读取或减少队列，不会改变任何任务状态，也不会签发输入下载或输出上传票据。正式轮询发送 `dry_run: false`。

正式领取返回的是专用的最小权限 `workerTask`，仅包含 `id`、`orderNo`、`model`、原始中文 `prompt` / `source_prompt` / `original_prompt`、`prompt_optimization_enabled`、`prompt_mode`、`local_prompt_optimization_required`、视频参数、三类素材数量、短时素材下载票据、`assigned_node`、`dispatch_estimated_total_seconds`、`auto_cancel_at` 和 `output_upload`。局域网调度器必须把任务交给 `assigned_node.node_id` 指定的节点；只有该节点自己的绑定令牌可以提交回调。开启时三个选择字段分别为 `true`、`desktop_local_magic_v1`、`true`；关闭时分别为 `false`、`raw_prompt_v1`、`false`。DTO 不包含 `requester`、需求用户邮箱或 ID、`priceFen`、`walletLedgerId` 或内部绑定 ID，渲染节点因此看不到需求用户的账号信息。

开启魔法优化时，节点领取后必须先回调 `status=optimizing`，在本机调用 PromptEngine 完成优化；成功后再回调 `status=started`，并提交本地产生的 `compiled_prompt`、`estimated_total_seconds` 和可选的 `prompt_optimization.engine/version/elapsed_seconds`。服务端收到并保存编译结果前，不接受生成进度或成功回调；本地优化失败时节点直接回调 `failed`，不得启动 H3 推理。关闭魔法优化时，节点不得发送 `optimizing` 或 `compiled_prompt`，应直接用原始 `prompt` 生成，并以 `status=started` + `estimated_total_seconds` 开始上报进度；服务端会拒绝违背用户选择的回调。

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

轮询节点只记录在 `claimRequestedByNode`；服务端选中的 `assigned_node` 写入 `claimedByNode`。回调令牌必须与 `claimedByNode` 一致，最终接单人与分佣账户仍取成功回调令牌对应用户。

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

任务创建时服务端会根据时长、profile、采样步数和素材数计算保守的 `dispatch_estimated_total_seconds`，并写入 `auto_cancel_at = createdAt + 10 × estimate`。执行节点首次 `started` 回调提供的 `estimated_total_seconds` 如果更长，会按两者较大值更新截止时间。任务超过截止时间仍未完成时，服务端原子改为 `cancelled`、幂等退款、作废未使用的输出上传票据，并发送站内提醒：建议用户改用其他视频模型。腾讯云节点每分钟执行一次维护；用户任务轮询、桌面领取和管理员列表也会触发同一幂等检查。

## 6. 管理员接口与页面

- 页面：`https://www.sologle.com/admin?section=h3tasks`
- 列表：`GET /api/admin/h3/tasks`
- 详情：`GET /api/admin/h3/tasks/{id}`
- 重试：`POST /api/admin/h3/tasks/{id}/retry`
- 取消退款：`POST /api/admin/h3/tasks/{id}/cancel`

支持 `status`、`source`、`assignee`、`q`、`from`、`to` 筛选。全部管理操作需要管理员身份并写入审计。
