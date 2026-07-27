export const themes = [
  { id: "porcelain", name: "玉瓷", colors: ["#fbfaf6", "#0c6159", "#d1a54f"] },
  { id: "morning", name: "日出", colors: ["#fff9f1", "#9f4c2f", "#e29b59"] },
  { id: "bamboo", name: "青竹", colors: ["#f5faf4", "#315f46", "#8ba66b"] },
  { id: "iris", name: "鸢尾", colors: ["#f8f7fc", "#4c4d8a", "#9f86d9"] },
];

export const capabilities = [
  { icon: "route", title: "自动选模型", text: "按任务难度、延迟和成本自动路由，把预算用在真正困难的步骤。" },
  { icon: "brain", title: "第二大脑", text: "长期记忆、结构化笔记与多重检索，让跨会话经验持续沉淀。" },
  { icon: "market", title: "能力市场", text: "插件、技能、工作流与模型一键安装，按需组合并即时生效。" },
  { icon: "devices", title: "跨端协同", text: "Windows、个人微信、企业微信和飞书共享能力，保持会话隔离。" },
];

export const workflowSteps = [
  { index: "01", title: "理解", text: "理解目标、约束与上下文，拆解任务并生成执行方案。" },
  { index: "02", title: "组装", text: "自动选择模型、插件和技能，编排专属工作流与工具链。" },
  { index: "03", title: "执行", text: "并行执行、实时汇报；关键步骤可审批，随时恢复与重做。" },
  { index: "04", title: "进化", text: "将结果沉淀成记忆和方法论，下一次直接复用并持续增强。" },
];

export const plans = [
  {
    id: "free",
    name: "普通用户",
    eyebrow: "开始使用",
    monthlyFen: 0,
    yearlyFen: 0,
    features: ["智能助手与日常办公", "免费插件、技能与工作流", "自动模型路由", "本地离线运行"],
  },
  {
    id: "member",
    name: "会员用户",
    eyebrow: "完整生产力",
    monthlyFen: 19800,
    yearlyFen: 99900,
    featured: true,
    features: ["第二大脑与长期记忆", "微信接 Codex", "图文与短视频自动化", "本地模型与会员能力包"],
  },
  {
    id: "custom",
    name: "深度定制",
    eyebrow: "共同增长",
    pricing: "结果式付费",
    subpricing: "利润五五分",
    features: ["业务工作流深度定制", "插件、技能与智能体开发", "私有化部署与模型接入", "联合运营与持续迭代"],
  },
];
