# @hotpot/ai

LLM 协议适配层：api×provider 二维适配，对上屏蔽各家 API 差异。

## 架构

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 【协议适配】实现 types.ts 的 LlmAdapter，对上暴露统一 streamChat                 │
│   api/anthropic-messages.ts                                                      │
│   api/openai-completions.ts                                                      │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 【流式解析】sse.ts：SSE 字节缓冲按行解析（两个协议适配器共用）                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 【统一契约】types.ts                                                             │
│   Message / ContentBlock / StreamEvent / ToolDeclaration / ModelInfo / FetchLike │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- 模型目录 `models.ts`：`MODELS` / `findModel`，真实 contextWindow / maxTokens / 定价常量。
- 测试支撑 `testing/`：`scriptedAdapter`（脚本化事件序列）与 `createRecordingAdapter` / `createReplayAdapter`（JSONL 录制回放）；网络 I/O 只经可注入的 `FetchLike` 进出，测试不打真实端点。

职责（M1 计划）：

- 统一类型：`Message` / `ContentBlock` / `StreamEvent` / `ToolDeclaration` / `LlmAdapter` / `ModelInfo`。
- 模型目录 `MODELS` 与 `findModel`（真实 contextWindow / maxTokens / 定价常量）。
- 两个协议适配器：`anthropic-messages`、`openai-completions`（SSE 按字节缓冲拼行，`fetch` 以 `FetchLike` 注入以便测试）。

当前状态：统一类型与模型目录（Task 2）、SSE 解析器与 openai-completions 适配器（Task 3）、anthropic-messages 适配器（Task 4）、测试工具 `scriptedAdapter`（Task 10，`src/testing/`）已实现，`package.json` 的 `exports` 指向 `src/index.ts`（tsx 直跑 TS，无需构建）。架构依据：`docs/archive/02-architecture.md`。
