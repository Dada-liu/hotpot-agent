// runMainTurn：一次用户消息的主流入口（main agent）。
// 流程：以 "main" 身份落盘 user_msg → 用 main 角色注册表（本任务只挂 delegate 元工具，
// spawn_workers 由 Task 8 加入）跑 core runTurn → 透传全部事件给调用方。
// complex 分支是本任务的占位：delegate 判定 complex 后 runTurn 正常收尾，
// 这里产出 plan-not-implemented 错误事件并结束回合；Task 8 用 plan 流程替换该占位，
// onPlanApproval 回调也留到 Task 8 才有消费者。

import { randomUUID } from "node:crypto";
import { LlmError } from "@hotpot/ai";
import { type LoopConfig, type ModelTier, runTurn } from "@hotpot/core";
import { buildRoleSystemPrompt } from "./prompts.ts";
import { createRoleRegistry } from "./registries.ts";
import type { OrchestrationRuntime } from "./runtime.ts";
import { createDelegateTool, type TurnState } from "./tools/delegate.ts";
import type { OrchestrationEvent } from "./types.ts";

export type PlanDecision =
	| { kind: "approve" }
	| { kind: "reject"; note: string }
	| { kind: "annotate"; note: string };

// 主流 agentId 固定为 "main"：spawn 的 parentAgentId、derive 的消息过滤都以此为准
const MAIN_AGENT_ID = "main";

export async function* runMainTurn(opts: {
	runtime: OrchestrationRuntime;
	userMessage: string;
	signal: AbortSignal;
	mainTier: ModelTier;
	onPlanApproval?: (plan: string) => Promise<PlanDecision>;
}): AsyncIterable<OrchestrationEvent> {
	const { runtime, userMessage, signal, mainTier } = opts;
	const state: TurnState = {
		phase: "initial",
		planApproved: false,
		revisions: 0,
	};
	const delegateTool = createDelegateTool(runtime, state);
	const registry = createRoleRegistry("main", [delegateTool]);
	await runtime.session.append({
		type: "user_msg",
		id: randomUUID(),
		ts: new Date().toISOString(),
		agentId: MAIN_AGENT_ID,
		content: userMessage,
	});
	const resolved = runtime.resolveModel(mainTier);
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
		system: buildRoleSystemPrompt("main", {
			cwd: runtime.cwd,
			os: process.platform,
			date: new Date().toISOString().slice(0, 10),
			tools: registry.declarations(),
		}),
		tier: mainTier,
	};
	for await (const event of runTurn(cfg, signal)) {
		yield event;
	}
	// complex 占位：plan 审批流 Task 8 实现，这里先报错结束回合
	if (state.phase === "planning") {
		yield {
			type: "error",
			error: new LlmError(
				"plan approval flow is not implemented yet",
				"plan-not-implemented",
			),
		};
	}
}
