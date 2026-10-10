# Working in src/ (packages/cli)

- This package only does terminal I/O, argument parsing and rendering; all agent logic belongs to `@hotpot/core`. Dependency direction is fixed: `cli → core → ai`.
- `bin.ts` stays a thin process-level entry; all testable logic lives in `chat.ts` (`runChat`, `parseChatArgs`, `runChatCli`, `resolveModelAdapter`).
- IO is injected through the `ChatInput`/`ChatOutput` interfaces so tests can drive `runChat` with scripted lines and captured output — never read `process.stdin`/`process.stdout` directly outside `createTerminalChatInput`/`runChatCli`.
- Do not call a tool's `present` for rendering tool calls: it can synchronously throw on raw LLM input. Render `name` plus a JSON argument summary only.
- `node-builtins.d.ts` must remain a superset of `packages/core/src/node-builtins.d.ts` (core sources are compiled as part of this package through workspace source imports). Extend it when a new Node builtin is used.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese; user-facing CLI text may be Chinese, LLM-visible content stays English.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
