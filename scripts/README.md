# scripts/

开发辅助脚本（不进产物、不发布）。

- `dev.ts`：`pnpm dev <pkg> [args...]` 的实现，把包名映射到 `packages/<pkg>/src/bin.ts` 并用 tsx 直跑；`pnpm dev web` 会先构建 Web 产物、再启动 server，就绪后自动打开浏览器。
- `pnpm dev hotpot-agent web` 可直跑发布包入口（源码态静态目录回退到 `packages/web/dist` 与 `public/`）。
