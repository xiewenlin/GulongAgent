# H3 强制零扣费合同 v1

## 请求与真实账单

沿用 `POST /api/h3/tasks`、现有 `tasks:write` 鉴权和 8–160 字符的 `Idempotency-Key`。
新增可选布尔字段 `require_no_charge`；非布尔值返回 `400 VALIDATION_ERROR`。

```json
{"source_channel":"desktop_agent","model":"minimax_h3_shared","prompt":"原始中文需求","duration_seconds":5,"aspect_ratio":"16:9","profile":"official_max","require_no_charge":true,"assets":{"images":[],"videos":[],"audio":[]}}
```

- `true`：当前有效古龙引擎包月会员或需求账号为管理员，才允许零扣费受理。其他情况返回 `403 H3_NO_CHARGE_ENTITLEMENT_REQUIRED`，不插入任务，不扣钱包或套餐，不产生佣金。
- 缺省/`false`：原计费行为和旧规范化指纹保持不变。不得作为客户端失败后的付费降级。
- 请求字段仅是计费上限约束，不授予会员、账号、素材或分组权限。
- 同键同请求重放原单；同键切换该约束或参数，返回 `409 IDEMPOTENCY_KEY_CONFLICT`，不能重放旧收费单或创建第二单。
- 成功响应的 `task.requireNoCharge=true`、`task.chargedFen=0`、`billing.chargedFen=0`；会员为 `billingMode=gulong_engine_membership`、`chargeStatus=member_no_charge`，管理员为 `administrator_exempt/exempt`。`priceFen` 是参考价格，不是实际扣款。

资格按服务端读取权威订阅时的时刻确定，而非客户端时间。读取成功后本请求固定选择零计费分支；并发到期、撤销或数据库异常都不得触发收费备用分支。本合同保证最高实际扣费为零，不宣称订阅读取与任务插入已组成跨集合事务，也不宣称撤权会回溯撤销此前已通过校验的受理。

## 生命周期

服务端将 `requireNoCharge:true` 纳入指纹并与真实零账单一起保存。缺失历史指纹时，内部恢复也保留该字段；客户端不能覆盖账单、流水或角色快照。

原单的租约恢复、GPU故障自动重派、合法完成和重复回调不重新预扣、不补扣、不分佣；失败也不会凭空退款。明确零费受理的原任务可以在随后会员到期时继续执行，但仍检查账号、绑定、素材、任务归属及同组隔离。

`POST /api/admin/h3/tasks/{id}/retry` 是主动重新受理：原任务 `requireNoCharge=true` 时必须重新检查需求用户当前权益，无权益仍返回上述403，原状态和重试次数不变；续费后才能零费重试。操作管理员不能把他人的任务伪装成管理员自用。未带约束的历史订单保留原流程，不在本轮改写或洗账。

请求结果未知时保留原请求、幂等键和已收到的订单ID；有ID则 `GET /api/h3/tasks/{id}` 对账。相同请求重放只能复用原键，不能换键、跨节点广播或改成收费请求。

## 工具发现

`GET /api/v1/desktop/agent/tools/minimax-h3-shared` 保持原鉴权和 `tool.createTask.url=/api/h3/tasks`，新增：

```json
{"tool":{"noChargeCreation":{"version":1,"requestField":"require_no_charge","enforced":true,"onUnavailable":"reject_without_order_or_charge"}}}
```

缺失、查询失败、字段不符或 `enforced=false` 时客户端继续禁用新提交，不试探收费。工具响应和公开 OpenAPI 同时表达阶段，OpenAPI不能替代账号的实际资格检查。

## 双目标发布与回滚

最低安全回滚基线：`b6a08f75d367e644212cca8f2d71eea53a8d70cc`。该版本两端保护已发布，公开合同阶段和30个客户端文件已做只读一致性核验。

1. A（保护基线）：完整guard、测试、OpenAPI先部署到Vercel和腾讯云，工具保持 `enforced=false`。A的POST已强制执行零费约束，并非忽略字段或503占位。
2. 确认两端A的版本、健康及合同后，B激活 `enforced=true`，再次发布并核验两端。
3. 只有B双目标通过后才报告合同开放。最低回滚版本是A；回滚A会关闭新入口，但在途请求仍受guard保护。
4. **禁止回滚到忽略 require_no_charge 的旧版本。** 如果不得不恢复更早的实现，必须先停止外部创建/重试流量（包括仍在途或缓存声明的客户端）。健康检查本身不证明计费协议兼容。

生产只做GET合同和鉴权核验，不发视频订单，不启动GPU，不修改真实会员、钱包或套餐。真实会员正例如未进行，应明确记录未验收，不能用模拟/源码解析冒充实跑。隔离内存测试验证扣费拒绝、并发、异常、重试及回调。

验证命令（只读GET；不输出凭据或账户内容）：

```
node scripts/verify-h3-no-charge-deployment.mjs --phase=baseline https://sologle.com https://111.229.70.235
node scripts/verify-h3-no-charge-deployment.mjs --phase=active https://sologle.com https://111.229.70.235
```

可选环境变量 `H3_NO_CHARGE_VERIFY_VERCEL_TOKEN`、`H3_NO_CHARGE_VERIFY_TENCENT_TOKEN` 只用于GET工具；未提供时通过公开OpenAPI阶段声明核验，真实鉴权工具响应仍未验收。完整账务验证由隔离测试承担。
