# Working in packages/orchestrator/

- Source in `src/`, tests in `test/*.test.ts`. `src/index.ts` is the package entry (placeholder re-export until Task 5 adds real exports).
- May depend on `@hotpot/core` (`workspace:*`) and `@hotpot/ai` (`workspace:*`); never import from `@hotpot/cli`.
- This package holds the three-layer agent orchestration: the main agent (conversation entry, difficulty/tier routing), worker agents (execution and parallel split), and task agents (atomic subtasks); plus the plan approval flow and the steer/queue dual-queue mechanism.
- Dependency direction is fixed: `orchestrator → core → ai`. Never add a reverse edge.
- LLM-facing prompt text is English; code comments in Simplified Chinese.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
