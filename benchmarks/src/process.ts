// 子进程执行辅助：统一捕获 stdout/stderr、支持超时与流式回调。
// workspace、validation、官方评测都走这里，避免各处重复 spawn 模板。
// 只有进程正常退出或超时被 SIGKILL 时 resolve；spawn 失败（命令不存在）也 resolve，
// 由调用方按 code=-1 处理，不把「工具缺失」变成未捕获异常。

import { spawn } from "node:child_process";

export interface RunCommandOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	// 逐块回调（日志落盘用）：stdout 与 stderr 分开标记
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export function runCommand(
	command: string,
	args: string[],
	opts: RunCommandOptions,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const child = spawn(command, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const finish = (code: number): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			resolve({ code, stdout, stderr, timedOut });
		};

		child.stdout?.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			opts.onStdout?.(text);
		});
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			opts.onStderr?.(text);
		});
		child.on("error", (err) => {
			stderr += err.message;
			finish(-1);
		});
		child.on("close", (code) => {
			finish(code ?? -1);
		});

		if (opts.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, opts.timeoutMs);
		}
	});
}
