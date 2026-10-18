# Working in packages/cli/

- Source in `src/`, tests in `test/*.test.ts`; the runnable entry is `src/bin.ts` (`pnpm dev cli [args...]` from the repo root).
- Depends on `@hotpot/core` and `@hotpot/ai` via `workspace:*`; all agent logic belongs in `@hotpot/core` — this package only does terminal I/O, argument parsing and rendering.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- M4: `runChat` discovers prompt templates (`/name args` expands locally and appends `prompt/invoked`), builds the hook chain and fires `session_start`, scans skills, and connects MCP servers; unknown slash commands print the available command list instead of entering a turn.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
