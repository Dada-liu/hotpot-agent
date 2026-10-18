// runMainTurn：一次用户消息的主流入口（main agent）。
// 流程：以 "main" 身份落盘 user_msg → main 角色注册表（delegate 元工具）跑 core runTurn
// → 透传全部事件。complex 流（Task 8）：delegate 判定 complex 后进入 runPlanPhase
// 修订/审批循环（初始轮产出的计划直接复用）；批准后换用只挂 spawn_workers 的注册表
// 跑执行 turn 并透传事件；拒绝/修订耗尽时 plan 阶段已收尾，回合直接结束。
// onPlanApproval 缺省时 plan 阶段 fail-closed（拒绝并收尾），见 plan.ts。
// 传入 inbox 时，core runTurn 的每个 step 顶部经 pollInbox 拉取 next-step 消息
// （steer/inject 注入），plan 起草/修订轮与执行轮同样生效；缺省不轮询。
// worker/task 的 spawn 经包装 runtime.spawn 记录进本回合待产队列，主循环先 drain
// 再透传 —— agent_spawn 流事件先于对应 tool_result 到达、与调用序一致。

import { randomUUID } from "node:crypto";
import {
	featureEnabled,
	type LoopConfig,
	type ModelTier,
	runTurn,
} from "@hotpot/core";
import type { Inbox } from "./inbox.ts";
import { type PlanDecision, runPlanPhase } from "./plan.ts";
import { buildRoleSystemPrompt, EXECUTION_INSTRUCTIONS } from "./prompts.ts";
import { createRoleRegistry } from "./registries.ts";
import type { OrchestrationRuntime } from "./runtime.ts";
import { createDelegateTool, type TurnState } from "./tools/delegate.ts";
import { createSpawnWorkersTool } from "./tools/spawn-workers.ts";
import type { OrchestrationEvent } from "./types.ts";

// 主agent 的 agentId 固定为 "main"：spawn 的 parentAgentId、derive 的消息过滤都以此为准
const MAIN_AGENT_ID = "main";

export async function* runMainTurn(opts: {
	runtime: OrchestrationRuntime;
	userMessage: string;
	signal: AbortSignal;
	mainTier: ModelTier;
	onPlanApproval?: (plan: string) => Promise<PlanDecision>;
	// steer/queue 双队列的 next-step 注入（可选）：存在时 core runTurn 每个 step
	// 顶部经 pollInbox 拉取已排队消息，逐条落盘为 user_msg 进入模型历史；缺省不轮询
	inbox?: Inbox;
}): AsyncIterable<OrchestrationEvent> {
	const { runtime, userMessage, signal, mainTier } = opts;
	const state: TurnState = {
		phase: "initial",
		planApproved: false,
		revisions: 0,
	};
	const inbox = opts.inbox;
	// Inbox.pollNextStep 的返回形状与 core 钩子一致（string[]，消息体已映射为
	// content），直接适配；起草轮与执行轮共用同一队列
	const pollInbox = inbox ? () => inbox.pollNextStep() : undefined;
	// 本回合待产的 agent_spawn 事件：spawn 包装在调用成功后推入，主循环每轮
	// （以及循环结束后）先 drain 再 yield runTurn 事件 —— spawn 事件因而稳定出现在
	// delegate/spawn_workers 的 tool_result 之前，且与调用序一致。base spawn 内部经
	// Promise 链串行化（见 runtime.ts），并发 spawn_tasks 的包装 push 也按调用序完成
	const pendingSpawns: Extract<OrchestrationEvent, { type: "agent_spawn" }>[] =
		[];
	async function* drainPendingSpawns(): AsyncGenerator<OrchestrationEvent> {
		while (pendingSpawns.length > 0) {
			const event = pendingSpawns.shift();
			if (event !== undefined) yield event;
		}
	}
	// spawn 包装：只在调用成功后追加事件记录，落盘语义不变（仍由 base runtime 负责）。
	// simple 路径的 spawn 发生在 delegate 的 execute 内部，complex 执行阶段的 spawn
	// 发生在 spawn_workers 的 execute 内部，两者都经这里进 pendingSpawns
	const turnRuntime: OrchestrationRuntime = {
		...runtime,
		spawn: async (spawnOpts) => {
			const { agentId } = await runtime.spawn(spawnOpts);
			pendingSpawns.push({
				type: "agent_spawn",
				agentId,
				role: spawnOpts.role,
				tier: spawnOpts.tier,
				task: spawnOpts.task,
			});
			return { agentId };
		},
	};
	const delegateTool = createDelegateTool(turnRuntime, state);
	const spawnWorkersTool = createSpawnWorkersTool(turnRuntime, state);
	const registry = createRoleRegistry(turnRuntime, MAIN_AGENT_ID, [
		delegateTool,
	]);
	await runtime.session.append({
		type: "user_msg",
		id: randomUUID(),
		ts: new Date().toISOString(),
		agentId: MAIN_AGENT_ID,
		content: userMessage,
	});
	const resolved = runtime.resolveModel(mainTier);
	// M4 Feature④：skills 段数据源（features.skills 关闭时不传，prompt 不出段——
	// 装配层关闭时本就不扫描，这里是第二道门）
	const skills = featureEnabled(runtime.features, "skills")
		? runtime.skills
		: undefined;
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
		system: buildRoleSystemPrompt(
			MAIN_AGENT_ID,
			{
				cwd: runtime.cwd,
				os: process.platform,
				date: new Date().toISOString().slice(0, 10),
				tools: registry.declarations(),
			},
			{ skills },
		),
		tier: mainTier,
		pollInbox,
		hooks: runtime.hooks,
	};
	let stopReason: string | undefined;
	// 回合收尾钩子（Stop → turn_end）：runMainTurn 的每条出口都要触发一次
	const endTurn = async (): Promise<void> => {
		await runtime.hooks?.run("turn_end", {
			agent_id: MAIN_AGENT_ID,
			stop_reason: stopReason ?? "stop",
		});
	};
	for await (const event of runTurn(cfg, signal)) {
		if (event.type === "done") {
			stopReason = event.stopReason;
		}
		yield* drainPendingSpawns();
		yield event;
	}
	yield* drainPendingSpawns();
	if (state.lastDelegate?.difficulty !== "complex") {
		await endTurn();
		return;
	}

	// complex 流：plan 修订/审批循环（拒绝与修订耗尽都在其中收尾并结束回合）。
	// inbox 透传：起草/修订轮与执行轮都在 step 顶部消费 next-step
	yield* runPlanPhase(turnRuntime, state, signal, {
		onPlanApproval: opts.onPlanApproval,
		inbox,
	});
	if (!state.planApproved || signal.aborted) {
		await endTurn();
		return;
	}

	// 执行阶段：plan 已获批，只挂 spawn_workers；delegate 不再可用，避免重复判定
	const execRegistry = createRoleRegistry(turnRuntime, MAIN_AGENT_ID, [
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
		system: buildRoleSystemPrompt(
			MAIN_AGENT_ID,
			{
				cwd: runtime.cwd,
				os: process.platform,
				date: new Date().toISOString().slice(0, 10),
				tools: execRegistry.declarations(),
			},
			{ skills, instructions: EXECUTION_INSTRUCTIONS },
		),
		tier: mainTier,
		pollInbox,
		hooks: runtime.hooks,
	};
	for await (const event of runTurn(execCfg, signal)) {
		if (event.type === "done") {
			stopReason = event.stopReason;
		}
		yield* drainPendingSpawns();
		yield event;
	}
	yield* drainPendingSpawns();
	await endTurn();
}
