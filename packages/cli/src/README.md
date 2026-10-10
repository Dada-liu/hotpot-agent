# packages/cli/src/

`@hotpot/cli` 的源码目录。本包只做终端 I/O、参数解析与渲染，全部 agent 逻辑在 `@hotpot/core`。

- `bin.ts`：可运行入口（根目录 `pnpm dev cli chat` 经 tsx 直跑）。只做进程级接线，逻辑全部在 `chat.ts`。
- `chat.ts`：行式交互主逻辑。IO 经 `ChatInput`/`ChatOutput` 两个最小接口注入（终端 readline 或测试脚本），`runChat` 驱动「输入一行 → `runTurn` → 渲染 `AgentEvent`」循环；`resolveModelAdapter` 把 `ModelRef` 映射为 `ModelInfo` + 协议适配器（目录未命中时按 provider 推断协议并告警，contextWindow 取保守默认 128000）；`parseChatArgs`/`runChatCli` 供 bin 入口组装。Ctrl-C 中断当前回合而不退出进程，`/exit` 退出。
- `approval-ui.ts`：终端审批 handler，展示 `ApprovalRequest` 并读一行 y/n；空行、EOF、非 y/yes 输入都视为 deny（fail-closed）。
- `node-builtins.d.ts`：Node builtins 的最小 ambient 声明（无 `@types/node`）。必须是 `packages/core/src/node-builtins.d.ts` 的超集——tsc 会把 core 源码拉进本包同一编译。
