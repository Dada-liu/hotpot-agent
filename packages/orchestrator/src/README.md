# packages/orchestrator/src/

按特性分目录；每个目录以 `index.ts` 作为对外出口，跨目录导入使用具体文件路径。包入口 `index.ts` 只做 re-export。

- `inbox/` — steer/queue 双队列 + `foldInbox` 崩溃恢复。
- `json-schema-to-zod/` — MCP `inputSchema` 到 zod 子集的转换。
- `main-turn/` — `runMainTurn` 主流入口。
- `mcp/` — MCP 客户端桥接（stdio / streamable HTTP）。
- `models/` — 档位模型解析。
- `plan/` — `runPlanPhase` 审批与修订循环。
- `prompts/` — main / worker / task 三角色系统提示词。
- `registries/` — 按角色装配工具注册表。
- `runtime/` — `createRuntime`（spawn / resolveModel / decorateWorkerTool）。
- `types/` — `AgentRole` 与 `OrchestrationEvent`。
- `tools/` — spawn_workers / spawn_tasks / run-worker（首轮难度路由由提示词承担，无独立 delegate 工具）。
