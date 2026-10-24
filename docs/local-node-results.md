# 本机 / LAN 结果收件合同

协议 `gulong-local-capability-result/v1`；OpenAPI 版本 `2.17.6`。
**本合同仅为结果采集；生产部署以双目标流水线和公网核验为准，不代表九项实机通过。**

本合同仅收集已经在本机 / LAN 完成的原始执行证据，兼容 H3 direct 草案
`2b397c52c8ef2e3678b32b108fec7c65c6837f426e4a8a582fc3f8bc3a61d3a8`。
它不能驱动任务：没有领取、查询节点、模型调用、素材下载、预算、钱包、旧挑战或准入写入。
严禁为准备报告调用官网 `/next`、创建官网订单、借旧窗口或重复执行原失败任务。

## 地址、鉴权与状态

`POST /api/v1/capability-verifications/local-results`

- `Content-Type: application/json`。
- `X-Gulong-Account-Binding: gab_...`，只证明上传者绑定身份，不证明模型执行。
- 当前绑定须有效；`node_id` 与 `compute_group_id` 须与服务端绑定相同。
- 不传本机 `X-H3-Client-Session`、`X-H3-Client-Device`、网站 Bearer、密码、私钥。
- 无 GET / 状态查询 / 任务获取接口。丢回执时只 POST 原报告的完整原证据，不重跑模型。
- 首次 `202`；相同原报告 `200`。响应 `Cache-Control: private, no-store`。

固定回执：

```json
{
  "ok": true,
  "protocol": "gulong-local-capability-result/v1",
  "receipt_id": "glr_<服务端确定性摘要>",
  "report_id": "<原UUID>",
  "status": "pending-native-review",
  "submitted_status": "completed",
  "idempotent": false,
  "verified": false,
  "grants_admission": false,
  "task_dispatched": false,
  "output_integrity_verified": true,
  "local_direct_tested": false,
  "missing_requirements": ["native_execution_review", "installed_scope_review"],
  "message": "已收到完整本地结果，字节校验通过，待原生执行审核；不授予官网共享准入，不派发任务"
}
```

`output_integrity_verified` **仅**表示报告包含的完整字节、原请求/响应对应及格式检查通过。
不是 GPU / 模型真实运行证明，不是独立整段 ASR 证明，不是全部语义通过，也不是官网准入。
`local_direct_tested` 不会由上传者的布尔值、哈希、账号令牌或自签名自动设成 true。
本地实际端到端执行须由 906 保留的原生证据、安装制品与独立审查确认；不因没有发行级非对称签名
而要求本地推理走官网订单。全局 admission 与 local-direct 的测试状态严格独立。

## 请求字段

所有字段严格校验，除下述可选项外都必须存在：

| 字段 | 约束 |
| --- | --- |
| protocol | 固定 `gulong-local-capability-result/v1` |
| report_id / local_request_id | 原报告 UUID / 原 direct request UUID；持久化后不换号 |
| node_id / compute_group_id | 当前绑定节点 ID / `gug_<32hex>` 或 null；不可由自报身份授权 |
| capability_id / capability_version | 下述原始能力标识（含历史 Music3 与独立 ACE-Step）/ 原库存版本 |
| artifact_sha256 | 实际对应能力组件的 SHA-256，64 位小写 hex |
| consumer_artifact_sha256 / matrix_sha256 | 实装消费者 / 精确模型矩阵原摘要，64 位小写 hex |
| model | 实际模型的 `{id,...原标量范围字段}`，不得换模型或扩展已测范围 |
| asr_languages | 实际 `zh` / `en` 列表；不用 ASR 时为空列表 |
| case_id | 本次原生测试用例名；不是官网 challenge |
| started_at / completed_at | UTC ISO 时间；首次收件起止有序、无未来结果、起始距上传不超过 7 天；已收到的完全相同原报告不因七天后恢复回执而失效 |
| local_direct_source | 原 direct 响应中的完整 source 对象，见下文 |
| request_body_base64 | **原始** direct POST jobs body 的规范 base64，最多 65536 原字节 |
| response_body_base64 | **原始** direct GET result body 的规范 base64，最多 320 KiB 原字节 |
| execution | `{origin:"local"或"lan",transport:"http"或"https"或"native_pipe",endpoint_path:"原相对路径"}` |
| status | completed / failed；只接收已经终态的报告 |
| parameters / inline_result | 原请求 parameters / 原完整 response.result（失败时可为 null） |
| outputs | 原 response.artifacts 对应的全部原文件，见下文 |
| error_code | 失败时必填；原中文错误对应的稳定大写错误码 |
| native_receipt | 可选未受信原生收据；现有可选 RS256/Ed25519 描述只保存、不验为准入，**不要求生成签名** |

`local_direct_source` 精确字段：

```json
{
  "protocol": "h3-direct-capabilities/v1",
  "request_id": "<原UUID>",
  "job_id": "<原UUID>",
  "owner_sha256": "<原64hex>",
  "capability_id": "<原能力>",
  "capability_version": "<原版本>",
  "request_sha256": "<原始jobs body字节SHA256>",
  "website_verified": false
}
```

原请求只含 direct v1 的五字段 `request_id/capability_id/capability_version/parameters/assets`。
服务端核对原请求摘要和参数，不规范化、裁减或补填原请求。原 result 必须同 request/job/source/
能力/版本、`terminal=true`，成功 state=succeeded，失败 state=failed/cancelled；原 result 与所有
artifact 的 ID、role、MIME、长度、摘要须完整对应。原 owner hash 仅作对应检查，不因自报它就获得权限。

### 全文件上报

每个 `outputs` 项必须为：

```json
{
  "artifact_id": "<原artifact ID>",
  "role": "primary_image",
  "filename": "original.png",
  "content_type": "image/png",
  "bytes": 12345,
  "sha256": "<完整原文件64hex摘要>",
  "content_base64": "<完整原文件的规范base64>"
}
```

- 整体 JSON 最多 **4 MiB**；直接内嵌的原文件合计最多 **2 MiB**。超过时使用下述纯结果分块，
  最终输出项保留相同字段，但用 `"upload_id":"<原上传UUID>"` **替换** `content_base64`，两者不能共存。
- 每份独立 capability 报告最多 8 文件、原文件合计 128 MiB、单文件最多 64 MiB，
  **不修改** direct v1 的 8 artifacts / 128 MiB 执行合同。报告按原 capability / request / job 独立提交。
- 传输或存储超限时必须保留完整原件；不能压缩重编码、裁切、丢文件、换成较短输出或重跑模型。
- 服务端读取所有原字节，核对长度 / SHA、规范 base64、PNG 完整像素与 CRC、FLAC 原始结构/全流摘要/
  STREAMINFO 时长、JSON/JSONL 完整结构或受限 ZIP 的 CRC/路径/解压预算。ZIP 只在内存解析，不解包落盘。
- FLAC 检查不是完整 PCM 解码；ASR、歌词、原生运行与范围等仍需原生审核，不会调用官网模型代做验证。
- JSON 中重复键、凭据、原型污染、过深对象等拒绝；不接受任意 URL / object_key / 本机路径代替输出原件，
  也不自动取原 direct artifact URL。
- 文本和向量保留完整 OpenAI 响应及 usage；向量核对原输入数量和精确维度，不补齐或截断。原始 native_job / provenance 等字段原样保留，不补造。
- 音乐的执行终态和语义验收分开：即便原任务 succeeded，但歌词 ASR 未覆盖、数字读法不同或缺少验证结论，也保存同一完整音频和原结果，仍为待审核。绝不调用音乐验收器要求重生成，也不据此标记音乐通过。
- 文件和请求 / 响应完整原字节保存在私有结果表及分块中；没有公开列表或下载路由，审计不复制正文/向量/文件。

### 只写原结果分块

`POST /api/v1/capability-verifications/local-results/chunks`

鉴权仍是当前节点的 `X-Gulong-Account-Binding`。`Content-Type: application/octet-stream`，body 仅为原始分块字节。
自定义头 `X-Gulong-Result-Descriptor` 是以下完整清单的 UTF-8 JSON **无填充 base64url**；禁止重复 JSON 键：

```json
{
  "upload_id": "<持久化的原上传UUID>",
  "report_id": "<原报告UUID>",
  "local_request_id": "<原direct请求UUID>",
  "job_id": "<原direct作业UUID>",
  "owner_sha256": "<原local_direct_source.owner_sha256>",
  "request_sha256": "<原始jobs body摘要>",
  "capability_id": "qwen_image_2_1.text_to_image",
  "capability_version": "2.1",
  "artifact_id": "<原artifact ID>",
  "filename": "original.png",
  "role": "primary_image",
  "content_type": "image/png",
  "file_bytes": 3000000,
  "file_sha256": "<完整原文件SHA256>",
  "chunk_index": 0,
  "chunk_offset": 0,
  "chunk_bytes": 1048576,
  "chunk_sha256": "<本块原字节SHA256>"
}
```

- 固定每块 **1048576 bytes**，最后一块是完整余数；`offset=index*1048576`，下标从 0 开始。
- 可乱序到达；每块先完整接收并验长度 / SHA，再与真实 binding / 节点 / 当前组 / 原 owner hash /
  report / request / job / capability / 全文件长度与 SHA 一起私有保存。原生 owner hash 是对应证据，不是新增授权。
- 首次 201，逐字节相同的重复块 200；相同块号换字节、换全文件清单、换请求或换组均 409。
  部分字节、错误位置/摘要不会保存，不增加推理授权。丢 ACK 只重传同块原字节，不重提任务。
- 回执只含 `ok/upload_id/chunk_index/received_bytes/idempotent/status=stored-unreviewed` 与
  `verified=false/grants_admission=false/task_dispatched=false`；不返回 URL、节点任务或模型目录。
- 无 GET 查询、下载、删除或“完成任务”路由；全部块送达后只 POST 原 `local-results` 报告。
  服务端按原块序号完整重组，再次核对每块及整文件长度 / SHA，然后执行原文件格式检查。
- 缺块 409 `LOCAL_RESULT_FILE_INCOMPLETE`，不能当完整输出；最终格式/摘要失败保留已收原块，
  不删除原失败，不凭收到字节就标 native 通过。
- 最终报告、封存标记、收件预算及最小审计同事务提交；失败回滚封存但保留此前已接收的原块。
- 同一绑定有固定累计 **128 MiB 原文件 / 64 文件 / 64 份报告**存储预算（含内嵌和失败/未完上传），
  不是每天重新获得 128 MiB。base64 / 文档 / 索引开销不属于“原文件字节”统计，不能把它称为物理磁盘上限。
  预算耗尽 507 `LOCAL_RESULT_STORAGE_FULL`，保留原件等待单独受审处理；没有自动删旧证据、换窗口或 HTTP 重置接口。
- 全局一次只进行一个重组/完整性检查，使用最长 120 秒的**结果存储锁**控制内存；忙时 409
  `LOCAL_RESULT_PROCESSING_BUSY`，仅原样重报。这个锁不是 GPU 租约，也不能启动模型。

成功媒体报告固定输出角色：

| 能力 | 全部原输出角色 |
| --- | --- |
| gulong_engine.agent_chat / embedding | 无二进制输出；完整 inline result |
| gulong_engine.music / minimax_music_3.generate / ace_step_1_5.generate | primary_audio |
| qwen_image_2_1.text_to_image / multi_image_edit | primary_image |
| sam.video_track | manifest_json、tracks_jsonl、mask_archive |
| mediapipe.video_analysis | analysis_json、pose_tracks_jsonl、person_layers_archive |
| whisper.transcribe | transcript_json，以及原响应实际含有时必须保留的 transcript_text（text/plain 完整 UTF-8） |

上述原始九项与替代音乐身份不包含 MiniMax H3 视频，也不包含独立数字直播实时声画。
失败可保留已经实际生成的原文件和原错误，但不制造缺失输出、不覆盖原失败，更不获得通过结论。

### 独立音乐身份（906 冻结合同）

- 历史 `minimax_music_3.generate` 和 `gulong_engine.music@1.0.0` 的旧结果保持原 ID/版本/模型/失败记录；不会改写成 ACE 通过。
- 新原生能力：`ace_step_1_5.generate@1.5-turbo-dit-only`；通用投影：`gulong_engine.music@2.0.0`。
- 实际 provider/model ID：`ace-step15-turbo`；模型名称：`ACE-Step-1.5-Turbo-DiT-Only`；原生协议：`ace-step-1.5/v1`。
- 修订：`Comfy-Org/ACE-Step-1.5@6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc`；原生输出 FLAC/48000Hz/stereo；plannerEnabled=false、generateAudioCodes=false、8 steps。
- 此处只登记已冻结的收件身份，不登记运行库存、不验证实装、不宣称 ACE 质量通过。完整音频/ASR 与所有原结果均由节点保留，采集回执仍 `verified=false`。

### 发布核验

双目标流水线运行 `scripts/verify-local-result-deployment.mjs`：只 GET 公开 OpenAPI，随后对两个收件路径发送无凭据空对象，确认 401/no-store。不会上传真实报告、激活窗口或消耗任何模型调用预算。

## 幂等、错误与持久化边界

- 服务端绑定 ID + report_id 唯一；同绑定 + local_request_id 唯一。
- 原报告重复只能使用相同完整原证据；修改内容、改报告号、把原请求换成其他能力均 409。
- 报告和最小审计同一事务提交，审计失败整体回滚；重复报告不重复计入审计。
- 60 次/分钟限流，64 份新报告/日上限只是结果收件限流，不是模型执行预算。
- 只写 `capabilityLocalResultReports` / `capabilityLocalResultAudits` / `capabilityLocalResultFiles` /
  `capabilityLocalResultChunks` / `capabilityLocalResultStorage`，不复制旧自动验收或挑战记录。
- 不改旧失败、不改 TTL、不自动激活任何窗口、不产生全局通过。部署流水线不自动执行音乐窗口激活。
- 常见错误：401 绑定失效、403 节点/组/原 source 不符、400 原字节/JSON/格式/时间不符、409 原报告冲突、
  413 完整证据超限、429 收件限流、503 保存失败、507 固定证据存储已满。
  503 / 丢 ACK 时保留原报告和全部原文件，仅原样重报。

目前没有人工“点通过”接口，也没有客户端公钥登记或任意 DTO 签名接口。
