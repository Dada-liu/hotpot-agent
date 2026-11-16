# Working in packages/cli/

- Source in `src/`, tests in `test/*.test.ts`; the runnable entry is `src/bin.ts` (`pnpm dev cli [args...]` from the repo root). `src/index.ts` is the package entry for consumers (the npm distribution package imports `runChatCli` from it).
- Depends on `@hotpot/core` and `@hotpot/ai` via `workspace:*`; all agent logic belongs in `@hotpot/core` — this package only does terminal I/O, argument parsing and rendering.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- M4: `runChat` discovers prompt templates (`/name args` expands locally and appends `prompt/invoked`), builds the hook chain and fires `session_start`, scans skills, and connects MCP servers; unknown slash commands print the available command list instead of entering a turn. It passes user-level `features`/`compaction` into the runtime, passes the explicit `home` into the orchestration runtime so new and resumed sessions share the same MEMORY.md, and renders main-agent transient compaction as a short `[compaction]` line without summary text.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
