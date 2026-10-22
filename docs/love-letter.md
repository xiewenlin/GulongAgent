# 生日墙 · 电子情书

生日墙右侧“写情书”红心水晶球打开全屏信纸编辑窗。填写收件人、正文、署名和查看密码，可自定义信纸背景色；日期由服务端按 `Asia/Shanghai` 保存提交当天日期。提交后生成独立 `/love-letter/<id>` 阅读页和二维码，收信人无需登录，但必须输入正确查看密码才能查看完整信件。

情书不进入生日祝福列表，不改变祝福统计，不调用模型、不创建订单、不扣费。装饰由页面绘制；信件是原样保留换行的纯文本，不执行 HTML、脚本或 Markdown。

## 分享与隐私

- `id` 是服务端使用 32 字节密码学随机数生成的 43 字符 base64url 分享标识。
- 只有同时持有链接和正确查看密码的人可以阅读。密码通过独立方式告知收信人，不能加入链接、二维码或页面查询参数；没有公开搜索、列表或按姓名查找接口。
- 普通 GET 永远只返回锁定状态，连收件人和署名也不会下发。正文只在服务端密码校验成功后的 POST 响应返回，不是前端隐藏已加载正文。无密码的旧信件同样锁定。
- 服务端只保存随机盐 `scrypt` 密码哈希（字段 `passwordHash`）及 `passwordSetAt`，不保存或返回明文密码；快速内容指纹不包含密码。密码不写 URL、日志、浏览器持久化存储或二维码。解锁不发访问令牌，刷新后重新输入。
- 经过验证的信件 DTO 不包含密码哈希、登录账户、访客 Cookie、访客摘要、IP、请求标识或数据库连接信息。
- API 返回 `Cache-Control: private, no-store`、`X-Robots-Tag: noindex, nofollow, noarchive`、`Referrer-Policy: no-referrer`。阅读页还应设置 noindex 与 no-referrer，分享链接不含登录令牌或临时查询参数。
- 提交后写信人不可原地改写；继续编辑视为新的信件。客户端应保持原请求 UUID 和本次内存中的密码，用于网络失败后的安全重试。管理员可通过独立管理员接口整理记录；删除后保留不含正文与密码的请求墓碑，旧请求不会复活信件。

## API

### 1. 建立写信会话

`GET /api/love-letters/session`

响应 `{ "ok": true }`。服务端建立 `gulong_love_letter_visitor=llv_...` Cookie：`HttpOnly; SameSite=Lax; Path=/api/love-letters`，HTTPS 下为 `Secure`。前端必须等待此请求成功并保留 Cookie，再提交信件；POST 不自行换访客身份，避免响应丢失造成重复信件。登录和未登录的访客均可使用。

### 2. 保存情书

`POST /api/love-letters`，`Content-Type: application/json`，同源浏览器请求，携带上述 Cookie。

```json
{
  "clientRequestId": "9b9776b0-2f96-48d0-aed7-b381ff2a5dd7",
  "senderName": "小满",
  "recipientName": "小星",
  "body": "见字如面。\n愿我们一起，看遍春夏秋冬。 💓",
  "backgroundColor": "#FFF4ED",
  "viewingPassword": "示例查看密码💓"
}
```

`senderName`、`recipientName`：1–60 Unicode 字符，不含换行；`body`：1–20000 Unicode 字符，保留内部换行；`backgroundColor`：六位十六进制 `#RRGGBB`；`clientRequestId`：UUID。正文与名称去除首尾空白、统一换行为 LF；控制字符不接受。`viewingPassword` 必填：6–128 Unicode 码点，不限制字符类型，保留前后空格和原始 Unicode，不接受全空白或控制字符。请求体上限 128 KiB。

成功首次 HTTP 201；同访客同请求相同内容重放 HTTP 200。

```json
{
  "letter": {
    "id": "<43-character-base64url-share-id>",
    "senderName": "小满",
    "recipientName": "小星",
    "body": "见字如面。\n愿我们一起，看遍春夏秋冬。 💓",
    "backgroundColor": "#FFF4ED",
    "date": "2026-10-22",
    "createdAt": "2026-10-22T07:00:00.000Z"
  },
  "url": "/love-letter/<43-character-base64url-share-id>",
  "replayed": false
}
```

`date`、`createdAt`、分享 ID 均以服务端为准。幂等重试保留首次日期；跨上海自然日重试也不变化。

存储于 MongoDB `loveLetters`，使用 `{ guestHash: 1, requestId: 1 }` 唯一索引。并发插入冲突读取胜出记录并校验内容摘要和盐哈希密码，同 UUID 不同内容或不同密码 HTTP 409，不覆盖旧信件。访客标识仅存摘要。同 UUID 在另一个访客下不能取回前一访客信件。被管理员删除的请求返回 HTTP 410，不能重新创建；无密码旧请求必须先通过原创建设备为原信件补设密码。

新建限额：每 IP 每 24 小时限流窗口最多 30 次、每访客最多 20 次；重放已保存请求不消耗新建限额，但仍受密码验证限流。会话每 IP 每分钟 60 次，读取每 IP 每分钟 120 次。

### 3. 查询锁定状态

`GET /api/love-letters/<id>`

有效信件返回 `{ "locked": true, "passwordSet": true }`。无密码旧信返回 `{ "locked": true, "passwordSet": false }`，不会因此开放正文。无效或已删除信件 HTTP 404；创建者 Cookie 也不能通过该 GET 绕过密码。

### 4. 验证密码并读信

`POST /api/love-letters/<id>/unlock`，同源 JSON `{ "password": "收信人输入的密码" }`。

正确返回 `{ "letter": { ... } }`，字段与创建结果一致。无需登录或访客 Cookie，不签发访问令牌或写访问 Cookie。错误、未设密码和未知信件均返回统一 HTTP 403 `LOVE_LETTER_PASSWORD_INVALID`；已删除信件 HTTP 404。前端按纯文本渲染所有正文，不截断，不通过 `dangerouslySetInnerHTML` 插入；刷新需再次输入密码。

所有昂贵的解锁密码校验之前：每 IP 每 10 分钟最多 20 次，每信件 + IP 每 10 分钟最多 6 次。创建请求重放和旧信补设密码分别使用相同额度的独立限流用途。请求体上限 2 KiB。超限 HTTP 429，不执行密码哈希校验。

### 5. 为旧信补设密码

`POST /api/love-letters/<id>/password`，同源 JSON `{ "password": "新查看密码" }`，必须携带原创建访客 Cookie。

仅原访客且信件尚无密码时通过原子条件更新，成功 `{ "ok": true, "passwordSet": true }`。非创建访客 HTTP 403；已有密码 HTTP 409，不允许修改。并发设置只有一个成功；设置过程中删除也不会复活信件。创建 Cookie 丢失后，不能仅凭公开链接接管旧信件。

## 错误

所有用户提示均为中文：

| HTTP | code | 语义 |
| --- | --- | --- |
| 400 | `INVALID_LOVE_LETTER` / `INVALID_LETTER_COLOR` / `INVALID_REQUEST_ID` / `INVALID_JSON` / `INVALID_VIEWING_PASSWORD` | 字段、格式或密码长度不正确 |
| 403 | `ORIGIN_REJECTED` | 请求来源不受信任 |
| 403 | `LOVE_LETTER_PASSWORD_INVALID` | 查看密码不正确或信件未设密码 |
| 403 | `LOVE_LETTER_OWNER_REQUIRED` | 不是原创建访客，无权补设旧信密码 |
| 404 | `LOVE_LETTER_NOT_FOUND` | 分享标识无效或信件不存在 |
| 409 | `LOVE_LETTER_VISITOR_REQUIRED` | 缺少写信 Cookie，需重新建立会话 |
| 409 | `LOVE_LETTER_REQUEST_CONFLICT` | 同一访客的请求 UUID 已用于不同内容或不同密码 |
| 409 | `LOVE_LETTER_PASSWORD_REQUIRED` | 旧信尚未设置密码，需要先补设 |
| 409 | `LOVE_LETTER_PASSWORD_ALREADY_SET` | 密码已存在，禁止重复修改 |
| 410 | `LOVE_LETTER_REMOVED` | 原信已删除，不能重放或恢复 |
| 413 | `PAYLOAD_TOO_LARGE` | 创建超过 128 KiB 或密码请求超过 2 KiB |
| 429 | `RATE_LIMITED` | 操作频率过高 |
| 503 | `LOVE_LETTER_UNAVAILABLE` | 暂时无法持久化或读取，可保留原请求重试 |

## 回归

`node --test tests/unit/love-letter.test.mjs`

使用内存集合和真实盐哈希，不读取生产凭据、不连接生产数据库、不写磁盘夹具。覆盖密码格式与非明文存储、锁定 GET、服务端验证、严格限流先于昂贵操作、旧信补设和并发、密码绑定幂等、删除/验证竞态防复活、完整长文本、上海跨日、隐私响应、来源/格式/请求体限制、数据库失败隐藏与恢复、OpenAPI。
