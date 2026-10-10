# scripts/

开发辅助脚本（不进产物、不发布）。

- `dev.ts`：`pnpm dev <pkg> [args...]` 的实现，把包名映射到 `packages/<pkg>/src/bin.ts` 并用 tsx 直跑。
