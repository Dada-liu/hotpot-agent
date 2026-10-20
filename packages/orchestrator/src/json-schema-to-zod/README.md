# src/json-schema-to-zod/

MCP 工具 `inputSchema` → zod 子集转换（M4 Feature⑦）。

- `jsonSchemaToZod(schema)`：支持 `object/properties/required`、`enum`、`string/number/integer/boolean`、`array/items`；`additionalProperties` 忽略（zod object 默认 strip 未知键）。
- 「不拦」原则：`anyOf/oneOf/allOf/$ref/not` 或未知 type 回退 `z.unknown()`；顶层非 object 回退空对象 passthrough，保证 `declarations()` 顶层是 object。
- 只被 `mcp/` 使用。转换不了的结构不抛给模型，校验交还 MCP server。
- `index.ts` 是本特性的对外出口。
