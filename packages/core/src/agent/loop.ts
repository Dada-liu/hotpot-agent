// turn/step 循环（M1 核心）：turn = 一次用户意图的完整处理，step = 一次 streamChat + 该消息全部 tool call 的执行
// 不维护游离的内存消息数组：每个 step 前 loadSession + deriveMessages 从事件日志重建历史（不变量：模型可见 ⟺ 已记录）
// 防御语义（docs/archive/02-architecture.md 第 3、4 节）：
// - finish=max_tokens 的消息，其 tool call 参数可能被截断 → 全部记 isError 不执行
// - finish=error（provider 返回未映射的 stop reason）时工具同样不执行：全部记 isError 后 done(error) 结束 turn
// - AbortSignal 贯穿流式请求与工具执行；中断时已 append 的事件保留在日志里，产出 done(aborted)。
//   串行批里被跳过的 tool call 也补落 isError tool_result（assistant_msg 含全部 tool_call，缺一即坏会话）
//   真实适配器把 signal 传给 fetch，流式中途 abort 表现为 AbortError rejection——catch 里先判 signal，不误记 error
// - 工具 execute 的 rejection（ZodError、fs 错误等）兜底转成 isError tool_result，不向调用方抛

import { randomUUID } from "node:crypto";
import {
	type ChatRequest,
	type ContentBlock,
	type FinishReason,
	LlmError,
	type Usage,
} from "@hotpot/ai";
import { registerDefaultSections } from "../prompt/default-sections.ts";
import { buildSystemPrompt } from "../prompt/sections.ts";
import { deriveMessages } from "../session/derive.ts";
import type { SessionEvent } from "../session/events.ts";
import { loadSession } from "../session/store.ts";
import type { ToolContext, ToolOutput } from "../tools/tool.ts";
import type { AgentEvent, LoopConfig } from "./types.ts";

// registerDefaultSections 非幂等（重复调用会重复注册），模块级守卫保证只注册一次
let defaultSectionsRegistered = false;

function defaultSystemPrompt(cfg: LoopConfig): string {
	if (!defaultSectionsRegistered) {
		registerDefaultSections();
		defaultSectionsRegistered = true;
	}
	return buildSystemPrompt({
		cwd: cfg.cwd,
		os: process.platform,
		date: new Date().toISOString().slice(0, 10),
		tools: cfg.registry.declarations(),
	});
}

// 工具入参 JSON 解析；空串视为 {}
// 解析失败（如 max_tokens 截断的半截 JSON）或结果不是对象时落 {} 占位：
// 持久化的 assistant_msg 里 tool_call.input 恒为对象，下一步请求不会把字符串当 input 发给 API
// （Anthropic tool_use.input 要求 object）；原始半截参数由 max_tokens 防御写进 isError tool_result 文本
function parseToolInput(inputJson: string): unknown {
	const trimmed = inputJson.trim();
	if (trimmed === "") {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed;
		}
		return {};
	} catch {
		return {};
	}
}

interface PendingCall {
	name: string;
	inputJson: string;
}

interface ResolvedCall {
	id: string;
	name: string;
	input: unknown;
	// 未解析的原始入参文本：max_tokens 防御写 isError 文本时带上，供模型排查
	rawInput: string;
}

interface CallResult {
	call: ResolvedCall;
	output: ToolOutput;
}

// 执行单个 tool call：未知工具与 execute rejection 都兜底为 isError 结果，不向上抛。
// M4 hooks：pre_tool 在工具执行前触发（非零退出直接产 isError、跳过执行），
// post_tool 在工具执行后触发（含执行失败/未知工具）；hook 先于工具内建审批，
// 高危命令仍要过人审——hook 不替代审批。
async function executeCall(
	cfg: LoopConfig,
	call: ResolvedCall,
	ctx: ToolContext,
): Promise<ToolOutput> {
	const hookBase = {
		agent_id: ctx.agentId,
		tool_name: call.name,
		tool_input: call.input,
	};
	const pre = await cfg.hooks?.run("pre_tool", hookBase);
	if (pre?.blocked === true) {
		return {
			content: `tool "${call.name}" blocked by PreToolUse hook: ${pre.output}`,
			isError: true,
		};
	}

	const startedAt = Date.now();
	let output: ToolOutput;
	const tool = cfg.registry.get(call.name);
	if (!tool) {
		output = { content: `unknown tool: ${call.name}`, isError: true };
	} else {
		try {
			output = await tool.execute(call.input, ctx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			output = {
				content: `tool "${call.name}" failed: ${message}`,
				isError: true,
			};
		}
	}
	await cfg.hooks?.run("post_tool", {
		...hookBase,
		tool_output: output.content,
		is_error: output.isError === true,
		duration_ms: Date.now() - startedAt,
	});
	return output;
}

// 同批全部 isConcurrencySafe 才 Promise.all 并行，否则按序执行；并行结果按调用顺序返回
async function executeCalls(
	cfg: LoopConfig,
	calls: ResolvedCall[],
	ctx: ToolContext,
): Promise<CallResult[]> {
	const allSafe = calls.every(
		(call) => cfg.registry.get(call.name)?.isConcurrencySafe === true,
	);
	if (allSafe) {
		const outputs = await Promise.all(
			calls.map((call) => executeCall(cfg, call, ctx)),
		);
		return calls.map((call, i) => ({ call, output: outputs[i] }));
	}
	const results: CallResult[] = [];
	for (const call of calls) {
		if (ctx.signal.aborted) {
			// 中断后未开始的调用不再执行，但必须补 isError 结果：
			// 含全部 N 个 tool_call 的 assistant_msg 已落盘，缺 tool_result 会让下一轮请求
			// 违反「每个 tool_use 必须有 tool_result」的 API 约束（400），会话永久损坏
			results.push({
				call,
				output: {
					content: `tool "${call.name}" not executed: aborted`,
					isError: true,
				},
			});
			continue;
		}
		results.push({ call, output: await executeCall(cfg, call, ctx) });
	}
	return results;
}

function nowIso(): string {
	return new Date().toISOString();
}

// 落盘一条 tool_result 会话事件并返回对应的 AgentEvent；max_tokens / error 防御与正常执行共用
async function persistToolResult(
	cfg: LoopConfig,
	call: ResolvedCall,
	output: ToolOutput,
): Promise<AgentEvent> {
	await cfg.session.append({
		type: "tool_result",
		id: randomUUID(),
		ts: nowIso(),
		agentId: cfg.agentId,
		toolCallId: call.id,
		content: output.content,
		isError: output.isError ?? false,
	});
	return { type: "tool_result", name: call.name, output };
}

// 落盘 error 会话事件并产出 error AgentEvent，结束 turn
async function* emitError(
	cfg: LoopConfig,
	error: LlmError,
): AsyncIterable<AgentEvent> {
	await cfg.session.append({
		type: "error",
		id: randomUUID(),
		ts: nowIso(),
		agentId: cfg.agentId,
		code: error.code,
		message: error.message,
	});
	yield { type: "error", error };
}

export async function* runTurn(
	cfg: LoopConfig,
	signal: AbortSignal,
): AsyncIterable<AgentEvent> {
	const system = cfg.system ?? defaultSystemPrompt(cfg);

	while (true) {
		if (signal.aborted) {
			yield { type: "done", stopReason: "aborted" };
			return;
		}

		// step 顶部注入 next-step 消息（steer/queue）：先落盘为 user_msg 事件，
		// 随后的 loadSession + deriveMessages 会把它折进模型历史（不变量：模型可见 ⟺ 已记录）
		if (cfg.pollInbox) {
			const inbox = await cfg.pollInbox();
			for (const content of inbox) {
				await cfg.session.append({
					type: "user_msg",
					id: randomUUID(),
					ts: nowIso(),
					agentId: cfg.agentId,
					content,
				});
			}
		}

		// 每个 step 从事件日志重建完整消息历史
		const { events } = await loadSession(cfg.session.filePath);
		const req: ChatRequest = {
			model: cfg.model,
			apiKey: cfg.apiKey,
			baseUrl: cfg.baseUrl,
			system,
			messages: deriveMessages(events, cfg.agentId),
			tools: cfg.registry.declarations(),
		};

		const content: ContentBlock[] = [];
		const pending = new Map<string, PendingCall>();
		const calls: ResolvedCall[] = [];
		let usage: Usage = { input: 0, output: 0 };
		let finish: FinishReason | undefined;

		try {
			for await (const ev of cfg.adapter.streamChat(req, signal)) {
				if (signal.aborted) {
					yield { type: "done", stopReason: "aborted" };
					return;
				}
				switch (ev.type) {
					case "text_delta": {
						yield { type: "text", delta: ev.delta };
						const last = content[content.length - 1];
						if (last?.type === "text") {
							last.text += ev.delta;
						} else {
							content.push({ type: "text", text: ev.delta });
						}
						break;
					}
					case "reasoning_delta":
						// M1：推理增量不进消息历史，也不透传给 UI
						break;
					case "tool_call_start":
						pending.set(ev.id, { name: ev.name, inputJson: "" });
						break;
					case "tool_call_delta": {
						const call = pending.get(ev.id);
						if (call) {
							call.inputJson += ev.inputDelta;
						}
						break;
					}
					case "tool_call_end": {
						const call = pending.get(ev.id);
						if (!call) {
							break;
						}
						pending.delete(ev.id);
						const input = parseToolInput(call.inputJson);
						content.push({
							type: "tool_call",
							id: ev.id,
							name: call.name,
							input,
						});
						calls.push({
							id: ev.id,
							name: call.name,
							input,
							rawInput: call.inputJson,
						});
						yield { type: "tool_call", name: call.name, input };
						break;
					}
					case "usage":
						usage = ev.usage;
						break;
					case "finish":
						finish = ev.reason;
						break;
				}
			}
		} catch (err) {
			if (signal.aborted) {
				// 流式中途 abort：真实适配器把 signal 传给 fetch，表现为 AbortError rejection。
				// 这是中断不是错误——不落 error 会话事件，直接 done(aborted)
				yield { type: "done", stopReason: "aborted" };
				return;
			}
			const error =
				err instanceof LlmError
					? err
					: new LlmError(
							err instanceof Error ? err.message : String(err),
							"stream_error",
						);
			yield* emitError(cfg, error);
			return;
		}

		if (signal.aborted || finish === "aborted") {
			yield { type: "done", stopReason: "aborted" };
			return;
		}
		if (finish === undefined) {
			// 流结束但没收到 finish：与适配器的 truncated_stream 语义一致
			yield* emitError(
				cfg,
				new LlmError("stream ended without a finish event", "truncated_stream"),
			);
			return;
		}

		// assistant 消息完整接收后落盘（含 usage / model / agentId / tier；tier 默认 high）
		const assistantMsg: SessionEvent = {
			type: "assistant_msg",
			id: randomUUID(),
			ts: nowIso(),
			agentId: cfg.agentId,
			content,
			usage,
			model: cfg.model.id,
			tier: cfg.tier ?? "high",
		};
		await cfg.session.append(assistantMsg);

		// 无 tool call：turn 结束（stop 是正常出口；其余 finish 原样透传）
		if (calls.length === 0) {
			yield { type: "done", stopReason: finish };
			return;
		}

		if (finish === "max_tokens") {
			// 截断防御：参数可能不完整，全部判失败不执行；错误结果落盘后进入下一 step 让模型重试。
			// isError 文本带上原始半截参数（截到 200 字符），assistant_msg 里的 input 已由 parseToolInput 落 {} 占位
			for (const call of calls) {
				const fragment =
					call.rawInput.length > 200
						? `${call.rawInput.slice(0, 200)}…`
						: call.rawInput;
				const output: ToolOutput = {
					content: `tool "${call.name}" not executed: finish reason is max_tokens, arguments may be truncated (raw arguments: ${fragment})`,
					isError: true,
				};
				yield await persistToolResult(cfg, call, output);
			}
			continue;
		}

		if (finish === "error") {
			// provider 返回错误状态（适配器把未映射的 stop reason 归一为 error）：
			// 工具不执行，但每个 tool_call 仍要补落 isError tool_result（assistant_msg 已含全部
			// tool_call，缺一会坏会话）；与 max_tokens 不同，不在错误状态上继续，done(error) 结束 turn
			for (const call of calls) {
				const output: ToolOutput = {
					content: `tool "${call.name}" not executed: provider returned finish reason "error"`,
					isError: true,
				};
				yield await persistToolResult(cfg, call, output);
			}
			yield { type: "done", stopReason: "error" };
			return;
		}

		const ctx: ToolContext = {
			cwd: cfg.cwd,
			signal,
			approval: cfg.approval,
			agentId: cfg.agentId,
			session: cfg.session,
		};
		const results = await executeCalls(cfg, calls, ctx);
		for (const { call, output } of results) {
			yield await persistToolResult(cfg, call, output);
		}
		// 本 step 的工具结果已全部落盘，继续下一 step
	}
}
