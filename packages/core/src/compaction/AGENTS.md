# Working in src/compaction/

- The session JSONL log remains the only source of truth. Persist a `compaction` event only after a complete, successful summary; never maintain a parallel mutable message history.
- Trigger before every formal request when estimated tokens exceed `(contextWindow - maxTokens) * triggerRatio`. Defaults are `0.8`, `20000`, and enabled; both settings are user-level only.
- Reuse the current adapter/model for summaries, pass `tools: []`, and call the adapter directly so compaction cannot recursively compact itself.
- Retain whole recent event groups. Never split an assistant tool_call from its matching tool_result events; the latest group is retained even when it alone exceeds `keepRecentTokens`.
- On summary failure or abort, do not append a compaction event or send the known-over-limit formal request. After compaction, a still-over-limit request fails with `context_limit`.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments and README in Simplified Chinese, LLM prompts in English with Chinese comments.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
