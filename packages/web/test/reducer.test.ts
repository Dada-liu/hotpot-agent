// reducer 测试：spawn 登记 → 工具事件归属 → failed 启发 → turn(end) 状态翻转 →
// 幂等去重 → delta 折叠定格 → approval 登记/清除 → panelOpen。
// 事件构造走协议形状（protocol.ts 镜像 server wire.ts）。

import { describe, expect, it } from "vitest";
import type { ContentBlock, SessionEvent, WireEvent } from "../src/protocol.ts";
import {
	applyInboxSnapshot,
	createInitialState,
	reduce,
} from "../src/state/reducer.ts";

// 造一个 log wire 事件的简写
function log(seq: number, event: SessionEvent): WireEvent {
	return { seq, kind: "log", event };
}

const ts = "2026-10-17T00:00:00.000Z";

function userMsg(id: string, content: string, agentId = "main"): SessionEvent {
	return { type: "user_msg", id, ts, agentId, content };
}

function assistantMsg(
	id: string,
	agentId: string,
	content: ContentBlock[],
): SessionEvent {
	return { type: "assistant_msg", id, ts, agentId, content };
}

// 带 usage/tier 的 assistant_msg（tier 默认时构造体不含该字段，走默认语义）
function assistantUsageMsg(
	id: string,
	agentId: string,
	usage: { input: number; output: number },
	tier?: string,
): SessionEvent {
	return {
		type: "assistant_msg",
		id,
		ts,
		agentId,
		content: [],
		usage,
		...(tier === undefined ? {} : { tier }),
	};
}

describe("reduce：spawn 登记与 agent 树", () => {
	it("spawn 登记 worker 与 task，字段齐全，panelOpen 置 true", () => {
		let state = createInitialState();
		expect(state.panelOpen).toBe(false);

		state = reduce(state, {
			seq: 1,
			kind: "spawn",
			agentId: "worker-1",
			role: "worker",
			tier: "medium",
			task: "实现 reducer",
			parentAgentId: "main",
		});
		state = reduce(state, {
			seq: 2,
			kind: "spawn",
			agentId: "task-1",
			role: "task",
			tier: "low",
			task: "跑测试",
			parentAgentId: "worker-1",
		});

		expect(state.panelOpen).toBe(true);
		expect(state.agents).toHaveLength(2);

		const worker = state.agents.find((a) => a.agentId === "worker-1");
		expect(worker).toMatchObject({
			agentId: "worker-1",
			role: "worker",
			tier: "medium",
			task: "实现 reducer",
			parentAgentId: "main",
			status: "running",
		});

		const task = state.agents.find((a) => a.agentId === "task-1");
		expect(task).toMatchObject({
			agentId: "task-1",
			role: "task",
			tier: "low",
			task: "跑测试",
			parentAgentId: "worker-1",
			status: "running",
		});
	});

	it("log(agent_spawn) 同样登记 agent", () => {
		let state = createInitialState();
		state = reduce(
			state,
			log(1, {
				type: "agent_spawn",
				id: "e-1",
				ts,
				parentAgentId: "main",
				agentId: "worker-2",
				role: "worker",
				task: "修 bug",
				tier: "high",
			}),
		);
		expect(state.agents.find((a) => a.agentId === "worker-2")).toMatchObject({
			role: "worker",
			parentAgentId: "main",
			status: "running",
		});
		expect(state.panelOpen).toBe(true);
	});
});

describe("reduce：工具卡片与 agent 归属", () => {
	it("worker 的 assistant_msg（含 tool_call）更新 currentTool；tool_result 配对并清除", () => {
		let state = createInitialState();
		state = reduce(state, {
			seq: 1,
			kind: "spawn",
			agentId: "worker-1",
			role: "worker",
			tier: "medium",
			task: "干活",
			parentAgentId: "main",
		});
		state = reduce(
			state,
			log(
				2,
				assistantMsg("a-1", "worker-1", [
					{ type: "text", text: "我来处理" },
					{
						type: "tool_call",
						id: "call-1",
						name: "read_file",
						input: { path: "a.ts" },
					},
				]),
			),
		);

		expect(
			state.agents.find((a) => a.agentId === "worker-1")?.currentTool,
		).toBe("read_file");

		// main 收到无关 tool_result（toolCallId 不匹配）不回填任何工具卡片
		state = reduce(
			state,
			log(3, {
				type: "tool_result",
				id: "r-0",
				ts,
				agentId: "main",
				toolCallId: "call-x",
				content: "别的",
				isError: false,
			}),
		);
		expect(
			state.transcript.some((t) => t.kind === "tool" && t.result !== undefined),
		).toBe(false);

		// worker 的 tool_result 按 toolCallId + agentId 配对
		state = reduce(
			state,
			log(4, {
				type: "tool_result",
				id: "r-1",
				ts,
				agentId: "worker-1",
				toolCallId: "call-1",
				content: "文件内容",
				isError: false,
			}),
		);

		const tool = state.transcript.find((t) => t.kind === "tool");
		expect(tool).toMatchObject({
			kind: "tool",
			agentId: "worker-1",
			toolCallId: "call-1",
			name: "read_file",
			result: { content: "文件内容", isError: false },
		});
		expect(
			state.agents.find((a) => a.agentId === "worker-1")?.currentTool,
		).toBeUndefined();
	});

	it("main 的 assistant_msg 进 transcript；user_msg 只收 main", () => {
		let state = createInitialState();
		state = reduce(state, log(1, userMsg("u-1", "你好")));
		state = reduce(
			state,
			log(2, userMsg("u-2", "worker 内部追问", "worker-1")),
		);
		state = reduce(
			state,
			log(3, assistantMsg("a-1", "main", [{ type: "text", text: "收到" }])),
		);

		const users = state.transcript.filter((t) => t.kind === "user");
		expect(users).toHaveLength(1);
		expect(users[0]).toMatchObject({ id: "u-1", content: "你好" });
		expect(
			state.transcript.some((t) => t.kind === "assistant" && t.id === "a-1"),
		).toBe(true);
	});
});

describe("reduce：failed 启发", () => {
	it("log(error) 标记对应 agent failed", () => {
		let state = createInitialState();
		state = reduce(state, {
			seq: 1,
			kind: "spawn",
			agentId: "task-1",
			role: "task",
			tier: "low",
			task: "干活",
			parentAgentId: "main",
		});
		state = reduce(
			state,
			log(2, {
				type: "error",
				id: "err-1",
				ts,
				agentId: "task-1",
				code: "TOOL_TIMEOUT",
				message: "工具超时",
			}),
		);
		expect(state.agents.find((a) => a.agentId === "task-1")?.status).toBe(
			"failed",
		);
	});

	it("父级 tool_result 内容含 [FAILED] <agentId> 时子 agent 标记 failed", () => {
		let state = createInitialState();
		state = reduce(state, {
			seq: 1,
			kind: "spawn",
			agentId: "task-1",
			role: "task",
			tier: "low",
			task: "干活",
			parentAgentId: "main",
		});
		state = reduce(
			state,
			log(2, {
				type: "tool_result",
				id: "r-1",
				ts,
				agentId: "main",
				toolCallId: "call-1",
				content: "[FAILED] task-1: 子任务异常退出",
				isError: true,
			}),
		);
		expect(state.agents.find((a) => a.agentId === "task-1")?.status).toBe(
			"failed",
		);
		expect(state.agents.find((a) => a.agentId === "main")).toBeUndefined();
	});
});

describe("reduce：turn 状态翻转", () => {
	it("turn(end) 把仍 running 的 agent 翻为 done；turn(start) 置 running", () => {
		let state = createInitialState();
		expect(state.turn).toBe("idle");
		state = reduce(state, { seq: 1, kind: "turn", phase: "start" });
		expect(state.turn).toBe("running");

		state = reduce(state, {
			seq: 2,
			kind: "spawn",
			agentId: "worker-1",
			role: "worker",
			tier: "medium",
			task: "干活",
			parentAgentId: "main",
		});
		state = reduce(
			state,
			log(3, {
				type: "error",
				id: "err-1",
				ts,
				agentId: "worker-1",
				code: "X",
				message: "失败",
			}),
		);
		state = reduce(state, {
			seq: 4,
			kind: "spawn",
			agentId: "task-2",
			role: "task",
			tier: "low",
			task: "别的活",
			parentAgentId: "main",
		});

		state = reduce(state, { seq: 5, kind: "turn", phase: "end" });
		expect(state.turn).toBe("idle");
		// failed 不被翻回 done，running 的翻为 done
		expect(state.agents.find((a) => a.agentId === "worker-1")?.status).toBe(
			"failed",
		);
		expect(state.agents.find((a) => a.agentId === "task-2")?.status).toBe(
			"done",
		);
	});
});

describe("reduce：幂等去重", () => {
	it("相同 id 的 log 事件重复投递不产生重复条目", () => {
		let state = createInitialState();
		state = reduce(state, log(1, userMsg("u-1", "你好")));
		const before = state.transcript.length;
		// 重复投递（不同 seq，同事件 id）
		state = reduce(state, log(2, userMsg("u-1", "你好")));
		state = reduce(state, log(3, userMsg("u-1", "你好")));
		expect(state.transcript.length).toBe(before);
	});
});

describe("reduce：delta 折叠与定格", () => {
	it("delta 累加进流式段；assistant_msg 到达后流式段定格清除", () => {
		let state = createInitialState();
		state = reduce(state, { seq: 1, kind: "turn", phase: "start" });
		state = reduce(state, {
			seq: 2,
			kind: "delta",
			agentId: "main",
			text: "你好",
		});
		state = reduce(state, {
			seq: 3,
			kind: "delta",
			agentId: "main",
			text: "，世界",
		});
		expect(state.streaming).toEqual({ agentId: "main", text: "你好，世界" });

		state = reduce(
			state,
			log(
				4,
				assistantMsg("a-1", "main", [
					{ type: "text", text: "你好，世界（定稿）" },
				]),
			),
		);
		expect(state.streaming).toBeNull();
		expect(
			state.transcript.some((t) => t.kind === "assistant" && t.id === "a-1"),
		).toBe(true);
	});

	it("turn(end) 清理流式段（LLM 失败等无 assistant_msg 定格的路径）", () => {
		let state = createInitialState();
		state = reduce(state, { seq: 1, kind: "turn", phase: "start" });
		state = reduce(state, {
			seq: 2,
			kind: "delta",
			agentId: "main",
			text: "半截回答",
		});
		expect(state.streaming).toEqual({ agentId: "main", text: "半截回答" });

		// 回合以 error 收尾（无 assistant_msg）：turn(end) 必须清掉残留流式段
		state = reduce(state, { seq: 3, kind: "turn", phase: "end" });
		expect(state.streaming).toBeNull();
	});

	it("log(error) 只清理出错 agent 自己的流式段", () => {
		let state = createInitialState();
		state = reduce(state, { seq: 1, kind: "turn", phase: "start" });
		state = reduce(state, {
			seq: 2,
			kind: "delta",
			agentId: "main",
			text: "main 回答中",
		});

		// worker 失败：main 的流式段保留
		state = reduce(state, {
			seq: 3,
			kind: "spawn",
			agentId: "worker-1",
			role: "worker",
			tier: "medium",
			task: "干活",
			parentAgentId: "main",
		});
		state = reduce(
			state,
			log(4, {
				type: "error",
				id: "err-1",
				ts,
				agentId: "worker-1",
				code: "LLM_ERROR",
				message: "模型调用失败",
			}),
		);
		expect(state.streaming).toEqual({ agentId: "main", text: "main 回答中" });
		expect(state.agents.find((a) => a.agentId === "worker-1")?.status).toBe(
			"failed",
		);

		// main 自己失败：流式段清除
		state = reduce(
			state,
			log(5, {
				type: "error",
				id: "err-2",
				ts,
				agentId: "main",
				code: "LLM_ERROR",
				message: "模型调用失败",
			}),
		);
		expect(state.streaming).toBeNull();
	});
});

describe("reduce：approval 登记与清除", () => {
	it("approval 事件登记 pendingApproval；approval/decided 清除", () => {
		let state = createInitialState();
		state = reduce(state, {
			seq: 1,
			kind: "approval",
			requestId: "req-1",
			approvalType: "tool",
			summary: "允许执行 rm -rf？",
		});
		expect(state.pendingApproval).toMatchObject({
			requestId: "req-1",
			approvalType: "tool",
			summary: "允许执行 rm -rf？",
		});

		state = reduce(
			state,
			log(2, {
				type: "approval/decided",
				id: "d-1",
				ts,
				requestId: "req-1",
				decision: "approved",
			}),
		);
		expect(state.pendingApproval).toBeNull();
	});

	it("turn(end) 兜底清除 pendingApproval", () => {
		let state = createInitialState();
		state = reduce(state, {
			seq: 1,
			kind: "approval",
			requestId: "req-9",
			approvalType: "plan",
			summary: "批准计划？",
			plan: "1. 先做 A",
		});
		state = reduce(state, { seq: 2, kind: "turn", phase: "end" });
		expect(state.pendingApproval).toBeNull();
	});
});

describe("reduce：usage 按 tier 累计", () => {
	it("两条不同 tier 的 assistant_msg 后 byTier 分组与 total 累加正确", () => {
		let state = createInitialState();
		expect(state.usage).toEqual({
			total: { input: 0, output: 0 },
			byTier: {},
		});
		state = reduce(
			state,
			log(
				1,
				assistantUsageMsg("a-1", "main", { input: 100, output: 50 }, "high"),
			),
		);
		state = reduce(
			state,
			log(
				2,
				assistantUsageMsg(
					"a-2",
					"worker-1",
					{ input: 40, output: 10 },
					"medium",
				),
			),
		);
		state = reduce(
			state,
			log(
				3,
				assistantUsageMsg("a-3", "main", { input: 60, output: 30 }, "high"),
			),
		);

		expect(state.usage.total).toEqual({ input: 200, output: 90 });
		expect(state.usage.byTier.high).toEqual({
			input: 160,
			output: 80,
			count: 2,
		});
		expect(state.usage.byTier.medium).toEqual({
			input: 40,
			output: 10,
			count: 1,
		});
	});

	it("tier 默认的 assistant_msg 计入 high（与 core 默认语义一致）", () => {
		let state = createInitialState();
		state = reduce(
			state,
			log(1, assistantUsageMsg("a-1", "main", { input: 10, output: 5 })),
		);
		expect(state.usage.byTier.high).toEqual({ input: 10, output: 5, count: 1 });
		expect(state.usage.total).toEqual({ input: 10, output: 5 });
	});

	it("相同 id 的 assistant_msg 重复投递不重复累计（幂等）", () => {
		let state = createInitialState();
		const event = assistantUsageMsg(
			"a-1",
			"main",
			{ input: 100, output: 50 },
			"high",
		);
		state = reduce(state, log(1, event));
		state = reduce(state, log(2, event)); // 同 id 不同 seq 的重复投递
		expect(state.usage.total).toEqual({ input: 100, output: 50 });
		expect(state.usage.byTier.high).toEqual({
			input: 100,
			output: 50,
			count: 1,
		});
	});
});

describe("reduce：plan 卡片与正文去重", () => {
	const planText = "PLAN: (1) add auth (2) add login.";

	it("plan(drafted) 按 messageIds 移除已存在的计划正文 assistant", () => {
		let state = createInitialState();
		state = reduce(state, log(1, userMsg("u-1", "给项目加认证")));
		state = reduce(
			state,
			log(
				2,
				assistantMsg("a-plan", "main", [{ type: "text", text: planText }]),
			),
		);
		expect(
			state.transcript.some((t) => t.kind === "assistant" && t.id === "a-plan"),
		).toBe(true);

		state = reduce(state, {
			seq: 3,
			kind: "plan",
			phase: "drafted",
			plan: planText,
			messageIds: ["a-plan"],
		});
		expect(
			state.transcript.some((t) => t.kind === "assistant" && t.id === "a-plan"),
		).toBe(false);
		expect(
			state.transcript.some((t) => t.kind === "plan" && t.plan === planText),
		).toBe(true);
		expect(state.pendingPlan?.plan).toBe(planText);
	});

	it("plan 事件先于 assistant 日志到达时，后到的正文同样不渲染", () => {
		let state = createInitialState();
		state = reduce(state, {
			seq: 1,
			kind: "plan",
			phase: "drafted",
			plan: planText,
			messageIds: ["a-plan"],
		});
		state = reduce(
			state,
			log(
				2,
				assistantMsg("a-plan", "main", [{ type: "text", text: planText }]),
			),
		);
		expect(
			state.transcript.some((t) => t.kind === "assistant" && t.id === "a-plan"),
		).toBe(false);
		expect(state.hiddenPlanMessageIds).toContain("a-plan");
	});

	it("plan 型 approval 广播由 plan 卡片承担，不重复落审计条目", () => {
		let state = createInitialState();
		state = reduce(state, {
			seq: 1,
			kind: "approval",
			requestId: "req-plan",
			approvalType: "plan",
			summary: "执行计划",
			plan: planText,
		});
		expect(state.transcript).toEqual([]);
		expect(state.pendingApproval).toBeNull();

		state = reduce(state, {
			seq: 2,
			kind: "plan",
			phase: "drafted",
			plan: planText,
		});
		state = reduce(state, { seq: 3, kind: "plan", phase: "approved" });
		expect(state.pendingPlan).toBeNull();
		expect(state.pendingApproval).toBeNull();
	});
});

describe("reduce：internal_msg 与 plan 审计条目", () => {
	it("internal_msg 不进入 transcript", () => {
		let state = createInitialState();
		state = reduce(
			state,
			log(1, {
				type: "internal_msg",
				id: "i-1",
				ts,
				agentId: "main",
				content: "Draft the implementation plan...",
			}),
		);
		expect(state.transcript).toEqual([]);
	});

	it("approval/asked 的 plan payload 归为 plan 类型且有可读 summary", () => {
		let state = createInitialState();
		state = reduce(
			state,
			log(1, {
				type: "approval/asked",
				id: "asked-1",
				ts,
				agentId: "main",
				payload: { kind: "plan", plan: "PLAN: do it" },
			}),
		);
		const entry = state.transcript.find((t) => t.kind === "approval");
		expect(entry).toMatchObject({
			kind: "approval",
			requestId: "asked-1",
			approvalType: "plan",
			summary: "执行计划",
		});
	});
});

// M4 Feature②：steer/queue 队列折叠与快照覆盖
describe("inbox 队列（M4）", () => {
	function spliced(
		id: string,
		queue: "next-turn" | "next-step",
		messages: { id: string; content: string }[],
	): SessionEvent {
		return { type: "inbox/spliced", id, ts, agentId: "main", queue, messages };
	}

	it("inbox/spliced 按队列整体替换并按消息 id 去重，两队列互不影响", () => {
		let state = createInitialState();
		state = reduce(
			state,
			log(1, spliced("e1", "next-step", [{ id: "m1", content: "a" }])),
		);
		state = reduce(
			state,
			log(
				2,
				spliced("e2", "next-step", [
					{ id: "m1", content: "a" },
					{ id: "m2", content: "b" },
				]),
			),
		);
		expect(state.inbox.nextStep.map((m) => m.id)).toEqual(["m1", "m2"]);

		// last write wins：新快照里已被消费的 m1 消失
		state = reduce(
			state,
			log(3, spliced("e3", "next-step", [{ id: "m2", content: "b" }])),
		);
		expect(state.inbox.nextStep.map((m) => m.id)).toEqual(["m2"]);

		state = reduce(
			state,
			log(4, spliced("e4", "next-turn", [{ id: "n1", content: "later" }])),
		);
		expect(state.inbox.nextTurn.map((m) => m.id)).toEqual(["n1"]);
		expect(state.inbox.nextStep.map((m) => m.id)).toEqual(["m2"]);
	});

	it("applyInboxSnapshot 覆盖两队列（消费后修正展示），且为拷贝语义", () => {
		let state = createInitialState();
		state = reduce(
			state,
			log(1, spliced("e1", "next-step", [{ id: "m1", content: "a" }])),
		);
		const snapshot = {
			nextTurn: [{ id: "n1", content: "later" }],
			nextStep: [],
		};
		state = applyInboxSnapshot(state, snapshot);
		expect(state.inbox).toEqual(snapshot);
		snapshot.nextTurn.push({ id: "n2", content: "外部改写" });
		expect(state.inbox.nextTurn).toHaveLength(1);
	});

	it("M4 新增事件不进入主对话投影（幂等去重后原样返回）", () => {
		let state = createInitialState();
		const events: SessionEvent[] = [
			{
				type: "todo/set",
				id: "t1",
				ts,
				agentId: "worker-1",
				todos: [{ content: "x", status: "pending" }],
			},
			{
				type: "hook/fired",
				id: "h1",
				ts,
				hook: "pre_tool",
				command: "exit 0",
				exitCode: 0,
				durationMs: 1,
			},
			{
				type: "skill/loaded",
				id: "s1",
				ts,
				agentId: "worker-1",
				skill: "commit",
				path: "/x/SKILL.md",
			},
			{
				type: "prompt/invoked",
				id: "p1",
				ts,
				agentId: "main",
				name: "commit",
				args: "",
				content: "body",
			},
			{
				type: "mcp/attached",
				id: "m1",
				ts,
				server: "fs",
				transport: "stdio",
				tools: ["mcp__fs__read"],
			},
		];
		for (const event of events) {
			state = reduce(state, log(1, event));
		}
		expect(state.transcript).toEqual([]);
		expect(state.inbox).toEqual({ nextTurn: [], nextStep: [] });
		expect(state.seenEventIds).toHaveLength(events.length);
	});
});
