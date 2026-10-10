# hotpot-code

基于 Node + TypeScript 的 code agent。目标：更低的成本、更好的效果。

## 目录结构

```
├── AGENTS.md          # 开发约定（英文）
├── AGENTS_zh-CN.md    # 开发约定（中文备份）
├── docs/              # 项目文档（md 即代码）
│   ├── PRD.md         # 定稿产品需求文档（权威需求来源）
│   ├── archive/       # 设计探讨归档：需求/架构/编排/里程碑
│   └── superpowers/   # 实现计划
├── packages/          # 代码（pnpm monorepo）
│   ├── ai/            # @hotpot/ai：LLM 协议适配与模型目录
│   ├── core/          # @hotpot/core：会话日志、turn 循环、工具与审批
│   └── cli/           # @hotpot/cli：行式交互入口
└── scripts/           # 开发辅助脚本（pnpm dev 等）
```

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm test             # 跑全部测试（vitest，packages/*/test/**/*.test.ts）
pnpm dev <pkg> [args] # tsx 直跑包入口，如 pnpm dev cli chat
pnpm exec biome check # lint + format 检查
```

## 当前状态

M1 实现进行中（计划见 `docs/superpowers/plans/2026-10-10-m1-minimal-loop.md`）。
