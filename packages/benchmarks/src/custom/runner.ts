// 自建题执行：每题一个临时 workspace（<workspaceRoot>/<id>-<random>），
// 先写初始文件，再交给注入的 AgentRunner（测试用假实现，真实 CLI 用无交互 agent），
// 最后在 workspace 内用 `bash -c` 跑校验命令。校验只看退出码与可选 stdout 子串。
// 默认清理 workspace；KEEP_BENCH_WORKSPACE=1 时保留，便于人工复盘失败题。
// 这里不安装依赖、不访问网络：题目必须自带校验脚本需要的全部文件。

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand } from "../process.ts";
import type { CustomTask } from "./task.ts";

export type AgentRunner = (opts: {
	cwd: string;
	prompt: string;
	timeoutMs?: number;
}) => Promise<{ inputTokens: number; outputTokens: number }>;

export interface CustomTaskDeps {
	runAgent: AgentRunner;
	workspaceRoot: string;
}

export interface CustomTaskResult {
	id: string;
	passed: boolean;
	exitCode: number;
	stdout: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	error?: string;
}

export async function runCustomTask(
	task: CustomTask,
	deps: CustomTaskDeps,
): Promise<CustomTaskResult> {
	const started = Date.now();
	const workspaceId = `${task.id}-${randomUUID().slice(0, 8)}`;
	const cwd = join(deps.workspaceRoot, workspaceId);
	let passed = false;
	let exitCode = -1;
	let stdout = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let error: string | undefined;

	try {
		await mkdir(cwd, { recursive: true });
		for (const [relative, content] of Object.entries(task.workspace.files)) {
			const target = join(cwd, relative);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content);
		}

		const usage = await deps.runAgent({
			cwd,
			prompt: task.prompt,
			timeoutMs: task.timeoutMs,
		});
		inputTokens = usage.inputTokens;
		outputTokens = usage.outputTokens;

		const validation = await runCommand(
			"bash",
			["-c", task.validation.command],
			{
				cwd,
				timeoutMs: task.timeoutMs,
			},
		);
		exitCode = validation.code;
		stdout = validation.stdout;

		const expectedExitCode = task.validation.expectedExitCode ?? 0;
		const exitOk = exitCode === expectedExitCode;
		const stdoutOk =
			task.validation.expectedStdout === undefined ||
			stdout.includes(task.validation.expectedStdout);
		passed = exitOk && stdoutOk;

		if (!passed) {
			if (validation.timedOut) {
				error = `validation timed out after ${task.timeoutMs ?? 0}ms`;
			} else if (!exitOk) {
				error = `validation exited with ${exitCode}, expected ${expectedExitCode}${
					validation.stderr.trim() === "" ? "" : `: ${validation.stderr.trim()}`
				}`;
			} else {
				error = "validation stdout did not contain the expected substring";
			}
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		if (process.env.KEEP_BENCH_WORKSPACE !== "1") {
			await rm(cwd, { recursive: true, force: true });
		}
	}

	return {
		id: task.id,
		passed,
		exitCode,
		stdout,
		durationMs: Date.now() - started,
		inputTokens,
		outputTokens,
		...(error === undefined ? {} : { error }),
	};
}
