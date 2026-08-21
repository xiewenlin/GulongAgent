# Chandler、腾讯云 COS 与发行渠道集成说明

本文说明生产架构、接口边界和上线前配置。在线运行时以 `/api/docs` 与 `/api/openapi.json` 为准。

## 1. 系统边界

- Chandler v3.6：邮箱注册、密码与验证码登录、邮箱验证、手机号绑定、微信预支付、用户订阅、离线权益凭据和合作伙伴管理能力。
- 古龙官网 MongoDB：加密会话引用、开发者 API Key、用户加密模型配置、合作伙伴、第二大脑文件索引、线下支付审核队列、发行渠道与发版任务。
- 腾讯云 COS：第二大脑 ZIP 与 Windows 安装包的私有对象存储。
- Windows 发行工作器：读取桌面端主题权限文件，领取官网发版任务，调用既有发布工作流并直传 COS。

官网不保存 Chandler 密码。Access Token 和 Refresh Token 使用 `SESSION_SECRET` 派生的 AES-256-GCM 密钥加密后存入服务端会话；浏览器只持有 HttpOnly 会话 Cookie。服务端合作伙伴调用使用 `Authorization: Apikey ${GulongAgent}`，API Key 不下发浏览器。

Chandler 用户是全局账号：在古龙版桌面端或永生花版桌面端注册的用户名/邮箱与密码，可直接登录官网；官网注册的账号默认写入古龙应用属性并归属“古龙版”，因此也可直接用于古龙版桌面端登录。官网分别通过 `CHANDLER_APPLICATION_ID` 与 `CHANDLER_AIROS_APPLICATION_ID` 识别两个桌面产品。

身份与产品版本是两条独立信息：`role` 表示管理员或普通用户，`editionKey` / `editionName` 表示古龙版或永生花版，会员状态来自订阅系统，不会覆盖管理员身份。发行渠道同步结果优先于应用属性；没有历史标记的兼容账号默认归为古龙版。

## 2. Chandler 接口映射

| 官网能力 | Chandler 公共 OpenAPI |
| --- | --- |
| 邮箱注册 / 密码登录 / 刷新 / 退出 | `/v1/auth/register`、`/v1/auth/login`、`/v1/oauth/token`（`grant_type=refresh_token`）、`/v1/auth/logout` |
| 查询短信能力 | `/v1/auth/capabilities` |
| 邮箱 / 短信验证码登录 | `/v1/auth/otp/send`、`/v1/auth/otp/login` |
| 邮箱找回密码 | `/v1/auth/forgot-password`、`/v1/auth/reset-password` |
| 手机找回密码 | `/v1/auth/phone/forgot-password`、`/v1/auth/phone/reset-password` |
| 邮箱验证 | `/v1/auth/send-verification-email`、`/v1/auth/verify-email` |
| 手机号绑定 / 验证 / 解绑 | `/v1/me/identities`、`/v1/me/identities/{id}/verify`、`DELETE /v1/me/identities/{id}` |
| 月 / 年订阅 | `/v1/checkout/subscriptions` + `/v1/pay/orders/{order}/prepay` |
| 当前用户订阅状态 | `/v1/me/subscriptions` |
| 单次充值 / 线下订单镜像 | `/v1/pay/orders` |
| 离线权益凭据 | `/v1/me/entitlements/offline-credential` |
| 合作伙伴应用用户同步 | `/v1/me/oauth/clients/{client_id}/users` |
| 应用用户属性 | `/v1/me/oauth/clients/{client_id}/users/{user_id}/attributes` |
| SKU 与价格版本 | `/v1/me/oauth/clients/{client_id}/skus`、`/v1/me/oauth/clients/{client_id}/skus/{sku_id}/prices` |

管理员执行官网本地操作前会再次读取 Chandler `/v1/me`，防止管理员权限撤销后旧会话继续操作。

## 3. 用户后台账号安全

- 用户后台：`/account`
- 聚合数据：`GET /api/account/dashboard`
- 修改个人资料：`PUT /api/account/profile`
- 认证能力：`GET /api/auth/capabilities`
- 邮箱 / 短信验证码登录：`POST /api/auth/otp/send`、`POST /api/auth/otp/login`
- 手机找回密码：`POST /api/auth/phone/forgot-password`、`POST /api/auth/phone/reset-password`
- 安全概览：`GET /api/account/security`
- 邮箱验证：`POST /api/account/security/email/send-verification`、`POST /api/account/security/email/verify`
- 手机号绑定：`POST /api/account/security/phone/bind`
- 手机号验证 / 解绑：`POST` / `DELETE /api/account/security/identities/{identityId}`
- 设置主身份：`POST /api/account/security/identities/{identityId}/primary`
- 发送敏感操作再认证码：`POST /api/account/security/reauth/send`
- 登录态修改密码：`POST /api/account/security/password/change`
- 注销全部设备：`POST /api/account/security/sessions/logout-all`

注册表单只接受邮箱，不提供手机号注册。手机号绑定要求 Chandler 邮箱已验证，并再次校验当前密码或短期再认证码。公开发送接口采用固定响应语义、60 秒客户端冷却、IP 和目标摘要双重限流，避免账号枚举与短信轰炸；账号安全接口只接受当前 Chandler 登录会话，响应禁止缓存。

## 4. COS 对象布局

```text
second-brain/{gulong-user-id}/{YYYY-MM-DD}/{random}-{filename}.zip
releases/{theme-group-id}/{timestamp}-{random}-{installer}.exe
```

浏览器上传流程：官网创建 MongoDB `uploading` 记录 → 返回限时签名 PUT URL → 浏览器直传 COS → 官网 `HEAD Object` 校验大小 → 标记为 `queued_for_analysis`。下载始终通过 15 分钟签名 GET URL，不公开永久对象地址。

CAM 子账号仅需目标 Bucket 下相应前缀的 `PutObject`、`HeadObject`、`GetObject`、`DeleteObject` 权限。不要使用主账号永久密钥。

Bucket CORS 至少允许：

- Origin：`https://www.sologle.com`、`https://sologle.com`
- Method：`PUT`、`GET`、`HEAD`
- Allowed-Headers：`Content-Type`、`Authorization`、`x-cos-*`
- Expose-Headers：`ETag`、`Content-Length`

## 5. 第二大脑管理员与开放接口

- 管理列表：`GET /api/admin/brain-attachments?keyword=&from=YYYY-MM-DD&to=YYYY-MM-DD`
- 手动下载：`GET /api/admin/brain-attachments/{id}/download`
- 更新处理进度、结果与用户反馈：`PUT /api/admin/brain-attachments/{id}`
- 按日期取最新：`GET /api/v1/brain/attachments/latest?date=YYYY-MM-DD&keyword=`

最后一个接口只接受管理员会话，或属于管理员且拥有 `brain:attachments:read` scope 的古龙 API Key。

## 6. 发行渠道

桌面端 `user-theme-access.json` 中每个 `group` 对应一个官网发行渠道，`assignments` 把 Chandler 用户 ID 映射到渠道。工作器每轮启动都会同步分组及成员；已经登录过官网的用户会立即更新，尚未登录的用户会在首次登录时命中保存的映射。

发版任务状态：`queued → building → uploading → completed`。请求上传地址前，官网按产品要求先删除该渠道旧对象，再为新安装包签发 PUT URL；上传完成后校验对象大小并写入最新版元数据。

## 7. 必需生产变量

除 MongoDB 与会话密钥外，需要：

```text
CHANDLER_API_BASE=https://api.chandler.work
CHANDLER_APPLICATION_ID=cm_89be865af1af48f4a83406f0cf1a472e
TENCENT_SECRET_ID=<CAM 子账号 SecretId>
TENCENT_SECRET_KEY=<CAM 子账号 SecretKey>
COS_BUCKET=gulong-1259744534
COS_REGION=ap-chengdu
COS_DOMAIN=gulong-1259744534.cos.ap-chengdu.myqcloud.com
RELEASE_WORKER_KEY=<官网与工作器共享的随机密钥>
# 通常留空：按 X-Forwarded-Proto/请求 URL 决定。临时 HTTP 直连可设 false；HTTPS 必须为 true。
SESSION_COOKIE_SECURE=
```

所有敏感变量只进入 Vercel Environment Variables 或受保护的本机用户环境，不能写入 Git、前端 `VITE_*` 变量、日志或截图。

腾讯云服务器如果暂时只能通过 `http://服务器IP` 访问，会话 Cookie 必须跟随外部 HTTP 协议且不能携带 `Secure`，否则登录接口虽然成功，后续管理员请求不会带回会话，页面就会提示“请先登录或提供有效管理员凭据”。本项目默认自动读取反向代理的 `X-Forwarded-Proto` 解决该问题。

当前腾讯云直连入口使用 Let’s Encrypt 免费公有 IP 短期证书，通过 Certbot 5.4+ 的 `--ip-address` 与 `--preferred-profile shortlived` 签发；Caddy 加载证书并把 HTTP 308 跳转到 HTTPS。证书有效期约 6 天，因此 `gulong-certbot-renew.timer` 每天检查两次，并在续签成功后执行 `/usr/local/sbin/deploy-gulong-ip-cert` 原子覆盖 Caddy 证书副本和热重载。配置模板位于 `deploy/tencent/`。正式域名备案完成后仍应迁移到自有域名证书，不再长期依赖 IP 入口。

## 8. 管理员数据看板与统计口径

- 页面入口：`/admin` → `数据看板`
- 聚合接口：`GET /api/admin/analytics/dashboard?days=7|30|90`
- 自动刷新：前端每 60 秒拉取一次；响应使用 `Cache-Control: private, no-store`
- 时区：所有日维度统一使用 `Asia/Shanghai`
- 周期对比：当前 N 天与紧邻的前 N 天对比，增长率不混用自然月

核心口径：

| 指标 | 统计来源与定义 |
| --- | --- |
| 新增用户 | `users.createdAt` 落在统计周期内的账号 |
| 活跃用户 | 统计周期内 `sessions.lastSeenAt` 去重后的用户；有效会话每 5 分钟最多更新一次活跃时间 |
| 访客 / 浏览量 | 官网 `PAGE_VIEW` 匿名访客 ID 去重 / 事件总数 |
| 下载 / 发起支付 | `DOWNLOAD_CLICK` / `CHECKOUT_START` 事件；不记录表单文字或密钥 |
| 已确认收入 | 在线订单状态为 `paid` 或 `completed`，加上线下订单状态为 `approved` 的金额 |
| 待处理金额 | 在线与线下 `pending` 订单，仅用于回款跟进，绝不计入已确认收入 |
| 活跃付费转化 | 周期内去重付费用户数 / 活跃用户数，线上线下同一用户只计一次 |
| 新用户激活 | 周期新增用户中，至少创建任务、提交第二大脑、配置 MiniMax 或创建有效 API Key 的人数 |

匿名分析只保存随机访客 ID、随机会话 ID、页面路径、来源类型、设备类型和 UTM 来源，不保存 IP 原文、表单内容、密码、MiniMax Key 或第二大脑文件内容。`analyticsEvents` 按事件/访客与时间建立 MongoDB 索引；管理员接口每次实时聚合，不向公共缓存写入经营数据。
