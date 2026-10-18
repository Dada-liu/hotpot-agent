# Working in src/skills/

- Discovery is progressive: only name/description/path enter the prompt; the body is read on demand by the model through the `read` tool.
- Scan recursively for `SKILL.md`. `name` defaults to the containing directory name, `description` defaults to an empty string. Later directories win on duplicate names; missing/unreadable directories are skipped silently.
- Frontmatter parsing is shared with `prompt-templates/` through `../frontmatter/frontmatter.ts`; do not fork the parser.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
