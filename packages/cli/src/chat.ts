// 行式交互主逻辑（M1 唯一用户界面）：runChat 驱动「输入一行 → runTurn → 渲染事件」循环。
// IO 全部经 ChatInput/ChatOutput 两个最小接口注入：bin 入口给真实终端实现，测试给脚本化实现。
// 另含进程入口的组装函数 runChatCli 与 argv 解析 parseChatArgs。

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { LlmAdapter, ModelInfo } from "@hotpot/ai";
import {
	type AgentEvent,
	ApprovalChain,
	bashTool,
	createSession,
	createToolRegistry,
	editTool,
	loadSettings,
	type ModelTier,
	readTool,
	resumeSession,
	runTurn,
	type Session,
	type Settings,
	type ToolDefinition,
	type ToolRegistry,
	writeTool,
} from "@hotpot/core";
import { resolveModel } from "@hotpot/orchestrator";
import { createTerminalApproval } from "./approval-ui.ts";

// 输入抽象：readLine 返回 null 表示 EOF；interrupt 对应 Ctrl-C（中断当前回合）
export interface ChatInput {
	readLine(): Promise<string | null>;
	setInterruptHandler(cb: (() => void) | null): void;
	close(): void;
}

export interface ChatOutput {
	write(text: string): void;
}

export interface RunChatOptions {
	cwd: string;
	settings: Settings;
	home?: string;
	sessionPath?: string;
	// tier 缺省取 settings.mainAgentTier，再缺省 "high"
	tier?: ModelTier;
	// 测试注入点：缺省时按 ModelRef 解析真实适配器（orchestrator 的 resolveModel）
	llm?: { adapter: LlmAdapter; model: ModelInfo };
	input: ChatInput;
	output: ChatOutput;
	// 告警通道（如未知模型兜底）；缺省写 output
	warn?: (text: string) => void;
}

// policy=always 时给有副作用的工具包一层审批：execute 前先过 ApprovalChain，deny 直接返回 isError
// （policy=ask-on-dangerous 时只有工具内建的危险判定会发起审批，见 bashTool/writeTool）
// ApprovalRequest.kind 只有 command/write 两种，按工具副作用类型映射
function withApproval<T>(
	tool: ToolDefinition<T>,
	kind: "command" | "write",
): ToolDefinition<T> {
	return {
		...tool,
		execute: async (args, ctx) => {
			const decision = await ctx.approval.ask({
				kind,
				summary: `Run tool "${tool.name}" (approval policy: always)`,
				detail: summarizeInput(args),
			});
			if (decision === "deny") {
				return {
					content: `tool "${tool.name}" denied by approval`,
					isError: true,
				};
			}
			return tool.execute(args, ctx);
		},
	};
}

type ApprovalPolicy = "ask-on-dangerous" | "always" | "never";

function buildRegistry(policy: ApprovalPolicy): ToolRegistry {
	const registry = createToolRegistry();
	if (policy === "always") {
		registry.register(withApproval(bashTool, "command"));
		registry.register(withApproval(writeTool, "write"));
		registry.register(withApproval(editTool, "write"));
	} else {
		registry.register(bashTool);
		registry.register(writeTool);
		registry.register(editTool);
	}
	// read 无副作用（isConcurrencySafe），任何 policy 下都不需要审批
	registry.register(readTool);
	return registry;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 工具入参摘要：input 来自 runTurn 的 JSON.parse，恒为 JSON-safe；防御性 try/catch 兜底
function summarizeInput(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input) ?? "";
	} catch {
		text = String(input);
	}
	return truncate(text, 120);
}

// 渲染单个 AgentEvent。tool_call 不调 present：present 对原始 LLM 输入可能同步抛错，
// 这里只展示名称与参数摘要（已知 minor 遗留，见 Task 10 报告）
function renderEvent(event: AgentEvent, output: ChatOutput): void {
	switch (event.type) {
		case "text":
			output.write(event.delta);
			break;
		case "tool_call":
			output.write(`\n[tool] ${event.name}(${summarizeInput(event.input)})\n`);
			break;
		case "tool_result": {
			const tag = event.output.isError === true ? "[error] " : "";
			output.write(
				`[tool_result] ${tag}${truncate(event.output.content, 500)}\n`,
			);
			break;
		}
		case "done":
			// stop 是正常出口只补换行；其余 stopReason（aborted/max_tokens/error 等）按文本展示
			output.write(
				event.stopReason === "stop" ? "\n" : `\n[done: ${event.stopReason}]\n`,
			);
			break;
		case "error":
			output.write(`\n[error: ${event.error.code}] ${event.error.message}\n`);
			break;
	}
}

export async function runChat(opts: RunChatOptions): Promise<void> {
	const { input, output } = opts;
	const warn = opts.warn ?? ((text: string) => output.write(`${text}\n`));
	const settings = opts.settings;
	const tier = opts.tier ?? settings.mainAgentTier ?? "high";
	const ref = settings.models[tier];

	let adapter: LlmAdapter;
	let model: ModelInfo;
	if (opts.llm) {
		adapter = opts.llm.adapter;
		model = opts.llm.model;
	} else {
		const resolved = resolveModel(ref);
		if (resolved.warning) {
			warn(resolved.warning);
		}
		adapter = resolved.adapter;
		model = resolved.model;
	}

	// --session 恢复已有会话（后续事件追加到同一文件），否则新建
	const session: Session = opts.sessionPath
		? await resumeSession(opts.sessionPath)
		: await createSession(opts.cwd, opts.home);
	output.write(
		`会话: ${session.filePath}（tier=${tier}, model=${model.id}）\n`,
	);
	output.write("输入消息开始对话；/exit 退出，Ctrl-C 中断当前回合\n");

	const policy: ApprovalPolicy =
		settings.approval?.policy ?? "ask-on-dangerous";
	const approval = new ApprovalChain();
	// never：不注册任何 handler，ApprovalChain fail-closed 全部 deny（不打扰用户，也不放行）
	if (policy !== "never") {
		approval.use(createTerminalApproval(input, output));
	}
	const registry = buildRegistry(policy);

	// Ctrl-C：回合中 abort 当前 runTurn；空闲时不退出进程，只重印提示符
	let currentTurn: AbortController | null = null;
	input.setInterruptHandler(() => {
		if (currentTurn) {
			currentTurn.abort();
		} else {
			output.write("\n（输入 /exit 退出）\n> ");
		}
	});

	try {
		for (;;) {
			output.write("> ");
			const line = await input.readLine();
			if (line === null || line.trim() === "/exit") {
				break;
			}
			const content = line.trim();
			if (content === "") {
				continue;
			}
			await session.append({
				type: "user_msg",
				id: randomUUID(),
				ts: new Date().toISOString(),
				agentId: "main",
				content,
			});
			const ac = new AbortController();
			currentTurn = ac;
			try {
				for await (const event of runTurn(
					{
						session,
						agentId: "main",
						adapter,
						model,
						apiKey: ref.apiKey,
						baseUrl: ref.baseUrl,
						registry,
						approval,
						cwd: opts.cwd,
					},
					ac.signal,
				)) {
					renderEvent(event, output);
				}
			} catch (err) {
				// runTurn 自身兜底 LLM/工具错误；这里防的是会话文件读失败等意外，回合出错不退出 REPL
				output.write(
					`\n[error] ${err instanceof Error ? err.message : String(err)}\n`,
				);
			} finally {
				currentTurn = null;
			}
		}
	} finally {
		input.setInterruptHandler(null);
	}
	output.write("再见\n");
}

// 真实终端输入：readline 逐行 + SIGINT 转发。
// TTY raw 模式下 ^C 只触发 readline 的 SIGINT 事件、不产生进程信号；管道模式相反——两个都挂，abort 幂等
export function createTerminalChatInput(): ChatInput {
	const rl = createInterface({ input: process.stdin });
	const queue: string[] = [];
	let waiting: ((line: string | null) => void) | null = null;
	let closed = false;
	let interruptHandler: (() => void) | null = null;

	const onSigint = () => {
		interruptHandler?.();
	};

	rl.on("line", (line) => {
		if (waiting) {
			const resolve = waiting;
			waiting = null;
			resolve(line);
		} else {
			// 回合进行中用户提前键入的行排队，回合结束后按序消费
			queue.push(line);
		}
	});
	rl.on("close", () => {
		closed = true;
		if (waiting) {
			const resolve = waiting;
			waiting = null;
			resolve(null);
		}
	});
	rl.on("SIGINT", onSigint);

	return {
		readLine(): Promise<string | null> {
			const queued = queue.shift();
			if (queued !== undefined) {
				return Promise.resolve(queued);
			}
			if (closed) {
				return Promise.resolve(null);
			}
			return new Promise<string | null>((resolve) => {
				waiting = resolve;
			});
		},
		setInterruptHandler(cb: (() => void) | null): void {
			interruptHandler = cb;
			if (cb) {
				process.on("SIGINT", onSigint);
			} else {
				process.removeListener("SIGINT", onSigint);
			}
		},
		close(): void {
			process.removeListener("SIGINT", onSigint);
			rl.close();
		},
	};
}

const USAGE = "用法: hotpot chat [--session <path>] [--tier high|medium|low]";

export interface ChatCliArgs {
	sessionPath?: string;
	tier?: ModelTier;
}

export function parseChatArgs(argv: string[]): ChatCliArgs {
	const [command, ...rest] = argv;
	if (command !== "chat") {
		throw new Error(`未知命令: ${command ?? "(空)"}\n${USAGE}`);
	}
	const args: ChatCliArgs = {};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		if (flag === "--session") {
			const value = rest[i + 1];
			if (value === undefined) {
				throw new Error(`--session 缺少路径参数\n${USAGE}`);
			}
			args.sessionPath = value;
			i += 1;
		} else if (flag === "--tier") {
			const value = rest[i + 1];
			if (value !== "high" && value !== "medium" && value !== "low") {
				throw new Error(`--tier 只接受 high|medium|low\n${USAGE}`);
			}
			args.tier = value;
			i += 1;
		} else {
			throw new Error(`未知参数: ${flag}\n${USAGE}`);
		}
	}
	return args;
}

// bin 入口的组装：argv → loadSettings → 终端 IO → runChat；返回进程退出码
export async function runChatCli(argv: string[]): Promise<number> {
	let args: ChatCliArgs;
	try {
		args = parseChatArgs(argv);
	} catch (err) {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
	let settings: Settings;
	try {
		settings = loadSettings({ cwd: process.cwd() });
	} catch (err) {
		process.stderr.write(
			`加载配置失败：${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
	const input = createTerminalChatInput();
	try {
		await runChat({
			cwd: process.cwd(),
			settings,
			sessionPath: args.sessionPath,
			tier: args.tier,
			input,
			output: process.stdout,
			warn: (text) => process.stderr.write(`${text}\n`),
		});
		return 0;
	} catch (err) {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	} finally {
		input.close();
	}
}
