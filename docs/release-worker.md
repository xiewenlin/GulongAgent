# 古龙官网发行工作器

官网管理员点击“手动打包发布”后，只创建一个 MongoDB 队列任务。Windows 发行工作器负责读取桌面端“用户管理 → 主题访问权限”，调用会话 `019f91fb-3c27-7c12-a6dc-2c14fe9d467d` 已交付并验证的 `Invoke-VersionReleaseWorkflow.ps1`，随后将该任务唯一安装包直传腾讯云 COS。

桌面端直接运行“发布版本”只生成本地安装包和 `built / awaiting-admin` 回执，不会上传 COS。只有以下管理员显式操作才会产生 COS 上传和流量：

1. 在官网“版本管理”选择“手动上传”，直接选择已有安装包。
2. 在官网“版本管理”点击“手动打包发布”，创建单渠道队列任务。

没有管理员任务时，工作器轮询只返回空队列，不构建、不上传。禁止把桌面端本地构建恢复成自动 COS 分发。

旧版直传协议 `/api/release-worker/releases/prepare`、`/api/release-worker/releases/:publishId/complete` 和 `/api/release-worker/releases/:publishId/fail` 已永久停用，统一返回 HTTP `410 DIRECT_RELEASE_DISABLED`。即使旧机器仍持有有效的 `X-Release-Worker-Key`，也不能绕过管理员后台直接上传。`/api/release-worker/channels/sync` 与 `/api/release-worker/jobs/*` 继续保留，但后者只会领取管理员通过 `/api/admin/release-jobs` 显式创建的单渠道任务。

## 必需环境变量

```powershell
$env:GULONG_RELEASE_WORKER_KEY = "与官网 RELEASE_WORKER_KEY 完全一致的长随机密钥"
$env:GULONG_SOURCE_THREAD_TURN_ID = "源会话 019f4ac3... 的最新已完成轮次 ID"
```

不要把密钥写进脚本、Git 或截图。`GULONG_SOURCE_THREAD_TURN_ID` 未设置时，工作器会使用源码 Git SHA 作为本地快照标识；正式发布建议显式设置为源会话最新已完成轮次。

## 单次运行

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-worker.ps1 -Once
```

## 持续领取任务

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-worker.ps1 -PollSeconds 20
```

工作器不会同时发布所有分组。每个管理员后台任务只执行一个菜单选项，并保留既有工作流的主题权限快照、品牌事务、测试、NSIS、SHA-256 和失败回执门禁。工作器只接受 `built / awaiting-admin` 且 `publicationMode=manual-admin-only` 的本地回执；COS 与官网确认成功后，才把该回执更新为 `released / published`。
