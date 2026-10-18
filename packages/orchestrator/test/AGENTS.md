# Working in packages/orchestrator/test/

- One `*.test.ts` file per feature area; import from `../src/<feature>/<file>.ts` with the `.ts` extension (for example `../src/runtime/runtime.ts`, `../src/inbox/inbox.ts`).
- Import `describe`/`expect`/`it` explicitly from `vitest`; no globals, no extra test dependencies.
- Tests must be deterministic and hermetic: use temp dirs plus `HOTPOT_HOME`, scripted adapters and stub MCP clients; never hit real network or LLM endpoints.
- Keep `m2-acceptance.test.ts` as the scenario-level suite driven from `runMainTurn`; put focused behavior in the feature-named test file.
- Erasable TypeScript only, no `any`, no inline imports; comments in Simplified Chinese.
- Run `pnpm test` and `pnpm exec biome check` from the repo root before committing.
