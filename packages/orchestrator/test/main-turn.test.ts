// runMainTurn 测试：首轮提示词路由——trivial 直接文本回答；simple 首轮直接
// spawn_workers（本回合无计划标记即放行，worker 内联跑完摘要回传）；complex 首轮
// 输出带 `# Plan` 标记的计划正文进入审批；同轮「计划标记 + spawn_workers」被
// 门禁拦截（未批准不产生 agent_spawn）。
// scriptedAdapter 按全局 streamChat 调用顺序回放：调用 1 = main 首轮步，
// 2..N = worker turn 的各步（工具步 + 摘要步），最后一调用 = main 收尾。

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
import { runMainTurn } from "../src/main-turn/main-turn.ts";
import {
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";
import type { OrchestrationEvent } from "../src/types/types.ts";

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

// main 首轮的 spawn_workers 轮：simple 直派一个 low 档 worker
function spawnWorkersRound(id: string, inputJson: string): StreamEvent[] {
	return toolCallRound("spawn_workers", id, inputJson);
}

// 同一条 assistant 消息内「计划正文 + 工具调用」：堵同轮执行守卫的构造
function planTextWithToolRound(
	text: string,
	name: string,
	id: string,
	inputJson: string,
	usage: Usage,
): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage },
		{ type: "finish", reason: "tool_calls" },
	];
}

// 合法计划正文（# Plan 标记 + 三个必备段落）
const PLAN_TEXT = `# Plan

## Steps
1. add auth routes

## Files
auth.ts

## Acceptance criteria
tests pass
`;

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
		// 普通回答不触发计划审批流
		expect(events.some((e) => e.type === "plan")).toBe(false);
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

	it("simple：首轮 spawn_workers（本回合无计划标记）放行，内联跑 worker，档位/模型正确，token 开销 < 20% worker 成本", async () => {
		let approvalAsks = 0;
		const approval = new ApprovalChain();
		approval.use(() => {
			approvalAsks += 1;
			return Promise.resolve("next");
		});
		// 全局调用序：1=main spawn_workers，2=worker 读文件（isConcurrencySafe 的 read），
		// 3=worker 文本摘要收尾，4=main 文本收尾
		const { runtime, usages } = await makeRuntime(
			[
				spawnWorkersRound(
					"m-tc-1",
					'{"workers":[{"task":"读取 note.txt 并总结","modelTier":"low"}]}',
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
			(e) => e.type === "tool_result" && e.name === "spawn_workers",
		);
		if (result?.type !== "tool_result") {
			throw new Error("spawn_workers tool_result missing");
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

		// 验收：全程无审批（simple 直派无 plan 审批、无工具审批）
		expectNoApproval(approvalAsks, fileEvents);

		// token 断言：main 两次请求（调用 1 与 4）开销 < 20% × worker 两次请求（调用 2 与 3）
		expect(usages).toHaveLength(4);
		const mainTokens = sumTokens(usages.filter((_, i) => i === 0 || i === 3));
		const workerTokens = sumTokens(usages.filter((_, i) => i === 1 || i === 2));
		expect(mainTokens).toBeLessThan(0.2 * workerTokens);
	});

	it("simple：agent_spawn 流事件由主流直产，位于 spawn_workers tool_result 之前", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=main spawn_workers(simple)，2=worker 读文件，3=worker 摘要收尾，4=main 收尾
		const { runtime } = await makeRuntime(
			[
				spawnWorkersRound(
					"m-tc-1",
					'{"workers":[{"task":"读取 note.txt 并总结","modelTier":"low"}]}',
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

		const spawnIdx = events.findIndex((e) => e.type === "agent_spawn");
		expect(spawnIdx).toBeGreaterThanOrEqual(0);
		const spawn = events[spawnIdx];
		expect(spawn).toEqual({
			type: "agent_spawn",
			agentId: "worker-1",
			role: "worker",
			tier: "low",
			task: "读取 note.txt 并总结",
		});
		const resultIdx = events.findIndex(
			(e) => e.type === "tool_result" && e.name === "spawn_workers",
		);
		expect(resultIdx).toBeGreaterThanOrEqual(0);
		// spawn 事件必须先于 spawn_workers 的 tool_result 到达
		expect(spawnIdx).toBeLessThan(resultIdx);
	});

	it("simple：同回合多次 spawn_workers 均放行（worker-1、worker-2 都诞生）", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=main 首次 spawn_workers，2=worker-1 摘要收尾，
		// 3=main 再次 spawn_workers，4=worker-2 摘要收尾，5=main 文本收尾
		const { runtime } = await makeRuntime(
			[
				spawnWorkersRound(
					"m-tc-1",
					'{"workers":[{"task":"读取 note.txt","modelTier":"low"}]}',
				),
				textRound("读完了。", { input: 50, output: 10 }),
				spawnWorkersRound(
					"m-tc-2",
					'{"workers":[{"task":"读取 note.txt 第二遍","modelTier":"low"}]}',
				),
				textRound("又读完了。", { input: 50, output: 10 }),
				textRound("两次都完成。", { input: 50, output: 10 }),
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
			(e) => e.type === "tool_result" && e.name === "spawn_workers",
		);
		expect(results).toHaveLength(2);
		for (const r of results) {
			if (r.type !== "tool_result") throw new Error("tool_result missing");
			expect(r.output.isError ?? false).toBe(false);
		}
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		const spawns = fileEvents.filter((e) => e.type === "agent_spawn");
		expect(spawns).toHaveLength(2);
		expect(spawns.map((e) => e.agentId).sort()).toEqual([
			"worker-1",
			"worker-2",
		]);
	});

	it("complex 守卫：首轮同轮产出计划标记文本并调 spawn_workers（未批准）→ isError 且 plan 仍走审批", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=main 一条消息内「计划正文 + spawn_workers 调用」（守卫应拦截执行），
		// 2=main 收到 isError 后结束首轮，3=plan 被拒后的收尾回复
		const { runtime } = await makeRuntime(
			[
				planTextWithToolRound(
					PLAN_TEXT,
					"spawn_workers",
					"m-tc-1",
					'{"workers":[{"task":"实现 auth 路由","modelTier":"high"}]}',
					{ input: 200, output: 60 },
				),
				textRound("收到，等待审批。", { input: 50, output: 10 }),
				textRound("好的，计划被拒绝，不做任何实现。", {
					input: 100,
					output: 20,
				}),
			],
			approval,
		);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "给项目加用户认证",
				signal: new AbortController().signal,
				mainTier: "high",
				onPlanApproval: () =>
					Promise.resolve({ kind: "reject", note: "先不做了" }),
			}),
		);

		// 守卫：spawn_workers 被拦截、无 agent_spawn 落盘
		const result = events.find(
			(e) => e.type === "tool_result" && e.name === "spawn_workers",
		);
		if (result?.type !== "tool_result") {
			throw new Error("spawn_workers tool_result missing");
		}
		expect(result.output.isError).toBe(true);

		// 计划仍进入审批流：drafted → denied，随后 main 收尾回复用户
		expect(events.some((e) => e.type === "plan" && e.phase === "drafted")).toBe(
			true,
		);
		expect(events.some((e) => e.type === "plan" && e.phase === "denied")).toBe(
			true,
		);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(fileEvents.some((e) => e.type === "agent_spawn")).toBe(false);
	});
});
