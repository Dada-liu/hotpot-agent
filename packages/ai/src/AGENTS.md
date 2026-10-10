# Working in packages/ai/src/

- `types.ts` is the project-wide contract: downstream packages and adapters consume only the names exported here. Keep it pure types except `LlmError`.
- `models.ts` holds the `MODELS` catalog. Use real vendor-published numbers (contextWindow / maxTokens / cost in USD per million tokens) and annotate the source review date in a comment when a value is uncertain.
- `index.ts` re-exports only; no logic.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Run `pnpm test`, `pnpm exec biome check` and `pnpm exec tsc -p packages/ai/tsconfig.json --noEmit` from the repo root before committing.
