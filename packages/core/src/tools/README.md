# src/tools/

工具框架：`ToolDefinition` 定义工具（参数为 zod schema），`ToolRegistry` 负责注册、擦除泛型、产出 LLM 所需的 `ToolDeclaration`。

- `tool.ts` — `ToolDefinition<T>` / `ToolOutput` / `ToolContext`。泛型 T 与 `parameters: z.ZodType<T>` 绑定；`ToolContext` 携带 cwd、`AbortSignal` 与 `ApprovalChain`。
- `registry.ts` — `createToolRegistry()`。`register` 把 `ToolDefinition<T>` 擦除为 `ToolDefinition<unknown>`，并用 `schema.parse` 包裹 execute/present，使 LLM 传入的 unknown 入参先校验、剥离多余字段再执行；`declarations` 用 zod v4 内置的 `z.toJSONSchema` 输出 JSON Schema（顶层必须是 object，否则抛错），`description` 以工具定义字段为准。
- `bash.ts` — `bashTool`。经 `bash -c` 执行命令，content 汇总 stdout、stderr 与退出码；两个流各截断到尾部 30000 字符（`MAX_OUTPUT_CHARS`）并在头部标注。命中 `DANGEROUS_COMMAND_PATTERNS`（rm -rf、mkfs、dd if=、> /dev/、shutdown/reboot、git push --force、fork bomb）的命令先走 `ApprovalChain.ask({kind:"command"})`，deny 则不执行并返回 isError；超时（默认 120s，可用参数 `timeoutMs` 覆盖）与 `AbortSignal` 都会 SIGKILL 子进程。`isConcurrencySafe: false`，同批调用串行。
