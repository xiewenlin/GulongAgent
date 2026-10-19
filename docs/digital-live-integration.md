# 数字直播：独立包月权益与异步共享合同 v1

API base固定使用 `https://www.sologle.com`。腾讯云相同源码端点为 `https://111.229.70.235`；一个客户端会话、原请求、素材和结果始终使用选定的同一base，不因超时跨平台换站重建任务。线上代码是否已发布，以两端部署清单commit与OpenAPI/config为准；单元测试、源码完成、安装版消费者发布及真实模型验收是四个不同阶段。

## 1. 现有价格与账号

不新增收费SKU，不新建账户体系。沿用古龙引擎包月 `gulong_engine_monthly` 当前权威价格99900分/月（999元），订阅只走既有流程。有效期内权益增加 `digital_live.use`，`included_products`增加`digital_live`；未生效、禁用、过期均不返回该使用能力。权益表示软件使用资格，不表示模型已安装或共享节点已验收。

- `POST /api/v1/desktop/gulong-engine/auth/login`，JSON `{identifier,password}`（官网用户名/邮箱与原密码，客户端不保存密码）。
- 成功200：`{access_token,refresh_token,token_type:"Bearer",expires_in,user:{id,display_name,email},entitlement:{product:"gulong_engine",plan_id:"gulong_engine_monthly",included_products:[...],active,status,starts_at,expires_at,capabilities:[...],monthly_price_fen},checked_at}`。生效时capabilities含`digital_live.use`。
- `GET /api/v1/desktop/gulong-engine/account`，Header `Authorization: Bearer gge_at_...`，返回同一账号与当前权威entitlement；必须定期刷新，不永久缓存登录时的active。
- 刷新/注销沿用 `/api/v1/desktop/gulong-engine/auth/refresh`、`auth/logout`。刷新JSON为`{refresh_token}`，原子轮换；刷新回包仍为token四字段，客户端随后GET account。

沿用既有限流、会话撤销和错误中文化，不读取或返回Chandler/PearAPI密钥。WorkLucky登录别名的原回包保持兼容。本产品使用GGE身份，但**不是WorkLucky产品标记**；产品标记是归因与订单/素材隔离，不是独立密码体系或新增权限域。

## 2. 产品发现

公开、不缓存：`GET /api/v1/desktop/digital-live/config`，可选`?product=digital_live`，错误/重复产品值400。

返回 `schema_version=digital-live-product-v1`、`product=digital_live`、`subscription.required_capability=digital_live.use`、`included_in_plan=true`、`separate_purchase=false`，以及现有GGE auth路径、异步订单路径、精确模型策略和实时缺口。

鉴权目录：`GET /api/v1/capability-orders/catalog?product=digital_live`。

| 能力ID | 合同/模型策略 |
|---|---|
| `gulong_engine.agent_chat` | 1.0.0；模型必须精确 `qwen38-27b-uncensored`，完整OpenAI request/response，不替换成Qwen3-1.7B |
| `qwen_image_2_1.text_to_image` | 2.1；Qwen-Image真实组件ID `qwen-image21-uc`或既有`qwen_image_2_1`，只按实测模型行/参数范围 |
| `qwen_image_2_1.multi_image_edit` | 2.1；Qwen-Image原生参考编辑，按`native_profiles`精确范围 |
| `gulong_engine.image_2k` | 1.0.0；`qwen_image_2_1`独立原生2K验证范围，不从512²资格放大 |
| `whisper.transcribe` | `large-v3-turbo-whisper.cpp`；真实`whisper-large-v3-turbo`，原生全段JSON及毫秒offset |
| `gulong_engine.tts` | 1.0.0；真实已自动验证的同一`model/voice_id`组合，不能因36个本地角色素材存在就宣称36种远程音色已就绪 |

所有候选必须真实自动验收、明确同意共享、当前在线、同算力分组及原子物理槽位匹配。目录只计入上述精确模型；其他Qwen在线不算指定27B模型可用。`availability.models/native_profiles`是原子已验证组合，不能合并不同节点的tools和multimodal标志造出未验证组合。未验证、离线或没有兼容精确参数时不建单（409 CAPABILITY_NO_COMPATIBLE_NODE），不回退到付费供应商。

原生Qwen参数schema不接受`model`字段：模型选择从目录整行匹配并作客户端审计，不强塞parameters。请求的能力ID已经固定原生模型路线。其他能力同样使用目录公开的真实schema和完整输入输出role。

## 3. 原请求、派单与取消

首次联网前持久化原 `client_request_id`（8–160个ASCII字母数字或`_.:-`），完整参数与素材receipt。POST `/api/v1/capability-orders`：

```json
{
  "client_product":"digital_live",
  "client_request_id":"digital-live:original-0001",
  "capability_id":"gulong_engine.agent_chat",
  "capability_version":"1.0.0",
  "source_channel":"desktop_agent",
  "parameters":{
    "model":"qwen38-27b-uncensored",
    "request":{"model":"qwen38-27b-uncensored","messages":[{"role":"user","content":"你好"}],"stream":false,"max_tokens":32}
  },
  "assets":[]
}
```

可用相同值`Idempotency-Key`请求头替代JSON编号；若同时有header、idempotency_key或client_request_id，所有提供值必须完全相等。稳定编号参与账号内幂等；产品也参与请求指纹，不能与WorkLucky/GGE/无标记订单跨读、取消或复用。正常201 `{order,idempotent}`，order回显 `client_product=digital_live`、原`client_request_id`，计费 `{currency:"CNY",price_fen:0,charge_status:"exempt",refund_status:"not_applicable"}`。不扣余额、不产生节点或平台分佣，也不调用付费模型。

- 丢创建响应：`GET /api/v1/capability-orders/by-request/{client_request_id}?product=digital_live`。
- 已知订单：`GET /api/v1/capability-orders/{id}?product=digital_live`。
- 原键取消：`POST /api/v1/capability-orders/by-request/{client_request_id}/cancel`，JSON `{client_product:"digital_live"}`；先取消会写同产品cancelled墓碑，迟到创建不能执行。
- 已知订单取消：`POST /api/v1/capability-orders/{id}/cancel`，JSON带相同产品。

新建前重新检查会员。已合法零价接纳的原任务即使之后会员到期仍能安全查询、取消、完成和恢复，不补收费用。401登录失效，403当前权益不足，409模型/兼容节点/产品/幂等冲突均显示真实中文message，不伪造成功。不要换键重试未知执行。

共享节点仍用既有 `X-Gulong-Account-Binding` 认证与 `gulong-capability-orders-v1` 领取/进度/输出票据/回调/取消协议。worker DTO注明`client_product=digital_live`但不含需求用户/账务隐私；每15秒worker-state/续租、fenced claim及幂等event_id不变。仅最终真实绑定节点可回调，跨分组禁止。结果完整保留 `inline_result`和所有`results[]`，短期签名GET到期只GET原单刷新，不重建或永久保存URL。

## 4. 输入素材与原生结果

使用[统一能力合同](unified-capability-orders-v1.md)的安全素材恢复流程，产品一律为`digital_live`：稳定每素材request_key、capability_id、role、完整规范化清单、SHA及原上传阶段。GET `/api/v1/capability-assets/by-request/{key}?product=digital_live`，完成`POST /api/v1/capability-assets/{id}/complete?product=digital_live`。未知/409/410不重传，只有明确awaiting_upload且防覆盖/CORS核对通过才对原对象PUT原字节，保留所有签名headers；ready复用receipt。WorkLucky素材不允许作为数字直播标记素材引用，反之亦然。

ASR返回原始whisper.cpp JSON，不裁切/flatten。图像保留原PNG及SHA；TTS保留真实音频、模型/音色来源。发布前还必须验证真实COS策略/权限、安装版消费者和各模型端到端，源码/mock测试不能替代这些实证。

## 5. 实时与未实现范围

当前 `realtime.status=integration_required`，`session_url/interrupt_url/media_transport=null`；avatar与highlights同样不可派单。**没有**连续实时会话、SSE/WebSocket音视频、句级流式音频、打断/背压/实时数字人消费者，亦没有60–180秒高光专用能力。普通异步订单和轮询不能当成这些功能，也不能承诺零延迟。

客户端可继续已实现的本机/LAN Codex/H3与本地高光流程。远程实时必须另行补有会话租约、媒体传输、背压、可打断取消、超时、幂等与同组隔离的真实合同和消费端；不通过添加假URL或安装布尔开关宣布上线。
