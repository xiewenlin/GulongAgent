# 独立产品有效期与 Chandler 同步保护

管理员“订阅用户 → 订阅详情 → 古龙引擎包月”的保存路径为
`PUT /api/admin/users/{id}/subscription-period`，body 是 `products` 数组。
它写入 `subscriptions.products.gulong_engine_monthly`，包含起止时间及
`manualPeriodOverride=true`。GGE 桌面 `GET /api/v1/desktop/gulong-engine/account`
优先读取同一产品；有效时 `entitlement.capabilities` 包含 `digital_live.use`。

修复前 Chandler 同步只检查顶层 `manualPeriodOverride`。当独立产品有管理员覆盖、
顶层没有覆盖，且远程同步指向同一产品时，旧远程日期可覆盖管理员的新日期。
管理员列表刷新或重新打开详情都会经过该同步路径。这是合成数据可复现的缺陷，
不是对某个真实账户曾被覆盖的断言。

从 OpenAPI 2.17.7 起，同步同时保护顶层覆盖与目标产品的独立覆盖，包括撤销。
更新按原记录 ID、ownerId、updatedAt 及覆盖标记执行条件写；并发修改时跳过，
不无条件重试。原记录不存在时只执行 `$setOnInsert`；如果管理员已并发创建该
ownerId 的记录，则不修改它。不假设旧部署已有唯一 ownerId 索引，也不在本修复中
执行生产索引或数据迁移。其他未覆盖产品仍可正常同步。

不修改付费、钱包或模型准入规则，不读取或批量修复真实会员数据，不自动延长有效期。
若某账户此前已被旧同步覆盖，应由管理员核对该账户并明确重新保存正确日期；
不能从其他产品、顶层旧日期或审计记录自动猜测授权。
