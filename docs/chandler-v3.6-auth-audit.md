# Chandler v3.6 认证接口升级审计

审计时间：2026-08-20。权威来源：[Chandler 最新开发文档](https://app.chandler.work/docs) 与生产能力接口 `GET https://api.chandler.work/v1/auth/capabilities`。

## 本次新增

- 官网继续只允许邮箱注册，不增加手机号注册入口；Chandler 对手机号注册返回 `auth.phone_register_disabled`。
- 登录新增邮箱验证码与短信验证码两种方式，分别代理到 `/v1/auth/otp/send` 和 `/v1/auth/otp/login`。
- 找回密码新增已绑定手机号路径，代理到 `/v1/auth/phone/forgot-password` 和 `/v1/auth/phone/reset-password`。
- 用户后台新增“账号安全”，接入 `/v1/me`、`/v1/me/identities`、身份验证、主身份切换与解绑接口，以及邮箱验证接口。
- 手机号绑定必须建立在已验证邮箱账号上；官网只允许删除 `phone` 身份，不能删除注册邮箱。
- 无密码账号可先通过 `/v1/auth/reauth/send` 获取短期再认证码，再绑定手机号；有密码账号继续使用当前密码再认证。
- 登录后的密码修改接入 `/v1/auth/change-password`，设备丢失场景接入 `/v1/auth/logout-all`，并同步撤销官网本地会话。

## 安全收口

- 验证码发送与校验均要求受信任浏览器来源，响应使用 `Cache-Control: no-store`。
- 发送接口按来源 IP 与目标 HMAC 摘要双重限流；服务端日志与数据库均不保存公开查询所用的手机号或邮箱明文。
- UI 强制 60 秒重发冷却。验证码由 Chandler 管理，有效期 10 分钟，最多校验 3 次，重新发送后旧验证码立即失效。
- 公开发送采用固定成功语义，不通过响应暴露邮箱或手机号是否已注册。
- 手机号绑定、验证与解绑只使用当前加密 Chandler 会话的 Bearer Token；合作伙伴 API Key 仅保存在服务端，并使用 `Authorization: Apikey`。
- 手机找回密码成功后，官网按手机号摘要定位本地影子账户并吊销全部官网会话。

## 已复核且保持兼容

- 密码登录：`POST /v1/auth/login`
- OAuth 刷新：`POST /v1/oauth/token`，表单 `grant_type=refresh_token`
- 退出登录：`POST /v1/auth/logout`
- 主身份设置：`POST /v1/me/identities/{identity_id}/primary`
- 敏感操作再认证：`POST /v1/auth/reauth/send`
- 修改密码与全部会话注销：`POST /v1/auth/change-password`、`POST /v1/auth/logout-all`
- 微信收银台、订阅 SKU、不可变价格版本、订单查询与 Webhook 验签调用保持当前正式合同。
- Chandler API Key 环境变量仍优先读取 `GulongAgent`，兼容 `CHANDLER_API_KEY`。

官网的精确请求、响应、鉴权和错误码以 `/api/openapi.json` 与 `/api/docs` 为准。
