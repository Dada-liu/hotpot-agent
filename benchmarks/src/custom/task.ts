// 自建题格式（见 docs/benchmark-authoring.md）：一个 JSON 文件描述题目、初始 workspace 文件、
// 校验命令与超时。题目离线、确定性、无网络；workspace.files 必须自带校验所需的全部文件。
// 用 .strict() 解析，字段拼错会直接报错，而不是让题目静默少跑一步。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const CUSTOM_TASK_DOMAINS = [
	"finance",
	"software",
	"self-media",
] as const;

export type CustomTaskDomain = (typeof CUSTOM_TASK_DOMAINS)[number];

export const customTaskSchema = z
	.object({
		id: z.string().min(1),
		domain: z.enum(CUSTOM_TASK_DOMAINS),
		prompt: z.string().min(1),
		workspace: z
			.object({
				files: z.record(z.string(), z.string()),
			})
			.strict(),
		validation: z
			.object({
				command: z.string().min(1),
				// 默认 0；只比较退出码，不解析测试框架输出
				expectedExitCode: z.number().int().optional(),
				// 提供时用「stdout 包含该子串」判定，适配 node 校验脚本的一行结论
				expectedStdout: z.string().optional(),
			})
			.strict(),
		timeoutMs: z.number().int().positive().optional(),
	})
	.strict();

export type CustomTask = z.infer<typeof customTaskSchema>;

export function parseCustomTask(value: unknown, source: string): CustomTask {
	const parsed = customTaskSchema.safeParse(value);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`invalid custom task ${source}: ${detail}`);
	}
	return parsed.data;
}

// 按文件名排序加载目录下全部 .json；id 冲突直接报错，避免报告里两题互相覆盖。
// 题目文件是仓库内资产，解析失败应尽早暴露，不做静默跳过。
export async function loadCustomTasks(dir: string): Promise<CustomTask[]> {
	const files = (await readdir(dir))
		.filter((file) => file.endsWith(".json"))
		.sort();
	const tasks: CustomTask[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const path = join(dir, file);
		const text = await readFile(path, "utf8");
		let value: unknown;
		try {
			value = JSON.parse(text) as unknown;
		} catch {
			throw new Error(`custom task is not valid JSON: ${path}`);
		}
		const task = parseCustomTask(value, path);
		if (seen.has(task.id)) {
			throw new Error(`duplicate custom task id "${task.id}" in ${path}`);
		}
		seen.add(task.id);
		tasks.push(task);
	}
	return tasks;
}
