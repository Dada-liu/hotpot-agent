# Working in packages/orchestrator/

- Source in `src/`, tests in `test/*.test.ts`. `src/index.ts` is the package entry, re-exporting `types.ts` / `models.ts` / `runtime.ts` / `prompts.ts` / `registries.ts` / `inbox.ts` / `main-turn.ts` / `plan.ts` / `mcp.ts` / `json-schema-to-zod.ts` / `tools/delegate.ts` / `tools/spawn-workers.ts`.
- May depend on `@hotpot/core` (`workspace:*`) and `@hotpot/ai` (`workspace:*`); never import from `@hotpot/cli`.
- This package holds the three-layer agent orchestration: the main agent (conversation entry, difficulty/tier routing), worker agents (execution and parallel split), and task agents (atomic subtasks); plus the plan approval flow and the steer/queue dual-queue mechanism.
- Dependency direction is fixed: `orchestrator → core → ai`. Never add a reverse edge.
- LLM-facing prompt text is English; code comments in Simplified Chinese.
- M4: `createRoleRegistry(runtime, role, metaTools)` derives worker/task tools from `runtime.features` (todo / web / MCP) while main stays meta-tools-only. Todo prompt sections come from `foldTodos` at prompt-build time; skill sections come from `runtime.skills` and are tracked by a read-tool wrapper that appends `skill/loaded`; `runtime.hooks` must be threaded into every `LoopConfig`, with `turn_end` fired once per turn by `runMainTurn` / `runAgentInline`.
- Plan flow: the initial complex turn produces the plan in its final message; `runPlanPhase` reuses it and only drafts when the plan is missing or the `next-step` queue is non-empty. The plan phase registers no tools; the execution phase registers only `spawn_workers`. Internal plan prompts are persisted as `internal_msg` (folded into model history, not rendered by UI), and `plan(drafted)` events carry `messageIds` so the web can hide the duplicate plan text.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
