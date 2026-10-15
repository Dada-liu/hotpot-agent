# packages/cli/test/

`@hotpot/cli` 的测试目录。`*.test.ts` 由根目录 `pnpm test`（vitest）统一跑。

- 测试不 spawn 真实 CLI 进程：直接 import `../src/chat.ts` 的 `runChat`，注入脚本化 `ChatInput`（逐行返回）与收集式 `ChatOutput`，LLM 侧用 `@hotpot/ai` 的 `scriptedAdapter`。
- 文件系统隔离用临时目录 + `HOTPOT_HOME` 环境变量（afterEach 恢复原值）。
- 不触碰真实网络：真实协议适配器只在 `resolveModel`（`@hotpot/orchestrator`）的映射断言里创建（构造不发请求），流式行为一律脚本化。
