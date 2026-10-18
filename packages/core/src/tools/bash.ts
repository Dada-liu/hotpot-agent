// bash 工具：经 `bash -c` 执行命令，content 汇总 stdout、stderr 与退出码。
// 安全面：命中 DANGEROUS_COMMAND_PATTERNS 的命令先走 ApprovalChain.ask（fail-closed），
// deny 则不执行；超时与 AbortSignal 会 SIGKILL 整个进程组（含后台子进程）；
// stdout/stderr 各截断到尾部 30000 字符并在 content 头部标注，防止超长输出撑爆上下文。
// 后台命令（`nohup ... &`）按直接 shell 的 exit 收口：不等继承自 shell 的后台进程关闭
// stdout/stderr，否则 dev server 一类长驻进程会让工具调用永久挂起。

import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tool.ts";

export const BASH_DEFAULT_TIMEOUT_MS = 120000;
export const MAX_OUTPUT_CHARS = 30000;

// 高危命令正则表：集中导出，后续扩充只改这里
// rm 行覆盖组合旗标任意顺序（-rf/-fr/-R/-frv）与长选项 --recursive——
// 旧写法 /rm\s+-rf?/ 只认 r 在前的单一顺序，rm -fr 等变体会绕过审批
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
	/mkfs/,
	/dd\s+if=/,
	// 只拦真正的设备写入；`2>/dev/null`、`>/dev/stdout` 等常见安全伪设备不触发审批
	/>\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|zero\b|random\b|urandom\b)/,
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
		const child = spawn("bash", ["-c", command], {
			cwd: ctx.cwd,
			// 独立进程组：超时/中断时能连同后台子进程一起杀死；
			// stdin 置空，避免后台进程占用调用方 stdin
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let exitCode: number | null = null;
		let exitSignal: string | null = null;

		// 杀整个进程组：只 kill 直接子 shell 时，后台进程仍持有 stdout/stderr，
		// close 事件不会触发（实际故障：nohup npm run dev & 永久挂起工具调用）
		const killTree = () => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") {
					child.kill("SIGKILL");
				} else {
					process.kill(-child.pid, "SIGKILL");
				}
			} catch {
				// 进程/进程组已退出：退回直接 kill，避免 timer 回调抛错
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutMs);

		const onAbort = () => {
			aborted = true;
			killTree();
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

		// 所有结束路径都经 settle 收口，保证 timer / abort / drain 只清理一次、只 resolve 一次
		const settle = (out: ToolOutput) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (drainTimer !== undefined) clearTimeout(drainTimer);
			ctx.signal.removeEventListener("abort", onAbort);
			// 后台进程可能仍持有管道：工具已返回，主动释放读端避免 fd 泄漏。
			// 后台进程自己的 stdout 通常已重定向到文件；仍写管道的会被 SIGPIPE。
			child.stdout?.removeAllListeners();
			child.stderr?.removeAllListeners();
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
			resolve(out);
		};

		const finish = (code: number | null, signal: string | null): void => {
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
		};

		child.on("error", (err) => {
			settle({
				content: `Failed to start command "${command}": ${err.message}`,
				isError: true,
			});
		});

		child.on("exit", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			// 直接 shell 已退出。若仍有后台进程继承 stdout/stderr，close 永远不会触发；
			// 给已缓冲输出一个很短的排空窗口后按 exit 收口（后台作业不等待）。
			drainTimer = setTimeout(() => {
				finish(code, signal);
			}, 50);
		});

		child.on("close", (code, signal) => {
			// 普通前台命令：exit 后 close 紧跟着到达，立即收口并清掉排空定时器
			finish(code ?? exitCode, signal ?? exitSignal);
		});
	});
}
