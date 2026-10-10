# packages/ai/src/api/

协议适配器目录：一个文件对应一种 API 协议，对上实现统一 `LlmAdapter` 接口，对下通过注入的 `FetchLike` 发请求（测试注入 fake，不触碰真实网络）。

- `openai-completions.ts`：OpenAI Chat Completions 协议适配器（`createOpenAICompletionsAdapter`），同样适用于 DeepSeek / Moonshot 等兼容端点。
  - 上行：`ChatRequest` → 请求体。system 提升为 messages 首条；tools 转 OpenAI `tools`（function 格式）；assistant 的 tool_call 块转 `tool_calls` 数组；user 消息里的 tool_result 块逐条转 `role:"tool"` 消息。
  - 下行：SSE 增量 → `StreamEvent`。text 增量直出；tool_call 按 `index` 跟踪，首帧出 `tool_call_start`、arguments 分帧出 `tool_call_delta`、流结束时补 `tool_call_end` 与 `finish`；`stream_options.include_usage` 让末帧携带 usage。
  - 错误：非 2xx 抛 `LlmError`（message 取 body 前 500 字符，`status` 透传，`retry-after` 头转 `retryAfter` 秒数）；流结束未收到 finish_reason 抛 `truncated_stream`。
