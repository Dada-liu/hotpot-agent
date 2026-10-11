# Working in packages/ai/test/

- One `*.test.ts` file per feature area; import from `../src/<file>.ts` with the `.ts` extension.
- Import `describe`/`expect`/`it` explicitly from `vitest`; no globals, no extra test dependencies.
- Tests must be deterministic and hermetic: inject `FetchLike` fakes instead of real network or LLM calls; SSE fixtures go under `test/fixtures/`.
- Erasable TypeScript only, no `any`, no inline imports; comments in Simplified Chinese.
- Run `pnpm test` and `pnpm exec biome check` from the repo root before committing.
