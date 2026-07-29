# Chandler、腾讯云 COS 与发行渠道集成说明

本文说明生产架构、接口边界和上线前配置。在线运行时以 `/api/docs` 与 `/api/openapi.json` 为准。

## 1. 系统边界

- Chandler：用户注册与登录、管理员角色、订阅目录、支付宝/微信预支付、用户订阅、离线权益凭据、双人审批。
- 古龙官网 MongoDB：加密会话引用、开发者 API Key、合作伙伴、第二大脑文件索引、线下支付审核队列、发行渠道与发版任务。
- 腾讯云 COS：第二大脑 ZIP 与 Windows 安装包的私有对象存储。
- Windows 发行工作器：读取桌面端主题权限文件，领取官网发版任务，调用既有发布工作流并直传 COS。

官网不保存 Chandler 密码。Access Token 和 Refresh Token 使用 `SESSION_SECRET` 派生的 AES-256-GCM 密钥加密后存入服务端会话；浏览器只持有 HttpOnly 会话 Cookie。

## 2. Chandler 接口映射

| 官网能力 | Chandler 公共 OpenAPI |
| --- | --- |
| 注册 / 登录 / 刷新 / 退出 | `/v1/auth/register`、`/v1/auth/login`、`/v1/auth/refresh`、`/v1/auth/logout` |
| 月 / 年订阅 | `/v1/checkout/subscriptions` + `/v1/pay/orders/{order}/prepay` |
| 单次充值 / 线下订单镜像 | `/v1/pay/orders` |
| 离线权益凭据 | `/v1/me/entitlements/offline-credential` |
| 管理员用户搜索 | `/v1/admin/users` |
| 冻结 / 恢复账号 | `/v1/admin/users/{id}/status` |
| 查看用户订阅 | `/v1/admin/users/{id}/subscriptions` |
| 权益变更申请 | `/v1/admin/approvals`，类型 `entitlement_grant` |
| 发布价格版本 | `/v1/admin/prices` |

管理员执行官网本地操作前会再次读取 Chandler `/v1/me`，防止管理员权限撤销后旧会话继续操作。

## 3. COS 对象布局

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

## 4. 第二大脑管理员与开放接口

- 管理列表：`GET /api/admin/brain-attachments?keyword=&from=YYYY-MM-DD&to=YYYY-MM-DD`
- 手动下载：`GET /api/admin/brain-attachments/{id}/download`
- 按日期取最新：`GET /api/v1/brain/attachments/latest?date=YYYY-MM-DD&keyword=`

最后一个接口只接受管理员会话，或属于管理员且拥有 `brain:attachments:read` scope 的古龙 API Key。

## 5. 发行渠道

桌面端 `user-theme-access.json` 中每个 `group` 对应一个官网发行渠道，`assignments` 把 Chandler 用户 ID 映射到渠道。工作器每轮启动都会同步分组及成员；已经登录过官网的用户会立即更新，尚未登录的用户会在首次登录时命中保存的映射。

发版任务状态：`queued → building → uploading → completed`。请求上传地址前，官网按产品要求先删除该渠道旧对象，再为新安装包签发 PUT URL；上传完成后校验对象大小并写入最新版元数据。

## 6. 必需生产变量

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
