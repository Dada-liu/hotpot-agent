// runMainTurn：一次用户消息的主流入口（main agent）。
// 流程：以 "main" 身份落盘 user_msg → main 角色注册表（delegate 元工具）跑 core runTurn
// → 透传全部事件。complex 流（Task 8）：delegate 判定 complex 后进入 runPlanPhase
// 修订/审批循环；批准后用挂 delegate+spawn_workers 的注册表跑执行 turn 并透传事件；
// 拒绝/修订耗尽时 plan 阶段已收尾，回合直接结束。
// onPlanApproval 缺省时 plan 阶段 fail-closed（拒绝并收尾），见 plan.ts。

import { randomUUID } from "node:crypto";
import { type LoopConfig, type ModelTier, runTurn } from "@hotpot/core";
import { type PlanDecision, runPlanPhase } from "./plan.ts";
import { buildRoleSystemPrompt } from "./prompts.ts";
import { createRoleRegistry } from "./registries.ts";
import type { OrchestrationRuntime } from "./runtime.ts";
import { createDelegateTool, type TurnState } from "./tools/delegate.ts";
import { createSpawnWorkersTool } from "./tools/spawn-workers.ts";
import type { OrchestrationEvent } from "./types.ts";

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
	const spawnWorkersTool = createSpawnWorkersTool(runtime, state);
	const registry = createRoleRegistry(MAIN_AGENT_ID, [delegateTool]);
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
		system: buildRoleSystemPrompt(MAIN_AGENT_ID, {
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
	if (state.lastDelegate?.difficulty !== "complex") {
		return;
	}

	// complex 流：plan 修订/审批循环（拒绝与修订耗尽都在其中收尾并结束回合）
	yield* runPlanPhase(runtime, state, signal, opts.onPlanApproval);
	if (!state.planApproved || signal.aborted) {
		return;
	}

	// 执行阶段：plan 已获批，main 的注册表加上 spawn_workers（system 随声明重建）
	const execRegistry = createRoleRegistry(MAIN_AGENT_ID, [
		delegateTool,
		spawnWorkersTool,
	]);
	const execResolved = runtime.resolveModel(mainTier);
	const execCfg: LoopConfig = {
		session: runtime.session,
		agentId: MAIN_AGENT_ID,
		adapter: execResolved.adapter,
		model: execResolved.model,
		apiKey: execResolved.apiKey,
		baseUrl: execResolved.baseUrl,
		registry: execRegistry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt(MAIN_AGENT_ID, {
			cwd: runtime.cwd,
			os: process.platform,
			date: new Date().toISOString().slice(0, 10),
			tools: execRegistry.declarations(),
		}),
		tier: mainTier,
	};
	for await (const event of runTurn(execCfg, signal)) {
		yield event;
	}
}
