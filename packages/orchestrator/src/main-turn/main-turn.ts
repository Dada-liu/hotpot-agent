// runMainTurn：一次用户消息的主流入口（main agent）。
// 流程：以 "main" 身份落盘 user_msg → main 角色注册表（spawn_workers 元工具）跑 core
// runTurn → 透传全部事件。首轮提示词路由（无 delegate）：模型首轮静默判定——
// trivial 纯文本直答、simple 首轮直接 spawn_workers（本回合无计划标记即放行）、
// complex 不调用工具、本轮最终消息按 PLAN_FORMAT_TEMPLATE 输出计划正文；
// 初始 turn 结束后 detectPlanDraft 命中 → state.phase="planning"，进入 plan/ 的
// runPlanPhase（复用首轮草稿，审批/修订循环，见 plan.ts）；批准后换 EXECUTION_INSTRUCTIONS
// 跑执行 turn（注册表仍只挂 spawn_workers，planApproved 已翻转、门禁放行）。
// 未命中 → trivial/simple 已在本轮内闭环，endTurn 收尾。
// 本回合 user_msg 落盘时记录事件锚点（state.turnAnchorId）：detectPlanDraft 以它为
// 扫描窗口起点，turn 内 steer 注入的 user_msg 不得把首轮计划挤出检测窗口。
// onPlanApproval 缺失时 plan 阶段 fail-closed（拒绝并收尾），见 plan.ts。
// 传入 inbox 时，core runTurn 的每个 step 顶部经 pollInbox 拉取 next-step 消息
// （steer/inject 注入），plan 起草/修订轮与执行轮同样生效；默认不轮询。
// worker 的 spawn 经包装 runtime.spawn 记录进本回合待产队列，主循环先 drain
// 再透传 —— agent_spawn 流事件先于对应 tool_result 到达、与调用序一致。

import { randomUUID } from "node:crypto";
import {
	featureEnabled,
	type LoopConfig,
	type ModelTier,
	runTurn,
} from "@hotpot/core";
import type { Inbox } from "../inbox/inbox.ts";
import {
	detectPlanDraft,
	type PlanDecision,
	runPlanPhase,
} from "../plan/plan.ts";
import {
	buildRoleSystemPrompt,
	EXECUTION_INSTRUCTIONS,
} from "../prompts/prompts.ts";
import { createRoleRegistry } from "../registries/registries.ts";
import type { OrchestrationRuntime } from "../runtime/runtime.ts";
import { createSpawnWorkersTool } from "../tools/spawn-workers.ts";
import type { OrchestrationEvent, TurnState } from "../types/types.ts";

// 主agent 的 agentId 固定为 "main"：spawn 的 parentAgentId、derive 的消息过滤都以此为准
const MAIN_AGENT_ID = "main";

export async function* runMainTurn(opts: {
	runtime: OrchestrationRuntime;
	userMessage: string;
	signal: AbortSignal;
	mainTier: ModelTier;
	onPlanApproval?: (plan: string) => Promise<PlanDecision>;
	// steer/queue 双队列的 next-step 注入（可选）：存在时 core runTurn 每个 step
	// 顶部经 pollInbox 拉取已排队消息，逐条落盘为 user_msg 进入模型历史；默认不轮询
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
	// spawn_workers 的 tool_result 之前，且与调用序一致。base spawn 内部经
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
	// simple 路径的 spawn 发生在 spawn_workers 的 execute 内部，执行阶段的 spawn 同理，
	// 两者都经这里进 pendingSpawns
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
	const spawnWorkersTool = createSpawnWorkersTool(turnRuntime, state);
	// 首轮注册表只挂 spawn_workers：simple 直派；complex 首轮不调用工具、
	// 只产出计划正文（plan 阶段注册表为空，执行阶段复用同一元工具）
	const registry = createRoleRegistry(turnRuntime, MAIN_AGENT_ID, [
		spawnWorkersTool,
	]);
	const userMsgId = randomUUID();
	await runtime.session.append({
		type: "user_msg",
		id: userMsgId,
		ts: new Date().toISOString(),
		agentId: MAIN_AGENT_ID,
		content: userMessage,
	});
	// 本回合扫描锚点：steer 注入的 user_msg 不得把首轮计划挤出 detectPlanDraft 窗口
	state.turnAnchorId = userMsgId;
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

	// 首轮提示词路由：只有首轮产出了带 # Plan 标记的计划正文才进入 plan 阶段；
	// 普通回答与 simple 直派（worker 已内联跑完）到此收尾。锚定本回合 user_msg，
	// turn 内 steer 注入不得把首轮计划挤出检测窗口
	const initialPlan = await detectPlanDraft(runtime, state.turnAnchorId);
	if (initialPlan === null || signal.aborted) {
		await endTurn();
		return;
	}
	state.phase = "planning";

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

	// 执行阶段：plan 已获批，注册表仍只挂 spawn_workers（planApproved 翻转后门禁放行）
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
