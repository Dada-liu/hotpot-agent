// write 工具：把 content 写入目标文件，父目录不存在时递归创建。
// 目标已存在时先走 ApprovalChain.ask({kind:"write"})，deny 则不写并返回 isError；
// 新文件不触发审批。路径相对 ctx.cwd 解析；有副作用，isConcurrencySafe 为 false。

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./tool.ts";

type WriteArgs = { path: string; content: string };

export const writeTool: ToolDefinition<WriteArgs> = {
	name: "write",
	description:
		"Write content to a file, creating parent directories as needed. Paths are relative to the working directory. Overwriting an existing file requires user approval; to change part of a file, prefer the edit tool.",
	parameters: z.object({
		path: z
			.string()
			.describe("file path, absolute or relative to the working directory"),
		content: z.string().describe("the full content to write to the file"),
	}),
	// 有副作用，同批调用必须串行
	isConcurrencySafe: false,
	async execute(args, ctx) {
		const fullPath = resolve(ctx.cwd, args.path);
		if (existsSync(fullPath)) {
			const decision = await ctx.approval.ask({
				kind: "write",
				summary: `Overwrite existing file: ${args.path}`,
				detail: args.content,
			});
			if (decision === "deny") {
				return {
					content: `Write denied by approval: ${args.path}`,
					isError: true,
				};
			}
		}
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, args.content);
		return { content: `Wrote ${args.path}` };
	},
};
