# @hotpot/orchestrator

三层 agent 编排，位于 core 之上。

本包做什么（M2 计划）：

- 主 agent：对话入口，负责难度评估与档位（tier）路由。
- 从 agent（worker）：承接主 agent 拆出的执行单元，支持并行拆分。
- 子 agent（task）：执行原子任务，无进一步拆分。
- plan 审批：执行计划先审批后落地。
- steer/queue 双队列：steer 队列注入中途指令，queue 队列排队后续任务。

当前进度：
- 已完成（Task 5）：`types.ts`（AgentRole / OrchestrationEvent）、`models.ts`（档位模型解析 `resolveModel`，自 cli 迁入）、`runtime.ts`（`createRuntime` / `OrchestrationRuntime`：spawn 落盘 agent_spawn、按 role 计数的 agentId、档位解析与缺省参数）。
- 待做：delegate/spawn_workers/spawn_tasks、plan 流程落地、steer/queue 双队列。
