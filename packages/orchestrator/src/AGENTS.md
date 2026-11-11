# Working in packages/orchestrator/src/

- `src/` is organized one feature per subdirectory; each folder owns an `index.ts` barrel, `README.md` (Simplified Chinese) and `AGENTS.md` (English).
- `src/index.ts` re-exports only. It intentionally keeps `tools/run-worker.ts` and `tools/spawn-tasks.ts` internal; do not widen the package surface without a reason.
- Cross-feature imports use concrete file paths, never another feature's `index.ts`, to avoid barrel cycles.
- Dependency direction is fixed: `orchestrator → core → ai`; code-search assembly also uses `orchestrator → memory`. Never import from `@hotpot/cli`, and never let memory introduce startup scanning or network I/O.
- LLM-facing prompt text is English; code comments are Simplified Chinese.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
