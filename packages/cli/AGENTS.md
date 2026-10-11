# Working in packages/cli/

- Source in `src/`, tests in `test/*.test.ts`; the runnable entry is `src/bin.ts` (`pnpm dev cli [args...]` from the repo root).
- Depends on `@hotpot/core` and `@hotpot/ai` via `workspace:*`; all agent logic belongs in `@hotpot/core` — this package only does terminal I/O, argument parsing and rendering.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
