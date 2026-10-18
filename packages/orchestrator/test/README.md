# packages/orchestrator/test/

`@hotpot/orchestrator` 的测试目录。所有 `*.test.ts` 由根目录 `pnpm test`（vitest）统一跑。

- 场景级验收：`m2-acceptance.test.ts`，全部从 `runMainTurn` 入口跑完整流。
- 单点行为：`hooks` / `inbox` / `json-schema-to-zod` / `main-turn` / `mcp` / `plan-flow` / `registries` / `runtime` / `skills` / `spawn-tasks` / `todo-flow`。
- 测试保持 hermetic：注入 scripted adapter、stub MCP client、临时目录加 `HOTPOT_HOME`，不触真实网络或 LLM。
