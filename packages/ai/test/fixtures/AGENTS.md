# Working in packages/ai/test/fixtures/

- SSE fixture files (`<api>-*.sse.txt`) hold raw vendor stream bytes in text form: `data: <json>` lines separated by blank lines, terminated by `data: [DONE]` for OpenAI-family APIs.
- Tests load them via `readFile(new URL("./fixtures/<name>", import.meta.url))`, encode to `Uint8Array`, and replay through a `FetchLike` fake. Never fetch real endpoints to refresh fixtures without being asked.
- Keep fixtures minimal but faithful: field names, `finish_reason`, and the trailing `usage` chunk must mirror real vendor payloads, because tests assert exact `StreamEvent` sequences against them.
- Multi-byte UTF-8 content in fixtures is intentional — it exercises byte-boundary decoding in `parseSseStream`.
