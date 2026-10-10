# Working in packages/core/

- Source in `src/` (subdirs: `session/`, `prompt/`, `tools/`, `approval/`, `agent/`), tests in `test/*.test.ts`.
- May depend on `@hotpot/ai` (`workspace:*`) and whitelisted runtime deps (`zod`); never import from `@hotpot/cli`.
- The session JSONL event log is the single source of truth — UI-facing state must be derivable via `deriveMessages`; do not introduce parallel mutable state.
- LLM-facing prompt text is English; code comments in Simplified Chinese.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
