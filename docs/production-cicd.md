# Vercel 与腾讯云双目标 CI/CD

## 发布行为

`.github/workflows/deploy-production.yml` 在 `main` 每次更新或管理员手动触发时执行：

1. 使用锁文件安装依赖，先执行 `npm run build` 生成 Sites 测试需要的生产产物，再执行 `npm test`、`npm run test:sites`。
2. 从当前 Git commit 和刚生成的 `dist/` 打包不可变发布物，制品保留 3 天。
3. Vercel 使用 Production 环境变量构建并发布，随后检查 `https://sologle.com/api/health`。
4. 腾讯云把同一制品上传到 `/opt/gulong/releases/<commit>`，复用未变化的生产依赖或执行 `npm ci --omit=dev`，通过结构和 Node 语法检查后再原子切换 `/opt/gulong/current`。
5. 腾讯云服务重启或本机健康检查失败时，脚本立即把软链接恢复到上一版本、重启服务并再次验活；失败版本不会保持在线。

两个目标都受 `gulong-production` 并发锁保护，新的提交不会中断正在执行的生产发布。GitHub Actions 页面保留每一步、commit、部署地址与健康检查结果，便于审计。

## GitHub Environment 与 Secrets

在仓库 `Settings → Environments` 创建 `production`。建议启用仅允许 `main`、防止自审批并配置至少一位管理员为 Required reviewer。以下值全部放在该 Environment 的 Secrets；不得使用 `VITE_*` 前缀：

| Secret | 内容 |
| --- | --- |
| `VERCEL_TOKEN` | 仅允许部署该项目的 Vercel Token |
| `VERCEL_ORG_ID` | Vercel 团队 ID |
| `VERCEL_PROJECT_ID` | 古龙官网 Vercel Project ID |
| `TENCENT_SSH_HOST` | 腾讯云服务器地址 |
| `TENCENT_SSH_PORT` | SSH 端口，当前为 `22` |
| `TENCENT_SSH_USER` | 具备发布权限的用户；现有节点可暂用 `root`，后续建议改成最小权限部署用户 |
| `TENCENT_SSH_PRIVATE_KEY` | 与服务器公钥配对的 PEM 私钥完整内容 |
| `TENCENT_SSH_KNOWN_HOSTS` | 管理员核验过指纹的 OpenSSH known_hosts 行；工作流严格禁止自动接受陌生主机 |

非敏感地址放在 Environment Variable：

| Variable | 内容 |
| --- | --- |
| `TENCENT_HEALTH_URL` | `https://111.229.70.235/api/health` |

应用自己的 MongoDB、COS、Chandler、激活签名与会话密钥继续分别保存在 Vercel Production Environment Variables 和腾讯云 `/etc/gulong/gulong.env`；CI 不复制、不回显这些业务密钥。

## 服务器前置条件

- Debian 上已经安装 Node.js、npm、Caddy、curl 和 systemd。
- `gulong.service` 从 `/opt/gulong/current` 启动，并以 `gulong` 系统用户运行。
- SSH 发布用户可创建 `/opt/gulong/releases`、切换 `/opt/gulong/current` 和重启 `gulong.service`。
- HTTPS 与证书续签由 Caddy、Certbot 和 `gulong-certbot-renew.timer` 独立维护，应用发布不会覆盖证书或 `/etc/gulong/gulong.env`。

## 故障处理

腾讯云切换后的 40 秒内会反复检查本机 `/api/health`。如果失败，`deploy/tencent/deploy-release.sh` 自动回滚并让工作流失败；管理员可从 Actions 日志看到失败 commit。Vercel 由平台保留历史 Deployment，可从 Vercel 控制台将上一个健康 Deployment 重新 Promote。任何情况下都不要把私钥、应用 `.env` 或 token 粘贴进 Actions 日志。
