# src/runtime/

编排运行时：spawn、模型解析、工具装饰与 M4 可选能力的闭包。

- `createRuntime(opts)` 返回 `OrchestrationRuntime`。
- spawn：首次调用按既有日志播种各 role 计数器（resume 场景防 agentId 复用），按 role 分配单调递增编号（worker-1、task-1…），并把 `agent_spawn` 落盘；spawn 本身不运行 turn。
- 编号分配经 Promise 链串行化，保证「播种 → 编号 → 落盘」与调用序一致；task turn 仍并行执行。
- `resolveModel(tier)` 走 `models/`；`decorateWorkerTool` 是 CLI policy=always 审批包装的注入缝。
- 可选透传：`features`、`skills`、`mcpTools`、`webSearch` / `webSearchBackend`、`hooks`。
- `index.ts` 是本特性的对外出口。
