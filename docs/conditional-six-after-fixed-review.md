# 固定原生 Music3 通过后的六项条件补验

发布接线：OpenAPI 2.14.9。官网只读核实正式native记录 `0836e6bc13cfad7d46cdf1dda8b3a0eb376416e9257b81979a9cd323c4d897a4` 在 `2026-10-20T12:50:53.341Z` 为active，六个原v1标记全true，原request、固定单次消费及来源一致。用户条件授权消息为 `01a15943-0a37-7d81-9a97-7ca53607a54b`（call_c3a9a9525da2456f86bef39f1f5f67d4），不包含第二次native或Qwen重跑。内存测试不冒充真实模型验收。

范围为原binding/node/user/空组、实际1829制品及已计算的六项完整raw matrix：agent_chat、embedding、generic_music（含一次整段ASR）、SAM、MediaPipe、Whisper。每cap1次、总6，不借额度、不续额，不能回退ordinary或旧grant。窗口从独立固定单次账本复制：本次已实际ready `2026-10-20T12:29:52.868Z`、截止 `2026-10-20T14:29:52.868Z`，绝不从native通过/后继部署时重新起算。

数据库门禁同时要求：固定单次授权合法且已消耗1；当前绑定/节点/用户/组正确；同1829 native矩阵的真实active记录；固定原参数/来源正确、fixedCaseOnly保留；全部原生v1音乐、整段ASR、完整歌词、时长与fixed_regression_case标记；有效testedAt/TTL/testEvidence；合法原生verifiedModel；原request与record/resultFingerprint匹配；真实服务端pass audit及model匹配。旧554a通过、客户端validated、会话报喜、缺审计或仅耗额都不满足。

条件未满足时有效limit/remaining均0，不创建六项账本，不预留资源或触发模型。条件成立后首次真实领取才建立独立表 `capabilityVerificationConditionalSixBudgets`，总数和单cap在一次Mongo CAS中消费；失败/准备失败不返还，重复request仍需沿用既有恢复路径。父证明在消费后变化时立即报错，不返回可执行挑战；不以冲回计数隐藏失败。父窗口过期后所有余量都不能使用。

在既有未知制品隔离分支中，只允许固定单次或这个经数据库核验的条件预算；GPU/独占物理槽必须先获取再消费。generic音乐挑战预算明确max_asr_passes=1，仍沿用原v1/COS实物校验；六项均不包含native/Qwen。`GET /api/v1/capability-verifications/supplemental-budget` 新增 `conditional_six_after_fixed`，只读显示实际门禁和计数。原next请求/结果协议不变；日志budgetSource为`conditional_six_after_fixed`。原请求恢复、准备失败、资源忙和真实退避均有接线回归；不改客户端nextAt、不强制next、不安装/重启服务。未知制品普通业务隔离不变，六项通过不自动授权1829的普通业务派单。

固定native可作为本轮正式native合同实测项，但必须保留fixed输入限制、parameters/source/newartifact及business_admission=false；不要求未经授权的另一次随机native。九项合同通过数量、离线包发布门禁与官网业务dispatchable是不同字段，不可丢弃scope限制来扩大共享准入。
