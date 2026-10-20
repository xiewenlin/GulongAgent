# 固定原生 Music3 通过后的六项条件补验：本地草案

状态：仅本地代码/内存CPU回归，尚未被app/next导入、未注册路由、未部署、未创建生产六项账本。固定单次生产版本394de5/OAS2.14.8不受影响。用户条件授权消息为 `01a15943-0a37-7d81-9a97-7ca53607a54b`（call_c3a9a9525da2456f86bef39f1f5f67d4），不包含第二次native或Qwen重跑。

范围为原binding/node/user/空组、实际1829制品及已计算的六项完整raw matrix：agent_chat、embedding、generic_music（含一次整段ASR）、SAM、MediaPipe、Whisper。每cap1次、总6，不借额度、不续额，不能回退ordinary或旧grant。窗口从独立固定单次账本复制：本次已实际ready `2026-10-20T12:29:52.868Z`、截止 `2026-10-20T14:29:52.868Z`，绝不从native通过/后继部署时重新起算。

数据库门禁同时要求：固定单次授权合法且已消耗1；当前绑定/节点/用户/组正确；同1829 native矩阵的真实active记录；固定原参数/来源正确、fixedCaseOnly保留；全部原生v1音乐、整段ASR、完整歌词、时长与fixed_regression_case标记；有效testedAt/TTL/testEvidence；合法原生verifiedModel；原request与record/resultFingerprint匹配；真实服务端pass audit及model匹配。旧554a通过、客户端validated、会话报喜、缺审计或仅耗额都不满足。

条件未满足时有效limit/remaining均0，不创建六项账本，不预留资源或触发模型。条件成立后首次真实领取才建立独立表 `capabilityVerificationConditionalSixBudgets`，总数和单cap在一次Mongo CAS中消费；失败/准备失败不返还，重复request仍需沿用既有恢复路径。父证明在消费后变化时立即报错，不返回可执行挑战；不以冲回计数隐藏失败。父窗口过期后所有余量都不能使用。

待生产接线：在既有未知制品隔离分支中，只允许固定单次或这个经数据库核验的条件预算；GPU/独占物理槽必须先获取再消费。generic音乐挑战预算明确max_asr_passes=1，仍沿用原v1/COS实物校验；六项均不包含native/Qwen。须加原请求恢复/准备失败/资源忙的接线回归、完整测试及双端一致性发布，不得仅因本草案单测通过就声称线上可用。

固定native可作为本轮正式native合同实测项，但必须保留fixed输入限制、parameters/source/newartifact及business_admission=false；不要求未经授权的另一次随机native。九项合同通过数量、离线包发布门禁与官网业务dispatchable是不同字段，不可丢弃scope限制来扩大共享准入。
