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
- 已完成（Task 6）：`prompts.ts`（角色系统提示词）、`registries.ts`（按角色装配工具注册表）。
- 已完成（Task 7）：`tools/delegate.ts`（delegate 元工具：trivial 提示直答 / simple 内联跑 worker turn 回传摘要 / complex 记录状态）、`main-turn.ts`（`runMainTurn` 主流入口：user_msg 落盘 + main 注册表跑 core runTurn + 事件透传；complex 分支为 Task 8 的 plan 占位）。
- 待做：spawn_workers/spawn_tasks、plan 流程落地、steer/queue 双队列。
