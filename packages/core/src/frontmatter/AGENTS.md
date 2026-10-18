# Working in src/frontmatter/

- Keep the parser minimal: `---` fence, `key: value` lines, value taken after the first colon and trimmed. Do not add a YAML dependency or support nested/list/multiline values.
- A first line that is not `---` returns `{}`; a missing closing fence reads to EOF (tolerant).
- Both `skills/` and `prompt-templates/` consume this module. If the contract changes, update both call sites and their tests.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
