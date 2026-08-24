# 桌面端订阅、充值与剩余用量合同

## 官网深链

- 会员订阅：`https://www.sologle.com/pricing?tab=subscription&source=desktop`
- 余额充值：`https://www.sologle.com/pricing?tab=recharge&source=desktop`

`tab` 仅接受 `subscription` 或 `recharge`，缺省或无效值回落到会员订阅。`source=desktop` 只用于来源识别，不参与鉴权。浏览器已有官网会话时会自动识别当前账号；没有会话时由用户在页面登录。

网页不把支付结果交给桌面端记账，也不使用开放回跳地址。桌面端在网页窗口重新获得焦点、用户主动刷新或短周期轮询时，重新读取下方两个服务端权威接口。

## 订阅状态

`GET /api/v1/desktop/account/subscription`

请求头：`Authorization: Bearer <Chandler Access Token>`

返回当前账号的会员状态、续费提醒、钱包余额和短视频包月权益。线下订阅审核通过后，下一次读取立即生效。

## 剩余用量

`GET /api/v1/desktop/account/usage`

请求头：`Authorization: Bearer <Chandler Access Token>`

金额全部为整数分。响应结构：

```json
{
  "currency": "CNY",
  "quota": {
    "balanceFen": 55000,
    "unlimited": false,
    "estimates": {
      "images": { "minimum": 1309, "maximum": 27500, "cheapestUnitFen": 2, "mostExpensiveUnitFen": 42 },
      "videos": { "minimum": 219, "maximum": 9166, "cheapestUnitFen": 6, "mostExpensiveUnitFen": 251 }
    },
    "weekly": {
      "rollingDays": 7,
      "usedFen": 1200,
      "calls": 8,
      "days": [{ "date": "2026-08-24", "usedFen": 200, "calls": 1 }]
    },
    "monthly": {
      "rollingDays": 30,
      "usedFen": 4600,
      "calls": 31,
      "days": [{ "date": "2026-08-24", "usedFen": 200, "calls": 1 }]
    }
  },
  "subscription": {
    "active": true,
    "restricted": false,
    "plan": "member",
    "currentPeriodEnd": "2026-09-24T00:00:00.000Z"
  },
  "shortVideoPackage": {
    "active": false,
    "unlimitedH3": false,
    "packageBalanceFen": 0,
    "packageExpiresAt": null,
    "chargeMode": "deduct_until_exhausted_then_free"
  },
  "checkedAt": "2026-08-24T08:00:00.000Z"
}
```

管理员返回 `quota.unlimited=true`。估算值尚不可用时对应的 `images` 或 `videos` 为 `null`。所有响应均带 `Cache-Control: private, no-store`。

## 充值订单

网页创建线下充值：

`POST /api/billing/orders`

```json
{
  "kind": "recharge",
  "provider": "offline",
  "amountFen": 50000
}
```

当前用户查询充值订单：

`GET /api/billing/offline-orders?kind=recharge&limit=10`

订单包含 `amountFen`、`bonusFen`、`creditedFen`、`status` 和审核信息。只有管理员审核通过后，官网服务端才按幂等钱包流水入账；桌面端不得自行修改余额。

完整、可执行的请求与响应约束以 `https://www.sologle.com/api/openapi.json` 为准。
