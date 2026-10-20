# 通用音乐追加验收授权（OpenAPI 2.14.10）

直接人类授权来自会话906：turn `01a159aa-4e6e-7a30-b764-942e0491b314`、userMessage `01a159bc-19d5-7643-9a8f-3648714f5635`，原文为“请追加次数，无需确认，直到验收通过为止，测完之后，立即重新发版。”官网通过read_thread直接核实，不将其他代理的转述作为授权本身。

仅1829制品、原绑定/节点/用户/空组的 `gulong_engine.music` 原raw矩阵可使用。原生Music3和其余已通过八项不新增次数。父六项每项1次/总6保持耗尽；原generic request `0bf14094-7f29-4e16-8e65-fe6244b772ca`、gcv `gcv_544da053-eb9b-43f7-9fef-092c5f955c75` 的时长失败不修改。原完整12秒音乐挑战、原生MiniMax-Music3、随机新歌词验证码/种子、1次推理及1次完整ASR、COS实物和至少11秒标准都不变。禁止填充静音、裁切/替换歌词或把失败请求换成成功。

新独立集合 `capabilityVerificationGenericMusicContinuations`，授权ID `gvm_20261020_1829_generic_until_pass`、epoch `20261020-human-generic-only-v1`。只有双端部署、前端一致性和只读合同检查完成后，CI精确核对`.deploy-commit`、真实旧失败及当前库存，才首次插入readyAt和3次独立额度。固定绝对截止 **2026-10-21T14:30:00Z（北京时间2026-10-21 22:30）**；不是复活旧窗口，也不随发布/失败/通过重新起算。重新执行CI只返回原值。

每批3次、串行一次：上次真实失败/准备失败/租约失败结束后才允许下一次。用完一批且仍未通过时，可按本条已核实授权在下一次真实领取CAS中增加下一批3次；usedTotal和全部消费request/challenge按序累计、不重置。安全硬上限126次/本绝对窗口，既有64个新请求/UTC日、速率限制、原指数退避、GPU空闲、单节点/全局/独占物理槽门禁仍适用；不能用批次机制绕过它们。到期或安全上限后停止，若仍未通过只能在本条人类授权下另行受审新grant，不能静默延长原账本。并发只允许一条原始消费，失败/准备失败不返还；状态不确定时不再签发。原键恢复不重跑推理。

任一同矩阵generic正式active回执（原v1四标记、时长>=11、真实pass audit/摘要均正确）出现时，后续领取立即关闭，即使关闭账本写入暂时失败也先拒绝新挑战；正常成功回调会把账本状态永久设为passed，后续库存刷新/失败/发布不会复活。消费者不使用客户端validated判断。此授权不授予1829普通业务准入，未知制品业务隔离不变。

只读 `GET /api/v1/capability-verifications/supplemental-budget`，原 `X-Gulong-Account-Binding`，新增 `generic_music_continuation`：authorization_id/authorization_epoch、ready_at、expires_at、state、batch_size、safety_max_attempts、total.{limit,issued,used,remaining}、next_batch_available。limit/remaining包含已授权但尚未物化的下一批时会明确next_batch_available=true；issued为实际已物化累计数。无HTTP激活端点，无令牌/密钥输出。next/result合同不变，journal budgetSource=`generic_music_continuation`。

节点可只读识别新grant/epoch，但本轮保持原自然nextAt（2026-10-20T15:09:07Z）；官网不修改本地journal、不重启服务、不强制next。实跑通过后，由节点归属完成全部软件/包资格并发版；官网代码测试通过不冒充九项真实通过。
