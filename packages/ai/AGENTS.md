# Working in packages/ai/

- Source in `src/`, tests in `test/*.test.ts` (SSE fixtures under `test/fixtures/`).
- This package has no runtime dependencies beyond the whitelist (`zod`); never import from `@hotpot/core` or `@hotpot/cli` — the dependency direction is `cli → core → ai`.
- Network I/O must go through the injectable `FetchLike` interface so tests never hit real endpoints.
- Erasable TypeScript only (no `enum`/`namespace`/parameter properties), `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
