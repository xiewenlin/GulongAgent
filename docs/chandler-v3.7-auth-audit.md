# Chandler v3.7 认证接口升级审计

审计时间：2026-08-22。权威来源：[Chandler 最新开发文档](https://app.chandler.work/docs)、[Chandler OpenAPI](https://api.chandler.work/openapi.yaml) 与生产能力接口 `GET https://api.chandler.work/v1/auth/capabilities`。

## 本次新增

- 邮箱登录、邮箱找回密码、短信登录和短信找回密码统一使用 6 位数字验证码；有效期默认 10 分钟、最多校验 3 次，重新发送后旧码立即失效。
- 官网继续只允许邮箱注册，不增加手机号注册入口；已激活桌面客户端新增手机号注册，经过古龙服务端受控代理调用 `/v1/auth/phone/send-otp` 与 `/v1/auth/phone/register`。
- 桌面手机号注册先验证 RS256 激活回执，服务端只采用回执内稳定匿名 `deviceId` 作为 Chandler `install_id`，不接收或保存原始 MAC。
- Chandler OAuth `client_secret` 仅保存在古龙官网服务端环境变量，绝不下发或打包进桌面客户端。
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
- 桌面手机号注册额外按来源 IP、手机号 HMAC 摘要和激活设备摘要三重限流，并写入不含手机号明文的认证审计记录。

## 已复核且保持兼容

- 密码登录：`POST /v1/auth/login`
- OAuth 刷新：`POST /v1/oauth/token`，表单 `grant_type=refresh_token`
- 退出登录：`POST /v1/auth/logout`
- 主身份设置：`POST /v1/me/identities/{identity_id}/primary`
- 敏感操作再认证：`POST /v1/auth/reauth/send`
- 修改密码与全部会话注销：`POST /v1/auth/change-password`、`POST /v1/auth/logout-all`
- 微信收银台、订阅 SKU、不可变价格版本、订单查询与 Webhook 验签调用保持当前正式合同。
- Chandler API Key 环境变量仍优先读取 `GulongAgent`，兼容 `CHANDLER_API_KEY`。
- 桌面手机号注册 OAuth 密钥读取 `CHANDLER_CLIENT_SECRET`，兼容 `CHANDLER_OAUTH_CLIENT_SECRET`；缺失时能力接口关闭该入口并返回中文配置提示。

官网的精确请求、响应、鉴权和错误码以 `/api/openapi.json` 与 `/api/docs` 为准。
