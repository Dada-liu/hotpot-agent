# Working in src/types/

- `AgentRole` is a strict union (`main` / `worker` / `task`); do not widen it to string.
- `OrchestrationEvent` is additive on top of core's `AgentEvent`. Extend the union for new orchestration events; never reshape core event types here.
- The storage contract `agent_spawn.role` is a loose string; the strict union is assignable to it, which is intentional.
- Types describe orchestration-level shape only. Persistence fields such as id/ts/parentAgentId are assembled by `runtime/`.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
