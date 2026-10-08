# 会员与共享算力节点分组合同

算力分组独立于发行渠道。每个分组有管理员设置的名称和服务端生成、不可更改的唯一 ID：`gug_<32 位小写十六进制>`。名称唯一（NFKC、不区分大小写）；ID 有数据库唯一索引。

## 权限规则

- 已分组用户仅能调用同 ID 节点。已分组节点仅服务同 ID 的有效古龙引擎包月会员。管理员保持原有免计费规则，但也不可跨组。
- 未分组用户仅匹配未分组节点；历史没有 `computeGroupId` 字段视为未分组。
- 用户分组来自官网 `users.computeGroupId`，H3/Capability 节点分组来自 `nodeAccountBindings.computeGroupId`。客户端 JSON 中自报组没有授权作用。
- H3 同账号 LAN 内可有不同组节点，按各节点真实绑定分组独立筛选；只有 `assigned_node` 能执行并回调。
- Codex Market 使用其主机所属用户的当前分组，十槽租约仍独立校验。
- 创建任务保存分组，领取、输出上传签发、状态查询/续租及回调重新校验当前组。跨组返回 `403 COMPUTE_GROUP_MISMATCH`，不签发素材/输出票据、不写结果或分佣。
- 管理员修改用户组会更新排队中订单的分组；用户仍有运行中需求或 Codex 执行任务时返回 `409 USER_GROUP_BUSY`。节点仍有运行中 H3/Capability 任务时修改组返回 `409 NODE_GROUP_BUSY`。先完成或取消任务后再改组。
- 同一节点重新绑定同账号保留组；改绑其他账号清除原节点组。

## 管理员后台

入口：管理员后台 → 订阅用户 → 订阅详情 → 共享算力用户分组。先新建，再选择并点击“保存用户分组”。订阅有效期与分组分别保存。

管理员认证沿用官网会话或已有管理员 Bearer。所有写操作验证可信来源并记审计。

`GET /api/admin/compute-groups?q=<名称关键词>&limit=100&cursor=<上页nextCursor>`

`POST /api/admin/compute-groups`：`{"name":"品牌短视频团队"}`。成功 `201`：

```json
{"group":{"id":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"品牌短视频团队","createdAt":"2026-10-08T09:00:00.000Z"}}
```

`GET /api/admin/users/:id/compute-group`：用户 ID 可以是官网 ID 或已同步的 Chandler ID。

`PUT /api/admin/users/:id/compute-group`：`{"groupId":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`；清除用 `{"groupId":null}`。

读取/保存响应：

```json
{"computeGroupId":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","computeGroup":{"id":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"品牌短视频团队","createdAt":"2026-10-08T09:00:00.000Z"},"eligible":true}
```

保存响应另有 `ok:true`。`eligible` 表示后台已配置未撤销的古龙引擎包月产品，可提前给尚未生效的产品设置组；实际调用仍按有效期检查。其他产品不可新分组，残留分组可清除。没有组时两个 group 字段为 `null`。

## 桌面906节点设置

以下均使用 `X-Gulong-Account-Binding: gab_...`，必须是当前已激活、已绑定节点的高熵令牌。

`GET https://www.sologle.com/api/desktop/compute-groups?q=<名称关键词>&limit=100&cursor=<上页nextCursor>`

```json
{"groups":[{"id":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"品牌短视频团队","createdAt":"2026-10-08T09:00:00.000Z"}],"nextCursor":null}
```

`q` 为名称字面量模糊搜索（不接受正则），`limit` 为 1–200。若有 `nextCursor` 继续分页拉取；仅返回组名称/ID/创建时间，不包含组内用户信息。

`GET https://www.sologle.com/api/desktop/nodes/compute-group?node_id=<当前节点ID>`

`PUT https://www.sologle.com/api/desktop/nodes/compute-group`：

```json
{"node_id":"anonymous-stable-node-id","group_id":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

取消选择时 `group_id:null`。只可改当前令牌绑定节点，组必须已存在。成功响应：

```json
{"ok":true,"node_id":"anonymous-stable-node-id","group_id":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","group":{"id":"gug_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"品牌短视频团队","createdAt":"2026-10-08T09:00:00.000Z"},"policy":"same_group_only","ungrouped_policy":"ungrouped_nodes_only"}
```

节点本地缓存仅为界面显示；启动/重新绑定后重新 GET，以官网记录为准。领取请求不需要发送组，H3 `/api/h3/tasks/claim` 的 `assigned_node.compute_group_id` 返回服务器判定的节点组。

## 本地与局域网直连鉴权

浏览器派单由官网负责校验。对于桌面客户端直接调用本地/LAN节点的生成接口，客户端和节点必须接入下面两步，禁止仅凭邮箱、用户 ID、组 ID 或 LAN IP 放行。

1. 调用方使用现有官网会话、古龙桌面登录 Bearer 或古龙引擎桌面 Bearer，调用 `POST https://www.sologle.com/api/v1/compute-access/authorize`：`{"node_id":"目标节点匿名ID"}`。
2. 成功响应 `{"ok":true,"permit":"gcp_<高熵令牌>","node_id":"目标节点匿名ID","group_id":"gug_...或null","expires_at":"ISO时间","one_time":true}`。permit 有效 90 秒，数据库仅存哈希。
3. 调用方将 permit 随该次本地/LAN任务发送给目标节点（建议 HTTP header `X-Gulong-Compute-Permit`）。所有生成接口/插件工具入口必须验证，未验证不得开始推理。
4. 目标节点使用**自己的** binding header，调用 `POST https://www.sologle.com/api/desktop/compute-access/verify`：`{"node_id":"自身节点匿名ID","permit":"gcp_..."}`。
5. 官网重查调用方有效会员及双方当前分组，然后原子消耗许可，仅一次成功：

```json
{"ok":true,"allowed":true,"node_id":"目标节点匿名ID","group_id":"gug_...或null","requester_user_id":"官网用户ID","authorization_id":"许可审计ID"}
```

6. 只有 200 且 `allowed:true` 才执行。超时、401/403/429、网络失败均拒绝启动，并显示中文原因。重试同次调用需要重新获取许可；不可缓存一次成功作为永久授权。桌面本地队列未清空时也应禁止切换节点组。

## 错误与迁移

所有错误为 `{code,message}`，message 中文。主要状态：401 `BINDING_REQUIRED` / `BINDING_REVOKED`；403 `NODE_BINDING_MISMATCH` / `COMPUTE_GROUP_MISMATCH` / `GULONG_ENGINE_SUBSCRIPTION_REQUIRED` / `COMPUTE_PERMIT_INVALID`；404 `COMPUTE_GROUP_NOT_FOUND`；409 `COMPUTE_GROUP_EXISTS` / `USER_GROUP_BUSY` / `NODE_GROUP_BUSY`；429 `RATE_LIMITED`。

旧未分组客户端和数据继续使用未分组节点池，不会自动移入任何新组。分组改变不会修改钱包、订阅起止时间或授权激活码。官网 OpenAPI：`https://www.sologle.com/api/openapi.json`。
