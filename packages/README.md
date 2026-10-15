# packages/

pnpm monorepo 的包目录。当前四个包：

- `ai/`（`@hotpot/ai`）：LLM 协议适配层。api×provider 二维适配，统一类型（`Message`/`StreamEvent`/`LlmAdapter`）与模型目录。
- `core/`（`@hotpot/core`）：agent 内核。append-only JSONL 会话事件日志（唯一事实源）、deriveMessages、系统提示词注册表、工具框架（bash/read/write/edit）与审批 waterfall、turn/step 循环。
- `orchestrator/`（`@hotpot/orchestrator`）：三层编排层。main 难度评估与档位路由、worker 执行与 spawn_workers/spawn_tasks 并行拆分、plan 审批流、steer/queue 双队列 inbox。
- `cli/`（`@hotpot/cli`）：行式交互入口 `hotpot chat`。

依赖方向：`cli → orchestrator → core → ai`，均用 `workspace:*` 声明。
