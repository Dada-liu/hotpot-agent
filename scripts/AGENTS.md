# Working in scripts/

- Dev-only helper scripts run via `pnpm <script>` from the repo root; never shipped or published.
- Same rules as package code: erasable TypeScript only, `.ts` extension on relative imports, no `any`, comments in Simplified Chinese.
- Scripts run through tsx without type-checking; keep them dependency-free (Node builtins only) and validate inputs before touching the filesystem.
