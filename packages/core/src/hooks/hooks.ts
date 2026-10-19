// hooks 生命周期链（M4 Feature③）：审批 waterfall 的公开版。
// 配置直接消费 Claude Code 钩子格式：SessionStart / PreToolUse / PostToolUse / Stop
// （Stop 映射 turn_end）。每个 handler 是用户配置的 shell 命令，执行约定：
// - payload 经 stdin 喂 JSON（含 session_id/cwd/agent_id/hook_event 与事件特有字段）
// - env 带 HOTPOT_HOOK_EVENT；cwd = 会话 cwd
// - 默认超时 60s（opts.timeoutMs 可覆盖，测试注入用）
// - 每条命令执行后落一条 hook/fired 事件（审计 + 遥测）
// 阻断语义：仅 pre_tool 的非零退出码阻断工具（stdout+stderr 作为 isError 内容）；
// 其余事件只记录不阻断；spawn 失败与超时 fail-open（exitCode=-1，不阻断）。
// 安全：hooks 只来自用户级 settings —— 项目级白名单不含 hooks，恶意仓库无法注入命令。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HooksConfig, Settings } from "../config/config.ts";
import type { HookEvent } from "../session/events.ts";
import type { Session } from "../session/store.ts";

export interface HookRunResult {
	// 仅 pre_tool 可能为 true（任一匹配命令非零退出）
	blocked: boolean;
	// 阻断原因汇总（stdout+stderr），未阻断时为空串
	output: string;
}

export interface HookChain {
	// payload 为事件特有字段；base 字段（session_id/cwd/agent_id/hook_event）由链补齐。
	// payload.agent_id 可覆盖链默认 agentId（worker/task 的工具钩子归属各自 agent）
	run(
		event: HookEvent,
		payload: Record<string, unknown>,
	): Promise<HookRunResult>;
}

// 事件 → Claude Code 配置键
const EVENT_KEYS: Record<HookEvent, keyof HooksConfig> = {
	session_start: "SessionStart",
	pre_tool: "PreToolUse",
	post_tool: "PostToolUse",
	turn_end: "Stop",
};

export const HOOK_DEFAULT_TIMEOUT_MS = 60_000;
// 钩子输出截断上限：阻断原因只需足够定位问题，避免超长输出撑爆工具结果
const MAX_HOOK_OUTPUT_CHARS = 8_000;

type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

function truncateTail(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `…(已截断前 ${text.length - max} 字符)…\n${text.slice(-max)}`;
}

// matcher 语义：工具事件按工具名精确匹配，"" 与 "*" 匹配全部；
// 非工具事件（session_start/turn_end）忽略 matcher 一律匹配（Claude Code 的
// SessionStart matcher 取值语义属于界面扩展，M4 不引入）。
function matchesEntry(
	event: HookEvent,
	matcher: string,
	payload: Record<string, unknown>,
): boolean {
	if (event !== "pre_tool" && event !== "post_tool") {
		return true;
	}
	const toolName =
		typeof payload.tool_name === "string" ? payload.tool_name : "";
	return matcher === "" || matcher === "*" || matcher === toolName;
}

// 执行单条 hook 命令：stdin JSON、收集 stdout/stderr、超时 SIGKILL。
// 永不 reject（spawn 失败以 exitCode=-1 收敛），保证钩子故障不打断回合。
function runCommand(
	command: string,
	payload: Record<string, unknown>,
	opts: { cwd: string; event: HookEvent; timeoutMs: number },
): Promise<CommandResult> {
	return new Promise<CommandResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (exitCode: number): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			resolve({
				exitCode,
				stdout: truncateTail(stdout, MAX_HOOK_OUTPUT_CHARS),
				stderr: truncateTail(stderr, MAX_HOOK_OUTPUT_CHARS),
				timedOut,
			});
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("bash", ["-c", command], {
				cwd: opts.cwd,
				env: { ...process.env, HOTPOT_HOOK_EVENT: opts.event },
			});
		} catch {
			// spawn 本身抛出（如命令表损坏）：fail-open
			finish(-1);
			return;
		}

		timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			finish(-1);
		}, opts.timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", () => {
			finish(-1);
		});
		child.on("close", (code) => {
			finish(code ?? -1);
		});

		if (child.stdin) {
			// hook 进程可能不读 stdin 就退出（如 `true` / 直接写文件的命令），
			// 此时 write/end 会异步触发 EPIPE。必须吞掉该流错误，否则会变成
			// Vitest 的未处理异常；结果仍以子进程 exit code 为准。
			child.stdin.on("error", () => {});
			try {
				child.stdin.write(`${JSON.stringify(payload)}\n`);
				child.stdin.end();
			} catch {
				// 同步写失败同样不影响退出码判定
			}
		}
	});
}

export function createHookChain(
	config: Settings["hooks"],
	opts: {
		session: Session;
		cwd: string;
		agentId: string;
		timeoutMs?: number;
	},
): HookChain {
	const timeoutMs = opts.timeoutMs ?? HOOK_DEFAULT_TIMEOUT_MS;

	return {
		async run(
			event: HookEvent,
			payload: Record<string, unknown>,
		): Promise<HookRunResult> {
			const entries = config?.[EVENT_KEYS[event]];
			if (entries === undefined || entries.length === 0) {
				return { blocked: false, output: "" };
			}

			// payload.agent_id 优先（worker/task 工具钩子归属各自 agent）
			const agentId =
				typeof payload.agent_id === "string" ? payload.agent_id : opts.agentId;
			const fullPayload = {
				session_id: opts.session.id,
				cwd: opts.cwd,
				agent_id: agentId,
				hook_event: event,
				...payload,
			};

			let blocked = false;
			const reasons: string[] = [];
			for (const entry of entries) {
				if (!matchesEntry(event, entry.matcher, payload)) {
					continue;
				}
				for (const hook of entry.hooks) {
					if (hook.type !== "command") {
						continue;
					}
					const startedAt = Date.now();
					const result = await runCommand(hook.command, fullPayload, {
						cwd: opts.cwd,
						event,
						timeoutMs,
					});
					await opts.session.append({
						type: "hook/fired",
						id: randomUUID(),
						ts: new Date().toISOString(),
						agentId,
						hook: event,
						command: hook.command,
						exitCode: result.exitCode,
						durationMs: Date.now() - startedAt,
					});
					// 超时属基础设施故障，fail-open；真实非零退出才阻断
					if (
						event === "pre_tool" &&
						result.exitCode !== 0 &&
						!result.timedOut
					) {
						blocked = true;
						const text = [result.stdout, result.stderr]
							.filter((s) => s.trim() !== "")
							.join("\n");
						reasons.push(
							text.trim() === ""
								? `hook command exited with code ${result.exitCode}`
								: text,
						);
					}
				}
			}
			return { blocked, output: reasons.join("\n") };
		},
	};
}
