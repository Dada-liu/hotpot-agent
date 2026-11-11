# Working in packages/orchestrator/test/

- One `*.test.ts` file per feature area; import from `../src/<feature>/<file>.ts` with the `.ts` extension (for example `../src/runtime/runtime.ts`, `../src/inbox/inbox.ts`).
- Import `describe`/`expect`/`it` explicitly from `vitest`; no globals, no extra test dependencies.
- Tests must be deterministic and hermetic: use temp dirs plus `HOTPOT_HOME`, scripted adapters and stub MCP clients; never hit real network or LLM endpoints.
- Keep `m2-acceptance.test.ts` as the scenario-level suite driven from `runMainTurn`; put focused behavior in the feature-named test file.
- Erasable TypeScript only, no `any`, no inline imports; comments in Simplified Chinese.
- 需要观测「同时有多少个流在飞」时用 `test/support/concurrency-gate.ts` 的
  `createConcurrencyCounter` + `waitForPeak`，不要自己写等待循环。判据必须是峰值
  （最后到达的流不会等待、会立刻结束并把当前计数减回去，等当前值必然白等）；只用
  `role=task` 这类被观测的流计数（worker 的流在工具执行期间一直挂着，混进来会让峰值
  虚高）。也别用固定时限兜底：task 流进入 `streamChat` 前要落盘两次带 fsync 的
  append，fsync 走 libuv 4 线程池排队，第 8 个流可能比第 1 个晚到 190ms 以上。
- Run `pnpm test` and `pnpm exec biome check` from the repo root before committing.
