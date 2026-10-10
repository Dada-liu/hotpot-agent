# packages/ai/src/

`@hotpot/ai` 的源码目录。本包是 LLM 协议适配层：对上屏蔽各家 API 差异，对下通过注入的 `FetchLike` 发起网络请求。

- `types.ts`：全项目公共契约（`ContentBlock` / `Message` / `ToolDeclaration` / `StreamEvent` / `Usage` / `FinishReason` / `LlmError` / `ModelInfo` / `ChatRequest` / `LlmAdapter` / `FetchLike`）。除 `LlmError` 外均为纯类型，零运行时开销。
- `models.ts`：模型目录 `MODELS` 与 `findModel`。数值取自各厂商官方定价 / 文档页，注释标注复核日期。
- `sse.ts`：SSE 字节流解析器 `parseSseStream`（TextDecoder 流式解码 + 空行分帧 + `[DONE]` 终止），各协议适配器共用。
- `api/`：协议适配器目录。`openai-completions.ts` 已实现；`anthropic-messages` 见后续任务。
- `index.ts`：包入口，仅 re-export，不写逻辑。
