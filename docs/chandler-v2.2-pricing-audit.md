# Chandler v2.2（7.29）接口升级审计

审计来源：`D:\Users\用户交易技术平台合作\7.29 新版本 partner-getting-started.md`，并于 2026-07-30 对照 `https://api.chandler.work/openapi.yaml` 的线上契约。

## 相较 7.27 文档的有效变更

1. 新增应用级 SKU 列表/创建：`GET/POST /v1/me/oauth/clients/{client_id}/skus`。
2. 新增 SKU 在售状态控制：`POST /v1/me/oauth/clients/{client_id}/skus/{sku_id}/status`。
3. 新增 SKU 价格历史与价格版本创建：`GET/POST /v1/me/oauth/clients/{client_id}/skus/{sku_id}/prices`。
4. `POST /v1/pay/orders` 新增可选 `sku_id`。传入后由 Chandler 当前有效价格权威定价，客户端的 `amount`/`currency` 不再参与结算。
5. 直连商户仍使用相同的应用级定价；`DIRECT_ONLY_CLIENT_IDS` 只改变支付路由，不改变 SKU/价格管理方式。

文档其余认证、OAuth、用户扩展属性、订单 `partner_data`、支付配置版本、订单/退款、团队与财务接口和 7.27 版没有新增路径差异。

## 古龙官网的接入策略

- 管理员读取订阅套餐时，使用当前 Chandler 会话访问古龙应用自己的 SKU，不再从公共全局商品目录推断可修改对象。
- 修改订阅价格时，先在 Chandler 远程服务器创建不可变价格版本；远程调用失败时，不发布官网本地覆盖价格。
- Chandler 返回成功后，以 `chandlerPriceId` 幂等镜像到 MongoDB，并更新官网定价、下单校验和桌面端公开价格接口。
- 普通订阅在线下单传入 `sku_id`，由 Chandler 服务端权威计算金额；月度升级年度的差额订单仍为独立业务金额，继续使用服务端计算后的 `amount`。
- 管理员可以查看远程价格版本历史；官网 OpenAPI 同时提供 SKU 创建、停售/恢复与价格历史代理接口。

## 官网接口映射

| 古龙官网接口 | Chandler v2.2 接口 | 用途 |
|---|---|---|
| `GET /api/admin/chandler/catalog` | `GET /v1/me/oauth/clients/{client_id}/skus` | 读取月/年套餐及当前有效价 |
| `POST /api/admin/chandler/prices` | `POST /v1/me/oauth/clients/{client_id}/skus/{sku_id}/prices` | 创建远程价格版本并镜像 |
| `GET /api/admin/chandler/skus/{skuId}/prices` | 同路径的 `GET` | 查看远程价格历史 |
| `POST /api/admin/chandler/skus` | 应用 SKU `POST` | 创建 SKU |
| `POST /api/admin/chandler/skus/{skuId}/status` | SKU 状态 `POST` | 停售或恢复在售 |
| `GET /api/v1/pricing/subscriptions` | MongoDB 中的 Chandler 镜像版本 | 桌面端无缓存实时价格 |

## 安全与一致性门禁

- 价格写操作需要古龙官网管理员身份、受信任来源以及 Chandler 应用 `owner/admin` 权限。
- 金额只接受整数分，范围为 100–5,000,000；生效时间使用 RFC3339，过期时间必须晚于生效时间。
- `chandlerPriceId` 建立唯一稀疏索引，防止刷新或重试生成重复本地版本。
- 新价格版本不会改写历史订单；下单前会比较官网展示价和 Chandler 当前 SKU 价，发现不同即拒绝创建订单并要求刷新。
- 桌面端价格接口继续使用 `Cache-Control: no-store`。
