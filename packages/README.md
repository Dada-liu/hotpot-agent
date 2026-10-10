# packages/

pnpm monorepo 的包目录。M1 三个包：

- `ai/`（`@hotpot/ai`）：LLM 协议适配层。api×provider 二维适配，统一类型（`Message`/`StreamEvent`/`LlmAdapter`）与模型目录。
- `core/`（`@hotpot/core`）：agent 内核。append-only JSONL 会话事件日志（唯一事实源）、deriveMessages、系统提示词注册表、工具框架（bash/read/write/edit）与审批 waterfall、turn/step 循环。
- `cli/`（`@hotpot/cli`）：行式交互入口 `hotpot chat`。

依赖方向：`cli → core → ai`，均用 `workspace:*` 声明。
