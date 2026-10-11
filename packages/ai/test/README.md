# packages/ai/test/

`@hotpot/ai` 的测试目录。所有测试文件命名为 `*.test.ts`，由根目录 `pnpm test`（vitest）统一跑，匹配模式 `packages/*/test/**/*.test.ts`。

- 测试使用 vitest 与 Node builtins，不引入额外依赖。
- 涉及网络行为的测试必须注入 `FetchLike` fake，禁止真实请求；SSE 用例的固件放 `test/fixtures/`。
- `node-builtins.d.ts`：依赖白名单不含 `@types/node`，在此为测试用到的 Node builtins（`readFile`）做最小类型声明，随用例需要按需补充。
