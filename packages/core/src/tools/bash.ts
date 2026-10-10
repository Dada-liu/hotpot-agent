// bash 工具：经 `bash -c` 执行命令，content 汇总 stdout、stderr 与退出码。
// 安全面：命中 DANGEROUS_COMMAND_PATTERNS 的命令先走 ApprovalChain.ask（fail-closed），
// deny 则不执行；超时与 AbortSignal 都会 SIGKILL 子进程；
// stdout/stderr 各截断到尾部 30000 字符并在 content 头部标注，防止超长输出撑爆上下文。

import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tool.ts";

export const BASH_DEFAULT_TIMEOUT_MS = 120000;
export const MAX_OUTPUT_CHARS = 30000;

// 高危命令正则表：集中导出，后续扩充只改这里
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
	/rm\s+-rf?/,
	/mkfs/,
	/dd\s+if=/,
	/>\s*\/dev\//,
	/shutdown|reboot/,
	/git\s+push\s+.*--force/,
	/:\(\)\{/,
];

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_COMMAND_PATTERNS.some((p) => p.test(command));
}

type BashArgs = { command: string; timeoutMs?: number };

export const bashTool: ToolDefinition<BashArgs> = {
	name: "bash",
	description:
		"Run a bash command in the current working directory via `bash -c`. Returns stdout, stderr and the exit code. Each stream is truncated to its last 30000 characters. Potentially destructive commands (recursive delete, disk formatting, writing to devices, force push, shutdown/reboot) require user approval before they run.",
	parameters: z.object({
		command: z.string().describe("the bash command to run"),
		timeoutMs: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				"kill the command after this many milliseconds; default 120000",
			),
	}),
	// bash 有副作用，同批调用必须串行
	isConcurrencySafe: false,
	async execute(args, ctx) {
		if (isDangerousCommand(args.command)) {
			const decision = await ctx.approval.ask({
				kind: "command",
				summary: `Run potentially destructive command: ${args.command}`,
				detail: args.command,
			});
			if (decision === "deny") {
				return {
					content: `Command denied by approval: ${args.command}`,
					isError: true,
				};
			}
		}
		return runBash(
			args.command,
			args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS,
			ctx,
		);
	},
};

// 保留尾部：模型更关心命令收尾的输出（错误、结果），开头被截掉时在头部标注
function tailTruncate(s: string): { text: string; truncated: boolean } {
	if (s.length <= MAX_OUTPUT_CHARS) return { text: s, truncated: false };
	return { text: s.slice(-MAX_OUTPUT_CHARS), truncated: true };
}

function runBash(
	command: string,
	timeoutMs: number,
	ctx: ToolContext,
): Promise<ToolOutput> {
	return new Promise<ToolOutput>((resolve) => {
		const child = spawn("bash", ["-c", command], { cwd: ctx.cwd });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		const onAbort = () => {
			aborted = true;
			child.kill("SIGKILL");
		};
		if (ctx.signal.aborted) {
			onAbort();
		} else {
			ctx.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		// 两种结束路径都经 settle 收口，保证 timer 与 abort 监听只清理一次、只 resolve 一次
		const settle = (out: ToolOutput) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ctx.signal.removeEventListener("abort", onAbort);
			resolve(out);
		};

		child.on("error", (err) => {
			settle({
				content: `Failed to start command "${command}": ${err.message}`,
				isError: true,
			});
		});

		child.on("close", (code, signal) => {
			const out = tailTruncate(stdout);
			const err = tailTruncate(stderr);

			let header = "";
			if (timedOut) header += `[timeout: killed after ${timeoutMs}ms]\n`;
			if (aborted) header += "[aborted: interrupted by caller]\n";
			if (out.truncated)
				header += `[stdout truncated to last ${MAX_OUTPUT_CHARS} chars]\n`;
			if (err.truncated)
				header += `[stderr truncated to last ${MAX_OUTPUT_CHARS} chars]\n`;

			let body = "";
			if (out.text) body += out.text;
			if (err.text) {
				body += `${body === "" || body.endsWith("\n") ? "" : "\n"}${err.text}`;
			}
			const exitLine =
				code === null ? `terminated by signal ${signal}` : `exit code: ${code}`;
			settle({
				content: `${header}${body}${body === "" || body.endsWith("\n") ? "" : "\n"}${exitLine}`,
				isError: timedOut || aborted || code !== 0,
			});
		});
	});
}
