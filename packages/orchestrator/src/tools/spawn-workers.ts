// spawn_workers 元工具：main 首轮（simple 直派）与 complex 执行阶段（plan 获批后）
// 共用。双分支门禁：planApproved=true 直接放行；未批准时调 detectPlanDraft——
// 本回合已产出带 # Plan 标记的计划正文则 fail-closed isError（堵「同轮既出计划
// 又执行、审批被绕过」的洞，core 在工具执行前已落盘整条 assistant_msg，此处读
// 会话日志即可拿到当前消息文本）；无标记则放行（simple 首轮直派）。
// 每个 worker role=worker、档位取参数 modelTier，任务描述折进 worker 的 user_msg
// （context 追加在后）；worker 顺序内联执行（并行拆分是 spawn_tasks 的职责），
// 聚合各 worker 摘要回传 main。

import { randomUUID } from "node:crypto";
import type { ModelTier, ToolContext, ToolDefinition } from "@hotpot/core";
import { z } from "zod";
import { detectPlanDraft } from "../plan/plan.ts";
import type { OrchestrationRuntime } from "../runtime/runtime.ts";
import type { TurnState } from "../types/types.ts";
import { runWorkerInline } from "./run-worker.ts";

export interface SpawnWorkersArgs {
	workers: { task: string; context?: string; modelTier: ModelTier }[];
}

export function createSpawnWorkersTool(
	runtime: OrchestrationRuntime,
	state: TurnState,
): ToolDefinition<SpawnWorkersArgs> {
	return {
		name: "spawn_workers",
		description:
			"Spawn worker agents and run each to completion; results are aggregated " +
			"back to you. Use it directly for simple tasks (exactly one worker), or to " +
			"execute the plan after it has been approved.",
		parameters: z.object({
			workers: z
				.array(
					z.object({
						task: z
							.string()
							.describe(
								"the full, self-contained task description handed to the worker",
							),
						context: z
							.string()
							.optional()
							.describe("extra context appended to the worker's task"),
						modelTier: z
							.enum(["high", "medium", "low"])
							.describe("model tier for this worker agent"),
					}),
				)
				.describe("worker agents to spawn and run sequentially"),
		}),
		// 有派生副作用且内联跑多个完整 worker turn，绝不能与同批工具并行
		isConcurrencySafe: false,
		async execute(args, ctx: ToolContext) {
			if (state.planApproved === false) {
				// 未批准时只有「本回合无计划标记」的 simple 直派可以放行；
				// 计划标记在本回合出现 = 模型已把任务定为 complex，必须先审批。
				// 锚定本回合 user_msg，steer 注入不得把计划挤出检测窗口
				const plan = await detectPlanDraft(runtime, state.turnAnchorId);
				if (plan !== null) {
					return {
						content:
							"Plan not approved yet: this turn produced a plan, so " +
							"spawn_workers is only available after plan approval.",
						isError: true,
					};
				}
			}
			const summaries: string[] = [];
			for (const worker of args.workers) {
				// parentAgentId 固定 "main"：主agent 的 agentId 是包级约定
				const { agentId } = await runtime.spawn({
					role: "worker",
					parentAgentId: "main",
					task: worker.task,
					tier: worker.modelTier,
				});
				// 任务描述作为 worker 的 user_msg 落盘：derive 按 agentId 过滤，main 的历史不受影响
				const content =
					worker.context === undefined
						? worker.task
						: `${worker.task}\n\nContext: ${worker.context}`;
				await runtime.session.append({
					type: "user_msg",
					id: randomUUID(),
					ts: new Date().toISOString(),
					agentId,
					content,
				});
				const summary = await runWorkerInline(
					runtime,
					agentId,
					worker.modelTier,
					ctx.signal,
				);
				summaries.push(
					`Worker ${agentId} (tier=${worker.modelTier}) result:\n${summary}`,
				);
			}
			return { content: summaries.join("\n\n") };
		},
	};
}
