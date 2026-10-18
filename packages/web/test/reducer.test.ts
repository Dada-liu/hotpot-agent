// reducer 测试：spawn 登记 → 工具事件归属 → failed 启发 → turn(end) 状态翻转 →
// 幂等去重 → delta 折叠定格 → approval 登记/清除 → panelOpen。
// 事件构造走协议形状（protocol.ts 镜像 server wire.ts）。

import { describe, expect, it } from "vitest";
import type { ContentBlock, SessionEvent, WireEvent } from "../src/protocol.ts";
import { createInitialState, reduce } from "../src/state/reducer.ts";

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

// 带 usage/tier 的 assistant_msg（tier 缺省时构造体不含该字段，走缺省语义）
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

	it("tier 缺省的 assistant_msg 计入 high（与 core 缺省语义一致）", () => {
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
