# Working in packages/ai/src/api/

- One file per protocol adapter, named after the API family (`openai-completions.ts`, `anthropic-messages.ts`). Each exports a `create*Adapter(fetchImpl?: FetchLike): LlmAdapter` factory.
- Adapters do pure protocol translation: unified `ChatRequest` → vendor wire format upstream, vendor SSE chunks → unified `StreamEvent` downstream. No retry, caching, or logging here.
- All network I/O goes through the injected `FetchLike`; fall back to global `fetch` only when no implementation is given. Never add an HTTP client dependency.
- SSE parsing is shared: import `parseSseStream` from `../sse.ts` instead of writing a per-adapter parser.
- Non-2xx responses must throw `LlmError` with `status`, the first 500 chars of the body as message, and `retryAfter` (seconds) when the `retry-after` header is present.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
