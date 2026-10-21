// plan 审批流（complex 流）测试：批准 / 批注修订 / 修订上限 / 拒绝 / spawn_workers 双分支门禁。
// 批准与拒绝走 runMainTurn 全流：main 首轮直接产出带 `# Plan` 标记的计划正文
// （初始轮复用，无 delegate）→ 起草/修订 → 执行。
// 批注与上限两条直接驱动 runPlanPhase（自建 TurnState，便于断言 state.revisions），
// 此时脚本只有 main 起草轮：每轮一个 textRound，plan 文本按轮次区分。
// 断言锚点：approval/decided 早于任何文件写工具 tool_result；asked/decided 落盘内容；
// 起草 internal_msg 携带批注；revision_exhausted 场景 asked 次数 == planMaxRevisions。

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
import { createInbox, type Inbox } from "../src/inbox/inbox.ts";
import { runMainTurn } from "../src/main-turn/main-turn.ts";
import { type PlanDecision, runPlanPhase } from "../src/plan/plan.ts";
import {
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";
import { createSpawnWorkersTool } from "../src/tools/spawn-workers.ts";
import type { OrchestrationEvent, TurnState } from "../src/types/types.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-plan-flow-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-plan-flow-proj-"));
	await writeFile(join(proj, "note.txt"), "hello hotpot\n", "utf8");
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

// 三档指向不同模型，worker 档位断言锚定 low=deepseek
const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

// 与 main-turn.test.ts 同款：scriptedAdapter 按全局 streamChat 调用序回放
async function makeRuntime(
	script: StreamEvent[][],
	approval: ApprovalChain,
	planMaxRevisions?: number,
	onCall?: (callIndex: number) => Promise<void> | void,
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
	let calls = 0;
	const adapter: LlmAdapter = {
		api: inner.api,
		streamChat(req, signal) {
			calls += 1;
			requests.push(req);
			const callIndex = calls;
			return (async function* (): AsyncGenerator<StreamEvent> {
				await onCall?.(callIndex);
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

function textRound(delta: string, usage: Usage): StreamEvent[] {
	return [
		{ type: "text_delta", delta },
		{ type: "usage", usage },
		{ type: "finish", reason: "stop" },
	];
}

function spawnWorkersRound(inputJson: string): StreamEvent[] {
	return toolCallRound("spawn_workers", "m-tc-2", inputJson);
}

// 第 n 版 plan 文本（# Plan 标记 + 三个必备段落；按轮次区分，便于断言 asked
// payload 与 drafted 事件携带哪一版）
function planText(n: number): string {
	return `# Plan

## Steps
1. PLAN v${n}: add auth routes
2. PLAN v${n}: add login page

## Files
auth.ts, login.tsx

## Acceptance criteria
tests pass (v${n})
`;
}

// complex 流的初始状态：首轮已产出计划正文（runPlanPhase 从会话日志复用草稿）
function planningState(): TurnState {
	return {
		phase: "planning",
		planApproved: false,
		revisions: 0,
	};
}

describe("plan 审批流（complex）", () => {
	it("批准路径：decided 早于任何文件写 tool_result，worker 执行后 main 收到聚合摘要", async () => {
		let approvalAsks = 0;
		const approval = new ApprovalChain();
		approval.use(() => {
			approvalAsks += 1;
			return Promise.resolve("next");
		});
		// 调用序：1=main 在初始轮产出 plan（plan 阶段直接复用，不再多跑一轮起草），
		// 2=main spawn_workers，3=worker 写 auth.ts（新文件，不触发审批），
		// 4=worker 摘要收尾，5=main 最终回复
		const { runtime, usages } = await makeRuntime(
			[
				textRound(planText(1), { input: 200, output: 60 }),
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

		// 审批回调拿到的是 main 起草的 plan 文本
		expect(seenPlans).toEqual([planText(1)]);

		// 编排事件：drafted 带 plan 文本与计划正文消息 id，随后 approved
		const drafted = events.find((e) => e.type === "plan");
		expect(drafted).toMatchObject({
			type: "plan",
			phase: "drafted",
			plan: planText(1),
		});
		if (drafted?.type !== "plan") throw new Error("drafted event missing");
		expect(drafted.messageIds).toHaveLength(1);

		// 初始轮计划被复用：不再产生第二次起草调用（plan + spawn + write +
		// worker 摘要 + main 收尾 = 5 次 streamChat）
		expect(usages).toHaveLength(5);
		const approvedIdx = events.findIndex(
			(e) => e.type === "plan" && e.phase === "approved",
		);
		expect(approvedIdx).toBeGreaterThan(-1);
		expect(events.some((e) => e.type === "error")).toBe(false);

		// main 收到 spawn_workers 聚合摘要（worker 跑了、摘要回传）
		const spawnResult = events.find(
			(e) => e.type === "tool_result" && e.name === "spawn_workers",
		);
		if (spawnResult?.type !== "tool_result") {
			throw new Error("spawn_workers tool_result missing");
		}
		expect(spawnResult.output.isError ?? false).toBe(false);
		expect(spawnResult.output.content).toContain(
			"Worker worker-1 (tier=high) result:",
		);
		expect(spawnResult.output.content).toContain("auth.ts");

		const { events: fileEvents } = await loadSession(runtime.session.filePath);

		// messageIds 精确指向初始轮产出计划正文的那条 main assistant_msg
		const planAssistant = fileEvents.find(
			(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
				e.type === "assistant_msg" &&
				e.agentId === "main" &&
				e.content.some(
					(b) => b.type === "text" && b.text.includes(planText(1)),
				),
		);
		expect(drafted.messageIds).toEqual([planAssistant?.id]);

		// 会话日志：asked 带 plan payload，decision=approved
		const asked = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "approval/asked" }> =>
				e.type === "approval/asked",
		);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({
			agentId: "main",
			payload: { kind: "plan", plan: planText(1) },
		});
		const decided = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "approval/decided" }> =>
				e.type === "approval/decided",
		);
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({ decision: "approved" });

		// 验收：第一个 approval/decided 早于任何文件写工具的 tool_result。
		// 会话不单独落 tool_call 事件：调用块在 assistant_msg.content 里，按 id 关联 tool_result
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
		expect(writeBlock?.id).toBeDefined();
		expect(firstDecidedIdx).toBeGreaterThan(-1);
		expect(firstWriteResultIdx).toBeGreaterThan(-1);
		expect(firstDecidedIdx).toBeLessThan(firstWriteResultIdx);

		// worker 确实 spawn 并执行：落盘 agent_spawn + assistant_msg（档位按参数 modelTier=high）
		const spawn = fileEvents.find((e) => e.type === "agent_spawn");
		expect(spawn).toMatchObject({
			agentId: "worker-1",
			parentAgentId: "main",
			role: "worker",
			tier: "high",
			task: "实现后端 auth 路由",
		});
		const workerMsgs = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
				e.type === "assistant_msg" && e.agentId === "worker-1",
		);
		expect(workerMsgs.length).toBeGreaterThan(0);
		expect(workerMsgs[workerMsgs.length - 1]?.model).toBe("claude-sonnet-4-5");

		// 批准后才有执行：初始计划不再触发额外起草；批准 kickoff 是 internal_msg
		const userMsgs = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "user_msg" }> =>
				e.type === "user_msg" && e.agentId === "main",
		);
		expect(
			userMsgs.some((m) => m.content.includes("Draft the implementation plan")),
		).toBe(false);
		const internalMsgs = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "internal_msg" }> =>
				e.type === "internal_msg" && e.agentId === "main",
		);
		expect(
			internalMsgs.some((m) =>
				m.content.includes(
					"Plan approved. Break the work down and call spawn_workers.",
				),
			),
		).toBe(true);
		// 初始轮已有计划且队列为空：没有额外起草提示
		expect(
			internalMsgs.some((m) =>
				m.content.includes("Draft the implementation plan"),
			),
		).toBe(false);
		expect(approvalAsks).toBe(0);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	it("plan 期间 steer：队列非空时先 reconcile，steer 在审批前进入模型历史", async () => {
		const approval = new ApprovalChain();
		let inbox: Inbox | null = null;
		// 调用序：1=初始 plan（此时用户 steer），2=reconcile 起草，
		// 3=拒绝后的收尾回复
		const { runtime, requests } = await makeRuntime(
			[
				textRound(planText(1), { input: 200, output: 60 }),
				textRound(planText(2), { input: 220, output: 60 }),
				textRound("好的，不做任何实现。", { input: 100, output: 20 }),
			],
			approval,
			undefined,
			async (callIndex) => {
				if (callIndex === 1) {
					if (inbox === null) throw new Error("inbox missing");
					await inbox.steer("改用 React 实现");
				}
			},
		);
		inbox = createInbox(runtime.session, "main");
		const plans: string[] = [];
		const events = await collect(
			runMainTurn({
				runtime,
				userMessage: "给项目加用户认证",
				signal: new AbortController().signal,
				mainTier: "high",
				inbox,
				onPlanApproval: (plan) => {
					plans.push(plan);
					return Promise.resolve<PlanDecision>({
						kind: "reject",
						note: "先不做了",
					});
				},
			}),
		);

		// 初始计划 v1 被 steer 触发 reconcile，最终审批的是 v2
		expect(plans).toEqual([planText(2)]);
		const drafted = events.find((e) => e.type === "plan");
		if (drafted?.type !== "plan") throw new Error("drafted event missing");
		expect(drafted.messageIds).toHaveLength(2);
		// 第 2 次请求（reconcile 起草）的模型历史包含 steer
		expect(JSON.stringify(requests[1]?.messages)).toContain("改用 React 实现");
		// plan 阶段不挂任何工具：请求里只有空工具列表
		expect(requests[1]?.tools).toEqual([]);

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(
			fileEvents.some(
				(e) =>
					e.type === "user_msg" &&
					e.agentId === "main" &&
					e.content === "改用 React 实现",
			),
		).toBe(true);
		// 队列已被消费
		expect(inbox.snapshot().nextStep).toHaveLength(0);
	});

	it("批注路径：annotate 两次后 approve，revisions === 2，起草请求携带批注，decided 带 note", async () => {
		const approval = new ApprovalChain();
		// 调用序：3 次起草轮（v1 被批注「加测试」→ v2 被批注「再改」→ v3 批准）
		const { runtime } = await makeRuntime(
			[
				textRound(planText(1), { input: 200, output: 60 }),
				textRound(planText(2), { input: 220, output: 60 }),
				textRound(planText(3), { input: 240, output: 60 }),
			],
			approval,
		);
		const state = planningState();
		const notes: string[] = [];
		const decisions: PlanDecision[] = [
			{ kind: "annotate", note: "加测试" },
			{ kind: "annotate", note: "再改" },
			{ kind: "approve" },
		];
		const events = await collect(
			runPlanPhase(runtime, state, new AbortController().signal, {
				onPlanApproval: (plan) => {
					notes.push(plan);
					const decision = decisions.shift();
					if (!decision) throw new Error("unexpected approval callback");
					return Promise.resolve(decision);
				},
			}),
		);

		expect(notes).toEqual([planText(1), planText(2), planText(3)]);
		// 两次批注计数；批准后 flip planApproved
		expect(state.revisions).toBe(2);
		expect(state.planApproved).toBe(true);
		expect(state.phase).toBe("executing");

		// 每轮起草一个 drafted 事件，最后一轮后 approved；无 revision_exhausted
		const drafted = events.filter(
			(e) => e.type === "plan" && e.phase === "drafted",
		);
		expect(
			drafted.map((e) => (e.type === "plan" ? e.plan : undefined)),
		).toEqual([planText(1), planText(2), planText(3)]);
		expect(
			events.some((e) => e.type === "plan" && e.phase === "approved"),
		).toBe(true);
		expect(
			events.some((e) => e.type === "plan" && e.phase === "revision_exhausted"),
		).toBe(false);

		const { events: fileEvents } = await loadSession(runtime.session.filePath);

		// 3 轮起草 = 3 对 asked/decided；asked payload 按顺序携带各版 plan
		const asked = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "approval/asked" }> =>
				e.type === "approval/asked",
		);
		expect(asked.map((e) => e.payload.plan)).toEqual([
			planText(1),
			planText(2),
			planText(3),
		]);
		const decided = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "approval/decided" }> =>
				e.type === "approval/decided",
		);
		expect(decided).toHaveLength(3);
		expect(decided.map((e) => e.decision)).toEqual([
			"denied",
			"denied",
			"approved",
		]);
		// 批注以 note 落在 denied 的 decided 上
		expect(decided[0]?.note).toBe("加测试");
		expect(decided[1]?.note).toBe("再改");

		// 起草请求（main 的 internal_msg）携带批注内容，驱动修订版 plan；
		// 内部提示不再污染 user_msg，UI 不会出现伪造的用户消息
		const draftingMsgs = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "internal_msg" }> =>
				e.type === "internal_msg" &&
				e.agentId === "main" &&
				e.content.includes("Output ONLY"),
		);
		expect(draftingMsgs).toHaveLength(3);
		expect(draftingMsgs[0]?.content).toContain("Draft the implementation plan");
		expect(draftingMsgs[1]?.content).toContain("加测试");
		expect(draftingMsgs[2]?.content).toContain("再改");
	});

	it("修订上限：planMaxRevisions=3，连续 annotate，第 4 次起草后 revision_exhausted，只有 3 次 asked", async () => {
		const approval = new ApprovalChain();
		// 4 次起草轮：v1..v4，回调始终 annotate；第 4 次批注触发超限，不再 asked
		const { runtime } = await makeRuntime(
			[
				textRound(planText(1), { input: 200, output: 60 }),
				textRound(planText(2), { input: 220, output: 60 }),
				textRound(planText(3), { input: 240, output: 60 }),
				textRound(planText(4), { input: 260, output: 60 }),
			],
			approval,
		);
		const state = planningState();
		const events = await collect(
			runPlanPhase(runtime, state, new AbortController().signal, {
				onPlanApproval: () =>
					Promise.resolve<PlanDecision>({
						kind: "annotate",
						note: "还不够",
					}),
			}),
		);

		// 第 4 次起草照常发生（drafted v4），其批注触发超限后 revision_exhausted
		const drafted = events.filter(
			(e) => e.type === "plan" && e.phase === "drafted",
		);
		expect(drafted).toHaveLength(4);
		expect(
			events.some((e) => e.type === "plan" && e.phase === "revision_exhausted"),
		).toBe(true);
		expect(
			events.some((e) => e.type === "plan" && e.phase === "approved"),
		).toBe(false);
		expect(state.planApproved).toBe(false);
		expect(state.revisions).toBe(4);

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		// 全程只有 3 次 approval/asked；超限轮不 asked、decided
		expect(fileEvents.filter((e) => e.type === "approval/asked")).toHaveLength(
			3,
		);
		expect(
			fileEvents.filter((e) => e.type === "approval/decided"),
		).toHaveLength(3);
		// 超限说明以 internal_msg 落盘给 main，结束本轮 plan 流程
		expect(
			fileEvents.some(
				(e) =>
					e.type === "internal_msg" &&
					e.agentId === "main" &&
					e.content.includes("revision limit"),
			),
		).toBe(true);
	});

	it("拒绝路径：reject 后无 spawn_workers 执行、无 worker agent_spawn", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=main 在初始轮产出 plan，2=main 收到拒绝提示后收尾回复用户
		const { runtime } = await makeRuntime(
			[
				textRound(planText(1), { input: 200, output: 60 }),
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
					Promise.resolve<PlanDecision>({
						kind: "reject",
						note: "不需要做了",
					}),
			}),
		);

		// denied 事件后 main 跑收尾轮回复用户
		expect(events.some((e) => e.type === "plan" && e.phase === "denied")).toBe(
			true,
		);
		expect(
			events.some((e) => e.type === "plan" && e.phase === "approved"),
		).toBe(false);
		const text = events
			.filter((e) => e.type === "text")
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("不做任何实现");
		expect(
			events.some(
				(e) => e.type === "tool_result" && e.name === "spawn_workers",
			),
		).toBe(false);
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		// 无 worker 派生、无文件写；拒绝决定带 note 落盘
		expect(fileEvents.some((e) => e.type === "agent_spawn")).toBe(false);
		const decided = fileEvents.find((e) => e.type === "approval/decided");
		expect(decided).toMatchObject({ decision: "denied", note: "不需要做了" });
		expect(
			fileEvents.some(
				(e) =>
					e.type === "internal_msg" &&
					e.agentId === "main" &&
					e.content.includes("Plan rejected by user."),
			),
		).toBe(true);
	});

	it("守卫：本回合已产出计划标记（未批准）时 spawn_workers 返回 isError，不产生 agent_spawn", async () => {
		const approval = new ApprovalChain();
		const { runtime } = await makeRuntime([], approval);
		// 首轮产物：user_msg + 带 # Plan 标记的计划正文（detectPlanDraft 命中）
		await runtime.session.append({
			type: "user_msg",
			id: "u-1",
			ts: new Date().toISOString(),
			agentId: "main",
			content: "给项目加用户认证",
		});
		await runtime.session.append({
			type: "assistant_msg",
			id: "a-1",
			ts: new Date().toISOString(),
			agentId: "main",
			content: [{ type: "text", text: planText(1) }],
			usage: { input: 200, output: 60 },
			model: "claude-sonnet-4-5",
			tier: "high",
		});
		const state: TurnState = {
			phase: "planning",
			planApproved: false,
			revisions: 0,
		};
		const tool = createSpawnWorkersTool(runtime, state);
		const out = await tool.execute(
			{ workers: [{ task: "实现 auth 路由", modelTier: "low" }] },
			{
				cwd: proj,
				signal: new AbortController().signal,
				approval,
				agentId: "main",
				session: runtime.session,
			},
		);
		expect(out.isError).toBe(true);
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(fileEvents.some((e) => e.type === "agent_spawn")).toBe(false);
	});

	it("放行：本回合无计划标记（simple 首轮直派）时 spawn_workers 正常 spawn worker", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=worker 摘要轮（execute 内联跑完该 worker turn）
		const { runtime } = await makeRuntime(
			[textRound("auth 路由完成。", { input: 300, output: 60 })],
			approval,
		);
		const state: TurnState = {
			phase: "initial",
			planApproved: false,
			revisions: 0,
		};
		const tool = createSpawnWorkersTool(runtime, state);
		const out = await tool.execute(
			{ workers: [{ task: "实现 auth 路由", modelTier: "low" }] },
			{
				cwd: proj,
				signal: new AbortController().signal,
				approval,
				agentId: "main",
				session: runtime.session,
			},
		);
		expect(out.isError ?? false).toBe(false);
		expect(out.content).toContain("Worker worker-1 (tier=low) result:");
		expect(out.content).toContain("auth 路由完成");
		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		expect(
			fileEvents.some(
				(e) => e.type === "agent_spawn" && e.agentId === "worker-1",
			),
		).toBe(true);
	});

	it("批准后 spawn_workers：按 modelTier 逐个 spawn worker 并聚合摘要", async () => {
		const approval = new ApprovalChain();
		// 调用序：1=worker-1 摘要轮，2=worker-2 摘要轮（execute 内联跑完两个 worker turn）
		const { runtime } = await makeRuntime(
			[
				textRound("auth 路由完成。", { input: 300, output: 60 }),
				textRound("登录页完成。", { input: 300, output: 60 }),
			],
			approval,
		);
		const state: TurnState = {
			phase: "executing",
			planApproved: true,
			revisions: 0,
		};
		const tool = createSpawnWorkersTool(runtime, state);
		const out = await tool.execute(
			{
				workers: [
					{ task: "实现 auth 路由", modelTier: "low" },
					{ task: "实现登录页", context: "用 React", modelTier: "medium" },
				],
			},
			{
				cwd: proj,
				signal: new AbortController().signal,
				approval,
				agentId: "main",
				session: runtime.session,
			},
		);
		expect(out.isError ?? false).toBe(false);
		// 聚合摘要：两个 worker 各一段
		expect(out.content).toContain("Worker worker-1 (tier=low) result:");
		expect(out.content).toContain("auth 路由完成");
		expect(out.content).toContain("Worker worker-2 (tier=medium) result:");
		expect(out.content).toContain("登录页完成");

		const { events: fileEvents } = await loadSession(runtime.session.filePath);
		const spawns = fileEvents.filter((e) => e.type === "agent_spawn");
		expect(spawns).toHaveLength(2);
		expect(spawns[0]).toMatchObject({
			agentId: "worker-1",
			role: "worker",
			tier: "low",
			task: "实现 auth 路由",
		});
		expect(spawns[1]).toMatchObject({
			agentId: "worker-2",
			role: "worker",
			tier: "medium",
			task: "实现登录页",
		});
		// context 折进 worker 的 user_msg
		const worker2Msg = fileEvents.find(
			(e): e is Extract<SessionEvent, { type: "user_msg" }> =>
				e.type === "user_msg" && e.agentId === "worker-2",
		);
		expect(worker2Msg?.content).toContain("用 React");
	});
});
