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

M1 已完成：终端里跑通「对话 → 工具调用 → 完成任务」最小闭环（脚本化验收见 `packages/cli/test/acceptance.test.ts`，验收标准见 `docs/archive/04-roadmap.md` M1 节）。

运行方式：

1. 配置 `~/.hotpot-code/settings.json`（三档模型必填；`apiKey` 可写字面值，或 `"$VAR"` 引用环境变量）：

   ```json
   {
     "models": {
       "high": { "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKey": "$ANTHROPIC_API_KEY" },
       "medium": { "provider": "openai", "model": "gpt-4.1", "apiKey": "$OPENAI_API_KEY" },
       "low": {
         "provider": "deepseek",
         "model": "deepseek-chat",
         "apiKey": "$DEEPSEEK_API_KEY",
         "baseUrl": "https://api.deepseek.com/v1"
       }
     }
   }
   ```

   内置目录模型的协议自动选择（anthropic→anthropic-messages，其余→openai-completions）；`baseUrl` 可省略，缺省走各家官方端点（openai 系缺省 `https://api.openai.com/v1`，deepseek/moonshot 等第三方端点需显式填写）。项目级可在 cwd 向上任一目录放 `.hotpot-code/settings.json` 覆盖非凭证白名单字段（`mainAgentTier`/`maxParallelTasks`/`planMaxRevisions`/`approval.policy`），凭证只从用户级读取。

2. `pnpm dev cli chat` 启动行式对话：`/exit` 退出，Ctrl-C 中断当前回合；高危命令与覆盖写会询问 `y/n` 审批（默认 n）。
3. 会话以 JSONL 落盘在 `~/.hotpot-code/sessions/`；`pnpm dev cli chat --session <会话文件路径>` 恢复历史继续对话。
