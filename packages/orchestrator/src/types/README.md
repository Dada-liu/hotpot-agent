# src/types/

编排层事件与角色类型。

- `AgentRole`：`"main" | "worker" | "task"` 严格联合。
- `OrchestrationEvent`：在 core `AgentEvent` 之上补充编排语义事件——`agent_spawn` 标记子 agent 诞生，`plan` 记录计划审批流（drafted / approved / denied / revision_exhausted）。
- `spawn` 落盘的完整字段（id/ts/parentAgentId）由 `runtime/` 组装；本目录只描述编排层关心的形状。
- core 的 `agent_spawn.role` 是 string 宽松契约，严格联合可赋值给它，两者不冲突。
- `index.ts` 是本特性的对外出口。
