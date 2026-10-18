// 自建题格式（见 docs/benchmark-authoring.md）：一个 JSON 文件描述题目、初始 workspace 文件、
// 校验命令与超时。题目离线、确定性、无网络；workspace.files 必须自带校验所需的全部文件。
// 用 .strict() 解析，字段拼错会直接报错，而不是让题目静默少跑一步。

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
				// 缺省 0；只比较退出码，不解析测试框架输出
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
