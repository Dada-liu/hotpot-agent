import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type FinishReason,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
} from "@hotpot/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runTurn } from "../src/agent/loop.ts";
import type { AgentEvent, LoopConfig } from "../src/agent/types.ts";
import { ApprovalChain } from "../src/approval/chain.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { createSession, loadSession } from "../src/session/store.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext, ToolDefinition } from "../src/tools/tool.ts";

// 每个用例一个临时 home，隔离会话文件
let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-loop-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const MODEL: ModelInfo = {
	id: "test-model",
	provider: "test",
	api: "anthropic-messages",
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 1, output: 1 },
};

const TS = "2026-10-10T08:00:00.000Z";

// 组装 LoopConfig：真实 session（临时 home）+ scriptedAdapter + 空注册表；工具由各用例自行注册
async function makeConfig(script: StreamEvent[][]): Promise<LoopConfig> {
	const session = await createSession("/tmp/project", home);
	await session.append({
		type: "user_msg",
		id: "u1",
		ts: TS,
		agentId: "main",
		content: "开始",
	});
	return {
		session,
		agentId: "main",
		adapter: scriptedAdapter(script),
		model: MODEL,
		apiKey: "test-key",
		registry: createToolRegistry(),
		approval: new ApprovalChain(),
		cwd: "/tmp/project",
		system: "test system prompt",
	};
}

async function collectTurn(
	cfg: LoopConfig,
	signal: AbortSignal,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of runTurn(cfg, signal)) {
		events.push(event);
	}
	return events;
}

// 一轮「调用单个工具」的脚本：tool_call_start/delta/end + usage + finish
function toolCallRound(
	name: string,
	id: string,
	inputJson: string,
	finish: FinishReason = "tool_calls",
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 5, output: 3 } },
		{ type: "finish", reason: finish },
	];
}

// 第二轮脚本：纯文本后 stop
const STOP_ROUND: StreamEvent[] = [
	{ type: "text_delta", delta: "完成了" },
	{ type: "usage", usage: { input: 8, output: 2 } },
	{ type: "finish", reason: "stop" },
];

interface ToolSpy {
	args: unknown;
	ctx: ToolContext;
}

function makeEchoTool(spy: ToolSpy[]): ToolDefinition<{ text: string }> {
	return {
		name: "echo",
		description: "Echo the given text back",
		parameters: z.object({ text: z.string() }),
		isConcurrencySafe: true,
		execute: async (args, ctx) => {
			spy.push({ args, ctx });
			return { content: `echo: ${args.text}` };
		},
	};
}

// 从事件流里捞出唯一的 tool_result，缺失时直接失败
function onlyToolResult(
	events: AgentEvent[],
): AgentEvent & { type: "tool_result" } {
	const found = events.filter((e) => e.type === "tool_result");
	expect(found).toHaveLength(1);
	const result = found[0];
	if (result?.type !== "tool_result") {
		throw new Error("tool_result event missing");
	}
	return result;
}

describe("runTurn", () => {
	it("脚本 A：纯文本回复 finish=stop，产出 text 与 done，落盘 assistant_msg", async () => {
		const cfg = await makeConfig([
			[
				{ type: "text_delta", delta: "Hello" },
				{ type: "text_delta", delta: " world" },
				{ type: "usage", usage: { input: 10, output: 2 } },
				{ type: "finish", reason: "stop" },
			],
		]);

		const events = await collectTurn(cfg, new AbortController().signal);
		expect(events).toEqual([
			{ type: "text", delta: "Hello" },
			{ type: "text", delta: " world" },
			{ type: "done", stopReason: "stop" },
		]);

		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		expect(fileEvents.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
		]);
		const assistant = fileEvents[2];
		if (assistant?.type !== "assistant_msg") {
			throw new Error("assistant_msg missing");
		}
		expect(assistant.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(assistant.usage).toEqual({ input: 10, output: 2 });
		expect(assistant.model).toBe("test-model");
		expect(assistant.agentId).toBe("main");
	});

	it("脚本 B：tool_call 执行后进入第二轮，AgentEvent 序与落盘事件齐全", async () => {
		const spy: ToolSpy[] = [];
		const cfg = await makeConfig([
			[
				{ type: "text_delta", delta: "我先调用工具" },
				...toolCallRound("echo", "tc-1", '{"text":"hi"}'),
			],
			STOP_ROUND,
		]);
		cfg.registry.register(makeEchoTool(spy));
		const ac = new AbortController();

		const events = await collectTurn(cfg, ac.signal);
		expect(events).toEqual([
			{ type: "text", delta: "我先调用工具" },
			{ type: "tool_call", name: "echo", input: { text: "hi" } },
			{ type: "tool_result", name: "echo", output: { content: "echo: hi" } },
			{ type: "text", delta: "完成了" },
			{ type: "done", stopReason: "stop" },
		]);

		// ToolContext 由 runTurn 组装：cwd / signal / approval 全部来自 cfg 与入参
		expect(spy).toHaveLength(1);
		expect(spy[0]?.args).toEqual({ text: "hi" });
		expect(spy[0]?.ctx.cwd).toBe("/tmp/project");
		expect(spy[0]?.ctx.signal).toBe(ac.signal);
		expect(spy[0]?.ctx.approval).toBe(cfg.approval);

		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		expect(fileEvents.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"tool_result",
			"assistant_msg",
		]);
		const first = fileEvents[2];
		if (first?.type !== "assistant_msg") {
			throw new Error("first assistant_msg missing");
		}
		expect(first.content).toEqual([
			{ type: "text", text: "我先调用工具" },
			{ type: "tool_call", id: "tc-1", name: "echo", input: { text: "hi" } },
		]);
		const toolResult = fileEvents[3];
		if (toolResult?.type !== "tool_result") {
			throw new Error("tool_result missing");
		}
		expect(toolResult.toolCallId).toBe("tc-1");
		expect(toolResult.agentId).toBe("main");
		expect(toolResult.content).toBe("echo: hi");
		expect(toolResult.isError).toBe(false);
	});

	it("脚本 C：finish=max_tokens 时 tool call 不执行，全部记 isError（参数可能被截断）", async () => {
		const spy: ToolSpy[] = [];
		const cfg = await makeConfig([
			toolCallRound("echo", "tc-1", '{"text":"hi', "max_tokens"),
			STOP_ROUND,
		]);
		cfg.registry.register(makeEchoTool(spy));

		const events = await collectTurn(cfg, new AbortController().signal);
		expect(spy).toHaveLength(0); // 截断防御：工具未执行

		const result = onlyToolResult(events);
		expect(result.name).toBe("echo");
		expect(result.output.isError).toBe(true);
		expect(result.output.content).toMatch(/truncated/);
		// 错误结果落盘后进入第二轮，正常结束
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		const tr = fileEvents.find((e) => e.type === "tool_result");
		if (tr?.type !== "tool_result") {
			throw new Error("tool_result missing in session file");
		}
		expect(tr.isError).toBe(true);
		expect(tr.content).toMatch(/truncated/);
	});

	it("脚本 D：第二轮前 abort，产出 done(aborted) 且中断前事件已落盘", async () => {
		const spy: ToolSpy[] = [];
		const cfg = await makeConfig([
			toolCallRound("echo", "tc-1", '{"text":"hi"}'),
			STOP_ROUND,
		]);
		cfg.registry.register(makeEchoTool(spy));
		const ac = new AbortController();

		const events: AgentEvent[] = [];
		for await (const event of runTurn(cfg, ac.signal)) {
			events.push(event);
			if (event.type === "tool_result") {
				ac.abort(); // 第一轮工具结果产出后、第二轮开始前中断
			}
		}

		expect(events.filter((e) => e.type === "done")).toEqual([
			{ type: "done", stopReason: "aborted" },
		]);
		expect(events.some((e) => e.type === "text" && e.delta === "完成了")).toBe(
			false,
		);
		// 中断前的 assistant_msg 与 tool_result 已落盘；第二轮 assistant_msg 不存在
		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		expect(fileEvents.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"tool_result",
		]);
	});

	it("串行批 abort：被跳过的 tool call 也补落 isError tool_result，会话日志不残缺", async () => {
		// 三个非 concurrency-safe 工具 → 串行路径；第一个执行时触发 abort，
		// s2/s3 不再执行，但必须各自落一条 isError tool_result——
		// 否则下一轮请求里 assistant_msg 的 tool_use 没有对应 tool_result，API 直接 400
		const executed: string[] = [];
		const ac = new AbortController();
		const makeTool = (name: string, abortOnRun = false) => ({
			name,
			description: name,
			parameters: z.object({}),
			isConcurrencySafe: false,
			execute: async () => {
				executed.push(name);
				if (abortOnRun) {
					ac.abort();
				}
				return { content: name };
			},
		});
		const round: StreamEvent[] = [
			{ type: "tool_call_start", id: "tc-1", name: "s1" },
			{ type: "tool_call_delta", id: "tc-1", inputDelta: "{}" },
			{ type: "tool_call_end", id: "tc-1" },
			{ type: "tool_call_start", id: "tc-2", name: "s2" },
			{ type: "tool_call_delta", id: "tc-2", inputDelta: "{}" },
			{ type: "tool_call_end", id: "tc-2" },
			{ type: "tool_call_start", id: "tc-3", name: "s3" },
			{ type: "tool_call_delta", id: "tc-3", inputDelta: "{}" },
			{ type: "tool_call_end", id: "tc-3" },
			{ type: "usage", usage: { input: 5, output: 3 } },
			{ type: "finish", reason: "tool_calls" },
		];
		const cfg = await makeConfig([round]);
		cfg.registry.register(makeTool("s1", true));
		cfg.registry.register(makeTool("s2"));
		cfg.registry.register(makeTool("s3"));

		const events = await collectTurn(cfg, ac.signal);
		expect(executed).toEqual(["s1"]); // s2/s3 未执行

		const results = events.filter(
			(e): e is AgentEvent & { type: "tool_result" } =>
				e.type === "tool_result",
		);
		expect(results).toHaveLength(3);
		expect(results[1]?.output.isError).toBe(true);
		expect(results[1]?.output.content).toMatch(/aborted/);
		expect(results[2]?.output.isError).toBe(true);
		expect(results[2]?.output.content).toMatch(/aborted/);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "aborted" });

		// 3 个 tool_result 全部落盘且按调用顺序关联 toolCallId
		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		expect(fileEvents.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"tool_result",
			"tool_result",
			"tool_result",
		]);
		const persisted = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "tool_result" }> =>
				e.type === "tool_result",
		);
		expect(persisted.map((e) => e.toolCallId)).toEqual([
			"tc-1",
			"tc-2",
			"tc-3",
		]);
		expect(persisted[1]?.isError).toBe(true);
		expect(persisted[1]?.content).toMatch(/aborted/);
		expect(persisted[2]?.isError).toBe(true);
		expect(persisted[2]?.content).toMatch(/aborted/);
	});

	it("finish=error 且有 tool call：工具不执行，补落 isError tool_result 后 done(error)", async () => {
		// provider 返回未映射的 stop reason 时适配器归一为 finish=error（见
		// packages/ai/src/api/* 的 mapStopReason/mapFinishReason）；
		// 错误状态下的 tool call 不能照常执行，但 tool_result 仍要补齐——
		// 否则 assistant_msg 的 tool_use 没有对应 tool_result，会话损坏
		const spy: ToolSpy[] = [];
		const cfg = await makeConfig([
			toolCallRound("echo", "tc-1", '{"text":"hi"}', "error"),
		]);
		cfg.registry.register(makeEchoTool(spy));

		const events = await collectTurn(cfg, new AbortController().signal);
		expect(spy).toHaveLength(0); // finish=error：工具未执行

		const result = onlyToolResult(events);
		expect(result.name).toBe("echo");
		expect(result.output.isError).toBe(true);
		expect(result.output.content).toMatch(/error/);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "error" });

		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		expect(fileEvents.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"tool_result",
		]);
		const tr = fileEvents.find((e) => e.type === "tool_result");
		if (tr?.type !== "tool_result") {
			throw new Error("tool_result missing in session file");
		}
		expect(tr.toolCallId).toBe("tc-1");
		expect(tr.isError).toBe(true);
		expect(tr.content).toMatch(/error/);
	});

	it("execute rejection 兜底：schema 校验失败（ZodError）转成 isError tool_result，不向上抛", async () => {
		const spy: ToolSpy[] = [];
		const cfg = await makeConfig([
			toolCallRound("echo", "tc-1", '{"text":123}'),
			STOP_ROUND,
		]);
		cfg.registry.register(makeEchoTool(spy));

		const events = await collectTurn(cfg, new AbortController().signal);
		expect(spy).toHaveLength(0); // schema.parse 拦截，工具体未执行

		const result = onlyToolResult(events);
		expect(result.output.isError).toBe(true);
		expect(result.output.content).toMatch(/failed/);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	it("execute rejection 兜底：工具内部抛错（如 fs EISDIR）转成 isError tool_result", async () => {
		const cfg = await makeConfig([
			toolCallRound("boom", "tc-1", "{}"),
			STOP_ROUND,
		]);
		cfg.registry.register({
			name: "boom",
			description: "Always throws",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("EISDIR: illegal operation on a directory");
			},
		});

		const events = await collectTurn(cfg, new AbortController().signal);
		const result = onlyToolResult(events);
		expect(result.output.isError).toBe(true);
		expect(result.output.content).toMatch(/EISDIR/);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	it("未知工具名产出 isError tool_result，不 throw", async () => {
		const cfg = await makeConfig([
			toolCallRound("nosuch", "tc-1", "{}"),
			STOP_ROUND,
		]);

		const events = await collectTurn(cfg, new AbortController().signal);
		const result = onlyToolResult(events);
		expect(result.name).toBe("nosuch");
		expect(result.output.isError).toBe(true);
		expect(result.output.content).toMatch(/unknown tool/);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	it("同批全部 isConcurrencySafe 时并行执行（屏障：两个 execute 都进入后才放行）", async () => {
		let entered = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		// 串行实现下第一个 execute 会永远等在屏障上，测试因超时失败
		const makeBarrierTool = (name: string) => ({
			name,
			description: name,
			parameters: z.object({}),
			isConcurrencySafe: true,
			execute: async () => {
				entered += 1;
				if (entered === 2) {
					release();
				}
				await barrier;
				return { content: name };
			},
		});
		const round: StreamEvent[] = [
			{ type: "tool_call_start", id: "tc-1", name: "pa" },
			{ type: "tool_call_delta", id: "tc-1", inputDelta: "{}" },
			{ type: "tool_call_end", id: "tc-1" },
			{ type: "tool_call_start", id: "tc-2", name: "pb" },
			{ type: "tool_call_delta", id: "tc-2", inputDelta: "{}" },
			{ type: "tool_call_end", id: "tc-2" },
			{ type: "finish", reason: "tool_calls" },
		];
		const cfg = await makeConfig([round, STOP_ROUND]);
		cfg.registry.register(makeBarrierTool("pa"));
		cfg.registry.register(makeBarrierTool("pb"));

		const events = await collectTurn(cfg, new AbortController().signal);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results).toHaveLength(2);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	it("同批含非 concurrency-safe 工具时按序执行", async () => {
		let aFinished = false;
		let bStarted = false;
		const toolA = {
			name: "sa",
			description: "a",
			parameters: z.object({}),
			isConcurrencySafe: false,
			execute: async () => {
				expect(bStarted).toBe(false); // 并行时 b 会先开始
				aFinished = true;
				return { content: "a" };
			},
		};
		const toolB = {
			name: "sb",
			description: "b",
			parameters: z.object({}),
			isConcurrencySafe: true,
			execute: async () => {
				bStarted = true;
				expect(aFinished).toBe(true); // 串行时 a 必然已完成
				return { content: "b" };
			},
		};
		const round: StreamEvent[] = [
			{ type: "tool_call_start", id: "tc-1", name: "sa" },
			{ type: "tool_call_delta", id: "tc-1", inputDelta: "{}" },
			{ type: "tool_call_end", id: "tc-1" },
			{ type: "tool_call_start", id: "tc-2", name: "sb" },
			{ type: "tool_call_delta", id: "tc-2", inputDelta: "{}" },
			{ type: "tool_call_end", id: "tc-2" },
			{ type: "finish", reason: "tool_calls" },
		];
		const cfg = await makeConfig([round, STOP_ROUND]);
		cfg.registry.register(toolA);
		cfg.registry.register(toolB);

		const events = await collectTurn(cfg, new AbortController().signal);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results).toHaveLength(2);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	it("system 缺省时用默认 section 注册表组装（冒烟）", async () => {
		const cfg = await makeConfig([
			[
				{ type: "text_delta", delta: "hi" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const noSystem: LoopConfig = { ...cfg, system: undefined };
		const events = await collectTurn(noSystem, new AbortController().signal);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	it("流式中途 abort：适配器 rejection（AbortError）产出 done(aborted)，不落 error 事件", async () => {
		const cfg = await makeConfig([]); // 脚本不消费：本例用自定义适配器
		// 模拟真实适配器：signal 传入 fetch，abort 使等待中的流 rejection（DOMException AbortError）
		cfg.adapter = {
			api: "abort-fake",
			streamChat(
				_req: ChatRequest,
				signal: AbortSignal,
			): AsyncIterable<StreamEvent> {
				return (async function* (): AsyncGenerator<StreamEvent> {
					yield { type: "text_delta", delta: "半截回复" };
					await new Promise<never>((_resolve, reject) => {
						// abort 可能先于监听注册：与 fetch 一致，已 aborted 时立即 reject
						if (signal.aborted) {
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							);
							return;
						}
						signal.addEventListener("abort", () =>
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							),
						);
					});
				})();
			},
		};
		const ac = new AbortController();

		const events: AgentEvent[] = [];
		for await (const event of runTurn(cfg, ac.signal)) {
			events.push(event);
			if (event.type === "text") {
				ac.abort(); // 流式中途中断
			}
		}

		expect(events).toEqual([
			{ type: "text", delta: "半截回复" },
			{ type: "done", stopReason: "aborted" },
		]);
		// 不落 error 会话事件，也不落半截 assistant_msg
		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		expect(fileEvents.map((e) => e.type)).toEqual(["meta", "user_msg"]);
	});

	it("max_tokens 截断的 tool_call input 以 {} 落盘，下一轮请求携带对象而非字符串", async () => {
		const spy: ToolSpy[] = [];
		const requests: ChatRequest[] = [];
		const cfg = await makeConfig([
			toolCallRound("echo", "tc-1", '{"text":"hi', "max_tokens"),
			STOP_ROUND,
		]);
		cfg.registry.register(makeEchoTool(spy));
		// 包裹 scriptedAdapter，记录每轮实际发出的 ChatRequest
		const inner = cfg.adapter;
		cfg.adapter = {
			api: inner.api,
			streamChat(
				req: ChatRequest,
				signal: AbortSignal,
			): AsyncIterable<StreamEvent> {
				requests.push(req);
				return inner.streamChat(req, signal);
			},
		};

		const events = await collectTurn(cfg, new AbortController().signal);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		// 落盘的 assistant_msg 里 tool_call.input 是对象：半截 JSON 不以字符串形式存
		const { events: fileEvents } = await loadSession(cfg.session.filePath);
		const assistant = fileEvents.find((e) => e.type === "assistant_msg");
		if (assistant?.type !== "assistant_msg") {
			throw new Error("assistant_msg missing");
		}
		const toolCallBlock = assistant.content.find((b) => b.type === "tool_call");
		if (toolCallBlock?.type !== "tool_call") {
			throw new Error("tool_call block missing");
		}
		expect(toolCallBlock.input).toEqual({});

		// 第二轮请求里 assistant 消息的 tool_call.input 同样是对象（Anthropic 要求 object）
		expect(requests).toHaveLength(2);
		const secondAssistant = requests[1]?.messages.find(
			(m) => m.role === "assistant",
		);
		const sentBlock = secondAssistant?.content.find(
			(b) => b.type === "tool_call",
		);
		if (sentBlock?.type !== "tool_call") {
			throw new Error("tool_call block missing in round 2 request");
		}
		expect(sentBlock.input).toEqual({});

		// 原始半截参数保留在 isError tool_result 文本里，供模型排查
		const result = onlyToolResult(events);
		expect(result.output.isError).toBe(true);
		expect(result.output.content).toContain('{"text":"hi');
	});
});
