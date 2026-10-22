# 个人生日墙

入口在官网 `/workflows` 的主区域；`/birthday-wall` 是创建入口，`/birthday-wall/<wallId>` 是独立收集页面。两者均不渲染官网导航、页脚菜单或反馈悬浮按钮。

登录用户填写寿星姓名后创建一面空墙，再分享专属链接。访客无需登录即可提交公开祝福。每面墙独立保存祝福、统计、草稿与绘图订单恢复记录，页面顶部居中仅展示祝福总数，标注“份暖心祝福”；PNG/SVG 导出使用相同文案，不展示参与访客数或今日新增数。后端 `stats.total / participants / today` 合同保留兼容。

## 接口

- `POST /api/birthday-walls`：官网会话鉴权，`{clientRequestId: UUID, name: string}`；返回 `wall` 和 `url`，同请求重试不创建第二面墙。
- `GET /api/birthday-walls/mine`：只返回当前登录账号创建的墙。
- `GET /api/birthday-walls/:wallId`：公开读取 `wall / notes / stats`，建立 HttpOnly 匿名访客 Cookie。
- `POST /api/birthday-walls/:wallId/notes`：`{clientRequestId: UUID, name?: string, message: string}`。仅允许同源 JSON 提交，服务端配色和增加表情；祝福最长 500 字、署名最长 40 字，每墙最多 1000 条，达到上限明确提示，已有祝福不截断。
- `DELETE /api/admin/birthday-walls/:wallId/notes/:id`：仅管理员移除祝福，幂等墓碑防止旧提交重试恢复已移除内容。

公开结果不包含账号、匿名访客标识、IP、原始鉴权或幂等指纹。计数与祝福写入使用现有 Mongo 事务，沿用官网数据库配置，不新增独立账户体系。

## Codex 图片与导出

生日画面复用现有 `/api/codex-market/models → /quotes → /tasks → /tasks/:id`，模型 `longtu`（服务端 Codex 图片执行模型）。检查在线且兼容的绘图节点后获取报价，用户确认才建单。报价展示使用服务端整数毫元；会员与管理员免扣费规则由服务端判断。网络结果未知时仅重放原请求，恢复信息按账号和墙隔离。

Codex 只接收固定的生日装饰提示，不上传祝福姓名或正文。生成图仅在当前用户页面和导出中使用，不自动公开其他用户的受保护订单结果。当前绘图合同的原生尺寸为 1536×1024；最终生日墙由浏览器以 4096 像素宽排版，原文不会让模型重新抄写。

古龙引擎包月按服务端订阅时间窗 `currentPeriodStart <= now < currentPeriodEnd` 及有效状态判断：有效期内龙图费用为 0，即使余额为 0 或尚无钱包记录也可完成订单，不扣余额、不产生节点或平台分佣。未来生效、已到期、禁用订阅不享受此豁免。报价之后会员状态变化会拒绝原报价并要求重新报价，不能沿用付费报价扣会员余额。

普通墙导出 PNG；超过安全画布尺寸时导出单张完整 SVG 矢量长图，页面明确说明格式。所有祝福保留，文字可继续放大，不通过裁剪或缩小字号适配。PNG/SVG 的超清排版尺寸不代表 AI 装饰图具有原生 4K 细节。

## 发布与验证

沿用同提交 Vercel / 腾讯云双目标 CI、自动健康检查与前端逐文件校验。Sites 原项目标识保持不变；原项目不可访问时不创建替代项目。公网验收只读页面、接口路由与目录；测试祝福只在隔离的内存测试环境产生，不写入生产生日墙。
