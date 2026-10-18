# Working in src/json-schema-to-zod/

- Support only the MCP `inputSchema` subset: `object/properties/required`, `enum`, `string/number/integer/boolean`, `array/items`. Ignore `additionalProperties`.
- Fail open: unsupported structural keywords (`anyOf/oneOf/allOf/$ref/not`) and unknown types fall back to `z.unknown()`; a top-level non-object falls back to an empty passthrough object so `declarations()` still emits `type: "object"`.
- Never throw at the model because a schema could not be converted; validation belongs to the MCP server.
- Keep the zod v4 enum guard: empty or non-string enums produce a never schema otherwise.
- Only `mcp/` consumes this module. Export the feature's public surface through `index.ts`.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
