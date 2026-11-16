# Working in src/user-memory/

- Store user memory only in `<home>/MEMORY.md`, resolving home through `session/store.ts` (`home` argument > `HOTPOT_HOME` > `~/.hotpot`). The file must remain human-editable Markdown.
- `appendMemory` trims content, rejects empty input, preserves existing content, appends one list item with two-space continuation indentation, and fsyncs each write. `readMemorySummary` returns at most 8,000 characters, keeps complete trailing Markdown list entries with a truncation notice, and degrades read failures to an empty string.
- `createMemorySaveTool` is the only write tool: `memory_save { content: string }`. A successful write appends audit-only `memory/saved { id, ts, agentId }`; never copy memory content into that event. Return `isError` on write failure.
- Do not add `memory_search`, vector storage, or automatic fact extraction here. Prompt injection and role registration belong to the orchestrator integration task.
- `features.memory` is user-level only and defaults to `false`; other existing feature switches retain their defaults.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
