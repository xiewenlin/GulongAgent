# WorkLucky 普通业务准入（OpenAPI 2.14.14）

本轮直接人类指令已通过read_thread核实：WorkLucky userMessage `01a15b8b-b0cb-7ce1-9094-49574b204e25`，“请检查九项共享开放，全部开放后，重新发版”。九项合同验收不自动等于九项普通业务全开；本次先修复已有真实证据对应的安全门禁，不改任何旧失败、额度、激活记录或模型。

## 当前有效范围

- Qwen两项保留其独立983e制品、2.1合同和原512²/4步精确profile，不继承1829。
- 当前1829制品的agent_chat、embedding、generic music、SAM、MediaPipe、Whisper，仅对 `client_product=worklucky` 开放经现行自动proof审查的模型范围。每次报告/目录/新订单/领取都重读实际绑定、用户、算力分组、原矩阵、active/TTL、服务端pass audit与原模型；不信任客户端validated、静态名单或序列化旧批准。
- 原生 `minimax_music_3.generate/3` 仍不在普通准入审定中：已有记录是fixed_regression/business_admission=false，且节点普通业务取结果路径与专用验收路径不同。必须由节点归属修复并提供完整相关输入/适配证据后另行审定，不能直接复用generic随机结果或翻客户端flag。**当前不能声明WorkLucky九项全部开放，不能据此发布客户端“全开”版。**
- 其他产品、未知制品/新矩阵、跨组、撤销/过期或缺审计仍拒绝；没有扩大工具、多模态、2K、长音乐、长视频等未验收范围。probe侧1829隔离及已永久关闭的gvm/旧六/native次数不变。

准入对象由服务端实际查询产生，并用进程内不可伪造的引用标记绑定；报告进入Mongo/JSON后该引用不再有效，下一次业务请求必须重新读proof构造，不能靠复制字段绕过。最终业务matcher同时校验WorkLucky产品和有效引用，同账号无产品请求也不能回退。

## 客户端兼容

客户端继续采用既有business-effective `dispatchable`、`availability.verified_node_count/free_slot_count/status`、`models/native_profiles`。受隔离或未准入的scope不计入矩阵/计数，目录不返回可用后再靠附加false字段要求客户端猜测。POST与最终claim使用同一门禁。现有订单和素材原GET恢复不增加fresh业务gate；可按原key恢复历史状态，不能借此创建新订单。

## 修复项与真实验收边界

规范化节点报告的制品SHA位于 `validation.artifactSha256`，不是顶层artifactSha256；旧读取造成已验证Qwen也被误判未知。现在统一读取并拒绝多个来源冲突或格式无效的摘要。

可恢复素材只在真实COS对象404+NoSuchKey，或带COS request-id的直接空HEAD 404且无delete-marker时，才判断缺失并允许原票据剩余期内的防覆盖PUT。403、NoSuchBucket、任意代理404、未知状态都只返回unknown/503，不续签PUT、不误删除对象。原1小时绝对期限、原request_key/asset_id/object_key/六个签名headers、产品与角色隔离保持。

2.14.12 补齐真实 SDK 空 HEAD 形态：`statusCode=404, code="404"` 还必须同时具有 `x-cos-request-id`、`server=tencent-cos`、`content-length=0`，并且没有 `x-cos-delete-marker=true`，才认定原对象不存在。仅数字错误码、代理404、非空响应、403、桶不存在或删除标记仍不授权上传。此兼容修复不创建或修改素材、对象、原票据期限或验收预算；原请求到期仍返回410，不能自动换编号重试。原编号查询返回可上传状态也不等于客户端有权越过其已关闭的验收窗口恢复PUT。

单元/内存HTTP测试不代表真实COS传输或模型E2E通过。WorkLucky生产素材开关仍由其归属在真实有界素材恢复验证后启用；官网不代它修改flag。真实素材验证不得顺带创建模型订单、claim或重跑九项，也不得占用DigitalLive语音/口型调试槽。

## 第九项中文普通音乐：合同准备，不是开放

2.14.13 提供仅供服务端调用的 `createNativeMusicBusinessProbe`：必须为 `minimax_music_3.generate/3`、真实 `MiniMax-Music3`、库存含中文整段ASR，指定两行完整中文短歌词、0..2147483647整数seed及10..12秒整数时长。时长不得超过最终库存的实际 `max_duration_seconds`；11.993秒上限不能请求12秒。探测预算仅声明一次生成和一次整段ASR，不是执行授权。

中文结果必须与原始完整歌词、完整FLAC及实际摘要绑定，实际ASR语言须为 `zh`，返回的 `asrLanguages` 来自已校验结果；不能从旧英文/fixed/generic证明推导。时长校验使用本次请求±0.05秒，准入上限取请求与真实音频时长的较小值，绝不向上取整。旧英文nonce参数不重写，新英文挑战同样尊重模型整数时长上限。

此构造器**没有接入自动签发路径**，不接收公共请求选择、不增加quota、不解除新制品隔离、不改旧失败/关闭预算、不会创建模型订单。当前生产默认仍为英文挑战；拟定中文普通窗口必须等实际新安装制品、完整相关输入审查、精确artifact/绑定/分组/矩阵，以及独立一次窗口的持久化恢复与授权都明确后，才可由服务端选择。完成构造器CPU测试不等于第九项已开放。最终catalog/create/claim必须使用新制品自己的非fixed真实证明和当前有效范围，不能用这个文档或客户端flag放行。

## 原生 Music3 显式 seed（2.14.14）

`GET /api/v1/capability-orders/catalog` 中 `minimax_music_3.generate` 的 `parameters_schema` 要求 `seed` 必填，类型 integer，范围 0..2147483647；`default: 0` 仅供客户端初始化表单。创建 `POST /api/v1/capability-orders` 时必须显式提交，例如 `parameters: {prompt: "中文音乐描述", seed: 0}`。缺失、负数、字符串、小数或越界值返回 HTTP 400 / `INVALID_CAPABILITY_PARAMETERS`，服务端不会补 0、随机生成或改写历史任务。原编号 GET 查询与取消使用保存的原任务，不重新规范化旧 seed；旧非法参数不得更换为 0 后重试原幂等键。

图片 seed=-1 的语义不变；`gulong_engine.music` 是独立合同，仍支持显式非负安全整数或完整 uint64 十进制字符串，不能借用原生 Music3 的证明或范围。这次仅修正参数合同，不签发挑战、不增加预算、不开放第九项派单。
