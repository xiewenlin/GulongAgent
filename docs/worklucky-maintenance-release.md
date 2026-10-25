# WorkLucky 维护版发布位置

0.1.19 的固定签名/下载地址：

`https://www.sologle.com/api/v1/desktop/worklucky/releases/0.1.19/WorkLucky-0.1.19-windows-x64-portable.zip`

这是预留位置，不代表已经发布。`WORKLUCKY_PUBLISHED_RELEASES` 默认空：下载 404、
`GET /api/v1/desktop/worklucky/updates` 继续 `no_update/release_not_published`。
没有环境开关、上传完成回调或 HTTP 请求可以把候选自动发布。

## 最终发布门禁

1. 客户端归属提供冻结 ZIP 的实际路径、字节数、SHA256、文本模型选择维护验收，及完整
   18→19/Data 升级验收回执。维护版不宣称九项全开；音乐/资产权限不因此开启。
2. 使用客户端已有的 `worklucky-desktop-2026-01` Ed25519 信任根，签署 ZIP 的 **原始32字节
   SHA256 摘要**，不是 hex 文本/JSON。私钥不进入官网、Git、上传或日志。官网核对签名。
3. 冻结字节上传至固定 COS key
   `releases/worklucky/0.1.19/WorkLucky-0.1.19-windows-x64-portable.zip`，核对实际完整字节、
   摘要与接收证据后才添加已审定的签名清单。不得仅凭 COS HEAD 大小或自报 metadata 称完整验收。
   不覆盖旧发布对象、不删除唯一回退、不复用其他产品的渠道。
4. 只在上述完成后通过源代码审查把最终 manifest 加到 `server/worklucky-releases.js` 的
   `WORKLUCKY_PUBLISHED_RELEASES`；走同一 commit 的 Vercel+腾讯云测试/构建/部署/字节核对。
   本准备提交不包含任何候选清单或包，不改变当前公开版本。
5. 公网核对 feed、固定版本下载、签名/大小/实际 SHA。下载路由仅为已审定的同一版本签发
   15分钟 HTTPS COS 重定向，绝不把未知版本回退到 latest，签名清单不保存过期 COS URL。

清单字段兼容现有 `sign-update.mjs`：`product_id=worklucky`、`status=update_available`、
`release` 包含 `release_id/version/release_notes/publishedAt/min_compatible_knowledge_version/knowledge_version_range`，
`assets.windows-x64.portable_zip` 包含 `filename/bytes/url/sha256/signature/signature_algorithm/signature_key_id`。
算法固定 `worklucky-ed25519-sha256-v1`；URL 必须等于对应固定版本地址。未验签/错误域名/未来日期/
未知公钥/未发布 example 均不发布。目录非空却损坏时返回 503，不能伪装 `no_update`。

该软件维护发布与 H3 S/模型准入、RTC 窗口及钱包无关：不创建订单、不调用模型、不改变用户权益、
不解除 ordinary hold，也不等待完整 H3 Setup 的 SHA。
