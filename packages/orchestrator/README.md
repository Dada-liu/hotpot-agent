# @hotpot/orchestrator

三层 agent 编排，位于 core 之上（依赖方向 `orchestrator → core → ai`）。

## 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 【主流与 plan】                                                             │
│   main-turn.ts  runMainTurn：主流入口，透传全部事件                         │
│   plan.ts       runPlanPhase：plan 起草 / 审批 / 修订循环                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 【元工具】                                                                  │
│   delegate.ts        难度判定与派发（trivial / simple / complex）           │
│   spawn-workers.ts   按档位 spawn worker 并聚合摘要                         │
│   spawn-tasks.ts     worker 内并行原子任务（并发池，默认 10）               │
│   run-worker.ts      worker / task 内联跑 core runTurn                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 【运行时与角色】                                                            │
│   runtime.ts    createRuntime：spawn 落盘、resolveModel、decorateWorkerTool │
│   models.ts     provider→api 映射                                           │
│   registries.ts main / worker / task 角色工具注册表                         │
│   prompts.ts    角色系统提示词（英文）                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 【基础设施】                                                                │
│   inbox.ts  steer/queue 双队列 + foldInbox 崩溃恢复                         │
│   types.ts  AgentRole / OrchestrationEvent                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

三种角色（main / worker / task）复用 core 的 `runTurn`，差异只在系统提示词与可用工具集；所有事件最终落进 core 的会话 JSONL，依赖方向 `orchestrator → core → ai`。

## 已实现能力（M2 完成）

- **主流入口 `runMainTurn`**：以 "main" 身份落盘 user_msg → main 角色注册表跑 core `runTurn` → 透传全部事件。complex 流走 plan 修订/审批循环，批准后换挂 delegate+spawn_workers 的注册表执行。
- **`delegate` 元工具（main）**：难度判定与派发。trivial 返回「直接回答」提示；simple 派一个 worker 并内联跑完其整个 turn、回收最后一条 assistant_msg 文本作为摘要回传；complex 只记录状态转 plan 阶段。首次判定后重复调用返回 isError 守卫。
- **`spawn_workers` 元工具（main，complex 执行阶段）**：按 modelTier 逐个 spawn worker 并聚合摘要；plan 未批准时 fail-closed 返回 isError，不产生 agent_spawn。
- **`spawn_tasks` 元工具（worker）**：并行拆分原子子任务，并发池按 `runtime.maxParallelTasks`（默认 10，可配）分批；失败任务以 `[FAILED] ${agentId}: ${reason}` 段聚合（整体 isError=false），由 worker 决定重试/接手/上报。
- **plan 审批流 `runPlanPhase`**：main 起草 plan → `onPlanApproval` 回调（CLI 给终端审批实现）→ 批准/批注修订/拒绝；修订上限 `planMaxRevisions`（默认 3）。asked/decided 事件落盘会话日志（审批审计），批注以 note 记入 denied 的 decided。
- **运行时 `createRuntime`**：spawn 落盘 `agent_spawn`、按 role 计数的 agentId（worker-1、task-1…单调不复用）、`resolveModel` 档位解析、`decorateWorkerTool` 工具装饰注入（CLI 的 policy=always 审批包装经此进入下层注册表）。
- **角色提示词与注册表**：main 只有 delegate/spawn_workers 元工具；worker 为 bash/read/write/edit + spawn_tasks；task 只有四件套。LLM-facing prompt 全英文。
- **steer/queue 双队列 `createInbox`**：next-turn（followup，turn 结束后消费补发）与 next-step（steer/inject，经 `LoopConfig.pollInbox` 在 step 顶部注入模型历史）双队列；`inbox/spliced` 事件落盘 + `foldInbox` 纯函数崩溃恢复。`runMainTurn` 接受可选 `inbox` 接线注入；缺省不轮询。
- **分层 usage 记账依据**：worker/task 经 `runtime.resolveModel(tier)` 走自己的档位模型，core 把 tier/model/agentId 落盘进 assistant_msg（`packages/orchestrator/test/m2-acceptance.test.ts` 验收 4 钉住）。

## 已知边界（留待后续里程碑）

- worker/task 内联 turn 的事件不透出主流：CLI 只能渲染 main 事件流与 spawn 标记行，子 agent 的 text/tool_call 过程不可见。
- `OrchestrationEvent` 的 `agent_spawn` 流变体当前无生产者（`runtime.spawn` 只落盘不产出事件），渲染由 CLI 在 spawn 调用点同步完成。
- steer/inject 只做入队 + step 顶部轮询，M2 无进程内唤醒；已排队消息在 abort 后是否保留由调用方决定。

## 测试

- `test/m2-acceptance.test.ts`：M2 验收 1-5 场景级串联（全部从 `runMainTurn` 入口跑完整流）+ pollInbox 接线用例。
- 单点行为见 `main-turn.test.ts`（delegate 主流）、`plan-flow.test.ts`（plan 审批流）、`spawn-tasks.test.ts`（并行调度/失败上报/abort）、`inbox.test.ts`、`runtime.test.ts`、`registries.test.ts`。
