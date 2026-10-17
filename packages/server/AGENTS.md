# Working in packages/server/

- Source in `src/`, tests in `test/*.test.ts`. `src/index.ts` is the package entry, re-exporting `app.ts`, `tailer.ts`, `wire.ts`, `approvals.ts`, `usage.ts` and `session-manager.ts`. `src/bin.ts` is the `hotpot-server` bin (Hono REST + SSE).
- May depend on `@hotpot/ai`, `@hotpot/core` and `@hotpot/orchestrator` (all `workspace:*`); never import from `@hotpot/cli`.
- This package is the M3 service layer: REST + SSE APIs between cli and orchestrator, session management, and resume-from-log replay for reconnecting clients. The JSONL tailer (`createTailer`) is the event-bus foundation; later tasks add hono routes and the `hotpot-server` bin.
- Dependency direction is fixed: `server → orchestrator → core → ai`. Never add a reverse edge.
- `node-builtins.d.ts` must stay a superset of `packages/core/src/node-builtins.d.ts` (workspace source references pull core's sources into this package's compilation). Add new ambient declarations there, never `@types/node`.
- LLM-facing prompt text is English; code comments in Simplified Chinese.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test`, `pnpm typecheck`, and `pnpm exec biome check` from the repo root before committing.
