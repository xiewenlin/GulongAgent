# Codex 共享节点：桌面接入合同

本合同对应 `/api/codex-market`。官网网页、H3 视频任务、Codex 共享任务和人工威客任务使用独立鉴权、能力与幂等合同，不得混用节点令牌。

## 路由与计费边界

- 龙言：本机 Codex 或可信 LAN 节点免费；需要官网共享节点时创建收费订单。执行模型固定为 `gpt-6-astra`、推理强度 `low`。
- 龙图：本机或可信 LAN 节点免费；官网共享节点固定 **0.14 元/次**。
- 官网收费成功后，执行节点与平台按实际订单金额五五分账。钱包按整数分记账；奇数分时节点取得向下取整的一半，平台取得余数，确保总账守恒。
- 管理员订单仍走完整任务、租约和回调流程，但 `chargedFen=0`，不产生节点或平台分成。
- `GULONG_CODEX_MARKET_DISABLED=true` 只关闭新报价和新订单；已创建任务仍可查询、回调和退款。
- MongoDB 必须是支持事务的副本集或 mongos。数据库不可达、standalone、缺少平台管理员账户时拒绝收费，绝不回退内存锁。

价格版本 `desktop-20260910-v4`（已包含一次 30% 加价）：

| 输入总量 | 非缓存输入 | 输出 | 缓存写入 | 缓存读取 |
| --- | ---: | ---: | ---: | ---: |
| 0–272,000 Tokens | ¥3.9/百万 | ¥19.5/百万 | ¥4.875/百万 | ¥0.39/百万 |
| 272,001+ Tokens | ¥7.8/百万 | ¥29.25/百万 | ¥9.75/百万 | ¥0.78/百万 |

`inputTokens` 专指非缓存输入，`cacheWriteTokens` 和 `cacheReadTokens` 是互斥缓存分类；分档量为三者之和。服务端用整数纳分/Token 计算各项总和，最后只向上取整一次到人民币分。订单保存完整 `pricingSnapshot`，后续价格升级不会重算旧订单；v3 及更早版本不再用于新报价。

边界验算：

- `271999` 非缓存输入、`1000` 输出、`1` 缓存读取，总输入 `272000`，费用 `109` 分。
- 上述缓存读取改成 `2`，总输入 `272001`，费用 `216` 分。
- 单类 `100000` Tokens：输入 `39` 分、输出 `195` 分、缓存写入 `49` 分、缓存读取 `4` 分。

## 请求者流程

账号请求沿用官网会话或 `Authorization: Bearer <Chandler access token>`。桌面遇到 401 时使用既有登录刷新逻辑；不得向执行节点发送账号 access token。

`GET /api/codex-market/models` 不要求登录，返回两种模型、价格标签、`pricingRevision`、可用状态、`nodeShareBps=5000`、`currency=CNY` 和 JSON 限额。

`POST /api/codex-market/quotes` 获取五分钟报价。龙图请求：

```json
{
  "model": "longtu",
  "requestId": "desktop-request-0001",
  "request": { "prompt": "一片荷叶", "images": [], "size": "1024x1024", "messages": [] }
}
```

龙言必须增加用户授权的最大计费用量：

```json
{
  "model": "longyan",
  "requestId": "desktop-request-0002",
  "request": { "prompt": "分析这份材料", "images": [], "size": "auto", "messages": [] },
  "usageLimit": {
    "inputTokens": 65536,
    "outputTokens": 8192,
    "cacheWriteTokens": 65536,
    "cacheReadTokens": 65536
  }
}
```

上述默认上限在 v4 的预留金额为 77 分。`usageLimit` 是用户授权的预留和结算上限，不是 Codex 上游生成硬限制。每项必须为 `0–2000000` 的整数，四项不能全为零。服务端按它计算最坏情况金额；同一账号、同一 `requestId` 只能重放完全相同的规范化请求及用量上限。

报价返回 HTTP 201，包含 `quoteId`、`executionModel`、`reasoningEffort`、`officialAmountFen`、`chargedFen`、`reservedFen`、两方预估分成、`billingExempt`、`pricingRevision`、`currency`、`usageLimit` 和 `expiresAt`。龙言缺少 `usageLimit` 返回 400 `USAGE_LIMIT_REQUIRED`，不进入事务收费。

`POST /api/codex-market/tasks`：

```json
{ "quoteId": "报价返回的ID", "requestId": "desktop-request-0002" }
```

创建返回 201，幂等重放返回 200。任务创建、钱包预扣和 `reserve` 流水同一事务提交。余额不足返回 402，持久保存 `rejected` 结果；充值后重放不会意外扣款。一个 quoteId 只能创建一个订单。

`GET /api/codex-market/tasks/{id}` 仅请求者或管理员可访问。任务公开字段含 `reservedFen`、最终 `chargedFen`、`refundedFen`、分成、状态、进度和截止时间；龙言完成后另含真实 `usage` 与计算快照。客户端只展示官网账本结果，不自行改余额。

## 节点注册、领取与租约

`POST /api/codex-market/nodes/register` 使用账号 Bearer。能够回传龙言真实用量的节点声明：

```json
{
  "nodeId": "device-stable-id",
  "nodeName": "我的电脑",
  "appVersion": "客户端版本",
  "capabilities": {
    "codexAvailable": true,
    "models": ["longyan", "longtu"],
    "usageReportingVersion": "codex-app-server-v1"
  }
}
```

返回 `{nodeId,nodeToken,heartbeatIntervalSeconds:30,leaseSeconds:120}`。服务端只保存 token 哈希。重新注册会轮换 token、撤销旧租约并重新排队未完成任务。没有 `usageReportingVersion=codex-app-server-v1` 的节点不能领取龙言收费订单。

节点请求使用 `X-Gulong-Codex-Node: cmn_...`。`POST /api/codex-market/nodes/heartbeat` 每 30 秒更新能力；执行中携带 `activeTask:{taskId,claimId,leaseToken}` 延长 120 秒租约，但不超过订单截止时间。

`POST /api/codex-market/tasks/claim` 请求 `{nodeId}`，按创建时间 FIFO 原子领取能力匹配任务，每节点最多一个活动订单。龙言任务额外返回 `executionModel:gpt-6-astra`、`reasoningEffort:low`、`usageLimit` 和 `usageReportingVersion:codex-app-server-v1`。领取 DTO 不含请求者身份、余额、钱包流水或分成账户。网络重试返回当前活动任务和同一领取令牌；旧租约不能回调或结算。

## 回调、真实用量与结算

`POST /api/codex-market/tasks/callback` 接受 `started`、`progress`、`completed`、`failed`。每个逻辑事件使用稳定 `eventId`；相同事件重试必须保持同一正文。

龙言完成回调：

```json
{
  "nodeId": "device-stable-id",
  "taskId": "任务ID",
  "claimId": "领取ID",
  "leaseToken": "领取令牌",
  "eventId": "task-completed-0001",
  "status": "completed",
  "result": { "text": "最终正文", "images": [] },
  "usage": {
    "source": "codex_app_server",
    "providerRequestId": "codex-request-0001",
    "inputTokens": 12000,
    "outputTokens": 800,
    "cacheWriteTokens": null,
    "cacheReadTokens": 4000,
    "cacheWriteTokensMeasured": false
  }
}
```

字段语义：

- `inputTokens` 是上游总输入扣除 `cachedInputTokens`，以及在出现独立写缓存字段时再扣除该互斥部分后的非缓存输入。
- `cacheReadTokens` 是上游真实 `cachedInputTokens`；`outputTokens` 是上游真实输出。
- 如果上游 JSON 中存在有效的 `cacheWriteInputTokens`，传整数和 `cacheWriteTokensMeasured=true`，按缓存写入价计费。
- 如果上游没有该字段，必须传 `cacheWriteTokens:null` 和 `cacheWriteTokensMeasured=false`。按用户确认规则，该项不另收费，未命中的输入继续按普通输入价计费；数据库原样保留 `null/false`，不能用反序列化默认值 0 冒充测得。
- `providerRequestId` 用于审计和回调指纹；服务端不接受前端估算替代真实用量。

缺少整个 usage、非缓存输入、缓存读取、输出或 providerRequestId 时返回 422；`measured=false` 却传入整数写缓存值也返回 422。真实用量超过任一授权上限返回 409 `USAGE_EXCEEDS_RESERVATION`，不追加扣款、不接收 completed。

真实用量低于预留上限时，服务端在同一 MongoDB 事务中：按订单价格快照计算实际金额、退回预留差额、节点入账、平台入账、保存结果、写回调幂等记录。任一步失败整笔回滚，节点以原 eventId 重试。失败和超时按原预留金额退款一次；完成与退款互斥。

龙图 completed 仍要求恰好一张有效 PNG/JPEG/WebP base64 图片。输入最多四张参考图、原始图像总量 2.5 MB、JSON 总量 3 MB。超限返回 413。任务最长一小时；查询或领取会在事务内补偿到期任务并退款。

## 数据、幂等与验收

集合：`codexMarketQuotes`、`codexMarketTasks`、`codexMarketNodes`、`codexMarketCallbacks`、`codexMarketLedger`，余额使用统一 `wallets`。报价 requestId、订单 requestId、quoteId、节点绑定、节点 token 哈希、回调 event 和账本 key 均有唯一索引；财务记录不设置 TTL。

流水类型：`reserve`、`reservation_adjustment_refund`、`node_commission`、`platform_commission`、`refund`。所有钱包变更必须携带同一 MongoDB session。单元事务模拟器用于故障注入；生产发布前还必须在真实 MongoDB 副本集的隔离测试库验证提交、回滚、重复回调和余额守恒，不能以模拟器替代。
