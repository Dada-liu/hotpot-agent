// plan 审批流（complex 任务的 human-in-the-loop 修订循环，编排文档 §3）。
// 每轮：起草 runTurn（user_msg 提示起草，批注轮携带批注内容）→ 取 main 最后一条
// assistant_msg 文本为 plan → yield drafted → await onPlanApproval（缺省 fail-closed 拒绝）
// → 按决定分流：
//   approve  → 落盘 asked/decided(approved)，state.planApproved/phase 翻转，yield approved，
//              追加执行 kickoff user_msg 后返回（main-turn 接着跑执行 turn）
//   annotate → revisions++；revisions > planMaxRevisions 时 yield revision_exhausted、
//              落盘说明并结束（不再 asked —— 超限轮的 asked/decided 不落盘）；
//              否则 decided(denied, note=批注) 落盘后带批注进入下一轮修订
//   reject   → decided(denied, note=拒绝理由) 落盘，yield denied，追加拒绝提示，
//              跑一轮收尾 runTurn（main 回复用户）后结束
// asked/decided 在拿到决定后落盘：asked payload {kind:"plan", plan}，
// 超限场景 asked 总数 == planMaxRevisions（第 planMaxRevisions+1 次起草不再询问）。

import { randomUUID } from "node:crypto";
import {
	type LoopConfig,
	loadSession,
	type ModelTier,
	runTurn,
} from "@hotpot/core";
import { buildRoleSystemPrompt } from "./prompts.ts";
import { createRoleRegistry } from "./registries.ts";
import type { OrchestrationRuntime } from "./runtime.ts";
import { createDelegateTool, type TurnState } from "./tools/delegate.ts";
import { createSpawnWorkersTool } from "./tools/spawn-workers.ts";
import type { OrchestrationEvent } from "./types.ts";

export type PlanDecision =
	| { kind: "approve" }
	| { kind: "reject"; note: string }
	| { kind: "annotate"; note: string };

// 主agent 的 agentId 固定为 "main"：与 main-turn.ts 的 MAIN_AGENT_ID 是同一包级约定
const MAIN_AGENT_ID = "main";

// 首轮起草提示：要求只输出 plan 文本，便于整条 assistant 消息直接作为 plan 回收
const DRAFT_PROMPT =
	"Draft the implementation plan for the approved scope: steps, files involved, " +
	"acceptance criteria. Output ONLY the plan.";

// 读取 main 最后一条 assistant_msg，拼接其文本块作为本轮 plan 草稿
async function readMainPlanText(
	runtime: OrchestrationRuntime,
): Promise<string> {
	const { events } = await loadSession(runtime.session.filePath);
	const messages = events.filter(
		(e) => e.type === "assistant_msg" && e.agentId === MAIN_AGENT_ID,
	);
	const last = messages[messages.length - 1];
	if (last?.type !== "assistant_msg") return "";
	return last.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
}

export async function* runPlanPhase(
	runtime: OrchestrationRuntime,
	state: TurnState,
	signal: AbortSignal,
	onPlanApproval?: (plan: string) => Promise<PlanDecision>,
): AsyncIterable<OrchestrationEvent> {
	// 起草/收尾轮与执行轮同款注册表：main 只挂 delegate + spawn_workers 元工具。
	// 起草期 planApproved 仍为 false，spawn_workers 被守卫挡住，不会提前执行
	const delegateTool = createDelegateTool(runtime, state);
	const spawnWorkersTool = createSpawnWorkersTool(runtime, state);
	const registry = createRoleRegistry(MAIN_AGENT_ID, [
		delegateTool,
		spawnWorkersTool,
	]);
	// 起草轮沿用 delegate 判定的档位（complex 固定 high），缺省回退 high
	const tier: ModelTier = state.lastDelegate?.modelTier ?? "high";
	const resolved = runtime.resolveModel(tier);
	const cfg: LoopConfig = {
		session: runtime.session,
		agentId: MAIN_AGENT_ID,
		adapter: resolved.adapter,
		model: resolved.model,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		registry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt(MAIN_AGENT_ID, {
			cwd: runtime.cwd,
			os: process.platform,
			date: new Date().toISOString().slice(0, 10),
			tools: registry.declarations(),
		}),
		tier,
	};

	let annotation: string | undefined;
	while (true) {
		const draftingPrompt =
			annotation === undefined
				? DRAFT_PROMPT
				: `The user annotated the previous plan: "${annotation}". Revise the plan ` +
					"accordingly. Output ONLY the revised plan.";
		await runtime.session.append({
			type: "user_msg",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId: MAIN_AGENT_ID,
			content: draftingPrompt,
		});
		for await (const event of runTurn(cfg, signal)) {
			yield event;
		}
		if (signal.aborted) return;

		const plan = await readMainPlanText(runtime);
		yield { type: "plan", phase: "drafted", plan };
		const decision: PlanDecision = onPlanApproval
			? await onPlanApproval(plan)
			: { kind: "reject", note: "no approval handler" };

		if (decision.kind === "annotate") {
			state.revisions += 1;
			if (state.revisions > runtime.planMaxRevisions) {
				// 修订耗尽：第 planMaxRevisions+1 次批注直接结束，不再 asked/起草
				yield { type: "plan", phase: "revision_exhausted" };
				await runtime.session.append({
					type: "user_msg",
					id: randomUUID(),
					ts: new Date().toISOString(),
					agentId: MAIN_AGENT_ID,
					content:
						`Plan revision limit reached (${String(runtime.planMaxRevisions)} ` +
						"revisions allowed). The plan is not approved; stop planning and " +
						"tell the user.",
				});
				return;
			}
		}

		const askedId = randomUUID();
		await runtime.session.append({
			type: "approval/asked",
			id: askedId,
			ts: new Date().toISOString(),
			agentId: MAIN_AGENT_ID,
			payload: { kind: "plan", plan },
		});

		if (decision.kind === "approve") {
			await runtime.session.append({
				type: "approval/decided",
				id: randomUUID(),
				ts: new Date().toISOString(),
				requestId: askedId,
				decision: "approved",
			});
			state.planApproved = true;
			state.phase = "executing";
			yield { type: "plan", phase: "approved" };
			await runtime.session.append({
				type: "user_msg",
				id: randomUUID(),
				ts: new Date().toISOString(),
				agentId: MAIN_AGENT_ID,
				content: "Plan approved. Break the work down and call spawn_workers.",
			});
			return;
		}

		// reject 与 annotate 都记 denied，note 携带拒绝理由/批注内容
		await runtime.session.append({
			type: "approval/decided",
			id: randomUUID(),
			ts: new Date().toISOString(),
			requestId: askedId,
			decision: "denied",
			note: decision.note,
		});
		if (decision.kind === "annotate") {
			annotation = decision.note;
			continue;
		}

		yield { type: "plan", phase: "denied" };
		await runtime.session.append({
			type: "user_msg",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId: MAIN_AGENT_ID,
			content: "Plan rejected by user.",
		});
		// 收尾轮：main 基于「计划被拒」回复用户，回合随之结束
		for await (const event of runTurn(cfg, signal)) {
			yield event;
		}
		return;
	}
}
