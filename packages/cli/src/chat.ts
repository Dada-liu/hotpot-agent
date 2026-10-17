// 行式交互主逻辑（M2 编排入口）：runChat 驱动「输入一行 → runMainTurn → 渲染事件」循环。
// 主循环不再碰 runTurn/工具注册表：main agent 只有 delegate/spawn_workers 元工具，
// 用户消息经 orchestrator 的 runMainTurn 走 delegate → worker 内联执行 → 摘要回传；
// 本文件只负责终端 I/O、审批装配（含审计落盘）、事件渲染与 next-turn 补发。
// IO 全部经 ChatInput/ChatOutput 两个最小接口注入：bin 入口给真实终端实现，测试给脚本化实现。
// 另含进程入口的组装函数 runChatCli 与 argv 解析 parseChatArgs。

import { createInterface } from "node:readline";
import type { LlmAdapter, ModelInfo } from "@hotpot/ai";
import {
	type AgentEvent,
	ApprovalChain,
	createAuditedApprovalChain,
	createSession,
	loadSettings,
	type ModelTier,
	resumeSession,
	type Session,
	type Settings,
	type ToolDefinition,
} from "@hotpot/core";
import {
	createInbox,
	createRuntime,
	type OrchestrationEvent,
	type OrchestrationRuntime,
	resolveModel,
	runMainTurn,
	type WorkerToolDecorator,
} from "@hotpot/orchestrator";
import { createTerminalApproval } from "./approval-ui.ts";
import { createTerminalPlanApproval } from "./plan-approval.ts";

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

type ApprovalPolicy = "ask-on-dangerous" | "always" | "never";

// policy=always 时给有副作用的工具包一层审批：execute 前先过 ApprovalChain，deny 直接返回 isError。
// M2 下这套包装经 runtime.decorateWorkerTool 注入，套在 worker/task 注册表的四件赛上
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

// 渲染 core 的 AgentEvent。tool_call 不调 present：present 对原始 LLM 输入可能同步抛错，
// 这里只展示名称与参数摘要（已知 minor 遗留，见 Task 10 报告）
function renderAgentEvent(event: AgentEvent, output: ChatOutput): void {
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

// 渲染单个 OrchestrationEvent：core AgentEvent 之外补充编排语义事件 ——
// agent_spawn 标记子 agent 诞生（task 截断 80 字符），plan 记录计划审批流的状态迁移
// （drafted 附带 plan 全文，便于用户就地审阅；批准/拒绝/修订耗尽只打状态行）
function renderEvent(event: OrchestrationEvent, output: ChatOutput): void {
	if (event.type === "agent_spawn") {
		output.write(
			`\n[spawn] ${event.agentId} (tier=${event.tier}): ${truncate(event.task, 80)}\n`,
		);
		return;
	}
	if (event.type === "plan") {
		if (event.phase === "drafted" && event.plan !== undefined) {
			output.write(`\n[plan] drafted:\n${event.plan}\n`);
		} else {
			output.write(`\n[plan] ${event.phase}\n`);
		}
		return;
	}
	renderAgentEvent(event, output);
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

	// 审批装配：终端 handler 挂内层链，整体经 createAuditedApprovalChain 落盘 asked/decided。
	// 审计包装的 agentId 在装配期固定为 "main"：ApprovalChain.ask 不带 agentId，
	// worker 发起的 command/write 询问也记在同一 id 下（core 包装层的既有契约）。
	// never：不注册任何 handler，ApprovalChain fail-closed 全部 deny（不打扰用户，也不放行）
	const policy: ApprovalPolicy =
		settings.approval?.policy ?? "ask-on-dangerous";
	const baseApproval = new ApprovalChain();
	if (policy !== "never") {
		baseApproval.use(createTerminalApproval(input, output));
	}
	const approval = createAuditedApprovalChain(baseApproval, {
		session,
		agentId: "main",
	});

	// policy=always：worker/task 的 bash/write/edit 包一层预审批。
	// read 无副作用（isConcurrencySafe），与 M1 一致任何 policy 下都不包、不询问。
	// 下层注册表由编排层内部装配，包装只能经 runtime.decorateWorkerTool 闭包带进去
	const decorateWorkerTool: WorkerToolDecorator | undefined =
		policy === "always"
			? (tool) =>
					tool.name === "read"
						? tool
						: withApproval(tool, tool.name === "bash" ? "command" : "write")
			: undefined;

	const baseRuntime = createRuntime({
		session,
		cwd: opts.cwd,
		approval,
		models: settings.models,
		maxParallelTasks: settings.maxParallelTasks,
		planMaxRevisions: settings.planMaxRevisions,
		decorateWorkerTool,
	});
	// 测试注入点：opts.llm 覆盖 runtime 的档位解析（main/worker 共用同一录制适配器），
	// 与 orchestrator 测试 makeRuntime 的展开覆盖同法。
	// agent_spawn 已由 runMainTurn 事件流直产（M3），renderEvent 的 agent_spawn
	// 分支直接渲染 [spawn] 行，无需再在 spawn 调用点同步打印
	const runtime: OrchestrationRuntime = {
		...baseRuntime,
		...(opts.llm
			? {
					resolveModel: (_t: ModelTier) => ({
						adapter,
						model,
						apiKey: ref.apiKey,
						baseUrl: ref.baseUrl,
					}),
				}
			: {}),
	};

	// steer/queue 双队列：turn 结束后消费 next-turn（followup 补发为新用户消息）；
	// turn 内注入走 next-step —— runMainTurn 经 pollInbox 在每个 step 顶部拉取
	const inbox = createInbox(session, "main", {
		onCancel: () => currentTurn?.abort(),
	});
	const onPlanApproval = createTerminalPlanApproval(input, output);

	// Ctrl-C：回合中 abort 当前 runMainTurn（并触发 inbox.cancel 同一路径）；空闲时不退出进程，只重印提示符
	let currentTurn: AbortController | null = null;
	input.setInterruptHandler(() => {
		if (currentTurn) {
			currentTurn.abort();
			inbox.cancel();
		} else {
			output.write("\n（输入 /exit 退出）\n> ");
		}
	});

	// 单回合：user_msg 落盘由 runMainTurn 以 main 身份负责，这里只迭代事件流并渲染
	const runOneTurn = async (content: string): Promise<void> => {
		const ac = new AbortController();
		currentTurn = ac;
		try {
			for await (const event of runMainTurn({
				runtime,
				userMessage: content,
				signal: ac.signal,
				mainTier: tier,
				onPlanApproval,
				inbox,
			})) {
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
	};

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
			await runOneTurn(content);
			// turn 结束后 drain next-turn 队列（followup），按序补发为新的用户消息
			let followups = await inbox.drainNextTurn();
			while (followups.length > 0) {
				for (const followup of followups) {
					await runOneTurn(followup.content);
				}
				followups = await inbox.drainNextTurn();
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
