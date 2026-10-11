# packages/ai/test/fixtures/

SSE 固件：录制的协议原始字节流（文本形态）。测试读取后编码为 `Uint8Array`，经 `FetchLike` fake 回放给适配器。

- `openai-text.sse.txt`：OpenAI 文本增量流（text delta + finish stop + usage 末帧）。刻意包含中文多字节字符与 `: keep-alive` 注释行，覆盖字节解码与注释跳过。
- `openai-tool-calls.sse.txt`：OpenAI 工具调用增量流（tool_call 的 arguments 分多帧 + finish tool_calls + usage 末帧），两段 arguments 拼接后是合法 JSON。
