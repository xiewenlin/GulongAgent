# 数字直播实时会话与有界媒体网关 v1

状态：会话控制、身份隔离、媒体直通、远程有界PCM输入及候选挑战/字节观察接口已实现，可审查/测试；**真实神经模型与独立播放见证验证器尚未接通，真实节点未验收，生产仍 `dispatchable=false`、`acceptance=adapter_required`**。候选result没有激活权限。不能把九项异步自动验收、模型文件存在、CPU编码测试或客户端原型当作连续直播通过。本次不占GPU、不改Windows服务、不安装依赖。

## 部署边界

控制API前缀 `/api/v1/digital-live/realtime`，官网和腾讯云使用同一源码。`GET /config` 返回合同和明确的不可派发状态；旧 `/api/v1/desktop/digital-live/config` 只增加 `control_contract_url`，原实时 `session_url/interrupt_url/media_transport` 继续为空。

媒体网关固定为 `https://111.229.70.235`，只在 `server/local.js` 的常驻Node进程启用。Vercel当前官方已提供WebSocket Beta，但此项目使用 `api/platform.js` 的普通fetch入口，未实现HTTP Upgrade，也没有跨实例媒体配对存储；不依赖Beta或内存粘性来宣称可用。Vercel/Sites媒体请求返回421 `REALTIME_PERSISTENT_GATEWAY_REQUIRED`。腾讯Caddy配置提供不缓冲代理，媒体流最长60秒/句、会话最长30分钟。

现有Tencent发布入口已负责校验Caddy候选配置、reload失败恢复，仓库实时路由随同一发布应用；发布完成前不把配置文件存在当作生产生效。当前没有可派发的实时消费者，因此不创建真实会话或上传视频以测试此代码。原生Sites项目仍保留原ID，连接器404时不建立替代站点。

## 账号、provider与创建

用户继续使用现有GGE登录的Bearer令牌，或官网受CSRF来源校验的会话；不新增账号体系/SKU/支付。有效包月必须有 `digital_live.use`，所有本产品会话0分，无余额扣减/分佣。用户和节点实时读取权威算力分组，未分组只匹配未分组；管理员不绕过分组。

`providers` 在登记、创建和每次节点事件中保持完全相同：

```json
{
  "text_model":"qwen38-27b-uncensored-q4-k-m",
  "tts_model":"qwen3-tts-0.6b-base",
  "avatar_model":"musetalk-1.5-stream",
  "character_id":"c01林晚晴",
  "voice_id":"c01",
  "character_image_sha256":"替换为真实64位小写SHA256",
  "voice_audio_sha256":"替换为真实64位小写SHA256",
  "asr_model":"仅在该精确组合独立验收远程ASR后出现的实际模型编号",
  "mime_type":"video/mp4; codecs=\"avc1.42E01E, mp4a.40.2\""
}
```

上面是字段示例，不是已验证的模型/codec组合。MIME必须来自实际avcC，6位hex不可猜测；角色和音色只传ID与摘要，绝不跨网上送本机路径。节点须核对本地实际目录，不能因有36项素材便批准36角色。文字模型固定实际27B Q4 ID，禁止小模型fallback。

客户端必须先GET受鉴权的 `/providers`（`config.catalog_url`），可精确筛选character_id/voice_id/character_image_sha256/voice_audio_sha256。返回 `providers[]` 每行含完整providers对象、capability_version、artifact_sha256、自动proof时间/证据摘要、verified_node_count/free_slot_count与dispatchable。仅本账户有效权益和同权威组、当前有效的自动实时证明组合会出现；候选库存不算ready，当前无验证器时数组为空是正确结果。客户端据实际行原样POST创建，不从本文示例或异步catalog猜模型/codec。

`POST /nodes/report`，Header `X-Gulong-Account-Binding`，JSON：

```json
{
  "capability_version":"digital-live-realtime-v1",
  "transport":"http-fmp4-mse-v1",
  "artifact_sha256":"替换为真实64位小写SHA256",
  "providers":["这里是上面完整providers对象，不是字符串"],
  "sharing_opt_in":true,
  "resources":{"gpu_state":"idle","gpu_observed_at":"真实ISO时间","current_task_remaining_seconds":0,"running_task_count":0}
}
```

返回 `{ok:true,inventory_recorded:true,dispatchable:false,acceptance:"adapter_required"}`，仅登记候选。客户端的ready/validated字段不获批准。生产 `lookupRealtimeProof` 故意无适配器；不能用环境变量、手动数据库记录或异步gcv跳过。后续需真实自动探测连续fMP4、实际provider、播放排空、打断代次和独占GPU，再实现服务器验证器；测试注入的memory proof不是上线证据。

`POST /sessions`，JSON `{client_product:"digital_live",client_request_id,providers}`。可提供同值 `Idempotency-Key`；稳定请求键8–160位ASCII。成功201 `{session,idempotent:false}`；重放200同一会话，改变参数409。没有同组、已自动实测、空闲且共享选择开启的节点时503 `REALTIME_INTEGRATION_REQUIRED`，不建单、不扣费。独占物理槽与九项探测/业务共用 `capabilityNodeSlots`，不能另起不兼容GPU锁。

`GET /sessions/by-request/{key}` 只恢复本账号/产品原键；`POST .../by-request/{key}/cancel` 可在创建前写取消墓碑，迟到创建也不能执行。未知创建结果只能查询原键，不能换键重复发。

会话返回字段：`id,client_product,client_request_id,state,generation,transport,gateway_origin,providers,worker_lease_expires_at,expires_at,pending_sentences,next_sequence,played_sequence,drained,cancellation_pending,cancel_reason,billing`。不返回用户邮箱、节点绑定ID/令牌、钱包内部字段。`GET /sessions/{id}` 仅本人；跨账户404，不能通过访问别人的会话触发过期写入。

## 节点领取、租约、句队列与打断

`POST /nodes/claim`，节点绑定Header，JSON `{lease_token:"节点预先持久保存的43位base64url随机密钥",dry_run:false}`。返回 `{session:workerDTO|null}`；仅已指定节点可领，同原密钥幂等恢复，不生成/返回新密钥。`dry_run:true`只返回reachable，绝不领取。

后续节点调用同时带 `X-Gulong-Account-Binding`、`X-Gulong-Realtime-Lease`。worker DTO只有会话ID、generation/state/providers/transport、期限和最多3项句队列，不含requester、email、wallet、binding或secret。

客户端每5秒 `POST /sessions/{id}/heartbeat`。节点每秒 `GET /sessions/{id}/worker-state` 获取当前代次及控制状态，每5秒 `POST .../worker-events`：`{generation,event:"heartbeat",providers}` 续15秒物理租约；必须同时有新鲜客户端心跳、有效权益/分组/精确实时证明。过期租约不复活，客户端断线后节点最长15秒必须停止自己持有的作业；网关不能终止其他任务。会话30分钟上限不能靠心跳延长。节点事件最多600次/分钟，用户控制最多240次/分钟；应合并文字delta，每秒1–2次提交，不为每个token发独立HTTP请求。

### 完整节点对话轮次（客户端不先运行LLM）

`POST /sessions/{id}/turns`：`{generation,request_id,turn_id,user_text,history}`。两种键都为8–160位稳定ASCII，原键未知只查询 `GET /sessions/{id}/turns/by-request/{request_id}`，不能换键或重跑模型。history最多16项 `{role:"user"|"assistant",content}`，不接受客户端system角色/选模型/改预算。user_text最多4000字；输入和历史加角色开销最多6144 UTF-8字节，保守留给节点系统词/输出，超出413，不静默截断。节点使用实际tokenizer再次强制8192总上下文和最多1024输出token，不能因预算失败换小模型。

worker-state的 `turn` 包含原user_text/history、request_id/turn_id、context_tokens=8192、max_output_tokens=1024、media_generation、state。由**同一指定节点**运行精确27B的真实流式输出，按句交给同一已验证TTS/avatar组合；不要求客户端先本地跑27B再上传句段。低层enqueue只是内部测试辅助，未注册用户HTTP接口。

同一session的 `generation` 仅打断/取消推进，防止旧执行回调；每次新turn另推进 `media_generation`，供客户端新建独立MediaSource/播放代次。媒体 `sequence` 在同一session generation中全局连续，`turn_sequence` 每轮从1开始；客户端不得把第二轮当旧轮，也不能静默改写官网身份。

流式节点事件仍POST worker-events，公共字段 `generation,providers,event_id,event_sequence,turn_id,media_generation,event`。event_id稳定持久；event_sequence从worker-state.last_event_sequence+1连续递增，原回包未知时同键/同内容恢复；新代次/重复不同内容409。支持：

- `event:"text_delta",delta`：单增量最多4096字节、整轮16KiB；产生 `type:"text.delta"`，model回显精确实际27B。
- `event:"media_announcement",sequence,turn_sequence,text,duration_seconds,timestamp_offset,mime_type`：text为该句真实27B输出（最多2000字），声明每句实际编码信息，不先谎称已发送；最多3句等待真实播放。每句最长60秒，offset为同轮内非负递增的编码时间轴。多个media可对应同一个turn_id。产生 `type:"session.media"`，同字段外加 `media_ticket_url`，不含长期密钥/带票据URL。
- `event:"turn_finished",final_sequence`：所有该轮媒体已完整传输，final_sequence必须与会话最后media序号相同，至少有一段真实媒体；产生 `type:"session.mediaEnd"`，含 `turn_id,media_generation,final_sequence,final_turn_sequence`。此时仍需全部played才drained。

客户端 `GET /sessions/{id}/events?after={cursor}` 每秒查询有界事件：`{session_id,generation,media_generation,events,next_cursor}`。服务端单调cursor，最多保留128事件；落后窗口409 `REALTIME_CURSOR_EXPIRED`，查询原会话取得当前代次/active_turn.text_snapshot，不重新执行模型或重播旧实时音频。worker-state不含用户身份，只含该会话原turn和必要队列。会话最多128个turn，原键收据有界保留；同一时刻只生成/播放一轮，新turn等待上一轮真实排空或显式打断。

`POST .../played`：`{generation,sequence,turn_id}`。客户端只有在 `video.played/currentTime` 真正越过该句编码边界后提交，最后一句还需EOS/ended。服务端只接受已经完整传输、按顺序的句段；这个ACK是客户端播放声明，不是服务端伪造的播放测量。`drained=true`还要求全部played ACK、队列空、turn_finished，不能用入队/上传完成代替。

`POST .../interrupt`：`{generation,request_id}`。原键重复不递增第二次；原子推进generation、清旧队列/旧票据连接，返回 `interrupting`，**不代表GPU已释放**。节点读到新代次后，只取消本会话旧推理并清队列，回 `worker-events {event:"interrupted",generation:新代次,providers}` 才回idle。旧帧、旧事件、旧ACK均不能恢复新代次。

`POST .../cancel` 进入cancelling，清旧代次但不提前释放物理槽。节点确认owned worker真正收尾后提交 `{event:"stopped",generation,providers}`，才幂等释放自己的精确物理lease；失联依赖lease自然到期，不杀其他服务。权益/分组撤销同样停止本会话，不转付费。

## 腾讯HTTP fMP4/MSE直通

客户端 `POST .../media-ticket`：`{generation,sequence,turn_id,media_generation,turn_sequence,origin}`，所有媒体身份必须对应同一个announcement。返回 `ticket,expires_at,method:"GET",authorization_scheme:"DigitalLiveMedia",media_url,transport,turn_id,media_generation,sequence,turn_sequence,duration_seconds,timestamp_offset,mime_type`。ticket最长30秒且不超过worker期限，服务端仅保存hash。只允许官网两个域名、腾讯HTTPS和明确Tauri本地Origin；不使用通配CORS。

客户端先 `GET media_url`，Header `Authorization: DigitalLiveMedia dlm_...` 和原Origin。不能把ticket放URL、日志、普通配置或跨Origin重发。严格一次消费、当前owner/product/generation/sequence/Origin校验；媒体连接未知/失败不凭原URL自动重放。

节点同一时刻 `PUT /sessions/{id}/media/{generation}/{sequence}` 到腾讯网关，带绑定/租约Header，Content-Type与providers.mime_type精确一致。HTTP body为FFmpeg正在输出的二进制fMP4：每句ftyp+moov初始化（包含edts/edit-list可以正常透传），随后moof/mdat；不是完整MP4落盘后拆包，不是JSON/base64。worker-state队列中有 `media_reader_ready`，节点应等该项true后启动对应编码输出；读取连接未建立时409 `REALTIME_MEDIA_READER_REQUIRED`且未接纳任何字节，不能因此重建模型turn。传输已开始/未知的PUT不自动重放。每句独立init允许客户端同轮同一个MediaSource/SourceBuffer用timestampOffset接续；实际AAC/帧边界可能有量化尾差，客户端按实际播放范围确认，不只用声明秒数。

网关最多8个流，单句16MiB/60秒、内部处理片最多256KiB；HTTP读取边界不等于编码片边界，合法合并网络chunk在总大小预算内拆分处理，不按其大小误拒绝。只保留小型有界流缓冲、完整fMP4 box边界检查，不把完整媒体写数据库/COS或缓存。每2秒重核执行租约/权益/分组/代次；5秒未释放写背压、断线、格式/大小/序号不符，取消原会话，不能阻塞其他流。没有用户确认不视为drained。

媒体已发送状态在Mongo持久记录。网关进程/部署重启不尝试恢复旧实时字节或转发到别的实例；客户端按原会话查询取消状态，节点必须观察15秒lease，重新开播需要新会话。控制状态保留7天后TTL；媒体ticket到期删除。不会将预签名URL或长期令牌持久写进消息。

## 验收边界

本模块单元/内存HTTP测试不是GPU验收。后续真实联调至少要：实际27B→TTS→神经avatar连续10轮、精确角色/音色摘要、首token/首样本/首帧、播放fps/偏差/队列水位、打断静音和worker回收、断线/重连、跨账号/分组拒绝、物理GPU独占/真实共驻。生产无验证器时任何客户端都不能自行注册ready。

官网任务负责受控challenge和服务端证据验证/写入通道；节点实际消费者由H3所属任务在九项自然安全检查点实现/实跑，数字直播任务负责客户端和独立神经worker。当前已有下述候选观察接口，但独立真实神经/播放见证验证器仍缺，因此不开放派发。不能手写proof、用环境开关解封或借用异步gcv。

## 远程真人语音输入（源码已接，真实ASR仍未开放）

只有实际provider行含 `asr_model` 且同一真实组合证明的 `realtime_asr` 独立通过才可使用；库存不能自动取得该字段权限。config.remote_asr当前明确 `status=integration_required,dispatchable=false`，公开状态枚举固定 `integration_required|available`，授权来源为 `authenticated_exact_provider_catalog`。受鉴权 `/providers` 返回同名remote_asr状态/布尔及逐行 `asr_dispatchable`、`proof.realtime_asr_verified`，仅精确模型、角色、音色、摘要及真正实时ASR证明与空闲节点相符才available/true。未知状态一律不可用，不猜ready/available。

目录free_slot_count用于**新会话**；已有会话所持独占物理槽不能导致会话内ASR被误禁用。已建会话的turn/ASR创建依其原provider及自有lease、当前权威组/账号权益/有效精确证明重新检查，不再预订新槽。当前生产所有真实组合仍未验收，目录为空。仅文字turn+视频通过不能称为真人连续语音完整链路。

`GET /config` 带当前GGE Bearer时，从该账号受鉴权实时目录导出顶层/remote_asr相同available/dispatchable状态；没有真实证明便保持integration_required/false，不会只更新catalog而让config永久false。匿名config始终不可派发；它不是解封证明。客户端创建前用相同登录身份查询config和精确provider行双层校验，已有会话不再以新会话空槽数量控制ASR。

1. 客户端 `POST /sessions/{id}/asr/utterances`：`{generation,request_id,turn_id,utterance_id,history}`，稳定原键，不传模型或音频JSON。仅上一轮已真实排空时开始，最多16项/4096字节历史；同键不同内容409。`GET /sessions/{id}/asr/by-request/{request_id}` 查询原语句，未知不能重录重投。
2. worker-state.input_audio含utterance_id/request_id/turn_id、实际ASR model、state、固定content_type、max_bytes、input摘要及read_path。指定节点先带绑定/原实时lease `GET /sessions/{id}/input-audio/{generation}/{utterance_id}`，常驻网关建立有界读取连接后持久记录reader_ready。
3. 客户端 `POST /sessions/{id}/asr/input-ticket`：`{generation,utterance_id,origin}`，返回一次 `DigitalLiveInput dli_...` header票据、input_url、method=PUT、期限和格式。URL不含票据，最长30秒且不超节点lease。必须等active_asr.reader_ready；输入开始后不再签新票据。
4. 客户端向腾讯input_url PUT二进制，Header `Authorization: DigitalLiveInput dli_...`、原Origin、`Content-Type: audio/pcm; rate=16000; channels=1; format=s16le`。单声道16k/s16le、每段最多20秒/640000字节，建议100ms=3200字节采集块；较大的合法网络合并读取会自动拆为最多64KiB的内部处理片，不假设TCP/HTTP保持上传帧边界。以EOF为这段明确端点，传输最多25秒、背压5秒；不是HTTP1浏览器在说话中必然持续发送的保证。原生代理应有界采集/上传，不Base64、不WebSpeech、不持久录音。
5. 网关完整统计bytes/SHA256，仅保存摘要，不保存音频。节点 `worker-events` 用原event_id/event_sequence/generation/providers/utterance_id/turn_id，`event:"asr_partial",text` 产生 `asr.partial`；`event:"asr_final",text,input_sha256,input_bytes` 必须与网关完整输入一致才接收。旧代次、旧语句、未收齐或摘要不符均拒绝。
6. **ASR final原子派生同一原request_id/turn_id的activeTurn**，由原指定节点接着跑27B。客户端不得再次调用普通live.send或POST /turns，否则会重复执行。`asr.final` 和active_asr查询包含generation/media_generation、原request_id/turn_id、input_sha256/input_bytes及event_cursor_start；客户端核对自己同一PCM摘要后，只查/附着原轮次。PUT回包丢失且状态receiving/unknown时不盲重传；input_received=true时只等原识别结果。取消或中断推进原session generation并关闭输入，不能让旧final恢复新轮次。

## 候选真实挑战与服务端字节观察（不会激活生产）

源码 `server/digital-live-verification.js`，节点继续使用自己的绑定，不向数字直播客户端传绑定密钥。所有后续挑战调用另带 `X-Gulong-Realtime-Verification-Lease`，不是业务实时租约。以下接口不是管理员手填验收，普通网页用户不可调用。

- `POST /verifications/next`：节点先持久保存 `{request_id,lease_token,provider_sha256,mode:"media"|"asr",dry_run:false}`。lease_token为本机新生成43位base64url高熵随机值，服务端只保存hash。`{dry_run:true}`只返回reachable、无挑战/预算/租约。必须有本节点当前选择共享的精确库存、新鲜idle GPU、空任务列表、无H3任务和空物理槽；不能抢九项验收。按原请求键重试只恢复原挑战。
- 每节点实时候选每天最多2次，同时计入既有每节点总验收16次预算；复用九项 `binding:*` / `global:0..3` 四个全站并发锁和独占物理槽，固定15分钟租约。超预算/忙碌不触发模型。原键保留失败/未发出记录，不自动换键重跑。
- `GET /verifications/by-request/{key}` 或 `/{id}` 查询原挑战。返回dlv ID、state/lease_valid、固定providers、provider_sha256、预算、固定随机nonce十轮短句或ASR输入下载票据；不返回binding/user/email/token。媒体模式最多10轮、每轮32输出token、音频总计60秒，第5轮需打断测试。ASR模式只允许现有服务器固定JFK 11秒完整FLAC夹具及其SHA，最多一次推理，不能换URL/音频。
- 节点媒体模式向腾讯 `PUT /verifications/{id}/media/{sequence}`（1–10）流式发原fMP4，Content-Type必须与原组合一致。服务器逐块检查、计算全字节摘要后丢弃原媒体，最多16MiB/片，不缓存完整视频或落库原音视频；查询只显示接收状态/大小/摘要。原片状态receiving/received/failed不自动重传或重跑模型，先查原请求。
- `POST /verifications/{id}/result` 提交有界**不可信声明**：`actual_provider_sha256,completed_turns,played_sequences,ended,interrupt{before_generation,after_generation,stopped_ms}`，ASR另含 `asr{fixture_sha256,transcript}`。ASR可省略没有实际执行的播放/打断字段，不能伪造数值。媒体声明与网关实际收到的十片字节记录分开保存；ASR需固定源摘要及完整转录关键句。缺实际媒体时awaiting_runtime_witness，数据错误failed。
- **即使十片实际字节/所有客户端声明看似完整，当前result也只能adapter_required，绝不写入capabilityAutoVerifications active或放开目录**。还缺真实神经运行身份和独立播放见证验证器；字节格式/客户端claimed played不能冒充这个证据。此接口连注入的验证器返回active都会拒绝转成激活状态。
- result完成不等于GPU释放。节点确认本次owned worker真实停止后 `POST /verifications/{id}/stopped {owned_worker_stopped:true}`，才幂等释放精确物理/全站锁；传输仍在进行则409，异常失联依15分钟租约到期。挑战/摘要7天TTL，保留失败证据，不阻塞其他节点。

当前上述源码/内存HTTP测试是协议与边界证据，未创建真实挑战、未请求模型。真实消费者、独立播放见证、可激活的神经验证器仍是后续必须完成的工作，不能宣称真人直播已全链路打通。
