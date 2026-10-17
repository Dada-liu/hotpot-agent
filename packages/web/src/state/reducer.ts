// 会话 UI 状态的纯函数归约：WireEvent 流 → ChatState。
// 不依赖 DOM/React，node 下可单测。核心规则：
// - transcript 只收 main 的 user_msg；assistant_msg 的工具块落成工具卡片，
//   tool_result 按 toolCallId + agentId 配对回填
// - agent 树由 spawn / log(agent_spawn) 登记；log(error) 或父级 tool_result
//   内容含 "[FAILED] <agentId>" 标记 failed；turn(end) 把仍 running 的翻为 done
// - log 事件按 event.id 去重（tailer 重放/断线补发会重复投递）
// - delta 只累加进当前流式段；assistant_msg 到达后流式段定格（以 content 为准）

import type { ContentBlock, SessionEvent, WireEvent } from "../protocol.ts";

export type AgentStatus = "running" | "done" | "failed";

// agent 树节点：spawn / log(agent_spawn) 登记
export interface AgentNode {
	agentId: string;
	role: "worker" | "task";
	tier: string;
	task: string;
	parentAgentId: string;
	status: AgentStatus;
	// 最近一个尚未收到结果的工具名
	currentTool?: string;
	lastEventAt: string;
}

// transcript 条目（主对话投影：用户/助手消息、工具卡片、plan 卡片、审批痕迹、错误）
export type TranscriptEntry =
	| { kind: "user"; id: string; ts: string; agentId: string; content: string }
	| {
			kind: "assistant";
			id: string;
			ts: string;
			agentId: string;
			content: ContentBlock[];
	  }
	| {
			kind: "tool";
			id: string;
			ts: string;
			agentId: string;
			toolCallId: string;
			name: string;
			input: unknown;
			result?: { content: string; isError: boolean };
	  }
	| {
			kind: "plan";
			id: string;
			ts: string;
			phase: "drafted" | "approved" | "denied" | "revision_exhausted";
			plan?: string;
	  }
	| {
			kind: "approval";
			id: string;
			ts: string;
			requestId: string;
			approvalType: "tool" | "plan";
			summary: string;
			decision?: "approved" | "denied";
			note?: string;
	  }
	| {
			kind: "error";
			id: string;
			ts: string;
			agentId: string;
			code: string;
			message: string;
	  };

// 待用户处理的审批请求（approval 事件登记，decided 日志或 turn(end) 清除）
export interface PendingApproval {
	requestId: string;
	approvalType: "tool" | "plan";
	summary: string;
	detail?: string;
	plan?: string;
}

export interface PendingPlan {
	entryId: string;
	plan?: string;
}

// 当前流式段：delta 累加；assistant_msg 到达后定格清除
export interface StreamingSegment {
	agentId: string;
	text: string;
}

export interface ChatState {
	transcript: TranscriptEntry[];
	agents: AgentNode[];
	streaming: StreamingSegment | null;
	pendingApproval: PendingApproval | null;
	pendingPlan: PendingPlan | null;
	turn: "idle" | "running";
	// agent 面板：首个 spawn 到达即展开
	panelOpen: boolean;
	// token 用量累计：log(assistant_msg) 时累加（含历史重放，幂等去重保证不重复计）
	usage: { input: number; output: number };
	// 已见过的 log 事件 id（幂等去重）
	seenEventIds: string[];
}

export function createInitialState(): ChatState {
	return {
		transcript: [],
		agents: [],
		streaming: null,
		pendingApproval: null,
		pendingPlan: null,
		turn: "idle",
		panelOpen: false,
		usage: { input: 0, output: 0 },
		seenEventIds: [],
	};
}

export function reduce(state: ChatState, event: WireEvent): ChatState {
	switch (event.kind) {
		case "log":
			return reduceLog(state, event.event);
		case "delta": {
			// 只累加当前 agent 的流式段（delta 目前仅 main 产出）
			const base =
				state.streaming?.agentId === event.agentId ? state.streaming.text : "";
			return {
				...state,
				streaming: { agentId: event.agentId, text: base + event.text },
			};
		}
		case "turn": {
			if (event.phase === "start") {
				return { ...state, turn: "running" };
			}
			// 回合结束：仍 running 的翻为 done（failed 不回退），并兜底清掉 pending
			return {
				...state,
				turn: "idle",
				pendingApproval: null,
				pendingPlan: null,
				agents: state.agents.map((a) =>
					a.status === "running" ? { ...a, status: "done" as const } : a,
				),
			};
		}
		case "plan":
			return reducePlan(state, event);
		case "spawn":
			return {
				...state,
				panelOpen: true,
				agents: upsertAgent(state.agents, {
					agentId: event.agentId,
					role: event.role,
					tier: event.tier,
					task: event.task,
					parentAgentId: event.parentAgentId,
					lastEventAt: "",
				}),
			};
		case "approval": {
			// 登记待审批并落一条审计痕迹；plan 审批同时占据 pendingPlan 槽位
			const entry: TranscriptEntry = {
				kind: "approval",
				id: `approval:${event.requestId}`,
				ts: "",
				requestId: event.requestId,
				approvalType: event.approvalType,
				summary: event.summary,
			};
			return {
				...state,
				transcript: [...state.transcript, entry],
				pendingApproval: {
					requestId: event.requestId,
					approvalType: event.approvalType,
					summary: event.summary,
					detail: event.detail,
					plan: event.plan,
				},
			};
		}
	}
}

function reduceLog(state: ChatState, event: SessionEvent): ChatState {
	// meta 无 id，忽略（不记录会话信息）
	if (event.type === "meta") {
		return state;
	}
	// 幂等：同 id 重复投递直接返回
	if (state.seenEventIds.includes(event.id)) {
		return state;
	}
	state = { ...state, seenEventIds: [...state.seenEventIds, event.id] };

	switch (event.type) {
		case "user_msg": {
			// 只收 main 的 user_msg（steer 注入同样落 user_msg，归属 main）
			if (event.agentId !== "main") {
				return state;
			}
			const entry: TranscriptEntry = {
				kind: "user",
				id: event.id,
				ts: event.ts,
				agentId: event.agentId,
				content: event.content,
			};
			return { ...state, transcript: [...state.transcript, entry] };
		}
		case "assistant_msg": {
			// 工具块落成工具卡片；最后一个 in-flight 工具名记到 agent.currentTool
			const toolEntries: TranscriptEntry[] = [];
			let currentTool: string | undefined;
			for (const block of event.content) {
				if (block.type === "tool_call") {
					currentTool = block.name;
					toolEntries.push({
						kind: "tool",
						id: block.id,
						ts: event.ts,
						agentId: event.agentId,
						toolCallId: block.id,
						name: block.name,
						input: block.input,
					});
				}
			}
			const assistantEntry: TranscriptEntry = {
				kind: "assistant",
				id: event.id,
				ts: event.ts,
				agentId: event.agentId,
				content: event.content,
			};
			return {
				...state,
				// 工具块落成工具卡片；usage 累计进面板用量条
				usage: event.usage
					? {
							input: state.usage.input + event.usage.input,
							output: state.usage.output + event.usage.output,
						}
					: state.usage,
				transcript: [...state.transcript, assistantEntry, ...toolEntries],
				// 流式段定格：durable 消息已落 transcript，以 content 为准
				streaming:
					state.streaming?.agentId === event.agentId ? null : state.streaming,
				agents:
					currentTool === undefined
						? touchAgent(state.agents, event.agentId, event.ts, (a) => a)
						: touchAgent(state.agents, event.agentId, event.ts, (a) => ({
								...a,
								currentTool,
							})),
			};
		}
		case "tool_result": {
			const agentId = event.agentId ?? "main";
			// 配对回填工具卡片
			const transcript = state.transcript.map((t) =>
				t.kind === "tool" &&
				t.toolCallId === event.toolCallId &&
				t.agentId === agentId
					? { ...t, result: { content: event.content, isError: event.isError } }
					: t,
			);
			// 父级工具结束，清除其 currentTool
			let agents = touchAgent(state.agents, agentId, event.ts, (a) => ({
				...a,
				currentTool: undefined,
			}));
			// failed 启发：结果内容含 "[FAILED] <agentId>" 时子 agent 标记 failed
			for (const agent of agents) {
				if (
					agent.status !== "failed" &&
					event.content.includes(`[FAILED] ${agent.agentId}`)
				) {
					agents = agents.map((a) =>
						a.agentId === agent.agentId
							? { ...a, status: "failed" as const }
							: a,
					);
				}
			}
			return { ...state, transcript, agents };
		}
		case "agent_spawn":
			return {
				...state,
				panelOpen: true,
				agents: upsertAgent(state.agents, {
					agentId: event.agentId,
					role: event.role === "task" ? "task" : "worker",
					tier: event.tier,
					task: event.task,
					parentAgentId: event.parentAgentId,
					lastEventAt: event.ts,
				}),
			};
		case "approval/asked": {
			// 审计痕迹：payload.requestId 可关联到对应审批条目
			const requestId =
				typeof event.payload.requestId === "string"
					? event.payload.requestId
					: event.id;
			const entry: TranscriptEntry = {
				kind: "approval",
				id: event.id,
				ts: event.ts,
				requestId,
				approvalType: "tool",
				summary:
					typeof event.payload.summary === "string"
						? event.payload.summary
						: "",
			};
			return { ...state, transcript: [...state.transcript, entry] };
		}
		case "approval/decided": {
			// 清除对应 pending；回填审批条目的决定
			const transcript = state.transcript.map((t) =>
				t.kind === "approval" && t.requestId === event.requestId
					? { ...t, decision: event.decision, note: event.note }
					: t,
			);
			const pendingApproval =
				state.pendingApproval?.requestId === event.requestId
					? null
					: state.pendingApproval;
			const pendingPlan =
				state.pendingApproval?.requestId === event.requestId &&
				state.pendingApproval.approvalType === "plan"
					? null
					: state.pendingPlan;
			return { ...state, transcript, pendingApproval, pendingPlan };
		}
		case "inbox/spliced":
			// steer 队列事件与主对话渲染无关，忽略
			return state;
		case "error": {
			const entry: TranscriptEntry = {
				kind: "error",
				id: event.id,
				ts: event.ts,
				agentId: event.agentId,
				code: event.code,
				message: event.message,
			};
			return {
				...state,
				transcript: [...state.transcript, entry],
				agents: touchAgent(state.agents, event.agentId, event.ts, (a) => ({
					...a,
					status: "failed",
				})),
			};
		}
	}
}

function reducePlan(
	state: ChatState,
	event: Extract<WireEvent, { kind: "plan" }>,
): ChatState {
	if (event.phase === "drafted") {
		const entryId = `plan:${event.seq}`;
		const entry: TranscriptEntry = {
			kind: "plan",
			id: entryId,
			ts: "",
			phase: "drafted",
			plan: event.plan,
		};
		return {
			...state,
			transcript: [...state.transcript, entry],
			pendingPlan: { entryId, plan: event.plan },
		};
	}
	// approved/denied/revision_exhausted：回填 plan 卡片并清除 pending
	const transcript = state.transcript.map((t) =>
		t.kind === "plan" && state.pendingPlan && t.id === state.pendingPlan.entryId
			? { ...t, phase: event.phase }
			: t,
	);
	return { ...state, transcript, pendingPlan: null };
}

// 登记或刷新 agent 节点（按 agentId 去重，重复 spawn 不新增）
function upsertAgent(
	agents: AgentNode[],
	init: Omit<AgentNode, "status" | "currentTool">,
): AgentNode[] {
	if (agents.some((a) => a.agentId === init.agentId)) {
		return agents.map((a) =>
			a.agentId === init.agentId ? { ...a, ...init } : a,
		);
	}
	return [...agents, { ...init, status: "running" as const }];
}

// 触碰某个 agent：更新 lastEventAt 并套用修改；节点不存在则忽略
function touchAgent(
	agents: AgentNode[],
	agentId: string,
	ts: string,
	fn: (a: AgentNode) => AgentNode,
): AgentNode[] {
	return agents.map((a) =>
		a.agentId === agentId ? { ...fn(a), lastEventAt: ts } : a,
	);
}
