# src/tools/

工具框架：`ToolDefinition` 定义工具（参数为 zod schema），`ToolRegistry` 负责注册、擦除泛型、产出 LLM 所需的 `ToolDeclaration`。

- `tool.ts` — `ToolDefinition<T>` / `ToolOutput` / `ToolContext`。泛型 T 与 `parameters: z.ZodType<T>` 绑定；`ToolContext` 携带 cwd、`AbortSignal`、`ApprovalChain` 与 M4 新增的 `agentId`/`session`（工具落盘功能事件的归属与通道）。
- `registry.ts` — `createToolRegistry()`。`register` 把 `ToolDefinition<T>` 擦除为 `ToolDefinition<unknown>`，并用 `schema.parse` 包裹 execute/present，使 LLM 传入的 unknown 入参先校验、剥离多余字段再执行；`declarations` 用 zod v4 内置的 `z.toJSONSchema` 输出 JSON Schema（顶层必须是 object，否则抛错），`description` 以工具定义字段为准。
- `bash.ts` — `bashTool`。经 `bash -c` 执行命令，content 汇总 stdout、stderr 与退出码；两个流各截断到尾部 30000 字符（`MAX_OUTPUT_CHARS`）并在头部标注。命中 `DANGEROUS_COMMAND_PATTERNS`（rm 递归删除——覆盖 -rf/-fr/-R/-frv 任意旗标组合与 --recursive、mkfs、dd if=、> /dev/、shutdown/reboot、git push --force、fork bomb）的命令先走 `ApprovalChain.ask({kind:"command"})`，deny 则不执行并返回 isError；超时（默认 120s，可用参数 `timeoutMs` 覆盖）与 `AbortSignal` 都会 SIGKILL 子进程。`isConcurrencySafe: false`，同批调用串行。
- `read.ts` — `readTool`。读取文本文件（路径相对 `ctx.cwd` 解析），按 `行号\t内容` 返回，行号 1-based；`offset`（默认 1）与 `limit`（默认 `READ_DEFAULT_LIMIT` 2000）分页，后面仍有内容时追加 `[truncated: ...]` 提示并给出续读 offset。含 NUL 字节的文件按二进制拒绝；文件不存在返回 isError 而不抛出。`isConcurrencySafe: true`。
- `write.ts` — `writeTool`。写入 `content`，父目录不存在时递归创建；目标已存在时先走 `ApprovalChain.ask({kind:"write"})`，deny 则不写并返回 isError。`isConcurrencySafe: false`。
- `edit.ts` — `editTool`。精确字符串替换（非正则），替换经函数式 replacer 写回：`new_string` 里的 `$$`、`$&` 等 `$` 模式逐字节保留，不做 JS replacement 模式展开。utf8 往返写回，未触及部分原样保留（CRLF 文件可精确匹配且不丢 `\r`）。`old_string` 出现 0 次 → isError 并建议先 read；出现多次且未传 `replace_all` → isError 并给出出现次数；`replace_all: true` 替换全部。`isConcurrencySafe: false`。
