// spawn_tasks 并行调度与失败上报测试（M2 验收 #3、#5 + abort 贯穿，Review Focus #4）。
// 驱动方式：与 run-worker 同款内联 worker turn —— createWorkerRegistry 装配注册表 +
// core runTurn，worker 第 1 步调 spawn_tasks，各 task turn 内联跑完回收结果段。
// 脚本分发按请求内容而非全局调用序：并发 task turn 进入首个 streamChat 的先后是
// fs 时序（不保证 FIFO），但每个 task turn 的请求 messages 必含自己的任务描述，
// spawn 编号在同批内同步前缀分配（FIFO），两相结合锚定确定性。
// recording 包装记录并发数（maxConcurrent）与每次请求（requests）：脚本流是同步
// 事件连发（微任务队列内耗尽），与真实网络流不同 —— 每个流先挂一个 setImmediate
// 并发闸门，等齐当前并发上限再回放，并发上限才可观测。

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, LlmAdapter, StreamEvent, Usage } from "@hotpot/ai";
import {
	type AgentEvent,
	ApprovalChain,
	createSession,
	type LoopConfig,
	loadSession,
	type ModelTier,
	runTurn,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRoleSystemPrompt } from "../src/prompts/prompts.ts";
import { createWorkerRegistry } from "../src/registries/registries.ts";
import {
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-spawn-tasks-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-spawn-tasks-proj-"));
	await writeFile(join(proj, "note.txt"), "hello hotpot\n", "utf8");
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

// worker 固定 low 档：派生的 task 继承该档位，agent_spawn.tier 断言锚定 low
const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

const WORKER_ID = "worker-1";
const WORKER_TIER: ModelTier = "low";

// 脚本条目：一轮事件序列；或一条内联异常指令（error=抛 LlmError 模拟流失效；
// abort=抛 AbortError 模拟流被 signal 中止——两者都在生成器迭代时抛，与真实适配器一致）
type ScriptEntry = StreamEvent[] | { error: Error } | { abort: true };

// 流脚本：worker 第一步（调 spawn_tasks）、worker 收尾步（tool_result 折进历史后）、
// 每个 task 一轮（下标 i 对应第 i+1 个任务；spawn 编号 FIFO，即 task-(i+1)）
interface FlowScript {
	workerFirst: StreamEvent[];
	workerNext?: StreamEvent[];
	tasks: ScriptEntry[];
}

interface Recording {
	maxConcurrent: number;
	requests: ChatRequest[];
}

// 并发闸门：脚本事件同步连发会在一个微任务队列内耗尽整条流（真实适配器的网络延迟
// 不会），每个 task 流先轮询等待 active 达到期望并发（或 signal 中止 / 超时兜底）再
// 回放 —— 上限内并发的流相互等齐，maxConcurrent 才观测得到真实池水位
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

function makeAdapter(
	script: FlowScript,
	tasks: { task: string }[],
	expectedConcurrency: number,
	recording: Recording,
	onTaskCall?: () => void,
): LlmAdapter {
	let active = 0;
	return {
		api: "recording",
		streamChat(req, signal) {
			recording.requests.push(req);
			const text = JSON.stringify(req.messages);
			// 分发：已带 spawn_tasks 的 tool_call 块（assistant 历史）→ worker 收尾步
			// （其 input JSON 内嵌全部 task 描述，必须最先判）；messages 含某 task 描述
			// → 该 task 的轮（task turn 的历史只有自己的 user_msg，worker 第一步的
			// messages 只有派发描述，均不含其他 task 描述）；其余 → worker 第一步
			let entry: ScriptEntry | StreamEvent[] | undefined;
			let isTask = false;
			if (text.includes('"name":"spawn_tasks"')) {
				entry = script.workerNext;
			} else {
				for (let i = 0; i < tasks.length; i += 1) {
					if (text.includes(tasks[i]?.task ?? "")) {
						entry = script.tasks[i];
						isTask = true;
						break;
					}
				}
				if (!isTask) {
					entry = script.workerFirst;
				}
			}
			if (isTask) onTaskCall?.();
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
						if ("abort" in entry) {
							throw new DOMException("The operation was aborted", "AbortError");
						}
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

async function makeRuntime(
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

// 与 run-worker 同款内联 worker turn：createWorkerRegistry 装配（四件套 + 绑定该
// worker 的 spawn_tasks），事件全量返回供断言 tool_result / done
async function runWorkerTurn(
	runtime: OrchestrationRuntime,
	signal: AbortSignal,
): Promise<AgentEvent[]> {
	const registry = createWorkerRegistry(runtime, {
		agentId: WORKER_ID,
		tier: WORKER_TIER,
	});
	const resolved = runtime.resolveModel(WORKER_TIER);
	const cfg: LoopConfig = {
		session: runtime.session,
		agentId: WORKER_ID,
		adapter: resolved.adapter,
		model: resolved.model,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		registry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt("worker", {
			cwd: runtime.cwd,
			os: process.platform,
			date: new Date().toISOString().slice(0, 10),
			tools: registry.declarations(),
		}),
		tier: WORKER_TIER,
	};
	const events: AgentEvent[] = [];
	for await (const event of runTurn(cfg, signal)) {
		events.push(event);
	}
	return events;
}

async function appendWorkerTask(runtime: OrchestrationRuntime, task: string) {
	await runtime.session.append({
		type: "user_msg",
		id: randomUUID(),
		ts: new Date().toISOString(),
		agentId: WORKER_ID,
		content: task,
	});
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

function spawnTasksResult(events: AgentEvent[]) {
	const result = events.find(
		(e) => e.type === "tool_result" && e.name === "spawn_tasks",
	);
	if (result?.type !== "tool_result") {
		throw new Error("spawn_tasks tool_result missing");
	}
	return result.output;
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

function spawnEvents(fileEvents: SessionEvent[]) {
	return fileEvents.filter((e) => e.type === "agent_spawn");
}

describe("spawn_tasks 并行调度", () => {
	it("8 个只读任务：默认上限 10 全开，maxConcurrent=8，落盘 8 条 role=task，聚合 8 段摘要（验收 #3）", async () => {
		const tasks = reviewTasks(8);
		const recording: Recording = { maxConcurrent: 0, requests: [] };
		const adapter = makeAdapter(
			{
				workerFirst: toolCallRound(
					"spawn_tasks",
					"w-tc-1",
					JSON.stringify({ tasks }),
				),
				workerNext: textRound("8 个文件全部审查完成。", {
					input: 50,
					output: 10,
				}),
				tasks: taskSummaryRounds(8),
			},
			tasks,
			8,
			recording,
		);
		const runtime = await makeRuntime(adapter);

		await appendWorkerTask(runtime, "并行审查这 8 个文件");
		const events = await runWorkerTurn(runtime, new AbortController().signal);

		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
		// 8 个 task turn 同批启动：并发数顶到 8（默认上限 10 不截断）
		expect(recording.maxConcurrent).toBe(8);

		// 落盘 8 条 role=task 的 agent_spawn：编号 task-1..8（集合断言；并发 append 的
		// 落盘顺序不保证 FIFO）、parent=worker、tier 继承 low
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		const spawns = spawnEvents(fileEvents);
		expect(spawns).toHaveLength(8);
		expect(spawns.map((e) => e.agentId).sort()).toEqual(
			Array.from({ length: 8 }, (_, i) => `task-${i + 1}`),
		);
		for (const spawn of spawns) {
			expect(spawn).toMatchObject({
				type: "agent_spawn",
				parentAgentId: WORKER_ID,
				role: "task",
				tier: "low",
			});
		}

		// 聚合 content：8 个结果段、各含对应摘要（分发按描述锚定，段与任务一一对齐）
		const output = spawnTasksResult(events);
		expect(output.isError ?? false).toBe(false);
		const sections = output.content.match(/Task task-\d+ result:/g) ?? [];
		expect(sections).toHaveLength(8);
		for (let i = 1; i <= 8; i += 1) {
			expect(output.content).toContain(`Task task-${i} result:\nsummary ${i}`);
		}
	});

	it("并发上限生效：maxParallelTasks=2、4 个任务，maxConcurrent=2", async () => {
		const tasks = reviewTasks(4);
		const recording: Recording = { maxConcurrent: 0, requests: [] };
		const adapter = makeAdapter(
			{
				workerFirst: toolCallRound(
					"spawn_tasks",
					"w-tc-1",
					JSON.stringify({ tasks }),
				),
				workerNext: textRound("4 个文件审查完成。", {
					input: 50,
					output: 10,
				}),
				tasks: taskSummaryRounds(4),
			},
			tasks,
			2,
			recording,
		);
		const runtime = await makeRuntime(adapter, 2);

		await appendWorkerTask(runtime, "并行审查这 4 个文件");
		const events = await runWorkerTurn(runtime, new AbortController().signal);

		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
		expect(recording.maxConcurrent).toBe(2);

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(spawnEvents(fileEvents)).toHaveLength(4);
		const output = spawnTasksResult(events);
		const sections = output.content.match(/Task task-\d+ result:/g) ?? [];
		expect(sections).toHaveLength(4);
	});
});

describe("spawn_tasks 失败上报（验收 #5）", () => {
	it("8 任务中第 5 个流失效：该段 [FAILED]、其余 7 段正常、整体 isError=false，worker 下一步请求可见失败内容", async () => {
		const tasks = reviewTasks(8);
		const recording: Recording = { maxConcurrent: 0, requests: [] };
		const taskRounds: ScriptEntry[] = taskSummaryRounds(8);
		// 第 5 个任务（task-5，描述锚点 file5）的流抛错，模拟 provider 流失效
		// （runTurn 把非 LlmError 归一为 code=stream_error 的 error 事件）
		taskRounds[4] = { error: new Error("scripted stream failure") };
		const adapter = makeAdapter(
			{
				workerFirst: toolCallRound(
					"spawn_tasks",
					"w-tc-1",
					JSON.stringify({ tasks }),
				),
				workerNext: textRound("7 个文件审查完成，1 个任务失败。", {
					input: 50,
					output: 10,
				}),
				tasks: taskRounds,
			},
			tasks,
			8,
			recording,
		);
		const runtime = await makeRuntime(adapter);

		await appendWorkerTask(runtime, "并行审查这 8 个文件");
		const events = await runWorkerTurn(runtime, new AbortController().signal);

		// 失败段按 `[FAILED] ${agentId}: ${reason}` 呈现，reason 带 error 事件的 code 与 message
		const output = spawnTasksResult(events);
		expect(output.isError ?? false).toBe(false);
		expect(output.content).toContain(
			"[FAILED] task-5: stream_error: scripted stream failure",
		);
		// 其余 7 段正常成段；失败任务没有正常摘要段
		const sections = output.content.match(/Task task-\d+ result:/g) ?? [];
		expect(sections).toHaveLength(7);
		expect(output.content).not.toContain("Task task-5 result:");

		// 失败 turn 的 error 事件已按 task-5 落盘（不静默丢失的落盘证据）
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(
			fileEvents.some((e) => e.type === "error" && e.agentId === "task-5"),
		).toBe(true);

		// worker 的下一步请求：messages 转换了含 [FAILED] 的 tool_result（recording 留档）
		const nextRequest = recording.requests.at(-1);
		expect(nextRequest).toBeDefined();
		expect(JSON.stringify(nextRequest?.messages)).toContain(
			"[FAILED] task-5: stream_error: scripted stream failure",
		);
	});
});

describe("spawn_tasks abort 贯穿（Review Focus #4）", () => {
	it("signal 在任务执行中 abort：各任务 turn 收到中止，结果段标 [FAILED] ... aborted，池不抛错", async () => {
		const controller = new AbortController();
		const tasks = reviewTasks(2);
		const recording: Recording = { maxConcurrent: 0, requests: [] };
		// 任务 turn 的流一进入即中止主流 signal，随后模拟流被 abort 打断
		const adapter = makeAdapter(
			{
				workerFirst: toolCallRound(
					"spawn_tasks",
					"w-tc-1",
					JSON.stringify({ tasks }),
				),
				tasks: [{ abort: true }, { abort: true }],
			},
			tasks,
			2,
			recording,
			() => controller.abort(),
		);
		const runtime = await makeRuntime(adapter);

		await appendWorkerTask(runtime, "并行审查这 2 个文件");
		const events = await runWorkerTurn(runtime, controller.signal);

		// abort 不是错误：无 error 事件，主流以 done(aborted) 收尾
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "aborted" });

		// 两个任务段都标 [FAILED] ... aborted；聚合整体仍不是错误（池本身没抛）
		const output = spawnTasksResult(events);
		expect(output.isError ?? false).toBe(false);
		expect(output.content).toContain("[FAILED] task-1: aborted");
		expect(output.content).toContain("[FAILED] task-2: aborted");

		// spawn 已落盘：task 诞生过，会话里可追溯
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(spawnEvents(fileEvents)).toHaveLength(2);
	});
});
