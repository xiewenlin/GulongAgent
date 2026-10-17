# WorkLucky 分布式共享能力合同

协议：`gulong-capability-orders-v1`。本文描述官网合同，不等同于真实消费者已在线或某模型已完成推理验收。生产合同以 `https://www.sologle.com/api/openapi.json` 和当前账户的鉴权目录为准。

## 账号、产品和计费边界

WorkLucky 包含在现有 `gulong_engine_monthly` 权益中，不新增用户体系、订阅 SKU 或另一笔费用。使用与古龙绿色版相同的 GGE 会话族：`gge_at_` 访问令牌、`gge_rt_` 刷新令牌、相同会话库与撤销行为。路由别名不是权限隔离：在任一别名刷新或注销，会使另一别名中的同一旧会话失效。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/desktop/worklucky/config` | 不缓存的配置和鉴权目录入口；静态能力列表不代表在线 |
| POST | `/api/v1/desktop/worklucky/auth/login` | JSON `{identifier,password}`；沿用账号密码验证和限流 |
| POST | `/api/v1/desktop/worklucky/auth/refresh` | JSON `{refresh_token}`；原子轮换，旧令牌立即失效 |
| POST | `/api/v1/desktop/worklucky/auth/logout` | Bearer 加 JSON `{refresh_token}`；撤销当前会话 |
| GET | `/api/v1/desktop/worklucky/account` | Bearer；当前用户、权威权益和 `checked_at` |
| GET | `/api/v1/desktop/worklucky/updates` | 未发布已验证安装包时明确返回 `no_update`，不能拿源码标签当安装包 |

上述别名若带可选 `product` 查询参数，只接受单个 `worklucky`；其他值、空值或重复参数返回 `400 WORKLUCKY_PRODUCT_INVALID`。所有响应均不可缓存。登录成功不代表会员生效，`active=false` 不授权创建共享订单。

统一订单继续用 `Authorization: Bearer gge_at_...`。消费者继续用 `X-Gulong-Account-Binding`；客户端不能通过自报邮箱、用户 ID、`client_product` 或分组绕过服务器身份。H3 独立接口的鉴权与 `/api/h3/tasks` 零扣费合同不因 WorkLucky 接入被放宽。

所有 WorkLucky 统一订单必须带 `client_product:"worklucky"`，仅允许目录中的零价 Gulong 共享能力。`price_fen=0`，无钱包扣款或分佣，不允许自动切换远程收费模型。会员有效期、账户所有权和用户/节点相同算力分组仍由服务端校验；未分组只匹配未分组。

## 目录、容量和消费验收

`GET /api/v1/capability-orders/catalog?product=worklucky` 必须鉴权。注册 ID 包含 text、image、image_2k、tts、video、agent_chat、embedding、music，但客户端只能采用条目的实时 `dispatchable`、`price_fen`、`availability`、版本和参数 schema。

- `availability.verified_node_count` 只计有效绑定、及时上报且实际验证通过的兼容消费者，不计网站注册表中的虚拟节点。
- `availability.free_slot_count` 是实际可接任务槽位；忙节点不凭空增加空位，过期报告不视为在线。共享消费者的槽位必须由服务器原子预留，不能仅信任重复轮询携带的 `running_task_count=0`。
- `ready` 表示有兼容空位，`busy` 表示兼容消费者存在但暂无线程空位，`offline` 表示没有可验证消费者。无消费者时拒绝新建，不能创建永不执行的订单。
- 新 agent_chat/embedding/music 使用 `1.0.0` 合同，必须具备管理员登记的可信验收 ID 后才能接单；单纯自行上报 `validated=true`、时间戳或测试名称不能成为验收。管理员记录须绑定实际节点、能力版本和验证产物摘要；模型、工具、多模态、音乐生成和完整音频 ASR 不能通过静态配置推定。
- `gulong_engine.video` 在精确参数消费者实机验收前保持 `adapter_required`，不得因 H3 独立合同上线而解除。

### 管理员可信验收登记

只有管理员会话和可信变更来源可以调用 `POST /api/admin/capability-consumers/acceptances`（JSON 上限64 KiB）。它只登记已完成的真实验收，不执行模型，也不生成验收证据。请求公共字段：

```json
{
  "binding_id": "<nodeAccountBindings 的24位十六进制ID>",
  "capability_id": "gulong_engine.agent_chat",
  "capability_version": "1.0.0",
  "artifact_sha256": "<实际消费者制品的64位SHA256>",
  "test_evidence_sha256": "<真实验收证据的64位SHA256>",
  "tested_at": "<真实测试的ISO时间>",
  "expires_at": "<测试时间起30天内的未来ISO时间>",
  "admin_confirmed_real_consumer": true,
  "models": [{"id":"actual-model-id","tools":false,"multimodal":false}],
  "default_model": "actual-model-id",
  "contract_tests": {"exact_request":true,"complete_response":true}
}
```

示例值不能作为可用模型或证据；必须替换为该绑定节点实际验证值。按能力追加或替换：

- agent_chat：每个 `models` 项必须含布尔 `tools` 和 `multimodal`，`default_model` 必须属于本模型列表；若任一模型声明工具或媒体可用，`contract_tests.tools` 或 `multimodal` 也必须为 true，且已有对应实机验收。
- embedding：每项为 `{id,dimension}`；`contract_tests` 必须含 `exact_request:true`、`complete_response:true`、`exact_model_dimension:true`。`default_model` 可省略或为 null，若填写必须在模型列表内。
- music：每项为 `{id}`，提供 `asr_languages:["zh"]`、`["en"]` 或两者；`contract_tests` 必须含 `music_generation:true`、`whole_audio_asr:true`、`exact_lyrics:true`、`exact_duration:true`。没有完整生成及整段 ASR 证据不得登记。`default_model` 可省略或为 null，若填写必须在模型列表内。

成功返回201 `{acceptance:{id:"gca_<UUID>",binding_id,capability_id,capability_version,...,status:"active"}}`。节点随后通过 Claim 的能力报告上送：

```json
{
  "capability_id": "gulong_engine.agent_chat",
  "capability_version": "1.0.0",
  "protocol_version": "gulong-capability-orders-v1",
  "installed": true,
  "validated": true,
  "enabled": true,
  "max_concurrent": 1,
  "models": [{"id":"actual-model-id","tools":false,"multimodal":false}],
  "default_model": "actual-model-id",
  "validation": {
    "acceptance_id": "gca_<登记返回的UUID>",
    "tested_at": "<真实测试ISO时间>",
    "artifact_sha256": "<登记的相同制品摘要>",
    "contract_tests": {"exact_request":true,"complete_response":true}
  }
}
```

验收记录须与 binding、能力/版本、制品摘要、模型/维度/功能矩阵、默认模型、ASR语言和测试声明完全匹配。过期、审计未激活、停用绑定或不同矩阵均不可接单。管理员 GET 同一路径可按 `binding_id`、`capability_id`、`status` 查询，`limit` 最大100；若POST返回503，必须先查询确认，不能假设已激活或盲目重建证据。

## 创建、恢复与取消

创建：`POST /api/v1/capability-orders`，头部 `Idempotency-Key` 为客户端稳定请求 ID（8–160 字符），JSON：

```json
{
  "source_channel": "desktop_agent",
  "client_product": "worklucky",
  "capability_id": "gulong_engine.agent_chat",
  "capability_version": "1.0.0",
  "parameters": {},
  "assets": []
}
```

版本必须采用目录实际返回值，不可凭本文示例升级。素材使用官网预签名上传、完成校验后返回的 `asset_id`，不能提交任意公网下载 URL。图片、音频和其他大对象直接传 COS，不经过官网 JSON 请求体。

- 已成功/未知受理的原请求：`GET /api/v1/capability-orders/by-request/{key}?product=worklucky`，或按已收到的原订单 ID 查询 `GET /api/v1/capability-orders/{id}?product=worklucky`。
- WorkLucky 查询和恢复必须显式携带 `?product=worklucky`；缺省属于旧版无产品标记的请求域，读取 WorkLucky 原订单会返回 409，不会自动猜测产品。回执 `order.client_product` 返回服务端保存的标记。英语教练专用凭据不可读取、创建或取消 WorkLucky 请求，包括预取消墓碑。
- 显式取消：`POST /api/v1/capability-orders/{id}/cancel` 或 `POST /api/v1/capability-orders/by-request/{key}/cancel`，按路由合同携带 `client_product:"worklucky"`。取消按请求号落幂等墓碑，迟到的同请求创建不得重新排队。
- `client_product` 是幂等指纹的一部分；同账户不同产品不能串用原请求或取消墓碑。它不是授权凭证，也不能跨账户恢复。
- 提交超时且受理结果未知时，先恢复原请求，不能向另一个节点、产品或网站广播同一任务；原收据持久化至本地，重启仍查询原订单，不重复收费或执行。
- 独立任务可分别派给真实可用槽位，并发处理；同一逻辑任务不得向所有节点广播。客户端负责汇集原订单输出，官网负责自己真实消费者池的派单。

## 新能力精确合同

### `gulong_engine.agent_chat`

`parameters.model` 必须为目录 `availability.models` 中的真实模型 ID；自动选择必须使用目录 `availability.default_model`，且该值必须属于同一列表。`parameters.request` 为完整 OpenAI Chat Completions 请求对象，包含原样的 `messages`、`tools`、`tool_choice` 等字段，不能降级为扁平 prompt，不能静默替换模型。

消费者完成后返回 `inline_result.response`：完整 OpenAI 响应（含消息、工具调用、用量等原有字段），不是仅一段文本。消费者必须显式验证和上报 tools/multimodal 支持；真实媒体未验收不能发布 `availability.multimodal=true`。官网只中转合同，不自行调用响应中的工具。

### `gulong_engine.embedding`

`parameters.request` 为完整 OpenAI Embeddings 请求，`parameters.model` 为精确模型 ID，`parameters.dimension` 与目录 `availability.models:[{id,dimension}]` 对应维度完全一致。不得换成另一向量模型或偷偷裁切、补齐维度。

未找到实际模型文件、真实服务及其验证向量维度时，目录必须保持不可派单；不能根据模型名称猜一个维度后宣称可用。

`inline_result.response` 保留完整 `data`、索引顺序和 `usage`。结果中索引、条目数和每个向量维度必须符合原请求及目录，不能只返回部分样本或把结果重排为另一个语义。

### `gulong_engine.music`

输入 `parameters.caption`、`lyrics`、`seconds`、`seed` 必须保留用户批准的完整歌词与时长，禁止截掉后半歌词以通过验证。结果 `primary_audio` 必须为 FLAC；回执提供经实际对象校验的 `bytes`、`sha256`、`duration_seconds`，不能把客户端自行填写的元数据当作完整验收。

`seconds` 是1–600秒的最长输出时长，并不要求补齐到该时长。服务端从完整 FLAC 的 STREAMINFO 读取真实 `duration_seconds`，必须为正且不超过请求 `seconds`（仅允许50毫秒解析/采样误差），不信任自报时长。`seed` 为非负 JavaScript 安全整数，或完整无前导零的 uint64 十进制字符串，最大 `"18446744073709551615"`；大种子保持字符串原值，不能先转浮点数丢精度。

同一执行消费者还必须对该完整音频进行 ASR，并在 `inline_result.lyric_verification` 返回：

```json
{
  "algorithm": "ordered-whole-lyrics-v1",
  "audio_sha256": "<actual FLAC SHA-256>",
  "lyrics_sha256": "<approved whole lyrics SHA-256>",
  "full_audio": true,
  "language": "zh",
  "transcript": "<the entire audio transcript, including the tail>"
}
```

`language` 必须是实际 ASR 语言 `zh` 或 `en`；缺失或未知语言拒绝。音频摘要须对应同一结果，歌词摘要须对应同一原任务。一个任意 `verified:true` 不能代替原文 transcript，客户端仍需独立进行整段歌词有序匹配。没有音乐生成和完整音频转录链路的节点不能发布可用 music 能力。

## Claim、回执、取消和隐私

消费者使用 `POST /api/v1/capability-orders/claim` 上报实际能力、资源和同账户 LAN 节点；`dry_run:true` 仅检验联通性，不领取真实任务。正式响应只包含执行必需参数、指定节点、短期素材下载票据和 claim 租约，不含需求用户邮箱或钱包内部字段。

指定执行节点持绑定令牌调用：

- `POST /api/v1/capability-orders/callback`：携带稳定 `event_id`、原订单/`claim_id`；`started`/`progress` 续租，`completed` 校验全部结果后幂等终结，同事件不得重复写账、产生输出或重复消息。
- `GET /api/v1/capability-orders/{id}/worker-state?claim_id=...`：定期检查取消与租约失效，不能把查询当续租；取消后立即停止精确任务。
- `POST /api/v1/capability-orders/{id}/outputs/presign`：输出与订单、claim、绑定节点、role、大小和摘要绑定，按票据直接 PUT 到私有 COS，再以 `output_id` 回调。结果查询鉴权后签发短期 GET，不保存永久公开下载地址。

单订单原子领取不等于节点槽位原子预留。消费者必须遵守服务器返回的有效 claim 租约，持久化本地执行去重记录；过期 claim、错误节点、撤销绑定、跨组回调都不能完成原订单。取消、失败和租约回收必须释放对应槽位，不影响其他正在运行的订单；未知完成结果应按原 `event_id` 恢复，不能重跑另一任务冒充原结果。

取消正在执行的任务时不能提前虚增槽位：服务端保留该运行槽，节点确认取消/停止后释放，或等租约终止回收。消费者每15秒检查 worker-state，`started`/`progress` 同时续满订单和槽位的300秒租约。

### 请求体、校验和限流

新三类能力 `parameters` 最大1 MiB、`inline_result` 最大4 MiB，超限拒绝，不截断原消息或歌词。创建包络最大1 MiB＋128 KiB，Claim包络256 KiB，Callback包络4 MiB＋128 KiB，其他能力 JSON 请求默认128 KiB。音乐FLAC最大64 MiB；管理员验收JSON另限64 KiB。

每绑定节点 Callback 每分钟最多60次，第61次返回429；同一音乐 `order_id + claim_id` 的完整完成校验每分钟最多2次。限流后保留原订单、`claim_id`、`event_id` 和完整请求体重试，不能换事件规避限流或重新发单。相同事件与相同载荷可恢复，修改原载荷返回409。

音乐发布先读取源对象版本ETag，再执行携带源ETag条件的私有COS复制，目标为 `capability-orders/{orderId}/published/{outputId}-{24位随机hex}-{filename}`。目标从未签发PUT票据，消费者不能复用原PUT覆盖已完成结果；复制后从目标完整流式校验摘要、大小和真实FLAC时长再落订单。旧上传源保留原票据边界，不能把 HEAD 自报摘要等同于内容校验。条件复制失败或内容不符不发布成功回执，重试仍恢复原订单和事件。

## 孤立输出清理

音乐最终结果从有 PUT 权限的源对象复制到随机且没有 PUT 票据的私有 published 路径后，原源对象和中断流程可能遗留的 staging 副本由 `GET /api/cron/capability-output-cleanup` 清理。仅 `CRON_SECRET` Bearer 可调用，未配置返回503、匿名返回401，每轮最多检查50个对象。Vercel 每小时第23分钟执行；腾讯已有分钟维护器保留 H3 任务，用文件锁及固定小时状态文件保证此能力清理每UTC小时最多一次正常执行。

只删除严格匹配该订单、输出ID与受控前缀的过期对象，删除前重新读取订单引用。`order.outputs` 正引用的对象永远优先保留，记录 retained 且去除清理到期时间；不以 staging 标记或旧回调状态判定真实输出可删。源对象等待原一小时 PUT 票据到期后再处理，避免尚有效的票据将对象重建。删除失败保留重试并退避，响应和错误记录不包含签名 URL、凭据或原始 COS 异常。

## 验收与上线声明

官网路由测试、消费者 loopback 测试、真实模型推理/ASR 验收是三种不同证据，分别记录。至少覆盖完整请求响应、模型/向量维度、歌词尾部与实际语言、并发槽位、401/账户切换、取消、未知受理恢复、重复回调和零账务。离线/模拟消费者不能当成生产在线消费者；缺少实机证据时公开缺口并保持不可派单。未经明确授权，不为验收创建收费订单、修改真实会员/余额或启动 GPU 推理。

当前代码测试和公开GET合同验证不包含真实模型出片/音乐生成或完整ASR验收；没有因此登记虚假 acceptance。未知实际embedding模型和维度时继续保持不可用。已发布端点存在不等于在线消费者存在，只有之后经过授权的真实验收和对应节点及时上报，才可由目录显示可派单。
