// M2 验收集成测试：对应 docs/archive/04-roadmap.md M2 验收 1-5，外加 runMainTurn 的
// pollInbox 接线用例（Task 12 补口）。全部 scriptedAdapter，不依赖真实 API。
// 每个场景都从 runMainTurn 入口跑完整流，与既有单点测试（main-turn/plan-flow/spawn-tasks）
// 的断言有重叠，本文件只做场景级串联：无审批 + token 量级（#1）、先批后改（#2）、
// 8 任务并行（#3）、分层路由可观测（#4）、失败不静默（#5）。
// 脚本分发两种模式：验收 1/2/4 与 pollInbox 按全局调用序回放（主流是严格顺序的
// 内联执行）；验收 3/5 的 8 个 task turn 并发，按请求内容分发（并发下调用序不确定），
// 并挂并发闸门观测 maxConcurrent。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type ContentBlock,
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
import { createInbox } from "../src/inbox.ts";
import { runMainTurn } from "../src/main-turn.ts";
import type { PlanDecision } from "../src/plan.ts";
import { createRuntime, type OrchestrationRuntime } from "../src/runtime.ts";
import type { OrchestrationEvent } from "../src/types.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-m2-acceptance-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-m2-acceptance-proj-"));
	await writeFile(join(proj, "note.txt"), "hello hotpot\n", "utf8");
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

// 三档指向不同模型，worker/task 走 low 档便于断言 model id 与 tier
const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

// 调用序运行时（验收 1/2/4、pollInbox 用例）：scriptedAdapter 按全局调用序回放，
// 包装层录制 usage 与请求；onFirstCall 在首次 streamChat 时触发（steer 注入用）
async function makeScriptedRuntime(
	script: StreamEvent[][],
	approval: ApprovalChain,
	planMaxRevisions?: number,
	onFirstCall?: () => void,
): Promise<{
	runtime: OrchestrationRuntime;
	usages: Usage[];
	requests: ChatRequest[];
}> {
	const session = await createSession(proj, home);
	const base = createRuntime({
		session,
		cwd: proj,
		approval,
		models: MODELS,
		planMaxRevisions,
	});
	const inner = scriptedAdapter(script);
	const usages: Usage[] = [];
	const requests: ChatRequest[] = [];
	let first = true;
	const adapter: LlmAdapter = {
		api: inner.api,
		streamChat(req, signal) {
			if (first) {
				first = false;
				onFirstCall?.();
			}
			requests.push(req);
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
	return { runtime, usages, requests };
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

function spawnWorkersRound(inputJson: string): StreamEvent[] {
	return toolCallRound("spawn_workers", "m-tc-2", inputJson);
}

function sumTokens(list: Usage[]): number {
	return list.reduce((acc, u) => acc + u.input + u.output, 0);
}

// ---- 并发分发适配器（验收 3/5）：task turn 并发，全局调用序不确定，按请求内容分发 ----

// 脚本条目：一轮事件序列；或一条内联异常指令（error=抛错模拟流失效）
type ScriptEntry = StreamEvent[] | { error: Error };

interface FlowScript {
	// main 的 delegate 步（主流入口第一调用）
	mainDelegate: StreamEvent[];
	// worker 第一步：调 spawn_tasks
	workerFirst: StreamEvent[];
	// worker 收尾步：messages 已带 spawn_tasks 的 tool_call 块
	workerNext: StreamEvent[];
	// main 收尾步：messages 已带 delegate 的 tool_call 块
	mainFinal: StreamEvent[];
	// 每个 task 一轮（下标 i 对应第 i+1 个任务）
	tasks: ScriptEntry[];
}

interface Recording {
	maxConcurrent: number;
	requests: ChatRequest[];
}

// 并发闸门：脚本事件同步连发会在一个微任务队列内耗尽整条流（真实适配器的网络
// 延迟不会），每个 task 流先轮询等待 active 达到期望并发再回放，并发上限才可观测
async function holdAtConcurrency(
	active: () => number,
	expected: number,
	signal: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + 100;
	while (active() < expected && !signal.aborted && Date.now() < deadline) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

// 分发规则（依次匹配）：messages 含 '"name":"spawn_tasks"' → worker 收尾步；
// 含 '"name":"delegate"' → main 收尾步；含主流用户消息 → main 的 delegate 步；
// 含 worker 任务描述 → worker 第一步；含某 task 描述 → 该 task 的轮；都不含 → 抛错。
// worker 收尾步同时含 worker 任务描述与全部 task 描述，故必须最先判 spawn_tasks 块；
// main 收尾步与 worker 第一步都含各自的任务描述锚点，故 tool_call 名/用户消息判定
// 须先于 worker 任务描述（main 收尾步的 delegate tool_call 输入含 worker 任务描述）
function makeDispatchAdapter(
	script: FlowScript,
	mainUserText: string,
	workerTaskText: string,
	tasks: { task: string }[],
	expectedConcurrency: number,
	recording: Recording,
): LlmAdapter {
	let active = 0;
	return {
		api: "recording",
		streamChat(req, signal) {
			recording.requests.push(req);
			const text = JSON.stringify(req.messages);
			let entry: ScriptEntry | StreamEvent[] | undefined;
			let isTask = false;
			if (text.includes('"name":"spawn_tasks"')) {
				entry = script.workerNext;
			} else if (text.includes('"name":"delegate"')) {
				entry = script.mainFinal;
			} else if (text.includes(mainUserText)) {
				entry = script.mainDelegate;
			} else if (text.includes(workerTaskText)) {
				entry = script.workerFirst;
			} else {
				for (let i = 0; i < tasks.length; i += 1) {
					if (text.includes(tasks[i]?.task ?? "")) {
						entry = script.tasks[i];
						isTask = true;
						break;
					}
				}
			}
			return (async function* (): AsyncGenerator<StreamEvent> {
				active += 1;
				recording.maxConcurrent = Math.max(recording.maxConcurrent, active);
				try {
					if (isTask) {
						await holdAtConcurrency(() => active, expectedConcurrency, signal);
					}
					if (entry === undefined) {
						throw new Error("no scripted round matches this request");
					}
					if (!Array.isArray(entry)) {
						throw entry.error;
					}
					for (const ev of entry) {
						yield ev;
					}
				} finally {
					active -= 1;
				}
			})();
		},
	};
}

async function makeDispatchRuntime(
	adapter: LlmAdapter,
	maxParallelTasks?: number,
): Promise<OrchestrationRuntime> {
	const session = await createSession(proj, home);
	const base = createRuntime({
		session,
		cwd: proj,
		approval: new ApprovalChain(),
		models: MODELS,
		maxParallelTasks,
	});
	return {
		...base,
		resolveModel(tier: ModelTier) {
			return { ...base.resolveModel(tier), adapter };
		},
	};
}

// 只读审查子任务：描述含 fileK 锚点，脚本轮按描述分发到对应 task turn
function reviewTasks(n: number): { task: string }[] {
	return Array.from({ length: n }, (_, i) => ({
		task: `review file${i + 1}.ts for type-safety issues`,
	}));
}

function taskSummaryRounds(n: number): StreamEvent[][] {
	return Array.from({ length: n }, (_, i) =>
		textRound(`summary ${i + 1}`, { input: 10, output: 5 }),
	);
}

// worker 内联 turn 的事件不透出主流（M2 决定 #3），spawn_tasks 的聚合结果从会话
// 日志取：worker 的 assistant_msg 里找 spawn_tasks 调用块，按其 id 关联落盘的
// tool_result（持久化形状：content/isError 平铺，区别于事件流的 output 包装）
function spawnTasksOutputFromLog(
	fileEvents: SessionEvent[],
	workerId: string,
): { content: string; isError: boolean } {
	const workerMsg = fileEvents.find(
		(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
			e.type === "assistant_msg" &&
			e.agentId === workerId &&
			e.content.some((b) => b.type === "tool_call" && b.name === "spawn_tasks"),
	);
	const block = workerMsg?.content.find(
		(b): b is Extract<ContentBlock, { type: "tool_call" }> =>
			b.type === "tool_call" && b.name === "spawn_tasks",
	);
	const result = fileEvents.find(
		(e) => e.type === "tool_result" && e.toolCallId === block?.id,
	);
	if (result?.type !== "tool_result") {
		throw new Error("spawn_tasks tool_result missing");
	}
	return { content: result.content, isError: result.isError };
}

describe("M2 验收 1-5（runMainTurn 端到端串联）", () => {
	it("验收 1：simple 任务全程无 plan 审批，main token 开销 < 20% worker 成本", async () => {
		let approvalAsks = 0;
		const approval = new ApprovalChain();
		approval.use(() => {
			approvalAsks += 1;
			return Promise.resolve("next");
		});
		let planAsked = 0;
		// 全局调用序：1=main delegate，2=worker 读文件，3=worker 摘要收尾，4=main 收尾
		const { runtime, usages } = await makeScriptedRuntime(
			[
				delegateRound(
					'{"difficulty":"simple","modelTier":"low","task":"读取 note.txt 并总结内容"}',
				),
				toolCallRound("read", "w-tc-1", '{"path":"note.txt"}'),
				textRound("note.txt 有一行：hello hotpot。", {
					input: 2000,
					output: 400,
				}),
				textRound("worker 已读完并总结。", { input: 120, output: 30 }),
			],
			approval,
		);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "看一下 note.txt",
				signal: new AbortController().signal,
				mainTier: "high",
				onPlanApproval: () => {
					planAsked += 1;
					return Promise.resolve<PlanDecision>({ kind: "approve" });
				},
			}),
		);

		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
		expect(events.some((e) => e.type === "error")).toBe(false);
		// 无 plan 审批：回调未被咨询、事件流无 plan 事件
		expect(planAsked).toBe(0);
		expect(events.some((e) => e.type === "plan")).toBe(false);

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		// 无审批询问：ApprovalChain 未被询问 + 日志无 approval/* 事件
		expect(approvalAsks).toBe(0);
		expect(
			fileEvents.filter((e) => e.type.startsWith("approval/")),
		).toHaveLength(0);

		// token 与 M1 同量级（偏差 < 20%）：main 两次请求（调用 1 与 4）
		// 开销 < 20% × worker 两次请求（调用 2 与 3）
		expect(usages).toHaveLength(4);
		const mainTokens = sumTokens(usages.filter((_, i) => i === 0 || i === 3));
		const workerTokens = sumTokens(usages.filter((_, i) => i === 1 || i === 2));
		expect(mainTokens).toBeLessThan(0.2 * workerTokens);
	});

	it("验收 2：complex 任务先展示 plan，批准前零文件改动，批准后 worker 执行", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=main delegate(complex)，2=main 起草前说明，3=main 起草 plan，
		// 4=main spawn_workers，5=worker 写 auth.ts，6=worker 摘要收尾，7=main 最终回复
		const planV1 =
			"PLAN v1: (1) add auth routes (2) add login page. Files: auth.ts, login.tsx.";
		const { runtime } = await makeScriptedRuntime(
			[
				delegateRound(
					'{"difficulty":"complex","modelTier":"high","task":"给项目加用户认证"}',
				),
				textRound("我来起草实现计划。", { input: 100, output: 20 }),
				textRound(planV1, { input: 200, output: 60 }),
				spawnWorkersRound(
					'{"workers":[{"task":"实现后端 auth 路由","modelTier":"high"}]}',
				),
				toolCallRound(
					"write",
					"w-tc-1",
					'{"path":"auth.ts","content":"export const auth = true;\\n"}',
				),
				textRound("auth 路由已完成，写入了 auth.ts。", {
					input: 500,
					output: 100,
				}),
				textRound("用户认证已按计划实现。", { input: 100, output: 20 }),
			],
			approval,
		);
		const seenPlans: string[] = [];
		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "给项目加用户认证",
				signal: new AbortController().signal,
				mainTier: "high",
				onPlanApproval: (plan) => {
					seenPlans.push(plan);
					return Promise.resolve<PlanDecision>({ kind: "approve" });
				},
			}),
		);

		// 先展示 plan：审批回调拿到 plan 全文，事件流 drafted 在 approved 之前
		expect(seenPlans).toEqual([planV1]);
		const draftedIdx = events.findIndex(
			(e) => e.type === "plan" && e.phase === "drafted",
		);
		const approvedIdx = events.findIndex(
			(e) => e.type === "plan" && e.phase === "approved",
		);
		expect(draftedIdx).toBeGreaterThan(-1);
		expect(approvedIdx).toBeGreaterThan(draftedIdx);

		// 批准后 worker 执行：spawn_workers 聚合摘要回传 main
		const spawnResult = events.find(
			(e) => e.type === "tool_result" && e.name === "spawn_workers",
		);
		if (spawnResult?.type !== "tool_result") {
			throw new Error("spawn_workers tool_result missing");
		}
		expect(spawnResult.output.isError ?? false).toBe(false);
		expect(spawnResult.output.content).toContain("auth.ts");
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		const { events: fileEvents } = await loadSession(runtime.session.filePath);

		// 批准前零文件改动：首个 approval/decided 早于任何写工具的 tool_result
		const firstDecidedIdx = fileEvents.findIndex(
			(e) => e.type === "approval/decided",
		);
		const workerMsg = fileEvents.find(
			(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
				e.type === "assistant_msg" && e.agentId === "worker-1",
		);
		const writeBlock = workerMsg?.content.find(
			(b): b is Extract<ContentBlock, { type: "tool_call" }> =>
				b.type === "tool_call" && b.name === "write",
		);
		const firstWriteResultIdx = fileEvents.findIndex(
			(e) => e.type === "tool_result" && e.toolCallId === writeBlock?.id,
		);
		expect(firstDecidedIdx).toBeGreaterThan(-1);
		expect(firstWriteResultIdx).toBeGreaterThan(-1);
		expect(firstDecidedIdx).toBeLessThan(firstWriteResultIdx);

		// 批准后确有 worker 诞生并落盘执行记录
		const spawn = fileEvents.find((e) => e.type === "agent_spawn");
		expect(spawn).toMatchObject({
			type: "agent_spawn",
			agentId: "worker-1",
			parentAgentId: "main",
			role: "worker",
			tier: "high",
			task: "实现后端 auth 路由",
		});
		const writeResult = fileEvents.find(
			(e) => e.type === "tool_result" && e.toolCallId === writeBlock?.id,
		);
		expect(writeResult).toMatchObject({ isError: false });
	});

	it("验收 3：8 个只读审查任务并行 TaskAgent，maxConcurrent=8，落盘 8 条 task agent_spawn", async () => {
		const tasks = reviewTasks(8);
		const mainUserText = "帮我审查这 8 个文件";
		const workerTaskText = "并行审查 8 个文件并逐文件汇总";
		const recording: Recording = { maxConcurrent: 0, requests: [] };
		const adapter = makeDispatchAdapter(
			{
				mainDelegate: delegateRound(
					`{"difficulty":"simple","modelTier":"low","task":"${workerTaskText}"}`,
				),
				workerFirst: toolCallRound(
					"spawn_tasks",
					"w-tc-1",
					JSON.stringify({ tasks }),
				),
				workerNext: textRound("8 个文件全部审查完成。", {
					input: 50,
					output: 10,
				}),
				mainFinal: textRound("8 个文件的审查结论已汇总。", {
					input: 100,
					output: 20,
				}),
				tasks: taskSummaryRounds(8),
			},
			mainUserText,
			workerTaskText,
			tasks,
			8,
			recording,
		);
		const runtime = await makeDispatchRuntime(adapter);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: mainUserText,
				signal: new AbortController().signal,
				mainTier: "high",
			}),
		);

		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
		// 8 个 task turn 同批启动：并发数顶到 8（默认上限 10 不截断）
		expect(recording.maxConcurrent).toBe(8);

		// 落盘 8 条 role=task 的 agent_spawn：编号 task-1..8（集合断言；并发 append 的
		// 落盘顺序不保证 FIFO）、parent=worker、tier 继承 low（另有 1 条 worker 的
		// agent_spawn，按 role=task 过滤）
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		const spawns = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "agent_spawn" }> =>
				e.type === "agent_spawn" && e.role === "task",
		);
		expect(spawns).toHaveLength(8);
		expect(spawns.map((e) => e.agentId).sort()).toEqual(
			Array.from({ length: 8 }, (_, i) => `task-${i + 1}`),
		);
		for (const spawn of spawns) {
			expect(spawn).toMatchObject({
				type: "agent_spawn",
				parentAgentId: "worker-1",
				role: "task",
				tier: "low",
			});
		}

		// 聚合 8 段摘要回传 worker（从落盘 tool_result 取），worker 摘要再回传 main
		const output = spawnTasksOutputFromLog(fileEvents, "worker-1");
		expect(output.isError).toBe(false);
		const sections = output.content.match(/Task task-\d+ result:/g) ?? [];
		expect(sections).toHaveLength(8);
		const delegateResult = events.find(
			(e) => e.type === "tool_result" && e.name === "delegate",
		);
		if (delegateResult?.type !== "tool_result") {
			throw new Error("delegate tool_result missing");
		}
		expect(delegateResult.output.isError ?? false).toBe(false);
		expect(delegateResult.output.content).toContain("8 个文件全部审查完成");
	});

	it("验收 4：simple 路由 low 档，worker 落盘 assistant_msg 的 tier/model 正确", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=main delegate(simple, low)，2=worker 摘要收尾，3=main 收尾
		const { runtime } = await makeScriptedRuntime(
			[
				delegateRound(
					'{"difficulty":"simple","modelTier":"low","task":"读取 note.txt 并总结内容"}',
				),
				textRound("note.txt 有一行：hello hotpot。", {
					input: 2000,
					output: 400,
				}),
				textRound("worker 已读完并总结。", { input: 120, output: 30 }),
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
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		// 分层路由可观测：spawn 事件 + worker assistant_msg 的 tier 落盘为 low、
		// model 为 low 档模型 id（usage 记账按 agentId + tier 的依据）
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		const spawn = fileEvents.find((e) => e.type === "agent_spawn");
		expect(spawn).toMatchObject({ agentId: "worker-1", tier: "low" });
		const workerMsgs = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
				e.type === "assistant_msg" && e.agentId === "worker-1",
		);
		const lastWorker = workerMsgs[workerMsgs.length - 1];
		if (!lastWorker) throw new Error("worker assistant_msg missing");
		expect(lastWorker.tier).toBe("low");
		expect(lastWorker.model).toBe("deepseek-chat");
		// 分层记账互不串档：main 自己的 assistant_msg 仍是 high 档
		const mainMsgs = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
				e.type === "assistant_msg" && e.agentId === "main",
		);
		const lastMain = mainMsgs[mainMsgs.length - 1];
		if (!lastMain) throw new Error("main assistant_msg missing");
		expect(lastMain.tier).toBe("high");
		expect(lastMain.model).toBe("claude-sonnet-4-5");
	});

	it("验收 5：子 agent 流失效不静默，[FAILED] 段可见且 worker 下一步据此上报", async () => {
		const tasks = reviewTasks(8);
		const mainUserText = "帮我审查这 8 个文件";
		const workerTaskText = "并行审查 8 个文件并逐文件汇总";
		const recording: Recording = { maxConcurrent: 0, requests: [] };
		const taskRounds: ScriptEntry[] = taskSummaryRounds(8);
		// 第 5 个任务（task-5，描述锚点 file5）的流抛错，模拟 provider 流失效
		// （runTurn 把非 LlmError 归一为 code=stream_error 的 error 事件）
		taskRounds[4] = { error: new Error("scripted stream failure") };
		const adapter = makeDispatchAdapter(
			{
				mainDelegate: delegateRound(
					`{"difficulty":"simple","modelTier":"low","task":"${workerTaskText}"}`,
				),
				workerFirst: toolCallRound(
					"spawn_tasks",
					"w-tc-1",
					JSON.stringify({ tasks }),
				),
				workerNext: textRound(
					"7 个文件审查完成，task-5 失败已见 [FAILED] 标注。",
					{ input: 50, output: 10 },
				),
				mainFinal: textRound("审查汇总：7 成 1 败，结论已给出。", {
					input: 100,
					output: 20,
				}),
				tasks: taskRounds,
			},
			mainUserText,
			workerTaskText,
			tasks,
			8,
			recording,
		);
		const runtime = await makeDispatchRuntime(adapter);

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: mainUserText,
				signal: new AbortController().signal,
				mainTier: "high",
			}),
		);

		// [FAILED] 段可见：聚合整体仍不是错误（池本身没抛），失败段按
		// `[FAILED] ${agentId}: ${reason}` 呈现，其余 7 段正常。
		// worker 事件不透出主流，断言从会话日志的落盘 tool_result 取
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		const output = spawnTasksOutputFromLog(fileEvents, "worker-1");
		expect(output.isError).toBe(false);
		expect(output.content).toContain(
			"[FAILED] task-5: stream_error: scripted stream failure",
		);
		const sections = output.content.match(/Task task-\d+ result:/g) ?? [];
		expect(sections).toHaveLength(7);
		expect(output.content).not.toContain("Task task-5 result:");

		// 不静默丢失的落盘证据：失败 turn 的 error 事件按 task-5 落盘
		expect(
			fileEvents.some((e) => e.type === "error" && e.agentId === "task-5"),
		).toBe(true);

		// worker 可据此上报：worker 收尾步的请求历史折进了含 [FAILED] 的
		// spawn_tasks tool_result（按 spawn_tasks 调用块定位该请求）
		const workerNextReq = recording.requests.find((r) =>
			JSON.stringify(r.messages).includes('"name":"spawn_tasks"'),
		);
		expect(workerNextReq).toBeDefined();
		expect(JSON.stringify(workerNextReq?.messages)).toContain(
			"[FAILED] task-5: stream_error: scripted stream failure",
		);

		// 主流不因单任务失败中断：worker 摘要回传 main，正常收尾
		const delegateResult = events.find(
			(e) => e.type === "tool_result" && e.name === "delegate",
		);
		if (delegateResult?.type !== "tool_result") {
			throw new Error("delegate tool_result missing");
		}
		expect(delegateResult.output.isError ?? false).toBe(false);
		expect(delegateResult.output.content).toContain("[FAILED]");
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});
});

describe("runMainTurn pollInbox 接线（Task 12 补口）", () => {
	it("turn 进行中 steer 的 next-step 消息注入后续 step 的模型历史", async () => {
		const approval = new ApprovalChain();
		// steer 动作经 onFirstCall 挂在首次 streamChat（step 1 进行中），
		// 模拟 turn 进行中用户注入；调用序：1=main delegate(trivial)，2=main 收尾
		let doSteer: (() => void) | null = null;
		const { runtime, requests } = await makeScriptedRuntime(
			[
				delegateRound(
					'{"difficulty":"trivial","modelTier":"high","task":"1+1 等于几"}',
				),
				textRound("答案是 2。", { input: 10, output: 5 }),
			],
			approval,
			undefined,
			() => doSteer?.(),
		);
		const inbox = createInbox(runtime.session, "main");
		doSteer = () => {
			void inbox.steer("改用中文回答");
		};

		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "1+1 等于几",
				signal: new AbortController().signal,
				mainTier: "high",
				inbox,
			}),
		);

		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
		// 注入落盘：steer 消息成为 main 的 user_msg，且队列快照有 next-step 记录
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(
			fileEvents.some(
				(e) =>
					e.type === "user_msg" &&
					e.agentId === "main" &&
					e.content === "改用中文回答",
			),
		).toBe(true);
		expect(
			fileEvents.some(
				(e) => e.type === "inbox/spliced" && e.queue === "next-step",
			),
		).toBe(true);

		// 出现在后续 step 的模型历史：step 1 请求不含注入，step 2 请求含注入
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[0]?.messages)).not.toContain("改用中文回答");
		expect(JSON.stringify(requests[1]?.messages)).toContain("改用中文回答");
	});
});
