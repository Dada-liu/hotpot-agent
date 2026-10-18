# Working in src/prompt/

- All prompt text is LLM-facing and must be written in English (root AGENTS.md rule); code comments stay in Simplified Chinese.
- The registry in `sections.ts` is a module-level singleton. `resetSections()` exists only for test isolation — never call it from production code.
- Default section orders live in `SECTION_ORDER` (`default-sections.ts`) with 1000-wide gaps; pick in-between values for new sections instead of renumbering existing ones.
- Keep section text short — a few lines per section. Dynamic content (tool list, cwd, date) goes through `PromptContext`, never read from `process` directly, so tests stay deterministic.
- Export the feature's public surface through `index.ts`; cross-feature imports target concrete files.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
