# packages/

pnpm monorepo 的包目录。当前八个包：

- `ai/`（`@hotpot/ai`）：LLM 协议适配层。api×provider 二维适配，统一类型（`Message`/`StreamEvent`/`LlmAdapter`）与模型目录。
- `core/`（`@hotpot/core`）：agent 内核。append-only JSONL 会话事件日志（唯一事实源）、deriveMessages、系统提示词注册表、工具框架（bash/read/write/edit）与审批 waterfall、turn/step 循环。
- `orchestrator/`（`@hotpot/orchestrator`）：三层编排层。main 难度评估与档位路由、worker 执行与 spawn_workers/spawn_tasks 并行拆分、plan 审批流、steer/queue 双队列 inbox。
- `server/`（`@hotpot/server`）：REST + SSE 服务层。会话管理（turn 串行化、审批桥）、JSONL 日志 tailer 断线补发、web 构建产物与静态资源托管（默认 4573 端口）。
- `web/`（`@hotpot/web`）：React SPA。会话列表 / 对话流 / agent 状态面板三栏界面，纯 reducer 状态归约与自研 markdown 渲染；构建产物由 server 静态托管。
- `cli/`（`@hotpot/cli`）：行式交互入口 `hotpot chat`。
- `telemetry/`（`@hotpot/telemetry`）：M5.1 匿名遥测客户端。事件 schema、错误脱敏、安装 ID、批量重试与 turn 采集；由 cli/server 装配，benchmark runner 复用。
- `benchmarks/`（`@hotpot/benchmarks`）：M5 benchmark runner（开发工具）。SWE-bench 实例导出/选择、checkout workspace、无交互 agent、predictions、官方 harness 编排、报告、benchmark 遥测与自建三题；不被 cli/server 引用，不进入工具产物。

依赖方向：`server → orchestrator → core → ai`；`cli` 与 `server` 同为 orchestrator 之上的入口（`cli → orchestrator`），二者另依赖旁路包 `telemetry → core`；`web` 不引 workspace 包（运行时经 server 托管）；`benchmarks` 依赖 ai/core/orchestrator/telemetry，是评测工具而非运行时入口。均用 `workspace:*` 声明。`telemetry` 不依赖 orchestrator/cli/server，`core`/`orchestrator`/`ai` 也不反向依赖它。
