# Working in packages/server/

- Source in `src/`, tests in `test/*.test.ts`. `src/index.ts` is the package entry, re-exporting `app.ts`, `tailer.ts`, `wire.ts`, `approvals.ts`, `usage.ts`, `static.ts`, `serve.ts` and `session-manager.ts`. `src/bin.ts` is the `hotpot-server` bin (Hono REST + SSE + static hosting); it delegates to `startServer` in `serve.ts`, which the published `hotpot web` command also uses.
- May depend on `@hotpot/ai`, `@hotpot/core`, `@hotpot/orchestrator` and `@hotpot/telemetry` (all `workspace:*`); never import from `@hotpot/cli`.
- This package is the M3 service layer: REST + SSE APIs between cli and orchestrator, session management, and resume-from-log replay for reconnecting clients. The JSONL tailer (`createTailer`) is the event-bus foundation; later tasks add hono routes and the `hotpot-server` bin.
- Dependency direction is fixed: `server → orchestrator → core → ai`. Never add a reverse edge.
- `node-builtins.d.ts` must stay a superset of `packages/core/src/node-builtins.d.ts` (workspace source references pull core's sources into this package's compilation). Add new ambient declarations there, never `@types/node`.
- LLM-facing prompt text is English; code comments in Simplified Chinese.
- Plan wire events carry optional `messageIds` (the assistant messages holding the plan text). `runOneTurn` emits `plan` only after `await syncDurable()`, so subscribers receive the durable `assistant_msg` before the plan event and can hide the duplicate bubble.
- M4: `assemble()` also scans skills/prompt templates, connects MCP servers, and builds the hook chain (firing `session_start`). `/name args` messages are expanded in `send()` (unknown commands throw `PromptCommandError` → HTTP 400). New routes: `GET /api/sessions/:id/prompts` and `GET /api/sessions/:id/inbox`. `summarizeUsage` takes the feature flags and reports per-feature event/tool-call counts.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test`, `pnpm typecheck`, and `pnpm exec biome check` from the repo root before committing.
