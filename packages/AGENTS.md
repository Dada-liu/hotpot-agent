# Working in packages/

- One directory per package; package names are `@hotpot/<dir>`. Cross-package dependencies use `workspace:*`.
- Every package carries its own `package.json` (`"type": "module"`), `tsconfig.json` (extends `../../tsconfig.base.json`), `README.md` (Simplified Chinese) and `AGENTS.md` (English).
- Source lives in `<pkg>/src/`, tests in `<pkg>/test/**/*.test.ts`; run `pnpm test` and `pnpm exec biome check` from the repo root.
- Dependency direction is fixed: `cli → core → ai`. Never add a reverse edge.
- Adding a new package or changing a package's responsibility requires updating this README and the root README's directory tree.
