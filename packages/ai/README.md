# @hotpot/ai

LLM 协议适配层：api×provider 二维适配，对上屏蔽各家 API 差异。

职责（M1 计划）：

- 统一类型：`Message` / `ContentBlock` / `StreamEvent` / `ToolDeclaration` / `LlmAdapter` / `ModelInfo`。
- 模型目录 `MODELS` 与 `findModel`（真实 contextWindow / maxTokens / 定价常量）。
- 两个协议适配器：`anthropic-messages`、`openai-completions`（SSE 按字节缓冲拼行，`fetch` 以 `FetchLike` 注入以便测试）。

当前状态：统一类型与模型目录（Task 2）、SSE 解析器与 openai-completions 适配器（Task 3）已实现，`package.json` 的 `exports` 指向 `src/index.ts`（tsx 直跑 TS，无需构建）；anthropic-messages 适配器见后续任务。架构依据：`docs/archive/02-architecture.md`。
