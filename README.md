# hotpot-code

基于 Node + TypeScript 的 code agent。目标：更低的成本、更好的效果。

## 架构

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 【接入层】                                                                │
│   packages/web    React SPA 三栏界面（会话列表 / 对话流 / agent 状态面板）│
│   packages/cli    行式交互入口                                            │
├───────────────────────────────────────────────────────────────────────────┤
│ 【服务层】                                                                │
│   packages/server REST + SSE 服务层（会话管理、日志补发、静态托管）       │
├───────────────────────────────────────────────────────────────────────────┤
│ 【编排层】                                                                │
│   packages/orchestrator                                                   │
│     三层 agent 编排：main 难度路由 → worker 执行/并行拆分 → task 原子任务 │
│     plan 先审后执行、steer/queue 双队列                                   │
├───────────────────────────────────────────────────────────────────────────┤
│ 【核心层】                                                                │
│   packages/core                                                           │
│     turn/step 两级循环、工具三面分离、审批 waterfall                      │
│     会话 JSONL 事件日志为唯一事实源                                       │
├───────────────────────────────────────────────────────────────────────────┤
│ 【适配层】                                                                │
│   packages/ai                                                             │
│     api×provider 二维协议适配（anthropic-messages / openai-completions）  │
│     SSE 流式解析、模型目录、用量统计                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

依赖方向严格自上而下（`server → orchestrator → core → ai`；`cli` 与 `server` 同为 orchestrator 之上的入口，`web` 不引 workspace 包、构建产物由 server 托管），禁止反向依赖。另有旁路包 `packages/telemetry`（`cli`/`server` → `telemetry` → `core`），只做匿名指标上报，不进入 agent 主链路。

一次用户消息的数据流：cli → `runMainTurn`（`delegate` 难度路由）→ worker / task 内联跑 core `runTurn` → 每个 step 由 `deriveMessages` 从会话日志转换历史 → `ai.streamChat` → 工具批次经审批 waterfall 执行 → 全部事件 append 进 JSONL 并流回 cli 渲染。

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
│   ├── orchestrator/  # @hotpot/orchestrator：三层编排（delegate/spawn_workers/spawn_tasks、plan 审批、inbox）
│   ├── server/        # @hotpot/server：REST + SSE 服务层（会话管理、日志补发、审批桥、静态托管）
│   ├── web/           # @hotpot/web：React SPA（三栏界面、agent 状态面板）
│   ├── cli/           # @hotpot/cli：行式交互入口
│   └── telemetry/     # @hotpot/telemetry：M5 匿名遥测客户端（事件 schema、脱敏、批量上报）
└── scripts/           # 开发辅助脚本（pnpm dev 等）
```

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm test             # 跑全部测试（vitest，packages/*/test/**/*.test.ts）
pnpm dev <pkg> [args] # tsx 直跑包入口，如 pnpm dev cli chat
pnpm dev server       # 启动 REST + SSE 服务（默认 4573 端口，托管 web 构建产物）
pnpm exec biome check # lint + format 检查
```

web 产物构建与开发：`pnpm --filter @hotpot/web build` 后由 server 直接托管；开发态跑 `pnpm --filter @hotpot/web dev`（Vite dev，把 `/api` 代理到 4573）。

## 当前状态

M1 已完成：终端里跑通「对话 → 工具调用 → 完成任务」最小闭环（脚本化验收见 `packages/cli/test/acceptance.test.ts`，验收标准见 `docs/archive/04-roadmap.md` M1 节）。

M2 已完成：三层编排（main 难度路由 → worker 执行/并行拆分 → task 原子任务）、plan 先审后执行、steer/queue 双队列（场景级验收见 `packages/orchestrator/test/m2-acceptance.test.ts`，验收标准见 `docs/archive/04-roadmap.md` M2 节）。

M3 已完成：Web 端交付——`packages/server`（REST + SSE，默认 4573 端口，断线重连从日志补发、CLI 与 web 可同时观察同一会话）+ `packages/web`（React SPA：会话列表、流式对话、工具卡片、plan 审查、审批、steer/中断、用量展示、右侧面板 agent 工作状态）。测试见 `packages/server/test/`（api / session-manager / tailer / static）与 `packages/web/test/`，验收标准见 `docs/archive/04-roadmap.md` M3 节。

运行方式：

1. 配置 `~/.hotpot/settings.json`（三档模型必填；`apiKey` 可写字面值，或 `"$VAR"` 引用环境变量）：

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

   内置目录模型的协议自动选择（anthropic→anthropic-messages，其余→openai-completions）；`baseUrl` 可省略，缺省走各家官方端点（openai 系缺省 `https://api.openai.com/v1`，deepseek/moonshot 等第三方端点需显式填写）。项目级可在 cwd 向上任一目录放 `.hotpot/settings.json` 覆盖非凭证白名单字段（`mainAgentTier`/`maxParallelTasks`/`planMaxRevisions`/`approval.policy`），凭证只从用户级读取。

2. `pnpm dev cli chat` 启动行式对话：`/exit` 退出，Ctrl-C 中断当前回合；高危命令与覆盖写会询问 `y/n` 审批（默认 n）。
3. 会话以 JSONL 落盘在 `~/.hotpot/sessions/`；`pnpm dev cli chat --session <会话文件路径>` 恢复历史继续对话。
4. Web 端：`pnpm --filter @hotpot/web build` 构建产物后 `pnpm dev server`，浏览器打开 http://localhost:4573（同一 settings 配置，会话与 CLI 互通）；开发态改前端时另开 `pnpm --filter @hotpot/web dev`，Vite 将 `/api` 代理到 4573。
