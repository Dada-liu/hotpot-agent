# packages/core/test/

`@hotpot/core` 的测试目录。所有测试文件命名为 `*.test.ts`，由根目录 `pnpm test`（vitest）统一跑，匹配模式 `packages/*/test/**/*.test.ts`。

- 测试使用 Node builtins 与 vitest，不引入额外依赖。
- 需要文件系统隔离时，用临时目录并设置 `HOTPOT_HOME` 环境变量覆盖配置 home。
