# Working in src/models/

- Resolve through `findModel` from `@hotpot/ai` first; only fall back to protocol inference when the catalog misses.
- Fallback mapping: `anthropic → anthropic-messages`, everything else → `openai-completions`. Do not add per-provider special cases without updating the catalog.
- Unknown models get a conservative `contextWindow` and zero cost (unknown means not billable), plus a warning.
- `resolveModel` returns a `ModelResolution` containing adapter, model info and credentials; do not read settings here — callers pass the `ModelRef`.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
