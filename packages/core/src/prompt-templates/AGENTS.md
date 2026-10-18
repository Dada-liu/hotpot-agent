# Working in src/prompt-templates/

- Scan order decides precedence: `settings.promptsDirs` (relative to cwd), then `<home>/prompts`, then `<cwd>/.hotpot/prompts`. Later scans overwrite earlier same-name templates, so project-level wins.
- Placeholders: `$ARGUMENTS` joins all args with spaces; `$1..$9` are positional. Referencing a position beyond the supplied argument count is an explicit error.
- Template expansion is pure and does not persist anything. The caller (CLI / server) appends the `prompt/invoked` event after expansion.
- Frontmatter parsing is shared with `skills/` through `../frontmatter/frontmatter.ts`; do not fork the parser.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
