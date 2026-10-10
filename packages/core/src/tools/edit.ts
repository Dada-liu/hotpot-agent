// edit 工具：对文件做精确字符串替换（非正则），替换后整体写回。
// old_string 出现 0 次 → isError 并建议先 read 拿到当前内容；出现多次且未传
// replace_all → isError 并给出出现次数；replace_all=true 时替换全部。
// 读写都用原始字节（utf8 往返不改动未触及的部分），CRLF 文件因此可精确匹配且不丢 \r。
// 路径相对 ctx.cwd 解析；有副作用，isConcurrencySafe 为 false。

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./tool.ts";

type EditArgs = {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
};

export const editTool: ToolDefinition<EditArgs> = {
	name: "edit",
	description:
		"Replace an exact string in a file with another string (no regex). Paths are relative to the working directory. Fails if old_string is not found, or if it appears more than once unless replace_all is true. Read the file first to get the exact current content, including indentation and line endings.",
	parameters: z.object({
		path: z
			.string()
			.describe("file path, absolute or relative to the working directory"),
		old_string: z
			.string()
			.min(1)
			.describe("the exact string to replace; must match the file content"),
		new_string: z.string().describe("the string to put in its place"),
		replace_all: z
			.boolean()
			.optional()
			.describe("replace every occurrence of old_string; default false"),
	}),
	// 有副作用，同批调用必须串行
	isConcurrencySafe: false,
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

		const count = text.split(args.old_string).length - 1;
		if (count === 0) {
			return {
				content: `old_string not found in ${args.path}. Read the file first to get the exact current content.`,
				isError: true,
			};
		}
		if (count > 1 && !args.replace_all) {
			return {
				content: `old_string appears ${count} times in ${args.path}; it must be unique. Pass replace_all=true to replace all occurrences.`,
				isError: true,
			};
		}

		// count === 1 时 replace 只命中唯一处；replace_all 时替换全部
		const replaced = args.replace_all
			? text.replaceAll(args.old_string, args.new_string)
			: text.replace(args.old_string, args.new_string);
		await writeFile(fullPath, replaced);
		return {
			content: `Replaced ${args.replace_all ? count : 1} occurrence(s) in ${args.path}`,
		};
	},
};
