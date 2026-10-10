# Working in src/tools/

- `ToolDefinition<T>` binds its generic to the zod schema: `parameters: z.ZodType<T>`. `register` erases `T` to `unknown` and wraps `execute`/`present` with `schema.parse`, so untrusted LLM input is validated and stripped before the tool body sees it.
- `declarations()` converts schemas with zod v4's built-in `z.toJSONSchema` (pinned by controller ruling; never add zod-to-json-schema). The top-level schema must be `type: "object"`; anything else throws.
- The declaration `description` always comes from the tool definition field, not from a schema-level `.describe()`.
- `zod` (^4) is the only whitelisted runtime dependency here besides `@hotpot/ai`.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
