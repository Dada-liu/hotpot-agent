# Working in src/main-turn/

- `runMainTurn` is the only main-agent entry. The main agent id is the package-level convention `"main"`; keep it consistent with `plan/` and `runtime/`.
- Persist the user message as `"main"` before running `runTurn`, and forward every event produced by the loop.
- The spawn wrapper only records `agent_spawn` events into the turn's pending queue; the base runtime still owns persistence. Drain pending spawns before yielding loop events so `agent_spawn` always precedes the matching tool_result and follows call order.
- Complex flow: delegate decides, `runPlanPhase` handles approval/revision, and the execution turn uses a registry containing only `spawn_workers`. Do not bypass the plan gate.
- When `inbox` is provided, consume next-step messages in the initial turn, plan draft/revision turns and execution turn via `pollInbox`.
- `onPlanApproval` being absent must stay fail-closed.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
