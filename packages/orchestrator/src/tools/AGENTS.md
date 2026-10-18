# Working in src/tools/

- `delegate` is consumed once per turn: after the first decision (including trivial), further calls return `isError`. Simple runs exactly one worker inline and returns its summary; complex only records state for the plan phase.
- `spawn_workers` must stay fail-closed until the plan is approved and must not emit `agent_spawn` before approval.
- `spawn_tasks` batches by `runtime.maxParallelTasks` (default 10) and aggregates each failure as `[FAILED] ${agentId}: ${reason}` with `isError=false` — the worker decides whether to retry, take over, or report.
- `run-worker` selects `createWorkerRegistry` for workers (bound `spawn_tasks`) and `createRoleRegistry` for tasks. It must not forward child events to the main stream; only error events, `done(aborted)` and the final summary are collected.
- Before building a child prompt, fold its todos and skills only when the corresponding feature is enabled.
- Export the directory barrel through `index.ts`; the package entry intentionally exports only delegate and spawn-workers.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
