# Working in packages/core/src/

- The session JSONL event log is the single source of truth. UI-facing state must be derivable via `session/derive.ts`; do not introduce parallel mutable state. Every persisted `assistant_msg` tool_call must end up with exactly one `tool_result` — a missing one makes the next API request invalid.
- Each subdirectory carries its own `README.md` (Simplified Chinese) and `AGENTS.md` (English) with module-level rules; read them before editing and keep them in sync with behavior changes.
- `index.ts` re-exports only; no logic. New public surface is exported here.
- `config.ts` (`loadSettings`) resolves home via `resolveHome` from `session/store.ts` (param > `HOTPOT_HOME` env > `~/hotpot-code`) — reuse it, never duplicate the rule. `apiKey` supports whole-string `$ENV` references.
- `node-builtins.d.ts` holds minimal ambient declarations for `node:*` modules because the dependency whitelist forbids `@types/node`; extend it when a new API is used, declaring only what is actually consumed.
- Dependency direction is fixed (`cli → core → ai`): may import `@hotpot/ai` and whitelisted runtime deps (`zod`); never import `@hotpot/cli`.
- LLM-facing prompt text and tool descriptions are English; code comments in Simplified Chinese.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
