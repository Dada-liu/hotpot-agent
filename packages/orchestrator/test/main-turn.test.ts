// runMainTurn 测试：delegate 元工具的 trivial/simple 流、重复调用守卫、worker 档位与 token 开销断言。
// scriptedAdapter 按全局 streamChat 调用顺序回放：
// 调用 1 = main 的 delegate 步，调用 2..N = worker turn 的各步（工具步 + 摘要步），
// 最后一调用 = main 收尾。所有档位共用一个录制适配器，按调用序对齐脚本。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LlmAdapter,
	type StreamEvent,
	scriptedAdapter,
	type Usage,
} from "@hotpot/ai";
import {
	ApprovalChain,
	createSession,
	loadSession,
	type ModelTier,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMainTurn } from "../src/main-turn.ts";
import { createRuntime, type OrchestrationRuntime } from "../src/runtime.ts";
import type { OrchestrationEvent } from "../src/types.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-main-turn-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-main-turn-proj-"));
	await writeFile(join(proj, "note.txt"), "hello hotpot\n", "utf8");
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

// 三档指向不同模型，worker 走 low 档便于断言 model id 与适配器选择
const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

// 组装运行时：真实 createRuntime 保留 spawn 落盘语义，resolveModel 的适配器换成
// scriptedAdapter 的录制包装（捕获每次请求的 usage，供 token 断言）
async function makeRuntime(
	script: StreamEvent[][],
	approval: ApprovalChain,
): Promise<{ runtime: OrchestrationRuntime; usages: Usage[] }> {
	const session = await createSession(proj, home);
	const base = createRuntime({ session, cwd: proj, approval, models: MODELS });
	const inner = scriptedAdapter(script);
	const usages: Usage[] = [];
	const adapter: LlmAdapter = {
		api: inner.api,
		streamChat(req, signal) {
			return (async function* (): AsyncGenerator<StreamEvent> {
				for await (const ev of inner.streamChat(req, signal)) {
					if (ev.type === "usage") usages.push(ev.usage);
					yield ev;
				}
			})();
		},
	};
	const runtime: OrchestrationRuntime = {
		...base,
		resolveModel(tier: ModelTier) {
			return { ...base.resolveModel(tier), adapter };
		},
	};
	return { runtime, usages };
}

async function collect(
	iter: AsyncIterable<OrchestrationEvent>,
): Promise<OrchestrationEvent[]> {
	const events: OrchestrationEvent[] = [];
	for await (const ev of iter) events.push(ev);
	return events;
}

// 一轮「调用单个工具」的脚本：tool_call_start/delta/end + usage + finish
function toolCallRound(
	name: string,
	id: string,
	inputJson: string,
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 100, output: 20 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

// 纯文本收尾轮
function textRound(delta: string, usage: Usage): StreamEvent[] {
	return [
		{ type: "text_delta", delta },
		{ type: "usage", usage },
		{ type: "finish", reason: "stop" },
	];
}

function delegateRound(inputJson: string): StreamEvent[] {
	return toolCallRound("delegate", "m-tc-1", inputJson);
}

function sumTokens(list: Usage[]): number {
	return list.reduce((acc, u) => acc + u.input + u.output, 0);
}

// 全程无审批：ApprovalChain 未被询问 + 会话日志无 approval/* 事件
function expectNoApproval(
	approvalAsks: number,
	fileEvents: SessionEvent[],
): void {
	expect(approvalAsks).toBe(0);
	expect(fileEvents.filter((e) => e.type.startsWith("approval/"))).toHaveLength(
		0,
	);
}

describe("runMainTurn", () => {
	it("trivial：main 直接文本回答 finish=stop，无 agent_spawn、无审批事件", async () => {
		let approvalAsks = 0;
		const approval = new ApprovalChain();
		approval.use(() => {
			approvalAsks += 1;
			return Promise.resolve("next");
		});
		const { runtime } = await makeRuntime(
			[textRound("答案是 42。", { input: 10, output: 5 })],
			approval,
		);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "1+1 等于几",
				signal: new AbortController().signal,
				mainTier: "high",
			}),
		);

		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
		const text = events
			.filter((e) => e.type === "text")
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("答案是 42");

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(fileEvents.some((e) => e.type === "agent_spawn")).toBe(false);
		expectNoApproval(approvalAsks, fileEvents);
		// user_msg 由 runMainTurn 以 main 身份落盘
		const userMsg = fileEvents.find((e) => e.type === "user_msg");
		expect(userMsg).toMatchObject({ agentId: "main", content: "1+1 等于几" });
	});

	it("trivial 难度：delegate 返回「直接回答用户」提示，不落 agent_spawn", async () => {
		const approval = new ApprovalChain();
		const { runtime } = await makeRuntime(
			[
				delegateRound(
					'{"difficulty":"trivial","modelTier":"high","task":"1+1 等于几"}',
				),
				textRound("答案是 42。", { input: 10, output: 5 }),
			],
			approval,
		);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "1+1 等于几",
				signal: new AbortController().signal,
				mainTier: "high",
			}),
		);

		const result = events.find(
			(e) => e.type === "tool_result" && e.name === "delegate",
		);
		if (result?.type !== "tool_result") {
			throw new Error("delegate tool_result missing");
		}
		expect(result.output.isError ?? false).toBe(false);
		expect(result.output.content).toContain("直接回答用户");
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(fileEvents.some((e) => e.type === "agent_spawn")).toBe(false);
	});

	it("simple：delegate 内联跑 worker 全程无审批，worker 档位/模型正确，token 开销 < 20% worker 成本", async () => {
		let approvalAsks = 0;
		const approval = new ApprovalChain();
		approval.use(() => {
			approvalAsks += 1;
			return Promise.resolve("next");
		});
		// 全局调用序：1=main delegate，2=worker 读文件（isConcurrencySafe 的 read），
		// 3=worker 文本摘要收尾，4=main 文本收尾
		const { runtime, usages } = await makeRuntime(
			[
				delegateRound(
					'{"difficulty":"simple","modelTier":"low","task":"读取 note.txt 并总结"}',
				),
				toolCallRound("read", "w-tc-1", '{"path":"note.txt"}'),
				textRound("note.txt 有一行：hello hotpot。", {
					input: 2000,
					output: 400,
				}),
				textRound("worker 已读完 note.txt。", {
					input: 120,
					output: 30,
				}),
			],
			approval,
		);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "看一下 note.txt",
				signal: new AbortController().signal,
				mainTier: "high",
			}),
		);

		// 主流正常结束、无错误事件
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
		expect(events.some((e) => e.type === "error")).toBe(false);

		// main 收到的 tool_result 带 worker 摘要（Worker <id> (tier=low) result: ...）
		const result = events.find(
			(e) => e.type === "tool_result" && e.name === "delegate",
		);
		if (result?.type !== "tool_result") {
			throw new Error("delegate tool_result missing");
		}
		expect(result.output.isError ?? false).toBe(false);
		expect(result.output.content).toContain(
			"Worker worker-1 (tier=low) result:",
		);
		expect(result.output.content).toContain("hello hotpot");

		const { events: fileEvents } = await loadSession(runtime.session.filePath);

		// worker 落盘：spawn 事件 + assistant_msg 档位与模型
		const spawn = fileEvents.find((e) => e.type === "agent_spawn");
		expect(spawn).toMatchObject({
			type: "agent_spawn",
			agentId: "worker-1",
			parentAgentId: "main",
			role: "worker",
			tier: "low",
			task: "读取 note.txt 并总结",
		});
		const workerMsgs = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
				e.type === "assistant_msg" && e.agentId === "worker-1",
		);
		const lastWorker = workerMsgs[workerMsgs.length - 1];
		if (!lastWorker) throw new Error("worker assistant_msg missing");
		expect(lastWorker.tier).toBe("low");
		expect(lastWorker.model).toBe("deepseek-chat");

		// 验收：全程无审批（无 plan 审批、无工具审批）；plan 事件不落会话日志，这里只看审批
		expectNoApproval(approvalAsks, fileEvents);

		// token 断言：main 两次请求（调用 1 与 4）开销 < 20% × worker 两次请求（调用 2 与 3）
		expect(usages).toHaveLength(4);
		const mainTokens = sumTokens(usages.filter((_, i) => i === 0 || i === 3));
		const workerTokens = sumTokens(usages.filter((_, i) => i === 1 || i === 2));
		expect(mainTokens).toBeLessThan(0.2 * workerTokens);
	});

	it("重复 delegate：第二次调用返回 isError「已判定」", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=main 首次 delegate(simple)，2=worker 摘要收尾，
		// 3=main 再次 delegate（应被守卫拒绝），4=main 文本收尾
		const { runtime } = await makeRuntime(
			[
				delegateRound(
					'{"difficulty":"simple","modelTier":"low","task":"读取 note.txt"}',
				),
				textRound("读完了。", { input: 50, output: 10 }),
				delegateRound(
					'{"difficulty":"simple","modelTier":"low","task":"再读一次"}',
				),
				textRound("收到，不再重复判定。", { input: 50, output: 10 }),
			],
			approval,
		);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "看一下 note.txt",
				signal: new AbortController().signal,
				mainTier: "high",
			}),
		);

		const results = events.filter(
			(e) => e.type === "tool_result" && e.name === "delegate",
		);
		expect(results).toHaveLength(2);
		const first = results[0];
		const second = results[1];
		if (first?.type !== "tool_result" || second?.type !== "tool_result") {
			throw new Error("delegate tool_result missing");
		}
		expect(first.output.isError ?? false).toBe(false);
		expect(second.output.isError).toBe(true);
		expect(second.output.content).toContain("已判定");
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		// 只有一次 spawn：第二次 delegate 未派生 worker
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(fileEvents.filter((e) => e.type === "agent_spawn")).toHaveLength(1);
	});
});
