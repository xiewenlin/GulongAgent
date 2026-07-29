# 古龙官网发行工作器

官网管理员点击“发版”后，只创建一个 MongoDB 队列任务。Windows 发行工作器负责读取桌面端“用户管理 → 主题访问权限”，调用会话 `019f91fb-3c27-7c12-a6dc-2c14fe9d467d` 已交付并验证的 `Invoke-VersionReleaseWorkflow.ps1`，随后将唯一安装包直传腾讯云 COS。

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

工作器不会同时发布所有分组。每个后台任务只执行一个菜单选项，并保留既有工作流的主题权限快照、品牌事务、测试、NSIS、SHA-256 和失败回执门禁。

