# WorkLucky 受审版本发布

0.1.20 的固定签名/下载地址：

`https://www.sologle.com/api/v1/desktop/worklucky/releases/0.1.20/WorkLucky-0.1.20-windows-x64-portable.zip`

本次审定最新目录为 0.1.20，保留 0.1.19 的原固定 ZIP。`GET /api/v1/desktop/worklucky/updates`
返回 `update_available`；config 的 `updates.latest_version` 来自相同目录。固定下载返回 302
到同一制品的 15 分钟 HTTPS COS 地址，实际大包直接在 COS 传输，不经过 API body。
未审定版本仍为 404，空目录仍返回 `no_update/release_not_published`。
没有环境开关、上传完成回调或 HTTP 请求可以把其他候选自动发布。
Feed 提供最新审定清单，不按 `current_version` 过滤；既有客户端校验清单后比较语义版本，
`latest <= CARGO_PKG_VERSION` 返回无更新，因此同版本不会重复提醒或安装。

## 0.1.20 发布依据（2026-10-26）

资格回执为 `worklucky-team-release-qualification-v1`，9,401 字节，SHA256
`fac55ed3a311abf8511b85160c330143532857edd246cdcd6dd52fa352eb6140`；
`qualified=true`、`publication.activationAuthorized=true`。官网逐一核对7个制品与9个证明。
以下文件均加前缀 `WorkLucky-0.1.20-`，位于上述固定 `/releases/0.1.20/` 路径：

| 文件后缀 | 字节 | SHA256 |
| --- | ---: | --- |
| windows-x64-portable.zip | 775539289 | `88e5584092f65a93dd40723754acb9a93f1f290503514f300ae78035deaaba50` |
| windows-x64-portable.exe | 495075328 | `fa63688c0bd4c1d430f0191076e75ef07f75980cae7463439eb5d7e79a52d2a6` |
| source.zip | 129277274 | `10c3bc74ea697c4e49c36e0cf82af69decc2ac7bf12c19fa582b1f1cafba1a85` |
| update-manifest.json | 1094 | `0a0bce55b0718d09e8dacc4a201c86cdd21d525c2da90c1e9b97638ec40a3f89` |

- 四项主制品使用防覆盖 PUT 上传，官网再完整流式 GET 核对每一字节和 SHA；未把包体放入
  API body、内存 Buffer 或临时文件。源码采用最终哈希，准备阶段的旧源码身份不再使用。
- 自动更新仍只接收原格式/原公钥的 ZIP 清单，不加入 EXE/source 等额外 asset 字段。
  EXE、源码和原清单用独立受审下载白名单，必须关联已发布版本；未知文件、路径穿越、重复/
  孤立/坏摘要条目均关闭，不提供任意对象代理、环境开关或上传完成即发布。
- ZIP 中央目录12,140项，展开2,069,534,518字节；旧0.1.19更新器的2GiB压缩包、4GiB展开、
  20,000项限制均兼容。中央目录核对没有代替完整绿色包与升级验收。
- 归属资格证明完整资源解包/复用/拒绝、0.1.19→0.1.20中断恢复/重试/同版复用、11个合成
  Data/teams文件内容及身份保留、独立检查点与候选精确退役；官网仅复核证明，不运行真实产品。
  真实模型、消息渠道、联邦未实跑，不能据团队功能发布宣布 all-nine open。
- 保持旧信任根、现有账号权益、音乐/资产gate及RTC准入不变。独立生产核验器仅使用Node内置模块，
  与受审目录、版本回归及OpenAPI同一提交走双目标CI；不因大包提高服务器上限或绕过存储防覆盖。

## 0.1.19 发布依据（2026-10-25）

- ZIP：124,997,007 字节；SHA256
  `dc1140c755f871c601bc14415a9bd1c46da3571bb89a6a7708db8eb26fd2fafd`。
- 原签名清单：1,070 字节；SHA256
  `3de0ef3ca49ac454ba07c213777c56c61e6f9607a9a8d015816c8fa46b150a2b`。
- 最终资格回执 SHA256
  `48845a78a0245de5a65aa27453e1d2c5b100c6e3bf581a1741b14fab23054f71`；
  `qualified=true`、`publication.activationAuthorized=true`。官网逐一核对6个制品与7个证明摘要。
- 18→19 全程序字节及模拟 Data 的内容/身份、独立备份、回滚、重试、固定槽回收验证通过。
  WinPS5.1 隔离启动器验收覆盖1,640真实资源、升级/复用/拒绝与无可见控制台；主程序由无窗口夹具替代。
  未访问实际安装或用户 Data，未运行真实产品；不将这些夹具结论冒称为生产用户运行实证。
- 官网对实际 ZIP 完整流式摘要验签；通过防覆盖 PUT 上传固定私有 COS key，再完整 GET
  124,997,007 字节，云端摘要与冻结 ZIP 完全一致。没有只凭 HEAD/metadata 宣称验收。
- 本次仅含默认模型失联修复和文档树/原文定位检索；音乐、资产两道共享开关及九项开放声明仍关闭。

## 最终发布门禁

1. 客户端归属提供冻结 ZIP 的实际路径、字节数、SHA256、文本模型选择维护验收，及完整
   前一正式版本→本版本/Data 升级验收回执。软件发布不宣称九项全开；音乐/资产权限不因此开启。
2. 使用客户端已有的 `worklucky-desktop-2026-01` Ed25519 信任根，签署 ZIP 的 **原始32字节
   SHA256 摘要**，不是 hex 文本/JSON。私钥不进入官网、Git、上传或日志。官网核对签名。
3. 冻结字节上传至固定 COS key
   `releases/worklucky/<version>/<精确受审文件名>`，核对实际完整字节、
   摘要与接收证据后才添加已审定的签名清单。不得仅凭 COS HEAD 大小或自报 metadata 称完整验收。
   不覆盖旧发布对象、不删除唯一回退、不复用其他产品的渠道。
4. 只在上述完成后通过源代码审查把最终 manifest 加到 `server/worklucky-releases.js` 的
   `WORKLUCKY_PUBLISHED_RELEASES`；走同一 commit 的 Vercel+腾讯云测试/构建/部署/字节核对。
   不允许靠候选目录、环境变量或仅上传完成自动改变公开版本。
5. 公网核对 feed、固定版本下载、签名/大小/实际 SHA。下载路由仅为已审定的同一版本签发
   15分钟 HTTPS COS 重定向，绝不把未知版本回退到 latest，签名清单不保存过期 COS URL。

清单字段兼容现有 `sign-update.mjs`：`product_id=worklucky`、`status=update_available`、
`release` 包含 `release_id/version/release_notes/publishedAt/min_compatible_knowledge_version/knowledge_version_range`，
`assets.windows-x64.portable_zip` 包含 `filename/bytes/url/sha256/signature/signature_algorithm/signature_key_id`。
算法固定 `worklucky-ed25519-sha256-v1`；URL 必须等于对应固定版本地址。未验签/错误域名/未来日期/
未知公钥/未发布 example 均不发布。目录非空却损坏时返回 503，不能伪装 `no_update`。

软件发布与 H3 S/模型准入、RTC 窗口及钱包无关：不创建订单、不调用模型、不改变用户权益、
不解除 ordinary hold，也不等待完整 H3 Setup 的 SHA。
