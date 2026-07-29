# Chandler、腾讯云 COS 与发行渠道集成说明

本文说明生产架构、接口边界和上线前配置。在线运行时以 `/api/docs` 与 `/api/openapi.json` 为准。

## 1. 系统边界

- Chandler：用户注册与登录、管理员角色、订阅目录、支付宝/微信预支付、用户订阅、离线权益凭据、双人审批。
- 古龙官网 MongoDB：加密会话引用、开发者 API Key、用户加密模型配置、合作伙伴、第二大脑文件索引、线下支付审核队列、发行渠道与发版任务。
- 腾讯云 COS：第二大脑 ZIP 与 Windows 安装包的私有对象存储。
- Windows 发行工作器：读取桌面端主题权限文件，领取官网发版任务，调用既有发布工作流并直传 COS。

官网不保存 Chandler 密码。Access Token 和 Refresh Token 使用 `SESSION_SECRET` 派生的 AES-256-GCM 密钥加密后存入服务端会话；浏览器只持有 HttpOnly 会话 Cookie。

Chandler 用户是全局账号：在古龙版桌面端或永生花版桌面端注册的用户名/邮箱与密码，可直接登录官网；官网注册的账号默认写入古龙应用属性并归属“古龙版”，因此也可直接用于古龙版桌面端登录。官网分别通过 `CHANDLER_APPLICATION_ID` 与 `CHANDLER_AIROS_APPLICATION_ID` 识别两个桌面产品。

身份与产品版本是两条独立信息：`role` 表示管理员或普通用户，`editionKey` / `editionName` 表示古龙版或永生花版，会员状态来自订阅系统，不会覆盖管理员身份。发行渠道同步结果优先于应用属性；没有历史标记的兼容账号默认归为古龙版。

## 2. Chandler 接口映射

| 官网能力 | Chandler 公共 OpenAPI |
| --- | --- |
| 注册 / 登录 / 刷新 / 退出 | `/v1/auth/register`、`/v1/auth/login`、`/v1/auth/refresh`、`/v1/auth/logout` |
| 月 / 年订阅 | `/v1/checkout/subscriptions` + `/v1/pay/orders/{order}/prepay` |
| 当前用户订阅状态 | `/v1/me/subscriptions` |
| 单次充值 / 线下订单镜像 | `/v1/pay/orders` |
| 离线权益凭据 | `/v1/me/entitlements/offline-credential` |
| 管理员用户搜索 | `/v1/admin/users` |
| 冻结 / 恢复账号 | `/v1/admin/users/{id}/status` |
| 查看用户订阅 | `/v1/admin/users/{id}/subscriptions` |
| 权益变更申请 | `/v1/admin/approvals`，类型 `entitlement_grant` |
| 发布价格版本 | `/v1/admin/prices` |

管理员执行官网本地操作前会再次读取 Chandler `/v1/me`，防止管理员权限撤销后旧会话继续操作。

## 3. 用户后台与桌面端模型配置

- 用户后台：`/account`
- 聚合数据：`GET /api/account/dashboard`
- 修改个人资料：`PUT /api/account/profile`
- 保存 / 删除 MiniMax 配置：`PUT` / `DELETE /api/account/integrations/minimax`
- 桌面端拉取：`GET /api/v1/configuration/minimax`

MiniMax API Key 使用由 `SESSION_SECRET` 派生且用途隔离的 AES-256-GCM 密钥加密。网页只返回掩码；桌面端接口只接受属于该用户且具有 `configuration:read` scope 的古龙 API Key，响应设置 `Cache-Control: private, no-store`。管理员不能跨用户读取模型密钥。

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
```

所有敏感变量只进入 Vercel Environment Variables 或受保护的本机用户环境，不能写入 Git、前端 `VITE_*` 变量、日志或截图。

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
