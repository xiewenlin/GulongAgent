# 生日墙 · 电子情书

生日墙右侧“写情书”红心水晶球打开全屏信纸编辑窗。填写收件人、正文与署名，可自定义信纸背景色；日期由服务端按 `Asia/Shanghai` 保存提交当天日期。提交后生成独立 `/love-letter/<id>` 阅读页和二维码，收信人免登录即可查看完整信件。

情书不进入生日祝福列表，不改变祝福统计，不调用模型、不创建订单、不扣费。装饰由页面绘制；信件是原样保留换行的纯文本，不执行 HTML、脚本或 Markdown。

## 分享与隐私

- `id` 是服务端使用 32 字节密码学随机数生成的 43 字符 base64url 分享标识。
- 持有完整链接的人可以免登录阅读；这不是仅收件人账户可读的身份权限，请仅分享给期望的收信人。没有公开搜索、列表或按姓名查找接口。
- 公开响应只包含信件字段，不包含登录账户、访客 Cookie、访客摘要、IP、请求标识或数据库连接信息。
- API 返回 `Cache-Control: private, no-store`、`X-Robots-Tag: noindex, nofollow, noarchive`、`Referrer-Policy: no-referrer`。阅读页还应设置 noindex 与 no-referrer，分享链接不含登录令牌或临时查询参数。
- 提交后信件不可原地改写；继续编辑视为新的信件。客户端应保持原请求 UUID，用于网络失败后的安全重试。

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
  "backgroundColor": "#FFF4ED"
}
```

`senderName`、`recipientName`：1–60 Unicode 字符，不含换行；`body`：1–20000 Unicode 字符，保留内部换行；`backgroundColor`：六位十六进制 `#RRGGBB`；`clientRequestId`：UUID。正文与名称去除首尾空白、统一换行为 LF；控制字符不接受。请求体上限 128 KiB。

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

存储于 MongoDB `loveLetters`，使用 `{ guestHash: 1, requestId: 1 }` 唯一索引。并发插入冲突读取胜出记录并校验内容摘要，同 UUID 不同内容 HTTP 409，不覆盖旧信件。访客标识仅存摘要。同 UUID 在另一个访客下不能取回前一访客信件。

新建限额：每 IP 每 24 小时限流窗口最多 30 次、每访客最多 20 次；重放已保存请求不消耗新建限额。会话每 IP 每分钟 60 次，读取每 IP 每分钟 120 次。

### 3. 打开信件

`GET /api/love-letters/<id>`

返回 `{ "letter": { ... } }`，字段与创建结果一致。无需登录或访客 Cookie。前端按文本渲染所有正文，不截断，不通过 `dangerouslySetInnerHTML` 插入。

## 错误

所有用户提示均为中文：

| HTTP | code | 语义 |
| --- | --- | --- |
| 400 | `INVALID_LOVE_LETTER` / `INVALID_LETTER_COLOR` / `INVALID_REQUEST_ID` / `INVALID_JSON` | 字段或格式不正确 |
| 403 | `ORIGIN_REJECTED` | 请求来源不受信任 |
| 404 | `LOVE_LETTER_NOT_FOUND` | 分享标识无效或信件不存在 |
| 409 | `LOVE_LETTER_VISITOR_REQUIRED` | 缺少写信 Cookie，需重新建立会话 |
| 409 | `LOVE_LETTER_REQUEST_CONFLICT` | 同一访客的请求 UUID 已用于不同内容 |
| 413 | `PAYLOAD_TOO_LARGE` | 超过 128 KiB |
| 429 | `RATE_LIMITED` | 操作频率过高 |
| 503 | `LOVE_LETTER_UNAVAILABLE` | 暂时无法持久化或读取，可保留原请求重试 |

## 回归

`node --test tests/unit/love-letter.test.mjs`

使用内存集合，不读取生产凭据、不连接生产数据库、不写磁盘夹具。覆盖并发幂等、不可覆盖、访客隔离、完整长文本、上海跨日、无账户信息公开、来源/格式/限流/请求体限制、数据库失败隐藏与恢复、OpenAPI。
