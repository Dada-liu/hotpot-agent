// read 工具：读取文本文件，按 `行号\t内容` 返回（offset 为 1-based 起始行号，默认 1）。
// 含 NUL 字节视为二进制文件，拒绝读取；默认最多返回 2000 行，超出时截断并提示用 offset 分页。
// 路径相对 ctx.cwd 解析（也接受绝对路径）；只读操作，isConcurrencySafe 为 true。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./tool.ts";

export const READ_DEFAULT_LIMIT = 2000;

type ReadArgs = { path: string; offset?: number; limit?: number };

export const readTool: ToolDefinition<ReadArgs> = {
	name: "read",
	description:
		"Read a text file and return its contents with 1-based line numbers (format: `line<TAB>content`). Paths are relative to the working directory. Use `offset` (first line to show) and `limit` (max lines, default 2000) to page through large files; when the output is truncated, call again with the offset given in the notice. Binary files (containing NUL bytes) are rejected.",
	parameters: z.object({
		path: z
			.string()
			.describe("file path, absolute or relative to the working directory"),
		offset: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("1-based line number to start reading from; default 1"),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("maximum number of lines to return; default 2000"),
	}),
	// 只读，同批调用可并行
	isConcurrencySafe: true,
	async execute(args, ctx) {
		const fullPath = resolve(ctx.cwd, args.path);
		let text: string;
		try {
			text = await readFile(fullPath, "utf8");
		} catch (err) {
			return {
				content: `Failed to read ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
		// utf8 解码保留 NUL 为 \0；含 NUL 即判定二进制，不往上下文里塞乱码
		if (text.includes("\0")) {
			return {
				content: `Cannot read ${args.path}: it is a binary file (contains NUL bytes)`,
				isError: true,
			};
		}

		const lines = text.split("\n");
		// 末尾换行产生的空串是 split 的 artifact，不是真实的空行
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

		const offset = args.offset ?? 1;
		const limit = args.limit ?? READ_DEFAULT_LIMIT;
		const start = offset - 1;
		const slice = lines.slice(start, start + limit);
		if (slice.length === 0 && lines.length > 0) {
			return {
				content: `offset ${offset} is past the end of ${args.path} (${lines.length} lines)`,
				isError: true,
			};
		}

		const end = start + slice.length;
		const body = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
		if (end < lines.length) {
			return {
				content: `${body}\n[truncated: showing lines ${offset}-${end} of ${lines.length}; call again with offset=${end + 1} to read more]`,
			};
		}
		return { content: body };
	},
};
