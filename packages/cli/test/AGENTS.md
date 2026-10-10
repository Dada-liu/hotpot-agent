# Working in test/ (packages/cli)

- One `*.test.ts` file per feature area; import the unit under test from `../src/<file>.ts` with the `.ts` extension, and public contracts from `@hotpot/core` / `@hotpot/ai`.
- Drive `runChat` in-process: scripted `ChatInput` (queued lines, `interrupt()` to simulate Ctrl-C), collecting `ChatOutput`, `scriptedAdapter` for LLM rounds. Do not spawn the real CLI or hit the network.
- Use temp dirs plus the `HOTPOT_HOME` env var (save/restore in `afterEach`) for anything touching the filesystem.
- Import `describe`/`expect`/`it` explicitly from `vitest`; erasable TypeScript only, no `any`, no inline imports; comments in Simplified Chinese.
- Run `pnpm test` and `pnpm exec biome check` from the repo root before committing.
