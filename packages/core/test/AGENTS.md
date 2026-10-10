# Working in packages/core/test/

- One `*.test.ts` file per feature area; import from `../src/<file>.ts` with the `.ts` extension.
- Import `describe`/`expect`/`it` explicitly from `vitest`; no globals, no extra test dependencies.
- Erasable TypeScript only, no `any`, no inline imports; comments in Simplified Chinese.
- Tests must be deterministic and hermetic: use temp dirs plus `HOTPOT_HOME` for anything touching the filesystem, and inject fakes (e.g. `FetchLike`) instead of real network or LLM calls.
- Run `pnpm test` and `pnpm exec biome check` from the repo root before committing.
