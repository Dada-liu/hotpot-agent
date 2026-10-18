# src/tools/

编排元工具与下层 agent 的内联执行。

- `delegate.ts` — main 的难度判定与派发：trivial 直接回答；simple 派一个 worker 并内联跑完整个 turn；complex 只记录状态转 plan。首次判定后重复调用返回 isError。
- `spawn-workers.ts` — complex 执行阶段按 `modelTier` 逐个 spawn worker 并聚合摘要；plan 未批准时 fail-closed 返回 isError。
- `spawn-tasks.ts` — worker 内并行原子任务；并发池按 `runtime.maxParallelTasks`（默认 10）分批；失败任务聚合为 `[FAILED] ${agentId}: ${reason}`，整体 `isError=false`。
- `run-worker.ts` — worker/task 内联执行：按角色装配注册表，事件不外传，只回收 error、done(aborted) 与收尾 summary；构建 prompt 前按 features 折入 todo/skills 段。
- `index.ts` 是本目录的 barrel；包入口只导出 delegate 与 spawn-workers，spawn-tasks / run-worker 保持包内可见。
