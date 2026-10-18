# Working in packages/

- One directory per package; package names are `@hotpot/<dir>`. Cross-package dependencies use `workspace:*`.
- Every package carries its own `package.json` (`"type": "module"`), `tsconfig.json` (extends `../../tsconfig.base.json`), `README.md` (Simplified Chinese) and `AGENTS.md` (English).
- Source lives in `<pkg>/src/`, tests in `<pkg>/test/**/*.test.ts`; run `pnpm test` and `pnpm exec biome check` from the repo root.
- In `packages/core` and `packages/orchestrator`, `src/` is one subdirectory per feature. Each feature folder owns an `index.ts` barrel, implementation files, `README.md` (Chinese) and `AGENTS.md` (English). `src/` root keeps only `index.ts` (re-exports, no logic) plus `node-builtins.d.ts`; cross-feature imports use concrete file paths, not another feature's barrel.
- Dependency direction is fixed: `cli/server/benchmarks → telemetry → core → ai`, plus `cli/server → orchestrator → core → ai` on the agent path. Never add a reverse edge: `core`, `orchestrator` and `ai` must not import `@hotpot/telemetry`, and telemetry must not import `cli`, `server` or `orchestrator`.
- `packages/telemetry` (`@hotpot/telemetry`) is the M5 anonymous telemetry client (strict event schema, error sanitizer, install ID, batching/retry, per-turn collector). `cli` and `server` wire it; the planned `benchmarks` runner will reuse it with `kind: "benchmark"`. It is a side channel: never let it block or fail a turn.
- Adding a new package or changing a package's responsibility requires updating this README and the root README's directory tree.
