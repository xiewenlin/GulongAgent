# 古龙引擎包月桌面端合同

生产基址：`https://www.sologle.com`。机器可读 OpenAPI：`/api/openapi.json`（v2.10.0）。这是独立产品月套餐，不自动获得普通会员、英语教练或短视频包月权益，也不向钱包充值。

## 登录与权益

桌面端使用官网用户名或邮箱和密码登录，不需要用户提供 PearAPI Key：

| 操作 | 路径 | 返回 |
|---|---|---|
| 登录 | `POST /api/v1/desktop/gulong-engine/auth/login` | `{ "access_token":"gge_at_...", "refresh_token":"gge_rt_...", "token_type":"Bearer", "expires_in":900 }` |
| 轮换刷新 | `POST /api/v1/desktop/gulong-engine/auth/refresh` | 同登录；旧令牌失效 |
| 注销 | `POST /api/v1/desktop/gulong-engine/auth/logout` | `{ "ok":true }` |
| 权益 | `GET /api/v1/desktop/gulong-engine/account` | `user`、`entitlement`、`checked_at` |

登录 JSON 为 `{ "identifier":"用户名或邮箱", "password":"密码" }`；刷新 JSON 为 `{ "refresh_token":"gge_rt_..." }`；注销携带访问令牌和可选刷新令牌。权益 `product="gulong_engine"`、`plan_id="gulong_engine_monthly"`、`monthly_price_fen=19800`，`status` 为 `inactive|scheduled|active|expired`，并返回 `starts_at`、`expires_at`、`capabilities`。访问令牌 15 分钟，刷新会话最长 30 天；仅服务端保存令牌哈希。英语教练的 `gec_`、古龙的 `gge_` 令牌互不通用。到期拒绝新的模型或能力订单，历史结果仍允许本人查询。错误使用中文 `{ "code", "message" }`。

官网 `/pricing?tab=subscription` 支持 `planType=gulong_engine_monthly`、`cycle=month`、`provider=offline` 的 198 元线下审核订单。管理员可在“订阅用户”中独立设置该产品的生效和到期时间。审核通过只延长独立权益，不增加钱包余额。

## 9 个免费文本模型

`Authorization: Bearer gge_at_...` 可调用：

- `GET /api/v1/desktop/pearapi/models`：返回九个免费文本模型，默认 `ox-alpha`；`image_models=[]`、`video_models=[]`。
- `POST /api/v1/desktop/pearapi/generations`：提交 `type=text`、目录内模型、文本消息和 8–160 字符 `Idempotency-Key`；图片/视频在此路由返回 `403 FREE_TEXT_ONLY`，不能意外进入付费媒体计费。
- `GET /api/v1/desktop/pearapi/generations/{id}`：本人轮询状态和结果。
- `GET /api/v1/desktop/pearapi/generations/by-request/{key}`：按原始幂等键找回已提交文本，不重复调用模型。
- `POST /api/v1/desktop/pearapi/generations/{id}/cancel`：取消本人的生成。

免费模型目录：`ox-alpha`、`minimax-m3`、`glm-4-flash-250414`、`GPT-OSS-120B`、`hunyuan-mt-7b`、`hy-mt2-1.8b`、`mistral-7b-instruct-v0.2`、`spark-lite`、`step-3.5-flash`。结果由官网管理员的服务端 PearAPI 凭据调用，客户端不得获取该凭据。古龙绿色版令牌对 PearAPI 图片、视频模型没有钱包扣费入口。

## 独立的零单次价格共享能力

`GET /api/v1/capability-orders/catalog` 返回 `gulong_engine.text`、`gulong_engine.image`、`gulong_engine.video`，均为 `priceFen=0`，不扣钱包、不分佣。客户端用 `POST /api/v1/capability-orders`、`Idempotency-Key` 和 `Authorization: Bearer gge_at_...` 创建。`text` 可提交 `prompt` 与可选 `model`；`image` 支持 `zimage` 或 `qwen_image_2_1`，最多 9 张 PNG/JPEG/WebP 参考图，单张最多 40 MiB；所有素材先走 `/api/v1/capability-assets/presign` 直传与 `/{asset_id}/complete` 回执核验。创建响应的 `order.id` 可用 `GET /api/v1/capability-orders/{id}` 查询；原请求丢失可走 `/api/v1/capability-orders/by-request/{key}` 恢复。

视频能力当前只公开独立的版本化参数和输出合同，`dispatchable=false`，尚未有真实节点适配器时 `POST` 明确返回 `409 CAPABILITY_ADAPTER_REQUIRED`；不能用已有收费的 `/api/h3/tasks` 偷换成零价路径。只有真实推理验收和节点适配完成后才可开放。

节点沿用 `X-Gulong-Account-Binding: gab_...`，必须上报已安装、已验证、已启用、30 天内的验证摘要；服务其他账户时还必须明确 `sharing_opt_in=true`。订单领取、素材/输出签名地址、回调和幂等规则见 [统一能力订单合同](./unified-capability-orders-v1.md)。用户钱包、邮箱等敏感字段不会下发给执行节点。
