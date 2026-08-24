# Chandler v3.9 合作伙伴代用户注册归因

本文对应 Chandler v3.9 合作伙伴接入指南 2.2 节。目标是在账号创建时写入应用来源，为后续拉新统计和分成提供可靠基础，同时保证 OAuth `client_secret` 只存在于官网服务端。

## 已接入范围

- 官网邮箱注册：浏览器仍调用 `POST /api/auth/register`，官网服务端自动注入古龙应用的 `client_id/client_secret`。
- 古龙桌面端邮箱注册：调用 `POST /api/v1/desktop/auth/email/register`，提交公开 `client_id` 和有效激活回执。
- 古龙桌面端手机号注册：继续调用 `POST /api/v1/desktop/auth/phone/send-otp` 与 `POST /api/v1/desktop/auth/phone/register`，并提交公开 `client_id`。
- MiniMax H3 极速视频桌面端：使用永生花兼容发行键对应的 Chandler 应用 ID，由官网选择 `CHANDLER_AIROS_CLIENT_SECRET`。
- 当前仓库没有微信/支付宝小程序工程，因此没有可直接修改的小程序客户端。未来小程序必须复用官网服务端代理，禁止把 `client_secret` 编译进小程序。

## 桌面邮箱注册合同

`POST /api/v1/desktop/auth/email/register`

```json
{
  "email": "user@example.com",
  "password": "用户输入的密码",
  "display_name": "用户昵称",
  "invite_code": "可选邀请码",
  "client_id": "公开的 Chandler 应用 ID",
  "activation_receipt": "RS256 激活回执 JSON 字符串或对象",
  "app_version": "2.1.0",
  "device_name": "可选设备名",
  "os_version": "可选系统版本"
}
```

成功返回 HTTP 201，字段为 `access_token`、`refresh_token`、`token_type`、`expires_in`、`user`。响应禁止缓存。客户端不得提交 `client_secret`；请求 Schema 也不接受该字段。

服务端依次执行：验证激活回执签名和数据库授权状态、校验 `client_id` 属于已登记应用、核对已知激活产品与应用版本、按 IP/邮箱摘要/设备摘要限流、注入服务端 OAuth 密钥、调用 Chandler `/v1/auth/register`、保存本地产品版本和只含摘要的审计记录。

## 配置门禁

```text
CHANDLER_APPLICATION_ID=<古龙应用 ID>
CHANDLER_CLIENT_SECRET=<古龙应用 OAuth 密钥>
CHANDLER_AIROS_APPLICATION_ID=<MiniMax H3 极速视频版兼容应用 ID>
CHANDLER_AIROS_CLIENT_SECRET=<对应 OAuth 密钥>
```

任何目标应用缺少密钥时，受激活保护的桌面注册代理返回 HTTP 503 `REGISTRATION_ATTRIBUTION_NOT_CONFIGURED`，不会回退为无来源桌面注册。公开官网邮箱注册遵循 Chandler 的兼容合同保持可用，但在密钥补齐前不会产生应用归因；这是为避免生产账号系统因配置迁移整体中断。Chandler 文档说明错误凭据可能不阻止账号创建但会丢失归因，因此生产发布前必须用测试账号在 Chandler 应用用户统计中核验来源。

## 隐私与安全

- 浏览器、桌面安装包、日志和 OpenAPI 示例均不包含 `client_secret`。
- 桌面端注册必须携带已激活设备回执；公开网页仍只允许邮箱注册。
- 限流键和审计记录只保存邮箱、手机号、设备 ID 的用途绑定摘要，不保存原始设备标识。
- 产品来源以服务端登记的应用为准；已知激活产品不能切换到另一应用归因。
- 客户端可保存 Chandler 返回的登录令牌，但应使用操作系统安全存储。
