# WorkLucky 普通业务准入（OpenAPI 2.14.11）

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

单元/内存HTTP测试不代表真实COS传输或模型E2E通过。WorkLucky生产素材开关仍由其归属在真实有界素材恢复验证后启用；官网不代它修改flag。真实素材验证不得顺带创建模型订单、claim或重跑九项，也不得占用DigitalLive语音/口型调试槽。
